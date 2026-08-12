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

function normalizeEntry(value, sourceName, tokenEstimator) {
  const contentValue = typeof value?.content === "string"
    ? value.content
    : JSON.stringify(value?.content ?? value?.value ?? "");
  const source = value?.source && typeof value.source === "object"
    ? value.source
    : { type: sourceName, id: String(value?.id || createId("source")), version: String(value?.version || "1") };
  const content = {
    format: ["text", "json", "reference"].includes(value?.format) ? value.format : (typeof value?.content === "string" ? "text" : "json"),
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
    if (used + entry.tokenEstimate > available) {
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
      defaultData: () => ({ bindings: {} }),
      validate: (data) => Boolean(data && typeof data === "object" && !Array.isArray(data) && data.bindings && typeof data.bindings === "object"),
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
        candidates.push(normalizeEntry(value, name, this.tokenEstimator));
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

  async deliveryForBinding(bindingKey, delivery) {
    validateContextDelivery(delivery);
    const receipts = await this.#receipts().read();
    const known = new Set(receipts.data.bindings[bindingKey]?.entryDigests || []);
    const entries = delivery.entries.filter((entry) => !known.has(entry.digest));
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

  async acknowledge({ bindingKey, nativeSessionId, delivery }) {
    validateContextDelivery(delivery);
    invariant(bindingKey && nativeSessionId, "CONTEXT_RECEIPT_INVALID", "Context receipt 缺少 Agent binding", { status: 400 });
    const repository = this.#receipts();
    const current = await repository.read();
    const acknowledgedAt = new Date().toISOString();
    await repository.update((data) => {
      const previous = data.bindings[bindingKey] || { entryDigests: [], lastDeliveryId: null, lastSequence: 0 };
      data.bindings[bindingKey] = {
        nativeSessionId,
        entryDigests: [...new Set([...previous.entryDigests, ...delivery.entries.map((entry) => entry.digest)])].slice(-50_000),
        lastDeliveryId: delivery.id,
        lastSequence: Math.max(previous.lastSequence || 0, delivery.sequence),
        acknowledgedAt,
      };
    }, { expectedRevision: current.revision });
    return { bindingKey, deliveryId: delivery.id, acknowledgedAt };
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
