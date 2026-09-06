import { invariant } from "../errors.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 60_000;
const PREVIEW_TYPES = Object.freeze(["text", "markdown", "code", "json", "image", "pdf", "table"]);
const REMOTE_FEATURES = Object.freeze([
  "remoteFiles",
  "preview",
  "terminal",
  "workspaces",
  "versioning",
  "scheduler",
  "agents",
  "skills",
]);

const clone = (value) => structuredClone(value);

function dateFrom(clock) {
  const value = (clock || (() => new Date()))();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.valueOf()), "SERVER_CAPABILITY_CLOCK_INVALID", "服务器能力检测时钟无效", { status: 500, expose: false });
  return date;
}

function diagnosticRef(code, retryable) {
  return code ? Object.freeze({ code, retryable: Boolean(retryable) }) : null;
}

function capability(status, reason = null, diagnostic = null, details = {}) {
  invariant(["available", "unavailable", "restricted", "error"].includes(status), "SERVER_CAPABILITY_STATUS_INVALID", "服务器能力状态无效", { status: 500, expose: false });
  return Object.freeze({
    available: status === "available",
    status,
    reason: reason ? String(reason) : null,
    diagnostic: diagnostic ? diagnosticRef(diagnostic.code, diagnostic.retryable) : null,
    ...details,
  });
}

function unavailableFeatures(status, reason, diagnostic) {
  const common = (details) => capability(status, reason, diagnostic, details);
  return Object.freeze({
    remoteFiles: common({ list: false, upload: false, download: false, range: false, mkdir: false, create: false, copy: false, rename: false, delete: false, maxUploadBytes: null, maxDownloadBytes: null }),
    preview: common({ types: [] }),
    terminal: common({ pty: false, resume: false }),
    workspaces: common({ virtual: false, user: false, switch: false }),
    versioning: common({ eventLedger: false, isolated: true }),
    scheduler: common({
      type: "none",
      resourceSummary: false,
      partitions: false,
      userJobs: false,
      jobHistory: false,
      submitJob: false,
      cancelJob: false,
      jobOutput: false,
    }),
    agents: common({ inspect: false, install: false, update: false, uninstall: false, configure: false, context: false, compact: false }),
    skills: common({ registry: false, deploy: false }),
  });
}

function diagnostic(feature, code, message, retryable) {
  return Object.freeze({ id: `capability:${feature}:${code}`, feature, code, message, retryable: Boolean(retryable) });
}

function safeFailure(error, fallbackCode = "SERVER_CAPABILITY_PROBE_FAILED") {
  const raw = String(error?.code || "");
  const code = /^[A-Z][A-Z0-9_]{2,127}$/.test(raw) ? raw : fallbackCode;
  const restricted = Number(error?.status) === 403 || /(?:FORBIDDEN|SCOPE_VIOLATION|POLICY)/.test(code);
  const disconnected = ["SSH_NOT_CONNECTED", "SSH_CONNECTION_CLOSED", "SSH_CONNECTION_LOST"].includes(code);
  if (restricted) return { status: "restricted", code, reason: "当前用户无权使用此能力", message: "能力受服务器权限或平台策略限制", retryable: false };
  if (disconnected) return { status: "unavailable", code, reason: "SSH 未连接", message: "SSH 会话当前不可用", retryable: true };
  return { status: "error", code, reason: "能力检测失败", message: "服务器能力检测未完成，可稍后重试", retryable: error?.retryable !== false };
}

function method(target, name) {
  return typeof target?.[name] === "function";
}

