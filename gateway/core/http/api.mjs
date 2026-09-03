import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { HttpRouter, commandId, expectedRevision } from "./router.mjs";

const requiredBody = (request) => {
  invariant(request.body && typeof request.body === "object" && !Array.isArray(request.body), "REQUEST_BODY_REQUIRED", "请求体不能为空", { status: 400 });
  return request.body;
};

function withRevision(request) {
  return { ...requiredBody(request), expectedRevision: expectedRevision(request) };
}

function exactBody(request, allowed, required, operation) {
  const body = request.body === null && required.length === 0 ? {} : requiredBody(request);
  invariant(Object.keys(body).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(body, key)), "REQUEST_BODY_SCHEMA_INVALID", `${operation}请求体不符合 EasyWork 协议`, {
    status: 400,
    details: { allowed, required },
  });
  return body;
}

export function createApi(options) {
  const router = new HttpRouter(options);
  const publicRoute = { auth: false };

  const establishSession = async (action, request, operation) => {
    const result = await operation();
    if (typeof options.auditSession === "function") {
      await options.auditSession({ action, result, request });
    }
    return result;
  };

  router.route("POST", "/api/auth/register", (request) => establishSession("auth.registered", request, () => options.auth.register(requiredBody(request))), publicRoute);
  router.route("POST", "/api/auth/login", (request) => establishSession("auth.logged-in", request, () => options.auth.login(requiredBody(request))), publicRoute);
  router.route("POST", "/api/auth/guest", (request) => establishSession("auth.guest-created", request, () => options.auth.createGuestSession(requiredBody(request))), publicRoute);
  router.route("POST", "/api/auth/refresh", (request) => options.auth.refreshSession(request.token));
  router.route("POST", "/api/auth/logout", (request) => options.logout ? options.logout(request) : options.auth.logout(request.token), { audit: false });
  router.route("POST", "/api/auth/help-seen", (request) => options.auth.markHelpSeen(request.token));
  router.route("GET", "/api/profile", (request) => options.auth.getProfile(request.token));
  router.route("PATCH", "/api/profile", (request) => {
    const body = requiredBody(request);
    invariant(!Object.hasOwn(body, "token"), "PROFILE_INPUT_SCHEMA_INVALID", "个人资料请求不能覆盖登录会话", { status: 400 });
    return options.auth.updateProfile({ ...body, token: request.token, expectedRevision: expectedRevision(request) });
  });

  router.route("GET", "/api/bootstrap", async (request) => {
    if (options.bootstrap) return options.bootstrap(request);
    const { conversations, projects, servers, providers, taskStore } = request.services;
    const conversationOverview = typeof conversations.bootstrapOverview === "function"
      ? conversations.bootstrapOverview({ limit: 8, projectId: null })
      : conversations.listConversations({ limit: 8, projectId: null });
    const [conversationPage, projectItems, serverItems, providerItems, runningTasks] = await Promise.all([
      conversationOverview,
      projects.list(),
      servers.list(),
      providers?.listAvailableProviders?.(request.session.actor, "web") || [],
      taskStore?.listTasks?.({ statuses: ["queued", "preparing", "running", "waiting_approval", "waiting_input", "interrupted", "resuming"], limit: 100 }) || [],
    ]);
    return {
      actor: request.session.profile,
      device: { deviceId: request.session.actor.deviceId, firstVisit: request.session.firstVisit },
      featureFlags: request.services.featureFlags || {},
      providers: providerItems,
      projects: projectItems,
      recentConversations: conversationPage.items,
      conversationCursor: conversationPage.nextCursor || null,
      servers: serverItems,
      runningTasks: runningTasks.items || runningTasks,
    };
  });

  router.route("GET", "/api/drafts/work", (request) => request.services.workDrafts.get());
  router.route("PATCH", "/api/drafts/work", (request) => {
    const body = exactBody(request, ["selection", "expectedRevision", "commandId"], ["selection"], "保存 Work 草稿");
    return request.services.workDrafts.replace({ selection: body.selection, expectedRevision: expectedRevision(request), commandId: commandId(request) });
  });
  router.route("DELETE", "/api/drafts/work", (request) => {
    exactBody(request, ["expectedRevision", "commandId"], [], "清除 Work 草稿");
    return request.services.workDrafts.clear({ expectedRevision: expectedRevision(request), commandId: commandId(request) });
  });

  router.route("GET", "/api/conversations", (request) => request.services.conversations.listConversations({
    cursor: request.query.cursor,
    limit: request.query.limit ? Number(request.query.limit) : undefined,
    projectId: request.query.unassigned === "true" ? null : request.query.projectId,
  }));
  router.route("POST", "/api/conversations", (request) => {
    const body = requiredBody(request);
    return request.services.conversations.sendMessage({ ...body, expectedRevision: expectedRevision(request), commandId: commandId(request), role: "user" });
  });
  router.route("GET", "/api/conversations/:id", (request) => request.services.conversations.getConversation(request.params.id));
  router.route("GET", "/api/conversations/:id/messages", (request) => request.services.conversations.listMessages({
    conversationId: request.params.id,
    branchId: request.query.branchId,
    cursor: request.query.before || request.query.cursor,
    limit: request.query.limit ? Number(request.query.limit) : undefined,
  }));
  router.route("GET", "/api/conversations/:id/server-binding", async (request) => {
    await request.services.conversations.getConversation(request.params.id);
    const binding = await request.services.servers.findConversationBinding(request.params.id);
    return { ...binding, connectionEnabled: binding.serverId ? await request.services.servers.isConversationConnectionEnabled(request.params.id) : false };
  });
  router.route("POST", "/api/conversations/:id/server-binding", async (request) => {
    const body = exactBody(request, ["serverId"], ["serverId"], "绑定对话服务器");
    const conversation = await request.services.conversations.getConversation(request.params.id);
    invariant(conversation.summary.mode === "work", "CONVERSATION_SERVER_BINDING_MODE_INVALID", "只有工作对话可以绑定服务器", { status: 409 });
    await request.services.servers.bindConversation(body.serverId, request.params.id);
    return { ...(await request.services.servers.findConversationBinding(request.params.id)), connectionEnabled: true };
  });
  router.route("DELETE", "/api/conversations/:id/server-binding", async (request) => {
    exactBody(request, [], [], "断开对话服务器");
    await request.services.conversations.getConversation(request.params.id);
    const binding = await request.services.servers.disableConversation(request.params.id);
    return { ...binding, connectionEnabled: false };
  });
  router.route("POST", "/api/conversations/:id/messages", (request) => request.services.conversations.sendMessage({
    ...requiredBody(request), conversationId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request), role: requiredBody(request).role || "user",
  }));
  router.route("PATCH", "/api/conversations/:id", async (request) => {
    const body = withRevision(request);
    invariant(body.mode === undefined, "CONVERSATION_MODE_FIXED", "对话类型在创建后不可修改", { status: 400 });
    const base = { conversationId: request.params.id, expectedRevision: body.expectedRevision, commandId: commandId(request) };
    if (body.title !== undefined) return request.services.conversations.rename({ ...base, title: body.title });
    if (body.projectId !== undefined) return request.services.conversations.moveToProject({ ...base, projectId: body.projectId });
    if (body.pinned !== undefined) return request.services.conversations.setPinned({ ...base, pinned: body.pinned });
    invariant(false, "CONVERSATION_PATCH_EMPTY", "没有可修改的对话字段", { status: 400 });
  });
  router.route("DELETE", "/api/conversations/:id", async (request) => {
    return request.services.conversations.delete({ conversationId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request) });
  });
  router.route("POST", "/api/conversations/:id/actions", (request) => {
    const body = requiredBody(request);
    const base = { ...body, conversationId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request) };
    const actions = {
      branch: "branch",
      retry: "retry",
      rewind: "rewind",
    };
    const method = actions[body.action];
    invariant(method && typeof request.services.conversations[method] === "function", "CONVERSATION_ACTION_INVALID", "对话操作无效", { status: 400 });
    return request.services.conversations[method](base);
  });

  router.route("GET", "/api/projects", (request) => request.services.projects.list());
  router.route("POST", "/api/projects", (request) => request.services.projects.create(requiredBody(request)));
  router.route("GET", "/api/projects/:id", (request) => request.services.projects.get(request.params.id));
  router.route("PATCH", "/api/projects/:id", (request) => request.services.projects.update({ ...withRevision(request), projectId: request.params.id }));
  router.route("DELETE", "/api/projects/:id", (request) => request.services.projects.delete({ projectId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request) }));

  router.route("GET", "/api/collections", (request) => request.services.collections.list());
  router.route("POST", "/api/collections", (request) => request.services.collections.create(requiredBody(request)));
  router.route("GET", "/api/collections/:id", (request) => request.services.collections.get(request.params.id));
  router.route("PATCH", "/api/collections/:id", (request) => request.services.collections.rename({ collectionId: request.params.id, name: requiredBody(request).name, expectedRevision: expectedRevision(request) }));
  router.route("DELETE", "/api/collections/:id", (request) => request.services.collections.delete({ collectionId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request) }));
  router.route("POST", "/api/projects/:id/collections", (request) => request.services.projects.linkCollection({ projectId: request.params.id, collectionId: requiredBody(request).collectionId, expectedRevision: expectedRevision(request) }));
  router.route("DELETE", "/api/projects/:id/collections/:collectionId", (request) => request.services.projects.unlinkCollection({ projectId: request.params.id, collectionId: request.params.collectionId, expectedRevision: expectedRevision(request) }));

  router.route("POST", "/api/resources/search", (request) => request.services.resources.search(requiredBody(request)));
  router.route("POST", "/api/resources/:id/reindex", (request) => request.services.resources.retryIndexing({ versionId: request.params.id, expectedRevision: expectedRevision(request) }));
  router.route("DELETE", "/api/resource-bindings/:id", (request) => request.services.resources.removeBinding({ bindingId: request.params.id, expectedRevision: expectedRevision(request) }));

  router.route("GET", "/api/servers", async (request) => {
    const servers = await request.services.servers.list();
    const conversationIds = [...new Set(servers.flatMap((server) => server.conversationIds || []))];
    const titles = new Map((await request.services.conversations.getConversationSummaries(conversationIds))
      .map((conversation) => [conversation.id, conversation.title]));
    return servers.map((server) => ({
      ...server,
      conversations: (server.conversationIds || []).map((id) => ({ id, title: titles.get(id) || "未命名对话" })),
    }));
  });
  router.route("POST", "/api/servers", (request) => request.services.servers.create(requiredBody(request)));
  router.route("GET", "/api/servers/:id", (request) => request.services.servers.get(request.params.id));
  router.route("PATCH", "/api/servers/:id", (request) => request.services.servers.update(request.params.id, withRevision(request)));
  router.route("POST", "/api/servers/:id/credential/reveal", (request) => request.services.servers.revealCredential(request.params.id), {
    secretResponse: true,
    auditAction: "ssh.credential.revealed",
    auditTarget: ({ params }) => ({ serverId: params.id }),
  });
  router.route("POST", "/api/servers/:id/connect", (request) => request.services.connectSsh(request.params.id, requiredBody(request)));
  router.route("POST", "/api/servers/:id/disconnect", (request) => request.services.sshWorker.disconnect(request.params.id));

  router.route("GET", "/api/tasks", (request) => {
    const conversationId = String(request.query.conversationId || "").trim();
    invariant(conversationId, "TASK_CONVERSATION_REQUIRED", "读取任务需要指定对话", { status: 400 });
    return request.services.taskStore.listTasks({
      conversationId,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
    });
  });
  router.route("POST", "/api/tasks", async (request) => {
    const body = requiredBody(request);
    const { start = true, ...input } = body;
    const created = await request.services.orchestrator.create(input, { commandId: commandId(request) });
    return start === false ? created : request.services.orchestrator.start(created.task.id, { commandId: `${commandId(request)}:start` });
  });
  router.route("GET", "/api/tasks/:id", (request) => request.services.orchestrator.getTask(request.params.id));
  router.route("GET", "/api/tasks/:id/report", (request) => request.services.taskReports.get(request.params.id));
  for (const [path, method] of [["append", "append"], ["interrupt", "interrupt"], ["resume", "resume"]]) {
    router.route("POST", `/api/tasks/:id/${path}`, (request) => request.services.orchestrator[method](request.params.id, { ...requiredBody(request), commandId: commandId(request) }));
  }
  router.route("POST", "/api/tasks/:id/approval", async (request) => {
    const result = await request.services.orchestrator.respondApproval(request.params.id, { ...requiredBody(request), commandId: commandId(request) });
    await request.services.interactions?.resumeTask(request.params.id);
    return result;
  });
  router.route("POST", "/api/tasks/:id/input", async (request) => {
    const result = await request.services.orchestrator.respondInput(request.params.id, { ...requiredBody(request), commandId: commandId(request) });
    await request.services.interactions?.resumeTask(request.params.id);
    return result;
  });

  router.route("GET", "/api/skills", (request) => request.services.skills.inspect());
  router.route("POST", "/api/skills", (request) => request.services.skills.uploadVersion({ ...requiredBody(request), commandId: commandId(request) }));
  router.route("GET", "/api/skill-center/installed", (request) => request.services.skills.listInstalled());
  router.route("GET", "/api/skill-center/installed/:skillId", (request) => request.services.skills.getInstalledDetail(request.params.skillId));
  router.route("PATCH", "/api/skill-center/installed/:skillId/applicability", (request) => request.services.skills.updateApplicability(request.params.skillId, requiredBody(request)));
  router.route("DELETE", "/api/skill-center/installed/:skillId", (request) => request.services.skills.uninstall({
    skillId: request.params.skillId,
    expectedRevision: expectedRevision(request),
  }));
  router.route("GET", "/api/skill-center/market", async (request) => {
    const installed = await request.services.skills.listInstalled();
    return request.services.skillMarketplace.listMarket({ installedSkillIds: installed.items.map((item) => item.skillId) });
  });
  router.route("GET", "/api/skill-center/market/:id", async (request) => {
    const installed = await request.services.skills.listInstalled();
    return request.services.skillMarketplace.getMarket(request.params.id, { installedSkillIds: installed.items.map((item) => item.skillId) });
  });
  router.route("POST", "/api/skill-center/market/:id/install", (request) => request.services.skillMarketplace.install(
    request.session.actor,
    request.services.skills,
    request.params.id,
  ));
  router.route("PATCH", "/api/skill-center/market/:id", (request) => request.services.skillMarketplace.updateMarket(request.session.actor, request.params.id, {
    ...requiredBody(request),
    expectedRevision: expectedRevision(request),
  }), { admin: true });
  router.route("DELETE", "/api/skill-center/market/:id", (request) => request.services.skillMarketplace.deleteMarket(request.session.actor, request.params.id, {
    expectedRevision: expectedRevision(request),
  }), { admin: true });
  router.route("GET", "/api/skill-center/uploads", (request) => request.services.skillMarketplace.listSubmissions(request.session.actor, {
    status: request.query.status,
  }));
  router.route("POST", "/api/skill-center/uploads", (request) => request.services.skillMarketplace.submit(request.session.actor, {
    ...requiredBody(request),
    commandId: commandId(request),
  }));
  router.route("GET", "/api/skill-center/uploads/:id", (request) => request.services.skillMarketplace.getSubmission(request.session.actor, request.params.id));
  router.route("POST", "/api/skill-center/uploads/:id/review", (request) => request.services.skillMarketplace.review(request.session.actor, request.params.id, {
    ...requiredBody(request),
    expectedRevision: expectedRevision(request),
  }), { admin: true });

  router.route("GET", "/api/providers", (request) => request.services.providers.listAvailableProviders(request.session.actor, request.query.purpose || "web"));
  router.route("POST", "/api/providers", (request) => request.services.providers.createUserProvider(request.session.actor, { ...requiredBody(request), commandId: commandId(request) }));
  router.route("PATCH", "/api/providers/:id", (request) => request.services.providers.updateUserProvider(request.session.actor, { ...requiredBody(request), providerId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request) }));
  router.route("DELETE", "/api/providers/:id", (request) => request.services.providers.deleteUserProvider(request.session.actor, { providerId: request.params.id, expectedRevision: expectedRevision(request), commandId: commandId(request) }));
  router.route("POST", "/api/providers/:id/models", (request) => request.services.providers.detectModels(request.session.actor, { providerId: request.params.id, purpose: requiredBody(request).purpose || "web" }));
  router.route("POST", "/api/providers/:id/reveal", (request) => (
    request.services.providers.revealUserProvider(request.session.actor, request.params.id)
  ), {
    secretResponse: true,
    auditAction: "provider.key.revealed",
    auditTarget: ({ params }) => ({ providerId: params.id, scope: "actor" }),
  });

  router.route("GET", "/api/admin/platform", (request) => request.services.platform.inspect(request.session.actor), { admin: true });
  router.route("PATCH", "/api/admin/providers/:purpose", (request) => request.services.platform.updateProvider(request.session.actor, { ...requiredBody(request), purpose: request.params.purpose, expectedRevision: expectedRevision(request), commandId: commandId(request) }), { admin: true });
  router.route("POST", "/api/admin/providers/:purpose/models", (request) => request.services.providers.detectModelsFromDraft(request.session.actor, {
    ...requiredBody(request),
    purpose: request.params.purpose,
  }), { admin: true });
  router.route("POST", "/api/admin/providers/:purpose/reveal", (request) => (
    request.services.platform.revealProvider(request.session.actor, request.params.purpose)
  ), {
    admin: true,
    secretResponse: true,
    auditAction: "platform.provider.key.revealed",
    auditTarget: ({ params }) => ({ providerId: `platform-${params.purpose}`, scope: "platform" }),
  });
  router.route("PATCH", "/api/admin/ssh-policy", (request) => request.services.platform.updateSshPolicy(request.session.actor, { ...requiredBody(request), expectedRevision: expectedRevision(request), commandId: commandId(request) }), { admin: true });
  router.route("GET", "/api/admin/usage", (request) => request.services.providerUsage.summarize(request.session.actor, request.query), { admin: true });

  if (typeof options.extend === "function") options.extend(router);
  return router;
}

export function createDraftConversationId() {
  return `conv_${crypto.randomUUID()}`;
}
