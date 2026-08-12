import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { createAgentAdapters } from "../agents/index.mjs";
import { ArtifactService } from "../artifacts/service.mjs";
import { AuditService } from "../audit/service.mjs";
import { CatalogConsistencyService } from "../catalog/consistency.mjs";
import { CollectionService, ProjectService } from "../catalog/service.mjs";
import { ContextHub } from "../context-hub/service.mjs";
import { ConversationService } from "../conversations/service.mjs";
import { WorkDraftService } from "../drafts/service.mjs";
import { defaultConversationTitle } from "../conversations/contract.mjs";
import { ApiError, invariant } from "../errors.mjs";
import { MemoryCoordinator, PersistentMemoryService } from "../memory/index.mjs";
import { resolveActorPath } from "../paths.mjs";
import { PreviewService } from "../previews/service.mjs";
import { DetachedTaskRuntime, FileTaskStore, PersistentWebInteractionStore } from "../orchestrator/persistence.mjs";
import { TaskReportService } from "../orchestrator/report.mjs";
import { TaskOrchestrator } from "../orchestrator/service.mjs";
import { RealtimeBroker } from "../realtime-broker.mjs";
import { RealtimeEventJournal } from "../realtime.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { ResourceService } from "../resources/service.mjs";
import { SlurmSchedulerAdapter } from "../scheduler/slurm.mjs";
import { SchedulerService } from "../scheduler/service.mjs";
import { createAgentBindingKey } from "../scope.mjs";
import { SkillService } from "../skills/service.mjs";
import { taskTopic } from "../orchestrator/contract.mjs";
import { VersioningService } from "../versioning/service.mjs";
import { WebAgentRuntime } from "../web-agent/runtime.mjs";
import { createDefaultWebAgentTools } from "../web-agent/tools.mjs";
import { WorkspaceService } from "../workspaces/service.mjs";
import { ServerCapabilityService } from "./server-capabilities.mjs";
import {
  CanonicalTaskJournal,
  DynamicEmbeddingAdapter,
  DynamicResourceExtractor,
  OrchestratorVersionAdapter,
  OrchestratorWorkspaceAdapter,
  UnavailableAgentTransport,
} from "./adapters.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const nowIso = (clock) => clock().toISOString();

const MIME_BY_EXTENSION = Object.freeze({
  ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".json": "application/json", ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".toml": "text/plain", ".ini": "text/plain", ".py": "text/x-python",
  ".js": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript", ".jsx": "text/javascript", ".css": "text/css",
  ".html": "text/html", ".sh": "text/x-shellscript", ".ps1": "text/plain", ".r": "text/plain", ".cpp": "text/plain",
  ".c": "text/plain", ".h": "text/plain", ".java": "text/plain", ".rs": "text/plain", ".go": "text/plain", ".sql": "text/plain",
});

function viewerMime(name, declared = "application/octet-stream") {
  const mime = String(declared || "application/octet-stream").toLowerCase();
  return mime === "application/octet-stream" ? MIME_BY_EXTENSION[path.posix.extname(String(name).toLowerCase())] || mime : mime;
}

function exactObject(input, allowed, operation) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "RUNTIME_INPUT_INVALID", `${operation} 参数无效`, { status: 400 });
  invariant(Object.keys(input).every((key) => allowed.includes(key)), "RUNTIME_INPUT_SCHEMA_INVALID", `${operation} 参数不符合 EasyWork 协议`, {
    status: 400,
    details: { allowed },
  });
  return input;
}

