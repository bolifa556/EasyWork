import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { ConversationService } from "../gateway/core/conversations/index.mjs";

const CURSOR_SECRET = "conversation-test-secret-0123456789abcdef";

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

test("新对话只在首条用户消息发送时创建，并固定 chat/work 模式", async () => withFixture(async (dataRoot) => {
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

  const converted = await api.convertMode({ conversationId: created.conversation.id, mode: "work", expectedRevision: 1, commandId: "convert-1" });
  assert.equal(converted.conversation.mode, "work");
  assert.equal(converted.conversation.revision, 2);
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

test("编辑最新用户消息在同一对话截断后续回复并返回 message/task 边界", async () => withFixture(async (dataRoot) => {
  const api = service(dataRoot);
  const created = await startConversation(api, "edit-create", "问题 1");
  await api.sendMessage({ conversationId: created.conversation.id, role: "assistant", content: "回答 1", taskId: "task-1", expectedRevision: 1, commandId: "edit-a1" });
  const user2 = await api.sendMessage({ conversationId: created.conversation.id, role: "user", content: "问题 2", expectedRevision: 2, commandId: "edit-u2" });
  await api.sendMessage({ conversationId: created.conversation.id, role: "assistant", content: "回答 2", taskId: "task-2", expectedRevision: 3, commandId: "edit-a2" });

  const edited = await api.editLatestUserMessage({ conversationId: created.conversation.id, messageId: user2.messageId, content: "修改后的问题 2", expectedRevision: 4, commandId: "edit-latest" });
  assert.equal(edited.conversation.id, created.conversation.id);
  assert.equal(edited.removedBoundary.message.count, 2);
  assert.equal(edited.removedBoundary.task.firstRemovedTaskId, "task-2");
  const messages = await api.listMessages({ conversationId: created.conversation.id });
  assert.deepEqual(messages.items.map((message) => message.content), ["问题 1", "回答 1", "修改后的问题 2"]);
  await assert.rejects(api.editLatestUserMessage({ conversationId: created.conversation.id, messageId: created.messageId, content: "不能改旧消息", expectedRevision: 5, commandId: "edit-old" }), (error) => error.code === "LATEST_USER_MESSAGE_REQUIRED");
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
