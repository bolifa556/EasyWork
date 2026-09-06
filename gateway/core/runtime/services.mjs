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
import { ApiError, invariant, redactSensitive } from "../errors.mjs";
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
import { agentSchedulerActivity, agentSubmissionReceipts, SchedulerSubmissionLedger, SchedulerSubmissionTracker } from "../scheduler/submissions.mjs";
import { createAgentBindingKey } from "../scope.mjs";
import {
  filterEligibleSkillObservations,
  isAutomaticSkillApplicable,
  isAutomaticSkillRelevantToRequest,
  isForcedWorkSkill,
  isSkillApplicableToMode,
} from "../skills/applicability.mjs";
import { SkillService } from "../skills/service.mjs";
import { taskTopic } from "../orchestrator/contract.mjs";
import { VersioningService } from "../versioning/service.mjs";
import { WebAgentRuntime } from "../web-agent/runtime.mjs";
import {
  filterRelevantHistoricalObservations,
  WebAgentObservationLedger,
} from "../web-agent/observations.mjs";
import {
  conversationKnowledgeUnit,
  createDefaultWebAgentTools,
  renderSemanticContext,
  semanticState,
} from "../web-agent/tools.mjs";
import { workSourceIntent } from "../web-agent/source-intent.mjs";
import { WorkspaceService } from "../workspaces/service.mjs";
import { createVirtualWorkspaceId } from "../workspaces/contract.mjs";
import { RemoteAgentConversationGarbageCollector } from "./agent-conversation-gc.mjs";
import { ServerCapabilityService } from "./server-capabilities.mjs";
import {
  DynamicEmbeddingAdapter,
  DynamicResourceExtractor,
  OrchestratorVersionAdapter,
  OrchestratorWorkspaceAdapter,
  UnavailableAgentTransport,
} from "./adapters.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const nowIso = (clock) => clock().toISOString();
export const WORK_WEB_AGENT_LIMITS = Object.freeze({
  // Retrieval ends when the required context is ready, not at a fixed step
  // count. Cancellation and stalled-request timeouts remain available.
  maxIterations: Infinity,
  maxToolCalls: Infinity,
  maxWallTimeMs: null,
  // Omit the provider's output-limit parameter. Reasoning and tool arguments
  // share that budget; a small local cap can cut off an otherwise valid call.
  maxOutputTokens: null,
});
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

function estimateMemoryTokens(value) {
  const text = String(value || "");
  let wide = 0;
  let narrow = 0;
  for (const character of text) {
    if (/^[\x00-\x7F]$/.test(character)) narrow += 1;
    else wide += 1;
  }
  return Math.max(1, Math.ceil(wide * 1.1 + narrow / 4));
}

function selectedWorkspaceName(routing = {}, workspace = null) {
  const workspaceId = String(routing.workspaceId || "").normalize("NFKC").trim();
  const explicit = String(routing.workspaceLabel || "").normalize("NFKC").trim();
  const opaqueWorkspace = (value) => Boolean(value && (value === workspaceId || /^ws_[a-z0-9]+$/iu.test(value)));
  if (explicit && explicit !== "已选工作区" && !opaqueWorkspace(explicit)) {
    return Array.from(explicit).slice(0, 120).join("");
  }
  if (workspace?.kind === "virtual" || routing.workspacePreparation?.kind === "virtual" || routing.deferWorkspaceState) return "虚拟工作区";
  const candidate = [routing.workspacePath, workspace?.canonicalPath]
    .map((value) => String(value || "").replaceAll("\\", "/").replace(/\/+$/, ""))
    .find((value) => value && !opaqueWorkspace(value)) || "";
  if (/(?:^|\/)\.easywork\/workspaces(?:\/|$)/u.test(candidate)) return "虚拟工作区";
  return candidate.split("/").filter(Boolean).at(-1) || "已选工作区";
}

export function workCurrentState(raw = {}, routing = {}) {
  const projected = semanticState(raw, ["server", "workspace", "agent"]);
  const selectedServerLabel = String(routing.serverLabel || "").normalize("NFKC").trim();
  const configuredServerName = String(raw?.server?.profile?.name || "").normalize("NFKC").trim();
  const serverName = selectedServerLabel && selectedServerLabel !== "已选服务器"
    ? selectedServerLabel
    : configuredServerName;
  const detectedScheduler = String(projected.server?.scheduler || "").trim().toLowerCase();
  const scheduler = ["slurm", "pbs", "generic"].includes(detectedScheduler) ? detectedScheduler : "";
  if (serverName || scheduler) {
    projected.server = {
      ...(serverName ? { name: Array.from(serverName).slice(0, 120).join("") } : {}),
      ...(scheduler ? { scheduler } : {}),
    };
  } else {
    delete projected.server;
  }
  const workspaceName = selectedWorkspaceName(routing, raw.workspace);
  projected.workspace = { name: workspaceName };
  return projected;
}

// Explicit @ conversation references are frozen, turn-local source material.
// They may be read, rewritten, and handed to the remote Agent, but must not be
// promoted into EasyWork memory merely because the Web Agent inspected them.
export function memoryExtractionObservations(fragments = []) {
  return (Array.isArray(fragments) ? fragments : [])
    .filter((fragment) => String(fragment?.toolName || "") !== "conversation_reference_read" && fragment?.rewritten !== true);
}

function handoffEventReferences(fragments = []) {
  const references = [];
  const indexes = new Map();
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    const kind = String(fragment?.reference?.kind || "").trim();
    const name = String(fragment?.reference?.name || "").trim();
    if (!kind || !name) continue;
    const key = `${kind}\0${name}`;
    const detail = kind.toLocaleLowerCase() === "skill" ? "" : String(fragment?.knowledge?.content || "").trim();
    const currentIndex = indexes.get(key);
    if (currentIndex !== undefined) {
      const current = references[currentIndex];
      if (fragment?.rewritten) current.edited = true;
      if (detail && !String(current.detail || "").includes(detail)) current.detail = current.detail ? `${current.detail}\n\n${detail}` : detail;
      continue;
    }
    indexes.set(key, references.length);
    references.push({ kind, name, ...(detail ? { detail } : {}), ...(fragment?.rewritten ? { edited: true } : {}) });
  }
  return references;
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

export function selectRetainedVersionCheckpoint(versionState, tasks, { boundaryRole = "assistant", followingTask = null } = {}) {
  const retainedIds = new Set((versionState?.checkpoints || [])
    .filter((checkpoint) => checkpoint?.status === "retained")
    .map((checkpoint) => String(checkpoint.id)));
  const candidates = [];
  const addTaskBoundary = (task, includeAfter = true) => {
    if (!task?.id || !task?.versionCheckpointId) return;
    if (includeAfter) candidates.push(`checkpoint_${task.id}_after`);
    candidates.push(String(task.versionCheckpointId));
  };

  // A user-message boundary excludes the following Task, so its before
  // checkpoint is authoritative. At an assistant boundary the latest
  // retained Task state is preferred; the next Task's before checkpoint is a
  // safe fallback when every visible Task was read-only.
  if (boundaryRole === "user") addTaskBoundary(followingTask, false);
  for (const task of [...(Array.isArray(tasks) ? tasks : [])].reverse()) addTaskBoundary(task, true);
  if (boundaryRole !== "user") addTaskBoundary(followingTask, false);
  return candidates.find((candidate) => retainedIds.has(candidate)) || null;
}

