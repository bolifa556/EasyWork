import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { createGatewayServer } from "../gateway/core/server.mjs";

async function temporaryRuntimeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# EasyWork\n\n组合网关帮助。\n", "utf8");
  return { dataRoot: path.join(root, "data"), helpFile };
}

function fakeModelFactory() {
  return {
    async complete({ messages, onDelta }) {
      const system = String(messages?.[0]?.content || "");
      if (system.includes("# 可复用记忆提取")) return { content: "", reasoning: "", toolCalls: [], usage: { prompt_tokens: 2, completion_tokens: 1 } };
      if (system.includes("# 对话上下文压缩")) {
        return {
          content: "## 目标\n- 完成组合运行时测试\n\n## 重要信息\n- 压缩由同一模型完成\n\n## 工作状态\n### 已完成\n- 无\n\n### 进行中\n- 验证压缩\n\n### 阻塞\n- 无\n\n## 下一步\n1. 继续验证\n\n## 相关文件\n- 无",
          reasoning: "",
          toolCalls: [],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        };
      }
      if (system.includes("只输出标题本身")) {
        return { content: "组合运行时验证", reasoning: "", toolCalls: [], usage: { prompt_tokens: 4, completion_tokens: 2 } };
      }
      await onDelta?.({ kind: "reasoning", content: "核对上下文。" });
      await onDelta?.({ kind: "content", content: "这是组合运行时的回复。" });
      return {
        content: "这是组合运行时的回复。",
        reasoning: "核对上下文。",
        toolCalls: [],
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      };
    },
  };
}

function titleFailureModelFactory() {
  return {
    async complete({ messages, onDelta }) {
      const system = String(messages?.[0]?.content || "");
      if (system.includes("只输出标题本身")) throw Object.assign(new Error("title unavailable"), { code: "MODEL_UNAVAILABLE", status: 502 });
      if (system.includes("# 可复用记忆提取")) return { content: "", reasoning: "", toolCalls: [], usage: {} };
      await onDelta?.({ kind: "content", content: "主回复正常完成。" });
      return { content: "主回复正常完成。", reasoning: "", toolCalls: [], usage: {} };
    },
  };
}

