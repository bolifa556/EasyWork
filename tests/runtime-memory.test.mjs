import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEasyWorkRuntime } from "../gateway/core/runtime/runtime.mjs";
import {
  ActorServiceContainer,
  memoryExtractionObservations,
  selectRetainedVersionCheckpoint,
  workCurrentState,
} from "../gateway/core/runtime/services.mjs";

test("显式 @ 对话引用不作为自动记忆提取证据", () => {
  const memory = { toolName: "memory_search", knowledge: { key: "memory:1", version: "1", content: "记忆" } };
  const reference = { toolName: "conversation_reference_search", knowledge: { key: "conversation-reference:1", version: "1", content: "引用" } };
  assert.deepEqual(memoryExtractionObservations([memory, reference]), [memory]);
});

test("Work 固定状态只投影选择名称与可用探测结果，不携带连接状态或最终路径", () => {
  assert.deepEqual(workCurrentState({
    server: { profile: { name: "211 算力节点", host: "private.example" }, connection: { status: "connected" } },
    workspace: { canonicalPath: "/home/smr/private/project" },
    agent: { name: "Codex" },
    serverCapabilities: { features: { scheduler: { status: "available", type: "slurm" } } },
  }, {
    serverLabel: "211 算力节点",
    workspaceLabel: "选中的项目目录",
    agentLabel: "Codex",
  }), {
    server: { name: "211 算力节点", scheduler: "slurm" },
    workspace: { name: "选中的项目目录" },
    agent: { name: "Codex" },
  });
  assert.deepEqual(workCurrentState({
    server: { profile: { host: "private.example" }, connection: { status: "connected" } },
    workspace: { canonicalPath: "/home/smr/project-a" },
    agent: { name: "OpenCode" },
    serverCapabilities: { features: { scheduler: { status: "unavailable", type: "none" } } },
  }, {
    serverLabel: "scnet-gpu",
    workspaceLabel: "project-a",
    agentLabel: "OpenCode",
  }), {
    server: { name: "scnet-gpu" },
    workspace: { name: "project-a" },
    agent: { name: "OpenCode" },
  });
  assert.deepEqual(workCurrentState({
    server: { profile: { host: "private.example" }, connection: { status: "connected" } },
    workspace: { canonicalPath: "/home/smr/project-a" },
    agent: { name: "OpenCode" },
  }, {
    workspaceLabel: "project-a",
  }), {
    workspace: { name: "project-a" },
    agent: { name: "OpenCode" },
  });
  assert.deepEqual(workCurrentState({
    server: { profile: { name: "211 算力节点" } },
    workspace: { canonicalPath: "/home/smr/research/project-a" },
    agent: { name: "OpenCode" },
  }, {
    workspaceId: "ws_7c8b03076dc9dedc35b564a9",
    workspacePath: "ws_7c8b03076dc9dedc35b564a9",
    workspaceLabel: "ws_7c8b03076dc9dedc35b564a9",
  }), {
    server: { name: "211 算力节点" },
    workspace: { name: "project-a" },
    agent: { name: "OpenCode" },
  });
  assert.deepEqual(workCurrentState({
    server: { profile: { name: "211 算力节点" } },
    workspace: { kind: "virtual", canonicalPath: "/home/smr/.easywork/workspaces/user/conversation/ws_internal" },
    agent: { name: "OpenCode" },
  }, {
    workspaceId: "ws_internal",
    workspaceLabel: "ws_internal",
  }), {
    server: { name: "211 算力节点" },
    workspace: { name: "虚拟工作区" },
    agent: { name: "OpenCode" },
  });
  assert.deepEqual(workCurrentState({
    server: { profile: { name: "211 算力节点" } },
    workspace: { canonicalPath: "/home/smr/.easywork/workspaces/user/conversation/ws_internal" },
    agent: { name: "OpenCode" },
  }, {
    workspaceId: "ws_internal",
    workspacePath: "/home/smr/.easywork/workspaces/user/conversation/ws_internal",
  }), {
    server: { name: "211 算力节点" },
    workspace: { name: "虚拟工作区" },
    agent: { name: "OpenCode" },
  });
});

