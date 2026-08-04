import assert from "node:assert/strict";
import test from "node:test";

import {
  activeMemoryRecords,
  agentConversationDelta,
  appendExplicitMemory,
  appendMemoryTombstone,
  defaultMemoryDocument,
  invalidateMemoryVersions,
  normalizeMemoryDocument,
  selectMemoryRecords,
  selectMemorySyncRecords,
} from "../gateway/memory.mjs";

test("memory respects project-only boundaries and ranks relevant records", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "用户偏好使用 Slurm sbatch 提交长任务",
    scope: "user",
  });
  document = appendExplicitMemory(document, {
    content: "项目 alpha 的 FRP 服务使用 7000 端口",
    scope: "project",
    scopeId: "alpha",
  });
  document = appendExplicitMemory(document, {
    content: "项目 beta 使用另一套端口",
    scope: "project",
    scopeId: "beta",
  });

  const projectOnly = selectMemoryRecords(document, {
    prompt: "部署 FRP 端口",
    projectId: "alpha",
    memoryMode: "project-only",
  });
  assert.deepEqual(
    projectOnly.map((record) => record.content),
    ["项目 alpha 的 FRP 服务使用 7000 端口"],
  );

  const withGlobal = selectMemoryRecords(document, {
    prompt: "提交 Slurm 任务",
    projectId: "alpha",
    memoryMode: "project-and-global",
  });
  assert.ok(withGlobal.some((record) => record.scope === "user"));
  assert.ok(!withGlobal.some((record) => record.scopeId === "alpha"));
  assert.ok(!withGlobal.some((record) => record.scopeId === "beta"));
});

test("agent switching only receives messages created after its own sync cursor", () => {
  const state = {
    conversations: [
      {
        id: "conversation-1",
        messages: [
          { id: "u1", role: "user", content: "让模型一完成三件事" },
          { id: "a1", role: "assistant", agentId: "agent-1", content: "三件事完成" },
          { id: "u2", role: "user", content: "切换模型二再做一件事" },
          { id: "a2", role: "assistant", agentId: "agent-2", content: "第四件事完成" },
          { id: "u3", role: "user", content: "切回模型一继续" },
          { id: "a3", role: "assistant", agentId: "agent-1", content: "" },
        ],
      },
    ],
  };
  const delta = agentConversationDelta(
    state,
    "conversation-1",
    { agentSessionId: "native-1", syncCursor: { lastMessageId: "a1" } },
    { currentUserMessageId: "u3" },
  );
  assert.equal(delta.bootstrap, false);
  assert.deepEqual(
    delta.messages.map((message) => message.id),
    ["u2", "a2"],
  );

  const bootstrap = agentConversationDelta(
    state,
    "conversation-1",
    null,
    { currentUserMessageId: "u3" },
  );
  assert.equal(bootstrap.bootstrap, true);
  assert.deepEqual(
    bootstrap.messages.map((message) => message.id),
    ["u1", "a1", "u2", "a2"],
  );
  assert.deepEqual(Object.keys(normalizeMemoryDocument({})).sort(), [
    "contextSettings",
    "ledger",
    "overview",
    "records",
    "revision",
    "schemaVersion",
    "sequence",
    "summaries",
    "updatedAt",
  ]);
});

