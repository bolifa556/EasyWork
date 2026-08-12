import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

const LEVELS = new Set(["user", "project", "conversation", "workspace", "task"]);
const PORTABILITY = Object.freeze({
  user: "universal",
  project: "project-bound",
  conversation: "universal",
  workspace: "workspace-bound",
  task: "task-bound",
});

function unwrapJson(value) {
  const text = String(value || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}

export function parseMemoryCandidates(value) {
  let parsed;
  try { parsed = JSON.parse(unwrapJson(value)); } catch { return []; }
  const candidates = Array.isArray(parsed) ? parsed : parsed?.memories;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    if (!Object.keys(candidate).every((key) => ["level", "semanticKey", "content", "confidence"].includes(key))) return [];
    const level = String(candidate.level || "");
    const semanticKey = String(candidate.semanticKey || "").trim();
    const content = String(candidate.content || "").trim();
    const confidence = Number(candidate.confidence ?? 0.5);
    if (!LEVELS.has(level) || !semanticKey || semanticKey.length > 512 || !content || content.length > 20_000) return [];
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return [];
    return [{ level, semanticKey, content, confidence }];
  });
}

function scopeId(scope, level) {
  if (level === "user") return scope.actorId;
  if (level === "project") return scope.projectId;
  if (level === "conversation") return scope.conversationId;
  if (level === "workspace") return scope.workspaceId;
  if (level === "task") return scope.taskId;
  return null;
}

function availableLevels(scope) {
  return ["user", "project", "conversation", "workspace", "task"].filter((level) => {
    if (level === "user" && scope.memoryMode !== "global") return false;
    return Boolean(scopeId(scope, level));
  });
}

export class MemoryCoordinator {
  #inflight = new Map();

  constructor({ memory, extractor, prompt, dataRoot = null, actor = null, queue = null, clock = () => new Date() }) {
    invariant(memory && typeof memory.append === "function" && typeof memory.find === "function" && typeof memory.snapshot === "function" && typeof memory.select === "function", "MEMORY_COORDINATOR_INVALID", "MemoryCoordinator 缺少 Memory service", { status: 500, expose: false });
    invariant(typeof extractor === "function", "MEMORY_EXTRACTOR_INVALID", "MemoryCoordinator 缺少候选提取器", { status: 500, expose: false });
    this.memory = memory;
    this.extractor = extractor;
    this.prompt = String(prompt || "").trim();
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
      defaultData: () => ({ completed: {}, tasks: {}, branches: {} }),
      validate: (data) => Boolean(data && typeof data === "object" && !Array.isArray(data)
        && data.completed && typeof data.completed === "object" && !Array.isArray(data.completed)
        && data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)
        && data.branches && typeof data.branches === "object" && !Array.isArray(data.branches)),
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
    const branch = ledger.data.branches[`${scope.conversationId}:${scope.branchId}`] || null;
    if (!branch) {
      return Object.freeze({
        ...scope,
        memoryBaselineSequence: null,
        memorySnapshotSequence: live.sequence,
        memorySnapshotVersionIds: Object.freeze([...live.versionIds]),
      });
    }

