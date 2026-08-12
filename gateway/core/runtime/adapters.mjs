import fs from "node:fs/promises";
import path from "node:path";

import { ApiError, invariant } from "../errors.mjs";
import { OpenAIEmbeddingAdapter } from "../resources/embedding-client.mjs";
import { DefaultResourceExtractor } from "../resources/extractor.mjs";
import { SshNetworkPolicy } from "../ssh/network-policy.mjs";

function hostMatches(pattern, host) {
  const normalized = String(pattern || "").toLowerCase();
  return normalized.startsWith("*.")
    ? host.endsWith(normalized.slice(1)) && host !== normalized.slice(2)
    : host === normalized;
}

export class DynamicSshPolicy {
  constructor({ platform }) {
    this.platform = platform;
  }

  async assertAllowed(profile) {
    const configuration = await this.platform.sshRuntimeConfiguration();
    const policy = configuration.networkPolicy;
    const host = String(profile?.host || "").toLowerCase();
    invariant(
      policy.allowedHosts.length === 0 || policy.allowedHosts.some((pattern) => hostMatches(pattern, host)),
      "SSH_HOST_FORBIDDEN",
      "服务器地址不在管理员允许范围内",
      { status: 403 },
    );
    const method = String(profile?.authMethod || "");
    invariant(
      (method !== "private-key" || configuration.transport.allowPrivateKeyAuth)
        && (method !== "password" || configuration.transport.allowPasswordAuth),
      "SSH_AUTH_METHOD_FORBIDDEN",
      "管理员策略不允许该 SSH 登录方式",
      { status: 403 },
    );
    return new SshNetworkPolicy(policy).assertAllowed(profile);
  }
}

export class DynamicEmbeddingAdapter {
  constructor({ platform, fetchImpl = globalThis.fetch }) {
    this.platform = platform;
    this.fetchImpl = fetchImpl;
  }

  async #adapter() {
    const access = await this.platform.resolveProvider("embedding");
    const embedding = access.provider.embedding;
    return new OpenAIEmbeddingAdapter({
      baseUrl: access.credential.baseUrl,
      apiKey: access.credential.apiKey,
      model: embedding.model,
      dimensions: embedding.dimensions,
      batchSize: embedding.batchSize,
      profileId: access.provider.embeddingProfileId,
      fetchImpl: this.fetchImpl,
    });
  }

  async embed(input) {
    return (await this.#adapter()).embed(input);
  }

  async search(input) {
    return (await this.#adapter()).search(input);
  }
}

export class DynamicResourceExtractor {
  constructor({ platform, visionExtractor = null }) {
    this.platform = platform;
    this.visionExtractor = visionExtractor;
  }

  async extract(input) {
    const provider = await this.platform.publicProvider("embedding");
    const settings = provider.embedding || {};
    return new DefaultResourceExtractor({
      visionExtractor: this.visionExtractor,
      maxCharacters: settings.chunkSize || 3_000,
      overlapCharacters: settings.chunkOverlap || 600,
    }).extract(input);
  }
}

export class PromptRepository {
  constructor({ promptRoot }) {
    invariant(path.isAbsolute(promptRoot || ""), "PROMPT_ROOT_INVALID", "promptRoot 必须是绝对路径", { status: 500, expose: false });
    this.promptRoot = path.resolve(promptRoot);
    this.cache = new Map();
  }

  async #read(filePath) {
    const stat = await fs.stat(filePath);
    const cached = this.cache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs) return cached.content;
    const content = await fs.readFile(filePath, "utf8");
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, content });
    return content;
  }

  async system(mode) {
    invariant(["chat", "work"].includes(mode), "PROMPT_MODE_INVALID", "网页 Agent 模式无效", { status: 400 });
    const filePath = path.join(this.promptRoot, "web", `${mode}-system.md`);
    return this.#read(filePath);
  }

  async memory(name) {
    invariant(["persistent-memory-extract", "conversation-compact"].includes(name), "MEMORY_PROMPT_INVALID", "Memory prompt 无效", { status: 400 });
    return this.#read(path.join(this.promptRoot, "memory", `${name}.md`));
  }

  async task(name) {
    invariant(name === "conversation-title", "TASK_PROMPT_INVALID", "Task prompt 无效", { status: 400 });
    return this.#read(path.join(this.promptRoot, "tasks", "conversation-title.md"));
  }

  async agent(agentId) {
    const id = String(agentId || "");
    invariant(["opencode", "codex", "claude-code"].includes(id), "AGENT_PROMPT_INVALID", "Agent prompt 无效", { status: 400 });
    const [common, specific] = await Promise.all([
      this.#read(path.join(this.promptRoot, "agents", "common.md")),
      this.#read(path.join(this.promptRoot, "agents", `${id}.md`)),
    ]);
    return `${common.trim()}\n\n${specific.trim()}\n`;
  }
}

export class CanonicalTaskJournal {
  constructor(journal) {
    this.journal = journal;
  }

  append(topic, event) {
    const { taskId = null, conversationId = null, ...canonical } = event || {};
    return this.journal.append(topic, {
      ...canonical,
      ids: {
        ...(canonical.ids || {}),
        ...(taskId ? { taskId: String(taskId) } : {}),
        ...(conversationId ? { conversationId: String(conversationId) } : {}),
      },
    });
  }
}

export class UnavailableAgentTransport {
  async execute() {
    throw new ApiError("AGENT_TRANSPORT_UNAVAILABLE", "当前 Gateway 未配置远端 Agent transport", { status: 503, retryable: true });
  }
}

export class OrchestratorWorkspaceAdapter {
  constructor({ workspaceFactory }) {
    this.workspaceFactory = workspaceFactory;
  }

  async prepare({ task }) {
    const service = await this.workspaceFactory(task.route.serverId, task.route.serverIdentity);
    const workspace = await service.getWorkspace(task.route.workspaceId);
    invariant(workspace.serverIdentity === task.route.serverIdentity, "TASK_WORKSPACE_SERVER_MISMATCH", "Task 工作区不属于目标服务器", { status: 409 });
    return { ...workspace, path: workspace.canonicalPath };
  }

  async finalize() {}
}

export class OrchestratorVersionAdapter {
  constructor({ versionFactory }) {
    this.versionFactory = versionFactory;
    this.active = new Map();
  }

  async prepare({ task, workspace }) {
    const service = await this.versionFactory(task.route.serverId, task.route.serverIdentity);
    if (!workspace.versionDomainId) return { managed: false, workspaceId: workspace.id };
    const state = await service.getDomain({
      actorId: task.actorId,
      serverIdentity: task.route.serverIdentity,
      versionDomainId: workspace.versionDomainId,
    });
    this.active.set(task.id, { service, state, workspace });
    return { managed: true, versionDomainId: state.versionDomainId, revision: state.revision };
  }

  async recordFileChange({ task, event }) {
    const active = this.active.get(task.id);
    if (!active) return { managed: false };
    return { managed: true, event };
  }

  async finalize({ task }) {
    this.active.delete(task.id);
    return { taskId: task.id, finalized: true };
  }
}

export function unavailableRemoteFactory(feature) {
  return async () => {
    throw new ApiError("REMOTE_CAPABILITY_UNAVAILABLE", `${feature} 尚未接入当前 SSH transport`, { status: 503, retryable: true });
  };
}
