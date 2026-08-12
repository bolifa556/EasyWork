import crypto from "node:crypto";

import { assertNoSensitiveFields, invariant } from "../errors.mjs";
import {
  assertArray,
  assertEntityHeader,
  assertEnum,
  assertExactKeys,
  assertId,
  assertInteger,
  assertIsoTimestamp,
  assertNullableId,
  assertNullableServerIdentity,
  assertSha256,
  assertString,
  assertUnique,
  clone,
  createHeader,
  deepFreeze,
  revisedHeader,
} from "./common.mjs";

export const CONTEXT_CONSUMERS = Object.freeze(["web-agent", "remote-agent"]);
export const CONTEXT_SESSION_STATUSES = Object.freeze(["open", "sealed", "stale", "closed"]);
export const CONTEXT_DELIVERY_MODES = Object.freeze(["bootstrap", "delta", "refresh", "invalidate"]);
export const CONTEXT_ENTRY_KINDS = Object.freeze([
  "system", "message", "memory", "conversation_state", "task_state", "resource", "skill", "workspace", "capability", "invalidation",
]);

const SCOPE_KEYS = [
  "actorType", "actorId", "userId", "projectId", "conversationId", "workspaceId", "taskId", "serverId", "serverIdentity", "versionDomainId", "memoryMode",
  "branchId", "memorySnapshotSequence", "memorySnapshotVersionIds", "resourceBindingSnapshotId", "selectedCollectionIds",
  "selectedSkillVersions", "capabilities", "contextEpoch", "memoryBaselineSequence",
];
const SESSION_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "consumer", "consumerId", "scope", "budget", "status",
  "createdAt", "updatedAt", "sealedAt", "staleAt", "closedAt",
];
const DELIVERY_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "sessionId", "sequence", "mode", "entries", "supersedes",
  "digest", "createdAt", "updatedAt",
];

function validateSelectedSkillVersion(value, field) {
  assertExactKeys(value, ["skillId", "version"], field);
  return {
    skillId: assertId(value.skillId, `${field}.skillId`),
    version: assertString(value.version, `${field}.version`, { max: 128 }),
  };
}

export function validateEffectiveContextScope(scope) {
  assertExactKeys(scope, SCOPE_KEYS, "EffectiveContextScope");
  assertEnum(scope.actorType, ["user", "guest"], "EffectiveContextScope.actorType");
  assertId(scope.actorId, "EffectiveContextScope.actorId");
  assertNullableId(scope.userId, "EffectiveContextScope.userId");
  invariant(scope.actorType === "user" ? scope.userId === scope.actorId : scope.userId === null, "CONTEXT_SCOPE_USER_ID_INVALID", "Scope userId 与 Actor 类型不一致", { status: 400 });
  assertNullableId(scope.projectId, "EffectiveContextScope.projectId");
  assertId(scope.conversationId, "EffectiveContextScope.conversationId");
  assertNullableId(scope.workspaceId, "EffectiveContextScope.workspaceId");
  assertNullableId(scope.taskId, "EffectiveContextScope.taskId");
  assertNullableId(scope.serverId, "EffectiveContextScope.serverId");
  assertNullableServerIdentity(scope.serverIdentity, "EffectiveContextScope.serverIdentity");
  assertNullableId(scope.versionDomainId, "EffectiveContextScope.versionDomainId");
  assertEnum(scope.memoryMode, ["project-only", "global"], "EffectiveContextScope.memoryMode");
  assertId(scope.branchId, "EffectiveContextScope.branchId");
  assertInteger(scope.memorySnapshotSequence, "EffectiveContextScope.memorySnapshotSequence", { min: 0 });
  if (scope.memoryBaselineSequence !== undefined && scope.memoryBaselineSequence !== null) {
    assertInteger(scope.memoryBaselineSequence, "EffectiveContextScope.memoryBaselineSequence", { min: 0 });
    invariant(scope.memoryBaselineSequence <= scope.memorySnapshotSequence, "CONTEXT_MEMORY_BASELINE_INVALID", "Memory baseline 不能晚于冻结快照", { status: 400 });
  }
  assertUnique(assertArray(scope.memorySnapshotVersionIds, "EffectiveContextScope.memorySnapshotVersionIds", (value, field) => assertId(value, field)), "EffectiveContextScope.memorySnapshotVersionIds");
  assertNullableId(scope.resourceBindingSnapshotId, "EffectiveContextScope.resourceBindingSnapshotId");
  assertUnique(assertArray(scope.selectedCollectionIds, "EffectiveContextScope.selectedCollectionIds", (value, field) => assertId(value, field)), "EffectiveContextScope.selectedCollectionIds");
  assertUnique(assertArray(scope.selectedSkillVersions, "EffectiveContextScope.selectedSkillVersions", validateSelectedSkillVersion), "EffectiveContextScope.selectedSkillVersions", (value) => `${value.skillId}@${value.version}`);
  assertUnique(assertArray(scope.capabilities, "EffectiveContextScope.capabilities", (value, field) => assertId(value, field)), "EffectiveContextScope.capabilities");
  assertInteger(scope.contextEpoch, "EffectiveContextScope.contextEpoch", { min: 0 });
  invariant((scope.serverIdentity === null) === (scope.serverId === null), "CONTEXT_SCOPE_SERVER_INCOMPLETE", "serverId 和 serverIdentity 必须同时存在或同时为空", { status: 400 });
  return true;
}

