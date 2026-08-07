import assert from "node:assert/strict";
import test from "node:test";

import {
  activeMemoryRecords,
  agentConversationDelta,
  appendExplicitMemory,
  appendMemoryTombstone,
  defaultMemoryDocument,
  invalidateMemoryVersions,
  memorySnapshotAt,
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
          {
            id: "u2",
            role: "user",
            content: "切换模型二再做一件事",
            workspaceId: "workspace-b",
            workspaceName: "项目 B",
          },
          {
            id: "a2",
            role: "assistant",
            agentId: "agent-2",
            content: "第四件事完成",
            workspaceId: "workspace-b",
            workspaceName: "项目 B",
          },
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
  assert.deepEqual(
    delta.messages.map((message) => message.workspaceId),
    ["workspace-b", "workspace-b"],
  );
  assert.deepEqual(
    delta.messages.map((message) => message.workspaceName),
    ["项目 B", "项目 B"],
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

  document = invalidateMemoryVersions(document, {
    sourceConversationIds: ["chat-a"],
    sourceTaskIds: ["run-a"],
    reason: "chat-a-reset",
  });
  const remaining = selectMemoryRecords(document, {
    prompt: "FRP 部署",
    projectId: "project-frp",
    memoryMode: "project-only",
    relevanceThreshold: 0,
  });
  assert.equal(remaining.length, 1);
  assert.deepEqual(remaining[0].sourceConversationIds, ["chat-b"]);
  assert.deepEqual(remaining[0].sourceTaskIds, ["run-b"]);
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

test("branch snapshots include their target task without leaking concurrent future memory", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "分支点之前的工作区事实",
    semanticKey: "workspace-before",
    scope: "workspace",
    scopeId: "workspace-a",
    sourceConversationId: "conversation-a",
    sourceTaskId: "task-a1",
  });
  document = appendExplicitMemory(document, {
    content: "另一服务器稍后产生的项目事实",
    semanticKey: "project-future",
    scope: "project",
    scopeId: "project-a",
    sourceConversationId: "conversation-b",
    sourceTaskId: "task-b2",
  });
  document = appendExplicitMemory(document, {
    content: "目标回复完成后才蒸馏出的事实",
    semanticKey: "target-result",
    scope: "workspace",
    scopeId: "workspace-a",
    sourceConversationId: "conversation-a",
    sourceTaskId: "task-a3",
  });
  const versions = document.records.flatMap((record) => record.versions);
  versions.find((version) => version.sourceTaskId === "task-a1").createdAt =
    "2026-01-01T00:00:01.000Z";
  versions.find((version) => version.sourceTaskId === "task-b2").createdAt =
    "2026-01-01T00:00:03.000Z";
  versions.find((version) => version.sourceTaskId === "task-a3").createdAt =
    "2026-01-01T00:00:04.000Z";

  const snapshot = memorySnapshotAt(
    document,
    "2026-01-01T00:00:02.000Z",
    { sourceTaskIds: ["task-a3"] },
  );
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.versionIds.length, 1);
  const selected = selectMemoryRecords(document, {
    prompt: "",
    projectId: "project-a",
    workspaceId: "workspace-a",
    memoryMode: "project-only",
    asOfSequence: snapshot.sequence,
    snapshotVersionIds: snapshot.versionIds,
    lineageConversationId: "branch-a3",
    relevanceThreshold: 0,
  });
  assert.deepEqual(
    selected.map((record) => record.content).sort(),
    ["分支点之前的工作区事实", "目标回复完成后才蒸馏出的事实"],
  );
});

test("a zero-sequence branch snapshot does not expose unrelated later memory", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "无关的后续项目事实",
    semanticKey: "future-project",
    scope: "project",
    scopeId: "project-zero",
    sourceTaskId: "task-unrelated",
  });
  document = appendExplicitMemory(document, {
    content: "零截点目标任务的结果",
    semanticKey: "zero-target",
    scope: "project",
    scopeId: "project-zero",
    sourceTaskId: "task-target",
  });
  for (const version of document.records.flatMap((record) => record.versions)) {
    version.createdAt = "2026-02-01T00:00:05.000Z";
  }
  const snapshot = memorySnapshotAt(
    document,
    "2026-02-01T00:00:01.000Z",
    { sourceTaskIds: ["task-target"] },
  );
  assert.equal(snapshot.sequence, 0);
  const selected = selectMemoryRecords(document, {
    prompt: "",
    projectId: "project-zero",
    memoryMode: "project-only",
    asOfSequence: 0,
    snapshotVersionIds: snapshot.versionIds,
    lineageConversationId: "branch-zero",
    relevanceThreshold: 0,
  });
  assert.deepEqual(selected.map((record) => record.content), [
    "零截点目标任务的结果",
  ]);
});

test("later reset invalidation does not rewrite an existing branch snapshot", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "分支创建时存在的共享事实",
    semanticKey: "shared-at-branch",
    scope: "workspace",
    scopeId: "workspace-branch",
    sourceConversationId: "conversation-source",
    sourceTaskId: "task-source",
  });
  const snapshotSequence = document.sequence;
  document = invalidateMemoryVersions(document, {
    sourceConversationIds: ["conversation-source"],
    sourceTaskIds: ["task-source"],
    reason: "source-reset-after-branch",
  });
  assert.equal(
    selectMemoryRecords(document, {
      prompt: "",
      workspaceId: "workspace-branch",
      relevanceThreshold: 0,
    }).length,
    0,
  );
  assert.deepEqual(
    selectMemoryRecords(document, {
      prompt: "",
      workspaceId: "workspace-branch",
      asOfSequence: snapshotSequence,
      lineageConversationId: "branch-copy",
      relevanceThreshold: 0,
    }).map((record) => record.content),
    ["分支创建时存在的共享事实"],
  );
});

test("message-scoped reset fallback never erases older turns when a timestamp is absent", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "较早一轮已确认的偏好",
    semanticKey: "older-preference",
    scope: "conversation",
    scopeId: "conversation-no-time",
    sourceConversationId: "conversation-no-time",
    sourceMessageIds: ["assistant-older"],
  });
  document = appendExplicitMemory(document, {
    content: "本轮准备重置的结果",
    semanticKey: "latest-result",
    scope: "conversation",
    scopeId: "conversation-no-time",
    sourceConversationId: "conversation-no-time",
    sourceMessageIds: ["assistant-latest"],
  });
  document = invalidateMemoryVersions(document, {
    sourceConversationIds: ["conversation-no-time"],
    sourceMessageIds: ["user-latest", "assistant-latest"],
    reason: "missing-timestamp-reset-fallback",
  });
  assert.deepEqual(
    selectMemoryRecords(document, {
      prompt: "",
      conversationId: "conversation-no-time",
      relevanceThreshold: 0,
    }).map((record) => record.content),
    ["较早一轮已确认的偏好"],
  );
});
