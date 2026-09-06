import crypto from "node:crypto";

import { ApiError, invariant } from "../errors.mjs";
import { OpenAIEmbeddingAdapter } from "../resources/embedding-client.mjs";
import { DefaultResourceExtractor } from "../resources/extractor.mjs";
import { MinerUOcrAdapter, OpenAIOcrAdapter } from "../resources/ocr-client.mjs";
import { SshNetworkPolicy } from "../ssh/network-policy.mjs";

function hostMatches(pattern, host) {
  const normalized = String(pattern || "").toLowerCase();
  return normalized.startsWith("*.")
    ? host.endsWith(normalized.slice(1)) && host !== normalized.slice(2)
    : host === normalized;
}

export class DynamicSshPolicy {
  constructor({ platform }) { this.platform = platform; }

  async assertAllowed(profile) {
    const configuration = await this.platform.sshRuntimeConfiguration();
    const policy = configuration.networkPolicy;
    const host = String(profile?.host || "").toLowerCase();
    invariant(policy.allowedHosts.length === 0 || policy.allowedHosts.some((pattern) => hostMatches(pattern, host)), "SSH_HOST_FORBIDDEN", "服务器地址不在管理员允许范围内", { status: 403 });
    const method = String(profile?.authMethod || "");
    invariant((method !== "private-key" || configuration.transport.allowPrivateKeyAuth) && (method !== "password" || configuration.transport.allowPasswordAuth), "SSH_AUTH_METHOD_FORBIDDEN", "管理员策略不允许该 SSH 登录方式", { status: 403 });
    return new SshNetworkPolicy(policy).assertAllowed(profile);
  }
}

export class DynamicEmbeddingAdapter {
  constructor({ platform, fetchImpl = globalThis.fetch }) { this.platform = platform; this.fetchImpl = fetchImpl; }

  async assertConfigured() {
    const provider = await this.platform.publicProvider("embedding");
    invariant(provider.configured, "RESOURCE_EMBEDDING_NOT_CONFIGURED", "管理员尚未配置 Embedding 工具，无法建立或检索文件索引", { status: 409, retryable: false });
  }

