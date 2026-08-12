import { invariant } from "../errors.mjs";
import {
  assertArray,
  assertEntityHeader,
  assertEnum,
  assertExactKeys,
  assertId,
  assertInteger,
  assertIsoTimestamp,
  assertNullableId,
  assertServerIdentity,
  assertString,
  clone,
  createHeader,
  deepFreeze,
  revisedHeader,
} from "./common.mjs";

export const TASK_STATUSES = Object.freeze([
  "queued",
  "preparing",
  "delivering_context",
  "running",
  "waiting_approval",
  "waiting_append",
  "interrupting",
  "interrupted",
  "recovering",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
]);

export const TERMINAL_TASK_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

const TRANSITIONS = Object.freeze({
  queued: Object.freeze(["preparing", "failed", "cancelled"]),
  preparing: Object.freeze(["delivering_context", "failed", "cancelled"]),
  delivering_context: Object.freeze(["running", "failed", "cancelled"]),
  running: Object.freeze(["waiting_approval", "waiting_append", "interrupting", "recovering", "finalizing", "failed", "cancelled"]),
  waiting_approval: Object.freeze(["running", "interrupting", "recovering", "failed", "cancelled"]),
  waiting_append: Object.freeze(["running", "interrupting", "recovering", "finalizing", "failed", "cancelled"]),
  interrupting: Object.freeze(["interrupted", "failed"]),
  interrupted: Object.freeze(["recovering", "cancelled"]),
  recovering: Object.freeze(["running", "failed", "cancelled"]),
  finalizing: Object.freeze(["completed", "failed", "cancelled"]),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const TASK_TRANSITIONS = TRANSITIONS;

const TASK_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "conversationId", "branchId", "goal", "route",
  "contextSessionId", "agentBindingId", "skillPins", "resourceBindingSnapshotId", "versionCheckpointId", "budgets",
  "idempotencyKey", "status", "taskEventSequence", "remoteRunId", "activeCommandId", "plan", "artifactIds",
  "failure", "createdAt", "updatedAt", "startedAt", "completedAt",
];

function validateRoute(route, field = "Task.route") {
  assertExactKeys(route, ["serverId", "serverIdentity", "workspaceId", "agentId", "providerId", "modelId"], field);
  return {
    serverId: assertId(route.serverId, `${field}.serverId`),
    serverIdentity: assertServerIdentity(route.serverIdentity, `${field}.serverIdentity`),
    workspaceId: assertId(route.workspaceId, `${field}.workspaceId`),
    agentId: assertId(route.agentId, `${field}.agentId`),
    providerId: assertId(route.providerId, `${field}.providerId`),
    modelId: assertString(route.modelId, `${field}.modelId`, { max: 512 }),
  };
}

function validateBudgets(budgets, field = "Task.budgets") {
  assertExactKeys(budgets, ["maxWallTimeMs", "maxInputTokens", "maxOutputTokens", "maxToolCalls"], field);
  return {
    maxWallTimeMs: assertInteger(budgets.maxWallTimeMs, `${field}.maxWallTimeMs`, { min: 1 }),
    maxInputTokens: assertInteger(budgets.maxInputTokens, `${field}.maxInputTokens`, { min: 1 }),
    maxOutputTokens: assertInteger(budgets.maxOutputTokens, `${field}.maxOutputTokens`, { min: 1 }),
    maxToolCalls: assertInteger(budgets.maxToolCalls, `${field}.maxToolCalls`, { min: 0 }),
  };
}

function validateSkillPin(pin, field) {
  assertExactKeys(pin, ["skillId", "version", "sha256"], field);
  const sha256 = assertString(pin.sha256, `${field}.sha256`, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
  return {
    skillId: assertId(pin.skillId, `${field}.skillId`),
    version: assertString(pin.version, `${field}.version`, { max: 128 }),
    sha256,
  };
}

function validatePlanStep(step, field) {
  assertExactKeys(step, ["id", "text", "status"], field);
  return {
    id: assertId(step.id, `${field}.id`),
    text: assertString(step.text, `${field}.text`, { max: 8192 }),
    status: assertEnum(step.status, ["pending", "running", "completed", "failed", "skipped"], `${field}.status`),
  };
}

function validateFailure(failure, field = "Task.failure") {
  if (failure === null) return null;
  assertExactKeys(failure, ["code", "message", "retryable"], field);
  invariant(typeof failure.retryable === "boolean", "ENTITY_BOOLEAN_REQUIRED", `${field}.retryable 必须是布尔值`, { status: 400 });
  return {
    code: assertId(failure.code, `${field}.code`),
    message: assertString(failure.message, `${field}.message`, { max: 16384 }),
    retryable: failure.retryable,
  };
}

export function validateTask(task) {
  assertExactKeys(task, TASK_KEYS, "Task");
  assertEntityHeader(task, "Task");
  assertId(task.id, "Task.id");
  assertId(task.actorId, "Task.actorId");
  assertId(task.conversationId, "Task.conversationId");
  assertId(task.branchId, "Task.branchId");
  assertString(task.goal, "Task.goal", { max: 65536 });
  validateRoute(task.route);
  assertId(task.contextSessionId, "Task.contextSessionId");
  assertId(task.agentBindingId, "Task.agentBindingId");
  assertArray(task.skillPins, "Task.skillPins", validateSkillPin, { max: 256 });
  assertId(task.resourceBindingSnapshotId, "Task.resourceBindingSnapshotId");
  assertNullableId(task.versionCheckpointId, "Task.versionCheckpointId");
  validateBudgets(task.budgets);
  assertString(task.idempotencyKey, "Task.idempotencyKey", { max: 512 });
  assertEnum(task.status, TASK_STATUSES, "Task.status");
  assertInteger(task.taskEventSequence, "Task.taskEventSequence", { min: 0 });
  assertNullableId(task.remoteRunId, "Task.remoteRunId");
  assertNullableId(task.activeCommandId, "Task.activeCommandId");
  assertArray(task.plan, "Task.plan", validatePlanStep, { max: 1000 });
  assertArray(task.artifactIds, "Task.artifactIds", (value, field) => assertId(value, field), { max: 10000 });
  validateFailure(task.failure);
  if (task.startedAt !== null) assertIsoTimestamp(task.startedAt, "Task.startedAt");
  if (task.completedAt !== null) assertIsoTimestamp(task.completedAt, "Task.completedAt");
  invariant(!TERMINAL_TASK_STATUSES.includes(task.status) || task.completedAt !== null, "TASK_COMPLETION_TIME_REQUIRED", "终态 Task 必须包含 completedAt", { status: 400 });
  invariant(task.status !== "failed" || task.failure !== null, "TASK_FAILURE_REQUIRED", "failed Task 必须包含 failure", { status: 400 });
  invariant(task.status === "failed" || task.failure === null, "TASK_FAILURE_STATE_INVALID", "非 failed Task 不能包含 failure", { status: 400 });
  return true;
}

export function createTask(input, options = {}) {
  assertExactKeys(input, [
    "id", "actorId", "conversationId", "branchId", "goal", "route", "contextSessionId", "agentBindingId", "skillPins",
    "resourceBindingSnapshotId", "versionCheckpointId", "budgets", "idempotencyKey",
  ], "TaskInput");
  const task = {
    ...createHeader("Task", options),
    id: input.id,
    actorId: input.actorId,
    conversationId: input.conversationId,
    branchId: input.branchId,
    goal: input.goal,
    route: clone(input.route),
    contextSessionId: input.contextSessionId,
    agentBindingId: input.agentBindingId,
    skillPins: clone(input.skillPins),
    resourceBindingSnapshotId: input.resourceBindingSnapshotId,
    versionCheckpointId: input.versionCheckpointId,
    budgets: clone(input.budgets),
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    taskEventSequence: 0,
    remoteRunId: null,
    activeCommandId: null,
    plan: [],
    artifactIds: [],
    failure: null,
    startedAt: null,
    completedAt: null,
  };
  validateTask(task);
  return deepFreeze(task);
}

export function canTransitionTask(from, to) {
  return TASK_STATUSES.includes(from) && TASK_STATUSES.includes(to) && TRANSITIONS[from].includes(to);
}

export function transitionTask(task, nextStatus, options = {}) {
  validateTask(task);
  assertEnum(nextStatus, TASK_STATUSES, "nextStatus");
  invariant(canTransitionTask(task.status, nextStatus), "TASK_TRANSITION_INVALID", `Task 不能从 ${task.status} 转为 ${nextStatus}`, {
    status: 409,
    details: { from: task.status, to: nextStatus },
  });
  const now = (options.clock || (() => new Date()))();
  const next = {
    ...clone(task),
    ...revisedHeader(task, options.expectedRevision, { clock: () => now }),
    status: nextStatus,
    taskEventSequence: task.taskEventSequence + 1,
    remoteRunId: options.remoteRunId === undefined ? task.remoteRunId : options.remoteRunId,
    activeCommandId: options.activeCommandId === undefined ? task.activeCommandId : options.activeCommandId,
    failure: nextStatus === "failed" ? clone(options.failure ?? null) : null,
    startedAt: task.startedAt ?? (nextStatus === "running" ? new Date(now).toISOString() : null),
    completedAt: TERMINAL_TASK_STATUSES.includes(nextStatus) ? new Date(now).toISOString() : null,
  };
  validateTask(next);
  return deepFreeze(next);
}

export function updateTaskRuntime(task, changes, options = {}) {
  validateTask(task);
  assertExactKeys(changes, ["remoteRunId", "activeCommandId", "plan", "artifactIds"], "TaskRuntimeChanges");
  invariant(Object.keys(changes).length > 0, "TASK_RUNTIME_CHANGES_REQUIRED", "Task runtime 更新不能为空", { status: 400 });
  invariant(!TERMINAL_TASK_STATUSES.includes(task.status), "TASK_TERMINAL_IMMUTABLE", "终态 Task 不能再更新运行态数据", { status: 409 });
  const next = {
    ...clone(task),
    ...revisedHeader(task, options.expectedRevision, options),
    ...clone(changes),
    taskEventSequence: task.taskEventSequence + 1,
  };
  validateTask(next);
  return deepFreeze(next);
}
