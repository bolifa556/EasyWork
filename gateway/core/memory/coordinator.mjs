import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { durableMemoryCandidate } from "./policy.mjs";

// EasyWork has three memory layers: account-wide memory shared between Web
// conversations, project memory, and the current Web conversation's memory.
// Workspace and remote Task identity belong to routing/versioning and must not
// become semantic-memory scopes merely because two projects share a cwd.
const LEVELS = Object.freeze(["user", "project", "conversation"]);
const LEVEL_SET = new Set(LEVELS);
const TOOL_LEVEL = Object.freeze(Object.fromEntries(LEVELS.map((level) => [`remember_${level}`, level])));
const PORTABILITY = Object.freeze({
  user: "universal",
  project: "project-bound",
  conversation: "universal",
});

function normalizedSemanticKey(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedObservedKnowledge(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const knowledge = value?.knowledge && typeof value.knowledge === "object" ? value.knowledge : value;
    const content = String(knowledge?.content || "").trim();
    if (!content) return [];
    const key = String(knowledge?.key || "").trim().slice(0, 1_024);
    const version = String(knowledge?.version || "").trim().slice(0, 1_024);
    const identity = `${key}\0${version}\0${content}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ ...(key ? { key } : {}), ...(version ? { version } : {}), content: content.slice(0, 48_000) }];
  }).slice(0, 128);
}

export function parseMemoryToolCalls(value, available = LEVELS) {
  const allowed = new Set((Array.isArray(available) ? available : []).filter((level) => LEVEL_SET.has(level)));
  return (Array.isArray(value) ? value : []).flatMap((call) => {
    const level = TOOL_LEVEL[String(call?.name || "")];
    const input = call?.input;
    if (!level || !allowed.has(level) || !input || typeof input !== "object" || Array.isArray(input)) return [];
    if (!Object.keys(input).every((key) => ["subject", "content", "kind", "evidence"].includes(key))) return [];
    const semanticKey = normalizedSemanticKey(input.subject);
    const content = String(input.content || "").trim();
    if (!semanticKey || semanticKey.length > 512 || !content || content.length > 20_000) return [];
    if (input.kind !== undefined && !["user-preference", "observed-fact"].includes(input.kind)) return [];
    if (input.evidence !== undefined && (!input.evidence || !["user", "assistant"].includes(input.evidence.role)
      || typeof input.evidence.quote !== "string" || !input.evidence.quote.trim()
      || Object.keys(input.evidence).some((key) => !["role", "quote"].includes(key)))) return [];
    return [{ level, semanticKey, content, ...(input.kind ? { kind: input.kind } : {}), ...(input.evidence ? { evidence: structuredClone(input.evidence) } : {}) }];
  });
}

function scopeId(scope, level) {
  if (level === "user") return scope.actorId;
  if (level === "project") return scope.projectId;
  if (level === "conversation") return scope.conversationId;
  return null;
}

function availableLevels(scope) {
  return LEVELS.filter((level) => {
    if (level === "user" && scope.memoryMode !== "global") return false;
    return Boolean(scopeId(scope, level));
  });
}

const branchKey = (conversationId, branchId) => `${String(conversationId)}:${String(branchId)}`;

function branchFamily(branches, conversationId, branchId) {
  const graph = new Map();
  const connect = (left, right) => {
    if (!graph.has(left)) graph.set(left, new Set());
    if (!graph.has(right)) graph.set(right, new Set());
    graph.get(left).add(right);
    graph.get(right).add(left);
  };
  for (const descriptor of Object.values(branches || {})) {
    connect(
      branchKey(descriptor.sourceConversationId, descriptor.sourceBranchId),
      branchKey(descriptor.conversationId, descriptor.branchId),
    );
  }
  const start = branchKey(conversationId, branchId);
  const family = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const adjacent of graph.get(current) || []) {
      if (family.has(adjacent)) continue;
      family.add(adjacent);
      queue.push(adjacent);
    }
  }
  return family;
}

export class MemoryCoordinator {
  #inflight = new Map();

  constructor({ memory, extractor, dataRoot = null, actor = null, queue = null, clock = () => new Date() }) {
    invariant(memory && typeof memory.append === "function" && typeof memory.find === "function" && typeof memory.snapshot === "function" && typeof memory.select === "function", "MEMORY_COORDINATOR_INVALID", "MemoryCoordinator 缺少 Memory service", { status: 500, expose: false });
    invariant(typeof extractor === "function", "MEMORY_EXTRACTOR_INVALID", "MemoryCoordinator 缺少候选提取器", { status: 500, expose: false });
    this.memory = memory;
    this.extractor = extractor;
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
  }

  #repository() {
    invariant(this.dataRoot && this.actor, "MEMORY_COORDINATOR_STORE_UNAVAILABLE", "MemoryCoordinator 没有持久化运行目录", { status: 500, expose: false });
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["memory", "coordinator.json"],
      schemaVersion: 2,
      defaultData: () => ({ completed: {}, tasks: {}, branches: {}, deletions: {} }),
      validate: (data) => Boolean(data && typeof data === "object" && !Array.isArray(data)
        && data.completed && typeof data.completed === "object" && !Array.isArray(data.completed)
        && data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
        && data.branches && typeof data.branches === "object" && !Array.isArray(data.branches)
        && data.deletions && typeof data.deletions === "object" && !Array.isArray(data.deletions)),
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

  async freezeScope(scope) {
    const canonicalScope = { ...scope, memoryBaselineSequence: null, memorySnapshotSequence: 0, memorySnapshotVersionIds: [] };
    const live = await this.memory.snapshot(canonicalScope);
    const ledger = await this.#repository().read();
    const currentBranchKey = branchKey(scope.conversationId, scope.branchId);
    const branch = ledger.data.branches[currentBranchKey] || null;
    if (!branch) {
      return Object.freeze({
        ...scope,
        memoryBaselineSequence: null,
        memorySnapshotSequence: live.sequence,
        memorySnapshotVersionIds: Object.freeze([...live.versionIds]),
      });
    }

    const baseline = await this.memory.snapshot(canonicalScope, {
      asOfSequence: branch.memorySequence,
      versionIds: [],
    });
    const allowed = new Set(baseline.versionIds);
    const family = branchFamily(ledger.data.branches, scope.conversationId, scope.branchId);
    for (const completed of Object.values(ledger.data.completed)) {
      const origin = completed?.origin;
      if (!origin || Number(completed.memorySequence || 0) <= branch.memorySequence) continue;
      const originBranchKey = branchKey(origin.conversationId, origin.branchId);
      // Branch relatives share the exact pre-fork snapshot, then advance only
      // from their own turns. Independent conversations still contribute
      // project memory according to the normal scope rules.
      if (family.has(originBranchKey) && originBranchKey !== currentBranchKey) continue;
      for (const versionId of completed.result?.memoryVersionIds || []) allowed.add(String(versionId));
    }
    const selected = await this.memory.snapshot({
      ...canonicalScope,
      memoryBaselineSequence: branch.memorySequence,
      memorySnapshotSequence: live.sequence,
      memorySnapshotVersionIds: [...allowed],
    }, {
      asOfSequence: live.sequence,
      versionIds: [...allowed],
    });
    return Object.freeze({
      ...scope,
      memoryBaselineSequence: branch.memorySequence,
      memorySnapshotSequence: live.sequence,
      memorySnapshotVersionIds: Object.freeze([...selected.versionIds]),
    });
  }

  async registerBranch({ conversationId, sourceConversationId = conversationId, sourceBranchId, branchId, sourceMessageIds }) {
    const key = `${String(conversationId)}:${String(branchId)}`;
    const sourceKey = branchKey(sourceConversationId, sourceBranchId);
    const included = new Set((sourceMessageIds || []).map(String));
    invariant(conversationId && sourceConversationId && sourceBranchId && branchId && included.size > 0, "MEMORY_BRANCH_DESCRIPTOR_INVALID", "分支记忆边界不完整", { status: 500, expose: false });
    await this.#update((data) => {
      const current = data.branches[key];
      if (current) {
        invariant(current.sourceConversationId === String(sourceConversationId) && current.sourceBranchId === String(sourceBranchId), "MEMORY_BRANCH_DESCRIPTOR_CONFLICT", "分支已绑定其他记忆边界", { status: 409 });
        return;
      }
      const parent = data.branches[sourceKey] || null;
      let memorySequence = Number(parent?.memorySequence || 0);
      for (const completed of Object.values(data.completed)) {
        const origin = completed?.origin;
        if (origin?.conversationId !== String(sourceConversationId) || origin.branchId !== String(sourceBranchId)) continue;
        if (!included.has(String(origin.sourceId || "")) && !included.has(String(origin.parentMessageId || ""))) continue;
        memorySequence = Math.max(memorySequence, Number(completed.memorySequence || 0));
      }
      const createdAt = this.clock().toISOString();
      if (!parent) {
        data.branches[sourceKey] = {
          conversationId: String(sourceConversationId),
          sourceConversationId: String(sourceConversationId),
          sourceBranchId: String(sourceBranchId),
          branchId: String(sourceBranchId),
          memorySequence,
          sourceMessageIds: [...included],
          createdAt,
        };
      }
      const descriptor = {
        conversationId: String(conversationId),
        sourceConversationId: String(sourceConversationId),
        sourceBranchId: String(sourceBranchId),
        branchId: String(branchId),
        memorySequence,
        sourceMessageIds: [...included],
        createdAt,
      };
      data.branches[key] = descriptor;
    });
    return { conversationId: String(conversationId), branchId: String(branchId), registered: true };
  }

  forkConversationScope(input) {
    invariant(typeof this.memory.forkConversationScope === "function", "MEMORY_FORK_UNAVAILABLE", "Memory service 不支持派生对话", { status: 500, expose: false });
    return this.memory.forkConversationScope(input);
  }

  async registerTask({ taskId, scope, providerId, modelId, mode = "work", sourceMessageId, userMessage, observedKnowledge = [] }) {
    const id = String(taskId || "");
    const sourceId = String(sourceMessageId || "");
    const originalUserMessage = String(userMessage || "").trim();
    invariant(id && sourceId && providerId && modelId && originalUserMessage, "MEMORY_TASK_DESCRIPTOR_INVALID", "Task 记忆提取描述不完整", { status: 500, expose: false });
    await this.#update((data) => {
      const descriptor = {
        taskId: id,
        scope: structuredClone(scope),
        providerId: String(providerId),
        modelId: String(modelId),
        mode: String(mode),
        sourceMessageId: sourceId,
        userMessage: originalUserMessage,
        observedKnowledge: normalizedObservedKnowledge(observedKnowledge),
        registeredAt: this.clock().toISOString(),
      };
      const current = data.tasks[id];
      invariant(!current || (
        current.providerId === descriptor.providerId
        && current.modelId === descriptor.modelId
        && current.sourceMessageId === descriptor.sourceMessageId
        && current.userMessage === descriptor.userMessage
      ), "MEMORY_TASK_DESCRIPTOR_CONFLICT", "Task 已绑定其他记忆提取上下文", { status: 409 });
      data.tasks[id] = current || descriptor;
    });
    return { taskId: id, registered: true };
  }

  async taskDescriptor(taskId) {
    const state = await this.#repository().read();
    const descriptor = state.data.tasks[String(taskId || "")];
    return descriptor ? structuredClone(descriptor) : null;
  }

  async invalidateBoundary({ messageIds = [], taskIds = [], reason, source }) {
    const sourceIds = [...new Set([...messageIds, ...taskIds].map(String).filter(Boolean))];
    if (!sourceIds.length) return { invalidated: 0 };
    return this.memory.invalidateSources({ sourceIds, reason, source });
  }

  async forgottenConversationIds() {
    const state = await this.#repository().read();
    return Object.keys(state.data.deletions);
  }

  async excludeConversationEntries(entries, conversationId, branchId = null) {
    if (!Array.isArray(entries) || !entries.length || !conversationId) return entries;
    const state = await this.#repository().read();
    const excludedVersionIds = new Set();
    const branch = branchId == null ? null : state.data.branches[branchKey(conversationId, branchId)] || null;
    const visibleSourceIds = new Set((branch?.sourceMessageIds || []).map(String));
    for (const completed of Object.values(state.data.completed)) {
      const origin = completed?.origin;
      const fromCurrentConversation = origin?.conversationId === String(conversationId);
      const representedByBranchHistory = visibleSourceIds.has(String(origin?.sourceId || ""))
        || visibleSourceIds.has(String(origin?.parentMessageId || ""));
      if (!fromCurrentConversation && !representedByBranchHistory) continue;
      for (const versionId of completed.result?.memoryVersionIds || []) excludedVersionIds.add(String(versionId));
    }
    if (!excludedVersionIds.size) return entries;
    return entries.filter((entry) => !excludedVersionIds.has(String(entry?.id || "")));
  }

  async referenceMemoryVersionIds({ sourceIds = [] } = {}) {
    const visibleSourceIds = new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean));
    if (!visibleSourceIds.size) return [];
    const state = await this.#repository().read();
    const versionIds = new Set();
    for (const completed of Object.values(state.data.completed)) {
      const origin = completed?.origin;
      if (!origin) continue;
      if (!visibleSourceIds.has(String(origin.sourceId || ""))
        && !visibleSourceIds.has(String(origin.parentMessageId || ""))) continue;
      for (const versionId of completed.result?.memoryVersionIds || []) versionIds.add(String(versionId));
    }
    return [...versionIds];
  }

  async forgetConversation({ conversationId, taskIds = [], sourceIds: explicitSourceIds = [], reason = "deleted conversation", source }) {
    const id = String(conversationId || "");
    invariant(id, "MEMORY_CONVERSATION_ID_REQUIRED", "删除对话记忆时缺少 conversationId", { status: 500, expose: false });
    const before = await this.#repository().read();
    const prior = before.data.deletions?.[id];
    if (prior) return { ...structuredClone(prior), duplicate: true };

    const relatedCompleted = Object.values(before.data.completed).filter((entry) => entry?.origin?.conversationId === id);
    const relatedTaskIds = new Set([
      ...(Array.isArray(taskIds) ? taskIds : []),
      ...relatedCompleted.map((entry) => entry?.origin?.taskId),
      ...Object.values(before.data.tasks)
        .filter((entry) => entry?.scope?.conversationId === id)
        .map((entry) => entry?.taskId),
    ].map(String).filter(Boolean));
    const sourceIds = new Set([
      ...(Array.isArray(explicitSourceIds) ? explicitSourceIds : []),
      ...relatedCompleted.map((entry) => entry?.origin?.sourceId),
      ...relatedTaskIds,
    ].map(String).filter(Boolean));
    const sourceResult = sourceIds.size
      ? await this.memory.invalidateSources({ sourceIds: [...sourceIds], reason, source })
      : { invalidated: 0 };
    const scopeResult = await this.memory.invalidateScopes({
      scopes: [
        { level: "conversation", id },
        ...[...relatedTaskIds].map((taskId) => ({ level: "task", id: taskId })),
      ],
      reason,
      source,
    });
    const result = {
      conversationId: id,
      invalidated: Number(sourceResult.invalidated || 0) + Number(scopeResult.invalidated || 0),
      sourceCount: sourceIds.size,
      taskCount: relatedTaskIds.size,
      completedAt: this.clock().toISOString(),
    };
    await this.#update((data) => {
      for (const [key, entry] of Object.entries(data.completed)) {
        if (entry?.origin?.conversationId === id) delete data.completed[key];
      }
      for (const [key, entry] of Object.entries(data.tasks)) {
        if (entry?.scope?.conversationId === id || relatedTaskIds.has(String(entry?.taskId))) delete data.tasks[key];
      }
      for (const [key, entry] of Object.entries(data.branches)) {
        if (entry?.conversationId === id || key.startsWith(`${id}:`)) delete data.branches[key];
      }
      data.deletions[id] = structuredClone(result);
    });
    return result;
  }

  async recordTaskFinal({ task, assistantMessage, source }) {
    const descriptor = await this.taskDescriptor(task?.id);
    if (!descriptor) return { extracted: 0, stored: [], skipped: "descriptor-unavailable" };
    return this.recordExchange({
      scope: descriptor.scope,
      userMessage: descriptor.userMessage,
      assistantMessage,
      source: source || { type: "remote-task", id: task.id, version: String(task.revision) },
      authority: "agent-observed",
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      mode: descriptor.mode,
      parentMessageId: descriptor.sourceMessageId,
      observedKnowledge: descriptor.observedKnowledge || [],
      dedupeKey: `task:${task.id}`,
    });
  }

  recordExchange(input) {
    const dedupeKey = String(input.dedupeKey || `${input.source?.type || "conversation"}:${input.source?.id || ""}`);
    const active = this.#inflight.get(dedupeKey);
    if (active) return active;
    const promise = this.#recordExchange({ ...input, dedupeKey });
    this.#inflight.set(dedupeKey, promise);
    promise.finally(() => {
      if (this.#inflight.get(dedupeKey) === promise) this.#inflight.delete(dedupeKey);
    }).catch(() => undefined);
    return promise;
  }

  async #recordExchange({ scope, userMessage, assistantMessage, source, authority = "model-inferred", providerId, modelId, mode = "chat", parentMessageId = null, observedKnowledge = [], dedupeKey }) {
    const before = await this.#repository().read();
    if (before.data.completed[dedupeKey]) return { ...structuredClone(before.data.completed[dedupeKey].result), duplicate: true };
    const levels = availableLevels(scope);
    if (!levels.length) return { extracted: 0, stored: [] };
    const output = await this.extractor({
      providerId: String(providerId || ""),
      modelId: String(modelId || ""),
      mode,
      input: {
        availableLevels: levels,
        userMessage: String(userMessage || ""),
        assistantMessage: String(assistantMessage || ""),
      },
    });
    const knowledgeEvidence = normalizedObservedKnowledge(observedKnowledge);
    const candidates = parseMemoryToolCalls(output, levels)
      .filter((candidate) => durableMemoryCandidate(candidate, { userMessage, assistantMessage, observedKnowledge: knowledgeEvidence, mode }));
    const stored = [];
    const memoryVersionIds = [];
    for (const candidate of candidates) {
      if (!levels.includes(candidate.level)) continue;
      const memoryScope = { level: candidate.level, id: scopeId(scope, candidate.level) };
      for (;;) {
        const existing = await this.memory.find({ scope: memoryScope, semanticKey: candidate.semanticKey });
        const latest = existing?.versions?.at(-1);
        // Identical semantic content is already durable. A new message source
        // must not create a no-op version that is then retrieved as a second
        // copy on a later turn.
        if (latest?.content === candidate.content) {
          memoryVersionIds.push(latest.id);
          break;
        }
        try {
          const result = await this.memory.append({
            scope: memoryScope,
            semanticKey: candidate.semanticKey,
            content: candidate.content,
            authority,
            confidence: 0.9,
            sensitivity: "private",
            portability: PORTABILITY[candidate.level],
            source: {
              type: String(source?.type || "conversation-message"),
              id: String(source?.id || scope.conversationId),
              version: String(source?.version || this.clock().toISOString()),
            },
            ...(existing ? { expectedRevision: existing.revision } : {}),
          });
          stored.push(result);
          memoryVersionIds.push(result.version.id);
          break;
        } catch (error) {
          if (!["MEMORY_REVISION_CONFLICT", "REVISION_CONFLICT"].includes(error?.code)) throw error;
        }
      }
    }
    const result = { extracted: candidates.length, stored };
    const snapshot = await this.memory.snapshot({ ...scope, memoryBaselineSequence: null, memorySnapshotSequence: 0, memorySnapshotVersionIds: [] });
    await this.#update((data) => {
      data.completed[dedupeKey] = {
        result: { extracted: result.extracted, memoryVersionIds: [...new Set(memoryVersionIds)] },
        evidence: candidates.map((candidate) => ({
          semanticKey: candidate.semanticKey,
          kind: candidate.kind || "observed-fact",
          ...(candidate.evidence ? { ...candidate.evidence, messageId: candidate.evidence.role === "user" ? parentMessageId : source?.id } : {}),
        })),
        memorySequence: snapshot.sequence,
        origin: {
          conversationId: String(scope.conversationId),
          branchId: String(scope.branchId),
          taskId: scope.taskId == null ? null : String(scope.taskId),
          sourceId: String(source?.id || scope.conversationId),
          parentMessageId: parentMessageId == null ? null : String(parentMessageId),
        },
        completedAt: this.clock().toISOString(),
      };
      if (String(source?.type || "") === "remote-task") delete data.tasks[String(source.id)];
    });
    return result;
  }
}
