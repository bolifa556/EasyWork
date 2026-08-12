import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryCoordinator, PersistentMemoryService, parseMemoryCandidates } from "../gateway/core/memory/index.mjs";

const actor = Object.freeze({ actorType: "user", actorId: "user_memory_coordinator", userId: "user_memory_coordinator" });

function scope(overrides = {}) {
  return {
    actorType: "user",
    actorId: actor.actorId,
    userId: actor.userId,
    projectId: "project_1",
    conversationId: "conversation_1",
    workspaceId: "workspace_1",
    taskId: null,
    serverId: "server_1",
    serverIdentity: `ssh_${"a".repeat(43)}`,
    versionDomainId: "version_1",
    memoryMode: "project-only",
    branchId: "branch_1",
    memorySnapshotSequence: 0,
    memorySnapshotVersionIds: [],
    resourceBindingSnapshotId: null,
    selectedCollectionIds: [],
    selectedSkillVersions: [],
    capabilities: [],
    contextEpoch: 0,
    ...overrides,
  };
}

test("MemoryCoordinator 只保存当前 Scope 可用层级并冻结最新快照", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-memory-coordinator-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataRoot = path.join(parent, "data");
  const memory = new PersistentMemoryService({ dataRoot, actor });
  const coordinator = new MemoryCoordinator({
    dataRoot,
    actor,
    memory,
    prompt: "extract",
    extractor: async () => JSON.stringify({ memories: [
      { level: "user", semanticKey: "preference", content: "偏好简洁回答", confidence: 0.9 },
      { level: "project", semanticKey: "frp-layout", content: "FRP 部署在项目服务器", confidence: 0.95 },
      { level: "workspace", semanticKey: "runtime", content: "工作区使用 Slurm", confidence: 0.8 },
    ] }),
  });
  const result = await coordinator.recordExchange({
    scope: scope(),
    userMessage: "部署 FRP",
    assistantMessage: "已完成",
    source: { type: "conversation", id: "conversation_1", version: "message_2" },
  });
  assert.equal(result.extracted, 3);
  assert.equal(result.stored.length, 2);
  const frozen = await coordinator.freezeScope(scope());
  assert.equal(frozen.memorySnapshotSequence, 2);
  assert.equal(frozen.memorySnapshotVersionIds.length, 2);
  const selected = await memory.select(frozen);
  assert.deepEqual(selected.entries.map((entry) => entry.scope.level).sort(), ["project", "workspace"]);
});

test("候选解析拒绝额外字段和非 JSON 文本", () => {
  assert.deepEqual(parseMemoryCandidates("not json"), []);
  assert.deepEqual(parseMemoryCandidates(JSON.stringify([{ level: "project", semanticKey: "x", content: "y", confidence: 1, secret: "z" }])), []);
  assert.equal(parseMemoryCandidates("```json\n[{\"level\":\"conversation\",\"semanticKey\":\"x\",\"content\":\"y\",\"confidence\":0.5}]\n```").length, 1);
});

test("项目记忆跨对话复用，分支保留既有记忆且重置只失效被移除来源", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-memory-coordinator-scope-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataRoot = path.join(parent, "data");
  const memory = new PersistentMemoryService({ dataRoot, actor });
  const coordinator = new MemoryCoordinator({
    dataRoot,
    actor,
    memory,
    prompt: "extract",
    extractor: async ({ input }) => JSON.stringify({ memories: [{
      level: input.assistantMessage.startsWith("project:") ? "project" : "conversation",
      semanticKey: input.assistantMessage.split(":")[1],
      content: input.assistantMessage,
      confidence: 1,
    }] }),
  });
  await coordinator.recordExchange({
    scope: scope(), userMessage: "project", assistantMessage: "project:shared", providerId: "provider", modelId: "model",
    source: { type: "conversation-message", id: "message_project", version: "1" },
  });
  await coordinator.recordExchange({
    scope: scope(), userMessage: "keep", assistantMessage: "conversation:kept", providerId: "provider", modelId: "model",
    source: { type: "conversation-message", id: "message_keep", version: "2" },
  });
  await coordinator.recordExchange({
    scope: scope({ branchId: "branch_2" }), userMessage: "remove", assistantMessage: "conversation:removed", providerId: "provider", modelId: "model",
    source: { type: "conversation-message", id: "message_removed", version: "3" },
  });

  const otherConversation = await coordinator.freezeScope(scope({ conversationId: "conversation_2", branchId: "main" }));
  const crossConversation = await memory.select(otherConversation);
  assert.deepEqual(crossConversation.entries.map((entry) => entry.scope.level), ["project"]);

  const branchBeforeReset = await coordinator.freezeScope(scope({ branchId: "branch_2" }));
  assert.deepEqual(new Set((await memory.select(branchBeforeReset)).entries.map((entry) => entry.version.content)), new Set(["project:shared", "conversation:kept", "conversation:removed"]));
  const invalidated = await coordinator.invalidateBoundary({
    messageIds: ["message_removed"],
    reason: "rewound branch",
    source: { type: "conversation-mutation", id: "rewind_1", version: "4" },
  });
  assert.equal(invalidated.invalidated, 1);
  const branchAfterReset = await coordinator.freezeScope(scope({ branchId: "branch_2" }));
  assert.deepEqual(new Set((await memory.select(branchAfterReset)).entries.map((entry) => entry.version.content)), new Set(["project:shared", "conversation:kept"]));
});

