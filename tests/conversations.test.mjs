import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { ConversationService } from "../gateway/core/conversations/index.mjs";

const CURSOR_SECRET = "conversation-test-secret-0123456789abcdef";

test("forks retain original message ownership, including legacy data and a second-generation fork", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const created = await startConversation(api, "origins-create", "帮我下载", "work");
  const answered = await api.sendMessage({ conversationId: created.conversation.id, role: "assistant", content: "文件已准备好", taskId: "task-origin", expectedRevision: 1, commandId: "origins-answer" });
  const child = await api.forkConversation({ conversationId: created.conversation.id, atMessageId: answered.messageId, expectedRevision: 2, commandId: "origins-child" });
  const copied = (await api.listMessages({ conversationId: child.conversation.id })).items;
  assert.deepEqual(copied.map((item) => item.originMessageId), [created.messageId, answered.messageId]);
  // Read a pre-upgrade immutable message fixture without rewriting production
  // messages. The storage shim removes only the newly introduced field.
  const read = api.storage.readMessage.bind(api.storage);
  api.storage.readMessage = async (conversationId, messageId) => {
    const value = await read(conversationId, messageId);
    if (conversationId === child.conversation.id) delete value.originMessageId;
    return value;
  };
  assert.deepEqual((await api.listMessages({ conversationId: child.conversation.id })).items.map((item) => item.originMessageId), [created.messageId, answered.messageId]);
  const grandchild = await api.forkConversation({ conversationId: child.conversation.id, atMessageId: copied[1].id, expectedRevision: 1, commandId: "origins-grandchild" });
  assert.deepEqual((await api.listMessages({ conversationId: grandchild.conversation.id })).items.map((item) => item.originMessageId), [created.messageId, answered.messageId]);
  await api.delete({ conversationId: created.conversation.id, expectedRevision: 2, commandId: "origins-delete-parent" });
  assert.deepEqual((await api.listMessages({ conversationId: child.conversation.id })).items.map((item) => item.originMessageId), [created.messageId, answered.messageId]);
}));

function actor(actorId = "alice", actorType = "user") {
  return createActorContext({
    actorType,
    actorId,
    deviceId: "device-1",
    sessionId: "session-1",
    roles: actorType === "user" ? ["user"] : [],
  });
}

async function withFixture(callback) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-conversations-"));
  try {
    return await callback(dataRoot);
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

function service(dataRoot, owner = actor(), options = {}) {
  return new ConversationService({
    dataRoot,
    actor: owner,
    cursorSecret: CURSOR_SECRET,
    indexPageSize: options.indexPageSize ?? 2,
    messagePageSize: options.messagePageSize ?? 2,
    beforeIndexCommit: options.beforeIndexCommit,
    clock: options.clock,
    authorizeProject: options.authorizeProject,
    projectMemoryMode: options.projectMemoryMode,
  });
}

async function startConversation(api, commandId = "create-1", content = "第一条问题", mode = "chat") {
  return api.sendMessage({
    mode,
    role: "user",
    content,
    expectedRevision: 0,
    commandId,
  });
}

test("新对话只在首条用户消息发送时创建，创建后不允许更改类型", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  assert.deepEqual(await api.listConversations(), { items: [], nextCursor: null });
  await assert.rejects(api.sendMessage({ type: "chat", role: "user", content: "旧字段", expectedRevision: 0, commandId: "legacy-mode" }), (error) => error.code === "CONVERSATION_INPUT_UNKNOWN_FIELD");

  await assert.rejects(api.sendMessage({ mode: "chat", role: "assistant", content: "不能创建", expectedRevision: 0, commandId: "bad-create" }), (error) => error.code === "CONVERSATION_LAZY_CREATE_USER_REQUIRED");
  assert.equal((await api.listConversations()).items.length, 0);

  const created = await startConversation(api);
  assert.equal(created.conversation.revision, 1);
  assert.equal(created.conversation.mode, "chat");
  assert.equal(created.conversation.title, "第一条问题");

  await assert.rejects(api.sendMessage({
    conversationId: created.conversation.id,
    mode: "work",
    role: "user",
    content: "偷偷改类型",
    expectedRevision: 1,
    commandId: "wrong-type",
  }), (error) => error.code === "CONVERSATION_MODE_FIXED");

  const work = await startConversation(api, "create-work", "工作任务", "work");
  await assert.rejects(api.sendMessage({
    conversationId: work.conversation.id, mode: "chat", role: "user", content: "不能改为聊天",
    expectedRevision: 1, commandId: "wrong-work-type",
  }), (error) => error.code === "CONVERSATION_MODE_FIXED");
  assert.equal((await api.getConversation(work.conversation.id)).summary.mode, "work");
  assert.equal(typeof api.convertWorkToChat, "undefined");
}));