async function startGateway(runtimeOptions) {
  const gateway = await createGatewayServer({ runtimeOptions });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  return { gateway, baseUrl: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/easywork-ws` };
}

async function requestJson(baseUrl, pathname, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = response.status === 304 ? null : await response.json();
  return { response, payload };
}

async function waitForMessage(socket, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw));
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

test("组合 Gateway 完成注册、严格 bootstrap、项目、流式对话并在重启后恢复", async (t) => {
  const { dataRoot, helpFile } = await temporaryRuntimeRoot(t);
  let active = await startGateway({ dataRoot, helpFile, webModelFactory: fakeModelFactory });
  t.after(async () => active?.gateway.close().catch(() => undefined));

  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "runtime-user", password: "runtime-password", deviceId: "runtime-device" },
  });
  assert.equal(registered.response.status, 200);
  const token = registered.payload.data.token;
  const actorId = registered.payload.data.actor.actorId;

  const initial = await requestJson(active.baseUrl, "/api/bootstrap", { token });
  assert.deepEqual(initial.payload.data.actor, {
    id: actorId,
    type: "user",
    username: "runtime-user",
    displayName: "runtime-user",
    avatar: null,
    roles: ["admin"],
  });
  assert.deepEqual(Object.keys(initial.payload.data.device).sort(), ["firstVisit", "id", "lastSeenAt"]);
  assert.equal(initial.payload.data.device.id, "runtime-device");
  assert.equal(initial.payload.data.device.firstVisit, true);
  const skills = await requestJson(active.baseUrl, "/api/skills", { token });
  assert.deepEqual(skills.payload.data, { skills: [] });
  assert.equal(skills.payload.meta.revision, 0);

  const project = await requestJson(active.baseUrl, "/api/projects", {
    token,
    method: "POST",
    body: { name: "组合项目" },
  });
  assert.equal(project.response.status, 200);

  const conversation = await requestJson(active.baseUrl, "/api/conversations", {
    token,
    method: "POST",
    headers: { "idempotency-key": "runtime-conversation-0001" },
    body: {
      mode: "chat",
      projectId: project.payload.data.id,
      content: "请回复",
      expectedRevision: 0,
      response: { providerId: "platform-web", modelId: "fake-model", scope: {} },
    },
  });
  assert.equal(conversation.response.status, 200);
  assert.match(conversation.payload.data.response.runId, /^web_/);
  const runId = conversation.payload.data.response.runId;
  const conversationId = conversation.payload.data.conversation.id;
  const session = await active.gateway.runtime.auth.resolveSession(token);
  const services = await active.gateway.runtime.servicesForActor(session.actor);
  await services.interactions.waitFor(runId);
  await services.taskRuntime.waitForIdle();

  const messages = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/messages`, { token });
  assert.deepEqual(messages.payload.data.items.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "请回复" },
    { role: "assistant", content: "这是组合运行时的回复。" },
  ]);
  const replayedConversation = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events?limit=2000`, { token });
  assert.equal(replayedConversation.response.status, 200);
  assert.ok(replayedConversation.payload.data.events.some((event) => event.kind === "run.reasoning.delta"));
  assert.ok(replayedConversation.payload.data.events.some((event) => event.kind === "run.persisted"));
  const summaryReplay = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events?view=summary`, { token });
  const reasoningHeading = summaryReplay.payload.data.events.find((event) => event.kind === "run.reasoning.delta");
  assert.equal(reasoningHeading.payload.content, "核对上下文。");
  const details = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events/details`, { token, method: "POST", body: { eventIds: [reasoningHeading.eventId] } });
  assert.equal(details.response.status, 200);
  assert.equal(details.payload.data.events[0].payload.content, "核对上下文。");
  const getDetails = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events/details?ids=${encodeURIComponent(reasoningHeading.eventId)}`, { token });
  assert.deepEqual(getDetails.payload.data, details.payload.data);
  const anonymousDetails = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events/details`, { method: "POST", body: { eventIds: [reasoningHeading.eventId] } });
  assert.equal(anonymousDetails.response.status, 401);
  const conversationTasks = await requestJson(active.baseUrl, `/api/tasks?conversationId=${conversationId}&limit=1000`, { token });
  assert.deepEqual(conversationTasks.payload.data, []);
  const titled = await requestJson(active.baseUrl, `/api/conversations/${conversationId}`, { token });
  assert.equal(titled.payload.data.summary.title, "组合运行时验证");
  const context = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/context`, { token });
  assert.equal(context.response.status, 200);
  assert.deepEqual(context.payload.data.config, { maxTokens: 200_000, autoCompactThreshold: 0.95 });
  assert.equal(context.payload.data.usage.usedTokens, 8);
  assert.equal(context.payload.data.usage.source, "native");
  assert.deepEqual(context.payload.data.usage.parts, [
    { kind: "model_input", tokens: 3, source: "native" },
    { kind: "model_output", tokens: 5, source: "native" },
  ]);
  const configuredContext = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/context`, {
    token,
    method: "PATCH",
    headers: { "if-match": `\"${context.payload.data.revision}\"` },
    body: { maxTokens: 120_000, autoCompactThreshold: 0.9 },
  });
  assert.equal(configuredContext.response.status, 200);
  assert.deepEqual(configuredContext.payload.data.config, { maxTokens: 120_000, autoCompactThreshold: 0.9 });
  const compactConversation = await requestJson(active.baseUrl, "/api/conversations", {
    token, method: "POST", headers: { "idempotency-key": "runtime-compact-conversation" },
    body: { mode: "chat", content: `压缩第一轮：${"历史资料".repeat(400)}`, expectedRevision: 0, response: { providerId: "platform-web", modelId: "fake-model", scope: {} } },
  });
  const compactConversationId = compactConversation.payload.data.conversation.id;
  await services.interactions.waitFor(compactConversation.payload.data.response.runId);
  await services.taskRuntime.waitForIdle();
  for (let index = 2; index <= 3; index += 1) {
    const current = await requestJson(active.baseUrl, `/api/conversations/${compactConversationId}`, { token });
    const appended = await requestJson(active.baseUrl, `/api/conversations/${compactConversationId}/messages`, {
      token,
      method: "POST",
      headers: { "idempotency-key": `runtime-compact-message-${index}`, "if-match": `"${current.payload.data.summary.revision}"` },
      body: { content: `压缩第 ${index} 轮：${"历史资料".repeat(400)}`, response: { providerId: "platform-web", modelId: "fake-model", scope: {} } },
    });
    await services.interactions.waitFor(appended.payload.data.response.runId);
  }
  const compactBefore = await requestJson(active.baseUrl, `/api/conversations/${compactConversationId}/context`, { token });
  const compact = await requestJson(active.baseUrl, `/api/conversations/${compactConversationId}/context/compact`, { token, method: "POST", body: {} });
  assert.equal(compact.response.status, 200);
  assert.ok(compact.payload.data.usage.parts.some((entry) => entry.kind === "system"));
  assert.ok(compact.payload.data.usage.usedTokens < compactBefore.payload.data.usage.usedTokens);
  const compactDetail = await requestJson(active.baseUrl, `/api/conversations/${compactConversationId}`, { token });
  await requestJson(active.baseUrl, `/api/conversations/${compactConversationId}`, {
    token, method: "DELETE", headers: { "idempotency-key": "runtime-delete-compact", "if-match": `"${compactDetail.payload.data.summary.revision}"` },
  });
  const afterReply = await requestJson(active.baseUrl, "/api/bootstrap", { token });
  assert.deepEqual(afterReply.payload.data.recentConversations, []);
  assert.equal(afterReply.payload.data.projects[0].conversationCount, 1);
  const projectConversationPage = await requestJson(active.baseUrl, `/api/conversations?projectId=${project.payload.data.id}&limit=4`, { token });
  assert.equal(projectConversationPage.payload.data.items.length, 1);
  assert.equal(projectConversationPage.payload.data.items[0].id, conversationId);
  assert.equal(projectConversationPage.payload.data.items[0].projectId, project.payload.data.id);

  const retried = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/actions`, {
    token,
    method: "POST",
    headers: { "idempotency-key": "runtime-retry-0001" },
    body: {
      action: "retry",
      branchId: messages.payload.data.items[0].branchId,
      messageId: messages.payload.data.items[1].id,
      expectedRevision: projectConversationPage.payload.data.items[0].revision,
      response: { providerId: "platform-web", modelId: "fake-model", scope: {} },
    },
  });
  assert.equal(retried.response.status, 200);
  await services.interactions.waitFor(retried.payload.data.response.runId);
  const afterRetry = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/messages`, { token });
  assert.notEqual(afterRetry.payload.data.items[1].id, messages.payload.data.items[1].id);
  const afterRetryDetail = await requestJson(active.baseUrl, `/api/conversations/${conversationId}`, { token });

  const removedEditAction = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/actions`, {
    token,
    method: "POST",
    headers: { "idempotency-key": "runtime-removed-edit-action" },
    body: {
      action: "edit-latest",
      expectedRevision: afterRetryDetail.payload.data.summary.revision,
    },
  });
  assert.equal(removedEditAction.response.status, 400);
  assert.equal(removedEditAction.payload.error.code, "CONVERSATION_ACTION_INVALID");

  await active.gateway.close();
  active = await startGateway({ dataRoot, helpFile, webModelFactory: fakeModelFactory });
  const restored = await requestJson(active.baseUrl, "/api/bootstrap", { token });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.data.projects[0].id, project.payload.data.id);
  assert.deepEqual(restored.payload.data.recentConversations, []);
  const restoredProjectConversationPage = await requestJson(active.baseUrl, `/api/conversations?projectId=${project.payload.data.id}&limit=4`, { token });
  assert.equal(restoredProjectConversationPage.payload.data.items[0].id, conversationId);
  const restoredMessages = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/messages`, { token });
  assert.equal(restoredMessages.payload.data.items.length, 2);
});