function validateBudget(budget) {
  assertExactKeys(budget, ["maxTokens", "reservedOutputTokens"], "ContextSession.budget");
  assertInteger(budget.maxTokens, "ContextSession.budget.maxTokens", { min: 1 });
  assertInteger(budget.reservedOutputTokens, "ContextSession.budget.reservedOutputTokens", { min: 0 });
  invariant(budget.reservedOutputTokens < budget.maxTokens, "CONTEXT_BUDGET_INVALID", "reservedOutputTokens 必须小于 maxTokens", { status: 400 });
}

export function validateContextSession(session) {
  assertExactKeys(session, SESSION_KEYS, "ContextSession");
  assertEntityHeader(session, "ContextSession");
  assertId(session.id, "ContextSession.id");
  assertId(session.actorId, "ContextSession.actorId");
  assertEnum(session.consumer, CONTEXT_CONSUMERS, "ContextSession.consumer");
  assertId(session.consumerId, "ContextSession.consumerId");
  validateEffectiveContextScope(session.scope);
  invariant(session.scope.actorId === session.actorId, "CONTEXT_SCOPE_ACTOR_MISMATCH", "ContextSession actor 与 Scope actor 不一致", { status: 403 });
  validateBudget(session.budget);
  assertEnum(session.status, CONTEXT_SESSION_STATUSES, "ContextSession.status");
  for (const field of ["sealedAt", "staleAt", "closedAt"]) {
    if (session[field] !== null) assertIsoTimestamp(session[field], `ContextSession.${field}`);
  }
  invariant((session.status === "open") === (session.sealedAt === null), "CONTEXT_SESSION_SEAL_STATE_INVALID", "ContextSession sealedAt 与状态不一致", { status: 400 });
  invariant(session.status !== "stale" || session.staleAt !== null, "CONTEXT_SESSION_STALE_STATE_INVALID", "stale ContextSession 必须包含 staleAt", { status: 400 });
  invariant(session.staleAt === null || session.sealedAt !== null, "CONTEXT_SESSION_STALE_STATE_INVALID", "staleAt 不能早于 sealed", { status: 400 });
  invariant((session.status === "closed") === (session.closedAt !== null), "CONTEXT_SESSION_CLOSE_STATE_INVALID", "ContextSession closedAt 与状态不一致", { status: 400 });
  return true;
}

export function createContextSession(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "consumer", "consumerId", "scope", "budget"], "ContextSessionInput");
  const session = {
    ...createHeader("ContextSession", options),
    ...clone(input),
    status: "open",
    sealedAt: null,
    staleAt: null,
    closedAt: null,
  };
  validateContextSession(session);
  return deepFreeze(session);
}

export function transitionContextSession(session, nextStatus, options = {}) {
  validateContextSession(session);
  assertEnum(nextStatus, CONTEXT_SESSION_STATUSES, "nextStatus");
  const allowed = {
    open: ["sealed", "stale", "closed"],
    sealed: ["stale", "closed"],
    stale: ["closed"],
    closed: [],
  };
  invariant(allowed[session.status].includes(nextStatus), "CONTEXT_SESSION_TRANSITION_INVALID", `ContextSession 不能从 ${session.status} 转为 ${nextStatus}`, { status: 409 });
  const nowValue = (options.clock || (() => new Date()))();
  const now = new Date(nowValue).toISOString();
  const next = {
    ...clone(session),
    ...revisedHeader(session, options.expectedRevision, { clock: () => nowValue }),
    status: nextStatus,
    sealedAt: session.sealedAt ?? now,
    staleAt: session.staleAt ?? (nextStatus === "stale" ? now : null),
    closedAt: nextStatus === "closed" ? now : null,
  };
  validateContextSession(next);
  return deepFreeze(next);
}