function normalizeGeneratedTitle(value) {
  const firstLine = String(value || "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || "";
  const normalized = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:标题|对话标题)\s*[:：]\s*/, "")
    .replace(/^[\s"'“”‘’《》【】]+|[\s"'“”‘’《》【】。！？.!?]+$/g, "")
    .trim();
  invariant(normalized.length > 0, "CONVERSATION_TITLE_GENERATION_EMPTY", "标题模型没有返回有效标题", { status: 502 });
  return normalized;
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

export function settledConversationHistory(history, currentMessageId = null, { retainTrailingUsers = false } = {}) {
  // Only the currently-running request is supplied separately.  The webpage
  // model may inspect every visible failed/retried request, but ordinary model
  // history and remote reconstruction must never reopen an unanswered request
  // as a new instruction.  Once a later retry succeeds, that failed request is
  // no longer trailing, so role-only tail trimming is insufficient: prefer the
  // durable assistant.replyToMessageId edge and retain the adjacent-pair rule
  // only for legacy messages that predate reply edges.
  const selected = (history || []).filter((entry) => !currentMessageId || entry.id !== currentMessageId);
  if (retainTrailingUsers) return selected;
  const byId = new Map(selected.flatMap((entry) => entry?.id ? [[String(entry.id), entry]] : []));
  const repliedUserIds = new Set();
  for (const assistant of selected) {
    if (assistant?.role !== "assistant" || !assistant.replyToMessageId) continue;
    // A running native Agent can receive more than one user message before it
    // emits its single final assistant body.  The final reply edge points to
    // the newest append, while each appended user message points to the
    // preceding visible message.  Walk that contiguous user chain so a later
    // Agent/workspace binding receives the whole human instruction sequence,
    // not just the last steering message.
    let cursor = byId.get(String(assistant.replyToMessageId));
    const visited = new Set();
    while (cursor?.role === "user" && cursor.id && !visited.has(String(cursor.id))) {
      const id = String(cursor.id);
      visited.add(id);
      repliedUserIds.add(id);
      cursor = cursor.replyToMessageId ? byId.get(String(cursor.replyToMessageId)) : null;
    }
  }
  return selected.filter((entry, index) => {
    if (entry.role !== "user") return true;
    if (entry.id && repliedUserIds.has(String(entry.id))) return true;
    const next = selected[index + 1];
    return next?.role === "assistant" && !next.replyToMessageId;
  });
}

export function workConversationState(history, currentMessageId = null) {
  // The selector needs the visible conversation (including answers) to resolve
  // follow-ups. Its own history is independent of native transcript delivery;
  // receipt identities and delivery decisions never enter these messages.
  return settledConversationHistory(history, currentMessageId, { retainTrailingUsers: true })
    .filter((entry) => ["system", "user", "assistant"].includes(entry?.role));
}

export async function workConversationTranscriptFragments(history, currentMessageId, prompts, { tasks = [] } = {}) {
  // A replyTo edge is also used for ordinary consecutive user turns. It does
  // not prove that an earlier cancelled preparation was delivered to native.
  const undelivered = new Set(tasks.filter((task) => !task.startedAt && !task.remoteRunId
    && ["failed", "interrupted", "cancelled"].includes(task.status)).map((task) => task.sourceMessageId));
  const messages = settledConversationHistory(history, currentMessageId)
    .filter((entry) => (entry?.role === "user" || entry?.role === "assistant") && !undelivered.has(entry.id));
  return (await Promise.all(messages.map(async (message) => {
    const knowledge = await conversationKnowledgeUnit(message, prompts);
    if (!knowledge) return null;
    return {
      toolName: "conversation_sync",
      rendered: knowledge.content,
      presented: {
        conversation: [{ role: message.role, content: String(message.content || "") }],
      },
      knowledge,
      priority: 100,
      required: true,
    };
  }))).filter(Boolean);
}

export function conversationCompactionBatch(history, keepCount = 4) {
  const messages = Array.isArray(history) ? history : [];
  let boundary = Math.max(0, messages.length - Math.max(0, Number(keepCount) || 0));
  if (!boundary) return { covered: [], summarized: [] };

  // Never leave an assistant response on the retained side while moving the
  // user request it directly answers into the checkpoint.  Reply edges are
  // authoritative; the adjacent-pair fallback keeps old conversations that
  // predate replyToMessageId internally consistent as well.
  const indexes = new Map(messages.flatMap((message, index) => message?.id ? [[String(message.id), index]] : []));
  for (;;) {
    let nextBoundary = boundary;
    for (const message of messages.slice(boundary)) {
      if (message?.role !== "assistant" || !message.replyToMessageId) continue;
      const requestIndex = indexes.get(String(message.replyToMessageId));
      if (Number.isSafeInteger(requestIndex) && requestIndex < nextBoundary) nextBoundary = requestIndex;
    }
    if (messages[boundary]?.role === "assistant"
      && !messages[boundary]?.replyToMessageId
      && messages[boundary - 1]?.role === "user") {
      nextBoundary = Math.min(nextBoundary, boundary - 1);
    }
    if (nextBoundary === boundary) break;
    boundary = nextBoundary;
    if (!boundary) return { covered: [], summarized: [] };
  }

  const covered = messages.slice(0, boundary);
  return {
    covered,
    // Failed or superseded webpage requests are safe to cover, but they must
    // not become instructions inside a durable context summary.
    summarized: settledConversationHistory(covered),
  };
}

function searchTokens(value) {
  const text = String(value || "").toLowerCase();
  const words = text.match(/[\p{L}\p{N}_-]+/gu) || [];
  const cjk = [...text.replace(/[^\p{Script=Han}]/gu, "")];
  return new Set([...words, ...cjk, ...cjk.slice(0, -1).map((entry, index) => entry + cjk[index + 1])]);
}

function textRelevance(value, query) {
  const expected = searchTokens(query);
  if (!expected.size) return 0;
  const actual = searchTokens(value);
  let score = 0;
  for (const token of expected) if (actual.has(token)) score += token.length > 1 ? 2 : 1;
  return score;
}

export function relevantConversationMessages(messages, {
  query,
  roles = [],
  limit = 8,
  excludeMessageId = null,
} = {}) {
  const entries = Array.isArray(messages) ? messages : [];
  const allowedRoles = new Set((Array.isArray(roles) ? roles : []).filter((role) => ["system", "user", "assistant"].includes(role)));
  const byId = new Map(entries.flatMap((message) => message?.id ? [[String(message.id), message]] : []));
  const requestedLimit = Math.min(20, Math.max(1, Number(limit) || 8));
  return entries
    .map((message, index) => {
      const legacyRequest = message?.role === "assistant" && !message?.replyToMessageId && entries[index - 1]?.role === "user"
        ? entries[index - 1]
        : null;
      const request = message?.role === "assistant"
        ? byId.get(String(message.replyToMessageId || "")) || legacyRequest
        : null;
      const searchable = [request?.content, message?.content].filter(Boolean).join("\n");
      return { message, index, score: textRelevance(searchable, query) };
    })
    .filter(({ message, score }) => message?.id !== excludeMessageId
      && (!allowedRoles.size || allowedRoles.has(message?.role))
      && score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, requestedLimit)
    .map((entry) => entry.message);
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

const CJK_TOKEN_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function estimatedTokens(value) {
  // This fallback is deliberately labelled as an estimate by the API/UI.  A
  // flat characters/4 rule severely under-counts Chinese, Japanese and Korean
  // text, so count those code points individually and retain the usual rough
  // four-characters-per-token rule only for ASCII text.
  let cjk = 0;
  let ascii = 0;
  let other = 0;
  for (const character of String(value || "")) {
    if (CJK_TOKEN_CHARACTER.test(character)) cjk += 1;
    else if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.max(0, cjk + other + Math.ceil(ascii / 4));
}

function minimumEstimatedTokens(value) {
  return Math.max(0, Math.ceil(String(value || "").length / 4));
}

function nativeWebUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const integer = (...candidates) => {
    for (const candidate of candidates) {
      const number = Number(candidate);
      if (Number.isSafeInteger(number) && number >= 0) return number;
    }
    return null;
  };
  const inputTokens = integer(value.prompt_tokens, value.input_tokens, value.promptTokens, value.inputTokens);
  const outputTokens = integer(value.completion_tokens, value.output_tokens, value.completionTokens, value.outputTokens);
  const reportedTotal = integer(value.total_tokens, value.totalTokens);
  const summed = inputTokens !== null || outputTokens !== null ? Number(inputTokens || 0) + Number(outputTokens || 0) : null;
  const totalTokens = reportedTotal === null ? summed : Math.max(reportedTotal, Number(summed || 0));
  return totalTokens !== null && totalTokens > 0 ? { inputTokens, outputTokens, totalTokens } : null;
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

  constructor({ dataRoot, actor, queue, clock, conversations, summarizer, prompts, runs = null }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
    this.conversations = conversations;
    this.summarizer = summarizer;
    this.prompts = prompts;
    this.runs = runs;
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

  async forget(conversationId) {
    const id = String(conversationId || "");
    const active = this.#compressions.get(id);
    if (active) await Promise.resolve(active).catch(() => undefined);
    const repository = this.#repository(id);
    for (;;) {
      const current = await repository.read();
      try {
        await repository.replace({ maxTokens: 200_000, autoCompactThreshold: 0.95, route: null, checkpoints: {} }, {
          expectedRevision: current.revision,
          clock: this.clock,
        });
        return { conversationId: id, cleared: true };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
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
    const { detail, stored, retained, checkpoint } = await this.#state(conversationId);
    const byRole = { user: 0, assistant: 0, system: 0 };
    const checkpointText = checkpoint ? await this.prompts.checkpointText(checkpoint.summary) : "";
    if (checkpointText) byRole.system += estimatedTokens(checkpointText);
    for (const message of retained) byRole[message.role] = (byRole[message.role] || 0) + estimatedTokens(message.content);
    const estimatedUsedTokens = Object.values(byRole).reduce((total, value) => total + value, 0);
    const native = await this.#latestNativeUsage(conversationId, retained, checkpoint, checkpointText, detail.summary.mode);
    const usedTokens = native?.usedTokens ?? estimatedUsedTokens;
    const limitTokens = stored.data.maxTokens;
    return {
      usage: {
        usedTokens,
        limitTokens,
        ratio: limitTokens ? Math.min(1, usedTokens / limitTokens) : 0,
        source: native?.source || "estimated",
        observedAt: native?.observedAt || null,
        parts: native?.parts || Object.entries(byRole).filter(([, tokens]) => tokens > 0).map(([kind, tokens]) => ({ kind, tokens, source: "estimated" })),
      },
      config: { maxTokens: stored.data.maxTokens, autoCompactThreshold: stored.data.autoCompactThreshold },
      revision: stored.revision,
      compressing: this.#compressions.has(String(conversationId)),
    };
  }

  async #latestNativeUsage(conversationId, retained, checkpoint, checkpointText, mode) {
    if (!this.runs || typeof this.runs.listCompleted !== "function") return null;
    const messageIndexes = new Map(retained.map((message, index) => [message.id, index]));
    const checkpointCreatedAt = checkpoint ? Date.parse(checkpoint.createdAt || 0) : 0;
    const records = (await this.runs.listCompleted())
      .filter((record) => record.input?.conversationId === String(conversationId) && messageIndexes.has(record.assistantMessageId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId));
    for (const record of records) {
      if (checkpointCreatedAt && Date.parse(record.updatedAt) <= checkpointCreatedAt) continue;
      const usage = nativeWebUsage(record.result?.usage);
      if (!usage) continue;
      const assistantIndex = messageIndexes.get(record.assistantMessageId);
      const activeThroughAssistant = retained.slice(0, assistantIndex + 1);
      const visibleMinimum = minimumEstimatedTokens(checkpointText)
        + activeThroughAssistant.reduce((total, message) => total + minimumEstimatedTokens(message.content), 0);
      // Reject incomplete or fabricated usage that is smaller than even a very
      // conservative lower bound for the visible messages.  This also keeps
      // tests and providers that omit real usage on the explicit estimate path.
      if (usage.totalTokens < visibleMinimum) continue;
      const assistant = retained[assistantIndex];
      const trailingTokens = retained.slice(assistantIndex + 1).reduce((total, message) => total + estimatedTokens(message.content), 0);
      const parts = [];
      let usedTokens;
      let source = trailingTokens ? "native-plus-estimate" : "native";
      if (mode === "work" && usage.inputTokens !== null) {
        // The Web Agent completion in Work mode is a handoff, while the
        // persisted assistant message is the remote Agent's final response.
        // Keep the provider-measured input and estimate only that replacement.
        const assistantTokens = estimatedTokens(assistant?.content || "");
        usedTokens = usage.inputTokens + assistantTokens + trailingTokens;
        parts.push({ kind: "model_input", tokens: usage.inputTokens, source: "native" });
        if (assistantTokens) parts.push({ kind: "remote_reply", tokens: assistantTokens, source: "estimated" });
        source = "native-plus-estimate";
      } else {
        usedTokens = usage.totalTokens + trailingTokens;
        if (usage.inputTokens !== null) parts.push({ kind: "model_input", tokens: usage.inputTokens, source: "native" });
        if (usage.outputTokens !== null) parts.push({ kind: "model_output", tokens: usage.outputTokens, source: "native" });
        if (!parts.length) parts.push({ kind: "model_total", tokens: usage.totalTokens, source: "native" });
      }
      if (trailingTokens) parts.push({ kind: "subsequent_messages", tokens: trailingTokens, source: "estimated" });
      return { usedTokens, source, observedAt: record.updatedAt, parts };
    }
    return null;
  }

  async history(conversationId, branchId) {
    const { retained, checkpoint } = await this.#state(conversationId, branchId);
    const checkpointContent = await this.prompts.checkpointText(checkpoint?.summary);
    return [
      ...(checkpointContent ? [{ role: "system", content: checkpointContent }] : []),
      ...retained.filter((entry) => ["user", "assistant"].includes(entry.role)).map((entry) => ({
        role: entry.role,
        content: entry.content,
        id: entry.id,
        ...(entry.replyToMessageId ? { replyToMessageId: entry.replyToMessageId } : {}),
        ...(entry.taskId ? { taskId: entry.taskId } : {}),
      })),
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
    const { covered: compactable, summarized } = conversationCompactionBatch(uncompressed, keepCount);
    if (!compactable.length) return this.get(conversationId);
    const existingCheckpoint = String(state.checkpoint?.summary || "").trim();
    const output = summarized.length ? await this.summarizer({
      providerId: route.providerId,
      modelId: route.modelId,
      existingCheckpoint: existingCheckpoint || null,
      messages: summarized.map(({ id, role, content, taskId, createdAt, replyToMessageId }) => ({
        id,
        role,
        content,
        taskId,
        createdAt,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      })),
      conversationId,
    }) : existingCheckpoint;
    const summary = String(output || "").trim();
    // With no earlier checkpoint, a prefix made solely of failed requests has
    // no semantic state to summarize.  Keep it visible instead of inventing a
    // synthetic instruction merely to reduce the token estimate.
    if (!summary && !summarized.length) return this.get(conversationId);
    invariant(summary, "CONVERSATION_COMPACTION_INVALID", "模型没有返回有效的对话摘要", { status: 502 });
    const coveredMessageIds = [...new Set([...(state.checkpoint?.coveredMessageIds || []), ...compactable.map((entry) => entry.id)])];
    await this.#replaceLatest(conversationId, (data) => {
      data.checkpoints[state.branchId] = {
        branchId: state.branchId,
        summary,
        coveredMessageIds,
        createdAt: this.clock().toISOString(),
      };
    });
    return this.get(conversationId);
  }
}

class ConversationInteractionFacade {
  constructor(base, interactions, memoryCoordinator, container) {
    this.base = base;
    this.interactions = interactions;
    this.memoryCoordinator = memoryCoordinator;
    this.container = container;
  }

  async #workRoute(conversationId, branchId) {
    const detail = await this.base.getConversation(conversationId);
    if (detail.summary.mode !== "work") return null;
    const binding = await this.container.servers.findConversationBinding(conversationId);
    if (!binding?.serverId) return null;
    const server = await this.container.servers.get(binding.serverId);
    if (!server.profile.serverIdentity) return null;
    const workspaces = await this.container.workspaceFor(binding.serverId, server.profile.serverIdentity);
    let route = await workspaces.getRoute({ conversationId, branchId });
    if (route) {
      await workspaces.ensureAgentBinding({
        conversationId,
        branchId,
        workspaceId: route.binding.workspaceId,
        agentId: route.binding.agentId,
        contextEpoch: route.binding.contextEpoch,
        commandId: `ensure-version-${crypto.createHash("sha256").update(route.binding.id).digest("hex").slice(0, 24)}`,
        expectedRevision: 0,
      });
      route = await workspaces.getRoute({ conversationId, branchId });
    }
    return route ? { binding, server, workspaces, route } : null;
  }

  async #advanceWorkEpoch(conversationId, branchId, commandId) {
    const route = await this.#workRoute(conversationId, branchId);
    if (!route) return null;
    return route.workspaces.advanceContextEpoch({
      conversationId,
      branchId,
      commandId: derivedCommandId(commandId, "context-epoch"),
    });
  }

  #agentBindingKey(workRoute, conversationId, branchId) {
    const binding = workRoute?.route?.binding;
    if (!binding) return null;
    return createAgentBindingKey({
      actorType: this.container.actor.actorType,
      actorId: this.container.actor.actorId,
      serverIdentity: workRoute.server.profile.serverIdentity,
      workspaceId: binding.workspaceId,
      conversationId,
      branchId,
      contextEpoch: binding.contextEpoch,
    }, binding.agentId);
  }

  async #executeNativeBindingOperation({ binding, operation, operationInput, configScope, workspacePath, recoveredSkillPins = [] }) {
    const adapter = this.container.agentAdapters[String(binding?.adapterId || "")];
    invariant(adapter, "AGENT_ADAPTER_NOT_FOUND", "Agent adapter 不存在", { status: 404 });
    const descriptor = adapter.operation(operation, operationInput);
    const route = clone(binding.route || {});
    const run = await this.container.agentTransport.execute({
      task: { conversationId: String(configScope), route },
      adapterId: adapter.id,
      operation,
      descriptor,
      binding: clone(binding),
      workspace: workspacePath ? { path: String(workspacePath) } : null,
      skills: [],
      recoveredSkillPins: clone(recoveredSkillPins),
      agentSource: binding.native?.agentSource || null,
    });
    const patch = clone(run.bindingPatch || {});
    const next = {
      ...binding,
      ...patch,
      agentBindingId: binding.agentBindingId,
      adapterId: adapter.id,
      route,
      state: patch.state ? { ...binding.state, ...patch.state } : binding.state,
      native: { ...(binding.native || {}), ...(patch.native || {}) },
      activeRunId: run.runId || binding.activeRunId || null,
    };
    await this.container.taskRuntime.saveBinding(binding.agentBindingId, next);
    return {
      ...next,
      ...(run.nativeBoundaryMap ? { operationMetadata: { nativeBoundaryMap: clone(run.nativeBoundaryMap) } } : {}),
    };
  }

  async #legacySkillPinsAtTask(sourceTask) {
    const summaries = await this.container.taskStore.listTasks({ conversationId: sourceTask.conversationId, limit: 1000 });
    const tasks = await Promise.all(summaries.filter((task) => task.createdAt <= sourceTask.createdAt).map((task) => this.container.taskStore.getTask(task.id)));
    const pins = new Map();
    for (const task of tasks.filter((task) => task && task.agentBindingId === sourceTask.agentBindingId && task.status === "completed").sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      for (const pin of task.skillPins || []) pins.set(pin.skillId, pin);
    }
    return [...pins.values()];
  }

  async #tryNativeAgentFork({ sourceTask, targetConversationId, targetBranchId, inheritedConversationUnits = [] }) {
    if (!sourceTask || sourceTask.status !== "completed") return { applied: false, reason: "boundary_not_completed" };
    const sourceBinding = await this.container.taskRuntime.loadBinding(sourceTask.agentBindingId);
    const adapter = this.container.agentAdapters[String(sourceBinding?.adapterId || "")];
    if (!adapter || adapter.capabilities.fork?.availability !== "available") return { applied: false, reason: "adapter_without_native_boundary_fork" };
    const sourceNativeSessionId = sourceBinding.native?.threadId || sourceBinding.native?.sessionId || sourceBinding.state?.sessionId || null;
    if (!sourceNativeSessionId) return { applied: false, reason: "source_native_session_unavailable" };
    const checkpoint = await this.container.contextHub.getBindingCheckpoint({
      bindingKey: sourceTask.agentBindingId,
      nativeSessionId: sourceNativeSessionId,
      checkpointId: sourceTask.id,
    });
    const boundary = checkpoint?.nativeBoundary || null;
    const boundarySessionId = boundary?.sessionId || sourceNativeSessionId;
    const lastTurnId = boundary?.turnId || null;
    if (!lastTurnId) return { applied: false, reason: "source_turn_boundary_unavailable" };
    if (adapter.id === "opencode" && String(boundary?.protocol || sourceBinding.native?.protocol || "") === "v2") {
      return { applied: false, reason: "opencode_v2_without_native_fork" };
    }
    const targetRoute = await this.#workRoute(targetConversationId, targetBranchId);
    if (!targetRoute || targetRoute.route.binding.agentId !== adapter.id) return { applied: false, reason: "target_route_mismatch" };
    const targetBindingId = this.#agentBindingKey(targetRoute, targetConversationId, targetBranchId);
    const existing = await this.container.taskRuntime.loadBinding(targetBindingId);
    if (existing) {
      const nativeSessionId = existing.native?.threadId || existing.native?.sessionId || existing.state?.sessionId || null;
      return nativeSessionId
        ? { applied: true, bindingId: targetBindingId, nativeSessionId, idempotentReplay: true }
        : { applied: false, reason: "target_binding_incomplete" };
    }
    const targetWorkspace = targetRoute.route.workspace;
    const route = {
      ...clone(sourceBinding.route || {}),
      serverId: String(targetRoute.binding.serverId),
      serverIdentity: String(targetRoute.server.profile.serverIdentity),
      workspaceId: String(targetWorkspace.id),
      agentId: adapter.id,
    };
    const targetBinding = {
      schemaVersion: 1,
      agentBindingId: targetBindingId,
      adapterId: adapter.id,
      route,
      state: adapter.createState(),
      native: {
        ...(sourceBinding.native?.agentSource ? { agentSource: sourceBinding.native.agentSource } : {}),
        // Native transcripts are shared, while process HOME, configuration and
        // selected Skills remain isolated by the new webpage binding.
        runtimeBindingId: String(sourceBinding.native?.runtimeBindingId || sourceBinding.agentBindingId),
        // A native branch inherits the source transcript and therefore also
        // inherits the exact Skill capabilities that transcript could use.
        // Pins are copied as identities only; execute() materializes a fresh
        // branch-local discovery view from the immutable server cache.
        skillPins: clone(boundary?.skillSnapshot?.skillPins || sourceBinding.native?.skillCheckpoints?.[sourceTask.id]?.skillPins || await this.#legacySkillPinsAtTask(sourceTask)),
        ...((boundary?.skillSnapshot || sourceBinding.native?.skillCheckpoints?.[sourceTask.id]) ? { skillSnapshot: clone(boundary?.skillSnapshot || sourceBinding.native.skillCheckpoints[sourceTask.id]) } : {}),
      },
      activeRunId: null,
      activeCommandId: null,
    };
    try {
      const targetSessionId = crypto.randomUUID();
      const operationInput = adapter.id === "codex"
        ? {
            threadId: boundarySessionId,
            path: String(boundary?.rolloutPath || sourceBinding.native?.rolloutPath || ""),
            lastTurnId,
            cwd: targetWorkspace.canonicalPath,
          }
        : adapter.id === "opencode"
          ? { sessionId: boundarySessionId, retainedMessageId: lastTurnId }
          : {
              sourceSessionId: boundarySessionId,
              targetSessionId,
              resumeSessionAt: lastTurnId,
            };
      if (adapter.id === "codex" && !operationInput.path) return { applied: false, reason: "source_rollout_unavailable" };
      const forked = await this.#executeNativeBindingOperation({
        binding: targetBinding,
        operation: "fork",
        operationInput,
        configScope: targetConversationId,
        workspacePath: targetWorkspace.canonicalPath,
        recoveredSkillPins: targetBinding.native.skillPins,
      });
      const targetNativeSessionId = forked.native?.threadId || forked.native?.sessionId || forked.state?.sessionId || null;
      invariant(targetNativeSessionId, "AGENT_NATIVE_SESSION_MISSING", `${adapter.id} fork 未返回新的原生会话`, { status: 502 });
      await this.container.contextHub.forkBindingCheckpoint({
        sourceBindingKey: sourceTask.agentBindingId,
        sourceNativeSessionId,
        targetBindingKey: targetBindingId,
        targetNativeSessionId,
        checkpointId: sourceTask.id,
        inheritedUnits: inheritedConversationUnits,
        nativeBoundaryMap: forked.operationMetadata?.nativeBoundaryMap || null,
        targetNativeBoundary: {
          protocol: forked.native?.protocol || boundary?.protocol || sourceBinding.native?.protocol || null,
          rolloutPath: forked.native?.rolloutPath || null,
        },
      });
      return { applied: true, adapterId: adapter.id, bindingId: targetBindingId, nativeSessionId: targetNativeSessionId };
    } catch (error) {
      await this.container.taskRuntime.clearBindings([targetBindingId]).catch(() => undefined);
      return {
        applied: false,
        reason: String(error?.code || "native_fork_failed"),
        detail: String(error?.message || "").slice(0, 500),
      };
    }
  }

  async #tryNativeAgentRevert({ conversationId, branchId, removedMessages, retainedMessages }) {
    const workRoute = await this.#workRoute(conversationId, branchId);
    if (!workRoute) return { applied: false, reason: "work_route_unavailable" };
    const bindingId = this.#agentBindingKey(workRoute, conversationId, branchId);
    const binding = await this.container.taskRuntime.loadBinding(bindingId);
    const adapter = this.container.agentAdapters[String(binding?.adapterId || "")];
    if (!binding || !adapter || adapter.capabilities.revert?.availability !== "available") return { applied: false, reason: "adapter_without_native_revert" };
    const nativeSessionId = binding.native?.threadId || binding.native?.sessionId || binding.state?.sessionId || null;
    if (!nativeSessionId) return { applied: false, reason: "native_session_unavailable" };
    const removedTasks = (await this.#tasksFromSourceMessages(conversationId, removedMessages))
      .filter((task) => task.agentBindingId === bindingId);
    if (!removedTasks.length) return { applied: true, bindingId, nativeSessionId, unchanged: true };
    const removedTaskIds = new Set(removedTasks.map((task) => task.id));
    const retainedTasks = (await this.#tasksFromSourceMessages(conversationId, retainedMessages || []))
      // A native webpage branch copies its source receipt checkpoint into the
      // child binding without rewriting the historical Task's binding id.
      // Resolve retained boundaries by their presence in the current receipt,
      // not by the Task's original binding, so the first child turn can be
      // regenerated through the native Agent instead of starting a new epoch.
      .filter((task) => !removedTaskIds.has(task.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    let retainedTask = null;
    let retainedCheckpoint = null;
    for (const task of [...retainedTasks].reverse()) {
      const checkpoint = await this.container.contextHub.getBindingCheckpoint({
        bindingKey: bindingId,
        nativeSessionId,
        checkpointId: task.id,
      });
      if (checkpoint?.nativeBoundary?.turnId) {
        retainedTask = task;
        retainedCheckpoint = checkpoint;
        break;
      }
    }
    if (!retainedTask || !retainedCheckpoint) return { applied: false, reason: "retained_receipt_boundary_unavailable" };
    const retainedBoundary = retainedCheckpoint.nativeBoundary;
    const retainedSessionId = retainedBoundary.sessionId || nativeSessionId;
    const retainedTurnId = retainedBoundary.turnId;
    const removedCheckpoints = (await Promise.all(removedTasks.map((task) => (
      this.container.contextHub.getBindingCheckpoint({ bindingKey: bindingId, nativeSessionId, checkpointId: task.id })
    )))).filter(Boolean);
    const currentSessionContainsRemovedTurn = removedCheckpoints.some((checkpoint) => (
      String(checkpoint?.nativeBoundary?.sessionId || nativeSessionId) === String(nativeSessionId)
      && checkpoint?.nativeBoundary?.turnId
    ));
    if (adapter.id === "opencode"
      && retainedSessionId !== nativeSessionId
      && !currentSessionContainsRemovedTurn
      && String(retainedBoundary.protocol || "") === "v2") {
      return { applied: false, reason: "opencode_v2_without_native_fork" };
    }
    try {
      let reverted;
      let targetNativeSessionId = nativeSessionId;
      let inPlace = false;
      if (adapter.id === "codex" && (retainedSessionId === nativeSessionId || currentSessionContainsRemovedTurn)) {
        let beforeTurnId = null;
        for (const checkpoint of removedCheckpoints) {
          if (checkpoint?.nativeBoundary?.turnId) {
            beforeTurnId = checkpoint.nativeBoundary.turnId;
            break;
          }
        }
        if (!beforeTurnId && removedTasks.length === 1) beforeTurnId = binding.native?.turnId || binding.state?.turnId || null;
        if (!beforeTurnId) return { applied: false, reason: "removed_turn_boundary_unavailable" };
        reverted = await this.#executeNativeBindingOperation({
          binding,
          operation: "revert",
          operationInput: { threadId: nativeSessionId, beforeTurnId },
          configScope: conversationId,
          workspacePath: workRoute.route.workspace.canonicalPath,
        });
        inPlace = true;
      } else if (adapter.id === "opencode" && (retainedSessionId === nativeSessionId || currentSessionContainsRemovedTurn)) {
        const stagedV2 = String(binding.native?.protocol || retainedBoundary.protocol || "") === "v2";
        reverted = await this.#executeNativeBindingOperation({
          binding,
          operation: "revert",
          operationInput: {
            sessionId: nativeSessionId,
            retainedMessageId: retainedTurnId,
            ...(stagedV2 ? { stageOnly: true } : {}),
          },
          configScope: conversationId,
          workspacePath: workRoute.route.workspace.canonicalPath,
        });
        inPlace = true;
      } else {
        const targetSessionId = crypto.randomUUID();
        const operation = adapter.id === "claude-code" ? "revert" : "fork";
        const operationInput = adapter.id === "codex"
          ? {
              threadId: retainedSessionId,
              path: String(retainedBoundary.rolloutPath || binding.native?.rolloutPath || ""),
              lastTurnId: retainedTurnId,
              cwd: workRoute.route.workspace.canonicalPath,
            }
          : adapter.id === "opencode"
            ? { sessionId: retainedSessionId, retainedMessageId: retainedTurnId }
            : { sourceSessionId: retainedSessionId, targetSessionId, resumeSessionAt: retainedTurnId };
        if (adapter.id === "codex" && !operationInput.path) return { applied: false, reason: "source_rollout_unavailable" };
        reverted = await this.#executeNativeBindingOperation({
          binding,
          operation,
          operationInput,
          configScope: conversationId,
          workspacePath: workRoute.route.workspace.canonicalPath,
        });
        targetNativeSessionId = reverted.native?.threadId || reverted.native?.sessionId || reverted.state?.sessionId || null;
        invariant(targetNativeSessionId, "AGENT_NATIVE_SESSION_MISSING", `${adapter.id} 原生边界恢复未返回 session id`, { status: 502 });
      }
      if (inPlace) {
        await this.container.contextHub.restoreBindingCheckpoint({
          bindingKey: bindingId,
          nativeSessionId,
          checkpointId: retainedTask.id,
        });
      } else {
        await this.container.contextHub.forkBindingCheckpoint({
          sourceBindingKey: bindingId,
          sourceNativeSessionId: nativeSessionId,
          targetBindingKey: bindingId,
          targetNativeSessionId,
          checkpointId: retainedTask.id,
          nativeBoundaryMap: reverted.operationMetadata?.nativeBoundaryMap || null,
          targetNativeBoundary: {
            protocol: reverted.native?.protocol || retainedBoundary.protocol || binding.native?.protocol || null,
            rolloutPath: reverted.native?.rolloutPath || null,
          },
        });
      }
      await this.container.taskRuntime.saveBinding(bindingId, {
        ...reverted,
        state: { ...reverted.state, turnId: retainedTurnId, status: "idle" },
        native: { ...reverted.native, turnId: retainedTurnId },
        activeRunId: retainedTask.remoteRunId || null,
        activeCommandId: null,
      });
      return {
        applied: true,
        adapterId: adapter.id,
        bindingId,
        nativeSessionId: targetNativeSessionId,
        inPlace,
        restoredWorkspace: adapter.id === "opencode" && inPlace,
        staged: adapter.id === "opencode" && inPlace && String(binding.native?.protocol || retainedBoundary.protocol || "") === "v2",
        restoredCheckpointId: retainedTask.id,
      };
    } catch (error) {
      return { applied: false, reason: String(error?.code || "native_revert_failed"), detail: String(error?.message || "").slice(0, 500) };
    }
  }

  async #tasksFromMessages(messages) {
    const taskIds = [...new Set((messages || []).map((entry) => entry.taskId).filter(Boolean))];
    return (await Promise.all(taskIds.map((taskId) => this.container.taskStore.getTask(taskId).catch(() => null)))).filter(Boolean);
  }

  async #tasksFromSourceMessages(conversationId, messages) {
    const taskIds = new Set((messages || []).map((entry) => entry.taskId).filter(Boolean));
    const records = await Promise.all((messages || []).map((entry) => (
      this.container.webInteractionStore.findByMessage(conversationId, entry.id)
    )));
    for (const record of records.flat()) for (const taskId of record.taskIds || []) taskIds.add(taskId);
    const tasks = (await Promise.all([...taskIds].map((taskId) => this.container.taskStore.getTask(taskId).catch(() => null)))).filter(Boolean);
    return tasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async #versionScopesForTasks(workRoute, conversationId, branchId, tasks, commandId) {
    if (!workRoute || !tasks.length) return [];
    const serverIdentity = workRoute.server.profile.serverIdentity;
    const workspaceIds = new Set(tasks
      .filter((task) => task.conversationId === conversationId && task.branchId === branchId && task.route?.serverIdentity === serverIdentity && task.versionCheckpointId)
      .map((task) => task.route.workspaceId));
    if (!workspaceIds.size) return [];
    const bindings = await workRoute.workspaces.listBindings({ conversationId, branchId });
    const latestBindingByWorkspace = new Map();
    for (const binding of bindings) {
      if (binding.serverIdentity !== serverIdentity || !workspaceIds.has(binding.workspaceId)) continue;
      const current = latestBindingByWorkspace.get(binding.workspaceId);
      if (!current
        || (current.status !== "active" && binding.status === "active")
        || (current.status === binding.status && binding.contextEpoch > current.contextEpoch)
        || (current.status === binding.status && binding.contextEpoch === current.contextEpoch && binding.updatedAt > current.updatedAt)) {
        latestBindingByWorkspace.set(binding.workspaceId, binding);
      }
    }
    const versioning = await this.container.versioningFor(workRoute.binding.serverId, serverIdentity);
    const scopes = [];
    for (const workspaceId of [...workspaceIds].sort()) {
      const sourceBinding = latestBindingByWorkspace.get(workspaceId);
      invariant(sourceBinding, "VERSION_WORKSPACE_BINDING_MISSING", "找不到文件历史对应的工作区绑定", {
        status: 409,
        details: { conversationId, branchId, workspaceId },
      });
      const ensured = await workRoute.workspaces.ensureAgentBinding({
        conversationId,
        branchId,
        workspaceId,
        agentId: sourceBinding.agentId,
        contextEpoch: sourceBinding.contextEpoch,
        commandId: derivedCommandId(commandId, `ensure-version-${crypto.createHash("sha256").update(workspaceId).digest("hex").slice(0, 16)}`),
        expectedRevision: 0,
      });
      const workspace = await workRoute.workspaces.getWorkspace(workspaceId);
      scopes.push({
        workspace,
        binding: ensured.binding,
        versioning,
        locator: {
          actorId: this.container.actor.actorId,
          serverIdentity,
          versionDomainId: ensured.binding.versionDomainId,
        },
      });
    }
    if (!scopes.length) return [];
    // The file history is conversation-wide. Bindings for different
    // workspaces and Agents intentionally resolve to the same ledger, so one
    // locator covers every path touched by these Tasks.
    return [{ ...scopes[0], workspaceIds: [...workspaceIds] }];
  }

  async #rewindWorkFiles(conversationId, branchId, removedMessages, commandId, retainedMessages = null, options = {}) {
    const route = await this.#workRoute(conversationId, branchId);
    if (!route) return null;
    const retainedTasks = await this.#tasksFromMessages(retainedMessages || []);
    const removedTaskIds = new Set((removedMessages || []).map((entry) => entry.taskId).filter(Boolean));
    const firstRemovedAt = (removedMessages || []).map((entry) => entry.createdAt).filter(Boolean).sort()[0] || null;
    const taskSummaries = await this.container.taskStore.listTasks({ conversationId, limit: 1000 });
    const branchTasks = (await Promise.all(taskSummaries.map((task) => this.container.taskStore.getTask(task.id)))).filter(Boolean);
    const removedTasks = branchTasks
      .filter((task) => task.branchId === branchId && task.versionCheckpointId)
      .filter((task) => removedTaskIds.has(task.id) || (firstRemovedAt && task.createdAt >= firstRemovedAt))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    if (!removedTasks.length) return null;
    const scopes = await this.#versionScopesForTasks(route, conversationId, branchId, removedTasks, derivedCommandId(commandId, "rewind-scopes"));
    const requests = [];
    for (const scope of scopes) {
      const retainedInWorkspace = retainedTasks
        .filter((task) => task.branchId === branchId && task.versionCheckpointId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const removedInWorkspace = removedTasks;
      if (!removedInWorkspace.length) continue;
      const state = await scope.versioning.getDomain(scope.locator);
      const targetCheckpointId = selectRetainedVersionCheckpoint(state, retainedInWorkspace, {
        boundaryRole: "assistant",
        followingTask: removedInWorkspace[0] || null,
      });
      invariant(targetCheckpointId, "VERSION_REWIND_BOUNDARY_MISSING", "工作区没有可恢复的文件 Checkpoint", {
        status: 409,
        details: { conversationId, branchId },
      });
      requests.push({
        scope,
        locator: scope.locator,
        branchId,
        targetCheckpointId,
        rewindId: derivedCommandId(commandId, "version-rewind-conversation"),
      });
    }
    if (!requests.length) return null;
    await this.#ensureVersionWorkspacesIdle(
      route.server.profile.serverIdentity,
      requests.flatMap((request) => request.scope.workspaceIds),
    );
    const batch = await requests[0].scope.versioning.rewindBatch(requests.map(({ locator, branchId: requestBranchId, targetCheckpointId, rewindId }) => ({
      locator,
      branchId: requestBranchId,
      targetCheckpointId,
      rewindId,
    })), { dryRun: options.dryRun === true });
    invariant(batch.applied, batch.conflict?.code || "VERSION_REWIND_FAILED", batch.conflict?.message || "无法安全回退工作区文件", {
      status: 409,
      details: batch.conflict || undefined,
    });
    return {
      applied: true,
      ...(batch.preview ? { preview: true } : {}),
      workspaces: requests.flatMap((request, index) => request.scope.workspaceIds.map((workspaceId) => ({
        workspaceId,
        targetCheckpointId: request.targetCheckpointId,
        result: batch.results[index],
      }))),
    };
  }

  async #rewindWorkAndNative({ conversationId, branchId, removedMessages, retainedMessages, commandId }) {
    const workRoute = await this.#workRoute(conversationId, branchId);
    const openCode = workRoute?.route?.binding?.agentId === "opencode";
    if (openCode) {
      await this.#rewindWorkFiles(conversationId, branchId, removedMessages, commandId, retainedMessages, { dryRun: true });
    } else {
      await this.#rewindWorkFiles(conversationId, branchId, removedMessages, commandId, retainedMessages);
    }
    const native = await this.#tryNativeAgentRevert({ conversationId, branchId, removedMessages, retainedMessages });
    if (openCode) {
      try {
        await this.#rewindWorkFiles(conversationId, branchId, removedMessages, commandId, retainedMessages);
      } catch (error) {
        if (native.applied && native.restoredWorkspace) {
          const binding = await this.container.taskRuntime.loadBinding(native.bindingId).catch(() => null);
          if (binding) {
            await this.#executeNativeBindingOperation({
              binding,
              operation: "revert",
              operationInput: { sessionId: native.nativeSessionId, undo: true },
              configScope: conversationId,
              workspacePath: workRoute.route.workspace.canonicalPath,
            }).catch(() => undefined);
          }
        }
        await this.#advanceWorkEpoch(conversationId, branchId, commandId).catch(() => undefined);
        throw error;
      }
    }
    if (native.applied && native.staged) {
      const binding = await this.container.taskRuntime.loadBinding(native.bindingId);
      await this.#executeNativeBindingOperation({
        binding,
        operation: "revert",
        operationInput: { sessionId: native.nativeSessionId, commit: true },
        configScope: conversationId,
        workspacePath: workRoute.route.workspace.canonicalPath,
      });
      return { ...native, staged: false, committed: true };
    }
    return native;
  }

  async #ensureWorkMutationIdle(conversationId) {
    const detail = await this.base.getConversation(conversationId);
    if (detail.summary.mode !== "work") return;
    const active = await this.container.taskStore.listTasks({
      conversationId,
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1,
    });
    invariant(!active.length, "CONVERSATION_TASK_ACTIVE", "当前远端任务结束或中断后才能修改历史", {
      status: 409,
      details: active[0] ? { taskId: active[0].id, status: active[0].status } : undefined,
    });
  }

  async #ensureVersionWorkspacesIdle(serverIdentity, workspaceIds) {
    const affected = new Set((workspaceIds || []).map(String).filter(Boolean));
    if (!affected.size) return;
    const active = await this.container.taskStore.listTasks({
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1000,
    });
    const conflicting = active.find((task) => task.route?.serverIdentity === serverIdentity && affected.has(task.route?.workspaceId));
    invariant(!conflicting, "WORKSPACE_TASK_ACTIVE", "当前工作区有任务正在执行，结束或中断后才能恢复文件版本", {
      status: 409,
      details: conflicting ? { taskId: conflicting.id, conversationId: conflicting.conversationId, workspaceId: conflicting.route?.workspaceId } : undefined,
    });
  }

  async #messagesFor(conversationId, branchId = null) {
    const detail = await this.base.getConversation(conversationId);
    const selected = branchId || detail.summary.activeBranchId;
    return { detail, branchId: selected, messages: await allMessages(this.base, conversationId, selected) };
  }

  async #allConversationMessages(detail) {
    const branches = Array.isArray(detail?.branches) ? detail.branches : [];
    const pages = await Promise.all(branches.map((branch) => allMessages(this.base, detail.summary.id, branch.id)));
    const byId = new Map();
    for (const message of pages.flat()) byId.set(message.id, message);
    return [...byId.values()];
  }

  async #invalidateRemoved(before, conversationId, branchId, result, commandId, reason) {
    const after = await allMessages(this.base, conversationId, branchId);
    const retained = new Set(after.map((entry) => entry.id));
    const removed = before.filter((entry) => !retained.has(entry.id));
    if (!removed.length) return { invalidated: 0 };
    const removedTasks = await this.#tasksFromSourceMessages(conversationId, removed);
    const [memory, observations] = await Promise.all([
      this.memoryCoordinator.invalidateBoundary({
        messageIds: removed.map((entry) => entry.id),
        taskIds: [...new Set([
          ...removed.map((entry) => entry.taskId).filter(Boolean),
          ...removedTasks.map((task) => task.id),
        ])],
        reason,
        source: { type: "conversation-mutation", id: String(commandId), version: String(result.conversation?.revision ?? "1") },
      }),
      this.container.webAgentObservations.invalidate({
        conversationId,
        branchId,
        removedMessageIds: removed.map((entry) => entry.id),
      }),
    ]);
    return { ...memory, invalidatedObservations: observations.invalidated };
  }

  listConversations(input) { return this.base.listConversations(input); }
  searchConversations(input) { return this.base.searchConversations(input); }
  searchReferenceCandidates(input) { return this.base.searchReferenceCandidates(input); }
  readConversationReference(input) { return this.base.readConversationReference(input); }
  getConversationSummaries(ids) { return this.base.getConversationSummaries(ids); }
  getConversation(id) { return this.base.getConversation(id); }
  listMessages(input) { return this.base.listMessages(input); }
  rename(input) { return this.base.rename(input); }
  setPinned(input) { return this.base.setPinned(input); }
  moveToProject(input) { return this.base.moveToProject(input); }
  activateBranch(input) { return this.base.activateBranch(input); }
  async delete(input) {
    const conversationId = String(input?.conversationId || "");
    let detail = null;
    try {
      detail = await this.base.getConversation(conversationId);
    } catch (error) {
      const deleted = (await this.base.listDeletedConversations()).some((entry) => entry.id === conversationId);
      if (!deleted) throw error;
    }
    if (detail) {
      await this.#ensureWorkMutationIdle(conversationId);
      const runningWeb = (await this.container.webInteractionStore.listRunning())
        .find((record) => record.input?.conversationId === conversationId);
      invariant(!runningWeb, "CONVERSATION_RESPONSE_ACTIVE", "当前网页 Agent 回复结束或终止后才能删除对话", {
        status: 409,
        details: runningWeb ? { runId: runningWeb.runId } : undefined,
      });
    }
    const result = await this.base.delete(input);
    const deletionSource = {
      type: "conversation-delete",
      id: String(input?.commandId || conversationId),
      version: String(result.conversation?.revision || 1),
    };
    await this.container.scheduleConversationDeletionCleanup(conversationId, deletionSource);
    return result;
  }
  async branch(input) {
    const mutation = { ...(input || {}) };
    delete mutation.action;
    delete mutation.response;
    await this.#ensureWorkMutationIdle(mutation.conversationId);
    const before = await this.#messagesFor(mutation.conversationId, mutation.sourceBranchId);
    const boundaryIndex = before.messages.findIndex((entry) => entry.id === mutation.atMessageId);
    invariant(boundaryIndex >= 0, "BRANCH_FORK_MESSAGE_NOT_FOUND", "分支起点不在来源消息链中", { status: 404 });
    const boundary = before.messages[boundaryIndex];
    const sourceBranchId = mutation.sourceBranchId || before.branchId;
    const workRoute = await this.#workRoute(mutation.conversationId, sourceBranchId);
    const preparedVersions = [];
    let boundaryWorkspaceBindingId = null;
    let boundaryWorkspaceId = null;
    let boundaryAgentId = workRoute?.route.binding.agentId || null;
    let boundaryNativeTask = null;
    if (workRoute) {
      const previousTaskId = [...before.messages.slice(0, boundaryIndex + 1)].reverse().find((entry) => entry.taskId)?.taskId || null;
      const followingTaskId = before.messages.slice(boundaryIndex + 1)
        .find((entry) => entry.role === "assistant" && entry.taskId)?.taskId || null;
      const previousTask = previousTaskId ? await this.container.taskStore.getTask(previousTaskId) : null;
      const followingTask = followingTaskId ? await this.container.taskStore.getTask(followingTaskId) : null;
      const task = followingTask || previousTask;
      if (boundary.role === "assistant" && boundary.taskId && previousTask?.id === boundary.taskId) boundaryNativeTask = previousTask;
      if (boundaryNativeTask?.agentBindingId) {
        const boundaryBinding = await this.container.taskRuntime.loadBinding(boundaryNativeTask.agentBindingId);
        const requiredFrom = boundaryBinding?.native?.skillSnapshotRequiredFrom;
        invariant(!requiredFrom || boundaryNativeTask.createdAt < requiredFrom || boundaryBinding.native?.skillCheckpoints?.[boundaryNativeTask.id],
          "AGENT_SKILL_SNAPSHOT_UNAVAILABLE", "该回合的技能快照未成功保存，无法创建内容一致的分支；请从已保存快照的回合分支", { status: 409 });
      }
      boundaryWorkspaceId = task?.route?.workspaceId || null;
      boundaryAgentId = task?.route?.agentId || boundaryAgentId;
      if (task?.route?.workspaceId && task.route.agentId) {
        const boundaryBindings = (await workRoute.workspaces.listBindings({ conversationId: mutation.conversationId, branchId: sourceBranchId }))
          .filter((entry) => entry.workspaceId === task.route.workspaceId && entry.agentId === task.route.agentId)
          .sort((left, right) => left.contextEpoch - right.contextEpoch || left.updatedAt.localeCompare(right.updatedAt));
        boundaryWorkspaceBindingId = boundaryBindings.at(-1)?.id || null;
      }
      const prefixTasks = await this.#tasksFromMessages(before.messages.slice(0, boundaryIndex + 1));
      const sourceTasks = [...prefixTasks, ...(followingTask && !prefixTasks.some((entry) => entry.id === followingTask.id) ? [followingTask] : [])]
        .filter((entry) => entry.conversationId === mutation.conversationId && entry.branchId === sourceBranchId && entry.versionCheckpointId);
      const scopes = await this.#versionScopesForTasks(workRoute, mutation.conversationId, sourceBranchId, sourceTasks, derivedCommandId(mutation.commandId, "branch-scopes"));
      for (const scope of scopes) {
        const prefixWorkspaceTasks = prefixTasks
          .filter((entry) => entry.branchId === sourceBranchId
            && entry.versionCheckpointId
            && scope.workspaceIds.includes(entry.route?.workspaceId));
        const followingWorkspaceTask = followingTask?.versionCheckpointId
          && scope.workspaceIds.includes(followingTask.route?.workspaceId)
          ? followingTask
          : null;
        const versionState = await scope.versioning.getDomain(scope.locator);
        const retainedForkCheckpointId = selectRetainedVersionCheckpoint(versionState, prefixWorkspaceTasks, {
          boundaryRole: boundary.role,
          followingTask: followingWorkspaceTask,
        });
        // A Task that attempted a mutation but ended with no net file change
        // has its temporary before checkpoint removed. If the whole visible
        // prefix has no durable checkpoint, the target conversation can start
        // an empty version domain over the same physical workspace.
        if (!retainedForkCheckpointId) continue;
        preparedVersions.push({
          ...scope,
          retainedForkCheckpointId,
          switchId: derivedCommandId(mutation.commandId, `version-switch-${crypto.createHash("sha256").update(scope.workspace.id).digest("hex").slice(0, 16)}`),
        });
      }
      if (preparedVersions.length) {
        await this.#ensureVersionWorkspacesIdle(
          workRoute.server.profile.serverIdentity,
          preparedVersions.flatMap((entry) => entry.workspaceIds),
        );
        const switched = await preparedVersions[0].versioning.switchBatch(preparedVersions.map((entry) => ({
          locator: entry.locator,
          targetCheckpointId: entry.retainedForkCheckpointId,
          switchId: entry.switchId,
          preserveDomainHead: true,
        })));
        invariant(switched.applied, switched.conflict?.code || "VERSION_SWITCH_FAILED", switched.conflict?.message || "无法安全切换到分支文件状态", {
          status: 409,
          details: switched.conflict || undefined,
        });
      }
    }
    const result = await this.base.forkConversation(mutation);
    const targetConversationId = result.conversation.id;
    const targetBranchId = result.branch.id;
    const sourcePrefix = before.messages.slice(0, boundaryIndex + 1);
    const targetMessages = await allMessages(this.base, targetConversationId, targetBranchId);
    const messageIdMap = new Map(sourcePrefix.map((message, index) => [message.id, targetMessages[index]?.id]).filter(([, targetId]) => targetId));
    const sharedBranchWork = [
      this.memoryCoordinator.registerBranch({
        conversationId: targetConversationId,
        sourceConversationId: mutation.conversationId,
        sourceBranchId,
        branchId: targetBranchId,
        sourceMessageIds: before.messages.slice(0, boundaryIndex + 1).map((entry) => entry.id),
      }),
      this.memoryCoordinator.forkConversationScope({
        sourceConversationId: mutation.conversationId,
        targetConversationId,
        sourceIds: before.messages.slice(0, boundaryIndex + 1).flatMap((entry) => [entry.id, entry.taskId].filter(Boolean)),
        source: { type: "conversation-branch", id: targetConversationId, version: String(result.conversation.revision) },
      }),
      this.container.webAgentObservations.fork({
        sourceConversationId: mutation.conversationId,
        sourceBranchId,
        targetConversationId,
        targetBranchId,
        messageIdMap,
      }),
    ];
    if (workRoute) {
      const activeAgentId = boundaryAgentId || workRoute.route.binding.agentId;
      const backend = await this.container.remoteBackend(workRoute.binding.serverId);
      invariant(typeof backend.agentConfiguration?.materializeScopes === "function", "AGENT_CONFIG_SCOPES_MATERIALIZE_UNAVAILABLE", "远端 backend 未提供当前配置作用域物化能力", { status: 503 });
      const workspaceFork = workRoute.workspaces.forkConversation({
        sourceConversationId: mutation.conversationId,
        conversationId: targetConversationId,
        sourceBranchId,
        branchId: targetBranchId,
        sourceBindingId: boundaryWorkspaceBindingId,
        commandId: derivedCommandId(mutation.commandId, "workspace-conversation-branch"),
      });
      const remoteBranchWork = [
        this.container.servers.bindConversation(workRoute.binding.serverId, targetConversationId),
        backend.agentConfiguration.materializeScopes([activeAgentId], {
          sourceScope: mutation.conversationId,
          targetScope: targetConversationId,
        }),
        ...preparedVersions.map((preparedVersion) => preparedVersion.versioning.forkDomain(preparedVersion.locator, {
          sourceCheckpointId: preparedVersion.retainedForkCheckpointId,
          targetConversationId,
          targetWorkspaceId: boundaryWorkspaceId || preparedVersion.workspace.id,
          targetBranchId,
          targetMode: preparedVersion.workspace.kind === "user" ? "real" : "virtual",
        })),
        workspaceFork,
      ];
      const settled = await Promise.all([...sharedBranchWork, ...remoteBranchWork]);
      result.workspaceRoute = settled.at(-1);
    } else {
      await Promise.all(sharedBranchWork);
    }
    const inheritedConversationUnits = (await workConversationTranscriptFragments(
      targetMessages,
      null,
      this.container.runtime.prompts,
    )).map((fragment) => fragment.knowledge);
    result.nativeConversation = await this.#tryNativeAgentFork({
      sourceTask: boundaryNativeTask,
      targetConversationId,
      targetBranchId,
      inheritedConversationUnits,
    });
    return result;
  }

  async retry(input) {
    const mutation = { ...(input || {}) };
    const response = mutation.response || null;
    delete mutation.action;
    delete mutation.response;
    await this.#ensureWorkMutationIdle(mutation.conversationId);
    if (!response) {
      const before = await this.#messagesFor(mutation.conversationId, mutation.branchId);
      const native = await this.#rewindWorkAndNative({
        conversationId: mutation.conversationId,
        branchId: before.branchId,
        removedMessages: before.messages.slice(-1),
        retainedMessages: before.messages.slice(0, -1),
        commandId: mutation.commandId,
      });
      const result = await this.base.retry(mutation);
      await this.#invalidateRemoved(before.messages, mutation.conversationId, result.branchId || before.branchId, result, mutation.commandId, "retried assistant response");
      const targetBranchId = result.branchId || before.branchId;
      if (!native.applied) await this.#advanceWorkEpoch(mutation.conversationId, targetBranchId, mutation.commandId);
      result.nativeConversation = native;
      return result;
    }
    exactObject(response, ["providerId", "modelId", "scope"], "ResponseDescriptor");
    const detail = await this.base.getConversation(mutation.conversationId);
    const branchId = mutation.branchId || detail.summary.activeBranchId;
    const messages = await allMessages(this.base, mutation.conversationId, branchId);
    const assistant = messages.at(-1);
    const user = messages.at(-2);
    if (assistant?.role === "user") {
      invariant(!mutation.messageId || mutation.messageId === assistant.id, "LATEST_RESPONSE_REQUEST_REQUIRED", "只能重新生成最新一轮回复", {
        status: 409,
        details: { latestMessageId: assistant.id },
      });
      const retainedMessages = messages.slice(0, -1);
      const native = await this.#rewindWorkAndNative({
        conversationId: mutation.conversationId,
        branchId,
        removedMessages: [assistant],
        retainedMessages,
        commandId: mutation.commandId,
      });
      const failedTasks = await this.#tasksFromSourceMessages(mutation.conversationId, [assistant]);
      await this.memoryCoordinator.invalidateBoundary({
        messageIds: [],
        taskIds: failedTasks.map((task) => task.id),
        reason: "regenerated failed response",
        source: { type: "conversation-mutation", id: String(mutation.commandId), version: String(detail.summary.revision) },
      });
      if (!native.applied) await this.#advanceWorkEpoch(mutation.conversationId, branchId, mutation.commandId);
      return {
        conversation: detail.summary,
        branchId,
        nativeConversation: native,
        response: await this.interactions.respond({
          conversationId: mutation.conversationId,
          messageId: assistant.id,
          providerId: response.providerId,
          modelId: response.modelId,
          scope: response.scope || {},
          commandId: derivedCommandId(mutation.commandId, "respond"),
        }),
      };
    }
    invariant(assistant?.role === "assistant" && user?.role === "user", "LATEST_ASSISTANT_MESSAGE_REQUIRED", "只能重新生成最新一条助手回复", { status: 409 });
    invariant(!mutation.messageId || mutation.messageId === assistant.id, "LATEST_ASSISTANT_MESSAGE_REQUIRED", "只能重新生成最新一条助手回复", { status: 409, details: { latestMessageId: assistant.id } });
    const native = await this.#rewindWorkAndNative({
      conversationId: mutation.conversationId,
      branchId,
      removedMessages: [assistant],
      retainedMessages: messages.slice(0, -1),
      commandId: mutation.commandId,
    });
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
    if (!native.applied) await this.#advanceWorkEpoch(mutation.conversationId, branchId, mutation.commandId);
    return {
      ...rewound,
      nativeConversation: native,
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
    await this.#ensureWorkMutationIdle(mutation.conversationId);
    const before = await this.#messagesFor(mutation.conversationId, mutation.branchId);
    const targetIndex = before.messages.findIndex((entry) => entry.id === mutation.toMessageId);
    invariant(targetIndex >= 0, "REWIND_MESSAGE_NOT_FOUND", "回溯位置不在当前分支中", { status: 404 });
    const native = await this.#rewindWorkAndNative({
      conversationId: mutation.conversationId,
      branchId: before.branchId,
      removedMessages: before.messages.slice(targetIndex + 1),
      retainedMessages: before.messages.slice(0, targetIndex + 1),
      commandId: mutation.commandId,
    });
    const result = await this.base.rewind(mutation);
    await this.#invalidateRemoved(before.messages, mutation.conversationId, result.branchId || before.branchId, result, mutation.commandId, "rewound conversation branch");
    const targetBranchId = result.branchId || before.branchId;
    if (!native.applied) await this.#advanceWorkEpoch(mutation.conversationId, targetBranchId, mutation.commandId);
    result.nativeConversation = native;
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

