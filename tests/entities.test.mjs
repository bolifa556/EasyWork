import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  canTransitionTask,
  createArtifact,
  createContextDelivery,
  createContextSession,
  createResourceBinding,
  createResourceBlob,
  createResourceVersion,
  createInstalledSkill,
  createTask,
  invalidateResourceBinding,
  isResourceKnowledgeReady,
  materializeRemoteArtifact,
  transitionContextSession,
  transitionTask,
  updateResourceVersionProcessing,
  updateTaskRuntime,
  validateArtifact,
  validateContextDelivery,
  validateResourceBlob,
  validateTask,
} from "../gateway/core/entities/index.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SERVER_IDENTITY = `ssh_${"s".repeat(43)}`;
const AT_0 = "2026-08-10T00:00:00.000Z";
const AT_1 = "2026-08-10T00:00:01.000Z";
const AT_2 = "2026-08-10T00:00:02.000Z";

const at = (value) => ({ clock: () => new Date(value) });

function scope(overrides = {}) {
  return {
    actorType: "user",
    actorId: "user_01",
    userId: "user_01",
    projectId: "project_01",
    conversationId: "conversation_01",
    workspaceId: "workspace_01",
    taskId: "task_01",
    serverId: "server_01",
    serverIdentity: SERVER_IDENTITY,
    versionDomainId: "version_domain_01",
    memoryMode: "project-only",
    branchId: "main",
    memorySnapshotSequence: 4,
    memorySnapshotVersionIds: ["memory_version_01"],
    resourceBindingSnapshotId: "resource_snapshot_01",
    selectedCollectionIds: ["collection_01"],
    selectedSkillVersions: [{ skillId: "skill_shell", version: "1.0.0" }],
    capabilities: ["resources.read", "tasks.run"],
    contextEpoch: 2,
    ...overrides,
  };
}

function taskInput(overrides = {}) {
  return {
    id: "task_01",
    actorId: "user_01",
    conversationId: "conversation_01",
    branchId: "main",
    sourceMessageId: "message_source_01",
    conversationRunId: "conversation_run_01",
    goal: "检查远端环境并生成报告",
    route: {
      serverId: "server_01",
      serverIdentity: SERVER_IDENTITY,
      workspaceId: "workspace_01",
      agentId: "codex",
      providerId: "provider_agent",
      modelId: "model-agent-1",
    },
    contextSessionId: "context_session_01",
    agentBindingId: "agent_binding_01",
    skillPins: [{ skillId: "skill_shell", version: "1.0.0", sha256: SHA_A }],
    resourceBindingSnapshotId: "resource_snapshot_01",
    versionCheckpointId: "checkpoint_01",
    budgets: {
      maxWallTimeMs: 60_000,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxToolCalls: 20,
    },
    idempotencyKey: "request_01",
    ...overrides,
  };
}

function contextEntry(overrides = {}) {
  return {
    id: "entry_01",
    kind: "memory",
    source: { type: "PersistentMemory", id: "memory_01", version: "4" },
    content: { format: "text", value: "用户偏好使用 Slurm。" },
    tokenEstimate: 12,
    sensitivity: "private",
    digest: SHA_A,
    ...overrides,
  };
}

function installedSkillInput(overrides = {}) {
  return {
    id: "skill_version_01",
    actorId: "user_01",
    skillId: "skill_shell",
    sha256: SHA_A,
    packagePath: "skills/packages/skill_shell/.installed/package.json",
    manifest: {
      name: "Shell Helper",
      description: "只读检查远端环境",
      entrypoint: "scripts/main.mjs",
      permissions: ["remote.read"],
    },
    ...overrides,
  };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code);
}

test("Task 构造生成 revision=0 的冻结快照并拒绝旧字段", () => {
  const task = createTask(taskInput(), at(AT_0));
  assert.equal(task.entityType, "Task");
  assert.equal(task.revision, 0);
  assert.equal(task.status, "queued");
  assert.equal(task.taskEventSequence, 0);
  assert.ok(Object.isFrozen(task));
  assert.ok(Object.isFrozen(task.route));
  assert.equal(validateTask(task), true);
  expectCode(() => createTask({ ...taskInput(), legacyState: "running" }, at(AT_0)), "ENTITY_UNKNOWN_FIELD");
});

