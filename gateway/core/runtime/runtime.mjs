import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthDeviceService } from "../auth/service.mjs";
import { createActorContext } from "../actor.mjs";
import { AuditService } from "../audit/service.mjs";
import { createOpaqueCursorCodec } from "../cursor.mjs";
import { ConversationService } from "../conversations/index.mjs";
import { HostAgentArtifactCatalog } from "../agent-runtime/index.mjs";
import { invariant } from "../errors.mjs";
import { canTransitionTask, transitionTask } from "../entities/task.mjs";
import { createApi } from "../http/api.mjs";
import { commandId, expectedRevision } from "../http/router.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import {
  OpenAICompatibleModelDetector,
  PlatformConfigurationService,
  ProviderService,
  ProviderUsageService,
} from "../platform/service.mjs";
import { PLATFORM_PROVIDER_IDS } from "../platform/contract.mjs";
import { MemoryPreviewSessionStore } from "../previews/index.mjs";
import { PromptRepository } from "../prompts/index.mjs";
import { taskTopic } from "../orchestrator/contract.mjs";
import { FileTaskStore } from "../orchestrator/persistence.mjs";
import { RealtimeSocketServer } from "../realtime-socket.mjs";
import { SshCredentialVault, SshServerRegistry, Ssh2TransportFactory, SshWorkerPool } from "../ssh/index.mjs";
import { SkillMarketplaceService } from "../skills/index.mjs";
import { SkillDistributionService } from "../skills/distribution.mjs";
import { OpenAIChatModel } from "../web-agent/openai-model.mjs";
import { DynamicSshPolicy } from "./adapters.mjs";
import { loadOrCreateRuntimeSecrets } from "./secrets.mjs";
import { ActorServiceContainer } from "./services.mjs";
import { createDefaultRemoteBackend, RoutingAgentTransport } from "./remote.mjs";

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(runtimeDirectory, "../../..");
const actorKey = (actor) => `${actor.actorType}:${actor.actorId}`;
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const REMOTE_FILE_DOWNLOAD_TTL_MS = 2 * 60_000;
const ARTIFACT_DOWNLOAD_TTL_MS = 5 * 60_000;

export function composeResourceList(snapshot, query = {}) {
  invariant(snapshot?.data && Array.isArray(snapshot.data.bindings) && Array.isArray(snapshot.data.versions) && Array.isArray(snapshot.data.blobs), "RESOURCE_STORE_INVALID", "资源索引结构无效", { status: 500, expose: false });
  const bindings = snapshot.data.bindings.filter((entry) => (!query.ownerType || entry.ownerType === query.ownerType) && (!query.ownerId || entry.ownerId === query.ownerId));
  const byVersion = new Map(snapshot.data.versions.map((entry) => [entry.id, entry]));
  const byBlob = new Map(snapshot.data.blobs.map((entry) => [entry.id, entry]));
  return bindings.map((binding) => {
    const version = byVersion.get(binding.resourceVersionId);
    invariant(version, "RESOURCE_VERSION_MISSING", "资源绑定引用了不存在的版本", { status: 500, expose: false });
    const blob = byBlob.get(version.blobId);
    invariant(blob, "RESOURCE_BLOB_MISSING", "资源版本引用了不存在的 Blob", { status: 500, expose: false });
    return {
      binding: clone(binding),
      version: clone(version),
      blob: clone(blob),
      size: blob.size,
    };
  });
}

function requiredObject(value, operation) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "REQUEST_BODY_REQUIRED", `${operation} 请求体不能为空`, { status: 400 });
  return value;
}

function strictBody(value, allowed, operation) {
  const body = requiredObject(value, operation);
  invariant(Object.keys(body).every((key) => allowed.includes(key)), "REQUEST_BODY_SCHEMA_INVALID", `${operation} 请求体不符合 EasyWork 协议`, {
    status: 400,
    details: { allowed },
  });
  return body;
}

function strictQuery(query, allowed, operation) {
  invariant(Object.keys(query || {}).every((key) => allowed.includes(key)), "QUERY_SCHEMA_INVALID", `${operation} 查询参数不符合 EasyWork 协议`, {
    status: 400,
    details: { allowed },
  });
  return query || {};
}