const HANDOFF_SETTLED_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function resourceCoverageKnowledge(fragment) {
  const key = String(fragment?.knowledge?.key || "");
  const match = /^resource:([^:]+):(.+)$/u.exec(key);
  if (!match || !fragment?.knowledge?.version) return null;
  return {
    key: `resource:${match[1]}:file`,
    version: String(fragment.knowledge.version),
    content: "",
  };
}

function isLegacyCompleteResourceRead(fragment) {
  if (String(fragment?.toolName || "") !== "resource_read") return false;
  if (!/^resource:[^:]+:read_0$/u.test(String(fragment?.knowledge?.key || ""))) return false;
  const resources = Array.isArray(fragment?.presented?.resources) ? fragment.presented.resources : [];
  return resources.length > 0 && resources.every((entry) => entry?.nextOffset === null || entry?.nextOffset === undefined);
}

function resourceCatalogCoverageKnowledge(item) {
  const resourceId = String(item?.resourceId || "").trim();
  const version = String(item?.resourceVersionId || "").trim();
  return resourceId && version ? { key: `resource:${resourceId}:file`, version, content: "" } : null;
}

export class RemoteTaskLifecycle {
  constructor(container, extraction) {
    this.container = container;
    this.extraction = extraction;
  }

  async conversationHistoryForBinding(scope, currentTaskId = null) {
    if (typeof this.container.baseConversations?.listMessages !== "function") return [];
    const bindingKey = createAgentBindingKey(scope, scope.agentId);
    const [binding, tasks] = await Promise.all([
      this.container.taskRuntime.loadBinding(bindingKey),
      this.container.taskStore.scanTasks
        ? this.container.taskStore.scanTasks({ conversationId: scope.conversationId })
        : this.container.taskStore.listTasks({ conversationId: scope.conversationId, limit: 1000 }),
    ]);
    const previous = tasks.filter((task) => task.id !== currentTaskId
      && task.sourceMessageId !== this.extraction.messageId
      // Failed preparation never changed the active native conversation.
      // Keep the preceding delivered binding so retrying a switch still syncs.
      && !(!task.startedAt && !task.remoteRunId && ["failed", "interrupted", "cancelled"].includes(task.status))
      && (!task.branchId || !scope.branchId || task.branchId === scope.branchId))
      .sort((left, right) => String(right.createdAt || right.updatedAt || "").localeCompare(String(left.createdAt || left.updatedAt || "")))[0];
    const nativeSessionId = binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId;
    // An existing native conversation owns its history. Even a missing local
    // receipt is not a reason to replay its transcript on an ordinary turn.
    if (nativeSessionId && previous?.agentBindingId === bindingKey) return [];
    const messages = await allMessages(this.container.baseConversations, scope.conversationId, scope.branchId);
    const fragments = await workConversationTranscriptFragments(messages, this.extraction.messageId, this.container.runtime.prompts, { tasks });
    return this.filterHandoff({ scope, fragments });
  }

  async filterHandoff({ scope, fragments }) {
    if (!Array.isArray(fragments) || !fragments.length) return [];
    const selectedByIdentity = new Map();
    for (const [index, fragment] of fragments.entries()) {
      const identity = fragment?.knowledge?.key && fragment?.knowledge?.version
        ? `knowledge:${fragment.knowledge.key}\0${fragment.knowledge.version}`
        : `content:${String(fragment?.rendered || "").trim()}`;
      if (!identity) continue;
      const current = selectedByIdentity.get(identity);
      if (!current || Number(fragment?.priority || 0) > Number(current.fragment?.priority || 0)) {
        selectedByIdentity.set(identity, { fragment, index: current?.index ?? index });
      }
    }
    const deduplicated = [...selectedByIdentity.values()].sort((left, right) => left.index - right.index).map((entry) => entry.fragment);
    const bindingKey = createAgentBindingKey(scope, scope.agentId);
    await this.#synchronizeNativeTurnReceipt(bindingKey, scope.conversationId, scope.branchId);
    const binding = await this.container.taskRuntime.loadBinding(bindingKey);
    const nativeSessionId = binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId || null;
    if (!nativeSessionId) return deduplicated;
    // A package pin proves deployment, not invocation or model compliance.
    // Keep applicable Skills available for selection in each new turn. Cached
    // observations avoid rereading their source; deployment reuses the owned
    // view, while the adapter invokes the selected native Skill explicitly.
    const skillFragments = deduplicated.filter((entry) => /^skill:(.+)$/.test(String(entry?.knowledge?.key || "")));
    const contextualFragments = deduplicated.filter((entry) => !skillFragments.includes(entry));
    const pendingSkills = new Set(skillFragments);
    const knowledgeFragments = contextualFragments.filter((entry) => entry?.knowledge?.key && entry?.knowledge?.version);
    const semanticFragments = contextualFragments.filter((entry) => !entry?.knowledge?.key || !entry?.knowledge?.version);
    const acceptedKnowledge = await this.container.contextHub.unacknowledgedKnowledge({
      bindingKey,
      nativeSessionId,
      units: knowledgeFragments.map((entry) => entry.knowledge),
    });
    const acceptedKnowledgeKeys = new Set(acceptedKnowledge.map((entry) => `${entry.key}\0${entry.version}`));

    // Before complete-file coverage identities existed, direct reads were
    // acknowledged as resource:<id>:read_0. Promote only reads already proven
    // delivered to this exact native session; an unacknowledged or partial read
    // must never hide the rest of a file.
    const promotedCoverage = knowledgeFragments
      .filter((entry) => isLegacyCompleteResourceRead(entry)
        && !acceptedKnowledgeKeys.has(`${entry.knowledge.key}\0${entry.knowledge.version}`))
      .map(resourceCoverageKnowledge)
      .filter(Boolean);
    if (promotedCoverage.length) {
      await this.container.contextHub.acknowledgeKnowledge({
        bindingKey,
        nativeSessionId,
        units: promotedCoverage,
      });
    }

    // Knowledge identities describe provenance. Content receipts additionally
    // prevent the same bytes from returning through another retrieval route
    // (for example resource_read followed by resource_search).
    const knowledgeContents = knowledgeFragments
      .map((entry) => String(entry?.knowledge?.content || ""))
      .filter((value) => value.trim());
    const unacknowledgedKnowledgeContent = await this.container.contextHub.unacknowledgedSemanticContent({
      bindingKey,
      nativeSessionId,
      values: knowledgeContents,
    });
    const acceptedKnowledgeContent = new Set(unacknowledgedKnowledgeContent);

    const resourceCoverage = knowledgeFragments.map(resourceCoverageKnowledge).filter(Boolean);
    const pendingResourceCoverage = resourceCoverage.length
      ? await this.container.contextHub.unacknowledgedKnowledge({ bindingKey, nativeSessionId, units: resourceCoverage })
      : [];
    const pendingResourceCoverageKeys = new Set(pendingResourceCoverage.map((entry) => `${entry.key}\0${entry.version}`));
    const rendered = semanticFragments.map((entry) => String(entry?.rendered || ""));
    const unacknowledged = await this.container.contextHub.unacknowledgedSemanticContent({ bindingKey, nativeSessionId, values: rendered });
    const remaining = new Set(unacknowledged);
    return deduplicated.filter((entry) => pendingSkills.has(entry)
      || (entry?.knowledge?.key && entry?.knowledge?.version
        ? acceptedKnowledgeKeys.has(`${entry.knowledge.key}\0${entry.knowledge.version}`)
          && (String(entry.knowledge.key).startsWith("conversation:")
            || !String(entry.knowledge.content || "").trim()
            || acceptedKnowledgeContent.has(String(entry.knowledge.content)))
          && (!resourceCoverageKnowledge(entry)
            || pendingResourceCoverageKeys.has(`${resourceCoverageKnowledge(entry).key}\0${resourceCoverageKnowledge(entry).version}`))
        : remaining.has(String(entry?.rendered || ""))));
  }

  async filterResourceCatalog({ scope, catalog }) {
    const items = Array.isArray(catalog?.items) ? catalog.items : [];
    if (!items.length) return { ...(catalog || {}), items: [] };
    const bindingKey = createAgentBindingKey(scope, scope.agentId);
    await this.#synchronizeNativeTurnReceipt(bindingKey, scope.conversationId, scope.branchId);
    const binding = await this.container.taskRuntime.loadBinding(bindingKey);
    const nativeSessionId = binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId || null;
    if (!nativeSessionId) return catalog;
    const markers = items.map(resourceCatalogCoverageKnowledge);
    const candidates = markers.filter(Boolean);
    if (!candidates.length) return catalog;
    const pending = await this.container.contextHub.unacknowledgedKnowledge({ bindingKey, nativeSessionId, units: candidates });
    const pendingKeys = new Set(pending.map((entry) => `${entry.key}\0${entry.version}`));
    return {
      ...catalog,
      items: items.filter((item, index) => {
        const marker = markers[index];
        return !marker || pendingKeys.has(`${marker.key}\0${marker.version}`);
      }),
    };
  }

  async filterForcedSkillCatalog({ scope, skills }) {
    const selectedIds = new Set((scope.selectedSkillVersions || []).map((pin) => String(pin.skillId)));
    const bindingKey = createAgentBindingKey(scope, scope.agentId);
    const checks = this.container.forcedSkillChecks ||= new Map();
    let check = checks.get(scope.conversationId);
    // Remember the active binding, not every binding ever seen: A -> B -> A
    // must inspect A again on its next question, even if B had no forced Skills.
    if (check?.bindingKey !== bindingKey) {
      check = { bindingKey, checked: false, pending: new Set() };
      checks.set(scope.conversationId, check);
      if (checks.size > 256) checks.delete(checks.keys().next().value);
    }
    const identity = (skill) => {
      const version = /^(?:semantic-v1:)?([^:]+):([a-f0-9]{64})$/.exec(String(skill.knowledge?.version || ""));
      return version ? JSON.stringify([skill.skillId, version[1], version[2]]) : null;
    };
    if (!check.checked) {
      const forced = skills.filter(isForcedWorkSkill);
      const binding = forced.length ? await this.container.taskRuntime.loadBinding(bindingKey) : null;
      const installed = new Set((binding?.native?.skillPins || []).map((pin) => JSON.stringify([pin.skillId, pin.version, pin.sha256])));
      check.pending = new Set(forced.filter((skill) => !identity(skill) || !installed.has(identity(skill))).map(identity));
      check.checked = true;
    }
    // Reuse this decision on consecutive questions. No remote/model check is
    // needed until the webpage conversation switches its remote binding.
    return skills.filter((skill) => {
      if (!isForcedWorkSkill(skill) || selectedIds.has(String(skill.skillId))) return true;
      return check.pending.has(identity(skill));
    });
  }

  settleForcedSkillDelivery(scope, dispatch) {
    const check = this.container.forcedSkillChecks?.get(scope.conversationId);
    if (!check || check.bindingKey !== createAgentBindingKey(scope, scope.agentId) || !check.pending.size) return;
    if (dispatch?.operation === "create" && ["running", "completed"].includes(dispatch.start?.status)) {
      for (const pin of dispatch.task.skillPins || []) check.pending.delete(JSON.stringify([pin.skillId, pin.version, pin.sha256]));
    } else {
      // An interrupted/failed startup is not proof that installation finished.
      check.checked = false;
    }
  }