test("分支和回溯跳过净零变更 Task 已移除的临时 Checkpoint", () => {
  const state = {
    checkpoints: [
      { id: "checkpoint_task_changed_after", status: "retained" },
      { id: "checkpoint_task_next_before", status: "retained" },
      { id: "checkpoint_rewound_after", status: "rewound" },
    ],
  };
  const changed = { id: "task_changed", versionCheckpointId: "checkpoint_task_changed_before" };
  const netZero = { id: "task_net_zero", versionCheckpointId: "checkpoint_task_net_zero_before" };
  const following = { id: "task_next", versionCheckpointId: "checkpoint_task_next_before" };

  assert.equal(selectRetainedVersionCheckpoint(state, [changed, netZero]), "checkpoint_task_changed_after");
  assert.equal(selectRetainedVersionCheckpoint(state, [], { boundaryRole: "user", followingTask: following }), "checkpoint_task_next_before");
  assert.equal(selectRetainedVersionCheckpoint(state, [], { boundaryRole: "assistant", followingTask: following }), "checkpoint_task_next_before");
  assert.equal(selectRetainedVersionCheckpoint({ checkpoints: [] }, [netZero]), null);
});

function projectMemoryModelFactory({ runId }, onMemoryInput = () => undefined) {
  return {
    async complete({ messages, tools = [] }) {
      const system = String(messages[0]?.content || "");
      if (system.includes("# 可复用记忆提取")) {
        const exchange = String(messages.at(-1).content || "");
        onMemoryInput({ exchange, tools });
        const toolCalls = exchange.includes("8789")
          ? [{ id: `${runId}:remember`, name: "remember_project", input: { subject: "service-port", content: "项目服务端口为 8789" } }]
          : [];
        return { content: "", reasoning: "", toolCalls, usage: null };
      }
      const user = messages.findLast((entry) => entry.role === "user")?.content || "";
      if (user.includes("记住")) return { content: "已确认项目服务端口为 8789。", reasoning: "", toolCalls: [], usage: null };
      const memory = messages.find((entry) => entry.role === "system" && String(entry.content).includes("项目服务端口为 8789"));
      return { content: `跨对话读取：${memory?.content || "未找到"}`, reasoning: "", toolCalls: [], usage: null };
    },
  };
}