test("Realtime 首消息鉴权、帮助 ETag 与 CORS OPTIONS 由独立入口处理", async (t) => {
  const { dataRoot, helpFile } = await temporaryRuntimeRoot(t);
  const active = await startGateway({ dataRoot, helpFile, allowedOrigins: ["https://easywork.test"], webModelFactory: fakeModelFactory });
  t.after(() => active.gateway.close());
  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "socket-user", password: "socket-password", deviceId: "socket-device" },
    headers: { origin: "https://easywork.test" },
  });
  const token = registered.payload.data.token;

  const options = await fetch(`${active.baseUrl}/api/bootstrap`, {
    method: "OPTIONS",
    headers: { origin: "https://easywork.test" },
  });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "https://easywork.test");

  const firstHelp = await fetch(`${active.baseUrl}/api/help`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(firstHelp.status, 200);
  const etag = firstHelp.headers.get("etag");
  assert.ok(etag);
  const cachedHelp = await fetch(`${active.baseUrl}/api/help`, {
    headers: { authorization: `Bearer ${token}`, "if-none-match": etag },
  });
  assert.equal(cachedHelp.status, 304);

  const socket = new WebSocket(active.wsUrl, { origin: "https://easywork.test" });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "authenticate", token, requestId: "socket-auth" }));
  const authenticated = await waitForMessage(socket, (message) => message.type === "authenticated");
  assert.equal(authenticated.actor.username, "socket-user");
});