test("Actor 数据与游标严格隔离 users/guests", async () => withFixture(async (dataRoot) => {
  const alice = service(dataRoot, actor("alice"));
  const bob = service(dataRoot, actor("bob"));
  const guest = service(dataRoot, actor("guest-a", "guest"));
  await startConversation(alice, "alice-create", "Alice 内容");
  await startConversation(guest, "guest-create", "Guest 内容");
  assert.equal((await bob.listConversations()).items.length, 0);
  assert.equal((await guest.listConversations()).items[0].lastMessagePreview, "Guest 内容");
  assert.equal((await fs.readdir(path.join(dataRoot, "users", "alice", "conversations"))).includes("index.json"), true);
  assert.equal((await fs.readdir(path.join(dataRoot, "guests", "guest-a", "conversations"))).includes("index.json"), true);

  const first = await alice.listConversations({ limit: 1 });
  if (first.nextCursor) {
    await assert.rejects(bob.listConversations({ cursor: first.nextCursor }), (error) => error.code === "CURSOR_INVALID");
  }
}));

test("摘要和消息均使用不透明游标分页，存储为分片索引与独立消息对象", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot, actor(), { indexPageSize: 1, messagePageSize: 1 });
  const firstConversation = await startConversation(api, "create-a", "不会完整进入根索引的正文 A");
  await startConversation(api, "create-b", "正文 B");
  await startConversation(api, "create-c", "正文 C");

  const firstPage = await api.listConversations({ limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  assert.equal(firstPage.nextCursor.includes("offset"), false);
  const secondPage = await api.listConversations({ limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id);

  const appended = await api.sendMessage({ conversationId: firstConversation.conversation.id, role: "assistant", content: "回答 A", expectedRevision: 1, commandId: "append-a" });
  const messages1 = await api.listMessages({ conversationId: firstConversation.conversation.id, limit: 1 });
  assert.equal(messages1.items[0].content, "不会完整进入根索引的正文 A");
  assert.ok(messages1.nextCursor);
  const messages2 = await api.listMessages({ conversationId: firstConversation.conversation.id, limit: 1, cursor: messages1.nextCursor });
  assert.equal(messages2.items[0].content, "回答 A");
  assert.equal(messages2.snapshotId, appended.conversation.snapshotId);

  const rootPath = path.join(dataRoot, "users", "alice", "conversations");
  const rootIndex = JSON.parse(await fs.readFile(path.join(rootPath, "index.json"), "utf8"));
  assert.deepEqual(Object.keys(rootIndex.data).sort(), ["count", "generationId"]);
  const indexPages = await fs.readdir(path.join(rootPath, "_index", rootIndex.data.generationId, "pages"));
  assert.equal(indexPages.length, 3);
  const messageFiles = await fs.readdir(path.join(rootPath, firstConversation.conversation.id, "messages"));
  assert.equal(messageFiles.length, 2);
}));

test("bootstrap 仅返回首屏非项目聊天，同时保留项目计数与兼容分页游标", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const firstStandalone = await startConversation(api, "bootstrap-standalone-a", "独立聊天 A");
  const projectConversation = await startConversation(api, "bootstrap-project", "项目聊天");
  await api.moveToProject({
    conversationId: projectConversation.conversation.id,
    projectId: "project-a",
    expectedRevision: projectConversation.conversation.revision,
    commandId: "bootstrap-move-project",
  });
  await startConversation(api, "bootstrap-standalone-b", "独立聊天 B");

  const overview = await api.bootstrapOverview({ limit: 1, projectId: null });
  assert.equal(overview.items.length, 1);
  assert.equal(overview.items[0].projectId, null);
  assert.equal(overview.projectConversationCounts["project-a"], 1);
  assert.ok(overview.nextCursor);

  const secondPage = await api.listConversations({ limit: 10, projectId: null, cursor: overview.nextCursor });
  assert.deepEqual(secondPage.items.map((item) => item.id), [firstStandalone.conversation.id]);
  assert.equal(secondPage.nextCursor, null);
  const projectPage = await api.listConversations({ limit: 4, projectId: "project-a" });
  assert.deepEqual(projectPage.items.map((item) => item.id), [projectConversation.conversation.id]);
}));

