import crypto from "node:crypto";

import { assertNoSensitiveFields, invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { durableStoredMemory } from "./policy.mjs";
import { validateEffectiveContextScope } from "../entities/context.mjs";
import { containsExplicitQueryAnchor, requiredExplicitQueryAnchors } from "../text-relevance.mjs";

const ACTIVE_LEVELS = Object.freeze(["user", "project", "conversation"]);
const ACTIVE_LEVEL_SET = new Set(ACTIVE_LEVELS);
const LEGACY_LEVEL_SET = new Set(["workspace", "task"]);
const STORED_LEVEL_SET = new Set([...ACTIVE_LEVELS, ...LEGACY_LEVEL_SET]);
const SENSITIVITIES = new Set(["public", "private", "restricted"]);
const PORTABILITIES = new Set(["universal", "project-bound", "workspace-bound", "task-bound"]);
const AUTHORITY_WEIGHT = Object.freeze({
  "user-explicit": 6,
  "verified-result": 5,
  "agent-observed": 3,
  "model-inferred": 1,
});
const LEVEL_WEIGHT = Object.freeze({ task: 5, conversation: 4, workspace: 3, project: 2, user: 1 });
const DEFAULT_RETRIEVAL = Object.freeze({
  configured: false,
  embeddingProfileId: null,
  retrievalProfileId: null,
  enabled: true,
  vectorWeight: 0.55,
  lexicalWeight: 0.15,
  titleWeight: 0.3,
  minimumScore: 0.12,
  diversityLambda: 0.72,
  recallLimit: 48,
  resultLimit: 8,
  tokenBudget: 3200,
  pageSize: 20,
});

const createId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const nowIso = (clock) => (clock || (() => new Date()))().toISOString();

function normalizeText(value, field, max = 200_000) {
  invariant(typeof value === "string" && value.trim(), "MEMORY_FIELD_INVALID", `${field} 必须是非空字符串`, { status: 400 });
  invariant(value.length <= max, "MEMORY_FIELD_TOO_LARGE", `${field} 超过长度限制`, { status: 413 });
  assertNoSensitiveFields(value, field);
  return value.trim();
}

function normalizeScope(value, actor, { allowLegacy = false } = {}) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "MEMORY_SCOPE_INVALID", "Memory scope 无效", { status: 400 });
  const level = String(value.level || "");
  invariant((allowLegacy ? STORED_LEVEL_SET : ACTIVE_LEVEL_SET).has(level), "MEMORY_SCOPE_INVALID", "Memory scope level 无效", { status: 400 });
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
    if (record?.id !== id || !STORED_LEVEL_SET.has(record?.scope?.level) || typeof record?.scope?.id !== "string") return false;
    if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.versions)) return false;
    for (const version of record.versions) {
      if (!version?.id || !Number.isSafeInteger(version.sequence) || version.sequence < 1 || typeof version.content !== "string") return false;
      if (!SENSITIVITIES.has(version.sensitivity) || !PORTABILITIES.has(version.portability)) return false;
      if (version.embedding !== undefined && version.embedding !== null) {
        if (typeof version.embedding.profileId !== "string" || !version.embedding.profileId || !Array.isArray(version.embedding.vector) || !version.embedding.vector.length) return false;
        if (!version.embedding.vector.every((item) => Number.isFinite(Number(item)))) return false;
      }
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

function queryTokens(value, { suppressIncidentalHanUnigrams = false } = {}) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = [...text.replace(/[^\p{Script=Han}]/gu, "")];
  const tokens = new Set([...words, ...cjk, ...cjk.slice(0, -1).map((item, index) => item + cjk[index + 1])]);
  if (!suppressIncidentalHanUnigrams) return tokens;
  const meaningful = [...tokens].filter((token) => !/^\p{Script=Han}$/u.test(token));
  // A genuinely one-character Chinese query still needs to work.  Once the
  // query contains any word or bigram, however, individual Han characters are
  // too weak: shared characters such as “项” or “定” otherwise surface
  // unrelated project memories beside the requested fact.
  return meaningful.length ? new Set(meaningful) : tokens;
}