test("统一入口在同一监听器处理 API、WebSocket 并把页面请求交给渲染回退", async (t) => {
  const { dataRoot, helpFile } = await temporaryRuntimeRoot(t);
  const fallbackRequests = [];
  const gateway = await createGatewayServer({
    runtimeOptions: { dataRoot, helpFile, webModelFactory: fakeModelFactory },
    fallbackRequestHandler(request, response) {
      fallbackRequests.push(request.url);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<main>EasyWork renderer</main>");
    },
  });
  t.after(() => gateway.close());
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${baseUrl}/help`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<main>EasyWork renderer</main>");
  assert.deepEqual(fallbackRequests, ["/help"]);

  const health = await requestJson(baseUrl, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.data.service, "easywork");
  assert.deepEqual(fallbackRequests, ["/help"]);

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/easywork-ws`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("首轮标题生成失败不影响主回复并保留首问截断标题", async (t) => {
  const { dataRoot, helpFile } = await temporaryRuntimeRoot(t);
  const active = await startGateway({ dataRoot, helpFile, webModelFactory: titleFailureModelFactory });
  t.after(() => active.gateway.close());
  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "title-fallback-user", password: "runtime-password", deviceId: "title-fallback-device" },
  });
  const token = registered.payload.data.token;
  const firstQuestion = "这是标题生成失败时仍需保留的首轮问题";
  const created = await requestJson(active.baseUrl, "/api/conversations", {
    token,
    method: "POST",
    headers: { "idempotency-key": "title-fallback-conversation" },
    body: {
      mode: "chat",
      content: firstQuestion,
      expectedRevision: 0,
      response: { providerId: "platform-web", modelId: "fake-model", scope: {} },
    },
  });
  const session = await active.gateway.runtime.auth.resolveSession(token);
  const services = await active.gateway.runtime.servicesForActor(session.actor);
  await services.interactions.waitFor(created.payload.data.response.runId);
  await services.taskRuntime.waitForIdle();
  const detail = await requestJson(active.baseUrl, `/api/conversations/${created.payload.data.conversation.id}`, { token });
  const messages = await requestJson(active.baseUrl, `/api/conversations/${created.payload.data.conversation.id}/messages`, { token });
  const context = await requestJson(active.baseUrl, `/api/conversations/${created.payload.data.conversation.id}/context`, { token });
  assert.equal(detail.payload.data.summary.title, firstQuestion);
  assert.equal(messages.payload.data.items.at(-1).content, "主回复正常完成。");
  assert.equal(context.payload.data.usage.source, "estimated");
  assert.ok(context.payload.data.usage.usedTokens >= firstQuestion.length);
  assert.ok(context.payload.data.usage.parts.every((part) => part.source === "estimated"));
  const audit = await services.audit.list();
  const failure = audit.items.find((event) => event.action === "conversation.title.generate");
  assert.equal(failure.status, "failure");
  assert.equal(failure.target.conversationId, created.payload.data.conversation.id);
  assert.equal(failure.requestId, created.payload.data.response.runId);
  assert.equal(failure.metadata.code, "MODEL_UNAVAILABLE");
});