  async nativeTaskConversationKnowledge(task, conversationId, branchId, { includeAssistant = task?.status === "completed" } = {}) {
    if (!task?.id || !this.container.baseConversations) return [];
    const descriptor = typeof this.container.memoryCoordinator?.taskDescriptor === "function"
      ? await this.container.memoryCoordinator.taskDescriptor(task.id)
      : null;
    const sourceMessageIds = new Set([
      task.sourceMessageId,
      descriptor?.sourceMessageId,
    ].filter(Boolean).map(String));
    const taskRuns = typeof this.container.webInteractionStore?.findByTask === "function"
      ? await this.container.webInteractionStore.findByTask(task.id)
      : [];
    for (const record of taskRuns) {
      if (record?.input?.messageId) sourceMessageIds.add(String(record.input.messageId));
    }
    const messages = await allMessages(this.container.baseConversations, conversationId, branchId);
    const acknowledgedMessages = messages.filter((message) => (
      message.role === "user" && sourceMessageIds.has(String(message.id))
    ));
    if (includeAssistant) {
      const assistantMessage = messages.find((message) => message.taskId === task.id && message.role === "assistant");
      if (assistantMessage) acknowledgedMessages.push(assistantMessage);
    }
    return (await Promise.all(acknowledgedMessages.map((message) => (
      conversationKnowledgeUnit(message, this.container.runtime.prompts)
    )))).filter(Boolean);
  }

  async #synchronizeNativeTurnReceipt(agentBindingId, conversationId, branchId) {
    const binding = await this.container.taskRuntime.loadBinding(agentBindingId);
    const nativeSessionId = binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId || null;
    const activeRunId = binding?.activeRunId || null;
    if (!nativeSessionId || typeof this.container.taskStore?.listTasks !== "function") return;

