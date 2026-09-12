import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

const MAX_STORED_OBSERVATIONS_PER_BRANCH = 4_096;
const MAX_CONTEXT_CHARACTERS = 120_000;

const digest = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function fragmentIdentity(fragment) {
  const key = String(fragment?.knowledge?.key || "").trim();
  const version = String(fragment?.knowledge?.version || "").trim();
  if (key && version) return `knowledge\0${key}\0${version}`;
  const rendered = String(fragment?.rendered || "").replace(/\r\n/g, "\n").trim();
  return rendered ? `content\0${digest(rendered)}` : "";
}

export function webAgentCandidateId(fragment) {
  const identity = fragmentIdentity(fragment);
  return identity ? `candidate_${digest(identity).slice(0, 24)}` : "";
}

function normalizeFragment(value) {
  const identity = fragmentIdentity(value);
  if (!identity) return null;
  const rendered = String(value?.rendered || "").replace(/\r\n/g, "\n").trim();
  const content = String(value?.knowledge?.content || "").replace(/\r\n/g, "\n").trim();
  if (!rendered && !content) return null;
  const key = String(value?.knowledge?.key || "").trim();
  const version = String(value?.knowledge?.version || "").trim();
  const kind = String(value?.reference?.kind || "").trim();
  const name = String(value?.reference?.name || "").trim();
  return {
    candidateId: webAgentCandidateId(value),
    toolName: String(value?.toolName || "").trim(),
    rendered,
    presented: value?.presented && typeof value.presented === "object" && !Array.isArray(value.presented)
      ? clone(value.presented)
      : {},
    ...(key && version ? { knowledge: { key, version, content } } : {}),
    ...(kind && name ? { reference: { kind, name } } : {}),
    priority: Number.isFinite(Number(value?.priority)) ? Number(value.priority) : 0,
    required: Boolean(value?.required),
  };
}

function validFragment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.candidateId !== "string" || typeof value.rendered !== "string" || typeof value.toolName !== "string") return false;
  if (!value.presented || typeof value.presented !== "object" || Array.isArray(value.presented)) return false;
  if (!Number.isFinite(value.priority) || typeof value.required !== "boolean") return false;
  if (value.knowledge && (!value.knowledge.key || !value.knowledge.version || typeof value.knowledge.content !== "string")) return false;
  return true;
}

function validObservation(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof value.identity === "string" && value.identity
    && typeof value.sourceMessageId === "string" && value.sourceMessageId
    && typeof value.observedAt === "string" && value.observedAt
    && typeof value.lastObservedAt === "string" && value.lastObservedAt
    && validFragment(value.fragment));
}

function validLedger(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.branches || typeof data.branches !== "object" || Array.isArray(data.branches)) return false;
  return Object.values(data.branches).every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    && Array.isArray(entry.observations) && entry.observations.every(validObservation));
}

async function updateLatest(repository, updater, clock) {
  for (;;) {
    const current = await repository.read();
    try {
      return await repository.update(updater, { expectedRevision: current.revision, clock });
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT") throw error;
    }
  }
}

function activeObservations(observations, sourceMessageIds = null) {
  const positions = sourceMessageIds
    ? new Map(sourceMessageIds.map((messageId, index) => [String(messageId), index]))
    : null;
  const eligible = (Array.isArray(observations) ? observations : [])
    .filter((entry) => !positions || positions.has(entry.sourceMessageId))
    .map((entry, storageIndex) => ({
      ...entry,
      position: positions ? positions.get(entry.sourceMessageId) : storageIndex,
      storageIndex,
    }))
    .sort((left, right) => left.position - right.position || left.storageIndex - right.storageIndex);

  // A stable source key can acquire a new immutable version. Keep the older
  // observation in storage for rewind, but expose only the latest version that
  // exists on the selected message chain.
  const latestByKnowledgeKey = new Map();
  const contentOnly = [];
  for (const entry of eligible) {
    const key = String(entry.fragment?.knowledge?.key || "").trim();
    if (key) latestByKnowledgeKey.set(key, entry);
    else contentOnly.push(entry);
  }
  return [...contentOnly, ...latestByKnowledgeKey.values()]
    .sort((left, right) => left.position - right.position || left.storageIndex - right.storageIndex)
    .map((entry) => clone(entry.fragment));
}

export class WebAgentObservationLedger {
  constructor({ dataRoot, actor, queue, clock = () => new Date() }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
  }