async function titleRuntime(t, completeTitle) {
  const { dataRoot, helpFile } = await temporaryRuntimeRoot(t);
  const active = await startGateway({ dataRoot, helpFile, webModelFactory: () => ({
    complete: (input) => String(input.messages?.[0]?.content || "").includes("只输出标题本身")
      ? completeTitle(input)
      : fakeModelFactory().complete(input),
  }) });
  t.after(() => active.gateway.close());
  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST", body: { username: "title-test-user", password: "runtime-password", deviceId: "title-test-device" },
  });
  const token = registered.payload.data.token;
  const session = await active.gateway.runtime.auth.resolveSession(token);
  const services = await active.gateway.runtime.servicesForActor(session.actor);
  return { ...active, token, services, actor: session.actor, create: async (content) => {
    const result = await requestJson(active.baseUrl, "/api/conversations", { token, method: "POST", headers: { "idempotency-key": "title-test-create" }, body: {
      mode: "chat", content, expectedRevision: 0,
      response: { providerId: "platform-web", modelId: "fake-model", scope: {} },
    } });
    assert.equal(result.response.status, 200);
    return result.payload.data;
  } };
}

test("标题思考不受 64 token 截断，英文标题保留完整单词，列表按账号实时接收", async (t) => {
  let titleCalls = 0;
  let titleLimits;
  const generated = "Relaxed Weekend Reading Group Names";
  const active = await titleRuntime(t, async ({ limits }) => {
    titleCalls += 1;
    titleLimits = limits;
    return { content: generated, reasoning: "Reasoning about the title. ".repeat(100), toolCalls: [], usage: { completion_tokens: 650 } };
  });
  const socket = new WebSocket(active.wsUrl);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const authentication = waitForMessage(socket, (message) => message.type === "authenticated");
  socket.send(JSON.stringify({ type: "authenticate", token: active.token }));
  await authentication;
  const topic = `conversations:${active.actor.actorId}`;
  const subscription = waitForMessage(socket, (message) => message.type === "subscribed");
  socket.send(JSON.stringify({ type: "subscribe", topics: [topic] }));
  assert.deepEqual((await subscription).topics, [topic]);
  const metadata = waitForMessage(socket, (message) => message.type === "event" && message.event.kind === "conversation.title.updated");
  const created = await active.create("帮我给周末的读书小组想三个名字，轻松一点。");
  await active.services.interactions.waitFor(created.response.runId);
  await active.services.taskRuntime.waitForIdle();
  const event = (await metadata).event;
  const detail = await active.services.baseConversations.getConversation(created.conversation.id);
  assert.equal(titleLimits.maxOutputTokens, null);
  assert.equal(detail.summary.title, generated);
  assert.equal(event.topic, topic);
  assert.equal(event.ids.conversationId, created.conversation.id);
  assert.equal(event.payload.title, generated);
  assert.equal(event.payload.conversationRevision, detail.summary.revision);
  const list = await active.services.baseConversations.listConversations({ limit: 100 });
  assert.equal(list.items[0].title, generated);

  const next = await requestJson(active.baseUrl, `/api/conversations/${created.conversation.id}/messages`, {
    token: active.token, method: "POST", headers: { "if-match": `"${detail.summary.revision}"`, "idempotency-key": "title-test-next-message" },
    body: { content: "再轻松一点呢", response: { providerId: "platform-web", modelId: "fake-model", scope: {} } },
  });
  assert.equal(next.response.status, 200);
  await active.services.interactions.waitFor(next.payload.data.response.runId);
  await active.services.taskRuntime.waitForIdle();
  assert.equal(titleCalls, 1);
  const forbidden = waitForMessage(socket, (message) => message.type === "error");
  socket.send(JSON.stringify({ type: "subscribe", topics: ["conversations:usr_someone_else"] }));
  assert.equal((await forbidden).error.code, "REALTIME_TOPIC_FORBIDDEN");
});