test("重命名、项目移动/移出、置顶和删除都要求 expectedRevision", async () => withFixture(async (dataRoot) => {
  let currentTime = "2026-01-01T00:00:00.000Z";
  const api = service(dataRoot, actor(), { clock: () => new Date(currentTime) });
  const created = await startConversation(api);
  const id = created.conversation.id;
  const firstMessageAt = created.conversation.lastMessageAt;
  await assert.rejects(api.rename({ conversationId: id, title: "无 revision", commandId: "rename-bad" }), (error) => error.code === "EXPECTED_REVISION_REQUIRED");
  currentTime = "2026-01-01T01:00:00.000Z";
  const renamed = await api.rename({ conversationId: id, title: "新的名称", expectedRevision: 1, commandId: "rename" });
  assert.equal(renamed.conversation.title, "新的名称");
  assert.equal(renamed.conversation.lastMessageAt, firstMessageAt);
  assert.equal(renamed.conversation.updatedAt, currentTime);
  currentTime = "2026-01-01T02:00:00.000Z";
  const moved = await api.moveToProject({ conversationId: id, projectId: "project-1", expectedRevision: 2, commandId: "move-in" });
  assert.equal(moved.conversation.projectId, "project-1");
  assert.equal(moved.conversation.lastMessageAt, firstMessageAt);
  currentTime = "2026-01-01T03:00:00.000Z";
  const pinned = await api.setPinned({ conversationId: id, pinned: true, expectedRevision: 3, commandId: "pin" });
  assert.equal(pinned.conversation.pinned, true);
  assert.equal(pinned.conversation.lastMessageAt, firstMessageAt);
  currentTime = "2026-01-01T04:00:00.000Z";
  const movedOut = await api.moveToProject({ conversationId: id, projectId: null, expectedRevision: 4, commandId: "move-out" });
  assert.equal(movedOut.conversation.projectId, null);
  assert.equal(movedOut.conversation.lastMessageAt, firstMessageAt);
  currentTime = "2026-01-01T05:00:00.000Z";
  const appended = await api.sendMessage({ conversationId: id, role: "assistant", content: "新回复", expectedRevision: 5, commandId: "append-after-meta" });
  assert.equal(appended.conversation.lastMessageAt, currentTime);
  await assert.rejects(api.rename({ conversationId: id, title: "冲突", expectedRevision: 1, commandId: "rename-conflict" }), (error) => error.code === "REVISION_CONFLICT" && error.details.actualRevision === 6);
  await api.delete({ conversationId: id, expectedRevision: 6, commandId: "delete" });
  assert.equal((await api.listConversations()).items.length, 0);
  await assert.rejects(api.getConversation(id), (error) => error.code === "CONVERSATION_NOT_FOUND");
}));

test("commandId 重放幂等，复用不同参数会冲突", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const input = { mode: "chat", role: "user", content: "幂等消息", expectedRevision: 0, commandId: "same-command" };
  const first = await api.sendMessage(input);
  const repeated = await api.sendMessage(input);
  assert.deepEqual(repeated, first);
  assert.equal((await api.listConversations()).items.length, 1);
  assert.equal((await api.listMessages({ conversationId: first.conversation.id })).items.length, 1);
  await assert.rejects(api.sendMessage({ ...input, content: "不同内容" }), (error) => error.code === "COMMAND_ID_REUSED");
}));

test("提交点失败不会留下可见半成品，原 commandId 可安全重试", async () => withFixture(async (dataRoot) => {
  let fail = true;
  const api = service(dataRoot, actor(), {
    beforeIndexCommit: () => {
      if (fail) throw new Error("injected failure");
    },
  });
  const input = { mode: "chat", role: "user", content: "事务消息", expectedRevision: 0, commandId: "transaction-command" };
  await assert.rejects(api.sendMessage(input), /injected failure/);
  assert.equal((await api.listConversations()).items.length, 0);
  fail = false;
  const committed = await api.sendMessage(input);
  assert.equal(committed.conversation.revision, 1);
  assert.equal((await api.listConversations()).items.length, 1);
}));