test("Task 状态机覆盖运行、等待、中断、恢复和完成路径", () => {
  assert.deepEqual(Object.keys(TASK_TRANSITIONS), TASK_STATUSES);
  let task = createTask(taskInput(), at(AT_0));
  const path = [
    "preparing",
    "delivering_context",
    "running",
    "waiting_approval",
    "running",
    "waiting_append",
    "running",
    "interrupting",
    "interrupted",
    "recovering",
    "running",
    "finalizing",
    "completed",
  ];
  for (const [index, status] of path.entries()) {
    assert.equal(canTransitionTask(task.status, status), true);
    task = transitionTask(task, status, {
      expectedRevision: task.revision,
      clock: () => new Date(AT_1),
      ...(status === "running" && !task.remoteRunId ? { remoteRunId: "run_01" } : {}),
      ...(status === "waiting_append" ? { sourceMessageId: "message-append", conversationRunId: "run-append" } : {}),
    });
    assert.equal(task.revision, index + 1);
    assert.equal(task.taskEventSequence, index + 1);
  }
  assert.equal(task.status, "completed");
  assert.equal(task.sourceMessageId, "message-append");
  assert.equal(task.conversationRunId, "run-append");
  assert.equal(task.completedAt, AT_1);
  assert.equal(canTransitionTask("completed", "running"), false);
  expectCode(() => transitionTask(task, "running", { expectedRevision: task.revision, ...at(AT_2) }), "TASK_TRANSITION_INVALID");
});