function derivedCommandId(commandId, suffix) {
  const seed = `${String(commandId)}:${suffix}`;
  return seed.length <= 255 ? seed : `cmd_${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

function normalizeGeneratedTitle(value) {
  const firstLine = String(value || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || "";
  const normalized = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:标题|对话标题)\s*[:：]\s*/, "")
    .replace(/^[\s"'“”‘’《》【】]+|[\s"'“”‘’《》【】。！？.!?]+$/g, "")
    .trim();
  const title = Array.from(normalized).slice(0, 14).join("");
  invariant(title.length > 0, "CONVERSATION_TITLE_GENERATION_EMPTY", "标题模型没有返回有效标题", { status: 502 });
  return title;
}

async function allConversations(service) {
  const output = [];
  let cursor = null;
  do {
    const page = await service.listConversations({ cursor, limit: 100 });
    output.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return output;
}

async function allMessages(service, conversationId, branchId) {
  const output = [];
  let cursor = null;
  do {
    const page = await service.listMessages({ conversationId, branchId, cursor, limit: 100 });
    output.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return output;
}

function effectiveScope(actor, summary, branchId, input = {}, taskId = null, preserveMemoryBaseline = false) {
  const serverId = input.serverId == null ? null : String(input.serverId);
  const serverIdentity = input.serverIdentity == null ? null : String(input.serverIdentity);
  invariant((serverId === null) === (serverIdentity === null), "CONTEXT_SCOPE_SERVER_INCOMPLETE", "serverId 与 serverIdentity 必须同时提供", { status: 400 });
  return Object.freeze({
    actorType: actor.actorType,
    actorId: actor.actorId,
    userId: actor.userId || null,
    projectId: summary.projectId,
    conversationId: summary.id,
    workspaceId: input.workspaceId == null ? null : String(input.workspaceId),
    taskId,
    serverId,
    serverIdentity,
    versionDomainId: input.versionDomainId == null ? null : String(input.versionDomainId),
    memoryMode: input.memoryMode === "global" ? "global" : "project-only",
    branchId,
    memorySnapshotSequence: Number(input.memorySnapshotSequence || 0),
    memoryBaselineSequence: preserveMemoryBaseline && input.memoryBaselineSequence != null ? Number(input.memoryBaselineSequence) : null,
    memorySnapshotVersionIds: Object.freeze((input.memorySnapshotVersionIds || []).map(String)),
    resourceBindingSnapshotId: input.resourceBindingSnapshotId == null ? null : String(input.resourceBindingSnapshotId),
    selectedCollectionIds: Object.freeze((input.selectedCollectionIds || []).map(String)),
    selectedSkillVersions: Object.freeze((input.selectedSkillVersions || []).map((entry) => Object.freeze({ skillId: String(entry.skillId), version: String(entry.version) }))),
    capabilities: Object.freeze((input.capabilities || []).map(String)),
    contextEpoch: Number(input.contextEpoch || 0),
  });
}

function estimatedTokens(value) {
  return Math.max(0, Math.ceil(String(value || "").length / 4));
}

function parseJsonObject(value, code, message) {
  const text = String(value || "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  let parsed;
  try { parsed = JSON.parse(fenced ? fenced[1] : text); } catch { throw new ApiError(code, message, { status: 502 }); }
  invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), code, message, { status: 502 });
  return parsed;
}

const COMPACT_FIELDS = Object.freeze([
  "goal", "currentFocus", "activeRequirements", "activeConstraints", "activeDecisions", "executionOutcomes",
  "importantFacts", "artifactReferences", "openQuestions", "pendingApprovals", "nextActions", "exactAnchors",
]);

function normalizedCheckpoint(value) {
  const output = {};
  for (const field of COMPACT_FIELDS) {
    if (["goal", "currentFocus"].includes(field)) output[field] = String(value[field] || "").slice(0, 20_000);
    else output[field] = [...new Set((Array.isArray(value[field]) ? value[field] : []).map((entry) => String(entry).trim()).filter(Boolean))].slice(0, 500);
  }
  return output;
}

function validContextSettings(data) {
  if (!data || !Number.isSafeInteger(data.maxTokens) || data.maxTokens < 4_096 || data.maxTokens > 2_000_000) return false;
  if (!Number.isFinite(data.autoCompactThreshold) || data.autoCompactThreshold < 0.5 || data.autoCompactThreshold > 1) return false;
  if (data.route !== null && (!data.route || typeof data.route.providerId !== "string" || typeof data.route.modelId !== "string")) return false;
  if (!data.checkpoints || typeof data.checkpoints !== "object" || Array.isArray(data.checkpoints)) return false;
  return Object.values(data.checkpoints).every((entry) => entry && typeof entry.branchId === "string" && entry.summary && Array.isArray(entry.coveredMessageIds));
}

class ConversationContextSettings {
  #compressions = new Map();

  constructor({ dataRoot, actor, queue, clock, conversations, summarizer }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
    this.conversations = conversations;
    this.summarizer = summarizer;
  }

  #repository(conversationId) {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["context", "conversations", String(conversationId), "settings.json"],
      schemaVersion: 2,
      defaultData: () => ({ maxTokens: 200_000, autoCompactThreshold: 0.95, route: null, checkpoints: {} }),
      validate: validContextSettings,
      queue: this.queue,
    });
  }

  async #replaceLatest(conversationId, updater) {
    const repository = this.#repository(conversationId);
    for (;;) {
      const current = await repository.read();
      try {
        return await repository.update(updater, { expectedRevision: current.revision, clock: this.clock });
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async rememberRoute(conversationId, { providerId, modelId }) {
    invariant(providerId && modelId, "CONVERSATION_MODEL_ROUTE_REQUIRED", "网页对话缺少模型路由", { status: 409 });
    await this.#replaceLatest(conversationId, (data) => { data.route = { providerId: String(providerId), modelId: String(modelId) }; });
  }

  async #state(conversationId, branchId = null) {
    const detail = await this.conversations.getConversation(conversationId);
    const selectedBranchId = branchId || detail.summary.activeBranchId;
    const [stored, messages] = await Promise.all([
      this.#repository(conversationId).read(),
      allMessages(this.conversations, conversationId, selectedBranchId),
    ]);
    const checkpoint = stored.data.checkpoints[selectedBranchId] || null;
    const covered = new Set(checkpoint?.coveredMessageIds || []);
    const retained = messages.filter((message) => !covered.has(message.id));
    return { detail, branchId: selectedBranchId, stored, messages, retained, checkpoint };
  }

  async get(conversationId) {
    const { stored, retained, checkpoint } = await this.#state(conversationId);
    const byRole = { user: 0, assistant: 0, system: 0 };
    if (checkpoint) byRole.system += estimatedTokens(JSON.stringify(checkpoint.summary));
    for (const message of retained) byRole[message.role] = (byRole[message.role] || 0) + estimatedTokens(message.content);
    const usedTokens = Object.values(byRole).reduce((total, value) => total + value, 0);
    const limitTokens = stored.data.maxTokens;
    return {
      usage: {
        usedTokens,
        limitTokens,
        ratio: limitTokens ? Math.min(1, usedTokens / limitTokens) : 0,
        parts: Object.entries(byRole).filter(([, tokens]) => tokens > 0).map(([kind, tokens]) => ({ kind, tokens })),
      },
      config: { maxTokens: stored.data.maxTokens, autoCompactThreshold: stored.data.autoCompactThreshold },
      revision: stored.revision,
      compressing: this.#compressions.has(String(conversationId)),
    };
  }

  async history(conversationId, branchId) {
    const { retained, checkpoint } = await this.#state(conversationId, branchId);
    return [
      ...(checkpoint ? [{ role: "system", content: `<conversation_checkpoint>\n${JSON.stringify(checkpoint.summary)}\n</conversation_checkpoint>` }] : []),
      ...retained.filter((entry) => ["user", "assistant"].includes(entry.role)).map((entry) => ({ role: entry.role, content: entry.content, id: entry.id })),
    ];
  }

  async update(conversationId, input) {
    await this.conversations.getConversation(conversationId);
    exactObject(input, ["maxTokens", "autoCompactThreshold", "expectedRevision"], "ConversationContextConfig");
    const current = await this.#repository(conversationId).read();
    const next = { ...current.data,
      maxTokens: input.maxTokens === undefined ? current.data.maxTokens : Number(input.maxTokens),
      autoCompactThreshold: input.autoCompactThreshold === undefined ? current.data.autoCompactThreshold : Number(input.autoCompactThreshold) };
    const stored = await this.#repository(conversationId).replace(next, { expectedRevision: input.expectedRevision, clock: this.clock });
    const currentUsage = await this.get(conversationId);
    if (next.route && currentUsage.usage.ratio >= next.autoCompactThreshold) return this.compact(conversationId);
    return { ...currentUsage, revision: stored.revision };
  }

  compact(conversationId) {
    const key = String(conversationId);
    if (this.#compressions.has(key)) return this.#compressions.get(key);
    const promise = this.#compact(key);
    this.#compressions.set(key, promise);
    promise.finally(() => {
      if (this.#compressions.get(key) === promise) this.#compressions.delete(key);
    }).catch(() => undefined);
    return promise;
  }

  async compactIfNeeded(conversationId) {
    const state = await this.get(conversationId);
    return state.usage.ratio >= state.config.autoCompactThreshold ? this.compact(conversationId) : state;
  }

  async #compact(conversationId) {
    invariant(typeof this.summarizer === "function", "CONVERSATION_COMPACTION_UNAVAILABLE", "网页对话没有可用的压缩执行器", { status: 503, retryable: true });
    const state = await this.#state(conversationId);
    const route = state.stored.data.route;
    invariant(route?.providerId && route?.modelId, "CONVERSATION_COMPACTION_MODEL_REQUIRED", "请先为该对话选择模型", { status: 409 });
    const uncompressed = state.retained;
    const keepCount = Math.min(4, uncompressed.length);
    const compactable = uncompressed.slice(0, Math.max(0, uncompressed.length - keepCount));
    if (!compactable.length) return this.get(conversationId);
    const prompt = await this.summarizer({
      providerId: route.providerId,
      modelId: route.modelId,
      existingCheckpoint: state.checkpoint?.summary || null,
      messages: compactable.map(({ id, role, content, taskId, createdAt }) => ({ id, role, content, taskId, createdAt })),
      conversationId,
    });
    const parsed = normalizedCheckpoint(parseJsonObject(prompt, "CONVERSATION_COMPACTION_INVALID", "模型没有返回有效的对话检查点"));
    const coveredMessageIds = [...new Set([...(state.checkpoint?.coveredMessageIds || []), ...compactable.map((entry) => entry.id)])];
    await this.#replaceLatest(conversationId, (data) => {
      data.checkpoints[state.branchId] = {
        branchId: state.branchId,
        summary: parsed,
        coveredMessageIds,
        createdAt: this.clock().toISOString(),
      };
    });
    return this.get(conversationId);
  }
}

class ConversationInteractionFacade {
  constructor(base, interactions, memoryCoordinator) {
    this.base = base;
    this.interactions = interactions;
    this.memoryCoordinator = memoryCoordinator;
  }

  async #messagesFor(conversationId, branchId = null) {
    const detail = await this.base.getConversation(conversationId);
    const selected = branchId || detail.summary.activeBranchId;
    return { detail, branchId: selected, messages: await allMessages(this.base, conversationId, selected) };
  }

  async #invalidateRemoved(before, conversationId, branchId, result, commandId, reason) {
    const after = await allMessages(this.base, conversationId, branchId);
    const retained = new Set(after.map((entry) => entry.id));
    const removed = before.filter((entry) => !retained.has(entry.id));
    if (!removed.length) return { invalidated: 0 };
    return this.memoryCoordinator.invalidateBoundary({
      messageIds: removed.map((entry) => entry.id),
      taskIds: removed.map((entry) => entry.taskId).filter(Boolean),
      reason,
      source: { type: "conversation-mutation", id: String(commandId), version: String(result.conversation?.revision ?? "1") },
    });
  }

  listConversations(input) { return this.base.listConversations(input); }
  getConversation(id) { return this.base.getConversation(id); }
  listMessages(input) { return this.base.listMessages(input); }
  rename(input) { return this.base.rename(input); }
  setPinned(input) { return this.base.setPinned(input); }
  moveToProject(input) { return this.base.moveToProject(input); }
  convertMode(input) { return this.base.convertMode(input); }
  activateBranch(input) { return this.base.activateBranch(input); }
  delete(input) { return this.base.delete(input); }
  async branch(input) {
    const mutation = { ...(input || {}) };
    delete mutation.action;
    delete mutation.response;
    const before = await this.#messagesFor(mutation.conversationId, mutation.sourceBranchId);
    const boundaryIndex = before.messages.findIndex((entry) => entry.id === mutation.atMessageId);
    invariant(boundaryIndex >= 0, "BRANCH_FORK_MESSAGE_NOT_FOUND", "分支起点不在来源消息链中", { status: 404 });
    const result = await this.base.branch(mutation);
    await this.memoryCoordinator.registerBranch({
      conversationId: mutation.conversationId,
      sourceBranchId: mutation.sourceBranchId || before.branchId,
      branchId: result.branch.id,
      sourceMessageIds: before.messages.slice(0, boundaryIndex + 1).map((entry) => entry.id),
    });
    return result;
  }

  async editLatestUserMessage(input) {
    const mutation = { ...(input || {}) };
    const response = mutation.response || null;
    delete mutation.action;
    delete mutation.response;
    const before = await this.#messagesFor(mutation.conversationId, mutation.branchId);
    const result = await this.base.editLatestUserMessage(mutation);
    await this.#invalidateRemoved(before.messages, mutation.conversationId, result.branchId || before.branchId, result, mutation.commandId, "edited latest user message");
    if (!response) return result;
    exactObject(response, ["providerId", "modelId", "scope"], "ResponseDescriptor");
    return {
      ...result,
      response: await this.interactions.respond({
        conversationId: mutation.conversationId,
        messageId: result.messageId,
        providerId: response.providerId,
        modelId: response.modelId,
        scope: response.scope || {},
        commandId: derivedCommandId(mutation.commandId, "respond"),
      }),
    };
  }

  async retry(input) {
    const mutation = { ...(input || {}) };
    const response = mutation.response || null;
    delete mutation.action;
    delete mutation.response;
    if (!response) {
      const before = await this.#messagesFor(mutation.conversationId, mutation.branchId);
      const result = await this.base.retry(mutation);
      await this.#invalidateRemoved(before.messages, mutation.conversationId, result.branchId || before.branchId, result, mutation.commandId, "retried assistant response");
      return result;
    }
    exactObject(response, ["providerId", "modelId", "scope"], "ResponseDescriptor");
    const detail = await this.base.getConversation(mutation.conversationId);
    const branchId = mutation.branchId || detail.summary.activeBranchId;
    const messages = await allMessages(this.base, mutation.conversationId, branchId);
    const assistant = messages.at(-1);
    const user = messages.at(-2);
    invariant(assistant?.role === "assistant" && user?.role === "user", "LATEST_ASSISTANT_MESSAGE_REQUIRED", "只能重新生成最新一条助手回复", { status: 409 });
    invariant(!mutation.messageId || mutation.messageId === assistant.id, "LATEST_ASSISTANT_MESSAGE_REQUIRED", "只能重新生成最新一条助手回复", { status: 409, details: { latestMessageId: assistant.id } });
    const rewound = await this.base.rewind({
      conversationId: mutation.conversationId,
      branchId,
      toMessageId: user.id,
      expectedRevision: mutation.expectedRevision,
      commandId: derivedCommandId(mutation.commandId, "rewind"),
    });
    await this.memoryCoordinator.invalidateBoundary({
      messageIds: [assistant.id],
      taskIds: assistant.taskId ? [assistant.taskId] : [],
      reason: "regenerated assistant response",
      source: { type: "conversation-mutation", id: String(mutation.commandId), version: String(rewound.conversation.revision) },
    });
    return {
      ...rewound,
      response: await this.interactions.respond({
        conversationId: mutation.conversationId,
        messageId: user.id,
        providerId: response.providerId,
        modelId: response.modelId,
        scope: response.scope || {},
        commandId: derivedCommandId(mutation.commandId, "respond"),
      }),
    };
  }

  async rewind(input) {
    const mutation = { ...(input || {}) };
    delete mutation.action;
    delete mutation.response;
    const before = await this.#messagesFor(mutation.conversationId, mutation.branchId);
    const result = await this.base.rewind(mutation);
    await this.#invalidateRemoved(before.messages, mutation.conversationId, result.branchId || before.branchId, result, mutation.commandId, "rewound conversation branch");
    return result;
  }

  async sendMessage(input) {
    const { response = null, ...messageInput } = input || {};
    const result = await this.base.sendMessage(messageInput);
    if ((messageInput.role || "user") !== "user" || !response) return result;
    exactObject(response, ["providerId", "modelId", "scope"], "ResponseDescriptor");
    const started = await this.interactions.respond({
      conversationId: result.conversation.id,
      messageId: result.messageId,
      providerId: response.providerId,
      modelId: response.modelId,
      scope: response.scope || {},
      commandId: derivedCommandId(messageInput.commandId, "respond"),
    });
    return { ...result, response: started };
  }
}

const HANDOFF_SETTLED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "waiting_approval"]);

function remoteAgentPrompt(userMessage, contextBrief) {
  const request = String(userMessage || "").trim();
  const brief = String(contextBrief || "").trim();
  return brief
    ? `用户请求（原文）：\n${request}\n\n与本轮请求直接相关的补充上下文：\n${brief}`
    : `用户请求（原文）：\n${request}`;
}

export class RemoteTaskLifecycle {
  constructor(container, extraction) {
    this.container = container;
    this.extraction = extraction;
  }

  async create({ scope, userMessage, contextBrief, idempotencyKey }) {
    invariant(scope?.serverId && scope?.serverIdentity && scope?.workspaceId && scope?.agentId, "WORK_ROUTE_REQUIRED", "工作模式需要服务器、工作区和 Agent", { status: 409 });
    const taskId = `task_${crypto.createHash("sha256").update(`${this.container.actor.actorId}:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
    const existing = await this.container.taskStore.getTask(taskId);
    if (existing) {
      if (this.extraction.runId) await this.container.webInteractionStore.addTask(this.extraction.runId, taskId);
      const start = existing.status === "queued"
        ? await this.container.orchestrator.start(taskId, { commandId: derivedCommandId(idempotencyKey, "start") })
        : { taskId, status: existing.status, duplicate: true };
      return { task: existing, start, duplicate: true };
    }
    const liveTasks = await this.container.taskStore.listTasks({
      conversationId: scope.conversationId,
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1000,
    });
    const conflicting = liveTasks.find((task) => (
      task.route.serverId === scope.serverId
      && task.route.workspaceId === scope.workspaceId
      && task.route.agentId === scope.agentId
    ));
    invariant(!conflicting, "CONVERSATION_TASK_ACTIVE", "当前 Agent 与工作区已有正在执行的任务，请向该任务追加指令或先中断任务", {
      status: 409,
      details: conflicting ? { taskId: conflicting.id, status: conflicting.status } : undefined,
    });
    const detail = await this.container.baseConversations.getConversation(scope.conversationId);
    const taskScope = effectiveScope(this.container.actor, detail.summary, scope.branchId || detail.summary.activeBranchId, scope, taskId, true);
    const contextSessionId = `ctx_${crypto.createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`;
    let contextSession;
    try {
      contextSession = await this.container.contextHub.createSession({
        id: contextSessionId,
        consumer: "remote-agent",
        consumerId: taskId,
        scope: taskScope,
        budget: {
          maxTokens: Number(scope.maxInputTokens || 160_000),
          reservedOutputTokens: Number(scope.maxOutputTokens || 32_000),
        },
      });
    } catch (error) {
      if (error?.code !== "CONTEXT_SESSION_EXISTS") throw error;
      contextSession = await this.container.contextHub.getSession(contextSessionId);
    }
    const agentBindingId = createAgentBindingKey(taskScope, scope.agentId);
    const created = await this.container.orchestrator.create({
      id: taskId,
      actorId: this.container.actor.actorId,
      conversationId: taskScope.conversationId,
      branchId: taskScope.branchId,
      goal: remoteAgentPrompt(userMessage, contextBrief),
      route: {
        serverId: taskScope.serverId,
        serverIdentity: taskScope.serverIdentity,
        workspaceId: taskScope.workspaceId,
        agentId: String(scope.agentId),
        providerId: String(scope.agentProviderId || this.extraction.providerId),
        modelId: String(scope.agentModelId || this.extraction.modelId),
      },
      contextSessionId: contextSession.id,
      agentBindingId,
      skillPins: clone(scope.skillPins || []),
      resourceBindingSnapshotId: taskScope.resourceBindingSnapshotId || `rsnap_${crypto.createHash("sha256").update(`${taskId}:resources`).digest("hex").slice(0, 32)}`,
      versionCheckpointId: null,
      budgets: {
        maxWallTimeMs: Number(scope.maxWallTimeMs || 30 * 60_000),
        maxInputTokens: Number(scope.maxInputTokens || 160_000),
        maxOutputTokens: Number(scope.maxOutputTokens || 32_000),
        maxToolCalls: Number(scope.maxToolCalls || 100),
      },
      idempotencyKey,
    }, { commandId: idempotencyKey });
    if (this.extraction.runId) await this.container.webInteractionStore.addTask(this.extraction.runId, taskId);
    if (created.task.skillPins.length > 0) {
      const skillSnapshot = await this.container.skills.inspect();
      await this.container.skills.pinTask({
        taskId,
        skills: created.task.skillPins.map((pin) => ({
          skillId: pin.skillId,
          version: pin.version,
          mandatory: true,
        })),
        expectedRevision: skillSnapshot.meta.revision,
      });
    }
    await this.container.memoryCoordinator.registerTask({
      taskId,
      scope: taskScope,
      providerId: this.extraction.providerId,
      modelId: this.extraction.modelId,
      mode: "work",
      sourceMessageId: this.extraction.messageId,
    });
    const started = await this.container.orchestrator.start(taskId, { commandId: derivedCommandId(idempotencyKey, "start") });
    return { task: created.task, start: started };
  }

  async dispatch({ scope, userMessage, contextBrief, idempotencyKey }) {
    invariant(scope?.serverId && scope?.serverIdentity && scope?.workspaceId && scope?.agentId, "WORK_ROUTE_REQUIRED", "工作模式需要服务器、工作区和 Agent", { status: 409 });
    const candidates = await this.container.taskStore.listTasks({
      conversationId: scope.conversationId,
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_append", "interrupting", "interrupted", "recovering", "finalizing"],
      limit: 1000,
    });
    const matching = candidates
      .filter((task) => task.route.serverId === scope.serverId && task.route.workspaceId === scope.workspaceId && task.route.agentId === scope.agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    invariant(matching.length <= 1, "CONVERSATION_TASK_STATE_AMBIGUOUS", "当前 Agent 与工作区存在多个非终态任务，无法安全投递", { status: 409 });
    const current = matching[0] || null;
    const prompt = remoteAgentPrompt(userMessage, contextBrief);
    if (!current) {
      const created = await this.create({ scope, userMessage, contextBrief, idempotencyKey });
      return { operation: "create", taskId: created.task.id, ...created };
    }
    if (this.extraction.runId) await this.container.webInteractionStore.addTask(this.extraction.runId, current.id);
    if (current.status === "running") {
      const command = await this.container.orchestrator.append(current.id, {
        prompt,
        commandId: derivedCommandId(idempotencyKey, "append"),
      });
      return { operation: "append", taskId: current.id, task: current, command };
    }
    if (current.status === "interrupted") {
      const commandId = derivedCommandId(idempotencyKey, "resume");
      const command = await this.container.orchestrator.resume(current.id, {
        prompt,
        commandId,
      });
      const activatedTask = await this.#waitForResumeActivation(current.id, commandId);
      return { operation: "resume", taskId: current.id, task: activatedTask, command };
    }
    invariant(false, "CONVERSATION_TASK_BUSY", `远程任务当前处于 ${current.status}，暂时不能接收新的用户消息`, {
      status: 409,
      details: { taskId: current.id, status: current.status },
    });
  }

  async #waitForResumeActivation(taskId, commandId) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const [task, command] = await Promise.all([
        this.container.orchestrator.getTask(taskId),
        this.container.orchestrator.getCommand(taskId, commandId),
      ]);
      if (task.status !== "interrupted") return task;
      if (command?.status === "failed") {
        throw new ApiError(command.failure?.code || "TASK_RESUME_FAILED", command.failure?.message || "远端 Agent 恢复失败", {
          status: 502,
          retryable: Boolean(command.failure?.retryable),
        });
      }
      if (command?.status === "completed") {
        throw new ApiError("TASK_RESUME_STATE_INVALID", "远端 Agent 恢复命令已结束，但任务仍处于中断状态", { status: 502 });
      }
      if (Date.now() >= deadline) {
        throw new ApiError("TASK_RESUME_ACTIVATION_TIMEOUT", "远端 Agent 恢复命令未能及时启动", { status: 504, retryable: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async observe({ taskId, afterSequence, signal }) {
    const deadline = Date.now() + 25_000;
    for (;;) {
      signal?.throwIfAborted();
      const [task, replay, report] = await Promise.all([
        this.container.orchestrator.getTask(taskId),
        this.container.broker.replay(taskTopic(taskId), { afterSequence, limit: 500 }),
        this.container.taskReports.get(taskId, { required: false }),
      ]);
      const settled = ["completed", "failed", "cancelled", "interrupted", "waiting_approval", "waiting_append"].includes(task.status);
      if (replay.events.length || settled || Date.now() >= deadline) {
        return { task, report, events: replay.events, nextAfterSequence: replay.nextAfterSequence };
      }
      await new Promise((resolve, reject) => {
        const finish = () => {
          if (signal) signal.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(650, Math.max(1, deadline - Date.now())));
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Task observation aborted"));
        };
        if (signal) signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          if (signal?.aborted) abort();
        });
      });
    }
  }

  async waitFor(taskId, signal) {
    let afterSequence = 0;
    for (;;) {
      signal?.throwIfAborted();
      const observation = await this.observe({ taskId, afterSequence, signal });
      afterSequence = Number(observation.nextAfterSequence) || afterSequence;
      const status = String(observation.task?.status || "");
      if (!HANDOFF_SETTLED_STATUSES.has(status)) continue;
      if (["completed", "failed", "cancelled"].includes(status) && !observation.report) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      return observation;
    }
  }
}

class WebInteractionService {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    this.runs = new Map();
  }

  async initialize() {
    const recovered = await this.store.listRunning();
    for (const record of recovered) this.#launch(record.runId, record.input);
    return recovered.length;
  }

  async respond(input) {
    exactObject(input, ["conversationId", "messageId", "providerId", "modelId", "scope", "commandId"], "RespondConversation");
    invariant(typeof input.commandId === "string" && input.commandId, "IDEMPOTENCY_KEY_REQUIRED", "Respond 必须提供 Idempotency-Key", { status: 428 });
    const runId = `web_${crypto.createHash("sha256").update(`${this.container.actor.actorId}:${input.commandId}`).digest("hex").slice(0, 32)}`;
    const claimed = await this.store.claim(runId, clone(input));
    if (claimed.record.status === "completed") return { runId, status: "completed", duplicate: true };
    if (claimed.record.status === "failed") return { runId, status: "failed", duplicate: true };
    this.#launch(runId, claimed.record.input);
    return { runId, status: "running", duplicate: !claimed.created };
  }

  #launch(runId, input) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const promise = this.#run({ ...clone(input), runId }).then(async (result) => {
      const metadata = {
        usage: clone(result.usage),
        iterations: Number(result.iterations || 0),
        toolCallCount: Number(result.toolCallCount || 0),
        taskId: result.taskId || null,
        taskStatus: result.taskStatus || null,
      };
      await this.store.complete(runId, { assistantMessageId: result.messageId, result: metadata });
      return result;
    }).catch(async (error) => {
      await this.store.fail(runId, {
        code: String(error?.code || "WEB_AGENT_FAILED").replace(/[^A-Za-z0-9._:-]/g, "_"),
        message: String(error?.message || "网页 Agent 执行失败").slice(0, 16_384),
        retryable: Boolean(error?.retryable),
      }).catch(() => undefined);
      throw error;
    });
    this.runs.set(runId, promise);
    promise.finally(() => this.runs.delete(runId)).catch(() => undefined);
    promise.catch(() => undefined);
    return promise;
  }

  async waitFor(runId) {
    const promise = this.runs.get(String(runId));
    if (promise) return promise;
    const record = await this.store.get(String(runId));
    invariant(record, "WEB_RUN_NOT_FOUND", "网页 Agent run 不存在", { status: 404 });
    if (record.status === "running") {
      this.#launch(record.runId, record.input);
      return this.runs.get(record.runId);
    }
    if (record.status === "failed") {
      throw new ApiError(record.failure?.code || "WEB_AGENT_FAILED", record.failure?.message || "网页 Agent 执行失败", {
        status: 502,
        retryable: Boolean(record.failure?.retryable),
      });
    }
    const detail = await this.container.baseConversations.getConversation(record.input.conversationId);
    if (!record.assistantMessageId) {
      return {
        runId: record.runId,
        content: "",
        reasoning: "",
        usage: clone(record.result?.usage || null),
        iterations: Number(record.result?.iterations || 0),
        toolCallCount: Number(record.result?.toolCallCount || 0),
        messageId: null,
        conversation: detail.summary,
        taskId: record.result?.taskId || null,
        taskStatus: record.result?.taskStatus || null,
        recovered: true,
      };
    }
    const messages = await allMessages(this.container.baseConversations, record.input.conversationId, detail.summary.activeBranchId);
    const assistant = messages.find((message) => message.id === record.assistantMessageId);
    invariant(assistant?.role === "assistant", "WEB_RUN_RESULT_GONE", "网页 Agent 的最终回复已不在当前对话分支", { status: 410 });
    return {
      runId: record.runId,
      content: assistant.content,
      reasoning: "",
      usage: clone(record.result?.usage || null),
      iterations: Number(record.result?.iterations || 0),
      toolCallCount: Number(record.result?.toolCallCount || 0),
      messageId: assistant.id,
      conversation: detail.summary,
      recovered: true,
    };
  }

  async status(runId) {
    const record = await this.store.get(String(runId));
    invariant(record, "WEB_RUN_NOT_FOUND", "网页 Agent run 不存在", { status: 404 });
    return {
      status: record.status,
      result: record.status === "completed" ? await this.waitFor(runId) : null,
      failure: record.status === "failed" ? clone(record.failure) : null,
    };
  }

  async #run(input) {
    const detail = await this.container.baseConversations.getConversation(input.conversationId);
    const branchId = detail.summary.activeBranchId;
    const messages = await allMessages(this.container.baseConversations, input.conversationId, branchId);
    const target = input.messageId ? messages.find((message) => message.id === input.messageId) : messages.at(-1);
    const latest = messages.at(-1);
    const mode = detail.summary.mode;
    invariant(target?.role === "user", "RESPONSE_TARGET_STALE", "只能回答当前分支中的用户消息", { status: 409 });
    if (latest?.role === "assistant" && latest.replyToMessageId === target.id && messages.at(-2)?.id === target.id) {
      return { runId: input.runId, content: latest.content, reasoning: "", usage: null, iterations: 0, toolCallCount: 0, messageId: latest.id, conversation: detail.summary, recovered: true };
    }
    const initialTargetIndex = messages.findIndex((message) => message.id === target.id);
    const workContinuation = mode === "work" && initialTargetIndex >= 0 && messages.slice(initialTargetIndex + 1).every((message) => message.role === "user");
    invariant(latest?.id === target.id || workContinuation, "RESPONSE_TARGET_STALE", "只能回答当前分支最新的用户消息", { status: 409 });
    const requestedScope = clone(input.scope || {});
    const project = detail.summary.projectId ? await this.container.projects.get(detail.summary.projectId) : null;
    requestedScope.memoryMode = project?.memoryMode || "global";
    if (requestedScope.serverId) {
      const server = await this.container.servers.get(String(requestedScope.serverId));
      invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
      invariant(!requestedScope.serverIdentity || requestedScope.serverIdentity === server.profile.serverIdentity, "SERVER_IDENTITY_MISMATCH", "服务器身份与当前 SSH 配置不一致", { status: 409 });
      requestedScope.serverIdentity = server.profile.serverIdentity;
    }
    const scope = await this.container.memoryCoordinator.freezeScope(effectiveScope(this.container.actor, detail.summary, branchId, requestedScope));
    await this.container.conversationContext.rememberRoute(input.conversationId, { providerId: input.providerId, modelId: input.modelId });
    const model = await this.container.runtime.createWebModel({
      actor: this.container.actor,
      providerId: input.providerId,
      modelId: input.modelId,
      mode,
      runId: input.runId,
    });
    const tools = createDefaultWebAgentTools({
      context: {
        // The Web Agent execution scope also carries routing-only fields such as
        // agentId.  Context and memory services intentionally accept only the
        // canonical EffectiveContextScope, so always bind tool calls to the
        // frozen snapshot instead of passing the model-facing scope through.
        search: (query) => this.container.searchContext({ ...query, scope }),
        state: () => this.container.contextState(scope),
      },
    });
    const runtime = new WebAgentRuntime({
      model,
      tools,
      prompts: this.container.runtime.prompts,
      eventSink: (event) => this.container.broker.append(`conversation:${detail.summary.id}`, {
        eventId: event.eventId,
        producer: event.producer,
        kind: event.kind,
        status: null,
        ids: { conversationId: detail.summary.id, runId: input.runId },
        payload: event.payload,
      }),
    });
    const history = (await this.container.conversationContext.history(input.conversationId, branchId))
      .filter((entry) => entry.id !== target.id)
      .map(({ role, content }) => ({ role, content }));
    const persistentRun = await this.store.get(input.runId);
    const taskLifecycle = mode === "work" ? new RemoteTaskLifecycle(this.container, {
      providerId: input.providerId,
      modelId: input.modelId,
      messageId: target.id,
      runId: input.runId,
    }) : null;
    let result;
    let taskId = mode === "work" ? persistentRun?.taskIds?.at(-1) || null : null;
    let taskStatus = null;
    if (mode === "work" && taskId) {
      result = { runId: input.runId, content: "", reasoning: "", usage: null, iterations: 0, toolCallCount: 0, recovered: true };
    } else {
      result = await runtime.run({
        mode,
        actor: this.container.actor,
        scope: { ...requestedScope, ...scope, agentId: requestedScope.agentId || null },
        userMessage: target.content,
        context: history,
        runId: input.runId,
      });
    }
    if (mode === "work") {
      if (!taskId) {
        const dispatch = await taskLifecycle.dispatch({
          scope: { ...requestedScope, ...scope, agentId: requestedScope.agentId || null },
          userMessage: target.content,
          contextBrief: result.content,
          idempotencyKey: `${input.runId}:handoff`,
        });
        taskId = dispatch.taskId;
        await this.container.broker.append(`conversation:${detail.summary.id}`, {
          producer: "web-agent",
          kind: "run.handoff.dispatched",
          status: "completed",
          ids: { conversationId: detail.summary.id, runId: input.runId, taskId },
          payload: { operation: dispatch.operation, taskId },
        });
      }
      const observation = await taskLifecycle.waitFor(taskId);
      taskStatus = String(observation.task?.status || "");
      const remoteFinal = String(observation.report?.remoteFinal?.text || "").trim();
      if (taskStatus === "failed") {
        throw new ApiError(observation.task?.failure?.code || "REMOTE_AGENT_FAILED", observation.task?.failure?.message || "远端 Agent 执行失败", {
          status: 502,
          retryable: Boolean(observation.task?.failure?.retryable),
        });
      }
      if (taskStatus === "completed") {
        invariant(remoteFinal, "REMOTE_AGENT_FINAL_MISSING", "远端 Agent 已结束，但没有提供最终回复", { status: 502 });
        result = { ...result, content: remoteFinal };
      } else if (["interrupted", "cancelled", "waiting_approval"].includes(taskStatus)) {
        await this.container.broker.append(`conversation:${detail.summary.id}`, {
          producer: "web-agent",
          kind: "run.suspended",
          status: taskStatus,
          ids: { conversationId: detail.summary.id, runId: input.runId, taskId },
          payload: { taskId, taskStatus },
        });
        return { ...result, content: "", messageId: null, conversation: detail.summary, taskId, taskStatus };
      }
    }
    const latestDetail = await this.container.baseConversations.getConversation(input.conversationId);
    const latestMessages = await allMessages(this.container.baseConversations, input.conversationId, latestDetail.summary.activeBranchId);
    if (mode === "work" && taskId) {
      const taskRuns = await this.store.findByTask(taskId);
      const messageIndexes = new Map(latestMessages.map((message, index) => [message.id, index]));
      const owner = taskRuns
        .filter((record) => messageIndexes.has(record.input.messageId))
        .sort((left, right) => Number(messageIndexes.get(right.input.messageId)) - Number(messageIndexes.get(left.input.messageId)))[0];
      if (owner && owner.runId !== input.runId) {
        await this.container.broker.append(`conversation:${detail.summary.id}`, {
          producer: "web-agent",
          kind: "run.superseded",
          status: "completed",
          ids: { conversationId: detail.summary.id, runId: input.runId, taskId },
          payload: { supersededByRunId: owner.runId, taskId },
        });
        return { ...result, content: "", messageId: null, conversation: latestDetail.summary, taskId, taskStatus };
      }
    } else {
      invariant(latestMessages.at(-1)?.id === target.id, "RESPONSE_SUPERSEDED", "对话已出现更新的消息，本次回复不再落盘", { status: 409 });
    }
    const persisted = await this.container.baseConversations.sendMessage({
      conversationId: input.conversationId,
      branchId,
      role: "assistant",
      content: result.content,
      taskId,
      expectedRevision: latestDetail.summary.revision,
      commandId: `persist:${input.runId}`,
    });
    await this.container.broker.append(`conversation:${detail.summary.id}`, {
      producer: "web-agent",
      kind: "run.persisted",
      status: "completed",
      ids: { conversationId: detail.summary.id, messageId: persisted.messageId, runId: input.runId, ...(taskId ? { taskId } : {}) },
      payload: { conversationRevision: persisted.conversation.revision },
    });
    if (messages.length === 1 && detail.summary.title === defaultConversationTitle(target.content)) {
      try {
        const template = await this.container.runtime.prompts.task("conversation-title");
        const system = template
          .replace("{{USER_PROMPT}}", target.content)
          .replace("{{ASSISTANT_RESPONSE}}", result.content);
        const rawTitle = await this.container.runtime.completeAuxiliary({
          actor: this.container.actor,
          providerId: input.providerId,
          modelId: input.modelId,
          mode,
          runId: `title_${crypto.createHash("sha256").update(`${input.conversationId}:${target.id}`).digest("hex").slice(0, 32)}`,
          system,
          input: "输出对话标题。",
          maxOutputTokens: 64,
        });
        const title = normalizeGeneratedTitle(rawTitle);
        const latestConversation = await this.container.baseConversations.getConversation(input.conversationId);
        if (latestConversation.summary.title === defaultConversationTitle(target.content)) {
          const renamed = await this.container.baseConversations.rename({
            conversationId: input.conversationId,
            title,
            expectedRevision: latestConversation.summary.revision,
            commandId: derivedCommandId(`title:${input.conversationId}:${target.id}`, "rename"),
          });
          await this.container.broker.append(`conversation:${input.conversationId}`, {
            producer: "web-agent",
            kind: "conversation.title.updated",
            status: "completed",
            ids: { conversationId: input.conversationId, messageId: persisted.messageId, runId: input.runId },
            payload: { title, conversationRevision: renamed.conversation.revision },
          });
        }
      } catch { /* title generation is independent from the completed reply */ }
    }
    if (mode === "chat") {
      await this.container.taskRuntime.launch(`memory:${persisted.messageId}`, async () => {
        try {
          await this.container.memoryCoordinator.recordExchange({
            scope,
            userMessage: target.content,
            assistantMessage: result.content,
            source: { type: "conversation-message", id: persisted.messageId, version: String(persisted.conversation.revision) },
            authority: "model-inferred",
            providerId: input.providerId,
            modelId: input.modelId,
            mode,
            dedupeKey: `message:${persisted.messageId}`,
          });
        } catch { /* the completed reply remains authoritative when extraction fails */ }
      });
    }
    await this.container.taskRuntime.launch(`compact:${input.conversationId}:${persisted.messageId}`, async () => {
      try { await this.container.conversationContext.compactIfNeeded(input.conversationId); } catch { /* compression is independent from the reply */ }
    });
    return { ...result, messageId: persisted.messageId, conversation: persisted.conversation, taskId, taskStatus };
  }
}

export class ActorServiceContainer {
  static async create(runtime, actor) {
    const container = new ActorServiceContainer(runtime, actor);
    await container.#initialize();
    return container;
  }

  constructor(runtime, actor) {
    this.runtime = runtime;
    this.actor = actor;
    this.clock = runtime.clock;
    this.remoteBundles = new Map();
    this.agentDeployments = new Map();
  }

  async #initialize() {
    const common = { dataRoot: this.runtime.dataRoot, actor: this.actor, queue: this.runtime.queue, clock: this.clock };
    this.collections = new CollectionService({ ...common, deleteCoordinator: (input) => this.catalogConsistency.deleteCollection(input) });
    this.platform = this.runtime.platform;
    this.providers = this.runtime.providers;
    this.providerUsage = this.runtime.providerUsage;
    this.projects = new ProjectService({ ...common, collections: this.collections, deleteCoordinator: (input) => this.catalogConsistency.deleteProject(input) });
    this.baseConversations = new ConversationService({
      ...common,
      cursorSecret: this.runtime.secrets.cursorSecret,
      authorizeProject: async (projectId) => Boolean(await this.projects.get(projectId)),
    });
    this.workDrafts = new WorkDraftService(common);
    this.memory = new PersistentMemoryService(common);
    const memoryPrompt = await this.runtime.prompts.memory("persistent-memory-extract");
    this.memoryCoordinator = new MemoryCoordinator({
      ...common,
      memory: this.memory,
      prompt: memoryPrompt,
      extractor: ({ system, input, providerId, modelId, mode }) => this.runtime.completeAuxiliary({
        actor: this.actor,
        providerId,
        modelId,
        mode,
        runId: `memory_${crypto.createHash("sha256").update(`${input.scopeIds.conversation || this.actor.actorId}:${JSON.stringify(input)}`).digest("hex").slice(0, 32)}`,
        system,
        input,
      }),
    });
    this.conversationContext = new ConversationContextSettings({
      ...common,
      conversations: this.baseConversations,
      summarizer: async ({ providerId, modelId, existingCheckpoint, messages, conversationId }) => {
        const template = await this.runtime.prompts.memory("conversation-compact");
        const rendered = template
          .replace("{{EXISTING_CHECKPOINT}}", existingCheckpoint ? JSON.stringify(existingCheckpoint) : "null")
          .replace("{{MESSAGES}}", JSON.stringify(messages));
        return this.runtime.completeAuxiliary({
          actor: this.actor,
          providerId,
          modelId,
          mode: "chat",
          runId: `compact_${crypto.createHash("sha256").update(`${conversationId}:${messages.map((entry) => entry.id).join(",")}`).digest("hex").slice(0, 32)}`,
          system: rendered,
          input: "生成当前对话检查点。",
          maxOutputTokens: 12_000,
        });
      },
    });
    this.taskStore = new FileTaskStore(common);
    this.taskRuntime = new DetachedTaskRuntime(common);
    this.webInteractionStore = new PersistentWebInteractionStore(common);
    this.journal = new RealtimeEventJournal(common);
    this.broker = new RealtimeBroker({ journal: this.journal });
    this.audit = new AuditService({ ...common, cursorSecret: this.runtime.secrets.cursorSecret });
    this.contextHub = new ContextHub({
      ...common,
      sources: {
        system: async ({ consumer, scope }) => {
          if (consumer !== "remote-agent" || !scope.taskId) return [];
          const task = await this.taskStore.getTask(scope.taskId);
          if (!task) return [];
          const content = await this.runtime.prompts.agent(task.route.agentId);
          return [{
            id: `agent-system-${task.route.agentId}`,
            kind: "system",
            source: { type: "agent-prompt", id: task.route.agentId, version: crypto.createHash("sha256").update(content).digest("hex") },
            content,
            sensitivity: "private",
            priority: 10_000,
            required: true,
          }];
        },
        conversation: async ({ scope }) => {
          const history = await this.conversationContext.history(scope.conversationId, scope.branchId);
          return history.map((message, index) => ({
            id: message.id || `conversation-checkpoint-${scope.branchId}`,
            kind: message.role === "system" ? "conversation_state" : "message",
            source: { type: "conversation", id: message.id || scope.conversationId, version: message.id || `checkpoint:${scope.branchId}` },
            content: `${message.role}: ${message.content}`,
            sensitivity: "private",
            priority: message.role === "system" ? 75 : 60 - Math.min(index, 20),
          }));
        },
        task: async ({ scope }) => scope.taskId ? [{
          id: scope.taskId,
          kind: "task_state",
          source: { type: "task", id: scope.taskId, version: "current" },
          content: await this.taskStore.getTask(scope.taskId),
          sensitivity: "private",
          priority: 70,
        }] : [],
        memory: ({ scope }) => this.memory.contextEntries(scope),
        ...(this.runtime.contextSourcesFactory ? await this.runtime.contextSourcesFactory({ actor: this.actor, container: this }) : {}),
      },
    });
    this.resources = new ResourceService({
      ...common,
      mutationQueue: this.runtime.queue,
      authorizeOwner: ({ ownerType, ownerId }) => this.authorizeOwner(ownerType, ownerId),
      extractor: new DynamicResourceExtractor({ platform: this.runtime.platform, visionExtractor: this.runtime.visionExtractor }),
      embedder: new DynamicEmbeddingAdapter({ platform: this.runtime.platform, fetchImpl: this.runtime.fetchImpl }),
    });
    this.catalogConsistency = new CatalogConsistencyService({
      ...common,
      projects: this.projects,
      collections: this.collections,
      conversations: this.baseConversations,
      resources: this.resources,
      artifacts: { detachProject: (input) => this.artifacts.detachProject(input) },
      faultInjector: this.runtime.catalogFaultInjector,
    });
    this.skills = new SkillService({
      ...common,
      authorizeTask: async ({ taskId }) => Boolean(await this.taskStore.getTask(taskId)),
    });
    const inspectSkills = this.skills.inspect.bind(this.skills);
    this.skills.inspect = async () => {
      const inspected = await inspectSkills();
      return { data: inspected.data, meta: { revision: inspected.revision } };
    };
    this.servers = this.runtime.registryForActor(this.actor);
    this.sshWorker = this.runtime.sshPool.workerFor(this.actor);
    this.sshRestorePromise = this.sshWorker.restore().catch(() => []);
    this.serverCapabilities = new ServerCapabilityService({
      servers: this.servers,
      resolveRemoteBackend: (serverId) => this.remoteBackend(serverId),
      resolveScheduler: (serverId) => this.schedulerFor(serverId),
      clock: this.clock,
    });
    this.artifacts = new ArtifactService({
      ...common,
      mutationQueue: this.runtime.queue,
      cursorSecret: this.runtime.secrets.artifactSecret,
      authorizeTask: async ({ taskId }) => Boolean(await this.taskStore.getTask(taskId)),
      authorizeProject: async ({ projectId }) => Boolean(await this.projects.get(projectId)),
      remoteSource: {
        inspect: (input) => this.remoteArtifactSource(input.task.route.serverId).then((source) => source.inspect(input)),
        openReadStream: (input) => this.remoteArtifactSourceByIdentity(input.serverIdentity).then((source) => source.openReadStream(input)),
      },
      resourcePromoter: {
        promote: async ({ projectId, artifact, commandId, openSource }) => {
          const promoted = await this.resources.ingestStream({
            commandId,
            filename: artifact.name,
            mime: artifact.mime,
            expectedSize: artifact.size,
            expectedSha256: artifact.sha256,
            binding: { ownerType: "project", ownerId: projectId, path: null },
            openSource,
          });
          return { resourceVersionId: promoted.version.id, bindingId: promoted.binding.id };
        },
      },
    });
    this.taskReports = new TaskReportService({
      ...common,
      taskStore: this.taskStore,
      journal: this.journal,
      artifactService: this.artifacts,
    });
    await this.catalogConsistency.recoverPending();
    const previewHostSource = this.runtime.previewHostSourceFactory
      ? await this.runtime.previewHostSourceFactory({ actor: this.actor, container: this })
      : this.previewHostSource();
    const previewRemoteSource = this.runtime.previewRemoteSourceFactory
      ? await this.runtime.previewRemoteSourceFactory({ actor: this.actor, container: this })
      : this.previewRemoteSource();
    this.previews = new PreviewService({
      actor: this.actor,
      store: this.runtime.previewStore,
      clock: this.clock,
      hostSource: previewHostSource,
      remoteSource: previewRemoteSource,
      ...this.runtime.previewLimits,
    });
    const workspaceAdapter = new OrchestratorWorkspaceAdapter({ workspaceFactory: (serverId, identity) => this.workspaceFor(serverId, identity) });
    const versionAdapter = new OrchestratorVersionAdapter({ versionFactory: (serverId, identity) => this.versioningFor(serverId, identity) });
    const transport = this.runtime.agentTransportFactory
      ? await this.runtime.agentTransportFactory({ actor: this.actor, sshWorker: this.sshWorker, container: this })
      : new UnavailableAgentTransport();
    this.agentTransport = transport;
    this.agentAdapters = createAgentAdapters();
    this.orchestrator = new TaskOrchestrator({
      taskStore: this.taskStore,
      runtime: this.taskRuntime,
      transport,
      contextHub: this.contextHub,
      journal: new CanonicalTaskJournal(this.journal),
      workspaceService: workspaceAdapter,
      versionService: versionAdapter,
      artifactService: {
        capture: async (input) => {
          const captured = await this.artifacts.capture(input);
          return captured?.artifact || captured;
        },
      },
      skillService: this.skills,
      reportService: this.taskReports,
      adapters: this.agentAdapters,
      taskFinalizer: async ({ task, event }) => {
        const finalText = String(event?.payload?.text || event?.payload?.content || "").trim();
        if (!finalText) return;
        await this.taskRuntime.launch(`memory:${task.id}`, () => this.memoryCoordinator.recordTaskFinal({
          task,
          assistantMessage: finalText,
          source: { type: "remote-task", id: task.id, version: String(task.revision) },
        }));
      },
      clock: this.clock,
    });
    await this.sshRestorePromise;
    await this.orchestrator.recoverPending();
    this.interactions = new WebInteractionService(this, this.webInteractionStore);
    await this.interactions.initialize();
    this.conversations = new ConversationInteractionFacade(this.baseConversations, this.interactions, this.memoryCoordinator);
    this.featureFlags = Object.freeze({
      chat: true,
      work: Boolean(this.runtime.agentTransportFactory && this.runtime.remoteBackendFactory),
      resources: true,
      skills: true,
      artifacts: true,
      previews: true,
      workspaces: Boolean(this.runtime.remoteBackendFactory),
      scheduler: Boolean(this.runtime.remoteBackendFactory),
    });
  }

  async authorizeOwner(ownerType, ownerId) {
    if (ownerType === "collection") await this.collections.get(ownerId);
    else if (ownerType === "project") await this.projects.get(ownerId);
    else if (ownerType === "conversation") await this.baseConversations.getConversation(ownerId);
    else return false;
    return true;
  }

  async createPreview(input) {
    exactObject(input, ["source", "ttlMs"], "CreatePreview");
    exactObject(input.source, ["kind", "sourceId", "artifactId", "resourceVersionId", "serverId", "workspaceId", "relativePath"], "CreatePreview.source");
    const kind = String(input.source.kind || "");
    if (kind === "host") {
      exactObject(input.source, ["kind", "sourceId"], "CreatePreview.host");
      return this.previews.create({ source: { kind: "host", sourceId: String(input.source.sourceId || "") }, ttlMs: input.ttlMs });
    }
    if (kind === "artifact") {
      exactObject(input.source, ["kind", "artifactId"], "CreatePreview.artifact");
      return this.previews.create({ source: { kind: "host", sourceId: `artifact:${String(input.source.artifactId || "")}` }, ttlMs: input.ttlMs });
    }
    if (kind === "resource") {
      exactObject(input.source, ["kind", "resourceVersionId"], "CreatePreview.resource");
      return this.previews.create({ source: { kind: "host", sourceId: `resource:${String(input.source.resourceVersionId || "")}` }, ttlMs: input.ttlMs });
    }
    invariant(kind === "remote", "PREVIEW_SOURCE_INVALID", "Preview 来源无效", { status: 400 });
    exactObject(input.source, ["kind", "serverId", "workspaceId", "relativePath"], "CreatePreview.remote");
    const server = await this.servers.get(String(input.source.serverId || ""));
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    return this.previews.create({
      source: {
        kind: "remote",
        serverIdentity: server.profile.serverIdentity,
        workspaceId: String(input.source.workspaceId || ""),
        relativePath: String(input.source.relativePath || ""),
      },
      ttlMs: input.ttlMs,
    });
  }

  previewHostSource() {
    return {
      inspect: async ({ sourceId }) => {
        if (sourceId.startsWith("artifact:")) {
          const artifactId = sourceId.slice("artifact:".length);
          const artifact = await this.artifacts.get({ artifactId });
          const version = artifact.versions.at(-1);
          invariant(version, "PREVIEW_SOURCE_NOT_FOUND", "Artifact Preview 来源不存在", { status: 404 });
          return {
            authorized: true,
            size: version.size,
            name: artifact.name,
            mime: viewerMime(artifact.name, version.mime),
            supportsRange: true,
            metadata: { sourceType: "artifact", revision: artifact.revision },
            handle: { type: "artifact", artifactId, artifactRevision: artifact.revision, versionId: version.id },
          };
        }
        if (sourceId.startsWith("resource:")) {
          const versionId = sourceId.slice("resource:".length);
          const snapshot = await this.resources.inspect();
          const version = snapshot.data.versions.find((entry) => entry.id === versionId);
          invariant(version, "PREVIEW_SOURCE_NOT_FOUND", "Resource Preview 来源不存在", { status: 404 });
          const blob = snapshot.data.blobs.find((entry) => entry.id === version.blobId);
          invariant(blob, "PREVIEW_SOURCE_NOT_FOUND", "Resource Blob 不存在", { status: 404 });
          return {
            authorized: true,
            size: blob.size,
            name: version.filename,
            mime: viewerMime(version.filename, blob.mime),
            supportsRange: true,
            metadata: { sourceType: "resource", revision: version.revision },
            handle: { type: "resource", versionId, versionRevision: version.revision, blobId: blob.id, storagePath: blob.storagePath, sha256: blob.sha256 },
          };
        }
        invariant(false, "PREVIEW_SOURCE_NOT_FOUND", "Host Preview 来源不存在", { status: 404 });
      },
      openReadStream: async ({ handle, range }) => {
        invariant(handle && typeof handle === "object", "PREVIEW_SOURCE_STALE", "Preview 来源已失效", { status: 409 });
        if (handle.type === "artifact") {
          const artifact = await this.artifacts.get({ artifactId: handle.artifactId });
          const version = artifact.versions.at(-1);
          invariant(artifact.revision === handle.artifactRevision && version?.id === handle.versionId, "PREVIEW_SOURCE_STALE", "Artifact 已变化，请重新创建 Preview", { status: 409 });
          const issued = await this.artifacts.issueDownload({ artifactId: handle.artifactId, ttlMs: 60_000 });
          return (await this.artifacts.openDownload({ downloadToken: issued.downloadToken, range })).stream;
        }
        invariant(handle.type === "resource", "PREVIEW_SOURCE_STALE", "Preview 来源已失效", { status: 409 });
        const snapshot = await this.resources.inspect();
        const version = snapshot.data.versions.find((entry) => entry.id === handle.versionId);
        const blob = snapshot.data.blobs.find((entry) => entry.id === handle.blobId);
        invariant(version?.revision === handle.versionRevision && blob?.sha256 === handle.sha256 && blob.storagePath === handle.storagePath, "PREVIEW_SOURCE_STALE", "Resource 已变化，请重新创建 Preview", { status: 409 });
        if (range.endExclusive === range.start) return Readable.from([]);
        return fs.createReadStream(resolveActorPath(this.runtime.dataRoot, this.actor, handle.storagePath), { start: range.start, end: range.endExclusive - 1 });
      },
    };
  }

  previewRemoteSource() {
    return {
      inspect: async (input) => {
        const server = (await this.servers.list()).find((entry) => entry.profile.serverIdentity === input.serverIdentity);
        invariant(server, "SERVER_NOT_FOUND", "Preview 所属服务器不存在", { status: 404 });
        const workspaces = await this.workspaceFor(server.profile.id, input.serverIdentity);
        const workspace = await workspaces.getWorkspace(input.workspaceId);
        const source = await this.remoteArtifactSource(server.profile.id);
        const inspected = await source.inspect({ workspaceId: input.workspaceId, candidatePath: path.posix.join(workspace.canonicalPath, input.relativePath) });
        return { ...inspected, mime: viewerMime(inspected.name, inspected.mime), metadata: {} };
      },
      openReadStream: async (input) => {
        const source = await this.remoteArtifactSourceByIdentity(input.serverIdentity);
        return source.openReadStream(input);
      },
    };
  }

  async searchContext({ scope, query, sources, limit }) {
    const selected = new Set(sources || ["memory", "resources"]);
    const output = {};
    if (selected.has("memory")) output.memory = await this.memory.contextEntries(scope);
    if (selected.has("resources")) {
      try {
        output.resources = (await this.resources.search({ query, scope, limit })).results;
      } catch (error) {
        if (error?.code !== "RESOURCE_SCOPE_EMPTY") throw error;
        output.resources = [];
      }
    }
    if (selected.has("conversation")) output.conversation = await allMessages(this.baseConversations, scope.conversationId, scope.branchId);
    if (selected.has("skills")) {
      output.skills = await this.skills.searchContext({
        query,
        limit,
        selectedSkillVersions: scope.selectedSkillVersions,
      });
    }
    return output;
  }

  async contextState(scope) {
    const [conversation, project, server] = await Promise.all([
      this.baseConversations.getConversation(scope.conversationId),
      scope.projectId ? this.projects.get(scope.projectId) : null,
      scope.serverId ? this.servers.get(scope.serverId) : null,
    ]);
    return { conversation, project, server, scope };
  }

  async #remoteBundle(serverId, serverIdentity) {
    invariant(this.runtime.remoteBackendFactory, "REMOTE_CAPABILITY_UNAVAILABLE", "当前 Gateway 未配置远端文件与工作区 backend", { status: 503, retryable: true });
    const server = await this.servers.get(serverId);
    invariant(server.profile.serverIdentity === serverIdentity, "SERVER_IDENTITY_MISMATCH", "服务器身份与当前 SSH 配置不一致", { status: 409 });
    const key = `${serverId}:${serverIdentity}`;
    if (!this.remoteBundles.has(key)) {
      const backend = await this.runtime.remoteBackendFactory({ actor: this.actor, serverId, serverIdentity, server, sshWorker: this.sshWorker, container: this });
      invariant(backend?.remoteControl && backend?.remoteFs && backend?.remoteExec, "REMOTE_BACKEND_INVALID", "远端 backend 契约不完整", { status: 500, expose: false });
      const versioning = new VersioningService({ remoteFs: backend.remoteFs, remoteExec: backend.remoteExec, clock: this.clock });
      const workspaces = new WorkspaceService({
        actor: this.actor,
        dataRoot: this.runtime.dataRoot,
        remoteControl: backend.remoteControl,
        versioning,
        authorizeConversation: async (conversationId) => Boolean(await this.baseConversations.getConversation(conversationId)),
        queue: this.runtime.queue,
        clock: this.clock,
      });
      this.remoteBundles.set(key, { backend, versioning, workspaces });
    }
    return this.remoteBundles.get(key);
  }

  async workspaceFor(serverId, serverIdentity) {
    return (await this.#remoteBundle(serverId, serverIdentity)).workspaces;
  }

  async versioningFor(serverId, serverIdentity) {
    return (await this.#remoteBundle(serverId, serverIdentity)).versioning;
  }

  async schedulerFor(serverId) {
    const server = await this.servers.get(serverId);
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    const bundle = await this.#remoteBundle(serverId, server.profile.serverIdentity);
    invariant(bundle.backend.schedulerExecutor, "SCHEDULER_EXECUTOR_UNAVAILABLE", "远端 backend 未提供 Scheduler executor", { status: 503 });
    return new SchedulerService({
      actor: this.actor,
      dataRoot: this.runtime.dataRoot,
      serverIdentity: server.profile.serverIdentity,
      username: server.profile.username,
      adapter: new SlurmSchedulerAdapter(),
      executor: bundle.backend.schedulerExecutor,
      authorizeServer: async () => true,
      queue: this.runtime.queue,
      clock: this.clock,
    });
  }

  async remoteBackend(serverId) {
    const server = await this.servers.get(serverId);
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    return (await this.#remoteBundle(serverId, server.profile.serverIdentity)).backend;
  }

  async agentDeploymentFor(serverId) {
    invariant(this.runtime.agentDeploymentFactory, "AGENT_DEPLOYMENT_UNAVAILABLE", "当前 Gateway 未配置 Agent 部署能力", { status: 503, retryable: true });
    if (!this.agentDeployments.has(serverId)) {
      const server = await this.servers.get(serverId);
      invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
      const deployment = await this.runtime.agentDeploymentFactory({
        actor: this.actor,
        serverId,
        serverIdentity: server.profile.serverIdentity,
        server,
        sshWorker: this.sshWorker,
        container: this,
      });
      invariant(deployment, "AGENT_DEPLOYMENT_INVALID", "Agent 部署服务契约无效", { status: 500, expose: false });
      this.agentDeployments.set(serverId, deployment);
    }
    return this.agentDeployments.get(serverId);
  }

  async agentOperation(serverId, agentId, operation, input = {}) {
    exactObject(input, ["bindingId", "workspacePath", "source", "providerId", "modelId"], `Agent ${operation}`);
    const bindingId = String(input.bindingId || "");
    invariant(bindingId, "AGENT_BINDING_REQUIRED", "Agent 上下文操作需要 bindingId", { status: 400 });
    const adapter = this.agentAdapters[String(agentId)];
    invariant(adapter, "AGENT_ADAPTER_NOT_FOUND", "Agent adapter 不存在", { status: 404 });
    const binding = await this.taskRuntime.loadBinding(bindingId);
    invariant(binding, "AGENT_BINDING_NOT_FOUND", "Agent 对话尚未建立上下文 binding", { status: 404 });
    invariant(binding.adapterId === adapter.id, "AGENT_BINDING_ADAPTER_MISMATCH", "Agent binding 与当前 Agent 不一致", { status: 409 });
    const operationInput = {
      sessionId: binding.native?.sessionId || binding.state?.sessionId || undefined,
      threadId: binding.native?.threadId || binding.state?.sessionId || undefined,
      turnId: binding.native?.turnId || binding.state?.turnId || undefined,
      processId: binding.native?.processId || undefined,
      providerId: input.providerId,
      modelId: input.modelId,
      cwd: input.workspacePath,
    };
    const descriptor = adapter.operation(operation, operationInput);
    const run = await this.agentTransport.execute({
      task: { route: {
        serverId: String(serverId),
        agentId: adapter.id,
        ...(input.providerId ? { providerId: String(input.providerId) } : {}),
        ...(input.modelId ? { modelId: String(input.modelId) } : {}),
      } },
      adapterId: adapter.id,
      operation,
      descriptor,
      binding,
      workspace: input.workspacePath ? { path: String(input.workspacePath) } : null,
      skills: [],
      agentSource: input.source || binding.native?.agentSource || null,
    });
    let state = clone(binding.state);
    if (run.frames) {
      for await (const frame of run.frames) state = adapter.reduce(state, frame).state;
    }
    if (run.contextUsage !== undefined) state = { ...state, contextUsage: clone(run.contextUsage) };
    const patch = clone(run.bindingPatch || {});
    const next = {
      ...binding,
      ...patch,
      agentBindingId: binding.agentBindingId,
      adapterId: adapter.id,
      state: patch.state ? { ...state, ...patch.state } : state,
      native: { ...(binding.native || {}), ...(patch.native || {}) },
      activeRunId: run.runId || binding.activeRunId,
    };
    await this.taskRuntime.saveBinding(bindingId, next);
    return {
      operation,
      capability: adapter.capabilities[operation],
      contextUsage: next.state?.contextUsage || null,
      bindingId,
      runId: run.runId || null,
    };
  }

  async remoteArtifactSource(serverId) {
    const server = await this.servers.get(serverId);
    return this.remoteArtifactSourceByIdentity(server.profile.serverIdentity, serverId);
  }

  async remoteArtifactSourceByIdentity(serverIdentity, knownServerId = null) {
    let serverId = knownServerId;
    if (!serverId) {
      const match = (await this.servers.list()).find((entry) => entry.profile.serverIdentity === serverIdentity);
      invariant(match, "SERVER_NOT_FOUND", "Artifact 所属服务器不存在", { status: 404 });
      serverId = match.profile.id;
    }
    const bundle = await this.#remoteBundle(serverId, serverIdentity);
    invariant(bundle.backend.remoteArtifactSource, "ARTIFACT_REMOTE_STREAM_UNAVAILABLE", "远端 backend 未提供 Artifact source", { status: 503 });
    return bundle.backend.remoteArtifactSource;
  }

  async bootstrap(session) {
    const [conversationPage, allConversationItems, projectItems, serverItems, providerItems, runningTasks, resources] = await Promise.all([
      this.baseConversations.listConversations({ limit: 20 }),
      allConversations(this.baseConversations),
      this.projects.list(),
      this.servers.list(),
      this.runtime.providers.listAvailableProviders(this.actor, "web"),
      this.taskStore.listTasks({ statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_append", "interrupting", "recovering", "finalizing"], limit: 1000 }),
      this.resources.inspect(),
    ]);
    const taskByConversation = new Map(runningTasks.map((task) => [task.conversationId, task.id]));
    const projectConversationCounts = new Map();
    for (const conversation of allConversationItems) {
      if (conversation.projectId) projectConversationCounts.set(conversation.projectId, (projectConversationCounts.get(conversation.projectId) || 0) + 1);
    }
    const projectResourceCounts = new Map();
    for (const binding of resources.data.bindings) {
      if (binding.ownerType === "project" && binding.invalidatedSequence === null) projectResourceCounts.set(binding.ownerId, (projectResourceCounts.get(binding.ownerId) || 0) + 1);
    }
    const username = session.profile?.username || "访客";
    return {
      actor: {
        id: this.actor.actorId,
        type: this.actor.actorType,
        username,
        displayName: username,
        avatar: session.profile?.avatar || null,
        roles: [...(session.actor?.roles || this.actor.roles)],
      },
      device: {
        id: session.actor?.deviceId || this.actor.deviceId,
        firstVisit: Boolean(session.firstVisit),
        lastSeenAt: nowIso(this.clock),
      },
      featureFlags: {
        ...this.featureFlags,
        resources: Boolean((await this.runtime.platform.publicProvider("embedding")).configured),
      },
      providers: providerItems.map((provider) => ({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl || "",
        audience: provider.audience || provider.purpose || "web",
        source: provider.scope === "platform" ? "platform" : "user",
        configured: Boolean(provider.configured),
      })),
      projects: projectItems.map((project) => ({
        id: project.id,
        name: project.name,
        memoryMode: project.memoryMode,
        conversationCount: projectConversationCounts.get(project.id) || 0,
        resourceCount: projectResourceCounts.get(project.id) || 0,
        revision: project.revision,
        updatedAt: project.updatedAt,
      })),
      recentConversations: conversationPage.items.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        mode: conversation.mode,
        projectId: conversation.projectId,
        pinned: conversation.pinned,
        lastMessageAt: conversation.lastMessageAt,
        runningTaskId: taskByConversation.get(conversation.id) || null,
        revision: conversation.revision,
        updatedAt: conversation.updatedAt,
      })),
      conversationCursor: conversationPage.nextCursor || null,
      servers: serverItems.map(({ profile, connection, conversationIds }) => ({
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        serverIdentity: profile.serverIdentity || null,
        status: connection.status === "connected" || connection.status === "connecting" ? connection.status : "disconnected",
        activeConversationCount: conversationIds.length,
        capabilityStatus: "unknown",
        revision: profile.revision,
        updatedAt: profile.updatedAt,
      })),
      runningTasks: runningTasks.map((task) => ({
        id: task.id,
        conversationId: task.conversationId,
        branchId: task.branchId,
        goal: task.goal,
        route: {
          serverId: task.route.serverId,
          serverIdentity: task.route.serverIdentity,
          workspaceId: task.route.workspaceId,
          agentId: task.route.agentId,
        },
        agentBindingId: task.agentBindingId,
        status: task.status,
        taskEventSequence: task.taskEventSequence,
        plan: task.plan,
        failure: task.failure,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        revision: task.revision,
        updatedAt: task.updatedAt,
      })),
    };
  }

  async waitForIdle() {
    while (this.interactions.runs.size || this.taskRuntime.activeKeys().length) {
      await Promise.allSettled([...this.interactions.runs.values()]);
      await this.taskRuntime.waitForIdle();
    }
  }

  async close() {
    await this.waitForIdle();
    await this.previews.closeAll().catch(() => undefined);
    for (const entry of this.remoteBundles.values()) {
      if (typeof entry?.backend?.close === "function") await Promise.resolve(entry.backend.close()).catch(() => undefined);
    }
    for (const entry of this.agentDeployments.values()) if (typeof entry?.close === "function") await Promise.resolve(entry.close()).catch(() => undefined);
    this.remoteBundles.clear();
    this.agentDeployments.clear();
  }
}
