import crypto from "node:crypto";

import { assertNoSensitiveFields, invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { validateEffectiveContextScope } from "../entities/context.mjs";

const LEVELS = Object.freeze(["user", "project", "conversation", "workspace", "task"]);
const LEVEL_SET = new Set(LEVELS);
const SENSITIVITIES = new Set(["public", "private", "restricted"]);
const PORTABILITIES = new Set(["universal", "project-bound", "workspace-bound", "task-bound"]);
const AUTHORITY_WEIGHT = Object.freeze({
  "user-explicit": 6,
  "verified-result": 5,
  "agent-observed": 3,
  "model-inferred": 1,
});
const LEVEL_WEIGHT = Object.freeze({ task: 5, conversation: 4, workspace: 3, project: 2, user: 1 });

const createId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const nowIso = (clock) => (clock || (() => new Date()))().toISOString();

function normalizeText(value, field, max = 200_000) {
  invariant(typeof value === "string" && value.trim(), "MEMORY_FIELD_INVALID", `${field} 必须是非空字符串`, { status: 400 });
  invariant(value.length <= max, "MEMORY_FIELD_TOO_LARGE", `${field} 超过长度限制`, { status: 413 });
  assertNoSensitiveFields(value, field);
  return value.trim();
}

function normalizeScope(value, actor) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "MEMORY_SCOPE_INVALID", "Memory scope 无效", { status: 400 });
  const level = String(value.level || "");
  invariant(LEVEL_SET.has(level), "MEMORY_SCOPE_INVALID", "Memory scope level 无效", { status: 400 });
  const id = level === "user" ? actor.actorId : String(value.id || "");
  invariant(id && id.length <= 256, "MEMORY_SCOPE_ID_REQUIRED", `${level} memory 必须包含 scope id`, { status: 400 });
  invariant(level !== "user" || id === actor.actorId, "MEMORY_SCOPE_ACTOR_MISMATCH", "User memory 不属于当前 Actor", { status: 403 });
  return Object.freeze({ level, id });
}

function normalizeSource(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "MEMORY_SOURCE_REQUIRED", "Memory source 必须可追溯", { status: 400 });
  const source = {
    type: normalizeText(String(value.type || ""), "Memory source.type", 64),
    id: normalizeText(String(value.id || ""), "Memory source.id", 256),
    version: normalizeText(String(value.version || ""), "Memory source.version", 256),
  };
  assertNoSensitiveFields(source);
  return source;
}

function validateDocument(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (!Number.isSafeInteger(data.sequence) || data.sequence < 0) return false;
  if (!data.records || typeof data.records !== "object" || Array.isArray(data.records)) return false;
  if (!Array.isArray(data.invalidations)) return false;
  for (const [id, record] of Object.entries(data.records)) {
    if (record?.id !== id || !LEVEL_SET.has(record?.scope?.level) || typeof record?.scope?.id !== "string") return false;
    if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.versions)) return false;
    for (const version of record.versions) {
      if (!version?.id || !Number.isSafeInteger(version.sequence) || version.sequence < 1 || typeof version.content !== "string") return false;
      if (!SENSITIVITIES.has(version.sensitivity) || !PORTABILITIES.has(version.portability)) return false;
    }
  }
  for (const entry of data.invalidations) {
    if (!entry?.id || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Array.isArray(entry.versionIds)) return false;
  }
  return true;
}

function scopeIdentity(scope, semanticKey) {
  return sha256(`${scope.level}\0${scope.id}\0${semanticKey}`);
}

function queryTokens(value) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = [...text.replace(/[^\p{Script=Han}]/gu, "")];
  return new Set([...words, ...cjk, ...cjk.slice(0, -1).map((item, index) => item + cjk[index + 1])]);
}

function relevance(content, query) {
  if (!query.size) return 0;
  const haystack = queryTokens(content);
  let score = 0;
  for (const token of query) if (haystack.has(token)) score += token.length > 1 ? 2 : 1;
  return score;
}

function scopeMatches(memoryScope, scope) {
  if (memoryScope.level === "user") return scope.memoryMode === "global" && memoryScope.id === scope.actorId;
  if (memoryScope.level === "project") return Boolean(scope.projectId) && memoryScope.id === scope.projectId;
  if (memoryScope.level === "conversation") return memoryScope.id === scope.conversationId;
  if (memoryScope.level === "workspace") return Boolean(scope.workspaceId) && memoryScope.id === scope.workspaceId;
  if (memoryScope.level === "task") return Boolean(scope.taskId) && memoryScope.id === scope.taskId;
  return false;
}

function invalidatedVersionIds(document, asOfSequence) {
  const result = new Set();
  for (const entry of document.invalidations) {
    if (entry.sequence > asOfSequence) continue;
    for (const id of entry.versionIds) result.add(id);
  }
  return result;
}