function interfaceFeatures(backend) {
  const remoteFiles = method(backend.remoteFiles, "list");
  const remoteUpload = method(backend.remoteFiles, "uploadStream");
  const remoteDownload = method(backend.remoteFiles, "inspectDownload") && method(backend.remoteFiles, "openDownloadStream");
  const remoteMkdir = method(backend.remoteFiles, "mkdir");
  const remoteCreate = method(backend.remoteFiles, "createFile");
  const remoteCopy = method(backend.remoteFiles, "copy");
  const remoteRename = method(backend.remoteFiles, "rename");
  const remoteDelete = method(backend.remoteFiles, "delete");
  const remoteFileCapabilities = typeof backend.remoteFiles?.capabilities === "function" ? backend.remoteFiles.capabilities() : {};
  const preview = method(backend.remoteArtifactSource, "inspect") && method(backend.remoteArtifactSource, "openReadStream");
  const terminal = method(backend.terminal, "create") && method(backend.terminal, "input") && method(backend.terminal, "inspect") && method(backend.terminal, "close");
  const terminalResume = terminal && method(backend.terminal, "detach") && method(backend.terminal, "resume");
  const eventLedger = Boolean(backend.conversationVersion);
  const workspaces = Boolean(backend.remoteControl && backend.remoteFs && backend.remoteExec);
  const inspectAgents = Boolean(backend.agentDeployment && method(backend.agentDeployment, "status"));
  const installAgents = inspectAgents && method(backend.agentDeployment, "install");
  const uninstallAgents = inspectAgents && method(backend.agentDeployment, "uninstall");
  const configureAgents = method(backend.agentConfiguration, "inspect") && method(backend.agentConfiguration, "update");
  const agentContext = Boolean(backend.agentTransport);
  const skillRegistry = method(backend.skillDeployment, "inspect");
  const skillDeploy = skillRegistry && method(backend.skillDeployment, "ensure");
  const available = (enabled, reason, details) => enabled
    ? capability("available", null, null, details)
    : capability("unavailable", reason, null, details);
  return {
    remoteFiles: available(remoteFiles, "远端文件接口不可用", {
      list: remoteFiles,
      upload: remoteUpload,
      download: remoteDownload,
      range: remoteDownload && remoteFileCapabilities.range === true,
      mkdir: remoteMkdir,
      create: remoteCreate,
      copy: remoteCopy,
      rename: remoteRename,
      delete: remoteDelete,
      maxUploadBytes: Number.isSafeInteger(remoteFileCapabilities.maxUploadBytes) ? remoteFileCapabilities.maxUploadBytes : null,
      maxDownloadBytes: Number.isSafeInteger(remoteFileCapabilities.maxDownloadBytes) ? remoteFileCapabilities.maxDownloadBytes : null,
    }),
    preview: available(preview, "远端文件预览不可用", { types: preview ? [...PREVIEW_TYPES] : [] }),
    terminal: available(terminal, "远程终端不可用", { pty: terminal, resume: terminalResume }),
    workspaces: available(workspaces, "远端工作区不可用", { virtual: workspaces, user: workspaces, switch: workspaces }),
    versioning: available(eventLedger, "版本管理不可用", { eventLedger, isolated: eventLedger }),
    agents: available(inspectAgents && Boolean(backend.agentTransport), "远端 Agent 管理不可用", {
      inspect: inspectAgents,
      install: installAgents,
      update: installAgents,
      uninstall: uninstallAgents,
      configure: configureAgents,
      context: agentContext,
      compact: agentContext,
    }),
    skills: available(skillRegistry && skillDeploy, "远端 Skill 部署不可用", { registry: skillRegistry, deploy: skillDeploy }),
  };
}

function schedulerFeature(profile) {
  const type = ["slurm", "pbs", "generic"].includes(profile?.scheduler) ? profile.scheduler : "none";
  const flags = profile?.features || {};
  const details = {
    type,
    resourceSummary: Boolean(flags.resourceSummary?.available),
    partitions: Boolean(flags.accessiblePartitions?.available),
    userJobs: Boolean(flags.userJobs?.available),
    jobHistory: Boolean(flags.jobHistory?.available),
    submitJob: Boolean(flags.submit?.available),
    cancelJob: Boolean(flags.cancelJob?.available),
    jobOutput: Boolean(flags.jobOutput?.available),
  };
  return type === "none"
    ? capability("unavailable", "未检测到支持的作业调度器", null, details)
    : capability("available", null, null, details);
}

function profileStatus(features, diagnostics) {
  const values = Object.values(features);
  const errorCount = values.filter((entry) => entry.status === "error").length;
  if (errorCount === values.length) return "error";
  if (errorCount || diagnostics.some((entry) => entry.code === "SSH_NOT_CONNECTED" || entry.code === "SSH_CONNECTION_CLOSED" || entry.code === "SSH_CONNECTION_LOST")) return "partial";
  return "ready";
}