test("标题请求未结束也可完成主回复，并发修订仅重试保存不重新调用模型", { timeout: 15_000 }, async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let titleCalls = 0;
  const active = await titleRuntime(t, async () => {
    titleCalls += 1;
    started.resolve();
    await gate.promise;
    return { content: "轻松读书小组命名", toolCalls: [], usage: {} };
  });
  try {
    const created = await active.create("读书小组叫什么好呢");
    await started.promise;
    await active.services.interactions.waitFor(created.response.runId);
    assert.equal((await active.services.interactions.status(created.response.runId)).status, "completed");
    const originalRename = active.services.baseConversations.rename.bind(active.services.baseConversations);
    let renameCalls = 0;
    active.services.baseConversations.rename = async (input) => {
      renameCalls += 1;
      if (renameCalls === 1) await active.services.baseConversations.setPinned({
        conversationId: input.conversationId, expectedRevision: input.expectedRevision, pinned: true, commandId: "title-pin-race",
      });
      return originalRename(input);
    };
    gate.resolve();
    await active.services.taskRuntime.waitForIdle();
    const detail = await active.services.baseConversations.getConversation(created.conversation.id);
    assert.equal(detail.summary.title, "轻松读书小组命名");
    assert.equal(detail.summary.pinned, true);
    assert.equal(renameCalls, 2);
    assert.equal(titleCalls, 1);
  } finally { gate.resolve(); }
});

test("标题生成期间的手动重命名优先，后台结果不会覆盖", async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const active = await titleRuntime(t, async () => {
    started.resolve();
    await gate.promise;
    return { content: "模型生成的标题", toolCalls: [], usage: {} };
  });
  try {
    const created = await active.create("给读书小组起个名");
    await started.promise;
    await active.services.interactions.waitFor(created.response.runId);
    const current = await active.services.baseConversations.getConversation(created.conversation.id);
    await active.services.baseConversations.rename({
      conversationId: created.conversation.id, title: "我自己取的标题", expectedRevision: current.summary.revision, commandId: "title-manual-rename",
    });
    gate.resolve();
    await active.services.taskRuntime.waitForIdle();
    assert.equal((await active.services.baseConversations.getConversation(created.conversation.id)).summary.title, "我自己取的标题");
    const events = await active.services.broker.replay(`conversations:${active.actor.actorId}`);
    assert.equal(events.events.filter((event) => event.kind === "conversation.title.updated").length, 0);
  } finally { gate.resolve(); }
});

test("仅返回思考而没有标题正文时记录可诊断的失败", async (t) => {
  const active = await titleRuntime(t, async () => ({ content: "\n\n", reasoning: "Thinking only", toolCalls: [], usage: {} }));
  const created = await active.create("周末读什么书好");
  await active.services.interactions.waitFor(created.response.runId);
  await active.services.taskRuntime.waitForIdle();
  const detail = await active.services.baseConversations.getConversation(created.conversation.id);
  assert.equal(detail.summary.title, "周末读什么书好");
  const audit = await active.services.audit.list();
  assert.equal(audit.items.find((event) => event.action === "conversation.title.generate").metadata.code, "CONVERSATION_TITLE_GENERATION_EMPTY");
});