test("same-workspace versions follow user-wide time order and reset only one conversation", () => {
  let document = defaultMemoryDocument();
  for (const operation of [
    { number: 1, conversation: "A", task: "A1" },
    { number: 2, conversation: "B", task: "B2" },
    { number: 3, conversation: "A", task: "A3" },
    { number: 4, conversation: "B", task: "B4" },
    { number: 5, conversation: "A", task: "A5" },
  ]) {
    document = appendExplicitMemory(document, {
      content: `操作 ${operation.number}`,
      semanticKey: `operation-${operation.number}`,
      scope: "workspace",
      scopeId: "shared-workspace",
      sourceConversationId: operation.conversation,
      sourceTaskId: operation.task,
      authority: "agent-reported-execution",
    });
  }
  const branchSnapshotSequence = 3;
  document = invalidateMemoryVersions(document, {
    sourceConversationIds: ["A"],
    sourceTaskIds: ["A5"],
    reason: "latest-response-reset",
  });

  const current = selectMemoryRecords(document, {
    prompt: "操作",
    workspaceId: "shared-workspace",
    relevanceThreshold: 0,
  });
  assert.deepEqual(
    current.map((record) => record.content).sort(),
    ["操作 1", "操作 2", "操作 3", "操作 4"],
  );

  const branch = selectMemoryRecords(document, {
    prompt: "操作",
    workspaceId: "shared-workspace",
    conversationId: "branch-A3",
    lineageConversationId: "branch-A3",
    asOfSequence: branchSnapshotSequence,
    relevanceThreshold: 0,
  });
  assert.deepEqual(
    branch.map((record) => record.content).sort(),
    ["操作 1", "操作 2", "操作 3"],
  );
});

test("deleted, expired, sensitive and credential-like memories never enter model context", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "普通偏好：使用中文回答",
    semanticKey: "language",
  });
  const normalId = document.records[0].id;
  document = appendExplicitMemory(document, {
    content: "过期设置",
    semanticKey: "expired",
    validUntil: "2000-01-01T00:00:00.000Z",
  });
  document = appendExplicitMemory(document, {
    content: "仅本人可见的敏感背景",
    semanticKey: "sensitive",
    sensitivity: "restricted",
  });
  document = appendExplicitMemory(document, {
    content: "api_key = sk-this-should-never-enter-a-model-context",
    semanticKey: "credential",
  });
  document = appendMemoryTombstone(document, {
    memoryId: normalId,
    reason: "forget",
  });

  assert.equal(selectMemoryRecords(document, { prompt: "设置 偏好" }).length, 0);
  const sync = selectMemorySyncRecords(document, {});
  assert.ok(sync.some((record) => record.id === normalId && record.status === "deleted"));
  assert.equal(activeMemoryRecords(document).some((record) => record.id === normalId), false);
});

test("portable project memories retain checkpoint provenance without duplicating content", () => {
  let document = defaultMemoryDocument();
  for (const source of [
    { conversation: "chat-a", task: "run-a", checkpoint: "checkpoint-a" },
    { conversation: "chat-b", task: "run-b", checkpoint: "checkpoint-b" },
  ]) {
    document = appendExplicitMemory(document, {
      content: "FRP 部署前先检查端口占用，再写入服务配置并验证回连",
      scope: "project",
      scopeId: "project-frp",
      kind: "workflow",
      source: "work-result-distillation",
      sourceConversationId: source.conversation,
      sourceTaskId: source.task,
      sourceCheckpointId: source.checkpoint,
      sourceWorkspaceId: "workspace-a",
      evidenceRefs: ["server:server-a"],
      portability: "reusable-after-validation",
    });
  }

  assert.equal(document.records.length, 1);
  assert.equal(document.records[0].portability, "reusable-after-validation");
  assert.deepEqual(
    document.records[0].sourceConversationIds,
    ["chat-a", "chat-b"],
  );
});

test("workspace facts never leak into another server workspace", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "FRP 已安装，配置位于 ~/.config/frp/frpc.toml",
    scope: "workspace",
    scopeId: "workspace-server-a",
    kind: "fact",
    semanticKey: "frp-installation-state",
    sourceWorkspaceId: "workspace-server-a",
    portability: "workspace-bound",
    authority: "verified-execution-result",
  });
  document = appendExplicitMemory(document, {
    content: "部署 FRP 前检查端口占用并验证回连",
    scope: "project",
    scopeId: "project-frp",
    kind: "workflow",
    semanticKey: "frp-deployment-procedure",
    portability: "reusable-after-validation",
  });

  const target = selectMemoryRecords(document, {
    prompt: "部署 FRP",
    projectId: "project-frp",
    workspaceId: "workspace-server-b",
    memoryMode: "project-only",
  });
  assert.ok(target.some((record) => record.scope === "project"));
  assert.ok(!target.some((record) => record.scope === "workspace"));
});