test("分支共享起点历史，但后续消息链保持独立", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const created = await startConversation(api, "branch-create", "共同起点");
  const rootBranchId = created.branchId;
  const answered = await api.sendMessage({ conversationId: created.conversation.id, branchId: rootBranchId, role: "assistant", content: "根分支回答", expectedRevision: 1, commandId: "root-answer" });
  const branched = await api.branch({ conversationId: created.conversation.id, sourceBranchId: rootBranchId, atMessageId: created.messageId, expectedRevision: 2, commandId: "branch" });
  const childBranchId = branched.branch.id;
  await api.sendMessage({ conversationId: created.conversation.id, branchId: childBranchId, role: "assistant", content: "子分支回答", expectedRevision: 3, commandId: "child-answer" });

  const child = await api.listMessages({ conversationId: created.conversation.id, branchId: childBranchId });
  assert.deepEqual(child.items.map((message) => message.content), ["共同起点", "子分支回答"]);
  const root = await api.listMessages({ conversationId: created.conversation.id, branchId: rootBranchId });
  assert.deepEqual(root.items.map((message) => message.content), ["共同起点", "根分支回答"]);
  assert.equal(answered.conversation.branchCount, 1);
}));

test("派生分支创建新的网页对话并保留来源对话不变", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const created = await startConversation(api, "fork-conversation-create", "共同问题", "work");
  const answered = await api.sendMessage({ conversationId: created.conversation.id, role: "assistant", content: "共同回答", taskId: "task-source", expectedRevision: 1, commandId: "fork-conversation-answer" });
  await api.sendMessage({ conversationId: created.conversation.id, role: "user", content: "来源后续", expectedRevision: 2, commandId: "fork-conversation-followup" });

  const forked = await api.forkConversation({
    conversationId: created.conversation.id,
    sourceBranchId: created.branchId,
    atMessageId: answered.messageId,
    expectedRevision: 3,
    commandId: "fork-conversation",
  });

  assert.notEqual(forked.conversation.id, created.conversation.id);
  assert.equal(forked.conversation.mode, "work");
  assert.match(forked.conversation.title, /· 分支$/);
  assert.deepEqual((await api.listMessages({ conversationId: forked.conversation.id })).items.map((message) => [message.content, message.taskId]), [
    ["共同问题", null],
    ["共同回答", "task-source"],
  ]);
  assert.deepEqual((await api.listMessages({ conversationId: created.conversation.id })).items.map((message) => message.content), ["共同问题", "共同回答", "来源后续"]);
  assert.equal((await api.listConversations()).items.length, 2);
}));

test("全文搜索精确匹配标题与消息，返回分组片段并使用快照游标分页", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const exact = await startConversation(api, "search-exact", "这是 scnet 连接成功 的验收消息");
  await api.sendMessage({
    conversationId: exact.conversation.id,
    role: "assistant",
    content: "scnet 连接成功，远端状态正常。",
    expectedRevision: exact.conversation.revision,
    commandId: "search-exact-answer",
  });
  await startConversation(api, "search-broad", "只有连接成功，不包含服务器名称");
  const titleOnly = await startConversation(api, "search-title", "这条正文与服务器无关");
  await api.rename({
    conversationId: titleOnly.conversation.id,
    title: "scnet 运维记录",
    expectedRevision: titleOnly.conversation.revision,
    commandId: "search-title-rename",
  });

  const phrase = await api.searchConversations({ query: "scnet 连接成功", limit: 20, messageLimit: 8 });
  assert.deepEqual(phrase.items.map((entry) => entry.conversationId), [exact.conversation.id]);
  assert.equal(phrase.items[0].matches.length, 2);
  assert.equal(phrase.items[0].matches.every((match) => match.excerpt.match.toLocaleLowerCase("zh-CN") === "scnet 连接成功"), true);

  const firstPage = await api.searchConversations({ query: "scnet", limit: 1, messageLimit: 8 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = await api.searchConversations({ query: "scnet", limit: 1, messageLimit: 8, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].conversationId, firstPage.items[0].conversationId);
  assert.deepEqual(new Set([firstPage.items[0].conversationId, secondPage.items[0].conversationId]), new Set([
    exact.conversation.id,
    titleOnly.conversation.id,
  ]));
}));