  #repository(conversationId) {
    const id = String(conversationId || "");
    invariant(id, "WEB_OBSERVATION_CONVERSATION_REQUIRED", "网页已读账本缺少 conversationId", { status: 500, expose: false });
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["context", "conversations", id, "observations.json"],
      schemaVersion: 1,
      defaultData: () => ({ branches: {} }),
      validate: validLedger,
      queue: this.queue,
    });
  }

  async list({ conversationId, branchId, sourceMessageIds = null }) {
    const branch = String(branchId || "");
    invariant(branch, "WEB_OBSERVATION_BRANCH_REQUIRED", "网页已读账本缺少 branchId", { status: 500, expose: false });
    const state = await this.#repository(conversationId).read();
    return activeObservations(state.data.branches[branch]?.observations || [], sourceMessageIds?.map(String));
  }

  async record({ conversationId, branchId, sourceMessageId, fragments }) {
    const branch = String(branchId || "");
    const messageId = String(sourceMessageId || "");
    invariant(branch && messageId, "WEB_OBSERVATION_BOUNDARY_REQUIRED", "网页已读知识缺少分支或消息边界", { status: 500, expose: false });
    const normalized = (Array.isArray(fragments) ? fragments : []).map(normalizeFragment).filter((entry) => entry?.knowledge?.key && entry?.knowledge?.version);
    if (!normalized.length) return { recorded: 0 };
    const repository = this.#repository(conversationId);
    let recorded = 0;
    await updateLatest(repository, (data) => {
      const observations = [...(data.branches[branch]?.observations || [])];
      const now = this.clock().toISOString();
      for (const fragment of normalized) {
        const identity = fragmentIdentity(fragment);
        const existing = observations.find((entry) => entry.identity === identity);
        if (existing) {
          existing.lastObservedAt = now;
          if (fragment.priority > existing.fragment.priority || fragment.required && !existing.fragment.required) {
            existing.fragment = { ...fragment, required: existing.fragment.required || fragment.required };
          }
          continue;
        }
        observations.push({ identity, sourceMessageId: messageId, observedAt: now, lastObservedAt: now, fragment });
        recorded += 1;
      }
      data.branches[branch] = {
        observations: observations.slice(-MAX_STORED_OBSERVATIONS_PER_BRANCH),
      };
    }, this.clock);
    return { recorded };
  }

  async invalidate({ conversationId, branchId, removedMessageIds }) {
    const removed = new Set((Array.isArray(removedMessageIds) ? removedMessageIds : []).map(String).filter(Boolean));
    if (!removed.size) return { invalidated: 0 };
    const branch = String(branchId || "");
    const repository = this.#repository(conversationId);
    let invalidated = 0;
    await updateLatest(repository, (data) => {
      const current = data.branches[branch]?.observations || [];
      const retained = current.filter((entry) => !removed.has(entry.sourceMessageId));
      invalidated = current.length - retained.length;
      data.branches[branch] = { observations: retained };
    }, this.clock);
    return { invalidated };
  }

  async fork({ sourceConversationId, sourceBranchId, targetConversationId, targetBranchId, messageIdMap }) {
    const mapping = messageIdMap instanceof Map
      ? messageIdMap
      : new Map(Object.entries(messageIdMap || {}).map(([source, target]) => [String(source), String(target)]));
    const source = await this.#repository(sourceConversationId).read();
    const copied = (source.data.branches[String(sourceBranchId)]?.observations || []).flatMap((entry) => {
      const targetMessageId = mapping.get(entry.sourceMessageId);
      return targetMessageId ? [{ ...clone(entry), sourceMessageId: targetMessageId }] : [];
    });
    const repository = this.#repository(targetConversationId);
    await updateLatest(repository, (data) => {
      data.branches[String(targetBranchId)] = { observations: copied.slice(-MAX_STORED_OBSERVATIONS_PER_BRANCH) };
    }, this.clock);
    return { copied: copied.length };
  }

  async forget(conversationId) {
    const repository = this.#repository(conversationId);
    for (;;) {
      const current = await repository.read();
      try {
        await repository.replace({ branches: {} }, { expectedRevision: current.revision, clock: this.clock });
        return { conversationId: String(conversationId), cleared: true };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }
}

export async function renderWebAgentObservations(fragments, mode, prompts, maxCharacters = MAX_CONTEXT_CHARACTERS) {
  const normalized = (Array.isArray(fragments) ? fragments : []).map(normalizeFragment).filter(Boolean);
  if (!normalized.length) return "";
  invariant(prompts && typeof prompts.webToolResult === "function", "WEB_OBSERVATION_PROMPTS_REQUIRED", "网页已读知识缺少 Prompt Repository", { status: 500, expose: false });
  const [defaultKind, defaultName, presentation] = await Promise.all([
    prompts.webToolResult("observationDefaultKind"),
    prompts.webToolResult("observationDefaultName"),
    prompts.webToolPresentation(),
  ]);
  const blocks = await Promise.all(normalized.map(async (fragment) => {
    const candidate = mode === "work"
      ? await prompts.webToolResult("observationCandidate", { CANDIDATE_ID: fragment.candidateId })
      : "";
    const content = String(fragment?.knowledge?.content || fragment.rendered || "").trim();
    if (fragment.toolName === "memory_catalog") {
      return (await prompts.webToolResult("observationMemoryItem", {
        CANDIDATE: candidate,
        CONTENT: content,
      })).trim();
    }
    return (await prompts.webToolResult("observationItem", {
      CANDIDATE: candidate,
      KIND: String(fragment?.reference?.kind || defaultKind).trim() || defaultKind,
      NAME: String(fragment?.reference?.name || fragment?.knowledge?.key || defaultName).trim() || defaultName,
      CONTENT: content,
    })).trim();
  }));
  const heading = await prompts.webToolResult(mode === "work" ? "observationWorkHeading" : "observationChatHeading");
  const total = heading.length + blocks.reduce((sum, block) => sum + block.length + presentation.sectionSeparator.length, 0);
  invariant(total <= maxCharacters, "WEB_CONTEXT_TOO_LARGE", "当前可见知识超过网页 Agent 上下文容量，请缩小授权范围后重试", { status: 413 });
  return `${heading}${presentation.sectionSeparator}${blocks.join(presentation.sectionSeparator)}`;
}

export { fragmentIdentity as webAgentFragmentIdentity, normalizeFragment as normalizeWebAgentFragment };