    const baseline = await this.memory.select(canonicalScope, {
      asOfSequence: branch.memorySequence,
      versionIds: [],
    });
    const pinnedVersionIds = baseline.entries.map((entry) => entry.version.id);
    const allowed = new Set(pinnedVersionIds);
    for (const completed of Object.values(ledger.data.completed)) {
      const origin = completed?.origin;
      if (!origin || Number(completed.memorySequence || 0) <= branch.memorySequence) continue;
      if (origin.conversationId === scope.conversationId && origin.branchId !== scope.branchId) continue;
      for (const versionId of completed.result?.storedVersionIds || []) allowed.add(String(versionId));
    }
    const selected = await this.memory.select({
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
      memorySnapshotVersionIds: Object.freeze(selected.entries.map((entry) => entry.version.id)),
    });
  }

  async registerBranch({ conversationId, sourceBranchId, branchId, sourceMessageIds }) {
    const key = `${String(conversationId)}:${String(branchId)}`;
    const included = new Set((sourceMessageIds || []).map(String));
    invariant(conversationId && sourceBranchId && branchId && included.size > 0, "MEMORY_BRANCH_DESCRIPTOR_INVALID", "分支记忆边界不完整", { status: 500, expose: false });
    await this.#update((data) => {
      const current = data.branches[key];
      if (current) {
        invariant(current.sourceBranchId === String(sourceBranchId), "MEMORY_BRANCH_DESCRIPTOR_CONFLICT", "分支已绑定其他记忆边界", { status: 409 });
        return;
      }
      const parent = data.branches[`${conversationId}:${sourceBranchId}`] || null;
      let memorySequence = Number(parent?.memorySequence || 0);
      for (const completed of Object.values(data.completed)) {
        const origin = completed?.origin;
        if (origin?.conversationId !== String(conversationId) || origin.branchId !== String(sourceBranchId)) continue;
        if (!included.has(String(origin.sourceId || "")) && !included.has(String(origin.parentMessageId || ""))) continue;
        memorySequence = Math.max(memorySequence, Number(completed.memorySequence || 0));
      }
      const descriptor = {
        conversationId: String(conversationId),
        sourceBranchId: String(sourceBranchId),
        branchId: String(branchId),
        memorySequence,
        sourceMessageIds: [...included],
        createdAt: this.clock().toISOString(),
      };
      data.branches[key] = descriptor;
    });
    return { conversationId: String(conversationId), branchId: String(branchId), registered: true };
  }

  async registerTask({ taskId, scope, providerId, modelId, mode = "work", sourceMessageId = null }) {
    const id = String(taskId || "");
    invariant(id && providerId && modelId, "MEMORY_TASK_DESCRIPTOR_INVALID", "Task 记忆提取描述不完整", { status: 500, expose: false });
    await this.#update((data) => {
      const descriptor = {
        taskId: id,
        scope: structuredClone(scope),
        providerId: String(providerId),
        modelId: String(modelId),
        mode: String(mode),
        sourceMessageId: sourceMessageId == null ? null : String(sourceMessageId),
        registeredAt: this.clock().toISOString(),
      };
      const current = data.tasks[id];
      invariant(!current || (current.providerId === descriptor.providerId && current.modelId === descriptor.modelId), "MEMORY_TASK_DESCRIPTOR_CONFLICT", "Task 已绑定其他记忆提取模型", { status: 409 });
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

  async recordTaskFinal({ task, assistantMessage, source }) {
    const descriptor = await this.taskDescriptor(task?.id);
    if (!descriptor) return { extracted: 0, stored: [], skipped: "descriptor-unavailable" };
    return this.recordExchange({
      scope: descriptor.scope,
      userMessage: task.goal,
      assistantMessage,
      source: source || { type: "remote-task", id: task.id, version: String(task.revision) },
      authority: "agent-observed",
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      mode: descriptor.mode,
      parentMessageId: descriptor.sourceMessageId,
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

  async #recordExchange({ scope, userMessage, assistantMessage, source, authority = "model-inferred", providerId, modelId, mode = "chat", parentMessageId = null, dedupeKey }) {
    const before = await this.#repository().read();
    if (before.data.completed[dedupeKey]) return { ...structuredClone(before.data.completed[dedupeKey].result), duplicate: true };
    const levels = availableLevels(scope);
    if (!levels.length) return { extracted: 0, stored: [] };
    const output = await this.extractor({
      system: this.prompt,
      providerId: String(providerId || ""),
      modelId: String(modelId || ""),
      mode,
      input: {
        availableLevels: levels,
        scopeIds: Object.fromEntries(levels.map((level) => [level, scopeId(scope, level)])),
        userMessage: String(userMessage || ""),
        assistantMessage: String(assistantMessage || ""),
      },
    });
    const candidates = parseMemoryCandidates(output);
    const stored = [];
    for (const candidate of candidates) {
      if (!levels.includes(candidate.level)) continue;
      const memoryScope = { level: candidate.level, id: scopeId(scope, candidate.level) };
      for (;;) {
        const existing = await this.memory.find({ scope: memoryScope, semanticKey: candidate.semanticKey });
        const latest = existing?.versions?.at(-1);
        if (latest?.content === candidate.content && latest?.source?.id === String(source?.id || scope.conversationId)) break;
        try {
          const result = await this.memory.append({
            scope: memoryScope,
            semanticKey: candidate.semanticKey,
            content: candidate.content,
            authority,
            confidence: candidate.confidence,
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
        result: { extracted: result.extracted, storedVersionIds: stored.map((entry) => entry.version.id) },
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