function validateContextEntry(entry, field) {
  assertExactKeys(entry, ["id", "kind", "source", "content", "tokenEstimate", "sensitivity", "digest"], field);
  assertExactKeys(entry.source, ["type", "id", "version"], `${field}.source`);
  assertExactKeys(entry.content, ["format", "value"], `${field}.content`);
  assertNoSensitiveFields(entry.content, `${field}.content`);
  return {
    id: assertId(entry.id, `${field}.id`),
    kind: assertEnum(entry.kind, CONTEXT_ENTRY_KINDS, `${field}.kind`),
    source: {
      type: assertId(entry.source.type, `${field}.source.type`),
      id: assertId(entry.source.id, `${field}.source.id`),
      version: assertString(entry.source.version, `${field}.source.version`, { max: 256 }),
    },
    content: {
      format: assertEnum(entry.content.format, ["text", "json", "reference"], `${field}.content.format`),
      value: assertString(entry.content.value, `${field}.content.value`, { max: 2_000_000, trim: false }),
    },
    tokenEstimate: assertInteger(entry.tokenEstimate, `${field}.tokenEstimate`, { min: 0 }),
    sensitivity: assertEnum(entry.sensitivity, ["public", "private", "restricted"], `${field}.sensitivity`),
    digest: assertSha256(entry.digest, `${field}.digest`),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeContextDeliveryDigest(input) {
  const canonical = canonicalJson({
    actorId: input.actorId,
    sessionId: input.sessionId,
    sequence: input.sequence,
    mode: input.mode,
    entries: input.entries,
    supersedes: input.supersedes,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function validateContextDelivery(delivery) {
  assertExactKeys(delivery, DELIVERY_KEYS, "ContextDelivery");
  assertEntityHeader(delivery, "ContextDelivery");
  assertId(delivery.id, "ContextDelivery.id");
  assertId(delivery.actorId, "ContextDelivery.actorId");
  assertId(delivery.sessionId, "ContextDelivery.sessionId");
  assertInteger(delivery.sequence, "ContextDelivery.sequence", { min: 1 });
  assertEnum(delivery.mode, CONTEXT_DELIVERY_MODES, "ContextDelivery.mode");
  assertUnique(assertArray(delivery.entries, "ContextDelivery.entries", validateContextEntry, { max: 10000 }), "ContextDelivery.entries", (entry) => entry.id);
  assertUnique(assertArray(delivery.supersedes, "ContextDelivery.supersedes", (value, field) => assertId(value, field), { max: 10000 }), "ContextDelivery.supersedes");
  assertSha256(delivery.digest, "ContextDelivery.digest");
  invariant(delivery.digest === computeContextDeliveryDigest(delivery), "CONTEXT_DELIVERY_DIGEST_MISMATCH", "ContextDelivery digest 与内容不一致", { status: 400 });
  invariant(delivery.mode !== "invalidate" || delivery.supersedes.length > 0, "CONTEXT_INVALIDATION_TARGET_REQUIRED", "invalidate Delivery 必须声明 supersedes", { status: 400 });
  return true;
}

export function createContextDelivery(input, options = {}) {
  assertExactKeys(input, ["id", "session", "sequence", "mode", "entries", "supersedes"], "ContextDeliveryInput");
  validateContextSession(input.session);
  invariant(input.session.status === "sealed", "CONTEXT_SESSION_NOT_DELIVERABLE", "ContextSession 必须 sealed 且未失效才能创建 Delivery", { status: 409 });
  const deliveryWithoutDigest = {
    ...createHeader("ContextDelivery", options),
    id: input.id,
    actorId: input.session.actorId,
    sessionId: input.session.id,
    sequence: input.sequence,
    mode: input.mode,
    entries: clone(input.entries),
    supersedes: clone(input.supersedes),
  };
  const delivery = { ...deliveryWithoutDigest, digest: computeContextDeliveryDigest(deliveryWithoutDigest) };
  validateContextDelivery(delivery);
  return deepFreeze(delivery);
}