export class ServerCapabilityService {
  constructor({ servers, resolveRemoteBackend, resolveScheduler, clock = () => new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
    invariant(servers?.get && typeof resolveRemoteBackend === "function" && typeof resolveScheduler === "function", "SERVER_CAPABILITY_DEPENDENCY_INVALID", "服务器能力检测依赖无效", { status: 500, expose: false });
    this.servers = servers;
    this.resolveRemoteBackend = resolveRemoteBackend;
    this.resolveScheduler = resolveScheduler;
    this.clock = clock;
    this.ttlMs = Number(ttlMs);
    invariant(Number.isSafeInteger(this.ttlMs) && this.ttlMs >= 1_000 && this.ttlMs <= 60 * 60_000, "SERVER_CAPABILITY_TTL_INVALID", "服务器能力 TTL 无效", { status: 500, expose: false });
    this.cache = new Map();
    this.pending = new Map();
    this.epochs = new Map();
  }

  async get(serverId, { refresh = false } = {}) {
    const server = await this.servers.get(serverId);
    const key = this.#key(server);
    const pendingKey = `${serverId}:${key}`;
    const current = this.cache.get(serverId);
    const now = dateFrom(this.clock);
    if (!refresh && current?.key === key && Date.parse(current.profile.expiresAt) > now.valueOf()) return clone(current.profile);
    if (!refresh && this.pending.has(pendingKey)) return clone(await this.pending.get(pendingKey));
    const detection = this.#detect(server, now, { refreshScheduler: refresh }).then(async (profile) => {
      if (this.#key(await this.servers.get(serverId)) !== key) return this.get(serverId);
      if (this.pending.get(pendingKey) === detection) this.cache.set(serverId, { key, profile });
      return profile;
    }).finally(() => {
      if (this.pending.get(pendingKey) === detection) this.pending.delete(pendingKey);
    });
    this.pending.set(pendingKey, detection);
    return clone(await detection);
  }

  async peek(serverId) {
    const server = await this.servers.get(serverId);
    const key = this.#key(server);
    const current = this.cache.get(serverId);
    return current?.key === key ? clone(current.profile) : null;
  }

  invalidate(serverId) {
    this.cache.delete(String(serverId));
    this.epochs.set(String(serverId), (this.epochs.get(String(serverId)) || 0) + 1);
  }

  #key(server) {
    return `${server.connection.status}:${server.connection.generation}:${server.profile.serverIdentity || "unidentified"}:${this.epochs.get(String(server.profile.id)) || 0}`;
  }

  async #detect(server, detectedAt, { refreshScheduler = false } = {}) {
    const serverId = server.profile.id;
    const expiresAt = new Date(detectedAt.valueOf() + this.ttlMs);
    const diagnostics = [];
    if (server.connection.status !== "connected" || !server.profile.serverIdentity) {
      const code = "SSH_NOT_CONNECTED";
      for (const feature of REMOTE_FEATURES) diagnostics.push(diagnostic(feature, code, "SSH 会话当前不可用", true));
      const features = unavailableFeatures("unavailable", "SSH 未连接", { code, retryable: true });
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        serverId,
        detectedAt: detectedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: "partial",
        features,
        diagnostics: Object.freeze(diagnostics),
      });
    }

    let backend;
    try {
      backend = await this.resolveRemoteBackend(serverId);
    } catch (error) {
      const failure = safeFailure(error);
      for (const feature of REMOTE_FEATURES) diagnostics.push(diagnostic(feature, failure.code, failure.message, failure.retryable));
      const features = unavailableFeatures(failure.status, failure.reason, failure);
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        serverId,
        detectedAt: detectedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: failure.status === "error" ? "error" : "partial",
        features,
        diagnostics: Object.freeze(diagnostics),
      });
    }

    const interfaces = interfaceFeatures(backend);
    let scheduler;
    try {
      const service = await this.resolveScheduler(serverId);
      scheduler = schedulerFeature(await (refreshScheduler && typeof service.inspectCapabilities === "function" ? service.inspectCapabilities() : service.getCapabilities()));
    } catch (error) {
      const failure = safeFailure(error, "SCHEDULER_CAPABILITY_PROBE_FAILED");
      diagnostics.push(diagnostic("scheduler", failure.code, failure.message, failure.retryable));
      scheduler = capability(failure.status, failure.reason, failure, {
        type: "none", resourceSummary: false, partitions: false, userJobs: false, jobHistory: false, submitJob: false, cancelJob: false, jobOutput: false,
      });
    }
    const features = Object.freeze({
      remoteFiles: interfaces.remoteFiles,
      preview: interfaces.preview,
      terminal: interfaces.terminal,
      workspaces: interfaces.workspaces,
      versioning: interfaces.versioning,
      scheduler,
      agents: interfaces.agents,
      skills: interfaces.skills,
    });
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      serverId,
      detectedAt: detectedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      status: profileStatus(features, diagnostics),
      features,
      diagnostics: Object.freeze(diagnostics),
    });
  }
}

export const serverCapabilityContract = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  defaultTtlMs: DEFAULT_TTL_MS,
  previewTypes: PREVIEW_TYPES,
  features: REMOTE_FEATURES,
});