test("Task failed/cancelled 终态、失败原因和 optimistic revision 均受约束", () => {
  const initial = createTask(taskInput(), at(AT_0));
  const failed = transitionTask(initial, "failed", {
    expectedRevision: 0,
    failure: { code: "REMOTE_FAILED", message: "远端进程退出", retryable: true },
    ...at(AT_1),
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.failure.code, "REMOTE_FAILED");
  const cancelled = transitionTask(createTask(taskInput({ id: "task_02" }), at(AT_0)), "cancelled", {
    expectedRevision: 0,
    ...at(AT_1),
  });
  assert.equal(cancelled.status, "cancelled");
  expectCode(() => transitionTask(initial, "preparing", { expectedRevision: 4, ...at(AT_1) }), "REVISION_CONFLICT");
  expectCode(() => transitionTask(initial, "running", { expectedRevision: 0, ...at(AT_1) }), "TASK_TRANSITION_INVALID");
});

test("Task runtime 更新会递增 revision，终态不可修改", () => {
  let task = createTask(taskInput(), at(AT_0));
  task = transitionTask(task, "preparing", { expectedRevision: 0, ...at(AT_1) });
  const next = updateTaskRuntime(task, {
    remoteRunId: "run_01",
    plan: [{ id: "step_01", text: "读取资源", status: "running" }],
    artifactIds: ["artifact_01"],
  }, { expectedRevision: 1, ...at(AT_2) });
  assert.equal(next.revision, 2);
  assert.equal(next.taskEventSequence, 2);
  assert.equal(next.plan[0].status, "running");
  expectCode(() => updateTaskRuntime(next, { plan: [] }, { expectedRevision: 1, ...at(AT_2) }), "REVISION_CONFLICT");
});

test("Task 终态不替远端 Agent 推进原生 Todo", () => {
  for (const [index, status] of ["completed", "failed", "cancelled"].entries()) {
    let task = createTask(taskInput({ id: `task_native_plan_${index}` }), at(AT_0));
    task = transitionTask(task, "preparing", { expectedRevision: task.revision, ...at(AT_1) });
    task = transitionTask(task, "delivering_context", { expectedRevision: task.revision, ...at(AT_2) });
    task = transitionTask(task, "running", { expectedRevision: task.revision, ...at(AT_2) });
    task = updateTaskRuntime(task, {
      plan: [{ id: "native_step", text: "由远端 Agent 维护", status: "running" }],
    }, { expectedRevision: task.revision, ...at(AT_2) });
    task = transitionTask(task, "finalizing", { expectedRevision: task.revision, ...at(AT_2) });
    const terminal = transitionTask(task, status, {
      expectedRevision: task.revision,
      ...(status === "failed" ? { failure: { code: "REMOTE_FAILED", message: "远端失败", retryable: false } } : {}),
      ...at(AT_2),
    });
    assert.deepEqual(terminal.plan, [{ id: "native_step", text: "由远端 Agent 维护", status: "running" }]);
  }
});

test("Artifact 严格区分 remote/host，物化需要 revision 且凭据字段被拒绝", () => {
  const remote = createArtifact({
    id: "artifact_01",
    actorId: "user_01",
    taskId: "task_01",
    serverIdentity: SERVER_IDENTITY,
    kind: "report",
    source: "remote",
    remotePath: "/home/user/.easywork/artifacts/task_01/report.json",
    blobId: null,
    size: 128,
    sha256: SHA_A,
    mime: "application/json",
  }, at(AT_0));
  assert.equal(validateArtifact(remote), true);
  const host = materializeRemoteArtifact(remote, {
    blobId: "blob_01",
    size: 128,
    sha256: SHA_A,
    mime: "application/json",
  }, { expectedRevision: 0, ...at(AT_1) });
  assert.equal(host.source, "host");
  assert.equal(host.revision, 1);
  expectCode(() => createArtifact({
    id: "artifact_02", actorId: "user_01", taskId: "task_01", serverIdentity: null, kind: "log", source: "host",
    remotePath: null, blobId: "blob_02", size: 1, sha256: SHA_B, mime: "text/plain", apiKey: "forbidden",
  }, at(AT_0)), "ENTITY_UNKNOWN_FIELD");
});

test("Resource 明确拆分 Blob/Version/Binding，并严格要求 Embedding ready", () => {
  const blob = createResourceBlob({
    id: "blob_01", actorId: "user_01", sha256: SHA_A, size: 512, mime: "text/markdown", storagePath: "resources/blobs/aa/file",
  }, at(AT_0));
  assert.equal(validateResourceBlob(blob), true);
  let version = createResourceVersion({
    id: "resource_version_01",
    actorId: "user_01",
    resourceId: "resource_01",
    blobId: blob.id,
    filename: "guide.md",
    parserVersion: "markdown-1",
  }, at(AT_0));
  assert.equal(isResourceKnowledgeReady(version), false);
  version = updateResourceVersionProcessing(version, {
    parseStatus: "ready",
    embeddingStatus: "pending",
    embeddingProfileId: null,
    parseError: null,
    embeddingError: null,
  }, { expectedRevision: 0, ...at(AT_1) });
  assert.equal(isResourceKnowledgeReady(version), false);
  version = updateResourceVersionProcessing(version, {
    embeddingStatus: "ready",
    embeddingProfileId: "embedding_profile_01",
    embeddingError: null,
  }, { expectedRevision: 1, ...at(AT_2) });
  assert.equal(isResourceKnowledgeReady(version), true);

  const binding = createResourceBinding({
    id: "binding_01",
    actorId: "user_01",
    resourceVersionId: version.id,
    ownerType: "conversation",
    ownerId: "conversation_01",
    path: "docs/guide.md",
    createdSequence: 8,
  }, at(AT_0));
  const invalidated = invalidateResourceBinding(binding, 12, { expectedRevision: 0, ...at(AT_1) });
  assert.equal(invalidated.invalidatedSequence, 12);
  assert.equal(invalidated.revision, 1);
  expectCode(() => invalidateResourceBinding(invalidated, 13, { expectedRevision: 1, ...at(AT_2) }), "RESOURCE_BINDING_ALREADY_INVALIDATED");
  expectCode(() => createResourceBlob({
    id: "blob_escape", actorId: "user_01", sha256: SHA_B, size: 1, mime: "text/plain", storagePath: "../outside.txt",
  }, at(AT_0)), "ENTITY_PATH_TRAVERSAL");
});

test("Resource 不允许解析未完成却宣称 Embedding ready", () => {
  const version = createResourceVersion({
    id: "resource_version_02", actorId: "user_01", resourceId: "resource_02", blobId: "blob_02", filename: "bad.txt", parserVersion: "text-1",
  }, at(AT_0));
  expectCode(() => updateResourceVersionProcessing(version, {
    embeddingStatus: "ready",
    embeddingProfileId: "embedding_profile_01",
    embeddingError: null,
  }, { expectedRevision: 0, ...at(AT_1) }), "RESOURCE_EMBEDDING_REQUIRES_PARSE");
});

test("ContextSession 固定 Scope，Delivery 具有不可变 sequence/digest", () => {
  const rawScope = scope();
  let session = createContextSession({
    id: "context_session_01",
    actorId: "user_01",
    consumer: "remote-agent",
    consumerId: "agent_binding_01",
    scope: rawScope,
    budget: { maxTokens: 200_000, reservedOutputTokens: 8_000 },
  }, at(AT_0));
  rawScope.contextEpoch = 99;
  assert.equal(session.scope.contextEpoch, 2);
  assert.ok(Object.isFrozen(session.scope));
  session = transitionContextSession(session, "sealed", { expectedRevision: 0, ...at(AT_1) });
  const rawEntry = contextEntry();
  const delivery = createContextDelivery({
    id: "delivery_01",
    session,
    sequence: 1,
    mode: "bootstrap",
    entries: [rawEntry],
    supersedes: [],
  }, at(AT_2));
  rawEntry.content.value = "被外部修改";
  assert.equal(delivery.entries[0].content.value, "用户偏好使用 Slurm。");
  assert.equal(delivery.sequence, 1);
  assert.match(delivery.digest, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(delivery.entries[0]));
  assert.equal(validateContextDelivery(delivery), true);
  const tamperedDelivery = structuredClone(delivery);
  tamperedDelivery.entries[0].content.value = "被篡改";
  expectCode(() => validateContextDelivery(tamperedDelivery), "CONTEXT_DELIVERY_DIGEST_MISMATCH");
  assert.throws(() => { delivery.sequence = 2; }, TypeError);
});

test("ContextSession actor 不匹配、未 sealed 投递和空 invalidate 均被拒绝", () => {
  const open = createContextSession({
    id: "context_session_02", actorId: "user_01", consumer: "web-agent", consumerId: "web_agent_01",
    scope: scope({ taskId: null }), budget: { maxTokens: 20_000, reservedOutputTokens: 2_000 },
  }, at(AT_0));
  expectCode(() => createContextDelivery({
    id: "delivery_02", session: open, sequence: 1, mode: "bootstrap", entries: [contextEntry()], supersedes: [],
  }, at(AT_1)), "CONTEXT_SESSION_NOT_DELIVERABLE");
  const sealed = transitionContextSession(open, "sealed", { expectedRevision: 0, ...at(AT_1) });
  expectCode(() => createContextDelivery({
    id: "delivery_03", session: sealed, sequence: 2, mode: "invalidate", entries: [], supersedes: [],
  }, at(AT_2)), "CONTEXT_INVALIDATION_TARGET_REQUIRED");
  expectCode(() => createContextSession({
    id: "context_session_03", actorId: "user_other", consumer: "web-agent", consumerId: "web_agent_01",
    scope: scope(), budget: { maxTokens: 10_000, reservedOutputTokens: 1_000 },
  }, at(AT_0)), "CONTEXT_SCOPE_ACTOR_MISMATCH");

  const guest = createContextSession({
    id: "context_session_guest", actorId: "guest_01", consumer: "web-agent", consumerId: "web_agent_01",
    scope: scope({
      actorType: "guest",
      actorId: "guest_01",
      userId: null,
      projectId: null,
      workspaceId: null,
      taskId: null,
      serverId: null,
      serverIdentity: null,
      versionDomainId: null,
    }),
    budget: { maxTokens: 10_000, reservedOutputTokens: 1_000 },
  }, at(AT_0));
  assert.equal(guest.scope.actorType, "guest");
  assert.equal(guest.scope.userId, null);

  expectCode(() => createContextDelivery({
    id: "delivery_secret",
    session: sealed,
    sequence: 3,
    mode: "delta",
    entries: [contextEntry({ content: { format: "text", value: "sk-1234567890abcdef" } })],
    supersedes: [],
  }, at(AT_2)), "SENSITIVE_VALUE_FORBIDDEN");
});

test("技能实体仅记录当前安装内容，不包含版本或历史注册表", () => {
  const skill = createInstalledSkill(installedSkillInput(), at(AT_0));
  assert.equal(skill.skillId, "skill_shell");
  assert.equal(skill.sha256, SHA_A);
  assert.equal(Object.hasOwn(skill, "version"), false);
  assert.ok(Object.isFrozen(skill));
});
test("技能实体拒绝不安全的包和入口路径", () => {
  expectCode(() => createInstalledSkill(installedSkillInput({ manifest: { name: "Bad", description: "", entrypoint: "../escape.mjs", permissions: [] } }), at(AT_0)), "ENTITY_PATH_TRAVERSAL");
  expectCode(() => createInstalledSkill(installedSkillInput({ packagePath: "C:/outside/skill.zip" }), at(AT_0)), "ENTITY_PATH_NOT_RELATIVE");
});