function selectedVersion(record, { asOfSequence, snapshotVersionIds, invalidated, baselineSequence = null, invalidatedAtBaseline = null }) {
  const allowed = snapshotVersionIds?.size ? snapshotVersionIds : null;
  return record.versions
    .filter((version) => {
      if (version.sequence > asOfSequence || (allowed && !allowed.has(version.id))) return false;
      const invalidationSet = baselineSequence !== null && version.sequence <= baselineSequence
        ? invalidatedAtBaseline
        : invalidated;
      return !invalidationSet?.has(version.id);
    })
    .sort((left, right) => right.sequence - left.sequence)[0] || null;
}

export class PersistentMemoryService {
  constructor({ dataRoot, actor, queue, clock }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
  }

  #repository() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["memory", "persistent.json"],
      schemaVersion: 1,
      defaultData: () => ({ sequence: 0, records: {}, invalidations: [] }),
      validate: validateDocument,
      queue: this.queue,
    });
  }

  async #update(mutator) {
    const repository = this.#repository();
    for (;;) {
      const current = await repository.read();
      try {
        return await repository.update(mutator, { expectedRevision: current.revision, clock: this.clock });
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async append(input) {
    const scope = normalizeScope(input.scope, this.actor);
    const semanticKey = normalizeText(input.semanticKey, "Memory semanticKey", 512);
    const content = normalizeText(input.content, "Memory content");
    const authority = normalizeText(input.authority || "model-inferred", "Memory authority", 64);
    const confidence = Number(input.confidence ?? 0.5);
    invariant(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1, "MEMORY_CONFIDENCE_INVALID", "Memory confidence 必须位于 0 到 1", { status: 400 });
    const sensitivity = String(input.sensitivity || "private");
    invariant(SENSITIVITIES.has(sensitivity), "MEMORY_SENSITIVITY_INVALID", "Memory sensitivity 无效", { status: 400 });
    const portability = String(input.portability || (scope.level === "workspace" ? "workspace-bound" : scope.level === "project" ? "project-bound" : scope.level === "task" ? "task-bound" : "universal"));
    invariant(PORTABILITIES.has(portability), "MEMORY_PORTABILITY_INVALID", "Memory portability 无效", { status: 400 });
    const source = normalizeSource(input.source);
    const recordId = `memory_${scopeIdentity(scope, semanticKey).slice(0, 32)}`;
    let output;
    await this.#update((data) => {
      const existing = data.records[recordId];
      if (existing) {
        invariant(Number.isSafeInteger(input.expectedRevision), "EXPECTED_REVISION_REQUIRED", "更新 Memory 必须提供 expectedRevision", { status: 428 });
        invariant(existing.revision === input.expectedRevision, "MEMORY_REVISION_CONFLICT", "Memory 已被其他操作更新", {
          status: 409,
          details: { expectedRevision: input.expectedRevision, actualRevision: existing.revision },
        });
      } else {
        invariant(input.expectedRevision === undefined, "MEMORY_REVISION_UNEXPECTED", "新 Memory 不接受 expectedRevision", { status: 400 });
      }
      data.sequence += 1;
      const createdAt = nowIso(this.clock);
      const versions = existing?.versions || [];
      const version = {
        id: createId("memory_version"),
        sequence: data.sequence,
        content,
        authority,
        confidence,
        sensitivity,
        portability,
        source,
        supersedes: versions.at(-1)?.id || null,
        createdAt,
      };
      const record = {
        id: recordId,
        scope,
        semanticKey,
        revision: existing ? existing.revision + 1 : 0,
        versions: [...versions, version],
        createdAt: existing?.createdAt || createdAt,
        updatedAt: createdAt,
      };
      data.records[recordId] = record;
      output = { record: structuredClone(record), version: structuredClone(version), sequence: data.sequence };
    });
    return output;
  }

  async find({ scope: rawScope, semanticKey: rawSemanticKey }) {
    const scope = normalizeScope(rawScope, this.actor);
    const semanticKey = normalizeText(rawSemanticKey, "Memory semanticKey", 512);
    const recordId = `memory_${scopeIdentity(scope, semanticKey).slice(0, 32)}`;
    const state = await this.#repository().read();
    const record = state.data.records[recordId];
    return record ? structuredClone(record) : null;
  }

  async invalidate(input) {
    const requested = [...new Set((input.versionIds || []).map(String))];
    invariant(requested.length > 0, "MEMORY_INVALIDATION_EMPTY", "必须指定需要失效的 Memory version", { status: 400 });
    const reason = normalizeText(input.reason, "Memory invalidation reason", 2_000);
    const source = normalizeSource(input.source);
    let output;
    await this.#update((data) => {
      const known = new Set(Object.values(data.records).flatMap((record) => record.versions.map((version) => version.id)));
      invariant(requested.every((id) => known.has(id)), "MEMORY_VERSION_NOT_FOUND", "存在未知 Memory version", { status: 404 });
      data.sequence += 1;
      const entry = { id: createId("memory_invalidation"), sequence: data.sequence, versionIds: requested, reason, source, createdAt: nowIso(this.clock) };
      data.invalidations.push(entry);
      output = structuredClone(entry);
    });
    return output;
  }

  async invalidateSources({ sourceIds, reason, source }) {
    const requested = new Set((sourceIds || []).map(String).filter(Boolean));
    invariant(requested.size > 0, "MEMORY_INVALIDATION_SOURCE_EMPTY", "必须指定需要失效的来源", { status: 400 });
    const state = await this.#repository().read();
    const alreadyInvalidated = invalidatedVersionIds(state.data, state.data.sequence);
    const versionIds = Object.values(state.data.records).flatMap((record) => record.versions
      .filter((version) => requested.has(version.source.id) && !alreadyInvalidated.has(version.id))
      .map((version) => version.id));
    if (!versionIds.length) return { invalidated: 0, sequence: state.data.sequence };
    const entry = await this.invalidate({ versionIds, reason, source });
    return { invalidated: versionIds.length, sequence: entry.sequence, invalidationId: entry.id };
  }

  async invalidateAfter({ scope, afterSequence, reason, source }) {
    validateEffectiveContextScope(scope);
    invariant(scope.actorType === this.actor.actorType && scope.actorId === this.actor.actorId, "MEMORY_SCOPE_ACTOR_MISMATCH", "Memory scope 不属于当前 Actor", { status: 403 });
    invariant(Number.isSafeInteger(afterSequence) && afterSequence >= 0, "MEMORY_SEQUENCE_INVALID", "afterSequence 无效", { status: 400 });
    const snapshot = await this.#repository().read();
    const ids = Object.values(snapshot.data.records)
      .filter((record) => scopeMatches(record.scope, scope))
      .flatMap((record) => record.versions.filter((version) => version.sequence > afterSequence).map((version) => version.id));
    if (!ids.length) return { invalidated: 0, sequence: snapshot.data.sequence };
    const entry = await this.invalidate({ versionIds: ids, reason, source });
    return { invalidated: ids.length, sequence: entry.sequence, invalidationId: entry.id };
  }

  async select(scope, options = {}) {
    validateEffectiveContextScope(scope);
    invariant(scope.actorType === this.actor.actorType && scope.actorId === this.actor.actorId, "MEMORY_SCOPE_ACTOR_MISMATCH", "Memory scope 不属于当前 Actor", { status: 403 });
    const state = await this.#repository().read();
    const asOfSequence = options.asOfSequence ?? scope.memorySnapshotSequence;
    invariant(Number.isSafeInteger(asOfSequence) && asOfSequence >= 0 && asOfSequence <= state.data.sequence, "MEMORY_SEQUENCE_INVALID", "Memory snapshot sequence 无效", { status: 400 });
    const explicitVersions = options.versionIds ?? scope.memorySnapshotVersionIds;
    const snapshotVersionIds = new Set(explicitVersions || []);
    const invalidated = invalidatedVersionIds(state.data, asOfSequence);
    const baselineSequence = scope.memoryBaselineSequence ?? options.baselineSequence ?? null;
    invariant(baselineSequence === null || (Number.isSafeInteger(baselineSequence) && baselineSequence >= 0 && baselineSequence <= asOfSequence), "MEMORY_BASELINE_INVALID", "Memory baseline 无效", { status: 400 });
    const invalidatedAtBaseline = baselineSequence === null ? invalidated : invalidatedVersionIds(state.data, baselineSequence);
    const query = queryTokens(options.query);
    const limit = Number(options.limit ?? 50);
    invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 500, "MEMORY_LIMIT_INVALID", "Memory limit 无效", { status: 400 });
    const entries = [];
    for (const record of Object.values(state.data.records)) {
      if (!scopeMatches(record.scope, scope)) continue;
      const version = selectedVersion(record, { asOfSequence, snapshotVersionIds, invalidated, baselineSequence, invalidatedAtBaseline });
      if (!version || (version.sensitivity === "restricted" && !options.includeRestricted)) continue;
      entries.push({
        recordId: record.id,
        semanticKey: record.semanticKey,
        scope: structuredClone(record.scope),
        version: structuredClone(version),
        score: LEVEL_WEIGHT[record.scope.level] * 10 + (AUTHORITY_WEIGHT[version.authority] || 0) + version.confidence + relevance(version.content, query),
      });
    }
    entries.sort((left, right) => right.score - left.score || right.version.sequence - left.version.sequence || left.recordId.localeCompare(right.recordId));
    return { sequence: state.data.sequence, asOfSequence, entries: entries.slice(0, limit) };
  }

  async snapshot(scope, options = {}) {
    const state = await this.#repository().read();
    const selected = await this.select(scope, { ...options, asOfSequence: state.data.sequence, versionIds: [] });
    return {
      sequence: state.data.sequence,
      versionIds: selected.entries.map((entry) => entry.version.id),
    };
  }

  async contextEntries(scope, options = {}) {
    const selected = await this.select(scope, options);
    return selected.entries.map((entry) => ({
      id: entry.version.id,
      kind: "memory",
      content: entry.version.content,
      tokenEstimate: options.tokenEstimator?.(entry.version.content),
      sensitivity: entry.version.sensitivity,
      priority: entry.score,
      source: { type: "memory", id: entry.recordId, version: entry.version.id },
    }));
  }
}

export { LEVELS as MEMORY_LEVELS };