    // A terminal Task and the native-session receipt live in separate durable
    // records. Complete the receipt idempotently after a process interruption
    // before selecting the next turn's context delta.
    const tasks = await this.container.taskStore.listTasks({
      conversationId,
      statuses: ["completed", "interrupted"],
      limit: 1000,
    });
    for (const activeTask of tasks.filter((task) => task.agentBindingId === agentBindingId)) {
      const activeRunMatches = Boolean(activeRunId && activeTask.remoteRunId === activeRunId);
      const checkpoint = !activeRunMatches && typeof this.container.contextHub.getBindingCheckpoint === "function"
        ? await this.container.contextHub.getBindingCheckpoint({
            bindingKey: agentBindingId,
            nativeSessionId,
            checkpointId: activeTask.id,
          })
        : null;
      // A replaced native conversation must receive a fresh transcript. Only
      // repair Tasks proven to belong to this exact native session, either by
      // its still-active run or by its durable receipt checkpoint.
      if (!activeRunMatches && !checkpoint) continue;
      await this.container.contextHub.acknowledgeStagedKnowledge({
        bindingKey: agentBindingId,
        nativeSessionId,
        taskId: activeTask.id,
      });
      const units = await this.nativeTaskConversationKnowledge(activeTask, conversationId, branchId);
      if (units.length) {
        await this.container.contextHub.acknowledgeSemanticContent({
          bindingKey: agentBindingId,
          nativeSessionId,
          values: units.map((unit) => unit.content),
        });
        await this.container.contextHub.acknowledgeKnowledge({
          bindingKey: agentBindingId,
          nativeSessionId,
          units,
        });
      }
      if (!checkpoint && typeof this.container.contextHub.checkpointBinding === "function") {
        await this.container.contextHub.checkpointBinding({
          bindingKey: agentBindingId,
          nativeSessionId,
          checkpointId: activeTask.id,
          nativeBoundary: {
            protocol: binding.adapterId,
            sessionId: nativeSessionId,
            turnId: binding.native?.turnId || binding.state?.turnId || null,
            rolloutPath: binding.native?.rolloutPath || null,
            skillSnapshot: binding.native?.skillCheckpoints?.[activeTask.id] || null,
          },
        });
      }
    }
  }

  async create(input) {
    const { scope, userMessage, handoffFragments: selectedHandoffFragments = [], idempotencyKey } = input;
    invariant(scope?.serverId && scope?.serverIdentity && scope?.workspaceId && scope?.agentId, "WORK_ROUTE_REQUIRED", "工作模式需要服务器、工作区和 Agent", { status: 409 });
    const taskId = `task_${crypto.createHash("sha256").update(`${this.container.actor.actorId}:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
    const existing = await this.container.taskStore.getTask(taskId);
    if (existing) {
      if (this.extraction.runId) await this.container.webInteractionStore.addTask(this.extraction.runId, taskId);
      const handoffFragments = await this.filterHandoff({ scope, fragments: selectedHandoffFragments });
      const historyFragments = existing.status === "queued"
        ? await this.conversationHistoryForBinding(scope, taskId)
        : [];
      const handoffKnowledge = [...handoffFragments, ...historyFragments]
        .filter((entry) => !String(entry?.knowledge?.key || "").startsWith("skill:"))
        .map((entry) => entry?.knowledge)
        .filter(Boolean);
      if (handoffKnowledge.length) {
        await this.container.contextHub.stageKnowledge({ bindingKey: existing.agentBindingId, taskId, units: handoffKnowledge });
      }
      const start = existing.status === "queued"
        ? await this.container.orchestrator.start(taskId, { commandId: derivedCommandId(idempotencyKey, "start") })
        : { taskId, status: existing.status, duplicate: true };
      return { task: existing, start, handoffFragments, duplicate: true };
    }
    const liveTasks = await this.container.taskStore.listTasks({
      conversationId: scope.conversationId,
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1000,
    });
    // A webpage conversation owns one writable remote-version ledger on a
    // server, even when its turns use different workspaces or Agents.  Keeping
    // one live Task per conversation is therefore part of the transaction
    // contract rather than an Agent-route limitation: two concurrent Tasks
    // could otherwise both advance the same logical HEAD from different
    // physical workspaces.
    const conflicting = liveTasks[0] || null;
    invariant(!conflicting, "CONVERSATION_TASK_ACTIVE", "当前对话已有正在执行的任务，请向该任务追加指令或先中断任务", {
      status: 409,
      details: conflicting ? { taskId: conflicting.id, status: conflicting.status } : undefined,
    });
    const detail = await this.container.baseConversations.getConversation(scope.conversationId);
    const taskScope = effectiveScope(this.container.actor, detail.summary, scope.branchId || detail.summary.activeBranchId, scope, taskId, true);
    const agentBindingId = createAgentBindingKey(taskScope, scope.agentId);
    // Re-evaluate delivery against the actual binding immediately before the
    // Task is staged. The Web model's selected set remains provenance for
    // memory extraction; only this receipt-filtered delta is sent remotely.
    const handoffFragments = await this.filterHandoff({ scope: { ...taskScope, agentId: scope.agentId }, fragments: selectedHandoffFragments });
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
    const created = await this.container.orchestrator.create({
      id: taskId,
      actorId: this.container.actor.actorId,
      conversationId: taskScope.conversationId,
      branchId: taskScope.branchId,
      sourceMessageId: this.extraction.messageId,
      conversationRunId: this.extraction.runId,
      // Task.goal is the user's request, not a second copy of the Web Agent's
      // handoff prose.  Selected semantic units are staged in ContextHub and
      // delivered once through the binding receipt ledger below.
      goal: await this.container.runtime.prompts.remoteTask({ userMessage }),
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
      userMessage,
      observedKnowledge: memoryExtractionObservations(selectedHandoffFragments),
    });
    // Transcript synchronization is backend-only. Do not return it as a Web
    // Agent candidate, observation, visible handoff or memory-extraction input.
    const historyFragments = await this.conversationHistoryForBinding({ ...taskScope, agentId: scope.agentId }, taskId);
    const handoffKnowledge = [...handoffFragments, ...historyFragments]
      .filter((entry) => !String(entry?.knowledge?.key || "").startsWith("skill:"))
      .map((entry) => entry?.knowledge)
      .filter(Boolean);
    if (handoffKnowledge.length) {
      await this.container.contextHub.stageKnowledge({ bindingKey: agentBindingId, taskId, units: handoffKnowledge });
    }
    try {
      const started = await this.container.orchestrator.start(taskId, { commandId: derivedCommandId(idempotencyKey, "start") });
      return { task: created.task, start: started, handoffFragments };
    } catch (error) {
      await this.container.contextHub.discardStagedKnowledge(taskId).catch(() => undefined);
      throw error;
    }
  }

  async dispatch({ scope, userMessage, handoffFragments = [], idempotencyKey, directRemoteTaskId = null }) {
    invariant(scope?.serverId && scope?.serverIdentity && scope?.workspaceId && scope?.agentId, "WORK_ROUTE_REQUIRED", "工作模式需要服务器、工作区和 Agent", { status: 409 });
    const candidates = await this.container.taskStore.listTasks({
      conversationId: scope.conversationId,
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1000,
    });
    const matching = candidates
      .filter((task) => task.route.serverId === scope.serverId && task.route.workspaceId === scope.workspaceId && task.route.agentId === scope.agentId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    invariant(matching.length <= 1, "CONVERSATION_TASK_STATE_AMBIGUOUS", "当前 Agent 与工作区存在多个非终态任务，无法安全投递", { status: 409 });
    let current = matching[0] || null;
    const prompt = String(userMessage || "");
    invariant(prompt.trim(), "WORK_USER_MESSAGE_REQUIRED", "工作模式必须包含用户消息", { status: 400 });
    invariant(!directRemoteTaskId || !current || current.id === directRemoteTaskId, "DIRECT_REMOTE_TASK_CHANGED", "运行中的远端任务已经变化，请重新发送消息", {
      status: 409,
      details: current ? { expectedTaskId: directRemoteTaskId, currentTaskId: current.id, status: current.status } : { expectedTaskId: directRemoteTaskId },
    });
    if (directRemoteTaskId && current?.id === directRemoteTaskId && current.status === "waiting_append") {
      const deadline = Date.now() + 25_000;
      while (current.status === "waiting_append" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        current = await this.container.orchestrator.getTask(current.id);
      }
    }
    if (directRemoteTaskId && current?.id === directRemoteTaskId && current.status === "finalizing") {
      await this.waitFor(current.id);
      current = await this.container.orchestrator.getTask(current.id);
    }
    if (!current || HANDOFF_SETTLED_STATUSES.has(current.status)) {
      const created = await this.create({ scope, userMessage, handoffFragments, idempotencyKey });
      return { operation: "create", taskId: created.task.id, ...created };
    }
    if (this.extraction.runId) await this.container.webInteractionStore.addTask(this.extraction.runId, current.id);
    if (current.status === "running") {
      try {
        const command = await this.container.orchestrator.append(current.id, {
          prompt,
          commandId: derivedCommandId(idempotencyKey, "append"),
          sourceMessageId: this.extraction.messageId,
          conversationRunId: this.extraction.runId,
        });
        return { operation: "append", taskId: current.id, task: current, command };
      } catch (error) {
        if (!directRemoteTaskId || error?.code !== "TASK_APPEND_STATE_INVALID") throw error;
        const raced = await this.container.orchestrator.getTask(current.id);
        if (raced.status === "finalizing") await this.waitFor(raced.id);
        const settled = await this.container.orchestrator.getTask(raced.id);
        if (!HANDOFF_SETTLED_STATUSES.has(settled.status)) throw error;
        const created = await this.create({ scope, userMessage, handoffFragments, idempotencyKey });
        return { operation: "create", taskId: created.task.id, ...created };
      }
    }
    invariant(false, "CONVERSATION_TASK_BUSY", `远程任务当前处于 ${current.status}，暂时不能接收新的用户消息`, {
      status: 409,
      details: { taskId: current.id, status: current.status },
    });
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
      const settled = HANDOFF_SETTLED_STATUSES.has(task.status);
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
      if (status === "completed" && !observation.report) {
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
    this.runControllers = new Map();
    this.repairedFailureConversations = new Set();
  }

  async initialize() {
    const running = await this.store.listRunning();
    // A host restart invalidates the in-memory model/tool execution boundary.
    // Never replay a user's old request merely because they later reconnect
    // SSH.  The original run is closed visibly and may only continue through
    // an explicit approval/input/resume action.
    const stopped = await Promise.all(running.map((record) => this.store.fail(record.runId, {
      code: "WEB_RUN_GATEWAY_RESTARTED",
      message: "主机服务已重启，本次 Agent 调用已停止；需要继续时请重新发送请求",
      retryable: true,
    })));
    // Only runs interrupted by this restart belong on the startup critical
    // path. Historical silent failures are repaired lazily when their
    // conversation is opened; replaying every old journal here made the
    // entire application wait on unrelated multi-megabyte conversations.
    await this.#backfillFailureEvents(stopped);
    return 0;
  }

  async #repairFailureEventsForConversation(conversationId) {
    const id = String(conversationId || "");
    if (!id || this.repairedFailureConversations.has(id)) return;
    // Mark before I/O so simultaneous initial event requests share the same
    // repair work instead of appending duplicate terminal events.
    this.repairedFailureConversations.add(id);
    try {
      const failed = await this.store.listFailedForConversation(id);
      await this.#backfillFailureEvents(failed);
    } catch (error) {
      this.repairedFailureConversations.delete(id);
      throw error;
    }
  }

  async resumeTask(taskId) {
    const records = await this.store.findByTask(taskId);
    const resumable = await this.#recoverableRecords(records);
    for (const record of resumable) {
      const reopened = await this.store.reopen(record.runId);
      this.#launch(reopened.runId, reopened.input);
    }
    return resumable.length;
  }

  async #recoverableRecords(records) {
    const recoverable = [];
    for (const record of records) {
      if (record.assistantMessageId || !record.taskIds?.length) continue;
      if (record.status === "completed" && ["waiting_approval", "waiting_input"].includes(record.result?.taskStatus)) {
        recoverable.push(record);
        continue;
      }
      if (record.status !== "failed") continue;
      const taskId = record.taskIds.at(-1);
      try {
        const [task, report] = await Promise.all([
          this.container.orchestrator.getTask(taskId),
          this.container.taskReports.get(taskId, { required: false }),
        ]);
        if (task?.status === "completed" && String(report?.remoteFinal?.text || "").trim()) recoverable.push(record);
      } catch {
        // A missing/deleted Task keeps its original failure record.
      }
    }
    return recoverable;
  }

  async #backfillFailureEvents(records) {
    const byConversation = new Map();
    for (const record of records) {
      const conversationId = String(record?.input?.conversationId || "");
      if (!conversationId) continue;
      const grouped = byConversation.get(conversationId) || [];
      grouped.push(record);
      byConversation.set(conversationId, grouped);
    }
    for (const [conversationId, failedRuns] of byConversation) {
      try {
        const visible = new Set();
        let afterSequence = 0;
        let replayWindowAdjusted = false;
        for (;;) {
          let page;
          try {
            page = await this.container.broker.replay(`conversation:${conversationId}`, { afterSequence, limit: 2_000 });
          } catch (error) {
            if (error?.code !== "REALTIME_REPLAY_EXPIRED" || replayWindowAdjusted) throw error;
            const first = Number(error?.details?.firstAvailableSequence);
            if (!Number.isSafeInteger(first) || first < 1) throw error;
            afterSequence = first - 1;
            replayWindowAdjusted = true;
            continue;
          }
          for (const event of page.events || []) {
            if (["run.failed", "run.aborted"].includes(event.kind) && event.ids?.runId) visible.add(String(event.ids.runId));
          }
          if (!page.hasMore) break;
          afterSequence = Number(page.nextAfterSequence) || afterSequence;
        }
        for (const record of failedRuns) {
          if (!visible.has(record.runId)) await this.#publishFailure(record.runId, record.input, record.failure || {});
        }
      } catch {
        // Deleted conversations and damaged journals must not block actor startup.
      }
    }
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

  async recordStartupFailure(input) {
    exactObject(input, ["conversationId", "messageId", "failure", "commandId"], "RecordWorkStartupFailure");
    invariant(typeof input.commandId === "string" && input.commandId, "IDEMPOTENCY_KEY_REQUIRED", "启动失败记录必须提供 Idempotency-Key", { status: 428 });
    const detail = await this.container.baseConversations.getConversation(String(input.conversationId || ""));
    invariant(detail.summary.mode === "work", "WORK_STARTUP_FAILURE_MODE_INVALID", "只有工作对话可以记录启动失败", { status: 409 });
    const messageId = String(input.messageId || "");
    invariant(detail.messages.some((message) => message.id === messageId && message.role === "user"), "WORK_STARTUP_MESSAGE_NOT_FOUND", "启动失败没有对应的用户消息", { status: 404 });
    const failure = {
      code: String(input.failure?.code || "WORK_STARTUP_FAILED").replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128),
      message: String(redactSensitive(String(input.failure?.message || "工作任务启动失败"))).slice(0, 16_384),
      retryable: input.failure?.retryable !== false,
    };
    const runId = `web_${crypto.createHash("sha256").update(`${this.container.actor.actorId}:startup:${input.commandId}`).digest("hex").slice(0, 32)}`;
    const runInput = {
      conversationId: detail.summary.id,
      messageId,
      providerId: "startup",
      modelId: "startup",
      scope: {},
      commandId: input.commandId,
    };
    const claimed = await this.store.claim(runId, runInput);
    if (claimed.record.status === "failed") return { runId, status: "failed", duplicate: true };
    await this.store.fail(runId, failure);
    await this.#publishFailure(runId, runInput, failure);
    return { runId, status: "failed", duplicate: !claimed.created };
  }

  async interruptConversation(conversationId, { commandId } = {}) {
    const id = String(conversationId || "");
    invariant(id && typeof commandId === "string" && commandId, "IDEMPOTENCY_KEY_REQUIRED", "停止对话必须提供 Idempotency-Key", { status: 428 });
    const candidates = await this.container.taskStore.listTasks({
      conversationId: id,
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting"],
      limit: 1000,
    });
    const task = [...candidates].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (task) {
      if (task.status === "interrupting") return { taskId: task.id, status: task.status, duplicate: true };
      const submitted = await this.container.orchestrator.interrupt(task.id, { commandId });
      // Orchestrator commands are durable and asynchronous.  The HTTP contract
      // must expose the Task identity (not the command envelope), otherwise the
      // client tries to read `/api/tasks/undefined` immediately after a valid
      // interrupt and reports the misleading "Task 不存在" error.
      return { taskId: task.id, status: "interrupting", duplicate: Boolean(submitted?.duplicate) };
    }

    // Before handoff there is no remote Task—and therefore no native Agent
    // interrupt endpoint—to call. The same send-slot stop action must still be
    // able to cancel the Web Agent's own model/tool request instead of leaving
    // a stalled provider stream on screen until the gateway restarts.
    const webRun = (await this.store.listByConversation(id))
      .filter((record) => record.status === "running")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId))[0];
    if (!webRun) {
      await this.container.baseConversations.getConversation(id);
      const history = await this.container.taskStore.listTasks({ conversationId: id, limit: 1000 });
      const latest = [...history].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      return { ...(latest ? { taskId: latest.id } : {}), status: latest?.status || "completed", duplicate: true };
    }
    const controller = this.runControllers.get(webRun.runId);
    invariant(controller, "WEB_RUN_INTERRUPT_UNAVAILABLE", "网页 Agent 当前无法停止，请稍后重试", { status: 409, retryable: true });
    if (controller.signal.aborted) return { runId: webRun.runId, status: "interrupting", duplicate: true };
    controller.abort(new ApiError("WEB_RUN_INTERRUPTED", "请求已停止", { status: 409 }));
    return { runId: webRun.runId, status: "interrupting", duplicate: false };
  }

  #launch(runId, input) {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const controller = new AbortController();
    this.runControllers.set(runId, controller);
    const promise = this.#run({ ...clone(input), runId }, { signal: controller.signal }).then(async (result) => {
      const metadata = {
        usage: clone(result.usage),
        iterations: Number(result.iterations || 0),
        toolCallCount: Number(result.toolCallCount || 0),
        taskId: result.taskId || null,
        taskStatus: result.taskStatus || null,
      };
      await this.store.complete(runId, { assistantMessageId: result.messageId, result: metadata });
      if (result.messageId) {
        await this.container.taskRuntime.launch(`compact:${input.conversationId}:${result.messageId}`, async () => {
          try { await this.container.conversationContext.compactIfNeeded(input.conversationId); } catch { /* compression is independent from the reply */ }
        });
      }
      return result;
    }).catch(async (error) => {
      const actualError = controller.signal.aborted ? controller.signal.reason || error : error;
      const failure = {
        code: String(actualError?.code || "WEB_AGENT_FAILED").replace(/[^A-Za-z0-9._:-]/g, "_"),
        message: String(redactSensitive(String(actualError?.message || "网页 Agent 执行失败"))).slice(0, 16_384),
        retryable: Boolean(actualError?.retryable),
      };
      await this.store.fail(runId, failure).catch(() => undefined);
      if (!error?.easyworkRunTerminalEmitted) await this.#publishFailure(runId, input, failure).catch(() => undefined);
      throw actualError;
    });
    this.runs.set(runId, promise);
    promise.finally(() => {
      this.runs.delete(runId);
      if (this.runControllers.get(runId) === controller) this.runControllers.delete(runId);
    }).catch(() => undefined);
    promise.catch(() => undefined);
    return promise;
  }

  async #publishFailure(runId, input, failure) {
    const detail = await this.container.baseConversations.getConversation(input.conversationId);
    const stored = await this.store.get(runId);
    const taskId = stored?.taskIds?.at(-1) || null;
    const payload = {
      code: String(failure?.code || "WEB_AGENT_FAILED").replace(/[^A-Za-z0-9._:-]/g, "_"),
      message: String(redactSensitive(String(failure?.message || "网页 Agent 执行失败"))).slice(0, 16_384),
      retryable: Boolean(failure?.retryable),
    };
    const interrupted = ["WEB_RUN_GATEWAY_RESTARTED", "WEB_RUN_INTERRUPTED"].includes(payload.code);
    await this.container.broker.append(`conversation:${detail.summary.id}`, {
      producer: "web-agent",
      kind: interrupted ? "run.aborted" : "run.failed",
      status: interrupted ? "cancelled" : "failed",
      ids: {
        conversationId: detail.summary.id,
        runId,
        sourceMessageId: input.messageId,
        ...(taskId ? { taskId } : {}),
      },
      payload,
    });
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

  async events(conversationId, options = {}) {
    if (!Number(options.afterSequence || 0)) {
      await this.#repairFailureEventsForConversation(conversationId);
    }
    return this.container.broker.replay(`conversation:${conversationId}`, options);
  }

  async #mirrorWebRunHistoryToTask({ conversationId, runId, sourceMessageId, taskId }) {
    const targetTopic = taskTopic(taskId);
    const existing = new Set();
    let taskAfter = 0;
    for (;;) {
      const page = await this.container.broker.replay(targetTopic, { afterSequence: taskAfter, limit: 2_000 });
      for (const event of page.events) existing.add(event.eventId);
      if (!page.hasMore) break;
      taskAfter = page.nextAfterSequence;
    }

    let afterSequence = 0;
    for (;;) {
      const page = await this.container.broker.replay(`conversation:${conversationId}`, { afterSequence, limit: 2_000 });
      for (const event of page.events) {
        if (event.ids.runId !== runId || event.ids.sourceMessageId !== sourceMessageId || existing.has(event.eventId)) continue;
        await this.container.journal.append(targetTopic, {
          eventId: event.eventId,
          producer: event.producer,
          kind: event.kind,
          status: event.status,
          ids: { ...event.ids, taskId },
          payload: event.payload,
          clock: () => new Date(event.occurredAt),
        });
        existing.add(event.eventId);
      }
      if (!page.hasMore) break;
      afterSequence = page.nextAfterSequence;
    }
  }

  async #repairRedundantContextEpoch({ workspaces, route, conversationId, branchId, messages }) {
    const current = route?.binding;
    if (!current || current.contextEpoch < 1) return route;
    const bindingIdFor = (binding) => createAgentBindingKey({
      actorType: this.container.actor.actorType,
      actorId: this.container.actor.actorId,
      serverIdentity: binding.serverIdentity,
      workspaceId: binding.workspaceId,
      conversationId,
      branchId,
      contextEpoch: binding.contextEpoch,
    }, binding.agentId);
    const currentAgentBindingId = bindingIdFor(current);
    const currentRuntime = await this.container.taskRuntime.loadBinding(currentAgentBindingId);
    const currentNativeSession = currentRuntime?.native?.sessionId
      || currentRuntime?.native?.threadId
      || currentRuntime?.state?.sessionId
      || null;
    if (currentNativeSession) return route;

    const currentTasks = await this.container.taskStore.listTasks({ conversationId, limit: 1000 });
    if (currentTasks.some((task) => task.agentBindingId === currentAgentBindingId && task.startedAt)) return route;
    const retainedMessageIds = new Set(messages.map((message) => message.id));
    const orphanRuns = (await this.store.listByConversation(conversationId))
      .filter((record) => record.input?.messageId && !retainedMessageIds.has(record.input.messageId) && record.taskIds?.length);
    const candidates = (await workspaces.listBindings({ conversationId, branchId }))
      .filter((binding) => binding.serverIdentity === current.serverIdentity
        && binding.workspaceId === current.workspaceId
        && binding.agentId === current.agentId
        && binding.contextEpoch < current.contextEpoch)
      .sort((left, right) => right.contextEpoch - left.contextEpoch || right.updatedAt.localeCompare(left.updatedAt));
    const orphanMessageIds = [...new Map(
      [...orphanRuns]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((record) => [record.input.messageId, record.input.messageId]),
    ).values()];
    for (const orphanMessageId of orphanMessageIds) {
      const sameRemovedTurn = orphanRuns.filter((record) => record.input.messageId === orphanMessageId);
      const removedTaskIds = [...new Set(sameRemovedTurn.flatMap((record) => record.taskIds || []))];
      const removedTasks = (await Promise.all(removedTaskIds.map((taskId) => this.container.taskStore.getTask(taskId)))).filter(Boolean);
      if (!removedTasks.length) continue;
      // Restoring is safe only when every Task associated with the removed
      // user turn failed before the native Agent started. A started Task proves
      // that the newer context epoch is a real history boundary.
      if (removedTasks.some((task) => task.startedAt)) return route;
      for (const candidate of candidates) {
        const candidateAgentBindingId = bindingIdFor(candidate);
        if (!removedTasks.some((task) => task.agentBindingId === candidateAgentBindingId)) continue;
        const runtimeBinding = await this.container.taskRuntime.loadBinding(candidateAgentBindingId);
        const nativeSession = runtimeBinding?.native?.sessionId
          || runtimeBinding?.native?.threadId
          || runtimeBinding?.state?.sessionId
          || null;
        if (!nativeSession) continue;
        await workspaces.restoreUnusedContextEpoch({
          conversationId,
          branchId,
          currentBindingId: current.id,
          targetBindingId: candidate.id,
          commandId: `repair-unused-epoch-${crypto.createHash("sha256").update(`${current.id}:${candidate.id}`).digest("hex").slice(0, 24)}`,
        });
        return workspaces.getRoute({ conversationId, branchId });
      }
    }
    return route;
  }

  async #run(input, { signal } = {}) {
    signal?.throwIfAborted();
    const detail = await this.container.baseConversations.getConversation(input.conversationId);
    const branchId = detail.summary.activeBranchId;
    await this.container.broker.append(`conversation:${detail.summary.id}`, {
      producer: "web-agent",
      kind: "run.started",
      status: null,
      ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: input.messageId },
      payload: {
        mode: detail.summary.mode,
        ...(String(input.scope?.directRemoteTaskId || "").trim() ? { directRemoteTask: true } : {}),
      },
    });
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
    const persistentRun = await this.store.get(input.runId);
    let taskId = mode === "work" ? persistentRun?.taskIds?.at(-1) || null : null;
    const requestedScope = clone(input.scope || {});
    const explicitResourceSelection = Boolean(
      (Array.isArray(requestedScope.selectedCollectionIds) && requestedScope.selectedCollectionIds.length)
      || requestedScope.resourceSelectionRequested === true
    );
    const directRemoteTaskHint = String(requestedScope.directRemoteTaskId || "").trim();
    delete requestedScope.directRemoteTaskId;
    const project = detail.summary.projectId ? await this.container.projects.get(detail.summary.projectId) : null;
    requestedScope.memoryMode = project?.memoryMode || "global";
    requestedScope.selectedCollectionIds = [...new Set([
      ...(requestedScope.selectedCollectionIds || []).map(String),
      ...(project?.collectionIds || []).map(String),
    ])];
    let remoteRouteOutcome = null;
    let remoteConfigurationOutcome = null;
    if (requestedScope.serverId) {
      const server = await this.container.servers.get(String(requestedScope.serverId));
      invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
      invariant(!requestedScope.serverIdentity || requestedScope.serverIdentity === server.profile.serverIdentity, "SERVER_IDENTITY_MISMATCH", "服务器身份与当前 SSH 配置不一致", { status: 409 });
      requestedScope.serverIdentity = server.profile.serverIdentity;
      // Only an explicit user turn renews the server's idle lease. Background
      // capability, scheduler and file reads intentionally do not.
      await this.container.sshWorker.touch(String(requestedScope.serverId)).catch(() => undefined);
      const workspacePreparation = requestedScope.workspacePreparation && typeof requestedScope.workspacePreparation === "object"
        ? clone(requestedScope.workspacePreparation)
        : null;
      delete requestedScope.workspacePreparation;
      if (workspacePreparation?.kind === "virtual" && !requestedScope.workspacePath) {
        // A newly allocated virtual path is resolved by the remote preparation
        // lane. Web reasoning must not wait for that remote read merely to
        // render its optional current-state preface.
        requestedScope.deferWorkspaceState = true;
      }
      if (workspacePreparation?.kind === "virtual" && !requestedScope.workspaceId) {
        requestedScope.workspaceId = createVirtualWorkspaceId({
          actorId: this.container.actor.actorId,
          serverIdentity: server.profile.serverIdentity,
          conversationId: input.conversationId,
          branchId,
        });
      }
      if (mode === "work" && !taskId && requestedScope.workspaceId && requestedScope.agentId) {
        const preparationInput = {
          conversationId: input.conversationId,
          branchId,
          workspaceId: String(requestedScope.workspaceId),
          agentId: String(requestedScope.agentId),
          contextEpoch: Number(requestedScope.contextEpoch || 0),
        };
        const configurationSourceScope = String(requestedScope.agentConfigSourceScope || "").trim();
        const requestedAgentId = String(requestedScope.agentId || "");
        const configuredAgents = new Set((Array.isArray(requestedScope.agentConfigIds) ? requestedScope.agentConfigIds : [])
          .map(String)
          .filter(Boolean));
        const configurationAgentIds = requestedAgentId && configuredAgents.has(requestedAgentId)
          ? [requestedAgentId]
          : [];
        delete requestedScope.agentConfigSourceScope;
        delete requestedScope.agentConfigIds;
        // The deterministic route, remote binding metadata, and isolated Agent
        // configuration are independent of Web Agent reasoning.  Start them now;
        // the version ledger itself is materialized by Task parallel preparation.
        remoteRouteOutcome = (async () => {
            const workspaces = await this.container.workspaceFor(String(requestedScope.serverId), server.profile.serverIdentity);
            if (workspacePreparation?.kind === "virtual") {
              await workspaces.createVirtual({
                conversationId: input.conversationId,
                branchId,
                serverIdentity: server.profile.serverIdentity,
                workspaceId: preparationInput.workspaceId,
                expectedRevision: 0,
                commandId: `prepare-virtual-${crypto.createHash("sha256").update(`${input.runId}:${preparationInput.workspaceId}`).digest("hex").slice(0, 24)}`,
              });
            }
            let route = await workspaces.getRoute({ conversationId: input.conversationId, branchId });
            if (route) {
              route = await this.#repairRedundantContextEpoch({
                workspaces,
                route,
                conversationId: input.conversationId,
                branchId,
                messages,
              });
              invariant(route.binding.workspaceId === preparationInput.workspaceId && route.binding.agentId === preparationInput.agentId, "WORK_ROUTE_STALE", "当前工作区或 Agent 路由已经变化，请刷新后重试", { status: 409 });
              preparationInput.contextEpoch = route.binding.contextEpoch;
            }
            if (!route) {
              await workspaces.ensureAgentBinding({
                ...preparationInput,
                commandId: `ensure-version-${crypto.createHash("sha256").update(JSON.stringify(preparationInput)).digest("hex").slice(0, 24)}`,
                expectedRevision: 0,
              });
              route = await workspaces.getRoute({ conversationId: input.conversationId, branchId });
            }
            const preparedRoute = route;
            invariant(preparedRoute, "WORK_ROUTE_REQUIRED", "当前分支缺少工作区与 Agent 绑定", { status: 409 });
            invariant(preparedRoute.binding.workspaceId === preparationInput.workspaceId && preparedRoute.binding.agentId === preparationInput.agentId, "WORK_ROUTE_STALE", "当前工作区或 Agent 路由已经变化，请刷新后重试", { status: 409 });
            const preparedWorkspace = preparedRoute.workspace;
            return { preparedRoute, preparedWorkspace };
          })().then((result) => ({ result }), (error) => ({ error }));
        remoteConfigurationOutcome = (async () => {
            if (!configurationSourceScope || !configurationAgentIds.length) return [];
            // New conversations inherit the server-wide default dynamically.
            // Only an explicit conversation/branch override is materialized.
            if (configurationSourceScope === "default") return [];
            const backend = await this.container.remoteBackend(String(requestedScope.serverId));
            invariant(typeof backend.agentConfiguration?.materializeScopes === "function", "AGENT_CONFIG_SCOPES_MATERIALIZE_UNAVAILABLE", "远端 backend 未提供当前配置作用域物化能力", { status: 503 });
            return backend.agentConfiguration.materializeScopes(configurationAgentIds, {
              sourceScope: configurationSourceScope,
              targetScope: input.conversationId,
            });
          })().then((result) => ({ result }), (error) => ({ error }));
      }
    }
    let directRemoteTask = null;
    if (mode === "work" && !taskId && requestedScope.serverId && requestedScope.workspaceId && requestedScope.agentId) {
      const matchesRoute = (task) => Boolean(task
        && task.conversationId === input.conversationId
        && task.branchId === branchId
        && task.route?.serverId === String(requestedScope.serverId)
        && task.route?.workspaceId === String(requestedScope.workspaceId)
        && task.route?.agentId === String(requestedScope.agentId));
      if (directRemoteTaskHint) {
        const hintedTask = await this.container.taskStore.getTask(directRemoteTaskHint);
        invariant(matchesRoute(hintedTask), "DIRECT_REMOTE_TASK_MISMATCH", "运行中追加的任务与当前对话路由不一致，请刷新后重试", { status: 409 });
        directRemoteTask = hintedTask;
      } else {
        const runningTasks = await this.container.taskStore.listTasks({
          conversationId: input.conversationId,
          statuses: ["running"],
          limit: 1000,
        });
        const matchingRunningTasks = runningTasks.filter(matchesRoute);
        invariant(matchingRunningTasks.length <= 1, "CONVERSATION_TASK_STATE_AMBIGUOUS", "当前 Agent 与工作区存在多个运行中任务，无法安全投递", { status: 409 });
        directRemoteTask = matchingRunningTasks[0] || null;
      }
    }
    const scope = await this.container.memoryCoordinator.freezeScope(effectiveScope(this.container.actor, detail.summary, branchId, requestedScope));
    // A raw handoff is allowed only for a message submitted while the exact
    // remote Task is running. Interrupted Tasks are terminal: their next user
    // message starts a normal Web Agent turn and a new EasyWork Task, while the
    // deterministic Agent binding keeps the native remote conversation intact.
    const skipWebAgentModel = mode === "work" && !taskId && Boolean(directRemoteTask);
    const rememberRoutePromise = this.container.conversationContext.rememberRoute(input.conversationId, {
      providerId: input.providerId,
      modelId: input.modelId,
    });
    const modelPromise = skipWebAgentModel
      ? Promise.resolve({ complete: async () => { throw new Error("Direct Work handoff does not invoke the Web Agent model"); } })
      : this.container.runtime.createWebModel({
          actor: this.container.actor,
          providerId: input.providerId,
          modelId: input.modelId,
          mode,
          runId: input.runId,
        });
    const agentScope = { ...requestedScope, ...scope, agentId: requestedScope.agentId || null };
    if (mode === "work" && !taskId && !skipWebAgentModel && remoteRouteOutcome && requestedScope.agentId && typeof this.container.agentTransport?.prepare === "function") {
      // Start native preparation eagerly, but leave the durable Task as the
      // authoritative owner of any failure.  Managed configuration waits for
      // the in-flight scope materialization inside runtimeValues().
      void Promise.all([remoteRouteOutcome, remoteConfigurationOutcome || Promise.resolve({ result: [] })]).then(async ([routeOutcome, configurationOutcome]) => {
        if (routeOutcome.error) throw routeOutcome.error;
        if (configurationOutcome.error) throw configurationOutcome.error;
        const prepared = routeOutcome.result;
        const preparedScope = {
          ...agentScope,
          contextEpoch: prepared.preparedRoute.binding.contextEpoch,
          versionDomainId: prepared.preparedRoute.binding.versionDomainId,
        };
        const agentBindingId = createAgentBindingKey(preparedScope, requestedScope.agentId);
        const existingBinding = await this.container.taskRuntime.loadBinding(agentBindingId);
        const binding = existingBinding || {
          agentBindingId,
          adapterId: String(requestedScope.agentId),
          route: {
            serverId: String(requestedScope.serverId),
            serverIdentity: String(requestedScope.serverIdentity),
            workspaceId: String(requestedScope.workspaceId),
            agentId: String(requestedScope.agentId),
          },
          state: {},
          native: {},
          activeRunId: null,
        };
        return this.container.agentTransport.prepare({
          task: {
            conversationId: input.conversationId,
            route: {
              serverId: String(requestedScope.serverId),
              serverIdentity: String(requestedScope.serverIdentity),
              workspaceId: String(requestedScope.workspaceId),
              agentId: String(requestedScope.agentId),
              providerId: String(requestedScope.agentProviderId || input.providerId),
              modelId: String(requestedScope.agentModelId || input.modelId),
            },
          },
          adapterId: String(requestedScope.agentId),
          binding,
          workspace: { path: prepared.preparedWorkspace.canonicalPath },
          agentSource: binding.native?.agentSource || null,
        });
      }).catch(() => undefined);
    }
    const taskLifecycle = mode === "work" ? new RemoteTaskLifecycle(this.container, {
      providerId: input.providerId,
      modelId: input.modelId,
      messageId: target.id,
      runId: input.runId,
    }) : null;
    let resolvedAgentBindingScopePromise = null;
    const resolvedAgentBindingScope = () => {
      resolvedAgentBindingScopePromise ||= (async () => {
        if (!(mode === "work" && !taskId && remoteRouteOutcome && requestedScope.agentId)) {
          return { ...scope, agentId: requestedScope.agentId || null };
        }
        const routeOutcome = await remoteRouteOutcome;
        if (routeOutcome.error) throw routeOutcome.error;
        return {
          ...scope,
          contextEpoch: routeOutcome.result.preparedRoute.binding.contextEpoch,
          versionDomainId: routeOutcome.result.preparedRoute.binding.versionDomainId,
          agentId: requestedScope.agentId,
        };
      })();
      return resolvedAgentBindingScopePromise;
    };
    const requestedWorkSources = mode === "work"
      ? workSourceIntent(target.content)
      : Object.freeze({ memory: true, resources: true, skills: true });
    const allowWorkSkills = mode !== "work" || requestedWorkSources.skills || scope.selectedSkillVersions.length > 0;
    let requestRelevantInstalledSkillsPromise = null;
    const requestRelevantInstalledSkills = () => {
      requestRelevantInstalledSkillsPromise ||= (async () => {
        if (skipWebAgentModel) return [];
        const result = await this.container.skills.listInstalledKnowledge();
        let items = (Array.isArray(result?.items) ? result.items : []).filter((skill) => isSkillApplicableToMode({ skill, mode }));
        const explicitlySelected = new Set(scope.selectedSkillVersions.map((entry) => String(entry.skillId)));
        if (mode === "work" && scope.serverId) {
          const automaticallyApplicable = await this.container.filterSkillCatalogForServer(scope.serverId, items);
          const applicableIds = new Set(automaticallyApplicable.map((entry) => String(entry.skillId)));
          items = items.filter((skill) => applicableIds.has(String(skill.skillId)));
        }
        items = items.filter((skill) => (mode === "work" && isForcedWorkSkill(skill)) || (allowWorkSkills && (explicitlySelected.has(String(skill.skillId))
          || isAutomaticSkillRelevantToRequest({ skill, request: target.content, mode }))));
        return items;
      })();
      return requestRelevantInstalledSkillsPromise;
    };
    const filterWorkObservations = async (fragments) => {
      if (!Array.isArray(fragments) || !fragments.length) return [];
      if (!taskLifecycle) return fragments;
      const eligibleSkillIds = new Set((await requestRelevantInstalledSkills()).map((entry) => String(entry.skillId)));
      const eligibleFragments = filterEligibleSkillObservations(fragments, eligibleSkillIds);
      if (!eligibleFragments.length) return [];
      return taskLifecycle.filterHandoff({
        scope: await resolvedAgentBindingScope(),
        fragments: eligibleFragments,
      });
    };
    const priorObservationsPromise = skipWebAgentModel
      ? Promise.resolve([])
      : allMessages(this.container.baseConversations, input.conversationId, branchId).then((messages) => (
          this.container.webAgentObservations.list({
            conversationId: input.conversationId,
            branchId,
            sourceMessageIds: messages.map((message) => message.id),
          })
        )).then((fragments) => this.container.memory.filterObservations?.(fragments) ?? fragments);
    // Filtering historical observations also migrates already-acknowledged
    // complete reads to file-version coverage receipts. Do this before exposing
    // the catalog, so a same-session Work turn does not even see files it has
    // already delivered.
    const historicalCoverageReadyPromise = mode === "work" && !skipWebAgentModel && taskLifecycle
      ? priorObservationsPromise.then(async (fragments) => {
          await filterWorkObservations(fragments);
          return true;
        })
      : Promise.resolve(true);
    let applicableInstalledSkillCatalogPromise = null;
    const applicableInstalledSkillCatalog = () => {
      applicableInstalledSkillCatalogPromise ||= (async () => {
        let items = await requestRelevantInstalledSkills();
        if (taskLifecycle) {
          items = await taskLifecycle.filterForcedSkillCatalog({ scope: await resolvedAgentBindingScope(), skills: items });
        }
        if (mode === "work" && items.length) {
          const probes = items.map((item) => ({
            toolName: "skill_list",
            rendered: String(item.name || item.skillId || "Skill"),
            presented: {},
            knowledge: item.knowledge,
            priority: 0,
          }));
          const visible = await filterWorkObservations(probes);
          const identities = new Set(visible.map((entry) => `${entry?.knowledge?.key || ""}\0${entry?.knowledge?.version || ""}`));
          items = items.filter((item) => identities.has(`${item?.knowledge?.key || ""}\0${item?.knowledge?.version || ""}`));
        }
        return items;
      })();
      return applicableInstalledSkillCatalogPromise;
    };
    let installedSkillCatalogPromise = null;
    const installedSkillCatalog = () => {
      installedSkillCatalogPromise ||= (async () => {
        let items = await applicableInstalledSkillCatalog();
        if (mode === "work") {
          const pinnedIds = new Set(scope.selectedSkillVersions.map((entry) => entry.skillId));
          items = items.filter((entry) => !pinnedIds.has(entry.skillId) && !isForcedWorkSkill(entry));
        }
        return items;
      })();
      return installedSkillCatalogPromise;
    };
    const explicitlySelectedSkillEvidencePromise = mode === "work" && !skipWebAgentModel
      ? (async () => {
          const applicable = await applicableInstalledSkillCatalog();
          const pins = new Map(scope.selectedSkillVersions.map((entry) => [String(entry.skillId), entry]));
          const selected = applicable.filter((entry) => pins.has(String(entry.skillId)) || isForcedWorkSkill(entry));
          const groups = await Promise.all(selected.map((entry) => this.container.skills.searchContext({
            query: String(target.content || entry.skillId),
            limit: 1,
            selectedSkillIds: [entry.skillId],
            ...(pins.has(String(entry.skillId)) ? { selectedSkillVersions: [pins.get(String(entry.skillId))] } : {}),
          })));
          const evidence = groups.flat();
          return evidence;
        })()
      : Promise.resolve([]);
    const hasSelectedResourceScope = requestedScope.selectedCollectionIds.length > 0 || requestedScope.resourceSelectionRequested === true;
    // Composer selections are only the newest way a resource can enter the
    // effective scope. Conversation attachments and files bound directly to a
    // project remain available on later turns after their chips are cleared.
    // Probe the authorized catalog before allowing the empty-handoff fast path.
    const allowWorkResources = mode !== "work" || requestedWorkSources.resources || hasSelectedResourceScope;
    // Chat and Work must discover files from the same authorized catalog.
    // Work additionally filters entries already known by the target native
    // session, while Chat consumes the catalog directly.
    const scopedResourceCatalogPromise = !skipWebAgentModel && allowWorkResources
      ? Promise.all([
          historicalCoverageReadyPromise,
          this.container.resources.catalog({ scope, limit: 80 }),
        ]).then(async ([, catalog]) => taskLifecycle
          ? taskLifecycle.filterResourceCatalog({ scope: await resolvedAgentBindingScope(), catalog })
          : catalog)
      : Promise.resolve({ items: [] });
    const workResourceToolsPromise = mode === "work" && !skipWebAgentModel
      ? scopedResourceCatalogPromise.then((catalog) => hasSelectedResourceScope || (Array.isArray(catalog?.items) && catalog.items.length > 0))
      : Promise.resolve(mode !== "work");
    const workMemoryToolsPromise = mode === "work" && !skipWebAgentModel && requestedWorkSources.memory
      ? this.container.searchContext({
          scope,
          query: "",
          sources: ["memory"],
          limit: 1,
          excludeMessageId: target.id,
          excludeAgentBindingId: requestedScope.agentId
            ? createAgentBindingKey(scope, requestedScope.agentId)
            : null,
        }).then((result) => Array.isArray(result?.memory) && result.memory.length > 0)
      : Promise.resolve(mode !== "work");
    const workSkillToolsPromise = mode === "work" && !skipWebAgentModel
      ? installedSkillCatalog().then((catalog) => catalog.length > 0)
      : Promise.resolve(mode !== "work");
    const conversationReferences = Array.isArray(target.references) ? target.references : [];
    const toolsPromise = skipWebAgentModel ? Promise.resolve({
      resolve: () => null,
      definitions: () => [],
    }) : Promise.all([workMemoryToolsPromise, workSkillToolsPromise, workResourceToolsPromise]).then(([workMemoryTools, workSkillTools, workResourceTools]) => createDefaultWebAgentTools({
      context: {
        // The Web Agent execution scope also carries routing-only fields such as
        // agentId.  Context and memory services intentionally accept only the
        // canonical EffectiveContextScope, so always bind tool calls to the
        // frozen snapshot instead of passing the model-facing scope through.
        search: (query) => this.container.searchContext({
          ...query,
          scope,
          filterSkillsByServer: mode === "work",
          mode,
          excludeMessageId: target.id,
          excludeAgentBindingId: mode === "work" && requestedScope.agentId
            ? createAgentBindingKey(scope, requestedScope.agentId)
            : null,
        }),
        readResource: async ({ filename, start }) => {
          const result = await this.container.resources.read({ scope, filename, start });
          return { resources: result.results, modelImages: result.modelImages };
        },
        state: ({ fields } = {}) => this.container.contextState(scope, requestedScope, fields, { includeCapabilities: true }),
      },
      skills: {
        list: async () => {
          const items = await installedSkillCatalog();
          // Receipt identities are control-plane data and must never be shown
          // to the model. The Web Agent only receives the readable catalog.
          return items.map((item) => {
            const entry = { ...item };
            delete entry.knowledge;
            delete entry.applicability;
            return entry;
          });
        },
        read: async ({ name, query }) => {
          const installed = await installedSkillCatalog();
          const normalizedName = String(name || "").trim().toLocaleLowerCase("zh-CN");
          const skill = installed.find((entry) => String(entry.name || "").trim().toLocaleLowerCase("zh-CN") === normalizedName);
          if (!skill) return { skills: [] };
          const pinnedVersion = scope.selectedSkillVersions.find((entry) => entry.skillId === skill.skillId) || null;
          const items = await this.container.skills.searchContext({
            query: String(query || name || "").trim(),
            limit: 1,
            selectedSkillIds: [skill.skillId],
            ...(pinnedVersion ? { selectedSkillVersions: [pinnedVersion] } : {}),
          });
          return { skills: items };
        },
      },
      conversationReferences: {
        read: async ({ referenceId, query, roles, cursor }) => {
          const configuration = await this.container.embedding.memoryConfiguration().catch(() => ({ pageSize: 20 }));
          const result = await this.container.baseConversations.readConversationReference({
            conversationId: input.conversationId,
            messageId: target.id,
            referenceId,
            ...(query ? { query } : {}),
            ...(roles?.length ? { roles } : {}),
            ...(cursor ? { cursor } : {}),
            limit: configuration.pageSize,
          });
          return {
            conversation: result.items,
            nextCursor: result.nextCursor,
            reference: result.reference,
          };
        },
      },
    }, this.container.runtime.prompts, {
      workMemoryTools,
      workResourceTools,
      workSkillTools,
      conversationReferences,
    }));
    const historyPromise = skipWebAgentModel
      ? Promise.resolve([])
      : this.container.conversationContext.history(input.conversationId, branchId).then((entries) => (mode === "work"
        ? workConversationState(entries, target.id)
        : settledConversationHistory(entries, target.id))
        .map(({ role, content }) => ({ role, content })));
    const workEnvironmentPromise = mode === "work" && !taskId && !skipWebAgentModel
      ? (async () => {
          const state = workCurrentState(
            await this.container.contextState(scope, requestedScope, ["server", "workspace", "agent"], { includeCapabilities: true }),
            requestedScope,
          );
          return { state, rendered: await renderSemanticContext(state, this.container.runtime.prompts) };
        })()
      : Promise.resolve({ state: null, rendered: "" });
    const resourceCatalogPromise = !skipWebAgentModel
      ? Promise.all([workResourceToolsPromise, scopedResourceCatalogPromise]).then(async ([resourceToolsAvailable, catalog]) => {
          const catalogItems = Array.isArray(catalog?.items) ? catalog.items : [];
          if (!resourceToolsAvailable || (!hasSelectedResourceScope && catalogItems.length === 0)) return "";
          const collections = await this.container.collections.list();
          const collectionNames = new Map(collections.map((entry) => [entry.id, entry.name]));
          const entries = catalogItems.map((item) => {
            const visibleItem = { ...item };
            delete visibleItem.resourceId;
            delete visibleItem.resourceVersionId;
            const sources = [...new Set(item.bindings.map((binding) => {
              if (binding.ownerType === "collection") return collectionNames.get(binding.ownerId) || "文件集";
              if (binding.ownerType === "project") return project?.name || "当前项目";
              return "当前对话附件";
            }))];
            return { ...visibleItem, source: sources.join("、") || "文件库" };
          });
          return this.container.runtime.prompts.resourceCatalog(entries);
        })
      : Promise.resolve("");
    const conversationReferenceCatalogPromise = !skipWebAgentModel && conversationReferences.length
      ? this.container.runtime.prompts.conversationReferenceCatalog(conversationReferences)
      : Promise.resolve("");
    const [model, tools, , , history, priorObservations, workEnvironment, resourceCatalog, conversationReferenceCatalog, explicitlySelectedSkills, requestRelevantSkills] = await Promise.all([
      modelPromise,
      toolsPromise,
      workResourceToolsPromise,
      rememberRoutePromise,
      historyPromise,
      priorObservationsPromise,
      workEnvironmentPromise,
      resourceCatalogPromise,
      conversationReferenceCatalogPromise,
      explicitlySelectedSkillEvidencePromise,
      requestRelevantInstalledSkills(),
    ]);
    const sourceFilteredPriorObservations = priorObservations.filter((fragment) => {
          const toolName = String(fragment?.toolName || "");
          if (toolName === "conversation_sync") return false;
          // An explicit @ reference belongs to exactly one user message. It may
          // be reread from that message's frozen snapshot, but its observation
          // is never silently restored into a later turn.
          if (toolName === "conversation_reference_read") return false;
          if (mode !== "work") return true;
          if (toolName === "memory_search") return requestedWorkSources.memory;
          if (toolName === "resource_search" || toolName === "resource_read") return allowWorkResources;
          if (toolName === "skill_list" || toolName === "skill_search") return allowWorkSkills;
          return true;
        });
    const relevantHistoricalObservations = mode === "work"
      ? filterRelevantHistoricalObservations(sourceFilteredPriorObservations, {
          request: target.content,
          skills: requestRelevantSkills,
          // A project file set remains searchable on every turn, but it must
          // not rehydrate every old read merely because the project owns a
          // collection. Only an explicit composer selection restores the
          // whole selected resource scope.
          includeAllResources: explicitResourceSelection,
        })
      : sourceFilteredPriorObservations;
    const forcedSkillIds = new Set((mode === "work" ? requestRelevantSkills.filter(isForcedWorkSkill) : []).map((skill) => `skill:${skill.skillId}`));
    const modelObservations = relevantHistoricalObservations.filter((fragment) => !forcedSkillIds.has(String(fragment.knowledge?.key || "")));
    const initialObservationFragments = mode === "work"
      ? await filterWorkObservations(modelObservations)
      : filterEligibleSkillObservations(modelObservations, new Set(requestRelevantSkills.map((skill) => String(skill.skillId))));
    let initialHandoffFragments = [];
    if (mode === "work" && explicitlySelectedSkills.length) {
      const skillTool = tools.resolve("skill_search", "chat");
      invariant(skillTool, "WEB_AGENT_SKILL_TOOL_REQUIRED", "网页 Agent 缺少 Skill 语义适配器", { status: 500, expose: false });
      const output = { skills: explicitlySelectedSkills };
      const presented = await skillTool.present({ output });
      const rendered = await skillTool.render(presented);
      initialHandoffFragments = await skillTool.handoffItems({ output, presented, rendered });
    }
    const runtime = new WebAgentRuntime({
      model,
      tools,
      prompts: this.container.runtime.prompts,
      ...(mode === "work" ? { limits: WORK_WEB_AGENT_LIMITS } : {}),
      eventSink: (event) => this.container.broker.append(`conversation:${detail.summary.id}`, {
        eventId: event.eventId,
        producer: event.producer,
        kind: event.kind,
        status: null,
        ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: target.id },
        payload: event.payload,
      }),
    });
    if (workEnvironment.state) {
      await this.container.broker.append(`conversation:${detail.summary.id}`, {
        producer: "web-agent",
        kind: "run.context.state",
        status: "completed",
        ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: target.id },
        payload: { state: workEnvironment.state },
      });
    }
    const modelContext = [workEnvironment.rendered, conversationReferenceCatalog, resourceCatalog]
      .filter(Boolean)
      .map((content) => ({ role: "system", content }))
      .concat(history);
    let result;
    let taskStatus = null;
    let sentHandoffFragments = [];
    let remoteObservation = null;
    if (mode === "work" && taskId) {
      result = { runId: input.runId, content: "", reasoning: "", usage: null, iterations: 0, toolCallCount: 0, recovered: true };
    } else {
      result = await runtime.run({
        mode,
        actor: this.container.actor,
        scope: agentScope,
        userMessage: target.content,
        context: modelContext,
        initialObservationFragments,
        // Deterministic selections belong to delivery, not the model's
        // candidate pool. In particular a forced Skill is never reread or
        // reconsidered by the Web Agent.
        requiredHandoffFragments: initialHandoffFragments,
        observationSink: (fragments) => this.container.webAgentObservations.record({
          conversationId: input.conversationId,
          branchId,
          sourceMessageId: target.id,
          fragments,
        }),
        runId: input.runId,
        signal,
        emitStarted: false,
        skipModel: skipWebAgentModel,
        ...(taskLifecycle ? {
          observationFilter: filterWorkObservations,
          handoffFilter: filterWorkObservations,
        } : {}),
      });
    }
    signal?.throwIfAborted();
    if (mode === "work") {
      if (!taskId) {
        if (remoteRouteOutcome) {
          const routeOutcome = await remoteRouteOutcome;
          if (routeOutcome.error) throw routeOutcome.error;
          const prepared = routeOutcome.result;
          agentScope.contextEpoch = prepared.preparedRoute.binding.contextEpoch;
          agentScope.versionDomainId = prepared.preparedRoute.binding.versionDomainId;
        }
        // The orchestrator starts the same preparation while version, Skill,
        // and context work runs in parallel. AgentRuntimeTransport coalesces it
        // with this early warmup, so dispatch must not wait for it here.
        const mergedSkillPins = new Map((Array.isArray(agentScope.skillPins) ? agentScope.skillPins : [])
          .map((pin) => [String(pin.skillId), pin]));
        const submittedSkills = (result.selectedHandoffFragments || result.handoffFragments || [])
          .filter((fragment) => String(fragment?.knowledge?.key || "").startsWith("skill:"));
        // Cached observations and newly read candidates use the same exact
        // registry resolution. A tool read in this round is not a receipt.
        const resolvedPins = submittedSkills.length ? await this.container.skills.resolveKnowledgePins(submittedSkills) : [];
        for (const pin of resolvedPins) mergedSkillPins.set(pin.skillId, pin);
        agentScope.skillPins = [...mergedSkillPins.values()];
        const dispatch = await taskLifecycle.dispatch({
          scope: agentScope,
          userMessage: target.content,
          // WebAgentRuntime already applies the binding receipt filter before
          // showing “已发送” in the timeline. The lifecycle checks that exact
          // set once more against the final native session only as a
          // last-moment consistency guard.
          handoffFragments: result.handoffFragments || [],
          idempotencyKey: `${input.runId}:handoff`,
          directRemoteTaskId: directRemoteTask?.id || null,
        }).catch((error) => {
          taskLifecycle.settleForcedSkillDelivery(agentScope, null);
          throw error;
        });
        taskLifecycle.settleForcedSkillDelivery(agentScope, dispatch);
        taskId = dispatch.taskId;
        if (dispatch.operation === "create") sentHandoffFragments = [...(dispatch.handoffFragments || [])];
        const deliveredReferences = handoffEventReferences(dispatch.handoffFragments || []);
        const deliveredContext = (dispatch.handoffFragments || []).some((fragment) => (
          !String(fragment?.knowledge?.key || "").startsWith("skill:")
          && Boolean(String(fragment?.rendered || fragment?.knowledge?.content || "").trim())
        ));
        await this.container.broker.append(`conversation:${detail.summary.id}`, {
          producer: "web-agent",
          kind: "run.handoff.dispatched",
          status: "completed",
          ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: target.id, taskId },
          payload: {
            operation: dispatch.operation,
            taskId,
            contextIncluded: dispatch.operation === "create" && deliveredContext,
            references: dispatch.operation === "create" ? deliveredReferences : [],
          },
        });
        // A Task journal is the immutable, self-contained history of one
        // webpage turn.  Mirror the preceding Web Agent events into it once a
        // remote Task exists so derived conversations can render the complete
        // pre-fork thought and Agent activity without consulting their parent.
        await this.#mirrorWebRunHistoryToTask({
          conversationId: detail.summary.id,
          runId: input.runId,
          sourceMessageId: target.id,
          taskId,
        });
      }
      const observation = await taskLifecycle.waitFor(taskId);
      remoteObservation = observation;
      taskStatus = String(observation.task?.status || "");
      const remoteFinal = String(observation.report?.remoteFinal?.text || "").trim();
      if (taskStatus === "failed") {
        await this.container.contextHub.discardStagedKnowledge(taskId).catch(() => undefined);
        throw new ApiError(observation.task?.failure?.code || "REMOTE_AGENT_FAILED", observation.task?.failure?.message || "远端 Agent 执行失败", {
          status: 502,
          retryable: Boolean(observation.task?.failure?.retryable),
        });
      }
      if (taskStatus === "completed") {
        invariant(remoteFinal, "REMOTE_AGENT_FINAL_MISSING", "远端 Agent 已结束，但没有提供最终回复", { status: 502 });
        await this.#acknowledgeNativeConversation(observation.task, [
          await this.container.runtime.prompts.conversationMessage("user", target.content),
          await this.container.runtime.prompts.conversationMessage("assistant", remoteFinal),
          ...sentHandoffFragments.filter((entry) => !entry?.knowledge).map((entry) => String(entry?.rendered || "")),
        ], sentHandoffFragments
          .filter((entry) => !String(entry?.knowledge?.key || "").startsWith("skill:"))
          .map((entry) => entry?.knowledge)
          .filter(Boolean), observation.report, { checkpoint: false });
        result = { ...result, content: remoteFinal };
      } else if (["interrupted", "cancelled"].includes(taskStatus)) {
        const nativeConversationKnowledge = await taskLifecycle.nativeTaskConversationKnowledge(
          observation.task,
          detail.summary.id,
          branchId,
          { includeAssistant: false },
        );
        const acknowledged = await this.#acknowledgeNativeConversation(observation.task, [
          await this.container.runtime.prompts.conversationMessage("user", target.content),
          ...sentHandoffFragments.filter((entry) => !entry?.knowledge).map((entry) => String(entry?.rendered || "")),
        ], sentHandoffFragments
          .filter((entry) => !String(entry?.knowledge?.key || "").startsWith("skill:"))
          .map((entry) => entry?.knowledge)
          .filter(Boolean)
          .concat(Array.isArray(nativeConversationKnowledge) ? nativeConversationKnowledge : []), observation.report);
        if (!acknowledged) await this.container.contextHub.discardStagedKnowledge(taskId).catch(() => undefined);
        await this.container.broker.append(`conversation:${detail.summary.id}`, {
          producer: "web-agent",
          kind: "run.suspended",
          status: taskStatus,
          ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: target.id, taskId },
          payload: { taskId, taskStatus },
        });
        await this.#mirrorWebRunHistoryToTask({
          conversationId: detail.summary.id,
          runId: input.runId,
          sourceMessageId: target.id,
          taskId,
        });
        return { ...result, content: "", messageId: null, conversation: detail.summary, taskId, taskStatus };
      }
    }
    let latestDetail = await this.container.baseConversations.getConversation(input.conversationId);
    let latestMessages = await allMessages(this.container.baseConversations, input.conversationId, latestDetail.summary.activeBranchId);
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
          ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: target.id, taskId },
          payload: { supersededByRunId: owner.runId, taskId },
        });
        return { ...result, content: "", messageId: null, conversation: latestDetail.summary, taskId, taskStatus };
      }
    } else {
      invariant(latestMessages.at(-1)?.id === target.id, "RESPONSE_SUPERSEDED", "对话已出现更新的消息，本次回复不再落盘", { status: 409 });
    }
    let persisted = null;
    for (let attempt = 0; attempt < 5 && !persisted; attempt += 1) {
      try {
        persisted = await this.container.baseConversations.sendMessage({
          conversationId: input.conversationId,
          branchId,
          role: "assistant",
          content: result.content,
          taskId,
          expectedRevision: latestDetail.summary.revision,
          commandId: `persist:${input.runId}`,
        });
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT" || attempt === 4) throw error;
        latestDetail = await this.container.baseConversations.getConversation(input.conversationId);
        latestMessages = await allMessages(this.container.baseConversations, input.conversationId, latestDetail.summary.activeBranchId);
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
              ids: { conversationId: detail.summary.id, runId: input.runId, sourceMessageId: target.id, taskId },
              payload: { supersededByRunId: owner.runId, taskId },
            });
            return { ...result, content: "", messageId: null, conversation: latestDetail.summary, taskId, taskStatus };
          }
          const existing = [...latestMessages].reverse().find((message) => (
            message.role === "assistant" && message.taskId === taskId && message.content === result.content
          ));
          if (existing) persisted = { messageId: existing.id, conversation: latestDetail.summary };
        } else {
          invariant(latestMessages.at(-1)?.id === target.id, "RESPONSE_SUPERSEDED", "对话已出现更新的消息，本次回复不再落盘", { status: 409 });
        }
      }
    }
    invariant(persisted, "RESPONSE_PERSIST_FAILED", "回复未能写入对话", { status: 500 });
    if (mode === "work" && taskStatus === "completed" && remoteObservation?.task) {
      const nativeConversationKnowledge = await taskLifecycle.nativeTaskConversationKnowledge(
        remoteObservation.task,
        input.conversationId,
        branchId,
        { includeAssistant: true },
      );
      await this.#acknowledgeNativeConversation(
        remoteObservation.task,
        [],
        Array.isArray(nativeConversationKnowledge) ? nativeConversationKnowledge : [],
        remoteObservation.report,
      );
    }
    await this.container.broker.append(`conversation:${detail.summary.id}`, {
      producer: "web-agent",
      kind: "run.persisted",
      status: "completed",
      ids: { conversationId: detail.summary.id, messageId: persisted.messageId, sourceMessageId: target.id, runId: input.runId, ...(taskId ? { taskId } : {}) },
      payload: { conversationRevision: persisted.conversation.revision },
    });
    if (taskId) {
      await this.#mirrorWebRunHistoryToTask({
        conversationId: detail.summary.id,
        runId: input.runId,
        sourceMessageId: target.id,
        taskId,
      });
    }
    if (messages.length === 1 && detail.summary.title === defaultConversationTitle(target.content)) {
      await this.container.taskRuntime.launch(`title:${input.conversationId}:${target.id}`, () => (
        this.#generateConversationTitle({ input, mode, target, persisted, assistantResponse: result.content })
      ));
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
            observedKnowledge: memoryExtractionObservations(result.observedFragments),
            dedupeKey: `message:${persisted.messageId}`,
          });
        } catch { /* the completed reply remains authoritative when extraction fails */ }
      });
    }
    return { ...result, messageId: persisted.messageId, conversation: persisted.conversation, taskId, taskStatus };
  }

  async #generateConversationTitle({ input, mode, target, persisted, assistantResponse }) {
    const fallbackTitle = defaultConversationTitle(target.content);
    try {
      const current = await this.container.baseConversations.getConversation(input.conversationId);
      if (current.summary.title !== fallbackTitle) return;
      const titlePrompt = await this.container.runtime.prompts.conversationTitle({ userPrompt: target.content, assistantResponse });
      const rawTitle = await this.container.runtime.completeAuxiliary({
        actor: this.container.actor,
        providerId: input.providerId,
        modelId: input.modelId,
        mode,
        runId: `title_${crypto.createHash("sha256").update(`${input.conversationId}:${target.id}`).digest("hex").slice(0, 32)}`,
        system: titlePrompt.system,
        input: titlePrompt.input,
        // Reasoning models share the output budget between reasoning and text.
        // Keep the title concise through the prompt, without starving its answer.
        maxOutputTokens: null,
      });
      const title = normalizeGeneratedTitle(rawTitle);
      let renamed;
      for (;;) {
        const latest = await this.container.baseConversations.getConversation(input.conversationId);
        if (latest.summary.title !== fallbackTitle || title === fallbackTitle) return;
        try {
          renamed = await this.container.baseConversations.rename({
            conversationId: input.conversationId,
            title,
            expectedRevision: latest.summary.revision,
            commandId: derivedCommandId(`title:${input.conversationId}:${target.id}:${latest.summary.revision}`, "rename"),
          });
          break;
        } catch (error) {
          // Reuse the generated text when a message or metadata write races us.
          if (error?.code !== "REVISION_CONFLICT") throw error;
        }
      }
      const event = {
        producer: "web-agent",
        kind: "conversation.title.updated",
        status: "completed",
        ids: { conversationId: input.conversationId, messageId: persisted.messageId, sourceMessageId: target.id, runId: input.runId },
        payload: { title, conversationRevision: renamed.conversation.revision },
      };
      await this.container.broker.append(`conversation:${input.conversationId}`, event);
      await this.container.broker.append(`conversations:${this.container.actor.actorId}`, event);
    } catch (error) {
      await this.container.audit.append({
        action: "conversation.title.generate",
        status: "failure",
        target: { conversationId: input.conversationId },
        requestId: input.runId,
        metadata: { code: error?.code || "TITLE_GENERATION_FAILED", providerId: input.providerId, modelId: input.modelId },
      });
    }
  }

  async #acknowledgeNativeConversation(task, values, knowledge = [], report = null, { checkpoint = true } = {}) {
    if (!task?.agentBindingId) return false;
    const binding = await this.container.taskRuntime.loadBinding(task.agentBindingId);
    const nativeSession = binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId || null;
    const activeRunMatches = Boolean(task.remoteRunId && binding?.activeRunId === task.remoteRunId);
    const reportSessionIds = new Set((report?.evidence || [])
      .map((entry) => entry?.source?.sessionId)
      .filter(Boolean)
      .map(String));
    if (!nativeSession || (!activeRunMatches && !reportSessionIds.has(String(nativeSession)))) return false;
    await this.container.contextHub.acknowledgeSemanticContent({
      bindingKey: task.agentBindingId,
      nativeSessionId: nativeSession,
      values,
    });
    await this.container.contextHub.acknowledgeStagedKnowledge({
      bindingKey: task.agentBindingId,
      nativeSessionId: nativeSession,
      taskId: task.id,
      units: knowledge,
    });
    const reportTurnId = [...(report?.evidence || [])].reverse().find((entry) => (
      String(entry?.source?.sessionId || "") === String(nativeSession) && entry?.source?.turnId
    ))?.source?.turnId;
    if (checkpoint) {
      await this.container.contextHub.checkpointBinding({
        bindingKey: task.agentBindingId,
        nativeSessionId: nativeSession,
        checkpointId: task.id,
        nativeBoundary: {
          protocol: binding.adapterId,
          sessionId: nativeSession,
          turnId: reportTurnId || binding.native?.turnId || binding.state?.turnId || null,
          rolloutPath: binding.native?.rolloutPath || null,
          skillSnapshot: binding.native?.skillCheckpoints?.[task.id] || null,
        },
      });
    }
    return true;
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
    this.remoteBundlePending = new Map();
    this.schedulers = new Map();
    this.submissionTrackers = new Map();
    this.agentDeployments = new Map();
    this.deletedAgentCleanupRequests = new Set();
    this.conversationDeletionCleanup = new AtomicJsonRepository({
      dataRoot: runtime.dataRoot,
      actor,
      relativePath: ["runtime", "conversation-deletion-cleanup", "state.json"],
      schemaVersion: 1,
      // The legacy shape stored completed revisions.  Keep that shape as the
      // on-disk default so the one-time migration can also distinguish a new
      // actor from an actor whose pending queue has already been initialised.
      defaultData: () => ({ local: {}, remote: {} }),
      validate: (data) => Boolean(
        data && typeof data === "object" && !Array.isArray(data)
          && Object.keys(data).every((key) => ["mode", "local", "remote"].includes(key))
          && (data.mode === undefined || data.mode === "pending")
          && data.local && typeof data.local === "object" && !Array.isArray(data.local)
          && data.remote && typeof data.remote === "object" && !Array.isArray(data.remote)
          && Object.entries(data.local).every(([id, revision]) => id && typeof revision === "string")
          && Object.values(data.remote).every((records) => records && typeof records === "object" && !Array.isArray(records)
            && Object.entries(records).every(([id, revision]) => id && typeof revision === "string")),
      ),
      queue: runtime.queue,
    });
  }

  async #migrateConversationDeletionCleanupState() {
    for (;;) {
      const current = await this.conversationDeletionCleanup.read();
      if (current.data.mode === "pending") return current.data;

      // Version 1 originally persisted every completed cleanup revision.  Do
      // one final tombstone scan while upgrading, invert those completion
      // markers into a compact pending queue, and persist the mode marker.
      // Every later startup reads only this queue and never revisits historical
      // tombstones.
      const [deleted, servers] = await Promise.all([
        this.baseConversations.listDeletedConversations(),
        this.servers.list(),
      ]);
      const serverIdentities = [...new Set(servers
        .map((entry) => entry.profile?.serverIdentity)
        .filter(Boolean)
        .map(String))];
      const local = {};
      const remote = {};
      for (const conversation of deleted) {
        const revision = String(conversation.revision || 1);
        if (current.data.local[conversation.id] !== revision) local[conversation.id] = revision;
        for (const serverIdentity of serverIdentities) {
          if (current.data.remote[serverIdentity]?.[conversation.id] === revision) continue;
          remote[serverIdentity] = remote[serverIdentity] || {};
          remote[serverIdentity][conversation.id] = revision;
        }
      }
      try {
        const migrated = await this.conversationDeletionCleanup.replace({ mode: "pending", local, remote }, {
          expectedRevision: current.revision,
          clock: this.clock,
        });
        return migrated.data;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async #resumeConversationDeletionTransactions() {
    const cleanupState = (await this.conversationDeletionCleanup.read()).data;
    const pending = Object.entries(cleanupState.local).map(([id, revision]) => ({ id, revision }));
    if (!pending.length) return { scheduled: false, count: 0 };
    const deletedConversationIds = new Set((await this.baseConversations.listDeletedConversations())
      .map((conversation) => conversation.id));
    const launched = await this.taskRuntime.launch("conversation-delete:resume", async () => {
      // Build one shared task index inside the detached worker.  Previously
      // every deleted conversation cloned and sorted the complete task store
      // concurrently, which could exhaust the heap before the first page was
      // usable.  Keeping this scan off the bootstrap path also makes a restart
      // independent of historical cleanup volume.
      const allTaskSummaries = await this.taskStore.scanTasks();
      const tasksByConversation = new Map();
      for (const task of allTaskSummaries) {
        const records = tasksByConversation.get(task.conversationId) || [];
        records.push(task);
        tasksByConversation.set(task.conversationId, records);
      }
      const remoteServerIds = new Set();
      let cleanedCount = 0;
      for (const conversation of pending) {
        // The cleanup entry is prepared before the conversation index commit.
        // If the process stopped between those two durable writes, the visible
        // conversation is still live and the prepared entry is an aborted
        // transaction, not authority to remove any local or remote state.
        if (!deletedConversationIds.has(conversation.id)) {
          await this.#consumeConversationDeletionCleanup("local", null, conversation.id, String(conversation.revision));
          continue;
        }
        const source = {
          type: "conversation-delete-resume",
          id: conversation.id,
          version: String(conversation.revision),
        };
        try {
          const cleaned = await this.#cleanupDeletedConversation(conversation.id, source, {
            taskSummaries: tasksByConversation.get(conversation.id) || [],
            scheduleRemote: false,
          });
          await this.#consumeConversationDeletionCleanup("local", null, conversation.id, source.version);
          cleanedCount += 1;
          for (const serverId of cleaned.remoteServerIds) remoteServerIds.add(serverId);
        } catch (error) {
          console.error(JSON.stringify({
            scope: "conversation-delete-cleanup",
            conversationId: conversation.id,
            code: String(error?.code || "CONVERSATION_DELETE_CLEANUP_FAILED"),
            message: String(redactSensitive(String(error?.message || "对话后台清理失败"))).slice(0, 2_000),
          }));
        }
      }
      await Promise.allSettled([...remoteServerIds].map((serverId) => this.scheduleDeletedAgentConversationCleanup(serverId)));
      return { cleaned: cleanedCount, remoteServers: remoteServerIds.size };
    });
    void launched.promise.catch(() => undefined);
    return { scheduled: launched.accepted, count: pending.length };
  }

  async #pruneOrphanedServerConversationBindings() {
    const servers = await this.servers.list();
    const boundConversationIds = [...new Set(servers.flatMap((server) => server.conversationIds || []))];
    if (!boundConversationIds.length) return { removedConversationIds: [], removedCount: 0 };
    const liveConversations = await this.baseConversations.getConversationSummaries(boundConversationIds);
    const liveConversationIds = new Set(liveConversations.map((conversation) => conversation.id));
    return this.servers.removeConversationBindings(boundConversationIds.filter((conversationId) => !liveConversationIds.has(conversationId)));
  }

  async #enqueueConversationDeletionCleanup(scope, serverIdentity, conversationId, revision) {
    for (;;) {
      const current = await this.conversationDeletionCleanup.read();
      const key = String(serverIdentity || "");
      const expected = scope === "local"
        ? current.data.local[conversationId]
        : current.data.remote[key]?.[conversationId];
      if (expected === String(revision)) return false;
      try {
        await this.conversationDeletionCleanup.update((data) => {
          invariant(data.mode === "pending", "CONVERSATION_DELETE_CLEANUP_STATE_INVALID", "对话清理队列尚未初始化", { status: 500, expose: false });
          if (scope === "local") data.local[conversationId] = String(revision);
          else {
            data.remote[key] = data.remote[key] || {};
            data.remote[key][conversationId] = String(revision);
          }
        }, { expectedRevision: current.revision, clock: this.clock });
        return true;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async #consumeConversationDeletionCleanup(scope, serverIdentity, conversationId, revision) {
    for (;;) {
      const current = await this.conversationDeletionCleanup.read();
      const key = String(serverIdentity || "");
      const pendingRevision = scope === "local"
        ? current.data.local[conversationId]
        : current.data.remote[key]?.[conversationId];
      if (pendingRevision !== String(revision)) return false;
      try {
        await this.conversationDeletionCleanup.update((data) => {
          if (scope === "local") delete data.local[conversationId];
          else {
            delete data.remote[key][conversationId];
            if (!Object.keys(data.remote[key]).length) delete data.remote[key];
          }
        }, { expectedRevision: current.revision, clock: this.clock });
        return true;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async #hasPendingRemoteConversationCleanup(serverIdentity) {
    const state = (await this.conversationDeletionCleanup.read()).data;
    return Boolean(Object.keys(state.remote[String(serverIdentity || "")] || {}).length);
  }

  async #cleanupDeletedConversation(conversationId, source, options = {}) {
    const [messages, taskSummaries, conversationServerBinding] = await Promise.all([
      this.baseConversations.listAllMessagesIncludingDeleted(conversationId),
      options.taskSummaries ? Promise.resolve(options.taskSummaries) : this.taskStore.scanTasks({ conversationId }),
      this.servers.findConversationBinding(conversationId),
    ]);
    const taskIds = [...new Set([
      ...taskSummaries.map((task) => task.id),
      ...messages.map((message) => message.taskId).filter(Boolean),
    ])];
    const tasks = (await Promise.all(taskIds.map((taskId) => this.taskStore.getTask(taskId).catch(() => null)))).filter(Boolean);
    const bindingKeys = [...new Set(tasks.map((task) => task.agentBindingId).filter(Boolean))];
    const remoteServerIds = [...new Set([
      conversationServerBinding?.serverId,
      ...tasks.map((task) => task.route?.serverId),
    ].filter(Boolean))];
    const serverIdentityById = new Map((remoteServerIds.length ? await this.servers.list() : [])
      .map((entry) => [entry.profile.id, entry.profile.serverIdentity]));
    const remoteServerIdentities = [...new Set([
      ...tasks.map((task) => task.route?.serverIdentity),
      ...remoteServerIds.map((serverId) => serverIdentityById.get(serverId)),
    ].filter(Boolean).map(String))];
    // Persist remote work before removing local bindings.  A disconnected
    // host can then finish later, while completed local work disappears from
    // the queue immediately instead of becoming a permanent history index.
    await Promise.all(remoteServerIdentities.map((serverIdentity) => this.#enqueueConversationDeletionCleanup(
      "remote",
      serverIdentity,
      conversationId,
      String(source?.version || "1"),
    )));
    await this.taskRuntime.waitForKeys([
      ...messages.map((message) => `memory:${message.id}`),
      ...taskIds.map((taskId) => `memory:${taskId}`),
    ]);
    await this.memoryCoordinator.forgetConversation({
      conversationId,
      taskIds,
      sourceIds: [...new Set(messages.map((message) => message.id))],
      reason: "conversation deleted",
      source,
    });
    const localCleanup = [
      this.conversationContext.forget(conversationId),
      this.webAgentObservations.forget(conversationId),
      this.webInteractionStore.forgetConversation(conversationId),
      this.contextHub.forgetConversation({ conversationId, bindingKeys, taskIds }),
      this.taskRuntime.clearBindings(bindingKeys),
    ];
    if (!options.serverBindingCleared) localCleanup.push(this.servers.unbindConversationEverywhere(conversationId));
    await Promise.all(localCleanup);
    if (options.scheduleRemote !== false) {
      await Promise.allSettled(remoteServerIds.map((serverId) => this.scheduleDeletedAgentConversationCleanup(serverId)));
    }
    return { conversationId, removedMessages: messages.length, removedTasks: taskIds.length, remoteServerIds };
  }

  async scheduleConversationDeletionCleanup(conversationId, source = null) {
    const id = String(conversationId || "");
    invariant(id, "CONVERSATION_ID_REQUIRED", "缺少对话 id", { status: 400 });
    const cleanupSource = source || { type: "conversation-delete-resume", id, version: "1" };
    await this.#enqueueConversationDeletionCleanup("local", null, id, String(cleanupSource.version || "1"));
    // A deleted webpage conversation must disappear from the server registry
    // before the delete request completes.  The heavier memory, task and
    // remote-Agent cleanup remains resumable in the durable queue below.
    await this.servers.unbindConversationEverywhere(id);
    const launched = await this.taskRuntime.launch(`conversation-delete:${id}`, async () => {
      const result = await this.#cleanupDeletedConversation(id, cleanupSource, { serverBindingCleared: true });
      await this.#consumeConversationDeletionCleanup("local", null, id, String(cleanupSource.version || "1"));
      return result;
    });
    if (launched.accepted) void launched.promise.catch((error) => {
      console.error(JSON.stringify({
        scope: "conversation-delete-cleanup",
        conversationId: id,
        code: String(error?.code || "CONVERSATION_DELETE_CLEANUP_FAILED"),
        message: String(redactSensitive(String(error?.message || "对话后台清理失败"))).slice(0, 2_000),
      }));
    });
    return { scheduled: launched.accepted, key: launched.key };
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
      projectMemoryMode: async (projectId) => (await this.projects.get(projectId))?.memoryMode || "global",
      // Prepare the local cleanup transaction before the tombstone becomes
      // visible.  The facade launches cleanup after commit; on a crash in that
      // narrow boundary startup can now recover from this durable entry.
      beforeIndexCommit: async ({ operation, conversationId, conversationRevision }) => {
        if (operation !== "conversation.delete") return;
        await this.#enqueueConversationDeletionCleanup(
          "local",
          null,
          conversationId,
          String(conversationRevision || "1"),
        );
      },
    });
    this.workDrafts = new WorkDraftService(common);
    this.embedding = new DynamicEmbeddingAdapter({ platform: this.runtime.platform, fetchImpl: this.runtime.fetchImpl });
    this.memory = new PersistentMemoryService({ ...common, embedder: this.embedding });
    this.memoryCoordinator = new MemoryCoordinator({
      ...common,
      memory: this.memory,
      extractor: async ({ input, providerId, modelId, mode }) => {
        const [prompt, tools] = await Promise.all([
          this.runtime.prompts.memoryExtraction(input),
          this.runtime.prompts.memoryTools(input.availableLevels),
        ]);
        return this.runtime.completeAuxiliary({
          actor: this.actor,
          providerId,
          modelId,
          mode,
          runId: `memory_${crypto.createHash("sha256").update(`${this.actor.actorId}:${prompt.system}:${prompt.input}`).digest("hex").slice(0, 32)}`,
          system: prompt.system,
          input: prompt.input,
          tools,
          response: "tool-calls",
        });
      },
    });
    this.webInteractionStore = new PersistentWebInteractionStore(common);
    this.webAgentObservations = new WebAgentObservationLedger(common);
    this.conversationContext = new ConversationContextSettings({
      ...common,
      conversations: this.baseConversations,
      prompts: this.runtime.prompts,
      runs: this.webInteractionStore,
      summarizer: async ({ providerId, modelId, existingCheckpoint, messages, conversationId }) => {
        const prompt = await this.runtime.prompts.conversationCompact({ existingCheckpoint, messages });
        return this.runtime.completeAuxiliary({
          actor: this.actor,
          providerId,
          modelId,
          mode: "chat",
          runId: `compact_${crypto.createHash("sha256").update(`${conversationId}:${messages.map((entry) => entry.id).join(",")}`).digest("hex").slice(0, 32)}`,
          system: prompt.system,
          input: prompt.input,
          maxOutputTokens: 12_000,
        });
      },
    });
    this.taskStore = new FileTaskStore(common);
    this.taskRuntime = new DetachedTaskRuntime(common);
    this.journal = new RealtimeEventJournal(common);
    this.broker = new RealtimeBroker({ journal: this.journal });
    this.audit = new AuditService({ ...common, cursorSecret: this.runtime.secrets.cursorSecret });
    this.contextHub = new ContextHub({
      ...common,
      sources: {
        // Work transcript deltas are staged explicitly after comparing the
        // target native conversation's receipt ledger. ContextHub must not add
        // an independent conversation tail on top of that deterministic delta.
        conversation: async () => [],
        task: async () => [],
        memory: async () => [],
        ...(this.runtime.contextSourcesFactory ? await this.runtime.contextSourcesFactory({ actor: this.actor, container: this }) : {}),
      },
    });
    this.resources = new ResourceService({
      ...common,
      mutationQueue: this.runtime.queue,
      authorizeOwner: ({ ownerType, ownerId }) => this.authorizeOwner(ownerType, ownerId),
      extractor: new DynamicResourceExtractor({
        platform: this.runtime.platform,
        prompts: this.runtime.prompts,
        fetchImpl: this.runtime.fetchImpl,
        ocrExtractor: this.runtime.ocrExtractor || this.runtime.visionExtractor,
      }),
      embedder: this.embedding,
    });
    this.catalogConsistency = new CatalogConsistencyService({
      ...common,
      projects: this.projects,
      collections: this.collections,
      conversations: this.baseConversations,
      deleteConversation: async (input) => {
        if (this.conversations?.delete) return this.conversations.delete(input);
        const result = await this.baseConversations.delete(input);
        await this.scheduleConversationDeletionCleanup(input.conversationId, {
          type: "conversation-delete",
          id: String(input.commandId || input.conversationId),
          version: String(result.conversation?.revision || 1),
        });
        return result;
      },
      resources: this.resources,
      artifacts: { detachProject: (input) => this.artifacts.detachProject(input) },
      memories: {
        invalidateProject: ({ projectId, commandId }) => this.memory.invalidateScopes({
          scopes: [{ level: "project", id: projectId }],
          reason: "project deleted",
          source: { type: "project-delete", id: commandId, version: "1" },
        }),
      },
      faultInjector: this.runtime.catalogFaultInjector,
    });
    this.skills = new SkillService({
      ...common,
      authorizeTask: async ({ taskId }) => Boolean(await this.taskStore.getTask(taskId)),
      conversationTaskIds: async (conversationId) => (await allMessages(this.conversations, conversationId)).map((message) => message.taskId).filter(Boolean),
    });
    this.skillMarketplace = this.runtime.skillMarketplace;
    await this.skills.cleanupStorage({ dryRun: false });
    await this.runtime.skillDistribution.installForActor(this.actor, this.skills);
    const inspectSkills = this.skills.inspect.bind(this.skills);
    this.skills.inspect = async () => {
      const inspected = await inspectSkills();
      return { data: inspected.data, meta: { revision: inspected.revision } };
    };
    this.servers = this.runtime.registryForActor(this.actor);
    this.sshWorker = this.runtime.sshPool.workerFor(this.actor);
    this.sshRestorePromise = this.sshWorker.restore().catch(() => []);
    await this.#pruneOrphanedServerConversationBindings();
    await this.#migrateConversationDeletionCleanupState();
    await this.#resumeConversationDeletionTransactions();
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
        verifyAvailable: (input) => this.remoteArtifactSourceByIdentity(input.serverIdentity).then((source) => source.verifyAvailable(input)),
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
    const versionAdapter = new OrchestratorVersionAdapter({
      versionFactory: (serverId, identity) => this.versioningFor(serverId, identity),
      workspaceFactory: (serverId, identity) => this.workspaceFor(serverId, identity),
      taskStore: this.taskStore,
      taskReports: this.taskReports,
    });
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
      journal: this.journal,
      workspaceService: workspaceAdapter,
      versionService: versionAdapter,
      artifactService: {
        // ArtifactService.capture returns the canonical
        // `{ artifact, duplicate, storeRevision }` envelope.  The
        // orchestrator needs that envelope in order to attach the public
        // artifact id/detail to the realtime event. Returning only the inner
        // artifact silently discarded every remote download card.
        capture: (input) => this.artifacts.capture(input),
      },
      skillService: this.skills,
      reportService: this.taskReports,
      adapters: this.agentAdapters,
      prompts: this.runtime.prompts,
      submissionRecorder: async ({ task, event, binding }) => {
        const receipts = agentSubmissionReceipts({ event, binding });
        const schedulerActivity = agentSchedulerActivity({ event, binding });
        if (!receipts.length && !schedulerActivity) return;
        const server = await this.servers.get(task.route.serverId);
        if (server.profile.serverIdentity !== task.route.serverIdentity) return;
        if (!receipts.length) {
          await this.notifySchedulerJobs(task.route.serverId, "agent_scheduler_activity", []);
          void this.trackSchedulerSubmissions(task.route.serverId).catch(() => undefined);
          return;
        }
        const ledger = new SchedulerSubmissionLedger({ ...common, serverIdentity: task.route.serverIdentity, username: server.profile.username });
        const created = await ledger.record(receipts, { taskId: task.id, conversationId: task.conversationId, workspaceId: task.route.workspaceId, agentId: task.route.agentId });
        if (created.length || schedulerActivity) {
          await this.notifySchedulerJobs(task.route.serverId, created.length ? "submitted" : "agent_scheduler_activity", created);
          void this.trackSchedulerSubmissions(task.route.serverId, receipts.map((receipt) => receipt.jobId)).catch(() => undefined);
        }
      },
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
    // Restoring every desired SSH connection is host-level background work.
    // Actor HTTP routes (especially the server picker) must not wait for every
    // remote host or its connection timeout before serving local state.
    void this.sshRestorePromise.then((restoredConnections) => Promise.allSettled(restoredConnections
      .filter((entry) => entry.status === "connected")
      .map((entry) => this.scheduleDeletedAgentConversationCleanup(entry.serverId)))).catch(() => undefined);
    await this.orchestrator.recoverPending();
    this.taskWatchdogTimer = setInterval(() => {
      void this.orchestrator.monitorActiveRuns({ quietForMs: 120_000 }).catch(() => undefined);
    }, 120_000);
    this.taskWatchdogTimer.unref?.();
    this.interactions = new WebInteractionService(this, this.webInteractionStore);
    await this.interactions.initialize();
    this.conversations = new ConversationInteractionFacade(this.baseConversations, this.interactions, this.memoryCoordinator, this);
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
          const serverIdentity = await this.artifacts.getSourceServerIdentity({ artifactId });
          const server = serverIdentity ? (await this.servers.list()).find((entry) => entry.profile.serverIdentity === serverIdentity) : null;
          return {
            authorized: true,
            size: version.size,
            name: artifact.name,
            mime: viewerMime(artifact.name, version.mime),
            supportsRange: true,
            metadata: { sourceType: "artifact", revision: artifact.revision, ...(server ? { serverId: server.profile.id, serverName: server.profile.name } : {}) },
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
        return { ...inspected, mime: viewerMime(inspected.name, inspected.mime), metadata: { serverId: server.profile.id, serverName: server.profile.name } };
      },
      openReadStream: async (input) => {
        const source = await this.remoteArtifactSourceByIdentity(input.serverIdentity);
        return source.openReadStream(input);
      },
    };
  }

  async #excludeMemoriesKnownByNativeSession(entries, agentBindingId) {
    if (!agentBindingId || !Array.isArray(entries) || !entries.length) return entries;
    const binding = await this.taskRuntime.loadBinding(agentBindingId);
    const nativeSessionId = binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId || null;
    if (!nativeSessionId) return entries;
    let knownCheckpointIds = new Set();
    try {
      knownCheckpointIds = new Set(await this.contextHub.listBindingCheckpointIds({
        bindingKey: agentBindingId,
        nativeSessionId,
      }));
    } catch {
      // Receipt provenance is a deduplication optimization.  If the ledger is
      // temporarily unavailable, keep candidate memories rather than hiding
      // potentially necessary context from the remote Agent.
    }
    const decisions = await Promise.all(entries.map(async (entry) => {
      const origin = entry?.origin;
      if (origin?.type !== "remote-task" || !origin.id) return true;
      // A native fork receives exactly the receipt checkpoint prefix through
      // its fork boundary.  Checking the copied Task ids is both more precise
      // than comparing session ids and safe for facts created on the parent
      // after the branch point.
      if (knownCheckpointIds.has(String(origin.id))) return false;
      try {
        const task = await this.taskStore.getTask(String(origin.id));
        if (!task || task.agentBindingId !== agentBindingId) return true;
        const report = await this.taskReports.get(task.id, { required: false });
        const sourceSessionIds = new Set((report?.evidence || [])
          .map((evidence) => evidence?.source?.sessionId)
          .filter(Boolean)
          .map(String));
        return !sourceSessionIds.has(String(nativeSessionId));
      } catch {
        // Provenance is an optimization boundary, not permission to starve a
        // new session. If its Task/report cannot be proven, keep the memory.
        return true;
      }
    }));
    return entries.filter((_, index) => decisions[index]);
  }

  async searchContext({ scope, query, sources, limit, roles = [], filterSkillsByServer = true, mode = filterSkillsByServer ? "work" : "chat", excludeMessageId = null, excludeAgentBindingId = null }) {
    const selected = new Set(sources || ["memory", "resources"]);
    const output = {};
    if (selected.has("memory")) {
      const configuration = typeof this.memory.retrievalConfiguration === "function"
        ? await this.memory.retrievalConfiguration()
        : { resultLimit: 8, recallLimit: 48, tokenBudget: 3_200, pageSize: 20 };
      const requestedLimit = Math.min(configuration.resultLimit, Math.min(20, Math.max(1, Number(limit) || configuration.resultLimit)));
      const recallLimit = Math.min(256, Math.max(requestedLimit, configuration.recallLimit));
      const candidates = await this.memory.contextEntries(scope, { query, limit: recallLimit, tokenEstimator: estimateMemoryTokens });
      // The Web Agent already receives the settled history of this webpage
      // conversation.  Re-querying a project/workspace memory extracted from
      // that same conversation only duplicates context and exposes an
      // unnecessary "memory" row in the timeline.  Other conversations still
      // share project memory normally, while the native handoff path below can
      // independently deliver a fact to a genuinely new Agent session.
      const crossConversation = await this.memoryCoordinator.excludeConversationEntries(candidates, scope.conversationId, scope.branchId);
      const sessionEligible = await this.#excludeMemoriesKnownByNativeSession(crossConversation, excludeAgentBindingId);
      const seenContent = new Set();
      const diversified = sessionEligible.filter((entry) => {
        const digest = crypto.createHash("sha256").update(String(entry.content || "").replace(/\r\n/g, "\n").trim()).digest("hex");
        if (seenContent.has(digest)) return false;
        seenContent.add(digest);
        return true;
      });
      const memory = [];
      let usedTokens = 0;
      for (const entry of diversified) {
        const tokens = Number(entry.tokenEstimate || estimateMemoryTokens(entry.content));
        if (memory.length && usedTokens + tokens > configuration.tokenBudget) continue;
        memory.push(entry);
        usedTokens += tokens;
        if (memory.length >= requestedLimit) break;
      }
      output.memory = memory;
    }
    if (selected.has("resources")) {
      try {
        output.resources = (await this.resources.search({ query, scope, limit })).results;
      } catch (error) {
        if (error?.code !== "RESOURCE_SCOPE_EMPTY") throw error;
        output.resources = [];
      }
    }
    if (selected.has("conversation")) {
      const messages = await this.conversationContext.history(scope.conversationId, scope.branchId);
      output.conversation = relevantConversationMessages(messages, { query, roles, limit, excludeMessageId });
    }
    if (selected.has("skills")) {
      const installed = await this.skills.listInstalledKnowledge();
      let eligible = installed.items.filter((skill) => isSkillApplicableToMode({ skill, mode }));
      if (mode === "work" && filterSkillsByServer) {
        const automaticallyApplicable = await this.filterSkillCatalogForServer(scope.serverId, installed.items);
        const applicableIds = new Set(automaticallyApplicable.map((entry) => String(entry.skillId)));
        eligible = eligible.filter((entry) => applicableIds.has(String(entry.skillId)));
      }
      output.skills = eligible.length ? await this.skills.searchContext({
        query,
        limit,
        selectedSkillVersions: scope.selectedSkillVersions,
        selectedSkillIds: eligible.map((entry) => entry.skillId),
      }) : [];
    }
    return output;
  }

  async contextState(scope, routing = {}, requestedFields = ["conversation", "project", "server", "workspace", "agent"], { includeCapabilities = false } = {}) {
    const fields = new Set((Array.isArray(requestedFields) ? requestedFields : []).map(String));
    const routedWorkspacePath = String(routing.workspacePath || "").trim();
    const routedWorkspaceId = String(routing.workspaceId || scope.workspaceId || "").trim();
    const usableRoutedWorkspacePath = routedWorkspacePath
      && routedWorkspacePath !== routedWorkspaceId
      && !/^ws_[a-z0-9]+$/iu.test(routedWorkspacePath)
      ? routedWorkspacePath
      : "";
    const routedScheduler = String(routing.scheduler || "").trim().toLowerCase();
    const cachedServerCapabilities = includeCapabilities && fields.has("server") && scope.serverId
      ? await this.serverCapabilities.peek(scope.serverId).catch(() => null)
      : null;
    const hasVerifiedRoutedScheduler = ["slurm", "pbs", "generic", "none"].includes(routedScheduler)
      && cachedServerCapabilities?.features?.scheduler?.type === routedScheduler;
    const deferWorkspaceState = Boolean(routing.deferWorkspaceState);
    const [conversation, project, server, workspace, serverCapabilities] = await Promise.all([
      fields.has("conversation") ? this.baseConversations.getConversation(scope.conversationId) : null,
      fields.has("project") && scope.projectId ? this.projects.get(scope.projectId) : null,
      fields.has("server") && scope.serverId ? this.servers.get(scope.serverId) : null,
      fields.has("workspace") && usableRoutedWorkspacePath
        ? Promise.resolve({ canonicalPath: usableRoutedWorkspacePath })
        : fields.has("workspace") && !deferWorkspaceState && scope.serverId && scope.serverIdentity && scope.workspaceId
        ? this.workspaceFor(scope.serverId, scope.serverIdentity).then((service) => service.getWorkspace(scope.workspaceId)).catch(() => null)
        : null,
      includeCapabilities && fields.has("server") && hasVerifiedRoutedScheduler
        ? Promise.resolve(cachedServerCapabilities)
        : includeCapabilities && fields.has("server") && scope.serverId
        ? this.serverCapabilities.get(scope.serverId).catch(() => null)
        : null,
    ]);
    const agentId = String(routing.agentId || "");
    const agentLabel = String(routing.agentLabel || "").normalize("NFKC").trim();
    const agent = fields.has("agent") && (agentId || agentLabel)
      ? { name: Array.from(agentLabel || ({ opencode: "OpenCode", codex: "Codex", "claude-code": "Claude Code" })[agentId] || agentId).slice(0, 120).join("") }
      : null;
    return { conversation, project, server, workspace, agent, serverCapabilities };
  }

  async filterSkillCatalogForServer(serverId, skills) {
    const items = Array.isArray(skills) ? skills : [];
    if (!serverId) return items;
    const server = await this.servers.get(String(serverId));
    const capabilities = await this.serverCapabilities.peek(String(serverId)).catch(() => null)
      || await this.serverCapabilities.get(String(serverId)).catch(() => null);
    const scheduler = String(capabilities?.features?.scheduler?.type || "unknown");
    const descriptor = {
      id: server.profile.id,
      serverId: server.profile.id,
      serverIdentity: server.profile.serverIdentity,
      name: server.profile.name,
      host: server.profile.host,
    };
    return items.filter((skill) => isAutomaticSkillApplicable({
      skill,
      server: descriptor,
      scheduler,
    }));
  }

  async #remoteBundle(serverId, serverIdentity) {
    invariant(this.runtime.remoteBackendFactory, "REMOTE_CAPABILITY_UNAVAILABLE", "当前 Gateway 未配置远端文件与工作区 backend", { status: 503, retryable: true });
    const key = `${serverId}:${serverIdentity}`;
    if (this.remoteBundles.has(key)) return this.remoteBundles.get(key);
    if (this.remoteBundlePending.has(key)) return this.remoteBundlePending.get(key);
    const server = await this.servers.get(serverId);
    invariant(server.profile.serverIdentity === serverIdentity, "SERVER_IDENTITY_MISMATCH", "服务器身份与当前 SSH 配置不一致", { status: 409 });
    const pending = (async () => {
      const backend = await this.runtime.remoteBackendFactory({ actor: this.actor, serverId, serverIdentity, server, sshWorker: this.sshWorker, container: this });
      invariant(backend?.remoteControl && backend?.remoteFs, "REMOTE_BACKEND_INVALID", "远端 backend 契约不完整", { status: 500, expose: false });
      const versioning = new VersioningService({ remoteFs: backend.remoteFs, clock: this.clock });
      const workspaces = new WorkspaceService({
        actor: this.actor,
        dataRoot: this.runtime.dataRoot,
        remoteControl: backend.remoteControl,
        versioning,
        authorizeConversation: async (conversationId) => Boolean(await this.baseConversations.getConversation(conversationId)),
        queue: this.runtime.queue,
        clock: this.clock,
      });
      const bundle = { backend, versioning, workspaces };
      this.remoteBundles.set(key, bundle);
      return bundle;
    })().finally(() => this.remoteBundlePending.delete(key));
    this.remoteBundlePending.set(key, pending);
    return pending;
  }

  async workspaceFor(serverId, serverIdentity) {
    return (await this.#remoteBundle(serverId, serverIdentity)).workspaces;
  }

  async versioningFor(serverId, serverIdentity) {
    return (await this.#remoteBundle(serverId, serverIdentity)).versioning;
  }

  async activateWorkspaceVersion(serverId, input = {}) {
    exactObject(input, ["workspaceId", "conversationId", "branchId", "activationId"], "ActivateWorkspaceVersion");
    const server = await this.servers.get(String(serverId || ""));
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    const workspaceId = String(input.workspaceId || "");
    const conversationId = String(input.conversationId || "");
    const branchId = String(input.branchId || "");
    invariant(workspaceId && conversationId && branchId, "VERSION_SCOPE_REQUIRED", "版本切换需要工作区、对话和分支", { status: 400 });
    const workspaces = await this.workspaceFor(server.profile.id, server.profile.serverIdentity);
    const workspace = await workspaces.getWorkspace(workspaceId);
    invariant(workspace.serverIdentity === server.profile.serverIdentity && workspace.actorId === this.actor.actorId, "VERSION_WORKSPACE_FORBIDDEN", "工作区不属于当前用户或服务器", { status: 403 });
    const bindings = await workspaces.listBindings({ conversationId, branchId });
    const binding = bindings
      .filter((entry) => entry.workspaceId === workspaceId && entry.versionDomainId)
      .sort((left, right) => right.contextEpoch - left.contextEpoch || right.updatedAt.localeCompare(left.updatedAt))[0] || null;
    if (!binding) return { activated: false, reason: "unversioned", headCheckpointId: null, paths: 0 };
    const versioning = await this.versioningFor(server.profile.id, server.profile.serverIdentity);
    let state;
    try {
      state = await versioning.getDomain({ actorId: this.actor.actorId, serverIdentity: server.profile.serverIdentity, versionDomainId: binding.versionDomainId });
    } catch (error) {
      if (error?.code !== "VERSION_DOMAIN_NOT_FOUND") throw error;
      return { activated: false, reason: "unmaterialized", headCheckpointId: null, paths: 0 };
    }
    invariant(state.conversationId === conversationId, "VERSION_CONVERSATION_MISMATCH", "版本账本不属于当前对话", { status: 409 });
    const headCheckpointId = state.branches[branchId]?.headCheckpointId || null;
    if (!headCheckpointId) return { activated: false, reason: "empty-head", headCheckpointId: null, paths: 0 };
    const activeStatuses = ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"];
    const activeTasks = await this.taskStore.listTasks({ statuses: activeStatuses, limit: 1000 });
    const conflicting = activeTasks.find((task) => task.route?.workspaceId === workspaceId
      && (task.route?.serverIdentity === server.profile.serverIdentity || task.route?.serverId === server.profile.id));
    invariant(!conflicting, "WORKSPACE_TASK_ACTIVE", "当前工作区有任务正在执行，结束或中断后才能切换对话文件版本", {
      status: 409,
      details: conflicting ? { taskId: conflicting.id, conversationId: conflicting.conversationId } : undefined,
    });
    const activation = await versioning.activateCheckpoint({
      actorId: this.actor.actorId,
      serverIdentity: server.profile.serverIdentity,
      versionDomainId: binding.versionDomainId,
    }, {
      checkpointId: headCheckpointId,
      activationId: String(input.activationId || `activate_${conversationId}_${branchId}`),
    });
    invariant(activation.applied, activation.conflict?.code || "VERSION_ACTIVATION_FAILED", activation.conflict?.message || "无法切换到当前对话的文件版本", {
      status: 409,
      details: activation.conflict || undefined,
    });
    return {
      activated: true,
      reason: null,
      headCheckpointId,
      paths: activation.paths || 0,
      reusedMaterialization: activation.reusedMaterialization === true,
    };
  }

  async workspaceVersionStatus(serverId, input = {}) {
    exactObject(input, ["workspaceId", "conversationId", "branchId"], "WorkspaceVersionStatus");
    const server = await this.servers.get(String(serverId || ""));
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    const workspaceId = String(input.workspaceId || "");
    const conversationId = String(input.conversationId || "");
    const branchId = String(input.branchId || "");
    invariant(workspaceId && conversationId && branchId, "VERSION_SCOPE_REQUIRED", "版本历史需要工作区、对话和分支", { status: 400 });
    const workspaces = await this.workspaceFor(server.profile.id, server.profile.serverIdentity);
    const workspace = await workspaces.getWorkspace(workspaceId);
    invariant(workspace.serverIdentity === server.profile.serverIdentity && workspace.actorId === this.actor.actorId, "VERSION_WORKSPACE_FORBIDDEN", "工作区不属于当前用户或服务器", { status: 403 });
    const bindings = await workspaces.listBindings({ conversationId, branchId });
    const binding = bindings
      .filter((entry) => entry.workspaceId === workspaceId && entry.versionDomainId)
      .sort((left, right) => right.contextEpoch - left.contextEpoch || right.updatedAt.localeCompare(left.updatedAt))[0] || null;
    if (!binding) return {
      workspace: { id: workspace.id, canonicalPath: workspace.canonicalPath, kind: workspace.kind },
      versioned: false,
      headCheckpointId: null,
      checkpoints: [],
      pendingCount: 0,
      counts: { added: 0, modified: 0, deleted: 0 },
    };
    const versioning = await this.versioningFor(server.profile.id, server.profile.serverIdentity);
    let state;
    try {
      state = await versioning.getDomain({ actorId: this.actor.actorId, serverIdentity: server.profile.serverIdentity, versionDomainId: binding.versionDomainId });
    } catch (error) {
      // Older workspace bindings may already carry the deterministic domain id
      // even though no Agent file write ever materialized its lazy ledger.  That
      // is a normal empty-history state, not a broken version service.
      if (error?.code !== "VERSION_DOMAIN_NOT_FOUND") throw error;
      return {
        workspace: { id: workspace.id, canonicalPath: workspace.canonicalPath, kind: workspace.kind },
        versioned: false,
        headCheckpointId: null,
        checkpoints: [],
        pendingCount: 0,
        counts: { added: 0, modified: 0, deleted: 0 },
      };
    }
    invariant(state.conversationId === conversationId, "VERSION_CONVERSATION_MISMATCH", "版本账本不属于当前对话", { status: 409 });
    const checkpoints = state.checkpoints
      .filter((checkpoint) => checkpoint.logicalBranchId === branchId)
      .sort((left, right) => right.sequence - left.sequence)
      .map((checkpoint) => ({
        ...checkpoint,
        changes: checkpoint.changes
          .filter((change) => change.workspaceId === null || change.workspaceId === workspaceId)
          .map((change) => ({
            ...change,
            path: change.path === workspace.canonicalPath
              ? "."
              : change.path.startsWith(`${workspace.canonicalPath}/`)
                ? change.path.slice(workspace.canonicalPath.length + 1)
                : change.path,
          })),
      }));
    const effectiveChanges = checkpoints.filter((checkpoint) => checkpoint.status === "retained" && checkpoint.boundary === "after").flatMap((checkpoint) => checkpoint.changes);
    return {
      workspace: { id: workspace.id, canonicalPath: workspace.canonicalPath, kind: workspace.kind },
      versioned: true,
      versionDomainId: binding.versionDomainId,
      revision: state.revision,
      headCheckpointId: state.branches[branchId]?.headCheckpointId || null,
      checkpoints,
      pendingCount: Object.values(state.pending).filter((entry) => entry.branchId === branchId && entry.workspaceId === workspaceId).length,
      counts: {
        added: effectiveChanges.filter((change) => !change.before.exists && change.after.exists).length,
        modified: effectiveChanges.filter((change) => change.before.exists && change.after.exists).length,
        deleted: effectiveChanges.filter((change) => change.before.exists && !change.after.exists).length,
      },
    };
  }

  async rewindWorkspaceVersion(serverId, input = {}) {
    exactObject(input, ["workspaceId", "conversationId", "branchId", "targetCheckpointId", "rewindId"], "RewindWorkspaceVersion");
    const active = await this.taskStore.listTasks({
      conversationId: String(input.conversationId || ""),
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1,
    });
    invariant(!active.length, "CONVERSATION_TASK_ACTIVE", "当前任务结束或中断后才能回退文件版本", { status: 409 });
    const server = await this.servers.get(String(serverId || ""));
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    const workspaces = await this.workspaceFor(server.profile.id, server.profile.serverIdentity);
    const workspace = await workspaces.getWorkspace(String(input.workspaceId || ""));
    invariant(workspace.serverIdentity === server.profile.serverIdentity && workspace.actorId === this.actor.actorId, "VERSION_WORKSPACE_FORBIDDEN", "工作区不属于当前用户或服务器", { status: 403 });
    const activeInWorkspace = await this.taskStore.listTasks({
      statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"],
      limit: 1000,
    });
    const conflicting = activeInWorkspace.find((task) => task.route?.workspaceId === workspace.id
      && (task.route?.serverIdentity === server.profile.serverIdentity || task.route?.serverId === server.profile.id));
    invariant(!conflicting, "WORKSPACE_TASK_ACTIVE", "当前工作区有任务正在执行，结束或中断后才能恢复文件版本", {
      status: 409,
      details: conflicting ? { taskId: conflicting.id, conversationId: conflicting.conversationId } : undefined,
    });
    const bindings = await workspaces.listBindings({ conversationId: input.conversationId, branchId: input.branchId });
    const binding = bindings
      .filter((entry) => entry.workspaceId === input.workspaceId && entry.versionDomainId)
      .sort((left, right) => right.contextEpoch - left.contextEpoch || right.updatedAt.localeCompare(left.updatedAt))[0];
    invariant(binding, "VERSION_CONTROL_WORKSPACE_UNVERSIONED", "当前工作区没有可回退的版本历史", { status: 409 });
    const versioning = await this.versioningFor(server.profile.id, server.profile.serverIdentity);
    return versioning.rewind({ actorId: this.actor.actorId, serverIdentity: server.profile.serverIdentity, versionDomainId: binding.versionDomainId }, {
      branchId: input.branchId,
      targetCheckpointId: input.targetCheckpointId,
      rewindId: input.rewindId,
    });
  }

  async schedulerFor(serverId) {
    const server = await this.servers.get(serverId);
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    const bundle = await this.#remoteBundle(serverId, server.profile.serverIdentity);
    invariant(bundle.backend.schedulerExecutor, "SCHEDULER_EXECUTOR_UNAVAILABLE", "远端 backend 未提供 Scheduler executor", { status: 503 });
    const key = `${serverId}:${server.profile.serverIdentity}:${server.profile.username}`;
    if (this.schedulers.has(key)) return this.schedulers.get(key);
    const scheduler = new SchedulerService({
      actor: this.actor,
      dataRoot: this.runtime.dataRoot,
      serverIdentity: server.profile.serverIdentity,
      username: server.profile.username,
      adapter: new SlurmSchedulerAdapter(),
      executor: bundle.backend.schedulerExecutor,
      authorizeServer: async () => true,
      queue: this.runtime.queue,
      clock: this.clock,
      onSubmitted: async (jobIds) => {
        await this.notifySchedulerJobs(serverId, "submitted", jobIds);
        await this.trackSchedulerSubmissions(serverId, jobIds);
      },
      onCancelled: async (jobIds) => {
        await this.notifySchedulerJobs(serverId, "cancelled", jobIds);
        await this.trackSchedulerSubmissions(serverId, jobIds);
      },
    });
    this.schedulers.set(key, scheduler);
    return scheduler;
  }

  async submitSchedulerJob(serverId, input = {}) {
    exactObject(input, ["workspaceId", "conversationId", "branchId", "partition", "scriptPath", "args", "commandId"], "提交作业");
    const conversationId = String(input.conversationId || "");
    const branchId = String(input.branchId || "");
    const workspaceId = String(input.workspaceId || "");
    invariant(conversationId && branchId && workspaceId, "SCHEDULER_WORKSPACE_REQUIRED", "提交作业需要当前对话工作区", { status: 400 });
    const server = await this.servers.get(String(serverId || ""));
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    const workspaces = await this.workspaceFor(server.profile.id, server.profile.serverIdentity);
    const [workspace, bindings] = await Promise.all([
      workspaces.getWorkspace(workspaceId),
      workspaces.listBindings({ conversationId, branchId }),
    ]);
    invariant(workspace.actorId === this.actor.actorId && workspace.serverIdentity === server.profile.serverIdentity, "SCHEDULER_WORKSPACE_FORBIDDEN", "工作区不属于当前用户或服务器", { status: 403 });
    invariant(bindings.some((binding) => binding.workspaceId === workspaceId), "SCHEDULER_WORKSPACE_NOT_BOUND", "当前对话没有绑定该工作区", { status: 403 });
    return (await this.schedulerFor(server.profile.id)).submit({
      commandId: input.commandId,
      partition: input.partition,
      scriptPath: input.scriptPath,
      args: input.args,
      cwd: workspace.canonicalPath,
    });
  }

  async notifySchedulerJobs(serverId, reason, jobIds) {
    for (const [key, scheduler] of this.schedulers) {
      if (key.startsWith(`${serverId}:`)) scheduler.invalidateJobs(jobIds);
    }
    await this.broker.append(`scheduler:${serverId}`, {
      producer: "scheduler", kind: "jobs.changed", status: "updated",
      ids: { serverId }, payload: { reason, jobIds },
    }).catch((error) => console.error(JSON.stringify({ scope: "scheduler-notify", code: error?.code || "SCHEDULER_NOTIFY_FAILED" })));
  }

  async trackSchedulerSubmissions(serverId, jobIds = null) {
    const server = await this.servers.get(serverId);
    if (server.connection.status !== "connected" || !server.profile.serverIdentity) return;
    const key = `${serverId}:${server.profile.serverIdentity}:${server.profile.username}`;
    const scheduler = await this.schedulerFor(serverId);
    let tracker = this.submissionTrackers.get(key);
    if (!tracker) {
      tracker = new SchedulerSubmissionTracker({
        ledger: scheduler.submissions,
        onChanged: (jobIds) => this.notifySchedulerJobs(serverId, "state_changed", jobIds),
        inspectJob: (jobId) => scheduler.inspectSubmittedJob(jobId),
        canPoll: async () => {
          const current = await this.servers.get(serverId);
          return current.connection.status === "connected"
            && current.profile.serverIdentity === server.profile.serverIdentity
            && current.profile.username === server.profile.username;
        },
      });
      this.submissionTrackers.set(key, tracker);
    }
    await tracker.resume(jobIds);
  }

  async remoteBackend(serverId) {
    const server = await this.servers.get(serverId);
    invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
    return (await this.#remoteBundle(serverId, server.profile.serverIdentity)).backend;
  }

  async systemMonitorFor(serverId) {
    const backend = await this.remoteBackend(serverId);
    invariant(backend.systemMonitor?.snapshot, "SYSTEM_MONITOR_UNAVAILABLE", "远端 backend 未提供系统监控能力", { status: 503 });
    return backend.systemMonitor;
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
    exactObject(input, ["bindingId", "configScope", "workspacePath", "source", "providerId", "modelId"], `Agent ${operation}`);
    const bindingId = String(input.bindingId || "");
    const configScope = String(input.configScope || "");
    invariant(bindingId, "AGENT_BINDING_REQUIRED", "Agent 上下文操作需要 bindingId", { status: 400 });
    invariant(configScope, "AGENT_CONFIG_SCOPE_REQUIRED", "Agent 上下文操作需要当前对话配置范围", { status: 400 });
    const adapter = this.agentAdapters[String(agentId)];
    invariant(adapter, "AGENT_ADAPTER_NOT_FOUND", "Agent adapter 不存在", { status: 404 });
    const binding = await this.taskRuntime.loadBinding(bindingId);
    invariant(binding, "AGENT_BINDING_NOT_FOUND", "Agent 对话尚未建立上下文 binding", { status: 404 });
    invariant(binding.adapterId === adapter.id, "AGENT_BINDING_ADAPTER_MISMATCH", "Agent binding 与当前 Agent 不一致", { status: 409 });
    const bindingRoute = binding.route;
    invariant(bindingRoute && typeof bindingRoute === "object" && !Array.isArray(bindingRoute), "AGENT_BINDING_ROUTE_MISSING", "Agent binding 缺少当前协议要求的 route", { status: 409 });
    invariant(bindingRoute.serverId === String(serverId) && bindingRoute.agentId === adapter.id, "AGENT_BINDING_ROUTE_MISMATCH", "Agent binding route 与当前服务器或 Agent 不一致", { status: 409 });
    const operationInput = {
      sessionId: binding.native?.sessionId || binding.state?.sessionId || undefined,
      threadId: binding.native?.threadId || binding.state?.sessionId || undefined,
      turnId: binding.native?.turnId || binding.state?.turnId || undefined,
      processId: binding.native?.processId || undefined,
      providerId: input.providerId || bindingRoute?.providerId,
      modelId: input.modelId || bindingRoute?.modelId,
      cwd: input.workspacePath,
    };
    const descriptor = adapter.operation(operation, operationInput);
    const run = await this.agentTransport.execute({
      task: { conversationId: configScope, route: {
        serverId: String(serverId),
        agentId: adapter.id,
        ...(operationInput.providerId ? { providerId: String(operationInput.providerId) } : {}),
        ...(operationInput.modelId ? { modelId: String(operationInput.modelId) } : {}),
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
      route: bindingRoute,
      state: patch.state ? { ...state, ...patch.state } : state,
      native: { ...(binding.native || {}), ...(patch.native || {}) },
      activeRunId: run.runId || binding.activeRunId,
    };
    await this.taskRuntime.saveBinding(bindingId, next);
    return {
      operation,
      capability: adapter.capabilities[operation],
      contextUsage: next.state?.contextUsage || null,
      contextUsageReason: run.contextUsageReason || null,
      bindingId,
      runId: run.runId || null,
    };
  }

  async #deletedAgentCleanupPlan(serverIdentity) {
    const cleanupState = (await this.conversationDeletionCleanup.read()).data;
    const pending = Object.entries(cleanupState.remote[serverIdentity] || {})
      .map(([id, revision]) => ({ id, revision }));
    const conversationIds = pending.map((conversation) => conversation.id);
    const conversationSet = new Set(conversationIds);
    const taskSummaries = conversationIds.length ? await this.taskStore.scanTasks() : [];
    const bindings = taskSummaries.filter((task) => conversationSet.has(task.conversationId)).flatMap((task) => (
      task?.agentBindingId
        && task?.route?.serverIdentity === serverIdentity
        && task?.route?.agentId
        ? [{
            bindingId: task.agentBindingId,
            agentId: task.route.agentId,
            conversationId: task.conversationId,
          }]
        : []
    ));
    return {
      conversationIds,
      bindings,
      pending,
    };
  }

  async reconcileDeletedAgentConversations(serverId) {
    const server = await this.servers.get(serverId);
    invariant(server.connection.status === "connected", "SSH_NOT_CONNECTED", "SSH 尚未连接", { status: 409 });
    const serverIdentity = server.profile.serverIdentity;
    invariant(serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "服务器尚未确认身份", { status: 409 });
    if (!(await this.#hasPendingRemoteConversationCleanup(serverIdentity))) {
      return { serverId, serverIdentity, scannedBindings: 0, matchedBindings: 0, reconciledRuntimes: 0, removedBindingRecords: 0, reconciledConfigurations: 0, reconciledVersionDomains: 0, deferredVersionDomains: 0, removedWorkspaces: 0 };
    }
    const [backend, workspaces] = await Promise.all([
      this.remoteBackend(serverId),
      this.workspaceFor(serverId, serverIdentity),
    ]);
    const plan = await this.#deletedAgentCleanupPlan(serverIdentity);
    if (!plan.conversationIds.length) return { serverId, serverIdentity, scannedBindings: 0, matchedBindings: 0, reconciledRuntimes: 0, removedBindingRecords: 0, reconciledConfigurations: 0, reconciledVersionDomains: 0, deferredVersionDomains: 0, removedWorkspaces: 0 };
    const collector = new RemoteAgentConversationGarbageCollector({
      executor: backend.executor,
      transport: backend.agentTransport,
      actor: this.actor,
      serverIdentity,
    });
    let reconciled = null;
    await workspaces.forgetConversations({
      conversationIds: plan.conversationIds,
      serverIdentity,
    }, {
      beforeCommit: async (workspaceCleanup) => {
        reconciled = await collector.reconcile({
          ...plan,
          removedWorkspaces: workspaceCleanup.removedWorkspaces,
          retainedWorkspaces: workspaceCleanup.retainedInheritedWorkspaces,
          protectedWorkspaceIds: workspaceCleanup.protectedWorkspaceIds,
        });
      },
    });
    invariant(reconciled, "AGENT_GC_RESULT_MISSING", "远端 Agent 对话清理没有返回结果", { status: 500, expose: false });
    for (const conversation of plan.pending) {
      await this.#consumeConversationDeletionCleanup("remote", serverIdentity, conversation.id, String(conversation.revision));
    }
    (await this.versioningFor(serverId, serverIdentity)).invalidateRemoteState();
    return { serverId, serverIdentity, ...reconciled };
  }

  async scheduleDeletedAgentConversationCleanup(serverId) {
    const server = await this.servers.get(serverId);
    if (server.connection.status !== "connected" || !server.profile.serverIdentity) return { scheduled: false, reason: "ssh-not-connected" };
    if (!(await this.#hasPendingRemoteConversationCleanup(server.profile.serverIdentity))) {
      return { scheduled: false, reason: "no-pending-cleanup" };
    }
    const key = `agent-gc:${server.profile.serverIdentity}`;
    this.deletedAgentCleanupRequests.add(key);
    const launched = await this.taskRuntime.launch(key, async () => {
      let result = null;
      // A deletion can arrive while reconciliation for the same server is
      // already scanning an older tombstone set. Consume the dirty flag until
      // no request arrived during the preceding pass, so that deletion never
      // has to wait for a later SSH reconnect to be observed.
      while (this.deletedAgentCleanupRequests.delete(key)) {
        result = await this.reconcileDeletedAgentConversations(serverId);
      }
      return result;
    });
    // There is a small boundary between the worker's final dirty-flag check
    // and DetachedTaskRuntime removing the finished job. If a deletion lands
    // in that boundary, launch() joins the old promise; schedule a fresh pass
    // once it settles instead of dropping the new request.
    void launched.promise.finally(async () => {
      if (this.deletedAgentCleanupRequests.has(key)) {
        await this.scheduleDeletedAgentConversationCleanup(serverId);
      }
    }).catch(() => undefined);
    if (launched.accepted) {
      void launched.promise.catch((error) => {
        console.error(JSON.stringify({
          scope: "agent-conversation-gc",
          serverIdentity: server.profile.serverIdentity,
          code: String(error?.code || "AGENT_GC_FAILED"),
          message: String(redactSensitive(String(error?.message || "远端 Agent 对话清理失败"))).slice(0, 2_000),
          details: error?.details
            ? String(redactSensitive(JSON.stringify(error.details))).slice(0, 8_000)
            : null,
        }));
      });
    }
    return { scheduled: launched.accepted, key, promise: launched.promise };
  }

  async connectSsh(serverId, options = {}) {
    const connection = await this.sshWorker.connect(serverId, options);
    await this.scheduleDeletedAgentConversationCleanup(serverId);
    // Classify once per connection generation and persist Scheduler detection.
    // The request itself must stay fast; the shared capability cache is warmed
    // in the background for every conversation bound to this server.
    void this.serverCapabilities.get(serverId, { refresh: true }).catch(() => undefined);
    void this.trackSchedulerSubmissions(serverId).catch(() => undefined);
    return connection;
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

  async bootstrap(session, { conversationId } = {}) {
    const conversationOverviewPromise = typeof this.baseConversations.bootstrapOverview === "function"
      ? this.baseConversations.bootstrapOverview({ limit: 8, projectId: null, ...(conversationId ? { activeConversationId: conversationId } : {}) })
      : Promise.all([
          this.baseConversations.listConversations({ limit: 8, projectId: null }),
          allConversations(this.baseConversations),
        ]).then(([page, conversations]) => ({
          ...page,
          projectConversationCounts: conversations.reduce((counts, conversation) => {
            if (conversation.projectId) counts[conversation.projectId] = (counts[conversation.projectId] || 0) + 1;
            return counts;
          }, {}),
        }));
    const [conversationPage, projectItems, serverItems, providerItems, runningTasks, resources] = await Promise.all([
      conversationOverviewPromise,
      this.projects.list(),
      this.servers.list(),
      this.runtime.providers.listAvailableProviders(this.actor, "web"),
      this.taskStore.listTasks({ statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "recovering", "finalizing"], limit: 1000 }),
      this.resources.inspect(),
    ]);
    const taskByConversation = new Map(runningTasks.map((task) => [task.conversationId, task.id]));
    const projectConversationCounts = new Map(Object.entries(conversationPage.projectConversationCounts || {}));
    const projectResourceCounts = new Map();
    for (const binding of resources.data.bindings) {
      if (binding.ownerType === "project" && binding.invalidatedSequence === null) projectResourceCounts.set(binding.ownerId, (projectResourceCounts.get(binding.ownerId) || 0) + 1);
    }
    const username = session.profile?.username || "访客";
    const summarizeConversation = (conversation) => ({
      id: conversation.id, title: conversation.title, mode: conversation.mode,
      projectId: conversation.projectId, pinned: conversation.pinned,
      lastMessageAt: conversation.lastMessageAt, runningTaskId: taskByConversation.get(conversation.id) || null,
      revision: conversation.revision, updatedAt: conversation.updatedAt,
    });
    const navigation = conversationPage.conversationNavigation;
    return {
      ...(navigation ? { conversationNavigation: {
        conversationId: navigation.conversationId,
        conversation: navigation.conversation ? summarizeConversation(navigation.conversation) : null,
        projectConversations: navigation.projectConversations ? {
          ...navigation.projectConversations,
          items: navigation.projectConversations.items.map(summarizeConversation),
        } : null,
      } } : {}),
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
      recentConversations: conversationPage.items.map(summarizeConversation),
      conversationCursor: conversationPage.nextCursor || null,
      servers: serverItems.map(({ profile, connection, conversationIds, activeConversationIds = conversationIds }) => ({
        id: profile.id,
        name: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        serverIdentity: profile.serverIdentity || null,
        status: connection.status === "connected" || connection.status === "connecting" ? connection.status : "disconnected",
        connectionGeneration: Number(connection.generation || 0),
        activeConversationCount: activeConversationIds.length,
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

  hasOpenTerminalSessions() {
    return [...this.remoteBundles.values()].some((entry) => entry?.backend?.terminal?.hasOpenSessions?.());
  }

  async close() {
    if (this.taskWatchdogTimer) clearInterval(this.taskWatchdogTimer);
    this.taskWatchdogTimer = null;
    await Promise.all([...this.submissionTrackers.values()].map((tracker) => tracker.close()));
    this.submissionTrackers.clear();
    await this.waitForIdle();
    await this.previews.closeAll().catch(() => undefined);
    for (const entry of this.remoteBundles.values()) {
      if (typeof entry?.backend?.close === "function") await Promise.resolve(entry.backend.close()).catch(() => undefined);
    }
    for (const entry of this.agentDeployments.values()) if (typeof entry?.close === "function") await Promise.resolve(entry.close()).catch(() => undefined);
    this.remoteBundles.clear();
    this.remoteBundlePending.clear();
    this.agentDeployments.clear();
  }
}
