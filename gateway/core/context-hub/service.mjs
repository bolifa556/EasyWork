import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import {
  computeContextDeliveryDigest,
  createContextDelivery,
  createContextSession,
  transitionContextSession,
  validateContextDelivery,
  validateContextSession,
  validateEffectiveContextScope,
} from "../entities/context.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

const SOURCE_ORDER = Object.freeze([
  "system",
  "conversation",
  "task",
  "memory",
  "resources",
  "skills",
  "environment",
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const createId = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const defaultTokenEstimate = (value) => Math.ceil([...String(value || "")].length / 3.2);
const semanticContentDigest = (value) => sha256(String(value || "").replace(/\r\n/g, "\n").trim());
const MAX_RECEIPT_ITEMS = 50_000;
const MAX_RECEIPT_CHECKPOINTS = 10_000;
const emptyReceiptSnapshot = () => ({
  entryDigests: [],
  contentDigests: [],
  knowledgeVersions: {},
  lastDeliveryId: null,
  lastSequence: 0,
});
const emptyReceipt = () => ({
  ...emptyReceiptSnapshot(),
  checkpointBase: emptyReceiptSnapshot(),
  checkpoints: [],
  checkpointSequence: 0,
});

function receiptSnapshot(value = {}) {
  return {
    entryDigests: [...new Set(Array.isArray(value?.entryDigests) ? value.entryDigests.map(String) : [])].slice(-MAX_RECEIPT_ITEMS),
    contentDigests: [...new Set(Array.isArray(value?.contentDigests) ? value.contentDigests.map(String) : [])].slice(-MAX_RECEIPT_ITEMS),
    knowledgeVersions: Object.fromEntries(Object.entries(value?.knowledgeVersions || {}).slice(-MAX_RECEIPT_ITEMS)),
    lastDeliveryId: value?.lastDeliveryId == null ? null : String(value.lastDeliveryId),
    lastSequence: Number.isSafeInteger(value?.lastSequence) && value.lastSequence >= 0 ? value.lastSequence : 0,
  };
}

function normalizeReceiptForMutation(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return emptyReceipt();
  const hasCheckpointLedger = Array.isArray(stored.checkpoints) && stored.checkpointBase && typeof stored.checkpointBase === "object";
  return {
    ...structuredClone(stored),
    ...receiptSnapshot(stored),
    // A pre-checkpoint receipt is the baseline of a live native conversation.
    // Preserve it rather than pretending old knowledge arrived in the first
    // post-migration Task, which would make an older rewind resend everything.
    checkpointBase: receiptSnapshot(hasCheckpointLedger ? stored.checkpointBase : stored),
    checkpoints: hasCheckpointLedger ? structuredClone(stored.checkpoints) : [],
    checkpointSequence: Number.isSafeInteger(stored.checkpointSequence) && stored.checkpointSequence >= 0
      ? stored.checkpointSequence
      : 0,
  };
}

function applyReceiptCheckpoint(snapshotInput, checkpoint) {
  const snapshot = receiptSnapshot(snapshotInput);
  const knowledgeVersions = {
    ...snapshot.knowledgeVersions,
    ...(checkpoint?.knowledgeVersions && typeof checkpoint.knowledgeVersions === "object" ? checkpoint.knowledgeVersions : {}),
  };
  return {
    entryDigests: [...new Set([...snapshot.entryDigests, ...(checkpoint?.entryDigests || []).map(String)])].slice(-MAX_RECEIPT_ITEMS),
    contentDigests: [...new Set([...snapshot.contentDigests, ...(checkpoint?.contentDigests || []).map(String)])].slice(-MAX_RECEIPT_ITEMS),
    knowledgeVersions: Object.fromEntries(Object.entries(knowledgeVersions).slice(-MAX_RECEIPT_ITEMS)),
    lastDeliveryId: checkpoint?.lastDeliveryId == null ? snapshot.lastDeliveryId : String(checkpoint.lastDeliveryId),
    lastSequence: Math.max(snapshot.lastSequence, Number(checkpoint?.lastSequence || 0)),
  };
}

function checkpointPrefix(receiptInput, checkpointId) {
  const receipt = normalizeReceiptForMutation(receiptInput);
  let snapshot = receiptSnapshot(receipt.checkpointBase);
  const checkpoints = [];
  let selected = null;
  for (const checkpoint of receipt.checkpoints) {
    snapshot = applyReceiptCheckpoint(snapshot, checkpoint);
    checkpoints.push(structuredClone(checkpoint));
    if (String(checkpoint.checkpointId) === String(checkpointId)) {
      selected = checkpoint;
      break;
    }
  }
  return { receipt, snapshot, checkpoints, selected };
}

function receiptCheckpointDelta(previousInput, currentInput) {
  const previous = receiptSnapshot(previousInput);
  const current = receiptSnapshot(currentInput);
  const knownEntries = new Set(previous.entryDigests);
  const knownContent = new Set(previous.contentDigests);
  return {
    entryDigests: current.entryDigests.filter((digest) => !knownEntries.has(digest)),
    contentDigests: current.contentDigests.filter((digest) => !knownContent.has(digest)),
    knowledgeVersions: Object.fromEntries(Object.entries(current.knowledgeVersions)
      .filter(([key, version]) => previous.knowledgeVersions[key] !== version)),
    lastDeliveryId: current.lastDeliveryId,
    lastSequence: current.lastSequence,
  };
}

async function updateWithLatestRevision(repository, mutate) {
  for (;;) {
    const current = await repository.read();
    try {
      return await repository.update(mutate, { expectedRevision: current.revision });
    } catch (error) {
      // Live append lets two webpage runs finish against the same native Agent
      // turn. Their context acknowledgements are additive and may legitimately
      // read the same revision, so retry the loser against the latest receipt
      // instead of failing an otherwise completed Agent response.
      if (error?.code !== "REVISION_CONFLICT") throw error;
    }
  }
}

function normalizeKnowledgeUnit(value) {
  const key = String(value?.key || "").trim();
  const version = String(value?.version || "").trim();
  const content = String(value?.content || "").replace(/\r\n/g, "\n").trim();
  if (!key || !version) return null;
  return { key, version, content };
}

function stagedKnowledgeEntry(unit, taskId, tokenEstimator) {
  // Work Skill entrypoints are intentionally not staged here: selected Skills
  // are immutable packages exposed through each Agent's native discovery
  // directory. ContextHub carries semantic memory and resource evidence.
  const separator = unit.key.indexOf(":");
  const sourceType = separator > 0 ? unit.key.slice(0, separator) : "memory";
  const sourceId = separator > 0 ? unit.key.slice(separator + 1) : unit.key;
  return normalizeEntry({
    id: `staged:${taskId}:${sha256(`${unit.key}\0${unit.version}`).slice(0, 24)}`,
    kind: sourceType === "conversation" ? "message" : sourceType === "resource" ? "resource" : sourceType === "skill" ? "skill" : "memory",
    source: { type: sourceType, id: sourceId, version: unit.version },
    content: unit.content,
    sensitivity: "private",
    priority: sourceType === "conversation" || sourceType === "skill" ? 100 : sourceType === "resource" ? 90 : 80,
  }, sourceType, tokenEstimator);
}

const knowledgeKeyDigest = (value) => sha256(`knowledge-key\0${value}`);
const knowledgeVersionDigest = (value) => sha256(`knowledge-version\0${value}`);

function updateKnowledgeVersions(previous, units) {
  const versions = new Map(Object.entries(previous?.knowledgeVersions || {}));
  for (const unit of units) {
    const key = knowledgeKeyDigest(unit.key);
    // Reinsert updated keys so the bounded tail retains the newest knowledge.
    versions.delete(key);
    versions.set(key, knowledgeVersionDigest(unit.version));
  }
  return Object.fromEntries([...versions.entries()].slice(-MAX_RECEIPT_ITEMS));
}

function deliveryKnowledgeUnits(delivery) {
  return delivery.entries.flatMap((entry) => {
    const sourceType = String(entry?.source?.type || "").trim();
    const sourceId = String(entry?.source?.id || "").trim();
    const sourceVersion = String(entry?.source?.version || "").trim();
    if (!sourceType || !sourceId || !sourceVersion) return [];
    return [{
      key: `${sourceType}:${sourceId}`,
      version: sourceVersion,
      content: String(entry?.content?.value || ""),
    }];
  });
}

function normalizeEntry(value, sourceName, tokenEstimator) {
  if (value?.format === "json" || value?.content?.format === "json") return null;
  const contentValue = typeof value?.content === "string"
    ? value.content
    : typeof value?.value === "string" ? value.value : "";
  if (!contentValue.trim()) return null;
  const source = value?.source && typeof value.source === "object"
    ? value.source
    : { type: sourceName, id: String(value?.id || createId("source")), version: String(value?.version || "1") };
  const content = {
    format: value?.format === "reference" ? "reference" : "text",
    value: contentValue,
  };
  return {
    id: String(value?.id || createId("entry")),
    kind: String(value?.kind || (sourceName === "conversation" ? "message" : sourceName === "resources" ? "resource" : sourceName === "skills" ? "skill" : sourceName)),
    source: {
      type: String(source.type || sourceName),
      id: String(source.id || createId("source")),
      version: String(source.version || "1"),
    },
    content,
    tokenEstimate: Number.isSafeInteger(value?.tokenEstimate)
      ? value.tokenEstimate
      : tokenEstimator(contentValue),
    sensitivity: ["public", "private", "restricted"].includes(value?.sensitivity) ? value.sensitivity : "private",
    digest: sha256(JSON.stringify({ source, content })),
    priority: Number.isFinite(value?.priority) ? Number(value.priority) : 0,
    required: Boolean(value?.required),
  };
}

function selectWithinBudget(entries, budget) {
  const available = budget.maxTokens - budget.reservedOutputTokens;
  const ordered = entries
    .map((entry, order) => ({ ...entry, order }))
    .sort((left, right) => Number(right.required) - Number(left.required) || right.priority - left.priority || left.order - right.order);
  const selected = [];
  let used = 0;
  for (const entry of ordered) {
    // Native transcript continuity cannot be silently truncated by a retrieval
    // budget. The remote Agent owns its context window and compaction; keep all
    // missing historical turns together, and budget optional knowledge normally.
    if (used + entry.tokenEstimate > available && entry.source.type !== "conversation") {
      invariant(!entry.required, "CONTEXT_REQUIRED_ENTRY_EXCEEDS_BUDGET", "必要上下文超过 ContextSession 预算", {
        status: 409,
        details: { entryId: entry.id, tokenEstimate: entry.tokenEstimate, availableTokens: available - used },
      });
      continue;
    }
    used += entry.tokenEstimate;
    selected.push(entry);
  }
  selected.sort((left, right) => left.order - right.order);
  return {
    entries: selected.map((entry) => {
      const clean = { ...entry };
      delete clean.priority;
      delete clean.required;
      delete clean.order;
      return clean;
    }),
    usage: { usedTokens: used, availableTokens: available, omittedEntries: entries.length - selected.length },
  };
}

function rebindPriority(entry, current = false, recency = 0) {
  const sourceType = String(entry?.source?.type || "");
  const base = sourceType === "resource"
    ? 90
    : sourceType === "memory"
      ? 80
      : entry?.kind === "conversation_state"
        ? 75
        : sourceType === "conversation"
          ? 60
          : 40;
  // The delivery assembled for the active turn is always preferred over
  // older reconstruction material.  Recency only breaks ties inside the
  // recovered native history and never changes the current-turn ordering.
  return base + (current ? 1_000 : Math.min(10, Math.max(0, recency)));
}

function sourceIdentity(entry) {
  return `${String(entry?.source?.type || "")}\0${String(entry?.source?.id || "")}`;
}

export class ContextHub {
  constructor({ dataRoot, actor, sources = {}, tokenEstimator = defaultTokenEstimate, queue }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.sources = sources;
    this.tokenEstimator = tokenEstimator;
    this.queue = queue;
  }

  #sessions() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["runtime", "context", "sessions.json"],
      schemaVersion: 1,
      defaultData: () => ({ sessions: {}, deliveries: {} }),
      validate: (data) => {
        if (!data || typeof data !== "object" || Array.isArray(data) || !data.sessions || !data.deliveries) return false;
        for (const session of Object.values(data.sessions)) validateContextSession(session);
        for (const list of Object.values(data.deliveries)) {
          if (!Array.isArray(list)) return false;
          for (const delivery of list) validateContextDelivery(delivery);
        }
        return true;
      },
      queue: this.queue,
    });
  }

  #receipts() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["runtime", "context", "receipts.json"],
      schemaVersion: 1,
      defaultData: () => ({ bindings: {}, pending: {} }),
      validate: (data) => Boolean(data && typeof data === "object" && !Array.isArray(data)
        && data.bindings && typeof data.bindings === "object" && !Array.isArray(data.bindings)
        && (data.pending === undefined || (data.pending && typeof data.pending === "object" && !Array.isArray(data.pending)))),
      queue: this.queue,
    });
  }

  async createSession({ consumer, consumerId, scope, budget, id = createId("ctx") }) {
    validateEffectiveContextScope(scope);
    invariant(scope.actorId === this.actor.actorId && scope.actorType === this.actor.actorType, "CONTEXT_SCOPE_ACTOR_MISMATCH", "Scope 不属于当前 Actor", { status: 403 });
    const session = createContextSession({
      id,
      actorId: this.actor.actorId,
      consumer,
      consumerId,
      scope,
      budget,
    });
    const repository = this.#sessions();
    const current = await repository.read();
    await repository.update((data) => {
      invariant(!data.sessions[id], "CONTEXT_SESSION_EXISTS", "ContextSession 已存在", { status: 409 });
      data.sessions[id] = session;
    }, { expectedRevision: current.revision });
    return session;
  }

  async getSession(sessionId) {
    const state = await this.#sessions().read();
    const session = state.data.sessions[sessionId];
    invariant(session, "CONTEXT_SESSION_NOT_FOUND", "ContextSession 不存在", { status: 404 });
    return structuredClone(session);
  }

  async assemble(sessionId, options = {}) {
    const repository = this.#sessions();
    const current = await repository.read();
    let session = current.data.sessions[sessionId];
    invariant(session, "CONTEXT_SESSION_NOT_FOUND", "ContextSession 不存在", { status: 404 });
    invariant(session.status === "open", "CONTEXT_SESSION_NOT_OPEN", "ContextSession 已封存", { status: 409 });
    const candidates = [];
    for (const name of SOURCE_ORDER) {
      const source = this.sources[name];
      if (typeof source !== "function") continue;
      const result = await source({ actor: this.actor, scope: session.scope, consumer: session.consumer, signal: options.signal });
      for (const value of Array.isArray(result) ? result : result ? [result] : []) {
        const normalized = normalizeEntry(value, name, this.tokenEstimator);
        if (normalized) candidates.push(normalized);
      }
    }
    const receipts = await this.#receipts().read();
    const pending = receipts.data.pending?.[String(session.consumerId)] || null;
    if (pending) {
      for (const unit of (Array.isArray(pending?.units) ? pending.units : []).map(normalizeKnowledgeUnit).filter(Boolean)) {
        const normalized = stagedKnowledgeEntry(unit, session.consumerId, this.tokenEstimator);
        if (normalized) candidates.push(normalized);
      }
    }
    const selected = selectWithinBudget(candidates, session.budget);
    session = transitionContextSession(session, "sealed", { expectedRevision: session.revision });
    const deliveries = current.data.deliveries[sessionId] || [];
    const delivery = createContextDelivery({
      id: options.deliveryId || createId("delivery"),
      session,
      sequence: deliveries.length + 1,
      mode: options.mode || "bootstrap",
      entries: selected.entries,
      supersedes: options.supersedes || [],
    });
    invariant(delivery.digest === computeContextDeliveryDigest(delivery), "CONTEXT_DELIVERY_DIGEST_MISMATCH", "Delivery digest 无效", { status: 500, expose: false });
    await repository.update((data) => {
      const stored = data.sessions[sessionId];
      invariant(stored?.revision === session.revision - 1, "REVISION_CONFLICT", "ContextSession 已被其他请求更新", { status: 409 });
      data.sessions[sessionId] = session;
      data.deliveries[sessionId] = [...(data.deliveries[sessionId] || []), delivery];
    }, { expectedRevision: current.revision });
    return { session, delivery, usage: selected.usage };
  }

  async deliveryForBinding(bindingKey, delivery, nativeSessionId = null) {
    validateContextDelivery(delivery);
    const receipts = await this.#receipts().read();
    const receipt = receipts.data.bindings[bindingKey] || null;
    // A receipt is only authoritative while the corresponding native session
    // still exists.  If the binding has lost its native session, replay the
    // complete selected context so a newly-created session is not starved by
    // stale receipts left by the previous process/session.
    const sameNativeSession = Boolean(nativeSessionId && receipt?.nativeSessionId === nativeSessionId);
    const known = new Set(sameNativeSession ? receipt?.entryDigests || [] : []);
    const knownContent = new Set(sameNativeSession ? receipt?.contentDigests || [] : []);
    const entries = delivery.entries.filter((entry) => {
      if (known.has(entry.digest)) return false;
      // Two separate chat turns may intentionally contain identical text.
      // Their message identities, rather than semantic-content de-duplication,
      // define the transcript received by one native Agent conversation.
      if (String(entry?.source?.type || "") === "conversation") return true;
      return !knownContent.has(semanticContentDigest(entry.content?.value));
    });
    if (entries.length === delivery.entries.length) return structuredClone(delivery);
    return createContextDelivery({
      id: createId("delivery"),
      session: await this.getSession(delivery.sessionId),
      sequence: delivery.sequence,
      mode: "delta",
      entries,
      supersedes: delivery.supersedes,
    });
  }

  async deliveryForRebinding(bindingKey, delivery) {
    validateContextDelivery(delivery);
    const [receipts, sessions] = await Promise.all([
      this.#receipts().read(),
      this.#sessions().read(),
    ]);
    const receipt = receipts.data.bindings[String(bindingKey)] || null;
    const known = new Set(Array.isArray(receipt?.entryDigests) ? receipt.entryDigests : []);
    if (!known.size) return structuredClone(delivery);

    // A verified missing native session must be rebuilt from semantic inputs,
    // not from its Agent's tool log.  Context deliveries are the durable record
    // of exactly which webpage messages, memories and resource fragments the
    // previous native session received.  Reconstruct their latest source
    // versions, then overlay the active turn's freshly assembled delivery.
    const historicalDeliveries = Object.values(sessions.data.deliveries || {})
      .flatMap((entries) => Array.isArray(entries) ? entries : [])
      .sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || ""))
        || Number(left.sequence || 0) - Number(right.sequence || 0));
    const recoveredBySource = new Map();
    let recoveredOrder = 0;
    for (const historical of historicalDeliveries) {
      for (const entry of historical.entries || []) {
        if (!known.has(entry.digest)) continue;
        recoveredOrder += 1;
        recoveredBySource.set(sourceIdentity(entry), {
          ...structuredClone(entry),
          priority: rebindPriority(entry, false, recoveredOrder / Math.max(1, known.size)),
          required: false,
        });
      }
    }
    for (const entry of delivery.entries) {
      const identity = sourceIdentity(entry);
      recoveredBySource.delete(identity);
      recoveredBySource.set(identity, {
        ...structuredClone(entry),
        priority: rebindPriority(entry, true),
        required: false,
      });
    }

    const semanticSeen = new Set();
    const idSeen = new Set();
    const candidates = [];
    for (const entry of recoveredBySource.values()) {
      const contentDigest = semanticContentDigest(entry.content?.value);
      const exactTranscriptEntry = String(entry?.source?.type || "") === "conversation";
      if ((!exactTranscriptEntry && semanticSeen.has(contentDigest)) || idSeen.has(entry.id)) continue;
      if (!exactTranscriptEntry) semanticSeen.add(contentDigest);
      idSeen.add(entry.id);
      candidates.push(entry);
    }
    const session = await this.getSession(delivery.sessionId);
    const selected = selectWithinBudget(candidates, session.budget);
    return createContextDelivery({
      id: createId("delivery"),
      session,
      sequence: delivery.sequence,
      mode: "bootstrap",
      entries: selected.entries,
      supersedes: delivery.supersedes,
    });
  }

  async acknowledge({ bindingKey, nativeSessionId, delivery }) {
    validateContextDelivery(delivery);
    invariant(bindingKey && nativeSessionId, "CONTEXT_RECEIPT_INVALID", "Context receipt 缺少 Agent binding", { status: 400 });
    const repository = this.#receipts();
    const acknowledgedAt = new Date().toISOString();
    await updateWithLatestRevision(repository, (data) => {
      const stored = data.bindings[bindingKey] || null;
      const previous = stored?.nativeSessionId === nativeSessionId
        ? normalizeReceiptForMutation(stored)
        : emptyReceipt();
      const knowledgeUnits = deliveryKnowledgeUnits(delivery);
      data.bindings[bindingKey] = {
        ...previous,
        nativeSessionId,
        entryDigests: [...new Set([...(previous.entryDigests || []), ...delivery.entries.map((entry) => entry.digest)])].slice(-MAX_RECEIPT_ITEMS),
        contentDigests: [...new Set([...(previous.contentDigests || []), ...delivery.entries.map((entry) => semanticContentDigest(entry.content?.value))])].slice(-MAX_RECEIPT_ITEMS),
        knowledgeVersions: updateKnowledgeVersions(previous, knowledgeUnits),
        lastDeliveryId: delivery.id,
        lastSequence: Math.max(previous.lastSequence || 0, delivery.sequence),
        acknowledgedAt,
      };
    });
    return { bindingKey, deliveryId: delivery.id, acknowledgedAt };
  }

  async acknowledgeSemanticContent({ bindingKey, nativeSessionId, values }) {
    invariant(bindingKey && nativeSessionId, "CONTEXT_RECEIPT_INVALID", "Context receipt 缺少 Agent binding", { status: 400 });
    const contentDigests = [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map(semanticContentDigest))];
    if (!contentDigests.length) return { bindingKey, acknowledgedAt: null };
    const repository = this.#receipts();
    const acknowledgedAt = new Date().toISOString();
    await updateWithLatestRevision(repository, (data) => {
      const stored = data.bindings[bindingKey] || null;
      const previous = stored?.nativeSessionId === nativeSessionId
        ? normalizeReceiptForMutation(stored)
        : emptyReceipt();
      data.bindings[bindingKey] = {
        ...previous,
        nativeSessionId,
        entryDigests: [...(previous.entryDigests || [])],
        contentDigests: [...new Set([...(previous.contentDigests || []), ...contentDigests])].slice(-MAX_RECEIPT_ITEMS),
        knowledgeVersions: { ...(previous.knowledgeVersions || {}) },
        acknowledgedAt,
      };
    });
    return { bindingKey, acknowledgedAt };
  }

  async unacknowledgedSemanticContent({ bindingKey, nativeSessionId, values }) {
    invariant(bindingKey && nativeSessionId, "CONTEXT_RECEIPT_INVALID", "Context receipt 缺少 Agent binding", { status: 400 });
    const candidates = (Array.isArray(values) ? values : []).map((value) => String(value || "")).filter((value) => value.trim());
    if (!candidates.length) return [];
    const receipts = await this.#receipts().read();
    const receipt = receipts.data.bindings[bindingKey] || null;
    if (receipt?.nativeSessionId !== nativeSessionId) return candidates;
    const known = new Set(receipt.contentDigests || []);
    return candidates.filter((value) => !known.has(semanticContentDigest(value)));
  }

  async acknowledgeKnowledge({ bindingKey, nativeSessionId, units }) {
    invariant(bindingKey && nativeSessionId, "CONTEXT_RECEIPT_INVALID", "Context receipt 缺少 Agent binding", { status: 400 });
    const normalized = (Array.isArray(units) ? units : []).map(normalizeKnowledgeUnit).filter(Boolean);
    if (!normalized.length) return { bindingKey, acknowledgedAt: null };
    const repository = this.#receipts();
    const acknowledgedAt = new Date().toISOString();
    await updateWithLatestRevision(repository, (data) => {
      const stored = data.bindings[bindingKey] || null;
      const previous = stored?.nativeSessionId === nativeSessionId ? normalizeReceiptForMutation(stored) : emptyReceipt();
      const knowledgeContent = normalized.map((unit) => unit.content).filter(Boolean).map(semanticContentDigest);
      data.bindings[bindingKey] = {
        ...previous,
        nativeSessionId,
        entryDigests: [...(previous.entryDigests || [])],
        contentDigests: [...new Set([...(previous.contentDigests || []), ...knowledgeContent])].slice(-MAX_RECEIPT_ITEMS),
        knowledgeVersions: updateKnowledgeVersions(previous, normalized),
        acknowledgedAt,
      };
    });
    return { bindingKey, acknowledgedAt };
  }

  async unacknowledgedKnowledge({ bindingKey, nativeSessionId, units }) {
    invariant(bindingKey && nativeSessionId, "CONTEXT_RECEIPT_INVALID", "Context receipt 缺少 Agent binding", { status: 400 });
    const candidates = (Array.isArray(units) ? units : []).map(normalizeKnowledgeUnit).filter(Boolean);
    if (!candidates.length) return [];
    const receipts = await this.#receipts().read();
    const receipt = receipts.data.bindings[bindingKey] || null;
    if (receipt?.nativeSessionId !== nativeSessionId) return candidates;
    const knownVersions = receipt.knowledgeVersions || {};
    return candidates.filter((unit) => {
      const knownVersion = knownVersions[knowledgeKeyDigest(unit.key)];
      return knownVersion !== knowledgeVersionDigest(unit.version);
    });
  }

  async checkpointBinding({ bindingKey, nativeSessionId, checkpointId, nativeBoundary = {} }) {
    invariant(bindingKey && nativeSessionId && checkpointId, "CONTEXT_CHECKPOINT_INVALID", "Context checkpoint 缺少 Agent binding、原生会话或边界", { status: 400 });
    const repository = this.#receipts();
    let saved = null;
    await updateWithLatestRevision(repository, (data) => {
      const stored = data.bindings[String(bindingKey)] || null;
      invariant(stored?.nativeSessionId === String(nativeSessionId), "CONTEXT_CHECKPOINT_SESSION_MISMATCH", "Context checkpoint 不属于当前原生会话", { status: 409 });
      const receipt = normalizeReceiptForMutation(stored);
      const existing = receipt.checkpoints.find((entry) => String(entry.checkpointId) === String(checkpointId));
      if (existing) {
        const existingBoundarySession = String(existing.nativeBoundary?.sessionId || "");
        const incomingBoundarySession = String(nativeBoundary?.sessionId || "");
        const sameBoundarySession = !existingBoundarySession
          || !incomingBoundarySession
          || existingBoundarySession === incomingBoundarySession;
        existing.nativeBoundary = {
          ...(existing.nativeBoundary || {}),
          ...(!existing.nativeBoundary?.protocol && nativeBoundary?.protocol ? { protocol: String(nativeBoundary.protocol) } : {}),
          ...(!existing.nativeBoundary?.sessionId && nativeBoundary?.sessionId ? { sessionId: String(nativeBoundary.sessionId) } : {}),
          ...(sameBoundarySession && nativeBoundary?.turnId ? { turnId: String(nativeBoundary.turnId) } : {}),
          ...(sameBoundarySession && nativeBoundary?.rolloutPath ? { rolloutPath: String(nativeBoundary.rolloutPath) } : {}),
          ...(!existing.nativeBoundary?.skillSnapshot && nativeBoundary?.skillSnapshot ? { skillSnapshot: structuredClone(nativeBoundary.skillSnapshot) } : {}),
        };
        data.bindings[String(bindingKey)] = receipt;
        saved = structuredClone(existing);
        return;
      }
      let previous = receiptSnapshot(receipt.checkpointBase);
      for (const checkpoint of receipt.checkpoints) previous = applyReceiptCheckpoint(previous, checkpoint);
      const sequence = receipt.checkpointSequence + 1;
      const checkpoint = {
        checkpointId: String(checkpointId),
        sequence,
        ...receiptCheckpointDelta(previous, receipt),
        nativeBoundary: {
          ...(nativeBoundary?.protocol ? { protocol: String(nativeBoundary.protocol) } : {}),
          ...(nativeBoundary?.sessionId ? { sessionId: String(nativeBoundary.sessionId) } : {}),
          ...(nativeBoundary?.turnId ? { turnId: String(nativeBoundary.turnId) } : {}),
          ...(nativeBoundary?.rolloutPath ? { rolloutPath: String(nativeBoundary.rolloutPath) } : {}),
          ...(nativeBoundary?.skillSnapshot ? { skillSnapshot: structuredClone(nativeBoundary.skillSnapshot) } : {}),
        },
        createdAt: new Date().toISOString(),
      };
      receipt.checkpoints.push(checkpoint);
      while (receipt.checkpoints.length > MAX_RECEIPT_CHECKPOINTS) {
        receipt.checkpointBase = applyReceiptCheckpoint(receipt.checkpointBase, receipt.checkpoints.shift());
      }
      receipt.checkpointSequence = sequence;
      data.bindings[String(bindingKey)] = receipt;
      saved = structuredClone(checkpoint);
    });
    return saved;
  }

  async getBindingCheckpoint({ bindingKey, nativeSessionId, checkpointId }) {
    invariant(bindingKey && nativeSessionId && checkpointId, "CONTEXT_CHECKPOINT_INVALID", "Context checkpoint 缺少 Agent binding、原生会话或边界", { status: 400 });
    const state = await this.#receipts().read();
    const stored = state.data.bindings[String(bindingKey)] || null;
    if (stored?.nativeSessionId !== String(nativeSessionId)) return null;
    const receipt = normalizeReceiptForMutation(stored);
    const checkpoint = receipt.checkpoints.find((entry) => String(entry.checkpointId) === String(checkpointId));
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async listBindingCheckpointIds({ bindingKey, nativeSessionId }) {
    invariant(bindingKey && nativeSessionId, "CONTEXT_CHECKPOINT_INVALID", "读取 Context checkpoint 缺少 Agent binding 或原生会话", { status: 400 });
    const state = await this.#receipts().read();
    const stored = state.data.bindings[String(bindingKey)] || null;
    if (stored?.nativeSessionId !== String(nativeSessionId)) return [];
    return normalizeReceiptForMutation(stored).checkpoints.map((entry) => String(entry.checkpointId));
  }

  async restoreBindingCheckpoint({ bindingKey, nativeSessionId, checkpointId = null }) {
    invariant(bindingKey && nativeSessionId, "CONTEXT_CHECKPOINT_INVALID", "恢复 Context checkpoint 缺少 Agent binding 或原生会话", { status: 400 });
    const repository = this.#receipts();
    let restored = null;
    await updateWithLatestRevision(repository, (data) => {
      const stored = data.bindings[String(bindingKey)] || null;
      invariant(stored?.nativeSessionId === String(nativeSessionId), "CONTEXT_CHECKPOINT_SESSION_MISMATCH", "Context checkpoint 不属于当前原生会话", { status: 409 });
      const receipt = normalizeReceiptForMutation(stored);
      const selected = checkpointId === null
        ? { receipt, snapshot: receiptSnapshot(receipt.checkpointBase), checkpoints: [], selected: null }
        : checkpointPrefix(receipt, checkpointId);
      invariant(checkpointId === null || selected.selected, "CONTEXT_CHECKPOINT_NOT_FOUND", "Context checkpoint 不存在", { status: 409 });
      data.bindings[String(bindingKey)] = {
        ...selected.receipt,
        ...selected.snapshot,
        nativeSessionId: String(nativeSessionId),
        checkpoints: selected.checkpoints,
        restoredAt: new Date().toISOString(),
      };
      restored = {
        checkpointId: checkpointId === null ? null : String(checkpointId),
        nativeBoundary: selected.selected?.nativeBoundary ? structuredClone(selected.selected.nativeBoundary) : null,
      };
    });
    return { bindingKey: String(bindingKey), nativeSessionId: String(nativeSessionId), ...restored };
  }

  async forkBindingCheckpoint({
    sourceBindingKey,
    sourceNativeSessionId,
    targetBindingKey,
    targetNativeSessionId,
    checkpointId,
    inheritedUnits = [],
    nativeBoundaryMap = null,
    targetNativeBoundary = null,
  }) {
    invariant(sourceBindingKey && sourceNativeSessionId && targetBindingKey && targetNativeSessionId && checkpointId,
      "CONTEXT_CHECKPOINT_INVALID", "分支 Context checkpoint 参数不完整", { status: 400 });
    const repository = this.#receipts();
    let forked = null;
    await updateWithLatestRevision(repository, (data) => {
      const sourceStored = data.bindings[String(sourceBindingKey)] || null;
      invariant(sourceStored?.nativeSessionId === String(sourceNativeSessionId), "CONTEXT_CHECKPOINT_SESSION_MISMATCH", "来源 Context checkpoint 不属于当前原生会话", { status: 409 });
      const selected = checkpointPrefix(sourceStored, checkpointId);
      invariant(selected.selected, "CONTEXT_CHECKPOINT_NOT_FOUND", "来源 Context checkpoint 不存在", { status: 409 });
      // A webpage branch clones the retained messages with fresh message IDs,
      // while a native Agent fork inherits the exact same transcript. Record
      // those target-side identities at the fork boundary as aliases of the
      // inherited transcript; otherwise the first turn on the new webpage
      // branch would resend the whole prefix merely because its IDs changed.
      const inherited = (Array.isArray(inheritedUnits) ? inheritedUnits : [])
        .map(normalizeKnowledgeUnit)
        .filter(Boolean);
      const inheritedCheckpoint = {
        contentDigests: [...new Set(inherited.map((unit) => unit.content).filter(Boolean).map(semanticContentDigest))],
        knowledgeVersions: updateKnowledgeVersions(emptyReceiptSnapshot(), inherited),
      };
      const targetCheckpoints = structuredClone(selected.checkpoints);
      const turnMap = nativeBoundaryMap && typeof nativeBoundaryMap === "object" && !Array.isArray(nativeBoundaryMap)
        ? Object.fromEntries(Object.entries(nativeBoundaryMap).map(([source, target]) => [String(source), String(target)]))
        : null;
      const boundaryOverride = targetNativeBoundary && typeof targetNativeBoundary === "object" && !Array.isArray(targetNativeBoundary)
        ? targetNativeBoundary
        : {};
      for (const checkpoint of targetCheckpoints) {
        const boundary = checkpoint?.nativeBoundary;
        if (!boundary || String(boundary.sessionId || sourceNativeSessionId) !== String(sourceNativeSessionId)) continue;
        const sourceTurnId = String(boundary.turnId || "");
        const mappedTurnId = sourceTurnId && turnMap ? turnMap[sourceTurnId] : null;
        // Codex and Claude keep inherited turn identifiers. OpenCode clones
        // each message with a new id, supplied through nativeBoundaryMap.
        // Never pair an unmapped source id with the child session.
        if (turnMap && sourceTurnId && !mappedTurnId) continue;
        checkpoint.nativeBoundary = {
          ...boundary,
          ...(boundaryOverride.protocol ? { protocol: String(boundaryOverride.protocol) } : {}),
          sessionId: String(targetNativeSessionId),
          ...(mappedTurnId ? { turnId: mappedTurnId } : {}),
          ...(boundaryOverride.rolloutPath ? { rolloutPath: String(boundaryOverride.rolloutPath) } : {}),
        };
      }
      const targetBoundary = targetCheckpoints.find((entry) => String(entry.checkpointId) === String(checkpointId));
      if (targetBoundary && inherited.length) {
        targetBoundary.contentDigests = [...new Set([
          ...(Array.isArray(targetBoundary.contentDigests) ? targetBoundary.contentDigests.map(String) : []),
          ...inheritedCheckpoint.contentDigests,
        ])].slice(-MAX_RECEIPT_ITEMS);
        targetBoundary.knowledgeVersions = Object.fromEntries(Object.entries({
          ...(targetBoundary.knowledgeVersions || {}),
          ...inheritedCheckpoint.knowledgeVersions,
        }).slice(-MAX_RECEIPT_ITEMS));
      }
      const targetSnapshot = applyReceiptCheckpoint(selected.snapshot, inheritedCheckpoint);
      data.bindings[String(targetBindingKey)] = {
        ...targetSnapshot,
        nativeSessionId: String(targetNativeSessionId),
        checkpointBase: receiptSnapshot(selected.receipt.checkpointBase),
        checkpoints: targetCheckpoints,
        checkpointSequence: selected.receipt.checkpointSequence,
        acknowledgedAt: new Date().toISOString(),
        forkedFrom: {
          bindingKey: String(sourceBindingKey),
          nativeSessionId: String(sourceNativeSessionId),
          checkpointId: String(checkpointId),
        },
      };
      forked = structuredClone(targetBoundary || selected.selected);
    });
    return {
      sourceBindingKey: String(sourceBindingKey),
      targetBindingKey: String(targetBindingKey),
      nativeSessionId: String(targetNativeSessionId),
      checkpoint: forked,
    };
  }

  async stageKnowledge({ bindingKey, taskId, units }) {
    invariant(bindingKey && taskId, "CONTEXT_PENDING_KNOWLEDGE_INVALID", "待确认上下文缺少 Agent binding 或 Task", { status: 400 });
    const normalized = (Array.isArray(units) ? units : []).map(normalizeKnowledgeUnit).filter(Boolean);
    if (!normalized.length) return { taskId, staged: 0 };
    const repository = this.#receipts();
    await updateWithLatestRevision(repository, (data) => {
      data.pending ||= {};
      const existing = data.pending[String(taskId)] || null;
      data.pending[String(taskId)] = {
        bindingKey: String(bindingKey),
        units: normalized,
        deliveredUnits: existing?.bindingKey === String(bindingKey) && Array.isArray(existing.deliveredUnits)
          ? existing.deliveredUnits
          : null,
        stagedAt: new Date().toISOString(),
      };
      const keys = Object.keys(data.pending);
      for (const stale of keys.slice(0, Math.max(0, keys.length - 10_000))) delete data.pending[stale];
    });
    return { taskId, staged: normalized.length };
  }

  async stageDeliveredKnowledge({ bindingKey, taskId, delivery }) {
    invariant(bindingKey && taskId, "CONTEXT_PENDING_KNOWLEDGE_INVALID", "待确认上下文缺少 Agent binding 或 Task", { status: 400 });
    validateContextDelivery(delivery);
    const delivered = new Set(deliveryKnowledgeUnits(delivery).map((unit) => `${unit.key}\0${unit.version}`));
    const repository = this.#receipts();
    let staged = 0;
    await updateWithLatestRevision(repository, (data) => {
      data.pending ||= {};
      const pending = data.pending[String(taskId)] || null;
      if (pending?.bindingKey !== String(bindingKey)) {
        staged = 0;
        return;
      }
      const units = (Array.isArray(pending.units) ? pending.units : [])
        .map(normalizeKnowledgeUnit)
        .filter(Boolean)
        .filter((unit) => delivered.has(`${unit.key}\0${unit.version}`));
      staged = units.length;
      data.pending[String(taskId)] = {
        ...pending,
        deliveredUnits: units,
        deliveryId: delivery.id,
      };
    });
    return { taskId, deliveryId: delivery.id, staged };
  }

  async acknowledgeStagedKnowledge({ bindingKey, nativeSessionId, taskId, units = [] }) {
    invariant(bindingKey && nativeSessionId && taskId, "CONTEXT_PENDING_KNOWLEDGE_INVALID", "待确认上下文缺少 Agent binding、原生会话或 Task", { status: 400 });
    const repository = this.#receipts();
    const state = await repository.read();
    const pending = state.data.pending?.[String(taskId)] || null;
    const staged = pending?.bindingKey === String(bindingKey) && Array.isArray(pending.deliveredUnits)
      ? pending.deliveredUnits
      : [];
    const combined = [...staged, ...(Array.isArray(units) ? units : [])];
    if (combined.length) await this.acknowledgeKnowledge({ bindingKey, nativeSessionId, units: combined });
    for (;;) {
      const current = await repository.read();
      if (!current.data.pending?.[String(taskId)]) break;
      try {
        await repository.update((data) => {
          if (data.pending?.[String(taskId)]?.bindingKey === String(bindingKey)) delete data.pending[String(taskId)];
        }, { expectedRevision: current.revision });
        break;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
    return { taskId, acknowledged: combined.length };
  }

  async discardStagedKnowledge(taskId) {
    const id = String(taskId || "");
    if (!id) return { taskId: id, discarded: false };
    const repository = this.#receipts();
    for (;;) {
      const current = await repository.read();
      if (!current.data.pending?.[id]) return { taskId: id, discarded: false };
      try {
        await repository.update((data) => { if (data.pending) delete data.pending[id]; }, { expectedRevision: current.revision });
        return { taskId: id, discarded: true };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async forgetConversation({ conversationId, bindingKeys = [], taskIds = [] }) {
    const id = String(conversationId || "");
    invariant(id, "CONTEXT_CONVERSATION_REQUIRED", "清理上下文时缺少 conversationId", { status: 500, expose: false });
    const bindings = new Set((Array.isArray(bindingKeys) ? bindingKeys : []).map(String).filter(Boolean));
    const tasks = new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter(Boolean));

    let removedSessions = 0;
    const sessions = this.#sessions();
    for (;;) {
      const current = await sessions.read();
      const sessionIds = Object.values(current.data.sessions)
        .filter((session) => session?.scope?.conversationId === id)
        .map((session) => session.id);
      if (!sessionIds.length) break;
      try {
        await sessions.update((data) => {
          for (const sessionId of sessionIds) {
            delete data.sessions[sessionId];
            delete data.deliveries[sessionId];
          }
        }, { expectedRevision: current.revision });
        removedSessions += sessionIds.length;
        break;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }

    let removedReceipts = 0;
    let removedPending = 0;
    const receipts = this.#receipts();
    for (;;) {
      const current = await receipts.read();
      const receiptKeys = [...bindings].filter((key) => current.data.bindings[key]);
      const pendingKeys = Object.entries(current.data.pending || {})
        .filter(([taskId, value]) => tasks.has(taskId) || bindings.has(String(value?.bindingKey || "")))
        .map(([taskId]) => taskId);
      if (!receiptKeys.length && !pendingKeys.length) break;
      try {
        await receipts.update((data) => {
          for (const key of receiptKeys) delete data.bindings[key];
          for (const taskId of pendingKeys) if (data.pending) delete data.pending[taskId];
        }, { expectedRevision: current.revision });
        removedReceipts += receiptKeys.length;
        removedPending += pendingKeys.length;
        break;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
    return { conversationId: id, removedSessions, removedReceipts, removedPending };
  }

  async markStale(sessionId) {
    const repository = this.#sessions();
    const state = await repository.read();
    const current = state.data.sessions[sessionId];
    invariant(current, "CONTEXT_SESSION_NOT_FOUND", "ContextSession 不存在", { status: 404 });
    const next = transitionContextSession(current, "stale", { expectedRevision: current.revision });
    await repository.update((data) => { data.sessions[sessionId] = next; }, { expectedRevision: state.revision });
    return next;
  }
}

export { defaultTokenEstimate, selectWithinBudget };