function parseCsv(value) {
  if (!value) return undefined;
  return [...new Set(String(value).split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function parseRangeHeader(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  invariant(match && (match[1] || match[2]), "ARTIFACT_RANGE_INVALID", "Range 请求无效", { status: 416, details: { size } });
  let start;
  let endExclusive;
  if (!match[1]) {
    const suffix = Number(match[2]);
    invariant(Number.isSafeInteger(suffix) && suffix > 0, "ARTIFACT_RANGE_INVALID", "Range 请求无效", { status: 416, details: { size } });
    start = Math.max(0, size - suffix);
    endExclusive = size;
  } else {
    start = Number(match[1]);
    endExclusive = match[2] ? Number(match[2]) + 1 : size;
  }
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(endExclusive) && start >= 0 && start < size && endExclusive > start && endExclusive <= size, "ARTIFACT_RANGE_INVALID", "Range 请求超出 Artifact 大小", {
    status: 416,
    details: { size },
  });
  return { start, endExclusive };
}

function parsePreviewRangeHeader(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  invariant(match && (match[1] || match[2]), "PREVIEW_RANGE_INVALID", "Range 请求无效", { status: 416, details: { size } });
  invariant(size > 0, "PREVIEW_RANGE_INVALID", "空文件不接受 Range", { status: 416, details: { size } });
  let start;
  let endExclusive;
  if (!match[1]) {
    const suffix = Number(match[2]);
    invariant(Number.isSafeInteger(suffix) && suffix > 0, "PREVIEW_RANGE_INVALID", "Range 请求无效", { status: 416, details: { size } });
    start = Math.max(0, size - suffix);
    endExclusive = size;
  } else {
    start = Number(match[1]);
    endExclusive = match[2] ? Number(match[2]) + 1 : size;
  }
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(endExclusive) && start >= 0 && start < size && endExclusive > start && endExclusive <= size, "PREVIEW_RANGE_INVALID", "Range 请求超出 Preview 大小", {
    status: 416,
    details: { size },
  });
  return { start, endExclusive };
}

export class EasyWorkRuntime {
  static async create(options = {}) {
    const dataRoot = path.resolve(String(options.dataRoot || ""));
    invariant(path.isAbsolute(dataRoot) && path.basename(dataRoot).toLowerCase() === "data", "RUNTIME_DATA_ROOT_INVALID", "Gateway dataRoot 必须指向 data 目录", { status: 500, expose: false });
    await fs.mkdir(dataRoot, { recursive: true });
    const secrets = await loadOrCreateRuntimeSecrets(dataRoot, options.secrets || {});
    const runtime = new EasyWorkRuntime({ ...options, dataRoot, secrets });
    await runtime.#initialize();
    return runtime;
  }

  constructor(options) {
    this.dataRoot = options.dataRoot;
    this.secrets = options.secrets;
    this.remoteFileDownloadCodec = createOpaqueCursorCodec({
      secret: this.secrets.artifactSecret,
      namespace: "remote-file-download",
      defaultTtlMs: REMOTE_FILE_DOWNLOAD_TTL_MS,
    });
    this.artifactDownloadTicketCodec = createOpaqueCursorCodec({
      secret: this.secrets.artifactSecret,
      namespace: "artifact-download-ticket",
      defaultTtlMs: ARTIFACT_DOWNLOAD_TTL_MS,
    });
    this.clock = options.clock || (() => new Date());
    this.queue = options.queue || defaultActorMutationQueue;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.allowedOrigins = Object.freeze([...(options.allowedOrigins || [])].map(String));
    this.contextSourcesFactory = options.contextSourcesFactory || null;
    this.visionExtractor = options.visionExtractor || null;
    this.ocrExtractor = options.ocrExtractor || null;
    this.remoteBackendFactory = options.remoteBackendFactory || null;
    this.agentTransportFactory = options.agentTransportFactory || null;
    this.agentDeploymentFactory = options.agentDeploymentFactory || null;
    this.agentCatalog = options.agentCatalog || null;
    this.agentAppRoot = path.resolve(options.agentAppRoot || path.join(defaultRepositoryRoot, "agent-app"));
    this.apiProxyFactory = options.apiProxyFactory || null;
    this.sshTransportFactory = options.sshTransportFactory || null;
    this.webModelFactory = options.webModelFactory || null;
    this.previewHostSourceFactory = options.previewHostSourceFactory || null;
    this.previewRemoteSourceFactory = options.previewRemoteSourceFactory || null;
    this.previewLimits = Object.freeze({ ...(options.previewLimits || {}) });
    this.remoteFileLimits = Object.freeze({ ...(options.remoteFileLimits || {}) });
    this.previewStore = options.previewStore || new MemoryPreviewSessionStore();
    this.containerIdleTtlMs = Number(options.containerIdleTtlMs ?? 15 * 60_000);
    this.containerMaintenanceMs = Number(options.containerMaintenanceMs ?? 60_000);
    this.guestTtlMs = Number(options.guestTtlMs ?? 30 * 24 * 60 * 60_000);
    this.guestMaintenanceMs = Number(options.guestMaintenanceMs ?? 6 * 60 * 60_000);
    invariant(Number.isSafeInteger(this.guestTtlMs) && this.guestTtlMs > 0 && Number.isSafeInteger(this.guestMaintenanceMs) && this.guestMaintenanceMs > 0, "GUEST_MAINTENANCE_INVALID", "访客清理周期无效", { status: 500, expose: false });
    this.promptRoot = path.resolve(options.promptRoot || path.join(defaultRepositoryRoot, "prompts"));
    this.authOptions = Object.freeze({ ...(options.authOptions || {}) });
    this.helpFile = path.resolve(options.helpFile || path.join(defaultRepositoryRoot, "help", "help.md"));
    this.containers = new Map();
    this.registries = new Map();
    this.closing = false;
  }

  async #initialize() {
    this.auth = new AuthDeviceService({ ...this.authOptions, dataRoot: this.dataRoot, sessionSecret: this.secrets.sessionSecret, clock: this.clock });
    this.prompts = new PromptRepository({ promptRoot: this.promptRoot });
    this.skillMarketplace = new SkillMarketplaceService({ dataRoot: this.dataRoot, clock: this.clock, queue: this.queue, prompts: this.prompts, onDeployment: (id) => this.skillDistribution.reconcile(id) });
    this.skillDistribution = new SkillDistributionService({ dataRoot: this.dataRoot, clock: this.clock, marketplace: this.skillMarketplace, auth: this.auth });
    await this.skillMarketplace.ensureBuiltins();
    await this.skillMarketplace.cleanupStorage({ dryRun: false });
    await this.skillDistribution.reconcile();
    this.platform = new PlatformConfigurationService({ dataRoot: this.dataRoot, masterSecret: this.secrets.masterSecret, clock: this.clock, queue: this.queue });
    this.providers = new ProviderService({
      dataRoot: this.dataRoot,
      masterSecret: this.secrets.masterSecret,
      platform: this.platform,
      detector: new OpenAICompatibleModelDetector({ fetchImpl: this.fetchImpl }),
      clock: this.clock,
      queue: this.queue,
    });
    this.providerUsage = new ProviderUsageService({ dataRoot: this.dataRoot, providerService: this.providers, clock: this.clock, queue: this.queue });
    this.agentCatalog ||= new HostAgentArtifactCatalog({ root: this.agentAppRoot });
    this.remoteBackendFactory ||= (input) => createDefaultRemoteBackend({
      ...input,
      catalog: this.agentCatalog,
      apiProxyFactory: this.apiProxyFactory,
    });
    this.agentTransportFactory ||= async ({ container }) => new RoutingAgentTransport(
      async (serverId) => (await container.remoteBackend(serverId)).agentTransport,
      async ({ providerId, modelId }) => {
        const agentProviderId = providerId === PLATFORM_PROVIDER_IDS.web ? PLATFORM_PROVIDER_IDS.agent : providerId;
        const access = await this.providers.resolve(container.actor, {
          providerId: agentProviderId,
          purpose: "agent",
          modelId,
          requireModel: true,
        });
        return Object.freeze({
          providerId: access.provider.id,
          model: access.model,
          baseUrl: access.credential.baseUrl,
          apiKey: access.credential.apiKey,
          protocol: access.credential.protocol,
        });
      },
    );
    this.agentDeploymentFactory ||= async ({ container, serverId }) => (
      await container.remoteBackend(serverId)
    ).agentDeployment;
    this.sshPolicy = new DynamicSshPolicy({ platform: this.platform });
    const sshRuntime = await this.platform.sshRuntimeConfiguration();
    this.sshPool = new SshWorkerPool({
      registryFactory: (actor) => this.registryForActor(actor),
      transportFactory: this.sshTransportFactory || new Ssh2TransportFactory({ readyTimeoutMs: sshRuntime.transport.connectTimeoutMs }),
      clock: () => this.clock().getTime(),
      ...sshRuntime.workerPool,
      ...sshRuntime.limits,
      limitsProvider: async () => (await this.platform.sshRuntimeConfiguration()).limits,
    });
    this.sshPool.start();
    this.containerTimer = setInterval(() => this.releaseIdleContainers().catch(() => undefined), this.containerMaintenanceMs);
    this.containerTimer.unref?.();
    this.guestTimer = setInterval(() => this.cleanupInactiveGuests().catch(() => undefined), this.guestMaintenanceMs);
    this.guestTimer.unref?.();
    this.actorRecoveryPromise = this.#recoverActorsAfterRestart().catch(() => []);
  }

  async #recoverActorsAfterRestart() {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    const candidates = [];
    for (const [directory, actorType] of [["users", "user"], ["guests", "guest"]]) {
      const root = path.join(this.dataRoot, directory);
      let actorIds = [];
      try { actorIds = await fs.readdir(root); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      for (const actorId of actorIds.sort()) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(actorId)) continue;
        let hasPendingTask = false;
        let pendingTaskIds = [];
        let hasRunningWebInteraction = false;
        try {
          const envelope = JSON.parse(await fs.readFile(path.join(root, actorId, "tasks", "index.json"), "utf8"));
          pendingTaskIds = Object.values(envelope?.data?.tasks || {})
            .filter((task) => task?.id && task?.status && !terminal.has(task.status))
            .map((task) => String(task.id));
          hasPendingTask = pendingTaskIds.length > 0;
        } catch (error) {
          if (error?.code !== "ENOENT") continue;
        }
        try {
          const envelope = JSON.parse(await fs.readFile(path.join(root, actorId, "runtime", "web-interactions", "state.json"), "utf8"));
          hasRunningWebInteraction = Object.values(envelope?.data?.runs || {}).some((run) => run?.status === "running");
        } catch (error) {
          if (error?.code !== "ENOENT" && !hasPendingTask) continue;
        }
        if (!hasPendingTask && !hasRunningWebInteraction) continue;
        candidates.push({
          actor: createActorContext({
            actorType,
            actorId,
            ...(actorType === "user" ? { userId: actorId } : {}),
            deviceId: "gateway-recovery",
            sessionId: "gateway-recovery",
            roles: [],
          }),
          pendingTaskIds,
        });
      }
    }
    return Promise.all(candidates.map(async ({ actor, pendingTaskIds }) => {
      try {
        await this.servicesForActor(actor);
        return { actorId: actor.actorId, status: "fulfilled" };
      } catch (error) {
        await this.#settleUnrecoverableActorTasks(actor, pendingTaskIds).catch(() => undefined);
        return { actorId: actor.actorId, status: "rejected", code: String(error?.code || "ACTOR_RECOVERY_FAILED") };
      }
    }));
  }

  async #settleUnrecoverableActorTasks(actor, pendingTaskIds) {
    const taskStore = new FileTaskStore({ dataRoot: this.dataRoot, actor, queue: this.queue, clock: this.clock });
    const now = this.clock().toISOString();
    for (const taskId of pendingTaskIds) {
      let task = await taskStore.getTask(taskId);
      if (task && canTransitionTask(task.status, "failed")) {
        const next = transitionTask(task, "failed", {
          expectedRevision: task.revision,
          activeCommandId: task.activeCommandId,
          failure: {
            code: "TASK_RECOVERY_RUNTIME_UNAVAILABLE",
            message: "Gateway 重启后无法初始化该用户的恢复运行时，Task 已安全收口",
            retryable: false,
          },
          clock: this.clock,
        });
        await taskStore.saveTask(next, { expectedRevision: task.revision });
        task = next;
      }
      for (const command of await taskStore.listCommands(taskId)) {
        if (!["accepted", "running"].includes(command.status)) continue;
        await taskStore.updateCommand(taskId, command.commandId, {
          status: "failed",
          failure: {
            code: "TASK_COMMAND_GATEWAY_RESTARTED",
            message: `Gateway 重启前的 ${command.type} command 未能返回确定结果，Task 当前状态为 ${task?.status || "unknown"}`,
            retryable: false,
          },
          updatedAt: now,
        });
      }
    }
  }

  registryForActor(actor) {
    const key = actorKey(actor);
    if (!this.registries.has(key)) {
      const vault = new SshCredentialVault({ dataRoot: this.dataRoot, actor, masterSecret: this.secrets.masterSecret, queue: this.queue });
      this.registries.set(key, new SshServerRegistry({
        dataRoot: this.dataRoot,
        actor,
        vault,
        queue: this.queue,
        clock: this.clock,
        networkPolicy: this.sshPolicy,
      }));
    }
    return this.registries.get(key);
  }

  async servicesForActor(actor) {
    invariant(!this.closing, "RUNTIME_CLOSING", "Gateway 正在关闭", { status: 503, retryable: true });
    const key = actorKey(actor);
    let entry = this.containers.get(key);
    if (!entry) {
      const promise = ActorServiceContainer.create(this, actor);
      entry = { promise, lastAccess: Date.now() };
      this.containers.set(key, entry);
      promise.catch(() => {
        if (this.containers.get(key) === entry) this.containers.delete(key);
      });
    }
    entry.lastAccess = Date.now();
    return entry.promise;
  }

  async releaseActor(actor, { force = false } = {}) {
    const key = actorKey(actor);
    const entry = this.containers.get(key);
    if (!entry) return false;
    const container = await entry.promise.catch(() => null);
    if (!force && (container?.interactions?.runs?.size || container?.hasOpenTerminalSessions?.())) return false;
    this.containers.delete(key);
    await container?.close?.();
    return true;
  }

  async releaseIdleContainers() {
    const threshold = Date.now() - this.containerIdleTtlMs;
    const entries = [...this.containers.entries()];
    await Promise.all(entries.map(async ([, entry]) => {
      const container = await entry.promise.catch(() => null);
      await container?.previews?.expireDue?.().catch(() => undefined);
    }));
    await Promise.all(entries
      .filter(([, entry]) => entry.lastAccess < threshold)
      .map(async ([key, entry]) => {
        const container = await entry.promise.catch(() => null);
        if (!container || container.interactions.runs.size || container.hasOpenTerminalSessions?.() || (await container.taskStore.listTasks({ statuses: ["queued", "preparing", "delivering_context", "running", "interrupting", "recovering", "finalizing"], limit: 1 })).length) return;
        if (this.containers.get(key) === entry) this.containers.delete(key);
        await container.close();
      }));
    await this.cleanupPendingGuests();
  }

  async createWebModel({ actor, providerId, modelId, mode, runId }) {
    if (this.webModelFactory) return this.webModelFactory({ actor, providerId, modelId, mode, runId, runtime: this });
    const access = await this.providers.resolve(actor, { providerId, purpose: "web", modelId, requireModel: true });
    const contextLayout = await this.prompts.contextLayout();
    const underlying = new OpenAIChatModel({
      baseUrl: access.credential.baseUrl,
      apiKey: access.credential.apiKey,
      model: access.model,
      protocol: access.credential.protocol,
      fetchImpl: this.fetchImpl,
      systemMessageSeparator: contextLayout.systemMessageSeparator,
    });
    let completionIndex = 0;
    return {
      complete: async (input) => {
        const usageRunId = `${runId}:${completionIndex++}`;
        const startedAt = Date.now();
        try {
          const result = await underlying.complete(input);
          await this.#recordModelUsage(actor, providerId, usageRunId, result.usage, Date.now() - startedAt, false).catch(() => undefined);
          return result;
        } catch (error) {
          await this.#recordModelUsage(actor, providerId, usageRunId, null, Date.now() - startedAt, true).catch(() => undefined);
          throw error;
        }
      },
    };
  }

  async completeAuxiliary({ actor, providerId, modelId, mode = "chat", runId, system, input, tools = [], toolChoice = "auto", response = "text", maxOutputTokens = 8_192 }) {
    invariant(typeof system === "string", "AUXILIARY_MODEL_SYSTEM_TEXT_REQUIRED", "辅助模型的系统提示必须是文本", { status: 500, expose: false });
    invariant(typeof input === "string", "AUXILIARY_MODEL_INPUT_TEXT_REQUIRED", "辅助模型的输入必须是文本", { status: 500, expose: false });
    invariant(Array.isArray(tools), "AUXILIARY_MODEL_TOOLS_INVALID", "辅助模型工具必须是数组", { status: 500, expose: false });
    invariant(["text", "tool-calls"].includes(response), "AUXILIARY_MODEL_RESPONSE_INVALID", "辅助模型返回类型无效", { status: 500, expose: false });
    const model = await this.createWebModel({ actor, providerId, modelId, mode, runId });
    const result = await model.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      tools,
      toolChoice,
      limits: { maxInputTokens: 160_000, maxOutputTokens },
      signal: undefined,
      onDelta: undefined,
    });
    return response === "tool-calls"
      ? structuredClone(Array.isArray(result?.toolCalls) ? result.toolCalls : [])
      : String(result?.content || "");
  }

  async #recordModelUsage(actor, providerId, runId, usage, latencyMs, failed) {
    const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
    const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
    await this.providerUsage.record(actor, {
      providerId,
      purpose: "web",
      metrics: {
        requests: 1,
        inputTokens: Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : 0,
        outputTokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0,
        embeddingTokens: 0,
        errors: failed ? 1 : 0,
        latencyMs: Math.max(0, Math.round(latencyMs)),
      },
      commandId: `usage_${crypto.createHash("sha256").update(runId).digest("hex").slice(0, 32)}`,
    });
  }

  createApi() {
    return createApi({
      auth: this.auth,
      servicesForActor: (actor) => this.servicesForActor(actor),
      allowedOrigins: this.allowedOrigins,
      bootstrap: (request) => request.services.bootstrap(request.session, { conversationId: request.query.conversationId }),
      logout: (request) => this.logoutSession(request),
      auditSession: async ({ action, result, request }) => {
        if (action === "auth.registered") await this.skillDistribution.installForActor(result.actor);
        // Authentication must never wait for the Actor service container. That
        // Actor service initialization may reconcile persisted SSH state and
        // detached tasks, and a slow remote server must not block login.
        const audit = new AuditService({
          dataRoot: this.dataRoot,
          actor: result.actor,
          cursorSecret: this.secrets.cursorSecret,
          queue: this.queue,
          clock: this.clock,
        });
        await audit.append({
          action,
          status: "success",
          target: { actorType: result.actor.actorType, actorId: result.actor.actorId },
          requestId: request.requestId,
          metadata: { deviceId: result.actor.deviceId },
        });
      },
      extend: (router) => this.#extendApi(router),
    });
  }

  async logoutSession(request) {
    const actor = request.session.actor;
    const result = await this.auth.logout(request.token);
    if (actor.actorType !== "guest") return { ...result, guestCleanup: "not-applicable" };
    const cleanup = await this.#deleteGuestWhenIdle(actor);
    if (!cleanup.deleted) await this.auth.markGuestCleanupPending(actor.actorId);
    return { ...result, guestCleanup: cleanup.deleted ? "deleted" : "deferred" };
  }

  async #guestHasProtectedState(actor, { preserveAnySshTask = false } = {}) {
    if (this.sshPool.snapshot().some((entry) => entry.actorType === "guest" && entry.actorId === actor.actorId)) return true;
    if (!this.sshPool.canReleaseActor(actor)) return true;
    const entry = this.containers.get(actorKey(actor));
    if (entry) {
      const container = await entry.promise.catch(() => null);
      if (!container) return true;
      if (container.interactions.runs.size || container.taskRuntime.activeKeys().length) return true;
      let active;
      try {
        active = await container.taskStore.listTasks(preserveAnySshTask
          ? { limit: 1 }
          : {
            statuses: ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "interrupted", "recovering", "finalizing"],
            limit: 1,
          });
      } catch {
        return true;
      }
      if (active.length) return true;
    } else {
      const tasksPath = path.join(this.dataRoot, "guests", actor.actorId, "tasks", "index.json");
      try {
        const envelope = JSON.parse(await fs.readFile(tasksPath, "utf8"));
        if (preserveAnySshTask && Object.keys(envelope?.data?.tasks || {}).length > 0) return true;
        const activeStatuses = new Set(["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting", "interrupted", "recovering", "finalizing"]);
        if (Object.values(envelope?.data?.tasks || {}).some((task) => activeStatuses.has(task?.status))) return true;
      } catch (error) {
        if (error?.code !== "ENOENT") return true;
      }
    }
    const serversPath = path.join(this.dataRoot, "guests", actor.actorId, "state", "servers.json");
    try {
      const envelope = JSON.parse(await fs.readFile(serversPath, "utf8"));
      if (preserveAnySshTask && Object.keys(envelope?.data?.profiles || {}).length > 0) return true;
      if (Object.values(envelope?.data?.connections || {}).some((connection) => connection?.desiredConnection || ["connected", "connecting"].includes(connection?.status))) return true;
    } catch (error) {
      if (error?.code !== "ENOENT") return true;
    }
    return false;
  }

  async #deleteGuestWhenIdle(actor, inactiveBefore = null) {
    if (await this.#guestHasProtectedState(actor, { preserveAnySshTask: Boolean(inactiveBefore) })) return { deleted: false, reason: "protected-runtime" };
    await this.releaseActor(actor, { force: true });
    if (!await this.sshPool.releaseActor(actor)) return { deleted: false, reason: "ssh-active" };
    this.registries.delete(actorKey(actor));
    try {
      return await this.auth.deleteGuestActor(actor.actorId, inactiveBefore ? { inactiveBefore } : {});
    } catch (error) {
      if (["GUEST_SESSION_ACTIVE", "GUEST_RECENTLY_ACTIVE"].includes(error?.code)) return { deleted: false, reason: error.code };
      throw error;
    }
  }

  async cleanupInactiveGuests() {
    const inactiveBefore = new Date(this.clock().getTime() - this.guestTtlMs);
    const candidates = await this.auth.listInactiveGuests({ inactiveBefore });
    const results = [];
    for (const candidate of candidates) {
      const actor = createActorContext({
        actorType: "guest",
        actorId: candidate.actorId,
        deviceId: "maintenance",
        sessionId: "maintenance",
        roles: [],
      });
      results.push({ actorId: candidate.actorId, ...(await this.#deleteGuestWhenIdle(actor, inactiveBefore)) });
    }
    return results;
  }

  async cleanupPendingGuests() {
    const candidates = await this.auth.listPendingGuestCleanup();
    const results = [];
    for (const candidate of candidates) {
      const actor = createActorContext({ actorType: "guest", actorId: candidate.actorId, deviceId: "maintenance", sessionId: "maintenance", roles: [] });
      results.push({ actorId: candidate.actorId, ...(await this.#deleteGuestWhenIdle(actor)) });
    }
    return results;
  }

  createRealtimeServer() {
    return new RealtimeSocketServer({
      auth: this.auth,
      brokerForActor: async (actor) => (await this.servicesForActor(actor)).broker,
      authorizeTopic: async ({ actor, topic }) => {
        const services = await this.servicesForActor(actor);
        if (topic === `conversations:${actor.actorId}`) return topic;
        if (topic.startsWith("conversation:")) {
          await services.baseConversations.getConversation(topic.slice("conversation:".length));
          return topic;
        }
        if (topic.startsWith("task:")) {
          const taskId = topic.slice("task:".length);
          const tasks = await services.taskStore.listTasks({ limit: 1000 });
          const visible = tasks.some((task) => task.id === taskId);
          invariant(visible, "REALTIME_TOPIC_FORBIDDEN", "无权订阅该 Task", { status: 403 });
          return taskTopic(taskId);
        }
        if (topic.startsWith("terminal:")) {
          const visible = [...services.remoteBundles.values()].some((entry) => entry.backend?.terminal?.ownsTopic?.(topic));
          invariant(visible, "REALTIME_TOPIC_FORBIDDEN", "无权订阅该终端会话", { status: 403 });
          return topic;
        }
        if (topic.startsWith("scheduler:")) {
          await services.servers.get(topic.slice("scheduler:".length));
          return topic;
        }
        invariant(false, "REALTIME_TOPIC_FORBIDDEN", "无权订阅该 topic", { status: 403 });
      },
    });
  }

  #extendApi(router) {
    router.route("GET", "/api/admin/users", (request) => this.adminUsers(request.session.actor, strictQuery(request.query, ["query", "page", "limit"], "管理员用户列表")), { admin: true });
    router.route("GET", "/api/admin/users/:actorId", (request) => this.adminUserDetails(request.session.actor, request.params.actorId, strictQuery(request.query, ["conversationCursor", "conversationLimit"], "管理员用户详情")), { admin: true });
    router.route("DELETE", "/api/admin/users/:actorId", (request) => this.adminDeleteUser(request.session.actor, {
      actorId: request.params.actorId,
      commandId: commandId(request),
    }), { admin: true });
    router.route("GET", "/api/admin/ssh-connections", (request) => this.adminSshConnections(request.session.actor), { admin: true });
    router.route("POST", "/api/admin/ssh-connections/:actorId/:serverId/disconnect", (request) => this.adminDisconnectSsh(request.session.actor, {
      actorId: request.params.actorId,
      serverId: request.params.serverId,
      commandId: commandId(request),
    }), { admin: true });

    router.route("POST", "/api/conversations/:id/respond", (request) => request.services.interactions.respond({
      ...requiredObject(request.body, "对话响应"),
      conversationId: request.params.id,
      commandId: commandId(request),
    }));
    router.route("POST", "/api/conversations/:id/startup-failure", (request) => {
      const body = strictBody(request.body, ["messageId", "failure"], "记录工作启动失败");
      return request.services.interactions.recordStartupFailure({
        conversationId: request.params.id,
        messageId: body.messageId,
        failure: body.failure,
        commandId: commandId(request),
      });
    });
    router.route("POST", "/api/conversations/:id/interrupt", (request) => request.services.interactions.interruptConversation(request.params.id, { commandId: commandId(request) }));
    router.route("GET", "/api/conversations/:id/runs/:runId", async (request) => {
      await request.services.conversations.getConversation(request.params.id);
      return request.services.interactions.status(request.params.runId);
    });
    router.route("GET", "/api/conversations/:id/events", async (request) => {
      await request.services.conversations.assertReadable(request.params.id);
      return request.services.interactions.events(request.params.id, {
        afterSequence: request.query.after ? Number(request.query.after) : 0,
        limit: request.query.limit ? Number(request.query.limit) : 2_000,
        view: request.query.view,
      });
    });
    router.route("POST", "/api/conversations/:id/events/details", async (request) => {
      await request.services.conversations.assertReadable(request.params.id);
      return request.services.broker.details(`conversation:${request.params.id}`, strictBody(request.body, ["eventIds"], "读取事件详情").eventIds);
    });
    router.route("GET", "/api/conversations/:id/events/details", async (request) => {
      await request.services.conversations.assertReadable(request.params.id);
      strictQuery(request.query, ["ids"], "读取事件详情");
      return request.services.broker.details(`conversation:${request.params.id}`, String(request.query.ids || "").split(","));
    });
    router.route("GET", "/api/conversations/:id/context", (request) => request.services.conversationContext.get(request.params.id));
    router.route("PATCH", "/api/conversations/:id/context", (request) => request.services.conversationContext.update(request.params.id, {
      ...requiredObject(request.body, "网页对话上下文配置"),
      expectedRevision: expectedRevision(request),
    }));
    router.route("POST", "/api/conversations/:id/context/compact", (request) => request.services.conversationContext.compact(request.params.id));

    router.route("GET", "/api/providers/manage", (request) => request.services.providers.inspectUserProviders(request.session.actor));
    router.route("GET", "/api/skills/deployments", async (request) => {
      const servers = await request.services.servers.list();
      const connected = servers.filter((entry) => entry.connection.status === "connected" && entry.profile.serverIdentity);
      const inspected = await Promise.all(connected.map(async (entry) => {
        const backend = await request.services.remoteBackend(entry.profile.id);
        invariant(typeof backend.skillDeployment?.inspect === "function", "REMOTE_SKILL_DEPLOYMENT_UNAVAILABLE", "远端 backend 未提供 Skill 部署状态", { status: 503 });
        return backend.skillDeployment.inspect();
      }));
      const names = new Map(connected.map((entry) => [entry.profile.id, entry.profile.name || entry.profile.host]));
      return { items: inspected.flatMap((entry) => entry.items.map((item) => ({
        ...item,
        serverId: entry.serverId,
        serverName: names.get(entry.serverId) || entry.serverId,
        serverIdentity: entry.serverIdentity,
        status: item.status === "failed" ? "failed" : "ready",
      }))) };
    });
    router.route("GET", "/api/resources", async (request) => {
      const query = strictQuery(request.query, ["ownerType", "ownerId", "cursor", "limit"], "资源列表");
      const inspected = await request.services.resources.inspect();
      const items = composeResourceList(inspected, query);
      return { items, revision: inspected.revision, nextCursor: null };
    });

    router.route("GET", "/api/artifacts", (request) => {
      const query = strictQuery(request.query, ["cursor", "limit", "taskId", "conversationId", "workspaceId", "lifecycle"], "Artifact 列表");
      return request.services.artifacts.list({
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.lifecycle ? { lifecycle: query.lifecycle } : {}),
      });
    });
    router.route("GET", "/api/artifacts/:id", (request) => request.services.artifacts.get({ artifactId: request.params.id }));
    router.route("POST", "/api/artifacts/:id/download", (request) => this.issueArtifactDownload({
      actor: request.session.actor,
      artifactId: request.params.id,
      ttlMs: request.body?.ttlMs,
    }));
    router.route("POST", "/api/previews", (request) => request.services.createPreview(requiredObject(request.body, "创建 Preview")));
    router.route("GET", "/api/previews/:id", (request) => request.services.previews.get({ previewId: request.params.id }));
    router.route("HEAD", "/api/previews/:id", (request) => request.services.previews.head({ previewId: request.params.id }));
    router.route("PATCH", "/api/previews/:id", (request) => request.services.previews.renew({
      previewId: request.params.id,
      expectedRevision: expectedRevision(request),
      ttlMs: requiredObject(request.body, "续期 Preview").ttlMs,
    }));
    router.route("DELETE", "/api/previews/:id", (request) => request.services.previews.close({
      previewId: request.params.id,
      expectedRevision: expectedRevision(request),
    }));

    router.route("GET", "/api/help", () => this.helpDocument(), { auth: false });

    router.route("GET", "/api/servers/:id/capabilities", async (request) => ({ data: await request.services.serverCapabilities.get(request.params.id) }));
    router.route("POST", "/api/servers/:id/capabilities/refresh", async (request) => ({ data: await request.services.serverCapabilities.get(request.params.id, { refresh: true }) }));
    router.route("GET", "/api/servers/:id/system/monitor", async (request) => (await request.services.systemMonitorFor(request.params.id)).snapshot({ refresh: request.query.refresh === "1" }));

    router.route("GET", "/api/servers/:id/workspaces", async (request) => {
      const server = await request.services.servers.get(request.params.id);
      invariant(server.profile.serverIdentity, "SSH_SERVER_IDENTITY_REQUIRED", "请先确认主机指纹并连接服务器", { status: 409 });
      return (await request.services.workspaceFor(request.params.id, server.profile.serverIdentity)).list({ serverIdentity: server.profile.serverIdentity });
    });
    router.route("POST", "/api/servers/:id/workspaces/virtual", async (request) => {
      const server = await request.services.servers.get(request.params.id);
      return (await request.services.workspaceFor(request.params.id, server.profile.serverIdentity)).createVirtual({
        ...requiredObject(request.body, "创建虚拟工作区"), serverIdentity: server.profile.serverIdentity, commandId: commandId(request),
      });
    });
    router.route("POST", "/api/servers/:id/workspaces/user", async (request) => {
      const server = await request.services.servers.get(request.params.id);
      return (await request.services.workspaceFor(request.params.id, server.profile.serverIdentity)).registerUserWorkspace({
        ...requiredObject(request.body, "注册工作区"), serverIdentity: server.profile.serverIdentity, commandId: commandId(request),
      });
    });
    router.route("GET", "/api/servers/:id/workspace-bindings", async (request) => {
      if (request.query.conversationId) invariant(await request.services.servers.isConversationConnectionEnabled(request.query.conversationId), "CONVERSATION_SERVER_CONNECTION_DISABLED", "此对话已断开远程服务器", { status: 409 });
      const server = await request.services.servers.get(request.params.id);
      return (await request.services.workspaceFor(request.params.id, server.profile.serverIdentity)).listBindings({
        conversationId: request.query.conversationId,
        branchId: request.query.branchId || undefined,
      });
    });
    router.route("POST", "/api/servers/:id/workspace-bindings", async (request) => {
      const body = requiredObject(request.body, "绑定工作区");
      await request.services.baseConversations.getConversation(body.conversationId);
      const existingBinding = await request.services.servers.findConversationBinding(body.conversationId);
      invariant(!existingBinding.serverId || await request.services.servers.isConversationConnectionEnabled(body.conversationId), "CONVERSATION_SERVER_CONNECTION_DISABLED", "此对话已断开远程服务器", { status: 409 });
      await request.services.servers.bindConversation(request.params.id, body.conversationId);
      const server = await request.services.servers.get(request.params.id);
      return (await request.services.workspaceFor(request.params.id, server.profile.serverIdentity)).ensureAgentBinding({
        ...body, commandId: commandId(request),
      });
    });
    router.route("GET", "/api/servers/:id/workspace-route", async (request) => {
      invariant(await request.services.servers.isConversationConnectionEnabled(request.query.conversationId), "CONVERSATION_SERVER_CONNECTION_DISABLED", "此对话已断开远程服务器", { status: 409 });
      const server = await request.services.servers.get(request.params.id);
      return (await request.services.workspaceFor(request.params.id, server.profile.serverIdentity)).getRoute({
        conversationId: request.query.conversationId,
        branchId: request.query.branchId || undefined,
      });
    });
    router.route("POST", "/api/servers/:id/workspace-switch/describe", async (request) => (await request.services.workspaceFor(request.params.id, (await request.services.servers.get(request.params.id)).profile.serverIdentity)).describeSwitch(requiredObject(request.body, "描述工作区切换")));
    router.route("POST", "/api/servers/:id/workspace-switch", async (request) => (await request.services.workspaceFor(request.params.id, (await request.services.servers.get(request.params.id)).profile.serverIdentity)).switchBinding({ ...requiredObject(request.body, "切换工作区"), commandId: commandId(request) }));

    router.route("GET", "/api/servers/:id/agents", async (request) => {
      const deployment = await request.services.agentDeploymentFor(request.params.id);
      const backend = await request.services.remoteBackend(request.params.id);
      const agentIds = parseCsv(request.query.agentIds) || ["opencode", "codex", "claude-code", "qoder-cn"];
      const configScope = request.query.configScope || "default";
      invariant(request.query.cached == null || request.query.cached === "1", "AGENT_CONFIG_CACHE_INVALID", "Agent 配置缓存参数无效", { status: 400 });
      return { items: await Promise.all(agentIds.map(async (agentId) => {
        const status = await deployment.status(agentId);
        const adapter = request.services.agentAdapters[String(agentId)] || null;
        let authentication = null;
        if (agentId === "qoder-cn" && status.installed) {
          try { authentication = await deployment.authenticationStatus(agentId); }
          catch (error) {
            authentication = {
              required: true,
              authenticated: false,
              status: "error",
              loginAvailable: status.status === "ready",
              message: String(error?.message || "Qoder CN 登录状态读取失败"),
            };
          }
        }
        let configuration = null;
        if (status.installed && typeof backend.agentConfiguration?.inspect === "function") {
          try {
            if (request.query.cached === "1" && typeof backend.agentConfiguration?.snapshot === "function") {
              configuration = backend.agentConfiguration.snapshot(agentId, { configScope });
            }
            if (!configuration) {
              configuration = await backend.agentConfiguration.inspect(agentId, { source: status.source, configScope });
            }
          } catch {
            // Agent discovery must remain usable when one isolated config is
            // unreadable; opening that Agent's config reports the typed error.
          }
        }
        const model = String(configuration?.values?.model || "").trim() || null;
        const publicConfiguration = configuration ? {
          agentId: configuration.agentId,
          source: configuration.source,
          managed: configuration.managed,
          writable: configuration.writable,
          configScope: configuration.configScope,
          inherited: configuration.inherited,
          revision: configuration.revision,
          updatedAt: configuration.updatedAt,
          fields: configuration.fields,
          values: configuration.values,
          ...(configuration.reason ? { reason: configuration.reason } : {}),
        } : null;
        return {
          ...status,
          configured: agentId === "qoder-cn"
            ? Boolean(status.installed && status.status === "ready" && authentication?.authenticated)
            : Boolean(status.installed && status.status === "ready" && model),
          model,
          authentication,
          configuration: publicConfiguration,
          runtimeCapabilities: adapter ? structuredClone(adapter.capabilities) : null,
        };
      })) };
    });
    router.route("GET", "/api/servers/:id/directories", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteControl?.listHomeDirectories === "function", "REMOTE_DIRECTORY_BROWSER_UNAVAILABLE", "当前服务器不支持目录选择", { status: 503 });
      return backend.remoteControl.listHomeDirectories(request.query.path || null);
    });
    router.route("POST", "/api/servers/:id/directories", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteControl?.createHomeDirectory === "function", "REMOTE_DIRECTORY_CREATE_UNAVAILABLE", "当前服务器不支持新建目录", { status: 503 });
      const body = strictBody(request.body, ["parent", "name"], "新建远端目录");
      return backend.remoteControl.createHomeDirectory({ parent: body.parent, name: body.name });
    });
    router.route("POST", "/api/servers/:id/agents/:agentId/register", async (request) => {
      const body = requiredObject(request.body, "手动添加 Agent");
      return (await request.services.agentDeploymentFor(request.params.id)).registerUserDeployment(request.params.agentId, { root: body.root });
    });
    router.route("POST", "/api/servers/:id/agents/:agentId/readiness", async (request) => {
      const body = strictBody(request.body || {}, ["configScope", "source"], "检查 Agent");
      invariant(body.source == null || ["managed", "user"].includes(body.source), "AGENT_CONFIG_SOURCE_INVALID", "Agent 配置来源无效", { status: 400 });
      const deployment = await request.services.agentDeploymentFor(request.params.id);
      const runtimeStatus = await deployment.resolveRuntime(request.params.agentId, { source: body.source || null });
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.agentConfiguration?.inspect === "function", "AGENT_CONFIG_READ_UNAVAILABLE", "远端 backend 未提供 Agent 配置读取能力", { status: 503 });
      const configuration = await backend.agentConfiguration.inspect(request.params.agentId, {
        source: runtimeStatus.source,
        configScope: body.configScope || "default",
      });
      const model = String(configuration?.values?.model || "").trim();
      const authentication = request.params.agentId === "qoder-cn"
        ? await deployment.authenticationStatus(request.params.agentId, { force: true })
        : null;
      invariant(request.params.agentId === "qoder-cn" || !runtimeStatus.managed || model, "AGENT_MODEL_NOT_CONFIGURED", `${runtimeStatus.displayName} 尚未选择模型`, {
        status: 409,
        details: { agentId: request.params.agentId },
      });
      const protocolReadiness = authentication?.authenticated === false
        ? null
        : typeof backend.agentTransport?.checkReadiness === "function"
        ? await backend.agentTransport.checkReadiness(request.params.agentId, {
            source: runtimeStatus.source,
            configScope: body.configScope || "default",
          })
        : null;
      return {
        ready: request.params.agentId === "qoder-cn" ? authentication?.authenticated === true : true,
        agentId: request.params.agentId,
        displayName: runtimeStatus.displayName,
        source: runtimeStatus.source,
        managed: runtimeStatus.managed,
        model: model || null,
        authentication,
        configScope: configuration.configScope,
        inherited: configuration.inherited === true,
        configurationRevision: configuration.revision,
        protocol: protocolReadiness?.protocol || null,
      };
    });
    router.route("GET", "/api/servers/:id/agents/:agentId/auth", async (request) => {
      strictQuery(request.query, [], "读取 Agent 登录状态");
      return (await request.services.agentDeploymentFor(request.params.id)).authenticationStatus(request.params.agentId, { force: true });
    });
    router.route("GET", "/api/servers/:id/agents/:agentId/catalog", async (request) => {
      const query = strictQuery(request.query, ["force"], "读取 Agent 原生模型目录");
      invariant(query.force == null || ["0", "1"].includes(query.force), "AGENT_NATIVE_CATALOG_QUERY_INVALID", "Agent 原生模型目录参数无效", { status: 400 });
      return (await request.services.agentDeploymentFor(request.params.id)).nativeCatalog(request.params.agentId, { force: query.force === "1" });
    });
    router.route("POST", "/api/servers/:id/agents/:agentId/login", async (request) => {
      strictBody(request.body || {}, [], "登录 Agent");
      return (await request.services.agentDeploymentFor(request.params.id)).beginLogin(request.params.agentId);
    });
    router.route("GET", "/api/servers/:id/agents/:agentId/update", async (request) => (await request.services.agentDeploymentFor(request.params.id)).checkUpdate(request.params.agentId));
    for (const [route, method] of [["install", "install"], ["update", "install"], ["uninstall", "uninstall"]]) {
      router.route("POST", `/api/servers/:id/agents/:agentId/${route}`, async (request) => (await request.services.agentDeploymentFor(request.params.id))[method](request.params.agentId, requiredObject(request.body || {}, `Agent ${route}`)));
    }
    router.route("GET", "/api/servers/:id/agents/:agentId/config", async (request) => {
      const query = strictQuery(request.query, ["source", "cached", "configScope"], "Agent 配置");
      invariant(query.source == null || ["managed", "user"].includes(query.source), "AGENT_CONFIG_SOURCE_INVALID", "Agent 配置来源无效", { status: 400 });
      invariant(query.cached == null || query.cached === "1", "AGENT_CONFIG_CACHE_INVALID", "Agent 配置缓存参数无效", { status: 400 });
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.agentConfiguration?.inspect === "function", "AGENT_CONFIG_UNAVAILABLE", "远端 backend 未提供 Agent 配置能力", { status: 503 });
      if (query.cached === "1" && typeof backend.agentConfiguration?.snapshot === "function") {
        const snapshot = backend.agentConfiguration.snapshot(request.params.agentId, { configScope: query.configScope || "default" });
        if (snapshot) return snapshot;
      }
      return backend.agentConfiguration.inspect(request.params.agentId, { source: query.source || null, configScope: query.configScope || "default" });
    });
    router.route("PATCH", "/api/servers/:id/agents/:agentId/config", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.agentConfiguration?.update === "function", "AGENT_CONFIG_WRITE_UNAVAILABLE", "远端 backend 未提供 Agent 配置写入能力", { status: 503 });
      const body = requiredObject(request.body, "更新 Agent 配置");
      const configuration = await backend.agentConfiguration.update(request.params.agentId, {
        source: body.source,
        configScope: body.configScope || "default",
        expectedRevision: expectedRevision(request),
        values: body.values,
      });
      if (typeof backend.agentTransport?.refreshManagedConfiguration === "function") {
        if (body.configScope) await backend.agentTransport.refreshManagedConfiguration(request.params.agentId, { configScope: body.configScope });
        else await backend.agentTransport.refreshManagedConfiguration(request.params.agentId);
      }
      return configuration;
    });
    router.route("GET", "/api/servers/:id/agents/:agentId/context", (request) => request.services.agentOperation(request.params.id, request.params.agentId, "contextUsage", {
      bindingId: request.query.bindingId,
      configScope: request.query.configScope,
      source: request.query.source,
      workspacePath: request.query.workspacePath,
    }));
    router.route("POST", "/api/servers/:id/agents/:agentId/compact", (request) => request.services.agentOperation(request.params.id, request.params.agentId, "compact", requiredObject(request.body, "压缩 Agent 上下文")));

    router.route("GET", "/api/tasks/:id/events", async (request) => {
      await request.services.orchestrator.getTask(request.params.id);
      return request.services.broker.replay(taskTopic(request.params.id), {
        afterSequence: request.query.after ? Number(request.query.after) : 0,
        limit: request.query.limit ? Number(request.query.limit) : 2_000,
        view: request.query.view,
      });
    });

    router.route("POST", "/api/tasks/:id/events/details", async (request) => {
      await request.services.orchestrator.getTask(request.params.id);
      return request.services.broker.details(taskTopic(request.params.id), strictBody(request.body, ["eventIds"], "读取事件详情").eventIds);
    });
    router.route("GET", "/api/tasks/:id/events/details", async (request) => {
      await request.services.orchestrator.getTask(request.params.id);
      strictQuery(request.query, ["ids"], "读取事件详情");
      return request.services.broker.details(taskTopic(request.params.id), String(request.query.ids || "").split(","));
    });

    router.route("GET", "/api/servers/:id/workspaces/:workspaceId/files", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.list === "function", "REMOTE_FILES_UNAVAILABLE", "远端 backend 未提供文件浏览", { status: 503 });
      strictQuery(request.query, ["path"], "浏览远端文件");
      return backend.remoteFiles.list({ workspaceId: request.params.workspaceId, path: request.query.path || "" });
    });
    router.route("GET", "/api/servers/:id/workspaces/:workspaceId/git/status", async (request) => {
      strictQuery(request.query, [], "读取工作区 Git 状态");
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.gitStatus === "function", "REMOTE_GIT_UNAVAILABLE", "远端 backend 未提供 Git 状态查询", { status: 503 });
      return backend.remoteFiles.gitStatus({ workspaceId: request.params.workspaceId });
    });
    router.route("POST", "/api/servers/:id/workspaces/:workspaceId/files/download", (request) => {
      const body = strictBody(request.body, ["path"], "下载远端文件");
      return this.issueRemoteFileDownload({
        actor: request.session.actor,
        serverId: request.params.id,
        workspaceId: request.params.workspaceId,
        path: body.path,
      });
    });
    router.route("POST", "/api/servers/:id/workspaces/:workspaceId/files", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.createFile === "function", "REMOTE_FILE_CREATE_UNAVAILABLE", "远端 backend 未提供新建文件", { status: 503 });
      const body = strictBody(request.body, ["path"], "新建远端文件");
      return backend.remoteFiles.createFile({ workspaceId: request.params.workspaceId, path: body.path });
    });
    router.route("POST", "/api/servers/:id/workspaces/:workspaceId/directories", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.mkdir === "function", "REMOTE_DIRECTORY_CREATE_UNAVAILABLE", "远端 backend 未提供新建目录", { status: 503 });
      const body = strictBody(request.body, ["path"], "新建远端目录");
      return backend.remoteFiles.mkdir({ workspaceId: request.params.workspaceId, path: body.path });
    });
    router.route("PATCH", "/api/servers/:id/workspaces/:workspaceId/entries", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.rename === "function", "REMOTE_FILE_RENAME_UNAVAILABLE", "远端 backend 未提供重命名", { status: 503 });
      const body = strictBody(request.body, ["path", "destination"], "重命名远端文件");
      return backend.remoteFiles.rename({ workspaceId: request.params.workspaceId, path: body.path, destination: body.destination });
    });
    router.route("POST", "/api/servers/:id/workspaces/:workspaceId/entries/copy", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.copy === "function", "REMOTE_FILE_COPY_UNAVAILABLE", "远端 backend 未提供复制文件", { status: 503 });
      const body = strictBody(request.body, ["path", "destination"], "复制远端文件");
      return backend.remoteFiles.copy({ workspaceId: request.params.workspaceId, path: body.path, destination: body.destination });
    });
    router.route("DELETE", "/api/servers/:id/workspaces/:workspaceId/entries", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.remoteFiles?.delete === "function", "REMOTE_FILE_DELETE_UNAVAILABLE", "远端 backend 未提供删除", { status: 503 });
      const body = strictBody(request.body, ["path", "recursive", "confirmation"], "删除远端文件");
      return backend.remoteFiles.delete({ workspaceId: request.params.workspaceId, path: body.path, recursive: body.recursive === true, confirmation: body.confirmation });
    });
    router.route("POST", "/api/servers/:id/terminal", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.create === "function", "REMOTE_TERMINAL_UNAVAILABLE", "远端 backend 未提供终端会话", { status: 503 });
      return backend.terminal.create({ ...requiredObject(request.body, "创建终端"), commandId: commandId(request) });
    });
    router.route("GET", "/api/servers/:id/terminal", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.list === "function", "REMOTE_TERMINAL_UNAVAILABLE", "远端 backend 未提供终端会话", { status: 503 });
      return backend.terminal.list({ scopeKey: request.query.scopeKey });
    });
    router.route("POST", "/api/servers/:id/terminal/:sessionId/input", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.input === "function", "REMOTE_TERMINAL_INPUT_UNAVAILABLE", "远端 backend 未提供终端输入", { status: 503 });
      return backend.terminal.input(request.params.sessionId, { ...requiredObject(request.body, "终端输入"), commandId: commandId(request) });
    });
    router.route("GET", "/api/servers/:id/terminal/:sessionId", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.inspect === "function", "REMOTE_TERMINAL_UNAVAILABLE", "远端 backend 未提供终端会话", { status: 503 });
      return backend.terminal.inspect(request.params.sessionId);
    });
    router.route("POST", "/api/servers/:id/terminal/:sessionId/resize", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.resize === "function", "REMOTE_TERMINAL_RESIZE_UNAVAILABLE", "远端 backend 未提供终端尺寸调整", { status: 503 });
      return backend.terminal.resize(request.params.sessionId, { ...requiredObject(request.body, "调整终端大小"), commandId: commandId(request) });
    });
    router.route("POST", "/api/servers/:id/terminal/:sessionId/detach", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.detach === "function", "REMOTE_TERMINAL_DETACH_UNAVAILABLE", "远端 backend 未提供终端分离", { status: 503 });
      return backend.terminal.detach(request.params.sessionId);
    });
    router.route("POST", "/api/servers/:id/terminal/:sessionId/resume", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.resume === "function", "REMOTE_TERMINAL_RESUME_UNAVAILABLE", "远端 backend 未提供终端恢复", { status: 503 });
      return backend.terminal.resume(request.params.sessionId);
    });
    router.route("DELETE", "/api/servers/:id/terminal/:sessionId", async (request) => {
      const backend = await request.services.remoteBackend(request.params.id);
      invariant(typeof backend.terminal?.close === "function", "REMOTE_TERMINAL_CLOSE_UNAVAILABLE", "远端 backend 未提供终端关闭", { status: 503 });
      return backend.terminal.close(request.params.sessionId);
    });
    router.route("POST", "/api/servers/:id/versioning/activate", (request) => {
      const body = strictBody(request.body, ["workspaceId", "conversationId", "branchId"], "切换对话文件版本");
      return request.services.activateWorkspaceVersion(request.params.id, { ...body, activationId: commandId(request) });
    });
    router.route("GET", "/api/servers/:id/versioning/status", (request) => {
      const query = strictQuery(request.query, ["workspaceId", "conversationId", "branchId"], "读取版本历史");
      return request.services.workspaceVersionStatus(request.params.id, {
        workspaceId: query.workspaceId,
        conversationId: query.conversationId,
        branchId: query.branchId,
      });
    });
    router.route("POST", "/api/servers/:id/versioning/rewind", (request) => {
      const body = strictBody(request.body, ["workspaceId", "conversationId", "branchId", "targetCheckpointId"], "回退版本历史");
      return request.services.rewindWorkspaceVersion(request.params.id, { ...body, rewindId: commandId(request) });
    });
    router.route("GET", "/api/servers/:id/scheduler/capabilities", async (request) => (await request.services.schedulerFor(request.params.id)).getCapabilities());
    router.route("GET", "/api/servers/:id/scheduler/partitions", async (request) => (await request.services.schedulerFor(request.params.id)).accessiblePartitions());
    router.route("GET", "/api/servers/:id/scheduler/resources", async (request) => (await request.services.schedulerFor(request.params.id)).resourceSummary({ partitions: parseCsv(request.query.partitions) }));
    router.route("GET", "/api/servers/:id/scheduler/jobs", async (request) => (await request.services.schedulerFor(request.params.id)).userJobs());
    router.route("GET", "/api/servers/:id/scheduler/jobs/history", async (request) => {
      const query = strictQuery(request.query, ["startDate", "endDate", "utcOffsetMinutes"], "读取历史作业");
      return (await request.services.schedulerFor(request.params.id)).jobHistory({ startDate: query.startDate, endDate: query.endDate, utcOffsetMinutes: query.utcOffsetMinutes });
    });
    router.route("GET", "/api/servers/:id/scheduler/resource-dashboard", async (request) => (await request.services.schedulerFor(request.params.id)).resources({ refresh: request.query.refresh === "1" }));
    router.route("GET", "/api/servers/:id/scheduler/dashboard", async (request) => (await request.services.schedulerFor(request.params.id)).dashboard({ refresh: request.query.refresh === "1" }));
    router.route("GET", "/api/servers/:id/scheduler/jobs/:jobId/output", async (request) => {
      const output = await (await request.services.schedulerFor(request.params.id)).jobOutput({ jobId: request.params.jobId, stream: request.query.stream, offset: request.query.offset && Number(request.query.offset), maxBytes: request.query.maxBytes && Number(request.query.maxBytes) });
      return { ...output, bytesBase64: output.bytes.toString("base64"), bytes: undefined };
    });
    router.route("POST", "/api/servers/:id/scheduler/jobs", (request) => {
      const body = strictBody(request.body, ["workspaceId", "conversationId", "branchId", "partition", "scriptPath", "args"], "提交作业");
      return request.services.submitSchedulerJob(request.params.id, { ...body, commandId: commandId(request) });
    });
    router.route("POST", "/api/servers/:id/scheduler/jobs/:jobId/cancel", async (request) => (await request.services.schedulerFor(request.params.id)).cancelJob({ jobId: request.params.jobId, commandId: commandId(request) }));
  }

  async helpDocument() {
    const [content, stat] = await Promise.all([fs.readFile(this.helpFile, "utf8"), fs.stat(this.helpFile)]);
    return {
      content,
      mediaType: "text/markdown; charset=utf-8",
      etag: `"${crypto.createHash("sha256").update(content).digest("base64url")}"`,
      lastModified: stat.mtime.toUTCString(),
    };
  }

  async adminSshConnections(adminActor) {
    invariant(adminActor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    const users = await this.auth.listUsersForAdmin(adminActor);
    const live = new Set(this.sshPool.snapshot().map((entry) => `${entry.actorId}:${entry.serverId}`));
    const groups = await Promise.all(users.map(async (user) => {
      const actor = createActorContext({
        actorType: "user",
        actorId: user.userId,
        deviceId: "admin-inspection",
        sessionId: "admin-inspection",
        roles: [],
      });
      const servers = await this.registryForActor(actor).list();
      return servers.map(({ profile, connection, conversationIds, activeConversationIds = conversationIds }) => {
        const isLive = live.has(`${user.userId}:${profile.id}`);
        const status = connection.status === "connected" && !isLive ? "disconnected" : connection.status;
        return {
          actorId: user.userId,
          username: user.username,
          serverId: profile.id,
          serverName: profile.name,
          host: profile.host,
          status,
          lastActiveAt: connection.lastActiveAt,
          conversationCount: activeConversationIds.length,
        };
      });
    }));
    return {
      items: groups.flat().sort((left, right) => String(right.lastActiveAt || "").localeCompare(String(left.lastActiveAt || "")) || left.username.localeCompare(right.username, "zh-CN")),
    };
  }

  async adminUsers(adminActor, query = {}) {
    invariant(adminActor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    const page = await this.auth.pageUsersForAdmin(adminActor, {
      query: query.query,
      page: query.page === undefined ? 1 : Number(query.page),
      limit: query.limit === undefined ? 30 : Number(query.limit),
    });
    const liveCounts = new Map();
    for (const entry of this.sshPool.snapshot()) liveCounts.set(entry.actorId, (liveCounts.get(entry.actorId) || 0) + 1);
    return {
      ...page,
      items: page.items.map((item) => ({ ...item, liveSshCount: liveCounts.get(item.userId) || 0 })),
    };
  }

  async adminUserDetails(adminActor, userId, query = {}) {
    invariant(adminActor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    const user = await this.auth.getUserForAdmin(adminActor, userId);
    const actor = createActorContext({
      actorType: "user",
      actorId: user.userId,
      deviceId: "admin-inspection",
      sessionId: "admin-inspection",
      roles: [],
    });
    const conversations = new ConversationService({
      dataRoot: this.dataRoot,
      actor,
      queue: this.queue,
      clock: this.clock,
      cursorSecret: this.secrets.cursorSecret,
    });
    const [conversationPage, servers, tasks] = await Promise.all([
      conversations.listConversations({
        ...(query.conversationCursor ? { cursor: query.conversationCursor } : {}),
        limit: query.conversationLimit === undefined ? 30 : Number(query.conversationLimit),
      }),
      this.registryForActor(actor).list(),
      new FileTaskStore({ dataRoot: this.dataRoot, actor, queue: this.queue, clock: this.clock }).listTasks({ limit: 1000 }),
    ]);
    const live = new Set(this.sshPool.snapshot()
      .filter((entry) => entry.actorId === user.userId)
      .map((entry) => entry.serverId));
    return {
      user,
      conversations: conversationPage,
      taskCount: tasks.length,
      activeTaskCount: tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).length,
      servers: servers.map(({ profile, connection, conversationIds, activeConversationIds = conversationIds }) => ({
        serverId: profile.id,
        serverName: profile.name,
        host: profile.host,
        status: connection.status === "connected" && !live.has(profile.id) ? "disconnected" : connection.status,
        desiredConnection: Boolean(connection.desiredConnection),
        lastActiveAt: connection.lastActiveAt,
        conversationCount: activeConversationIds.length,
      })),
    };
  }

  async adminDeleteUser(adminActor, input) {
    invariant(adminActor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    invariant(typeof input?.commandId === "string" && input.commandId, "IDEMPOTENCY_KEY_REQUIRED", "写操作必须提供 Idempotency-Key", { status: 428 });
    const user = await this.auth.getUserForAdmin(adminActor, input.actorId);
    const actor = createActorContext({ actorType: "user", actorId: user.userId, deviceId: "admin-deletion", sessionId: "admin-deletion", roles: [] });
    const entry = this.containers.get(actorKey(actor));
    if (entry) {
      const container = await entry.promise.catch(() => null);
      invariant(!container?.interactions?.runs?.size && !container?.taskRuntime?.activeKeys?.().length, "ADMIN_USER_BUSY", "用户仍有正在执行的任务，请先停止任务后再删除", { status: 409 });
      await this.releaseActor(actor, { force: true });
    }
    await this.sshPool.forceReleaseActor(actor);
    this.registries.delete(actorKey(actor));
    return { commandId: input.commandId, ...(await this.auth.deleteUserForAdmin(adminActor, user.userId)) };
  }

  async adminDisconnectSsh(adminActor, input) {
    invariant(adminActor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    invariant(typeof input?.commandId === "string" && input.commandId, "IDEMPOTENCY_KEY_REQUIRED", "写操作必须提供 Idempotency-Key", { status: 428 });
    const users = await this.auth.listUsersForAdmin(adminActor);
    const user = users.find((entry) => entry.userId === input.actorId);
    invariant(user, "ADMIN_SSH_ACTOR_NOT_FOUND", "用户不存在", { status: 404 });
    const actor = createActorContext({
      actorType: "user",
      actorId: user.userId,
      deviceId: "admin-inspection",
      sessionId: "admin-inspection",
      roles: [],
    });
    const registry = this.registryForActor(actor);
    const before = await registry.get(input.serverId);
    const connection = await this.sshPool.workerFor(actor).disconnect(input.serverId);
    return {
      commandId: input.commandId,
      disconnected: true,
      item: {
        actorId: user.userId,
        username: user.username,
        serverId: before.profile.id,
        serverName: before.profile.name,
        host: before.profile.host,
        status: connection.status,
        lastActiveAt: connection.lastActiveAt,
        conversationCount: (before.activeConversationIds || before.conversationIds).length,
      },
    };
  }

  async openArtifactDownload({ actor, artifactId, downloadToken, rangeHeader }) {
    const services = await this.servicesForActor(actor);
    const artifact = await services.artifacts.get({ artifactId });
    const range = parseRangeHeader(rangeHeader, artifact.versions.find((entry) => entry.id === artifact.activeVersionId)?.size ?? artifact.size);
    return services.artifacts.openDownload({ downloadToken, range });
  }

  async issueArtifactDownload({ actor, artifactId, ttlMs }) {
    invariant(actor?.actorType && actor?.actorId && actor?.deviceId && actor?.sessionId, "ACTOR_CONTEXT_REQUIRED", "下载结果文件需要有效会话", { status: 401 });
    const services = await this.servicesForActor(actor);
    const requestedTtlMs = Number(ttlMs ?? ARTIFACT_DOWNLOAD_TTL_MS);
    const issued = await services.artifacts.issueDownload({ artifactId: String(artifactId || ""), ttlMs: requestedTtlMs });
    const clockValue = this.clock();
    const now = (clockValue instanceof Date ? clockValue : new Date(clockValue)).valueOf();
    const downloadTicket = this.artifactDownloadTicketCodec.encode({
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        deviceId: actor.deviceId,
        sessionId: actor.sessionId,
        roles: [...(actor.roles || [])],
      },
      artifactId: String(artifactId),
      artifactToken: issued.downloadToken,
    }, { now, ttlMs: requestedTtlMs });
    return {
      ...issued,
      downloadToken: downloadTicket,
      url: `/api/artifacts/${encodeURIComponent(String(artifactId))}/download?token=${encodeURIComponent(downloadTicket)}`,
    };
  }

  resolveArtifactDownloadTicket(downloadTicket) {
    const clockValue = this.clock();
    const now = (clockValue instanceof Date ? clockValue : new Date(clockValue)).valueOf();
    const decoded = this.artifactDownloadTicketCodec.decode(downloadTicket, { now });
    const actor = createActorContext(decoded?.actor);
    const artifactId = String(decoded?.artifactId || "");
    const artifactToken = String(decoded?.artifactToken || "");
    invariant(artifactId && artifactToken, "ARTIFACT_DOWNLOAD_TOKEN_INVALID", "结果文件下载链接无效", { status: 401 });
    return { actor, artifactId, artifactToken };
  }

  issueRemoteFileDownload({ actor, serverId, workspaceId, path: relativePath }) {
    invariant(actor?.actorType && actor?.actorId && actor?.deviceId && actor?.sessionId, "ACTOR_CONTEXT_REQUIRED", "下载远端文件需要有效会话", { status: 401 });
    const normalizedServerId = String(serverId || "");
    const normalizedWorkspaceId = String(workspaceId || "");
    const normalizedPath = String(relativePath || "").replace(/\\/g, "/");
    invariant(normalizedServerId && normalizedServerId.length <= 256 && normalizedWorkspaceId && normalizedWorkspaceId.length <= 256, "REMOTE_FILE_DOWNLOAD_SCOPE_INVALID", "远端文件下载范围无效", { status: 400 });
    invariant(normalizedPath && normalizedPath.length <= 32_768 && !normalizedPath.includes("\0"), "REMOTE_FILE_DOWNLOAD_PATH_INVALID", "远端文件下载路径无效", { status: 400 });
    const clockValue = this.clock();
    const now = (clockValue instanceof Date ? clockValue : new Date(clockValue)).valueOf();
    invariant(Number.isSafeInteger(now), "REMOTE_FILE_DOWNLOAD_CLOCK_INVALID", "远端文件下载时钟无效", { status: 500, expose: false });
    const downloadToken = this.remoteFileDownloadCodec.encode({
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        deviceId: actor.deviceId,
        sessionId: actor.sessionId,
        roles: [...(actor.roles || [])],
      },
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      path: normalizedPath,
    }, { now, ttlMs: REMOTE_FILE_DOWNLOAD_TTL_MS });
    return {
      url: `/api/servers/${encodeURIComponent(normalizedServerId)}/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/files/content?downloadToken=${encodeURIComponent(downloadToken)}`,
      expiresAt: new Date(now + REMOTE_FILE_DOWNLOAD_TTL_MS).toISOString(),
    };
  }

  resolveRemoteFileDownloadToken(downloadToken) {
    const clockValue = this.clock();
    const now = (clockValue instanceof Date ? clockValue : new Date(clockValue)).valueOf();
    const decoded = this.remoteFileDownloadCodec.decode(downloadToken, { now });
    const actor = createActorContext(decoded?.actor);
    const serverId = String(decoded?.serverId || "");
    const workspaceId = String(decoded?.workspaceId || "");
    const relativePath = String(decoded?.path || "");
    invariant(serverId && workspaceId && relativePath && !relativePath.includes("\0"), "REMOTE_FILE_DOWNLOAD_TOKEN_INVALID", "远端文件下载链接无效", { status: 401 });
    return { actor, serverId, workspaceId, path: relativePath };
  }

  async previewHead({ actor, previewId }) {
    const services = await this.servicesForActor(actor);
    return services.previews.head({ previewId });
  }

  async openPreviewContent({ actor, previewId, rangeHeader }) {
    const services = await this.servicesForActor(actor);
    const head = services.previews.head({ previewId });
    const range = parsePreviewRangeHeader(rangeHeader, head.contentLength);
    return services.previews.openContent({ previewId, range });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    if (this.containerTimer) clearInterval(this.containerTimer);
    if (this.guestTimer) clearInterval(this.guestTimer);
    await this.actorRecoveryPromise?.catch(() => undefined);
    await Promise.allSettled([...this.containers.values()].map(async (entry) => (await entry.promise).close()));
    this.containers.clear();
    await this.sshPool.stop();
    this.registries.clear();
  }
}

export async function createEasyWorkRuntime(options) {
  return EasyWorkRuntime.create(options);
}