function relevance(content, query) {
  if (!query.size) return 0;
  const haystack = queryTokens(content);
  let score = 0;
  for (const token of query) if (haystack.has(token)) score += token.length > 1 ? 2 : 1;
  return score;
}

function normalizedRelevance(content, query) {
  if (!query.size) return 0;
  const haystack = queryTokens(content);
  let matched = 0;
  let possible = 0;
  for (const token of query) {
    const weight = token.length > 1 ? 2 : 1;
    possible += weight;
    if (haystack.has(token)) matched += weight;
  }
  return possible ? matched / possible : 0;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? Math.max(0, dot / Math.sqrt(leftNorm * rightNorm)) : 0;
}

function memoryEmbeddingText(semanticKey, content) {
  return `${String(semanticKey || "").trim()}\n${String(content || "").trim()}`;
}

function lexicalSimilarity(left, right) {
  const leftTokens = queryTokens(left);
  const rightTokens = queryTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function memoryEntrySimilarity(left, right) {
  const leftEmbedding = left.version.embedding;
  const rightEmbedding = right.version.embedding;
  if (leftEmbedding?.profileId && leftEmbedding.profileId === rightEmbedding?.profileId) {
    const similarity = cosineSimilarity(leftEmbedding.vector, rightEmbedding.vector);
    if (similarity > 0) return similarity;
  }
  return lexicalSimilarity(
    memoryEmbeddingText(left.semanticKey, left.version.content),
    memoryEmbeddingText(right.semanticKey, right.version.content),
  );
}

function diversifyMemoryEntries(entries, lambda) {
  if (entries.length < 2 || lambda >= 1) return entries;
  const remaining = [...entries];
  const selected = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestMmr = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      let redundancy = 0;
      for (const prior of selected) redundancy = Math.max(redundancy, memoryEntrySimilarity(candidate, prior));
      const mmr = lambda * candidate.score - (1 - lambda) * redundancy;
      const current = remaining[bestIndex];
      if (
        mmr > bestMmr
        || (mmr === bestMmr && candidate.score > current.score)
        || (mmr === bestMmr && candidate.score === current.score && candidate.version.sequence > current.version.sequence)
        || (mmr === bestMmr && candidate.score === current.score && candidate.version.sequence === current.version.sequence && candidate.recordId.localeCompare(current.recordId) < 0)
      ) {
        bestMmr = mmr;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function scopeMatches(memoryScope, scope) {
  if (memoryScope.level === "user") return scope.memoryMode === "global" && memoryScope.id === scope.actorId;
  if (memoryScope.level === "project") return Boolean(scope.projectId) && memoryScope.id === scope.projectId;
  if (memoryScope.level === "conversation") return memoryScope.id === scope.conversationId;
  // workspace/task records can exist in stores created by older releases.
  // Keep them readable for audit and invalidation, but never project them into
  // model context: cwd and remote Task identity are not memory boundaries.
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
  constructor({ dataRoot, actor, queue, clock, embedder = null }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
    this.embedder = embedder;
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

  async retrievalConfiguration() {
    if (!this.embedder?.memoryConfiguration) return DEFAULT_RETRIEVAL;
    try {
      return Object.freeze({ ...DEFAULT_RETRIEVAL, ...(await this.embedder.memoryConfiguration()) });
    } catch {
      return DEFAULT_RETRIEVAL;
    }
  }

  async #embeddingFor(semanticKey, content) {
    if (!this.embedder?.embedTexts) return null;
    const configuration = await this.retrievalConfiguration();
    if (!configuration.configured || !configuration.enabled || !configuration.embeddingProfileId) return null;
    try {
      const embedded = await this.embedder.embedTexts([memoryEmbeddingText(semanticKey, content)]);
      const vector = embedded?.vectors?.[0];
      if (!Array.isArray(vector) || !vector.length) return null;
      return { profileId: configuration.embeddingProfileId, vector: vector.map(Number) };
    } catch {
      // Memory writes and lexical retrieval must remain available while the
      // shared Embedding provider is unavailable. Missing vectors are
      // backfilled on a later search.
      return null;
    }
  }

  async #persistEmbeddings(updates) {
    if (!updates.length) return;
    await this.#update((data) => {
      for (const update of updates) {
        const record = data.records[update.recordId];
        const version = record?.versions?.find((candidate) => candidate.id === update.versionId);
        if (version) version.embedding = structuredClone(update.embedding);
      }
    });
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
    const embedding = await this.#embeddingFor(semanticKey, content);
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
        ...(embedding ? { embedding } : {}),
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

  async forkConversationScope({ sourceConversationId, targetConversationId, sourceIds = [], source }) {
    const sourceId = String(sourceConversationId || "");
    const targetId = String(targetConversationId || "");
    const includedSources = new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean));
    invariant(sourceId && targetId && sourceId !== targetId, "MEMORY_FORK_SCOPE_INVALID", "分支对话的 Memory scope 无效", { status: 400 });
    invariant(includedSources.size > 0, "MEMORY_FORK_BOUNDARY_EMPTY", "分支对话缺少 Memory 来源边界", { status: 400 });
    const provenance = normalizeSource(source);
    let output = { copied: 0, versionIds: [] };
    await this.#update((data) => {
      const invalidated = invalidatedVersionIds(data, data.sequence);
      const candidates = Object.values(data.records)
        .filter((record) => record.scope?.level === "conversation" && record.scope.id === sourceId)
        .map((record) => ({
          record,
          version: [...record.versions]
            .filter((version) => includedSources.has(String(version.source?.id || "")) && !invalidated.has(version.id))
            .sort((left, right) => right.sequence - left.sequence)[0] || null,
        }))
        .filter((entry) => entry.version);
      const versionIds = [];
      for (const { record, version: original } of candidates) {
        const scope = { level: "conversation", id: targetId };
        const recordId = `memory_${scopeIdentity(scope, record.semanticKey).slice(0, 32)}`;
        if (data.records[recordId]) continue;
        data.sequence += 1;
        const createdAt = nowIso(this.clock);
        const version = {
          id: createId("memory_version"),
          sequence: data.sequence,
          content: original.content,
          authority: original.authority,
          confidence: original.confidence,
          sensitivity: original.sensitivity,
          portability: original.portability,
          source: provenance,
          supersedes: null,
          createdAt,
          ...(original.embedding ? { embedding: structuredClone(original.embedding) } : {}),
        };
        data.records[recordId] = {
          id: recordId,
          scope,
          semanticKey: record.semanticKey,
          revision: 0,
          versions: [version],
          createdAt,
          updatedAt: createdAt,
        };
        versionIds.push(version.id);
      }
      output = { copied: versionIds.length, versionIds };
    });
    return structuredClone(output);
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

  async filterObservations(fragments) {
    if (!fragments.some((fragment) => String(fragment?.knowledge?.key || "").startsWith("memory:"))) return fragments;
    const state = (await this.#repository().read()).data;
    const invalidated = invalidatedVersionIds(state, state.sequence);
    return fragments.filter((fragment) => {
      const key = String(fragment?.knowledge?.key || "");
      if (!key.startsWith("memory:")) return true;
      const record = state.records[key.slice("memory:".length)];
      if (!record) return false;
      const latest = [...record.versions].reverse().find((version) => !invalidated.has(version.id));
      return Boolean(latest && String(latest.content).trim() === String(fragment.knowledge.content || "").trim());
    });
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

  async invalidateScopes({ scopes, reason, source }) {
    const requested = new Map();
    for (const value of Array.isArray(scopes) ? scopes : []) {
      const scope = normalizeScope(value, this.actor, { allowLegacy: true });
      requested.set(`${scope.level}\0${scope.id}`, scope);
    }
    invariant(requested.size > 0, "MEMORY_INVALIDATION_SCOPE_EMPTY", "必须指定需要失效的 Memory scope", { status: 400 });
    const state = await this.#repository().read();
    const alreadyInvalidated = invalidatedVersionIds(state.data, state.data.sequence);
    const versionIds = Object.values(state.data.records).flatMap((record) => (
      requested.has(`${record.scope.level}\0${record.scope.id}`)
        ? record.versions.filter((version) => !alreadyInvalidated.has(version.id)).map((version) => version.id)
        : []
    ));
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
    const query = queryTokens(options.query, { suppressIncidentalHanUnigrams: true });
    const requiredAnchors = requiredExplicitQueryAnchors(options.query);
    const limit = Number(options.limit ?? 50);
    invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 500, "MEMORY_LIMIT_INVALID", "Memory limit 无效", { status: 400 });
    const entries = [];
    for (const record of Object.values(state.data.records)) {
      if (!scopeMatches(record.scope, scope)) continue;
      const version = selectedVersion(record, { asOfSequence, snapshotVersionIds, invalidated, baselineSequence, invalidatedAtBaseline });
      if (!version || (version.sensitivity === "restricted" && !options.includeRestricted)) continue;
      // Runtime measurements, absolute paths and unfinished activity summaries
      // are audit material, not durable semantic memory.
      if (!durableStoredMemory(record.semanticKey, version.content)) continue;
      // Concrete filenames, job ids and similar identifiers constrain the
      // requested subject. Generic prose such as “静态检查” must not surface a
      // different fact merely because it shares one broad phrase.
      const searchable = memoryEmbeddingText(record.semanticKey, version.content);
      if (requiredAnchors.length && !containsExplicitQueryAnchor(searchable, requiredAnchors)) continue;
      const relevanceScore = relevance(searchable, query);
      entries.push({
        recordId: record.id,
        semanticKey: record.semanticKey,
        scope: structuredClone(record.scope),
        version: structuredClone(version),
        score: LEVEL_WEIGHT[record.scope.level] * 10 + (AUTHORITY_WEIGHT[version.authority] || 0) + version.confidence + relevanceScore,
        lexicalScore: normalizedRelevance(version.content, query),
        titleScore: normalizedRelevance(record.semanticKey, query),
        vectorScore: 0,
      });
    }
    if (query.size && entries.length) {
      const configuration = await this.retrievalConfiguration();
      let queryVector = null;
      const missing = configuration.configured && configuration.enabled && configuration.embeddingProfileId && this.embedder?.embedTexts
        ? entries.filter((entry) => entry.version.embedding?.profileId !== configuration.embeddingProfileId)
        : [];
      if (configuration.configured && configuration.enabled && configuration.embeddingProfileId && this.embedder?.embedTexts) {
        try {
          const queryEmbedding = await this.embedder.embedTexts([String(options.query || "")]);
          queryVector = queryEmbedding?.vectors?.[0] || null;
          const updates = [];
          const pageSize = Math.min(100, Math.max(5, Number(configuration.pageSize) || DEFAULT_RETRIEVAL.pageSize));
          for (let offset = 0; offset < missing.length; offset += pageSize) {
            const page = missing.slice(offset, offset + pageSize);
            try {
              const embedded = await this.embedder.embedTexts(page.map((entry) => memoryEmbeddingText(entry.semanticKey, entry.version.content)));
              for (let index = 0; index < page.length; index += 1) {
                const vector = embedded?.vectors?.[index];
                if (!Array.isArray(vector) || !vector.length) continue;
                const embedding = { profileId: configuration.embeddingProfileId, vector: vector.map(Number) };
                page[index].version.embedding = embedding;
                updates.push({ recordId: page[index].recordId, versionId: page[index].version.id, embedding });
              }
            } catch {
              // A failed backfill page must not discard vectors from other
              // pages or disable lexical/title retrieval for this query.
            }
          }
          await this.#persistEmbeddings(updates);
        } catch {
          queryVector = null;
        }
      }
      const vectorWeight = queryVector ? configuration.vectorWeight : 0;
      const totalWeight = vectorWeight + configuration.lexicalWeight + configuration.titleWeight;
      for (const entry of entries) {
        entry.vectorScore = queryVector ? cosineSimilarity(queryVector, entry.version.embedding?.vector) : 0;
        const semanticScore = totalWeight
          ? (entry.vectorScore * vectorWeight + entry.lexicalScore * configuration.lexicalWeight + entry.titleScore * configuration.titleWeight) / totalWeight
          : 0;
        const scopeBonus = entry.scope.level === "conversation" ? 0.03 : entry.scope.level === "project" ? 0.02 : 0.01;
        const authorityBonus = ((AUTHORITY_WEIGHT[entry.version.authority] || 0) / 6) * 0.02;
        const confidenceBonus = Number(entry.version.confidence || 0) * 0.01;
        entry.semanticScore = semanticScore;
        entry.score = semanticScore + scopeBonus + authorityBonus + confidenceBonus;
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (
          (entry.vectorScore <= 0 && entry.lexicalScore <= 0 && entry.titleScore <= 0)
          || entry.semanticScore < configuration.minimumScore
        ) entries.splice(index, 1);
      }
    }
    entries.sort((left, right) => right.score - left.score || right.version.sequence - left.version.sequence || left.recordId.localeCompare(right.recordId));
    const configuration = query.size ? await this.retrievalConfiguration() : DEFAULT_RETRIEVAL;
    const diversified = query.size ? diversifyMemoryEntries(entries, configuration.diversityLambda) : entries;
    return { sequence: state.data.sequence, asOfSequence, entries: diversified.slice(0, limit) };
  }

  async snapshot(scope, options = {}) {
    validateEffectiveContextScope(scope);
    invariant(scope.actorType === this.actor.actorType && scope.actorId === this.actor.actorId, "MEMORY_SCOPE_ACTOR_MISMATCH", "Memory scope 不属于当前 Actor", { status: 403 });
    const state = await this.#repository().read();
    const asOfSequence = options.asOfSequence ?? state.data.sequence;
    invariant(Number.isSafeInteger(asOfSequence) && asOfSequence >= 0 && asOfSequence <= state.data.sequence, "MEMORY_SEQUENCE_INVALID", "Memory snapshot sequence 无效", { status: 400 });
    const explicitVersions = options.versionIds ?? [];
    const snapshotVersionIds = new Set(explicitVersions || []);
    const invalidated = invalidatedVersionIds(state.data, asOfSequence);
    const baselineSequence = scope.memoryBaselineSequence ?? options.baselineSequence ?? null;
    invariant(baselineSequence === null || (Number.isSafeInteger(baselineSequence) && baselineSequence >= 0 && baselineSequence <= asOfSequence), "MEMORY_BASELINE_INVALID", "Memory baseline 无效", { status: 400 });
    const invalidatedAtBaseline = baselineSequence === null ? invalidated : invalidatedVersionIds(state.data, baselineSequence);
    const versionIds = [];
    for (const record of Object.values(state.data.records)) {
      if (!scopeMatches(record.scope, scope)) continue;
      const version = selectedVersion(record, {
        asOfSequence,
        snapshotVersionIds,
        invalidated,
        baselineSequence,
        invalidatedAtBaseline,
      });
      if (!version || (version.sensitivity === "restricted" && !options.includeRestricted)) continue;
      if (!durableStoredMemory(record.semanticKey, version.content)) continue;
      versionIds.push(version.id);
    }
    return {
      sequence: state.data.sequence,
      asOfSequence,
      versionIds,
    };
  }

  async contextEntries(scope, options = {}) {
    const selected = await this.select(scope, options);
    return selected.entries.map((entry) => ({
      id: entry.version.id,
      kind: "memory",
      semanticKey: entry.semanticKey,
      title: entry.semanticKey,
      content: entry.version.content,
      tokenEstimate: options.tokenEstimator?.(entry.version.content),
      sensitivity: entry.version.sensitivity,
      priority: entry.score,
      source: { type: "memory", id: entry.recordId, version: entry.version.id },
      // Provenance is consumed by the host before the semantic projection is
      // shown to a model. It lets a reused native Agent session suppress facts
      // that were extracted from that same session without exposing IDs.
      origin: structuredClone(entry.version.source),
    }));
  }
}

export { ACTIVE_LEVELS as MEMORY_LEVELS };