async function fixture(t, webModelFactory = projectMemoryModelFactory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-runtime-memory-"));
  const runtime = await createEasyWorkRuntime({ dataRoot: path.join(root, "data"), webModelFactory });
  t.after(async () => {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const registered = await runtime.auth.register({ username: `memory-${Date.now()}`, password: "password-value", deviceId: "device-a" });
  const session = await runtime.auth.resolveSession(registered.token);
  return { runtime, services: await runtime.servicesForActor(session.actor) };
}

async function isolatedContainer(t, actorId) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-runtime-container-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ActorServiceContainer(
    { clock: () => new Date(), dataRoot: path.join(root, "data") },
    { actorType: "user", actorId },
  );
}

test("网页失败但未创建远端任务的工作请求直接重试，不连接 SSH 或变更远端上下文", async (t) => {
  const { services } = await fixture(t);
  const created = await services.baseConversations.sendMessage({ mode: "work", role: "user", content: "更新技能", expectedRevision: 0, commandId: "failed-before-handoff" });
  services.servers.findConversationBinding = async () => { throw new Error("无远端任务时不应连接 SSH 回退"); };
  const responded = [];
  services.interactions.respond = async (input) => { responded.push(input); return { runId: "retried-web-run" }; };
  const result = await services.conversations.retry({ conversationId: created.conversation.id, branchId: created.branchId, messageId: created.messageId,
    expectedRevision: created.conversation.revision, commandId: "retry-before-handoff",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  assert.deepEqual(result.nativeConversation, { applied: true, unchanged: true, reason: "no_remote_task" });
  assert.equal(result.response.runId, "retried-web-run");
  assert.equal(responded[0].messageId, created.messageId);
});

test("Web Agent 在每轮冻结快照后跨对话读取同项目记忆", async (t) => {
  const extractionInputs = [];
  const { services } = await fixture(t, (options) => projectMemoryModelFactory(options, (input) => extractionInputs.push(input)));
  const project = await services.projects.create({ name: "Memory Project" });
  const first = await services.conversations.sendMessage({
    mode: "chat",
    projectId: project.id,
    content: "记住这个项目的服务端口",
    expectedRevision: 0,
    commandId: "memory-first-message",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(first.response.runId);
  await services.waitForIdle();

  const sameConversationScope = await services.memoryCoordinator.freezeScope({
    actorType: services.actor.actorType,
    actorId: services.actor.actorId,
    userId: services.actor.userId,
    projectId: project.id,
    conversationId: first.conversation.id,
    workspaceId: null,
    taskId: null,
    serverId: null,
    serverIdentity: null,
    versionDomainId: null,
    memoryMode: "project-only",
    branchId: first.branchId,
    memorySnapshotSequence: 0,
    memorySnapshotVersionIds: [],
    resourceBindingSnapshotId: null,
    selectedCollectionIds: [],
    selectedSkillVersions: [],
    capabilities: [],
    contextEpoch: 0,
  });
  const sameConversation = await services.searchContext({
    scope: sameConversationScope,
    query: "项目服务端口",
    sources: ["memory"],
    limit: 8,
  });
  assert.deepEqual(sameConversation.memory, []);

  const second = await services.conversations.sendMessage({
    mode: "chat",
    projectId: project.id,
    content: "另一个对话里项目服务端口是多少？",
    expectedRevision: 0,
    commandId: "memory-second-message",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(second.response.runId);
  const messages = await services.baseConversations.listMessages({ conversationId: second.conversation.id, branchId: second.branchId, limit: 20 });
  assert.match(messages.items.at(-1).content, /项目服务端口为 8789/);
  assert.ok(extractionInputs.length >= 1);
  for (const { exchange, tools } of extractionInputs) {
    assert.match(exchange, /^## 用户请求\n/);
    assert.match(exchange, /\n\n## 最终结果\n/);
    assert.doesNotMatch(exchange, /可用记忆层级|scopeIds|availableLevels|conversation_\d|workspace_\d|project_\d|branch_\d/);
    assert.deepEqual(tools.map((tool) => tool.name), ["remember_project", "remember_conversation"]);
  }
});

test("删除对话会失效该对话提升到项目层的派生记忆", async (t) => {
  const { services } = await fixture(t);
  const project = await services.projects.create({ name: "Deleted Memory Project" });
  const first = await services.conversations.sendMessage({
    mode: "chat",
    projectId: project.id,
    content: "记住这个项目的服务端口",
    expectedRevision: 0,
    commandId: "deleted-memory-first-message",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(first.response.runId);
  await services.waitForIdle();

  const current = await services.baseConversations.getConversation(first.conversation.id);
  await services.conversations.delete({
    conversationId: first.conversation.id,
    expectedRevision: current.summary.revision,
    commandId: "delete-memory-source-conversation",
  });
  await services.waitForIdle();
  const cleanupQueue = (await services.conversationDeletionCleanup.read()).data;
  assert.equal(cleanupQueue.mode, "pending");
  assert.equal(cleanupQueue.local[first.conversation.id], undefined);

  const next = await services.conversations.sendMessage({
    mode: "chat",
    projectId: project.id,
    content: "删除来源对话后，项目服务端口是多少？",
    expectedRevision: 0,
    commandId: "deleted-memory-second-message",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(next.response.runId);
  const messages = await services.baseConversations.listMessages({ conversationId: next.conversation.id, branchId: next.branchId, limit: 20 });
  assert.doesNotMatch(messages.items.at(-1).content, /8789/);

  const scope = await services.memoryCoordinator.freezeScope({
    actorType: services.actor.actorType,
    actorId: services.actor.actorId,
    userId: services.actor.userId,
    projectId: project.id,
    conversationId: next.conversation.id,
    workspaceId: null,
    taskId: null,
    serverId: null,
    serverIdentity: null,
    versionDomainId: null,
    memoryMode: "project-only",
    branchId: next.branchId,
    memorySnapshotSequence: 0,
    memorySnapshotVersionIds: [],
    resourceBindingSnapshotId: null,
    selectedCollectionIds: [],
    selectedSkillVersions: [],
    capabilities: [],
    contextEpoch: 0,
  });
  assert.deepEqual((await services.memory.select(scope)).entries, []);
});

test("删除登记跨越墓碑提交崩溃窗口，提交前中断不误删、提交后中断可恢复", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-runtime-delete-transaction-"));
  const dataRoot = path.join(root, "data");
  let firstRuntime = await createEasyWorkRuntime({ dataRoot, webModelFactory: projectMemoryModelFactory });
  let secondRuntime = null;
  let thirdRuntime = null;
  t.after(async () => {
    await firstRuntime?.close().catch(() => undefined);
    await secondRuntime?.close().catch(() => undefined);
    await thirdRuntime?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 40 });
  });

  const registered = await firstRuntime.auth.register({ username: `delete-transaction-${Date.now()}`, password: "password-value", deviceId: "device-a" });
  const session = await firstRuntime.auth.resolveSession(registered.token);
  const firstServices = await firstRuntime.servicesForActor(session.actor);
  const created = await firstServices.baseConversations.sendMessage({
    mode: "chat",
    role: "user",
    content: "用于验证删除事务边界",
    expectedRevision: 0,
    commandId: "delete-transaction-create",
  });

  const prepareCleanup = firstServices.baseConversations.beforeIndexCommit;
  firstServices.baseConversations.beforeIndexCommit = async (input) => {
    await prepareCleanup(input);
    if (input.operation === "conversation.delete") throw new Error("simulated crash before tombstone commit");
  };
  await assert.rejects(firstServices.baseConversations.delete({
    conversationId: created.conversation.id,
    expectedRevision: created.conversation.revision,
    commandId: "delete-transaction-aborted",
  }), /simulated crash/);
  assert.equal((await firstServices.conversationDeletionCleanup.read()).data.local[created.conversation.id], "2");
  assert.equal((await firstServices.baseConversations.listConversations()).items.some((entry) => entry.id === created.conversation.id), true);

  await firstRuntime.close();
  firstRuntime = null;
  secondRuntime = await createEasyWorkRuntime({ dataRoot, webModelFactory: projectMemoryModelFactory });
  const secondServices = await secondRuntime.servicesForActor(session.actor);
  await secondServices.waitForIdle();
  assert.deepEqual((await secondServices.conversationDeletionCleanup.read()).data.local, {});
  const stillLive = await secondServices.baseConversations.getConversation(created.conversation.id);
  assert.equal(stillLive.summary.deletedAt, null);

  await secondServices.baseConversations.delete({
    conversationId: created.conversation.id,
    expectedRevision: stillLive.summary.revision,
    commandId: "delete-transaction-committed",
  });
  assert.equal((await secondServices.conversationDeletionCleanup.read()).data.local[created.conversation.id], "2");
  await secondRuntime.close();
  secondRuntime = null;

  thirdRuntime = await createEasyWorkRuntime({ dataRoot, webModelFactory: projectMemoryModelFactory });
  const thirdServices = await thirdRuntime.servicesForActor(session.actor);
  await thirdServices.waitForIdle();
  assert.deepEqual((await thirdServices.conversationDeletionCleanup.read()).data.local, {});
  assert.equal((await thirdServices.baseConversations.listDeletedConversations()).some((entry) => entry.id === created.conversation.id), true);
});

test("Work 记忆查询不把当前原生 Agent 会话自己产生的事实再发回去", async (t) => {
  const container = await isolatedContainer(t, "user-memory-filter");
  container.memory = {
    async contextEntries() {
      return [
        { content: "当前原生会话刚刚查询到的服务器情况", origin: { type: "remote-task", id: "task-current-session" } },
        { content: "原生分支点之前父会话已经知道的事实", origin: { type: "remote-task", id: "task-parent-before-fork" } },
        { content: "另一个 Agent 会话提供的新事实", origin: { type: "remote-task", id: "task-other-session" } },
        { content: "用户手工保存的偏好", origin: { type: "conversation-message", id: "message-user" } },
      ];
    },
  };
  container.memoryCoordinator = {
    async excludeConversationEntries(entries) { return entries; },
  };
  container.taskRuntime = {
    async loadBinding() { return { native: { sessionId: "native-current" } }; },
  };
  container.contextHub = {
    async listBindingCheckpointIds() { return ["task-parent-before-fork"]; },
  };
  container.taskStore = {
    async getTask(taskId) {
      return {
        id: taskId,
        agentBindingId: taskId === "task-parent-before-fork" ? "binding-parent" : "binding-current",
      };
    },
  };
  container.taskReports = {
    async get(taskId) {
      return { evidence: [{ source: { sessionId: taskId === "task-current-session" ? "native-current" : "native-other" } }] };
    },
  };

  const result = await container.searchContext({
    scope: {},
    query: "服务器",
    sources: ["memory"],
    limit: 8,
    excludeAgentBindingId: "binding-current",
  });

  assert.deepEqual(result.memory.map((entry) => entry.content), ["另一个 Agent 会话提供的新事实", "用户手工保存的偏好"]);
});

test("Chat 上下文搜索不按当前连接服务器裁剪已安装技能", async (t) => {
  const container = await isolatedContainer(t, "user-chat-skills");
  const selectedSkillIds = [];
  container.skills = {
    async listInstalledKnowledge() {
      return { items: [
        { skillId: "skill-compute", name: "计算 Skill", description: "计算节点上的 Slurm 作业", applicability: { serverKind: "compute", allowServers: [], denyServers: [] } },
        { skillId: "skill-standard", name: "标准 Skill", description: "普通服务器工作", applicability: { serverKind: "standard", allowServers: [], denyServers: [] } },
      ] };
    },
    async searchContext({ selectedSkillIds: ids }) {
      selectedSkillIds.push(...ids);
      return [];
    },
  };
  container.servers = {
    async get() { throw new Error("Chat 技能查询不应读取服务器"); },
  };

  await container.searchContext({
    scope: { serverId: "server-connected" },
    query: "技能",
    sources: ["skills"],
    filterSkillsByServer: false,
  });

  assert.deepEqual(selectedSkillIds, ["skill-compute", "skill-standard"]);
});

test("模式边界同样约束手动选择，Chat 不让工作模式技能进入读取", async (t) => {
  const container = await isolatedContainer(t, "user-mode-skills");
  const selectedSkillIds = [];
  container.skills = {
    async listInstalledKnowledge() { return { items: [
      { skillId: "only-chat", name: "聊天说明", applicability: { mode: "chat" } },
      { skillId: "only-work", name: "工作说明", applicability: { mode: "work", forceEnabled: true } },
      { skillId: "both", name: "通用说明", applicability: { mode: "all" } },
    ] }; },
    async searchContext({ selectedSkillIds: ids }) { selectedSkillIds.push(...ids); return []; },
  };
  await container.searchContext({ scope: { selectedSkillVersions: [{ skillId: "only-work", version: "1.0.0" }] }, query: "技能", sources: ["skills"], filterSkillsByServer: false, mode: "chat" });
  assert.equal(selectedSkillIds.includes("only-work"), false);
  assert.ok(selectedSkillIds.every((id) => ["only-chat", "both"].includes(id)));
});

test("全部模式强制 Skill 在 Chat 按需读取，下一轮复用正文且不重复检索", async (t) => {
  const skillName = "通用核验说明";
  const skillBody = "核验时保留蓝色签收记录。";
  const modelInputs = [];
  let discoveryCalls = 0;
  let skillReads = 0;
  const { services } = await fixture(t, ({ runId }) => {
    let iteration = 0;
    return {
      async complete({ messages, tools = [] }) {
        if (String(messages[0]?.content || "").includes("你为一个已安装 Skill 生成发现简介")) {
          discoveryCalls++;
          return { content: "当用户需要核验签收记录或沿用核验规则时使用，要求保留蓝色签收记录。", reasoning: "", toolCalls: [], usage: null };
        }
        if (!tools.some((tool) => tool.name === "skill_search")) {
          return { content: "", reasoning: "", toolCalls: [], usage: null };
        }
        modelInputs.push(structuredClone(messages));
        const user = messages.findLast((entry) => entry.role === "user")?.content || "";
        if (iteration++ === 0 && user.includes("读取")) {
          return {
            content: "", reasoning: "", usage: null,
            toolCalls: [{ id: `${runId}:skill`, name: "skill_search", input: { name: skillName, query: "核验" } }],
          };
        }
        return { content: "已确认。", reasoning: "", toolCalls: [], usage: null };
      },
    };
  });
  await services.skills.installPackage({
    skillId: "all-mode-forced", version: "1.0.0",
    manifest: { name: skillName, description: "核验记录的通用规则。", entrypoint: "SKILL.md", permissions: [] },
    files: [{ path: "SKILL.md", content: skillBody }],
    applicability: { mode: "all", forceEnabled: true },
  });
  const search = services.skills.searchContext.bind(services.skills);
  services.skills.searchContext = async (input) => { skillReads += 1; return search(input); };
  const first = await services.conversations.sendMessage({
    mode: "chat", content: `读取${skillName}。`, expectedRevision: 0, commandId: "chat-forced-skill-first",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(first.response.runId);
  await services.waitForIdle();
  assert.equal(discoveryCalls, 0, "对话复用已安装技能简介，不按用户再次生成");
  assert.ok(modelInputs[0].some((entry) => String(entry.content).includes("核验记录的通用规则。")));
  const initialCatalog = modelInputs[0].find((entry) => String(entry.content).startsWith("可用 Skill 目录\n\n"))?.content;
  assert.ok(initialCatalog, "Chat 使用独立技能目录");
  assert.doesNotMatch(initialCatalog, /（已读取）|已发送|远端/);
  assert.equal(skillReads, 1);
  assert.ok(modelInputs.some((messages) => messages.some((entry) => String(entry.content).includes(skillBody))));
  const current = await services.baseConversations.getConversation(first.conversation.id);
  modelInputs.length = 0;
  const second = await services.conversations.sendMessage({
    mode: "chat", conversationId: first.conversation.id, branchId: first.branchId,
    content: "沿用核验规则。", expectedRevision: current.summary.revision, commandId: "chat-forced-skill-second",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(second.response.runId);
  assert.equal(skillReads, 1);
  assert.ok(modelInputs[0].some((entry) => String(entry.content).includes(skillBody)));
  const readCatalog = modelInputs[0].find((entry) => String(entry.content).startsWith("可用 Skill 目录\n\n"))?.content;
  assert.ok(readCatalog?.includes(`${skillName}（已读取）`), "后续提问标记本分支已经读取的技能");
  await services.waitForIdle();
  await services.skills.updateInstalled("all-mode-forced", {
    expectedRevision: (await services.skills.listInstalled()).revision,
    fileUpdates: [{ path: "SKILL.md", content: "核验时保留绿色签收记录。" }],
  });
  modelInputs.length = 0;
  const third = await services.conversations.sendMessage({
    mode: "chat", conversationId: first.conversation.id, branchId: first.branchId,
    content: "沿用核验规则。", expectedRevision: (await services.baseConversations.getConversation(first.conversation.id)).summary.revision,
    commandId: "chat-forced-skill-updated", response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(third.response.runId);
  const updatedCatalog = modelInputs[0].find((entry) => String(entry.content).startsWith("可用 Skill 目录\n\n"))?.content;
  assert.ok(updatedCatalog);
  assert.doesNotMatch(updatedCatalog, /（已读取）/, "技能内容改变后不能继续标记已读取");
});

test("Work Skill 目录只依据显式适用范围过滤，不从名称简介猜测服务器", async (t) => {
  const container = await isolatedContainer(t, "user-work-skills");
  container.servers = {
    async get() {
      return { profile: { id: "server-reta", serverIdentity: "ssh-reta", name: "reta服务器", host: "211.86.151.186" } };
    },
  };
  container.serverCapabilities = {
    async peek() { return { features: { scheduler: { type: "none" } } }; },
    async get() { throw new Error("cached capability should be reused"); },
  };

  const filtered = await container.filterSkillCatalogForServer("server-reta", [
    { skillId: "legacy-compute", name: "本科生算力平台使用规范", description: "适用于 USTC 登录节点、Slurm 队列和 GPU 作业。" },
    { skillId: "legacy-standard", name: "发布说明规范", description: "生成 Markdown 发布说明。" },
    { skillId: "explicit-all", name: "显式通用算力规范", description: "包含 Slurm 文本但由用户明确允许所有服务器。", applicability: { serverKind: "all", allowServers: [], denyServers: [] } },
    { skillId: "explicit-compute", name: "显式计算规范", description: "计算任务。", applicability: { serverKind: "compute", allowServers: [], denyServers: [] } },
  ]);

  assert.deepEqual(filtered.map((entry) => entry.skillId), ["legacy-compute", "legacy-standard", "explicit-all"]);
});

test("Work 读取按个人 Skill 的允许禁止规则过滤，强制启用或手动点选不能绕过", async (t) => {
  const container = await isolatedContainer(t, "user-skill-server-rules");
  const catalog = [
    { skillId: "allowed", name: "可用规范", applicability: { mode: "work", allowServers: ["server-reta"], forceEnabled: true } },
    { skillId: "wrong-host", name: "其他服务器规范", applicability: { mode: "work", allowServers: ["107.ustc.edu.cn"], forceEnabled: true } },
    { skillId: "denied", name: "禁用规范", applicability: { mode: "all", allowServers: ["server-reta"], denyServers: ["211.86.151.186"] } },
    { skillId: "chat-only", name: "聊天规范", applicability: { mode: "chat" } },
  ];
  const selectedIds = [];
  container.servers = { async get() { return { profile: { id: "server-reta", name: "reta", host: "211.86.151.186" } }; } };
  container.serverCapabilities = { async peek() { return { features: { scheduler: { type: "none" } } }; } };
  container.skills = {
    async listInstalledKnowledge() { return { items: catalog }; },
    async searchContext({ selectedSkillIds }) { selectedIds.push(...selectedSkillIds); return []; },
  };
  await container.searchContext({
    scope: { serverId: "server-reta", selectedSkillVersions: [{ skillId: "denied", version: "1.0.0" }, { skillId: "wrong-host", version: "1.0.0" }] },
    query: "规范", sources: ["skills"], mode: "work",
  });
  assert.deepEqual(selectedIds, ["allowed"]);
});

test("没有显式服务器范围的 Skill 在不同服务器保持可见", async (t) => {
  const container = await isolatedContainer(t, "user-work-scnet-skills");
  container.servers = {
    async get() {
      return { profile: { id: "server-scnet", serverIdentity: "ssh-scnet", name: "scnet-gpu", host: "qdeshell.hpccube.com" } };
    },
  };
  container.serverCapabilities = {
    async peek() { return { features: { scheduler: { type: "slurm" } } }; },
    async get() { throw new Error("cached capability should be reused"); },
  };

  const filtered = await container.filterSkillCatalogForServer("server-scnet", [
    { skillId: "legacy-ustc", name: "本科生算力平台使用规范", description: "适用于 USTC 登录节点、Slurm 队列和 GPU 作业。" },
    { skillId: "generic-slurm", name: "通用 Slurm 基线", description: "生成 sbatch 脚本并检查 CPU 和内存参数。" },
  ]);

  assert.deepEqual(filtered.map((entry) => entry.skillId), ["legacy-ustc", "generic-slurm"]);
});

test("Work 只有运行中追加绕过网页 Agent，中断后的新请求重新检索上下文", async () => {
  const source = await fs.readFile(path.resolve("gateway/core/runtime/services.mjs"), "utf8");
  assert.match(source, /const skipWebAgentModel = mode === "work" && !taskId && Boolean\(directRemoteTask\)/);
  assert.match(source, /statuses: \["running"\]/);
  assert.doesNotMatch(source, /workRequestNeedsContext|WORK_CONTEXT_REQUEST/);
});

test("辅助模型入口拒绝对象序列化输入", async (t) => {
  const { runtime, services } = await fixture(t);
  await assert.rejects(runtime.completeAuxiliary({
    actor: services.actor,
    providerId: "platform-web",
    modelId: "memory-model",
    runId: "auxiliary-object-input",
    system: "system",
    input: { backendId: "private" },
  }), (error) => {
    assert.equal(error.code, "AUXILIARY_MODEL_INPUT_TEXT_REQUIRED");
    return true;
  });
});

test("文件发现简介不给推理模型设置会截断正文的输出上限", async (t) => {
  let summaryLimits;
  const { services } = await fixture(t, () => ({
    async complete({ limits }) {
      summaryLimits = limits;
      return { content: "一份介绍蓝绿发布步骤的文档。", reasoning: "先阅读文件。", toolCalls: [], usage: null };
    },
  }));
  const summary = await services.resources.summaryGenerator({
    filename: "deploy.md",
    sha256: "a".repeat(64),
    parsed: { text: "先发布绿色版本，再验证健康检查。" },
    providerId: "platform-web",
    modelId: "reasoning-model",
  });
  assert.equal(summary, "一份介绍蓝绿发布步骤的文档。");
  assert.equal(summaryLimits.maxOutputTokens, null);
});

test("独立记忆提取失败不影响网页最终回复落盘", async (t) => {
  const { services } = await fixture(t, ({ runId }) => ({
    async complete({ messages }) {
      if (String(messages[0]?.content || "").includes("# 可复用记忆提取")) throw new Error("extractor failed");
      return { content: `reply:${runId}`, reasoning: "", toolCalls: [], usage: null };
    },
  }));
  const sent = await services.conversations.sendMessage({
    mode: "chat",
    content: "仍需回复",
    expectedRevision: 0,
    commandId: "memory-extraction-failure",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(sent.response.runId);
  await services.waitForIdle();
  const messages = await services.baseConversations.listMessages({ conversationId: sent.conversation.id, branchId: sent.branchId, limit: 20 });
  assert.match(messages.items.at(-1).content, /^reply:web_/);
  assert.equal((await services.memory.snapshot(await services.memoryCoordinator.freezeScope({
    actorType: services.actor.actorType,
    actorId: services.actor.actorId,
    userId: services.actor.userId,
    projectId: null,
    conversationId: sent.conversation.id,
    workspaceId: null,
    taskId: null,
    serverId: null,
    serverIdentity: null,
    versionDomainId: null,
    memoryMode: "global",
    branchId: sent.branchId,
    memorySnapshotSequence: 0,
    memorySnapshotVersionIds: [],
    resourceBindingSnapshotId: null,
    selectedCollectionIds: [],
    selectedSkillVersions: [],
    capabilities: [],
    contextEpoch: 0,
  }))).versionIds.length, 0);
});

test("前一轮网页回复失败后，下一轮不会把未回答请求当成既有对话指令", async (t) => {
  const modelInputs = [];
  const failedPrompt = "FAILED_ORPHAN_PROMPT";
  const currentPrompt = "CURRENT_PROMPT_ONLY";
  const { services } = await fixture(t, () => ({
    async complete({ messages }) {
      const system = String(messages[0]?.content || "");
      if (system.includes("# 可复用记忆提取")) return { content: "", reasoning: "", toolCalls: [], usage: null };
      if (system.includes("只输出标题本身")) return { content: "失败请求隔离", reasoning: "", toolCalls: [], usage: null };
      const serialized = messages.map((entry) => `${entry.role}:${entry.content}`).join("\n");
      modelInputs.push(serialized);
      if (serialized.includes(failedPrompt)) throw new Error("simulated web model failure");
      return { content: "CURRENT_PROMPT_OK", reasoning: "", toolCalls: [], usage: null };
    },
  }));

  const first = await services.conversations.sendMessage({
    mode: "chat",
    content: failedPrompt,
    expectedRevision: 0,
    commandId: "failed-orphan-first",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await assert.rejects(services.interactions.waitFor(first.response.runId), /simulated web model failure/);

  const current = await services.baseConversations.getConversation(first.conversation.id);
  const second = await services.conversations.sendMessage({
    conversationId: first.conversation.id,
    branchId: first.branchId,
    content: currentPrompt,
    expectedRevision: current.summary.revision,
    commandId: "failed-orphan-second",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(second.response.runId);

  const currentInvocation = modelInputs.find((entry) => entry.includes(currentPrompt));
  assert.ok(currentInvocation);
  assert.doesNotMatch(currentInvocation, new RegExp(failedPrompt));
  const messages = await services.baseConversations.listMessages({
    conversationId: first.conversation.id,
    branchId: first.branchId,
    limit: 20,
  });
  assert.deepEqual(messages.items.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: failedPrompt },
    { role: "user", content: currentPrompt },
    { role: "assistant", content: "CURRENT_PROMPT_OK" },
  ]);
});