test("远端 Task 最终报告使用创建它的同一模型独立提取并包含 task Scope", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-memory-coordinator-task-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataRoot = path.join(parent, "data");
  const memory = new PersistentMemoryService({ dataRoot, actor });
  const calls = [];
  const coordinator = new MemoryCoordinator({
    dataRoot,
    actor,
    memory,
    prompt: "extract",
    extractor: async (input) => {
      calls.push(input);
      return JSON.stringify({ memories: [{ level: "task", semanticKey: "verified-result", content: "任务验证通过", confidence: 1 }] });
    },
  });
  const taskScope = await coordinator.freezeScope(scope({ taskId: "task_1" }));
  await coordinator.registerTask({ taskId: "task_1", scope: taskScope, providerId: "provider_same", modelId: "model_same" });
  const result = await coordinator.recordTaskFinal({ task: { id: "task_1", goal: "验证", revision: 5 }, assistantMessage: "任务验证通过" });
  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0].record.scope.level, "task");
  assert.equal(calls[0].providerId, "provider_same");
  assert.equal(calls[0].modelId, "model_same");
});

test("分支固定起点记忆，忽略源分支后续版本并在子分支重置后回到固定版本", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-memory-coordinator-branch-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataRoot = path.join(parent, "data");
  const memory = new PersistentMemoryService({ dataRoot, actor });
  const coordinator = new MemoryCoordinator({
    dataRoot,
    actor,
    memory,
    prompt: "extract",
    extractor: async ({ input }) => JSON.stringify({ memories: [{
      level: "project",
      semanticKey: "deployment-port",
      content: input.assistantMessage,
      confidence: 1,
    }] }),
  });
  await coordinator.recordExchange({
    scope: scope(), userMessage: "before", assistantMessage: "端口 8789", providerId: "provider", modelId: "model",
    source: { type: "conversation-message", id: "answer_before", version: "1" },
  });
  await coordinator.recordExchange({
    scope: scope(), userMessage: "after", assistantMessage: "端口 9000", providerId: "provider", modelId: "model",
    source: { type: "conversation-message", id: "answer_after", version: "2" },
  });
  await coordinator.registerBranch({
    conversationId: "conversation_1",
    sourceBranchId: "branch_1",
    branchId: "branch_child",
    sourceMessageIds: ["question_before", "answer_before"],
  });

  let child = await coordinator.freezeScope(scope({ branchId: "branch_child" }));
  assert.deepEqual((await memory.select(child)).entries.map((entry) => entry.version.content), ["端口 8789"]);
  await coordinator.invalidateBoundary({
    messageIds: ["answer_before"],
    reason: "源分支重置",
    source: { type: "conversation-mutation", id: "reset_parent", version: "3" },
  });
  child = await coordinator.freezeScope(scope({ branchId: "branch_child" }));
  assert.deepEqual((await memory.select(child)).entries.map((entry) => entry.version.content), ["端口 8789"]);

  await coordinator.recordExchange({
    scope: child, userMessage: "child", assistantMessage: "端口 7777", providerId: "provider", modelId: "model",
    source: { type: "conversation-message", id: "answer_child", version: "4" },
  });
  child = await coordinator.freezeScope(scope({ branchId: "branch_child" }));
  assert.deepEqual((await memory.select(child)).entries.map((entry) => entry.version.content), ["端口 7777"]);
  await coordinator.invalidateBoundary({
    messageIds: ["answer_child"],
    reason: "子分支重置",
    source: { type: "conversation-mutation", id: "reset_child", version: "5" },
  });
  child = await coordinator.freezeScope(scope({ branchId: "branch_child" }));
  assert.deepEqual((await memory.select(child)).entries.map((entry) => entry.version.content), ["端口 8789"]);
});