  async #adapter() {
    await this.assertConfigured();
    const access = await this.platform.resolveProvider("embedding");
    const embedding = access.provider.embedding;
    return new OpenAIEmbeddingAdapter({
      baseUrl: access.credential.baseUrl,
      apiKey: access.credential.apiKey,
      model: embedding.model,
      dimensions: embedding.dimensions,
      batchSize: embedding.batchSize,
      hybridEnabled: embedding.hybridEnabled,
      profileId: access.provider.embeddingProfileId,
      fetchImpl: this.fetchImpl,
    });
  }

  async embed(input) { return (await this.#adapter()).embed(input); }
  async search(input) { return (await this.#adapter()).search(input); }
  async embedTexts(inputs) { return (await this.#adapter()).embedTexts(inputs); }

  async memoryConfiguration() {
    const provider = await this.platform.publicProvider("embedding");
    const memory = provider.embedding?.memory || {};
    return Object.freeze({
      configured: Boolean(provider.configured),
      embeddingProfileId: provider.memoryEmbeddingProfileId || null,
      retrievalProfileId: provider.memoryRetrievalProfileId || null,
      enabled: memory.enabled !== false,
      vectorWeight: Number(memory.vectorWeight ?? 0.55),
      lexicalWeight: Number(memory.lexicalWeight ?? 0.15),
      titleWeight: Number(memory.titleWeight ?? 0.3),
      minimumScore: Number(memory.minimumScore ?? 0.12),
      diversityLambda: Number(memory.diversityLambda ?? 0.72),
      recallLimit: Number(memory.recallLimit ?? 48),
      resultLimit: Number(memory.resultLimit ?? 8),
      tokenBudget: Number(memory.tokenBudget ?? 3200),
      pageSize: Number(memory.pageSize ?? 20),
    });
  }
}

export class DynamicOcrAdapter {
  constructor({ platform, prompts, fetchImpl = globalThis.fetch }) {
    this.platform = platform;
    this.prompts = prompts;
    this.fetchImpl = fetchImpl;
  }

  async assertConfigured() {
    const provider = await this.platform.publicProvider("ocr");
    invariant(provider.configured, "RESOURCE_OCR_NOT_CONFIGURED", "管理员尚未配置 OCR 工具，无法解析图片或扫描 PDF", { status: 409, retryable: false });
  }

  async #adapter() {
    await this.assertConfigured();
    const access = await this.platform.resolveProvider("ocr");
    if (access.credential.protocol === "mineru") {
      return new MinerUOcrAdapter({
        baseUrl: access.credential.baseUrl,
        apiKey: access.credential.apiKey,
        fetchImpl: this.fetchImpl,
      });
    }
    return new OpenAIOcrAdapter({
      baseUrl: access.credential.baseUrl,
      apiKey: access.credential.apiKey,
      model: access.provider.ocr.model,
      maxOutputTokens: access.provider.ocr.maxOutputTokens,
      systemPrompt: await this.prompts.ocrExtraction(),
      inputPrompt: (label) => this.prompts.ocrInput(label),
      fetchImpl: this.fetchImpl,
    });
  }

  async extract(input) { return (await this.#adapter()).extract(input); }
}

export class DynamicResourceExtractor {
  constructor({ platform, prompts, fetchImpl = globalThis.fetch, ocrExtractor = null, visionExtractor = null }) {
    this.platform = platform;
    this.ocrExtractor = ocrExtractor || visionExtractor || new DynamicOcrAdapter({ platform, prompts, fetchImpl });
  }

  async #extractor() {
    const provider = await this.platform.publicProvider("embedding");
    const settings = provider.embedding || {};
    return new DefaultResourceExtractor({
      ocrExtractor: this.ocrExtractor,
      maxCharacters: settings.chunkSize || 3_000,
      overlapCharacters: settings.chunkOverlap || 600,
    });
  }

  async preflight(input) { return (await this.#extractor()).preflight(input); }

  async extract(input) {
    return (await this.#extractor()).extract(input);
  }
}

export class UnavailableAgentTransport {
  async execute() {
    throw new ApiError("AGENT_TRANSPORT_UNAVAILABLE", "当前 Gateway 未配置远端 Agent transport", { status: 503, retryable: true });
  }
}

export class OrchestratorWorkspaceAdapter {
  constructor({ workspaceFactory }) { this.workspaceFactory = workspaceFactory; }

  async prepare({ task }) {
    const service = await this.workspaceFactory(task.route.serverId, task.route.serverIdentity);
    const route = await service.getRoute({ conversationId: task.conversationId, branchId: task.branchId });
    invariant(route && route.binding.workspaceId === task.route.workspaceId && route.binding.agentId === task.route.agentId, "TASK_WORKSPACE_ROUTE_MISMATCH", "Task 工作区路由已经变化", { status: 409 });
    const workspace = route.workspace;
    invariant(workspace.id === task.route.workspaceId && workspace.serverIdentity === task.route.serverIdentity, "TASK_WORKSPACE_SERVER_MISMATCH", "Task 工作区不属于目标服务器", { status: 409 });
    invariant(route.binding.versionDomainId, "TASK_VERSION_DOMAIN_MISSING", "当前工作区绑定缺少版本账本", { status: 409 });
    return { ...workspace, versionDomainId: route.binding.versionDomainId, workspaceBindingId: route.binding.id, path: workspace.canonicalPath };
  }

  async finalize() {}
}

function eventOperationId(event) {
  const source = event?.source && typeof event.source === "object" ? event.source : {};
  const raw = source.itemId || source.requestId || source.id;
  return raw == null || raw === "" ? null : `op_${crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 24)}`;
}

export class OrchestratorVersionAdapter {
  constructor({ versionFactory, workspaceFactory }) {
    this.versionFactory = versionFactory;
    this.workspaceFactory = workspaceFactory;
    this.active = new Map();
  }

  async prepare({ task, workspace }) {
    const service = await this.versionFactory(task.route.serverId, task.route.serverIdentity);
    if (!workspace.versionDomainId) {
      this.active.set(task.id, { managed: false, workspace });
      return { managed: false, workspaceId: workspace.id };
    }
    const locator = { actorId: task.actorId, serverIdentity: task.route.serverIdentity, versionDomainId: workspace.versionDomainId };
    let state = null;
    try {
      state = await service.getDomain(locator);
    } catch (error) {
      if (error?.code !== "VERSION_DOMAIN_NOT_FOUND") throw error;
    }
    const branch = state?.branches?.[task.branchId] || null;
    // The ledger records this web conversation's history; it is not an Agent
    // filesystem view. Normal Tasks therefore use the shared workspace exactly
    // as it currently exists. Only an explicit branch/rewind/regenerate command
    // is allowed to materialize an older checkpoint into that shared directory.
    this.active.set(task.id, {
      managed: true,
      service,
      locator,
      workspace,
      beforeCheckpointId: task.versionCheckpointId || null,
      operationIds: new Set(),
    });
    return {
      managed: true,
      versionDomainId: workspace.versionDomainId,
      revision: state?.revision ?? null,
      headCheckpointId: branch?.headCheckpointId || null,
    };
  }

  async #ensureTransaction(active, task) {
    if (active.beforeCheckpointId) return active.beforeCheckpointId;
    const ensured = await active.service.ensureConversationDomain({
      actorId: task.actorId,
      serverIdentity: task.route.serverIdentity,
      conversationId: task.conversationId,
      workspaceId: active.workspace.id,
      rootPath: active.workspace.canonicalPath || active.workspace.path,
      mode: active.workspace.kind === "user" ? "real" : "virtual",
    });
    invariant(ensured.state.versionDomainId === active.locator.versionDomainId, "TASK_VERSION_DOMAIN_MISMATCH", "Task 版本账本与当前网页对话不一致", { status: 409 });
    const beforeCheckpointId = `checkpoint_${task.id}_before`;
    const beforeCheckpoint = await active.service.beginTask(active.locator, {
      taskId: task.id,
      branchId: task.branchId,
      conversationId: task.conversationId,
      agentId: task.route.agentId,
      agentBindingId: task.agentBindingId,
      workspaceId: active.workspace.id,
      beforeCheckpointId,
      message: `Task ${task.id} 开始前`,
    });
    active.beforeCheckpointId = beforeCheckpoint.id;
    return beforeCheckpoint.id;
  }

  async recordFileChange({ task, event }) {
    const active = this.active.get(task.id);
    if (!active) return { managed: false };
    if (active.managed === false) return { managed: false };
    if (event?.kind !== "file_change" || event?.phase !== "completed") return { managed: true, staged: 0 };
    const operationId = eventOperationId(event);
    if (!operationId || active.operationIds.has(operationId)) return { managed: true, staged: 0 };
    // The native hook has already captured the preimage before the Agent was
    // allowed to mutate the path. Fold all operations into one task mutation
    // at finish instead of writing the ledger once per tool event.
    // Writing the ledger once per tool event only inflated SSH latency.
    active.operationIds.add(operationId);
    const beforeCheckpointId = await this.#ensureTransaction(active, task);
    return { managed: true, staged: 0, recorded: true, beforeCheckpointId };
  }

  async finalize({ task }) {
    let active = this.active.get(task.id) || null;
    try {
      if (active?.managed === false) return { taskId: task.id, managed: false, finalized: true };
      if (!active) {
        const service = await this.versionFactory(task.route.serverId, task.route.serverIdentity);
        const workspaces = await this.workspaceFactory(task.route.serverId, task.route.serverIdentity);
        const route = await workspaces.getRoute({ conversationId: task.conversationId, branchId: task.branchId });
        if (!route?.binding.versionDomainId) return { taskId: task.id, managed: false, finalized: true };
        active = {
          managed: true,
          service,
          locator: { actorId: task.actorId, serverIdentity: task.route.serverIdentity, versionDomainId: route.binding.versionDomainId },
          workspace: route.workspace || { id: route.binding.workspaceId, path: task.workspacePath },
          beforeCheckpointId: task.versionCheckpointId || null,
          operationIds: new Set(),
        };
      }
      if (!active.beforeCheckpointId) {
        const operationCount = await active.service.agentOperationCount(active.locator, {
          taskId: task.id,
          agentId: task.route.agentId,
          agentBindingId: task.agentBindingId,
        });
        if (operationCount === 0) {
          return { taskId: task.id, managed: true, finalized: true, beforeCheckpointId: null, afterCheckpointId: null, afterCheckpoint: null };
        }
        await this.#ensureTransaction(active, task);
      }
      const afterCheckpointId = `checkpoint_${task.id}_after`;
      let afterCheckpoint;
      try {
        afterCheckpoint = await active.service.finishTask(active.locator, { taskId: task.id, afterCheckpointId, message: `Task ${task.id} 结束后` });
      } catch (error) {
        if (error?.code !== "VERSION_TASK_TRANSACTION_NOT_FOUND") throw error;
        const state = await active.service.getDomain(active.locator);
        afterCheckpoint = state.checkpoints.find((entry) => entry.id === afterCheckpointId) || null;
        const beforeCheckpoint = state.checkpoints.find((entry) => entry.id === active.beforeCheckpointId) || null;
        if (!afterCheckpoint && beforeCheckpoint) throw error;
      }
      return {
        taskId: task.id,
        managed: true,
        finalized: true,
        beforeCheckpointId: afterCheckpoint ? active.beforeCheckpointId : null,
        afterCheckpointId: afterCheckpoint ? afterCheckpointId : null,
        afterCheckpoint,
      };
    } finally {
      this.active.delete(task.id);
    }
  }

  async abandon(taskId) {
    this.active.delete(String(taskId));
  }
}

export function unavailableRemoteFactory(feature) {
  return async () => {
    throw new ApiError("REMOTE_CAPABILITY_UNAVAILABLE", `${feature} 尚未接入当前 SSH transport`, { status: 503, retryable: true });
  };
}