test("对话 @ 候选覆盖当前账号全部对话，显式选择可跨项目记忆边界", async () => withFixture(async (dataRoot) => {
  const modes = new Map([
    ["project-private-a", "project-only"],
    ["project-private-b", "project-only"],
    ["project-global", "global"],
  ]);
  const api = service(dataRoot, actor(), {
    authorizeProject: async (projectId) => modes.has(projectId),
    projectMemoryMode: async (projectId) => modes.get(projectId) || "global",
  });
  const create = (commandId, content, projectId = null) => api.sendMessage({
    mode: "chat", role: "user", content, projectId, expectedRevision: 0, commandId,
  });
  const privateSource = await create("ref-private-source", "A 项目源对话", "project-private-a");
  const privateCurrent = await create("ref-private-current", "A 项目当前对话", "project-private-a");
  const otherPrivate = await create("ref-private-other", "B 项目对话", "project-private-b");
  const standalone = await create("ref-standalone", "独立聊天资料");
  const globalProject = await create("ref-global-project", "全局项目资料", "project-global");

  const privateCandidates = await api.searchReferenceCandidates({ conversationId: privateCurrent.conversation.id, query: "项目", limit: 20 });
  assert.deepEqual(new Set(privateCandidates.items.map((item) => item.conversationId)), new Set([
    privateSource.conversation.id,
    otherPrivate.conversation.id,
    globalProject.conversation.id,
  ]));
  const globalCandidates = await api.searchReferenceCandidates({ conversationId: standalone.conversation.id, query: "资料", limit: 20 });
  assert.deepEqual(new Set(globalCandidates.items.map((item) => item.conversationId)), new Set([globalProject.conversation.id]));

  const crossPrivateReference = await api.sendMessage({
    conversationId: privateCurrent.conversation.id,
    role: "user",
    content: "引用越界",
    references: [{ type: "conversation", conversationId: otherPrivate.conversation.id }],
    expectedRevision: privateCurrent.conversation.revision,
    commandId: "ref-cross-private",
  });
  const crossPrivateMessage = (await api.listMessages({ conversationId: privateCurrent.conversation.id })).items
    .find((message) => message.id === crossPrivateReference.messageId);
  assert.equal(crossPrivateMessage.references[0].conversationId, otherPrivate.conversation.id);

  const globalReference = await api.sendMessage({
    conversationId: standalone.conversation.id,
    role: "user",
    content: "引用全局项目",
    references: [{ type: "conversation", conversationId: globalProject.conversation.id }],
    expectedRevision: standalone.conversation.revision,
    commandId: "ref-global-allowed",
  });
  const globalMessage = (await api.listMessages({ conversationId: standalone.conversation.id })).items
    .find((message) => message.id === globalReference.messageId);
  assert.equal(globalMessage.references[0].conversationId, globalProject.conversation.id);
  assert.equal(globalMessage.references[0].title, globalProject.conversation.title);
}));

test("对话 @ 引用冻结发送时快照，读取只能使用当前消息绑定的 opaque reference_id", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const source = await startConversation(api, "frozen-source", "最初问题");
  const sourceAnswer = await api.sendMessage({
    conversationId: source.conversation.id,
    role: "assistant",
    content: "冻结快照中的答案",
    expectedRevision: 1,
    commandId: "frozen-source-answer",
  });
  const secondQuestion = await api.sendMessage({
    conversationId: source.conversation.id,
    role: "user",
    content: "第二轮训练参数问题应该怎么处理？",
    expectedRevision: sourceAnswer.conversation.revision,
    commandId: "frozen-source-second-question",
  });
  const secondAnswer = await api.sendMessage({
    conversationId: source.conversation.id,
    role: "assistant",
    content: "当时建议 batch size 设为 64。",
    expectedRevision: secondQuestion.conversation.revision,
    commandId: "frozen-source-second-answer",
  });
  let latestSource = secondAnswer;
  for (let index = 0; index < 10; index += 1) {
    const question = await api.sendMessage({
      conversationId: source.conversation.id,
      role: "user",
      content: `最近上下文问题 ${index + 1}`,
      expectedRevision: latestSource.conversation.revision,
      commandId: `frozen-source-recent-question-${index}`,
    });
    latestSource = await api.sendMessage({
      conversationId: source.conversation.id,
      role: "assistant",
      content: `最近上下文回答 ${index + 1}`,
      expectedRevision: question.conversation.revision,
      commandId: `frozen-source-recent-answer-${index}`,
    });
  }
  const renamed = await api.rename({
    conversationId: source.conversation.id,
    title: "被冻结的来源名称",
    expectedRevision: latestSource.conversation.revision,
    commandId: "frozen-source-title",
  });
  const target = await api.sendMessage({
    mode: "work",
    role: "user",
    content: "请参考这个对话",
    references: [{ type: "conversation", conversationId: source.conversation.id }],
    expectedRevision: 0,
    commandId: "frozen-target",
  });
  const targetMessage = (await api.listMessages({ conversationId: target.conversation.id })).items[0];
  const reference = targetMessage.references[0];
  assert.equal(reference.snapshotId, renamed.conversation.snapshotId);
  assert.equal(reference.title, "被冻结的来源名称");
  assert.match(reference.referenceId, /^cref_[a-f0-9]{32}$/);

  await api.sendMessage({
    conversationId: source.conversation.id,
    role: "user",
    content: "引用发送后才新增的内容",
    expectedRevision: renamed.conversation.revision,
    commandId: "frozen-source-later",
  });
  const firstPage = await api.searchConversationReference({
    conversationId: target.conversation.id,
    messageId: target.messageId,
    referenceId: reference.referenceId,
    query: "问题",
    limit: 1,
  });
  assert.deepEqual(firstPage.items.map((message) => message.content), ["第二轮训练参数问题应该怎么处理？", "当时建议 batch size 设为 64。"]);
  assert.deepEqual(firstPage.items.map((message) => message.role), ["user", "assistant"]);
  assert.equal(new Set(firstPage.items.map((message) => message.referenceTurnId)).size, 1);
  assert.equal(firstPage.recentItems.length, 20);
  assert.equal(firstPage.recentItems[0].content, "最近上下文问题 1");
  assert.equal(firstPage.recentItems.at(-1).content, "最近上下文回答 10");
  assert.ok(firstPage.memorySourceIds.includes(source.messageId));
  assert.ok(firstPage.nextCursor);
  const secondPage = await api.searchConversationReference({
    conversationId: target.conversation.id,
    messageId: target.messageId,
    referenceId: reference.referenceId,
    query: "问题",
    cursor: firstPage.nextCursor,
    limit: 1,
  });
  assert.deepEqual(secondPage.items.map((message) => message.content), ["最初问题", "冻结快照中的答案"]);
  assert.deepEqual(secondPage.items.map((message) => message.role), ["user", "assistant"]);
  assert.equal(new Set(secondPage.items.map((message) => message.referenceTurnId)).size, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.equal([...firstPage.recentItems, ...firstPage.items, ...secondPage.items].some((message) => message.content.includes("新增")), false);
  const answerMatch = await api.searchConversationReference({
    conversationId: target.conversation.id,
    messageId: target.messageId,
    referenceId: reference.referenceId,
    query: "batch size",
    limit: 1,
  });
  assert.deepEqual(answerMatch.items.map((message) => message.content), ["第二轮训练参数问题应该怎么处理？", "当时建议 batch size 设为 64。"]);
  assert.equal(answerMatch.nextCursor, null);
  await assert.rejects(api.searchConversationReference({
    conversationId: target.conversation.id,
    messageId: target.messageId,
    referenceId: "cref_00000000000000000000000000000000",
    query: "参数",
  }), (error) => error.code === "CONVERSATION_REFERENCE_NOT_BOUND");
}));

test("retry 替换同一对话最新回复，rewind 返回清理边界", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const created = await startConversation(api, "retry-create", "问题");
  const answer = await api.sendMessage({ conversationId: created.conversation.id, role: "assistant", content: "旧回答", taskId: "task-old", expectedRevision: 1, commandId: "retry-old" });
  const retried = await api.retry({ conversationId: created.conversation.id, messageId: answer.messageId, content: "新回答", taskId: "task-new", expectedRevision: 2, commandId: "retry-new" });
  assert.equal(retried.removedBoundary.message.firstRemovedMessageId, answer.messageId);
  assert.equal(retried.removedBoundary.task.firstRemovedTaskId, "task-old");
  assert.deepEqual((await api.listMessages({ conversationId: created.conversation.id })).items.map((message) => message.content), ["问题", "新回答"]);

  await api.sendMessage({ conversationId: created.conversation.id, role: "user", content: "继续追问", expectedRevision: 3, commandId: "rewind-user" });
  await api.sendMessage({ conversationId: created.conversation.id, role: "assistant", content: "继续回答", taskId: "task-follow", expectedRevision: 4, commandId: "rewind-answer" });
  const rewind = await api.rewind({ conversationId: created.conversation.id, toMessageId: retried.messageId, expectedRevision: 5, commandId: "rewind" });
  assert.equal(rewind.removedBoundary.message.count, 2);
  assert.equal(rewind.removedBoundary.message.afterMessageId, retried.messageId);
  assert.equal(rewind.removedBoundary.task.firstRemovedTaskId, "task-follow");
  assert.deepEqual((await api.listMessages({ conversationId: created.conversation.id })).items.map((message) => message.content), ["问题", "新回答"]);
}));
