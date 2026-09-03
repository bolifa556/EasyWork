import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { requireAuthenticatedActor, requireRole } from "../actor.mjs";
import { ApiError, invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import {
  PLATFORM_PROVIDER_IDS,
  PLATFORM_SCHEMA_VERSION,
  assertCommandId,
  assertProviderId,
  assertProviderPurpose,
  defaultSshPolicy,
  normalizeBaseUrl,
  normalizeEmbeddingSettings,
  normalizeOcrSettings,
  normalizeProtocol,
  normalizeProviderName,
  normalizeSshPolicy,
  sshRuntimeConfiguration,
  stableFingerprint,
} from "./contract.mjs";
import { PlatformJsonRepository } from "./store.mjs";
import { ProviderSecretVault, normalizeApiKey } from "./vault.mjs";

const MAX_COMMANDS = 4096;
const USER_PROVIDER_STORE_SCHEMA_VERSION = 1;
const USAGE_STORE_SCHEMA_VERSION = 1;
const USAGE_METRICS = Object.freeze(["requests", "inputTokens", "outputTokens", "embeddingTokens", "errors", "latencyMs"]);

function clone(value) {
  return structuredClone(value);
}

function nowIso(clock) {
  const value = clock();
  invariant(value instanceof Date && Number.isFinite(value.getTime()), "PLATFORM_CLOCK_INVALID", "平台服务 clock 无效", { status: 500, expose: false });
  return value.toISOString();
}

function exactKeys(input, allowed, operation) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "PLATFORM_INPUT_INVALID", `${operation} 参数无效`, { status: 400 });
  const names = Object.keys(input);
  invariant(names.every((name) => allowed.includes(name)), "PLATFORM_INPUT_SCHEMA_INVALID", `${operation} 参数不符合 EasyWork 协议`, {
    status: 400,
    details: { allowed },
  });
}

function trimCommands(commands) {
  const entries = Object.entries(commands || {});
  if (entries.length <= MAX_COMMANDS) return commands;
  return Object.fromEntries(entries.slice(-MAX_COMMANDS));
}

function platformProvider(purpose) {
  return {
    id: PLATFORM_PROVIDER_IDS[purpose],
    scope: "platform",
    purpose,
    name: purpose === "web" ? "网页公共 API" : purpose === "agent" ? "Agent 公共 API" : purpose === "embedding" ? "Embedding API" : "OCR API",
    baseUrl: "",
    protocol: purpose === "embedding" ? "openai-embeddings" : purpose === "ocr" ? "chat-completions" : "auto",
    sealedKey: null,
    embedding: purpose === "embedding" ? clone(normalizeEmbeddingSettings()) : null,
    ocr: purpose === "ocr" ? clone(normalizeOcrSettings()) : null,
    updatedAt: null,
  };
}

function defaultPlatformData() {
  return {
    providers: {
      web: platformProvider("web"),
      agent: platformProvider("agent"),
      embedding: platformProvider("embedding"),
      ocr: platformProvider("ocr"),
    },
    ssh: defaultSshPolicy(),
    commands: {},
  };
}

function validSealed(value) {
  return value === null || (
    value?.version === 1
    && typeof value.iv === "string"
    && typeof value.ciphertext === "string"
    && typeof value.tag === "string"
  );
}

function validatePlatformData(value) {
  invariant(value && typeof value === "object" && value.providers && value.ssh && value.commands, "PLATFORM_STORE_INVALID", "平台配置结构无效", {
    status: 500,
    expose: false,
  });
  for (const purpose of ["web", "agent", "embedding"]) {
    const provider = value.providers[purpose];
    invariant(provider?.id === PLATFORM_PROVIDER_IDS[purpose] && provider.scope === "platform" && provider.purpose === purpose && validSealed(provider.sealedKey), "PLATFORM_STORE_INVALID", "平台 Provider 结构无效", {
      status: 500,
      expose: false,
    });
    normalizeProtocol(provider.protocol, purpose);
  }
  if (value.providers.ocr) {
    const provider = value.providers.ocr;
    invariant(provider.id === PLATFORM_PROVIDER_IDS.ocr && provider.scope === "platform" && provider.purpose === "ocr" && validSealed(provider.sealedKey), "PLATFORM_STORE_INVALID", "平台 OCR Provider 结构无效", {
      status: 500,
      expose: false,
    });
    normalizeProtocol(provider.protocol, "ocr");
    normalizeOcrSettings(provider.ocr);
  }
  normalizeSshPolicy(value.ssh);
  return true;
}

function providerConfigured(record, apiKey) {
  if (!record.baseUrl || !apiKey) return false;
  return !["embedding", "ocr"].includes(record.purpose) || Boolean(record[record.purpose]?.model);
}

function providerPublic(record, vault, revision) {
  const key = vault.describe(record.sealedKey, record.id);
  const result = {
    schemaVersion: PLATFORM_SCHEMA_VERSION,
    revision,
    id: record.id,
    scope: record.scope,
    purpose: record.purpose,
    name: record.name,
    baseUrl: record.baseUrl,
    protocol: record.protocol,
    configured: providerConfigured(record, key.hasKey),
    hasKey: key.hasKey,
    maskedKey: key.maskedKey,
    updatedAt: record.updatedAt,
  };
  if (record.audience) result.audience = record.audience;
  if (record.purpose === "embedding") {
    result.embedding = clone(record.embedding);
    result.embeddingProfileId = record.baseUrl && record.embedding?.model
      ? `emb_${stableFingerprint({ baseUrl: record.baseUrl, protocol: record.protocol, ...record.embedding }).slice(0, 24)}`
      : null;
  }
  if (record.purpose === "ocr") result.ocr = clone(record.ocr);
  return Object.freeze(result);
}

function platformRecord(data, purpose) {
  return data.providers[purpose] || platformProvider(purpose);
}

function commandFingerprint(operation, payload) {
  return stableFingerprint({ operation, payload });
}

function existingCommand(commands, commandId, fingerprint) {
  const previous = commands?.[commandId];
  if (!previous) return null;
  invariant(previous.fingerprint === fingerprint, "COMMAND_ID_REUSED", "commandId 已用于不同的平台变更", { status: 409 });
  return clone(previous.result);
}

function commandEntry(fingerprint, result, occurredAt) {
  return { fingerprint, result: clone(result), occurredAt };
}

export class PlatformConfigurationService {
  constructor({ dataRoot, masterSecret, clock = () => new Date(), queue } = {}) {
    invariant(path.isAbsolute(dataRoot || ""), "PLATFORM_DATA_ROOT_INVALID", "PlatformConfigurationService 需要绝对 dataRoot", { status: 500, expose: false });
    this.dataRoot = path.resolve(dataRoot);
    this.clock = clock;
    this.vault = new ProviderSecretVault({ masterSecret, scope: "platform:global" });
    this.repository = new PlatformJsonRepository({
      dataRoot: this.dataRoot,
      relativePath: ["settings.json"],
      schemaVersion: PLATFORM_SCHEMA_VERSION,
      defaultData: defaultPlatformData,
      validate: validatePlatformData,
      queue,
      queueKey: "settings",
    });
  }

  async #snapshot() {
    const envelope = await this.repository.read();
    return {
      schemaVersion: PLATFORM_SCHEMA_VERSION,
      revision: envelope.revision,
      updatedAt: envelope.updatedAt,
      providers: Object.fromEntries(["web", "agent", "embedding", "ocr"].map((purpose) => [
        purpose,
        providerPublic(platformRecord(envelope.data, purpose), this.vault, envelope.revision),
      ])),
      ssh: clone(normalizeSshPolicy(envelope.data.ssh)),
    };
  }

  async inspect(actor) {
    requireRole(actor, "admin");
    return this.#snapshot();
  }

  async publicProvider(purposeInput) {
    const purpose = assertProviderPurpose(purposeInput);
    const envelope = await this.repository.read();
    return providerPublic(platformRecord(envelope.data, purpose), this.vault, envelope.revision);
  }

  async publicProviders(purposeInput = null) {
    const purposes = purposeInput === null ? ["web", "agent", "embedding", "ocr"] : [assertProviderPurpose(purposeInput)];
    const envelope = await this.repository.read();
    return purposes.map((purpose) => providerPublic(platformRecord(envelope.data, purpose), this.vault, envelope.revision));
  }

  async resolveProvider(purposeInput) {
    const purpose = assertProviderPurpose(purposeInput);
    const envelope = await this.repository.read();
    const record = platformRecord(envelope.data, purpose);
    const apiKey = record.sealedKey ? this.vault.open(record.sealedKey, record.id) : "";
    invariant(providerConfigured(record, apiKey), "PLATFORM_PROVIDER_NOT_CONFIGURED", `平台 ${purpose} Provider 尚未配置`, { status: 409 });
    return Object.freeze({
      provider: providerPublic(record, this.vault, envelope.revision),
      credential: Object.freeze({ baseUrl: record.baseUrl, apiKey, protocol: record.protocol }),
    });
  }

  async revealProvider(actor, purposeInput) {
    requireRole(actor, "admin");
    const purpose = assertProviderPurpose(purposeInput);
    const envelope = await this.repository.read();
    const record = platformRecord(envelope.data, purpose);
    invariant(record?.sealedKey, "PROVIDER_API_KEY_NOT_CONFIGURED", "当前平台 API 尚未保存 Key", { status: 409 });
    const apiKey = this.vault.open(record.sealedKey, record.id);
    return Object.freeze({
      providerId: record.id,
      apiKey,
      expiresAt: new Date(this.clock().getTime() + 30_000).toISOString(),
    });
  }

  async updateProvider(actor, input) {
    requireRole(actor, "admin");
    exactKeys(input, ["purpose", "patch", "apiKey", "clearApiKey", "expectedRevision", "commandId"], "更新平台 Provider");
    const purpose = assertProviderPurpose(input.purpose);
    const commandId = assertCommandId(input.commandId);
    invariant(!(Object.hasOwn(input, "apiKey") && input.clearApiKey), "PROVIDER_KEY_UPDATE_INVALID", "不能同时设置和清除 API Key", { status: 400 });
    const patch = input.patch || {};
    const allowedPatch = purpose === "embedding"
      ? ["name", "baseUrl", "protocol", "model", "dimensions", "chunkStrategy", "chunkSize", "chunkOverlap", "batchSize", "hybridEnabled"]
      : purpose === "ocr"
        ? ["name", "baseUrl", "protocol", "model", "maxOutputTokens"]
        : ["name", "baseUrl", "protocol"];
    exactKeys(patch, allowedPatch, "更新平台 Provider patch");
    const secretDigest = Object.hasOwn(input, "apiKey") ? stableFingerprint(normalizeApiKey(input.apiKey)) : null;
    const fingerprint = commandFingerprint(`provider:${purpose}`, { patch, secretDigest, clearApiKey: Boolean(input.clearApiKey) });
    const before = await this.repository.read();
    const replay = existingCommand(before.data.commands, commandId, fingerprint);
    if (replay) return { ...replay, replayed: true };
    try {
      const envelope = await this.repository.update((data, transaction) => {
        const duplicate = existingCommand(data.commands, commandId, fingerprint);
        if (duplicate) return data;
        const current = platformRecord(data, purpose);
        const baseUrl = Object.hasOwn(patch, "baseUrl")
          ? (String(patch.baseUrl || "").trim() ? normalizeBaseUrl(patch.baseUrl) : "")
          : current.baseUrl;
        const next = {
          ...current,
          name: Object.hasOwn(patch, "name") ? normalizeProviderName(patch.name, current.name) : current.name,
          baseUrl,
          protocol: Object.hasOwn(patch, "protocol") ? normalizeProtocol(patch.protocol, purpose) : current.protocol,
          sealedKey: Object.hasOwn(input, "apiKey")
            ? this.vault.seal(input.apiKey, current.id)
            : input.clearApiKey ? null : current.sealedKey,
          updatedAt: nowIso(this.clock),
        };
        if (purpose === "embedding") next.embedding = clone(normalizeEmbeddingSettings({ ...current.embedding, ...patch }));
        if (purpose === "ocr") next.ocr = clone(normalizeOcrSettings({ ...current.ocr, ...patch }));
        data.providers[purpose] = next;
        const result = {
          revision: transaction.nextRevision,
          provider: providerPublic(next, this.vault, transaction.nextRevision),
        };
        data.commands[commandId] = commandEntry(fingerprint, result, next.updatedAt);
        data.commands = trimCommands(data.commands);
      }, { expectedRevision: input.expectedRevision, clock: this.clock });
      return { ...envelope.data.commands[commandId].result, replayed: false };
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT") throw error;
      const latest = await this.repository.read();
      const concurrentReplay = existingCommand(latest.data.commands, commandId, fingerprint);
      if (concurrentReplay) return { ...concurrentReplay, replayed: true };
      throw error;
    }
  }

  async updateSshPolicy(actor, input) {
    requireRole(actor, "admin");
    exactKeys(input, ["policy", "expectedRevision", "commandId"], "更新 SSH 平台策略");
    const commandId = assertCommandId(input.commandId);
    const policy = normalizeSshPolicy(input.policy);
    const fingerprint = commandFingerprint("ssh-policy", policy);
    const before = await this.repository.read();
    const replay = existingCommand(before.data.commands, commandId, fingerprint);
    if (replay) return { ...replay, replayed: true };
    try {
      const envelope = await this.repository.update((data, transaction) => {
        if (existingCommand(data.commands, commandId, fingerprint)) return data;
        data.ssh = clone(policy);
        const result = { revision: transaction.nextRevision, ssh: clone(policy) };
        data.commands[commandId] = commandEntry(fingerprint, result, nowIso(this.clock));
        data.commands = trimCommands(data.commands);
      }, { expectedRevision: input.expectedRevision, clock: this.clock });
      return { ...envelope.data.commands[commandId].result, replayed: false };
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT") throw error;
      const latest = await this.repository.read();
      const concurrentReplay = existingCommand(latest.data.commands, commandId, fingerprint);
      if (concurrentReplay) return { ...concurrentReplay, replayed: true };
      throw error;
    }
  }

  async sshRuntimeConfiguration() {
    const envelope = await this.repository.read();
    return sshRuntimeConfiguration(envelope.data.ssh);
  }
}

function defaultUserProviders() {
  return { providers: [], commands: {} };
}

function validateUserProviders(value) {
  invariant(value && Array.isArray(value.providers) && value.commands && typeof value.commands === "object", "USER_PROVIDER_STORE_INVALID", "用户 Provider 数据无效", {
    status: 500,
    expose: false,
  });
  for (const provider of value.providers) {
    assertProviderId(provider?.id);
    invariant(provider.scope === "actor" && validSealed(provider.sealedKey), "USER_PROVIDER_STORE_INVALID", "用户 Provider 记录无效", {
      status: 500,
      expose: false,
    });
  }
  return true;
}

function userProviderPurposeCompatible(provider, purpose) {
  return !["embedding", "ocr"].includes(purpose) && provider.scope === "actor";
}

function deterministicProviderId(actor, commandId) {
  return `provider_${crypto.createHash("sha256").update(`${actor.actorType}:${actor.actorId}:${commandId}`).digest("hex").slice(0, 24)}`;
}

function normalizeUserProviderPatch(patch, current = null) {
  exactKeys(patch, ["name", "baseUrl", "protocol"], "用户 Provider patch");
  return {
    name: Object.hasOwn(patch, "name") ? normalizeProviderName(patch.name, current?.name) : current?.name || "模型 API",
    baseUrl: Object.hasOwn(patch, "baseUrl")
      ? (String(patch.baseUrl || "").trim() ? normalizeBaseUrl(patch.baseUrl) : "")
      : current?.baseUrl || "",
    protocol: Object.hasOwn(patch, "protocol") ? normalizeProtocol(patch.protocol, "web") : current?.protocol || "auto",
  };
}

export class ProviderService {
  constructor({ dataRoot, masterSecret, platform, detector, clock = () => new Date(), idFactory, queue, detectionCacheTtlMs = 2 * 60_000 } = {}) {
    invariant(path.isAbsolute(dataRoot || "") && platform instanceof PlatformConfigurationService, "PROVIDER_SERVICE_DEPENDENCY_INVALID", "ProviderService 缺少平台配置依赖", {
      status: 500,
      expose: false,
    });
    this.dataRoot = path.resolve(dataRoot);
    this.masterSecret = masterSecret;
    this.platform = platform;
    this.detector = detector || new OpenAICompatibleModelDetector();
    this.clock = clock;
    this.idFactory = idFactory || deterministicProviderId;
    this.queue = queue;
    this.detectionCacheTtlMs = Math.max(0, Number(detectionCacheTtlMs) || 0);
    this.detectionCache = new Map();
  }

  async #detect({ baseUrl, apiKey, purpose, signal }) {
    const key = stableFingerprint({ baseUrl, apiKey, purpose });
    const now = this.clock().getTime();
    const cached = this.detectionCache.get(key);
    if (cached && cached.expiresAt > now) return clone(await cached.promise);
    if (cached) this.detectionCache.delete(key);

    const promise = Promise.resolve(this.detector.detect({ baseUrl, apiKey, purpose, signal }));
    this.detectionCache.set(key, { expiresAt: now + this.detectionCacheTtlMs, promise });
    while (this.detectionCache.size > 64) this.detectionCache.delete(this.detectionCache.keys().next().value);
    try {
      const detected = await promise;
      return clone(detected);
    } catch (error) {
      if (this.detectionCache.get(key)?.promise === promise) this.detectionCache.delete(key);
      throw error;
    }
  }

  #vault(actor) {
    return new ProviderSecretVault({ masterSecret: this.masterSecret, scope: `${actor.actorType}:${actor.actorId}` });
  }

  #repository(actor) {
    requireAuthenticatedActor(actor);
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor,
      relativePath: ["credentials", "providers.json"],
      schemaVersion: USER_PROVIDER_STORE_SCHEMA_VERSION,
      defaultData: defaultUserProviders,
      validate: validateUserProviders,
      queue: this.queue,
    });
  }

  #publicUser(provider, vault, revision) {
    const key = vault.describe(provider.sealedKey, provider.id);
    return Object.freeze({
      schemaVersion: PLATFORM_SCHEMA_VERSION,
      revision,
      id: provider.id,
      scope: "actor",
      actorType: provider.actorType,
      actorId: provider.actorId,
      audience: "both",
      name: provider.name,
      baseUrl: provider.baseUrl,
      protocol: provider.protocol,
      configured: Boolean(provider.baseUrl && key.hasKey),
      hasKey: key.hasKey,
      maskedKey: key.maskedKey,
      updatedAt: provider.updatedAt,
    });
  }

  async inspectUserProviders(actor) {
    const repository = this.#repository(actor);
    const envelope = await repository.read();
    const vault = this.#vault(actor);
    return { revision: envelope.revision, providers: envelope.data.providers.map((provider) => this.#publicUser(provider, vault, envelope.revision)) };
  }

  async revealUserProvider(actor, providerIdInput) {
    requireAuthenticatedActor(actor);
    const providerId = assertProviderId(providerIdInput);
    const repository = this.#repository(actor);
    const envelope = await repository.read();
    const provider = envelope.data.providers.find((entry) => entry.id === providerId);
    invariant(provider, "PROVIDER_NOT_FOUND", "用户 Provider 不存在", { status: 404 });
    invariant(provider.sealedKey, "PROVIDER_API_KEY_NOT_CONFIGURED", "当前 API 尚未保存 Key", { status: 409 });
    const apiKey = this.#vault(actor).open(provider.sealedKey, provider.id);
    return Object.freeze({
      providerId: provider.id,
      apiKey,
      expiresAt: new Date(this.clock().getTime() + 30_000).toISOString(),
    });
  }

  async createUserProvider(actor, input) {
    requireAuthenticatedActor(actor);
    exactKeys(input, ["provider", "apiKey", "expectedRevision", "commandId"], "创建用户 Provider");
    const commandId = assertCommandId(input.commandId);
    const normalized = normalizeUserProviderPatch(input.provider || {});
    const apiKey = Object.hasOwn(input, "apiKey") ? normalizeApiKey(input.apiKey) : "";
    const providerId = assertProviderId(this.idFactory(actor, commandId));
    const fingerprint = commandFingerprint("user-provider:create", { normalized, secretDigest: apiKey ? stableFingerprint(apiKey) : null });
    const repository = this.#repository(actor);
    const vault = this.#vault(actor);
    const before = await repository.read();
    const replay = existingCommand(before.data.commands, commandId, fingerprint);
    if (replay) return { ...replay, replayed: true };
    try {
      const envelope = await repository.update((data) => {
        invariant(!data.providers.some((provider) => provider.id === providerId), "PROVIDER_EXISTS", "Provider 已存在", { status: 409 });
        const updatedAt = nowIso(this.clock);
        const provider = {
          id: providerId,
          scope: "actor",
          actorType: actor.actorType,
          actorId: actor.actorId,
          ...normalized,
          sealedKey: apiKey ? vault.seal(apiKey, providerId) : null,
          createdAt: updatedAt,
          updatedAt,
        };
        data.providers.push(provider);
        const result = { revision: before.revision + 1, provider: this.#publicUser(provider, vault, before.revision + 1) };
        data.commands[commandId] = commandEntry(fingerprint, result, updatedAt);
        data.commands = trimCommands(data.commands);
      }, { expectedRevision: input.expectedRevision, clock: this.clock });
      return { ...envelope.data.commands[commandId].result, replayed: false };
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT") throw error;
      const latest = await repository.read();
      const concurrentReplay = existingCommand(latest.data.commands, commandId, fingerprint);
      if (concurrentReplay) return { ...concurrentReplay, replayed: true };
      throw error;
    }
  }

  async updateUserProvider(actor, input) {
    requireAuthenticatedActor(actor);
    exactKeys(input, ["providerId", "patch", "apiKey", "clearApiKey", "expectedRevision", "commandId"], "更新用户 Provider");
    const providerId = assertProviderId(input.providerId);
    const commandId = assertCommandId(input.commandId);
    invariant(!(Object.hasOwn(input, "apiKey") && input.clearApiKey), "PROVIDER_KEY_UPDATE_INVALID", "不能同时设置和清除 API Key", { status: 400 });
    const apiKey = Object.hasOwn(input, "apiKey") ? normalizeApiKey(input.apiKey) : "";
    const fingerprint = commandFingerprint("user-provider:update", {
      providerId,
      patch: input.patch || {},
      secretDigest: apiKey ? stableFingerprint(apiKey) : null,
      clearApiKey: Boolean(input.clearApiKey),
    });
    const repository = this.#repository(actor);
    const vault = this.#vault(actor);
    const before = await repository.read();
    const replay = existingCommand(before.data.commands, commandId, fingerprint);
    if (replay) return { ...replay, replayed: true };
    const current = before.data.providers.find((provider) => provider.id === providerId);
    invariant(current, "PROVIDER_NOT_FOUND", "用户 Provider 不存在", { status: 404 });
    const normalized = normalizeUserProviderPatch(input.patch || {}, current);
    try {
      const envelope = await repository.update((data) => {
        const index = data.providers.findIndex((provider) => provider.id === providerId);
        invariant(index >= 0, "PROVIDER_NOT_FOUND", "用户 Provider 不存在", { status: 404 });
        const updatedAt = nowIso(this.clock);
        const provider = {
          ...data.providers[index],
          ...normalized,
          sealedKey: apiKey ? vault.seal(apiKey, providerId) : input.clearApiKey ? null : data.providers[index].sealedKey,
          updatedAt,
        };
        delete provider.audience;
        data.providers[index] = provider;
        const result = { revision: before.revision + 1, provider: this.#publicUser(provider, vault, before.revision + 1) };
        data.commands[commandId] = commandEntry(fingerprint, result, updatedAt);
        data.commands = trimCommands(data.commands);
      }, { expectedRevision: input.expectedRevision, clock: this.clock });
      return { ...envelope.data.commands[commandId].result, replayed: false };
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT") throw error;
      const latest = await repository.read();
      const concurrentReplay = existingCommand(latest.data.commands, commandId, fingerprint);
      if (concurrentReplay) return { ...concurrentReplay, replayed: true };
      throw error;
    }
  }

  async deleteUserProvider(actor, input) {
    requireAuthenticatedActor(actor);
    exactKeys(input, ["providerId", "expectedRevision", "commandId"], "删除用户 Provider");
    const providerId = assertProviderId(input.providerId);
    const commandId = assertCommandId(input.commandId);
    const fingerprint = commandFingerprint("user-provider:delete", { providerId });
    const repository = this.#repository(actor);
    const before = await repository.read();
    const replay = existingCommand(before.data.commands, commandId, fingerprint);
    if (replay) return { ...replay, replayed: true };
    invariant(before.data.providers.some((provider) => provider.id === providerId), "PROVIDER_NOT_FOUND", "用户 Provider 不存在", { status: 404 });
    try {
      const envelope = await repository.update((data) => {
        data.providers = data.providers.filter((provider) => provider.id !== providerId);
        const result = { revision: before.revision + 1, deletedProviderId: providerId };
        data.commands[commandId] = commandEntry(fingerprint, result, nowIso(this.clock));
        data.commands = trimCommands(data.commands);
      }, { expectedRevision: input.expectedRevision, clock: this.clock });
      return { ...envelope.data.commands[commandId].result, replayed: false };
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT") throw error;
      const latest = await repository.read();
      const concurrentReplay = existingCommand(latest.data.commands, commandId, fingerprint);
      if (concurrentReplay) return { ...concurrentReplay, replayed: true };
      throw error;
    }
  }

  async listAvailableProviders(actor, purposeInput) {
    const purpose = assertProviderPurpose(purposeInput);
    if (["embedding", "ocr"].includes(purpose)) {
      const provider = await this.platform.publicProvider(purpose);
      return provider.configured ? [provider] : [];
    }
    const platform = await this.platform.publicProvider(purpose);
    const providers = platform.configured ? [platform] : [];
    if (actor?.actorType !== "user") return providers;
    const inspected = await this.inspectUserProviders(actor);
    return providers.concat(inspected.providers.filter((provider) => provider.configured && userProviderPurposeCompatible(provider, purpose)));
  }

  async resolve(actor, input) {
    exactKeys(input, ["providerId", "purpose", "modelId", "requireModel"], "解析 Provider");
    const purpose = assertProviderPurpose(input.purpose);
    const providerId = assertProviderId(input.providerId);
    const modelId = String(input.modelId || "").trim();
    if (Object.values(PLATFORM_PROVIDER_IDS).includes(providerId)) {
      invariant(providerId === PLATFORM_PROVIDER_IDS[purpose], "PROVIDER_PURPOSE_MISMATCH", "平台 Provider 与用途不匹配", { status: 409 });
      const access = await this.platform.resolveProvider(purpose);
      const model = ["embedding", "ocr"].includes(purpose) ? access.provider[purpose].model : modelId;
      invariant(!input.requireModel || model, "PROVIDER_MODEL_REQUIRED", "请选择模型", { status: 409 });
      return Object.freeze({ ...access, model });
    }
    invariant(purpose !== "embedding", "EMBEDDING_PLATFORM_ONLY", "Embedding 只能使用管理员配置", { status: 403 });
    invariant(purpose !== "ocr", "OCR_PLATFORM_ONLY", "OCR 只能使用管理员配置", { status: 403 });
    requireAuthenticatedActor(actor);
    const repository = this.#repository(actor);
    const envelope = await repository.read();
    const provider = envelope.data.providers.find((entry) => entry.id === providerId);
    invariant(provider && userProviderPurposeCompatible(provider, purpose), "PROVIDER_NOT_FOUND", "当前用途下找不到该 Provider", { status: 404 });
    const vault = this.#vault(actor);
    const apiKey = provider.sealedKey ? vault.open(provider.sealedKey, provider.id) : "";
    invariant(provider.baseUrl && apiKey, "PROVIDER_NOT_CONFIGURED", "用户 Provider 尚未配置完成", { status: 409 });
    invariant(!input.requireModel || modelId, "PROVIDER_MODEL_REQUIRED", "请选择模型", { status: 409 });
    return Object.freeze({
      provider: this.#publicUser(provider, vault, envelope.revision),
      credential: Object.freeze({ baseUrl: provider.baseUrl, apiKey, protocol: provider.protocol }),
      model: modelId,
    });
  }

  async detectModels(actor, input) {
    exactKeys(input, ["providerId", "purpose", "signal"], "检测 Provider 模型");
    const purpose = assertProviderPurpose(input.purpose);
    if (["embedding", "ocr"].includes(purpose)) requireRole(actor, "admin");
    const access = await this.resolve(actor, { providerId: input.providerId, purpose, modelId: "", requireModel: false });
    const detected = await this.#detect({
      baseUrl: access.credential.baseUrl,
      apiKey: access.credential.apiKey,
      purpose,
      signal: input.signal,
    });
    return {
      provider: access.provider,
      detectedAt: nowIso(this.clock),
      models: normalizedDetectedModels(detected, purpose),
    };
  }

  async detectModelsFromDraft(actor, input) {
    exactKeys(input, ["purpose", "baseUrl", "apiKey", "signal"], "检测未保存 Provider 模型");
    const purpose = assertProviderPurpose(input.purpose);
    requireRole(actor, "admin");
    const detected = await this.#detect({
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: normalizeApiKey(input.apiKey),
      purpose,
      signal: input.signal,
    });
    return {
      provider: null,
      detectedAt: nowIso(this.clock),
      models: normalizedDetectedModels(detected, purpose),
    };
  }
}

function triState(value) {
  return typeof value === "boolean" ? value : null;
}

function modelPurposes(model) {
  if (Array.isArray(model.purposes)) {
    const declared = [...new Set(model.purposes.map(assertProviderPurpose))];
    if (declared.length > 0) return declared;
  }
  const id = String(model.id || "");
  const type = String(model.type || model.objectType || "").toLowerCase();
  const embedding = model.capabilities?.embeddings === true || /(^|[-_.])(embed|embedding|bge|e5|gte|nomic|jina)([-_.]|$)/i.test(id) || type.includes("embedding");
  if (embedding) return ["embedding"];
  const nonText = /(image|audio|whisper|tts|moderation|realtime|transcri)/i.test(`${id} ${type}`);
  if (nonText) return [];
  const purposes = ["web", "agent"];
  const vision = model.capabilities?.vision === true || model.supports_vision === true || /(^|[-_.])(vision|ocr|vl|gpt-4o|gemini|claude)([-_.]|$)/i.test(id);
  if (vision) purposes.push("ocr");
  return purposes;
}

function normalizeModelDescriptor(model) {
  const source = typeof model === "string" ? { id: model } : model;
  invariant(source && typeof source === "object" && typeof source.id === "string" && source.id.trim(), "PROVIDER_MODEL_DESCRIPTOR_INVALID", "模型描述无效", {
    status: 502,
  });
  const capabilities = source.capabilities && typeof source.capabilities === "object" ? source.capabilities : {};
  return Object.freeze({
    id: source.id.trim(),
    name: String(source.name || source.id).trim(),
    ownedBy: source.owned_by == null && source.ownedBy == null ? null : String(source.owned_by ?? source.ownedBy),
    contextWindow: Number.isSafeInteger(Number(source.context_window ?? source.contextWindow)) ? Number(source.context_window ?? source.contextWindow) : null,
    outputLimit: Number.isSafeInteger(Number(source.max_output_tokens ?? source.outputLimit)) ? Number(source.max_output_tokens ?? source.outputLimit) : null,
    capabilities: Object.freeze({
      toolCalling: triState(capabilities.toolCalling ?? source.supports_tools),
      reasoning: triState(capabilities.reasoning ?? source.supports_reasoning),
      jsonSchema: triState(capabilities.jsonSchema ?? source.supports_json_schema),
      vision: triState(capabilities.vision ?? source.supports_vision),
      streaming: triState(capabilities.streaming ?? source.supports_streaming),
      usage: triState(capabilities.usage ?? source.supports_usage),
      embeddings: modelPurposes(source).includes("embedding"),
    }),
    purposes: Object.freeze(modelPurposes(source)),
  });
}

function normalizedDetectedModels(detected, purpose) {
  invariant(Array.isArray(detected), "PROVIDER_DETECTION_INVALID_RESPONSE", "模型检测器返回值无效", { status: 502 });
  return [...new Map(detected.map(normalizeModelDescriptor).map((descriptor) => [descriptor.id, descriptor])).values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .filter((descriptor) => descriptor.purposes.includes(purpose));
}

export class OpenAICompatibleModelDetector {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    invariant(typeof fetchImpl === "function", "PROVIDER_FETCH_UNAVAILABLE", "模型检测需要 fetch 实现", { status: 500, expose: false });
    invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "PROVIDER_DETECTION_TIMEOUT_INVALID", "模型检测超时时间无效", { status: 500, expose: false });
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async detect({ baseUrl, apiKey, signal }) {
    const normalizedUrl = normalizeBaseUrl(baseUrl);
    const source = new URL(normalizedUrl);
    const pathname = source.pathname.replace(/\/+$/, "");
    const candidatePaths = pathname.endsWith("/models")
      ? [pathname]
      : /\/v1$/i.test(pathname)
        ? [`${pathname}/models`]
        : pathname === ""
          // Most OpenAI-compatible servers (including vLLM) expose models at
          // /v1/models even when users paste only the service origin. Keep the
          // legacy /models route as a narrow 404/405 fallback.
          ? ["/v1/models", "/models"]
          : [`${pathname}/models`, `${pathname}/v1/models`];
    let response = null;
    let target = null;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    for (const [index, candidatePath] of [...new Set(candidatePaths)].entries()) {
      target = new URL(source);
      target.pathname = candidatePath.replace(/^\/?/, "/");
      try {
        response = await this.fetchImpl(target, {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${normalizeApiKey(apiKey)}` },
          signal: requestSignal,
        });
      } catch (error) {
        const timedOut = timeoutSignal.aborted && !signal?.aborted;
        throw new ApiError(timedOut ? "PROVIDER_DETECTION_TIMEOUT" : "PROVIDER_DETECTION_UNREACHABLE", timedOut
          ? "模型 API 响应超时，请检查地址、网络或服务状态"
          : "无法连接模型 API，请检查地址和网络", {
          status: 502,
          expose: true,
          cause: error,
        });
      }
      if (response?.ok) break;
      const routeMissing = [404, 405].includes(Number(response?.status));
      if (!routeMissing || index === candidatePaths.length - 1) break;
    }
    if (!response?.ok) {
      const upstreamStatus = Number(response?.status) || null;
      const authenticationFailed = [401, 403].includes(upstreamStatus);
      const routeMissing = [404, 405].includes(upstreamStatus);
      throw new ApiError("PROVIDER_DETECTION_FAILED", authenticationFailed
        ? "模型 API 认证失败，请检查 API Key"
        : routeMissing
          ? "未找到模型列表接口，请确认 API URL（通常填写服务根地址或 /v1）"
          : `模型列表接口返回错误${upstreamStatus ? `（HTTP ${upstreamStatus}）` : ""}`, {
        status: 502,
        expose: true,
        details: { upstreamStatus, endpoint: target?.pathname || null },
      });
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw new ApiError("PROVIDER_DETECTION_INVALID_RESPONSE", "模型列表接口未返回有效 JSON", { status: 502, expose: true, cause: error });
    }
    const models = Array.isArray(body) ? body : body?.data;
    invariant(Array.isArray(models), "PROVIDER_DETECTION_INVALID_RESPONSE", "模型列表接口结构无效", { status: 502, expose: true });
    return [...new Map(models.map(normalizeModelDescriptor).map((descriptor) => [descriptor.id, descriptor])).values()]
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

function blankMetrics() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, errors: 0, latencyMs: 0 };
}

function normalizeMetrics(value = {}) {
  exactKeys(value, USAGE_METRICS, "Provider usage metrics");
  const metrics = blankMetrics();
  for (const field of USAGE_METRICS) {
    const amount = Number(value[field] ?? (field === "requests" ? 1 : 0));
    invariant(Number.isSafeInteger(amount) && amount >= 0, "PROVIDER_USAGE_METRIC_INVALID", `${field} 必须是非负安全整数`, { status: 400 });
    metrics[field] = amount;
  }
  return metrics;
}

function addMetrics(target, source) {
  for (const field of USAGE_METRICS) target[field] += Number(source[field] || 0);
  return target;
}

function usageKey(actor, providerId, purpose) {
  return `${actor.actorType}:${actor.actorId}\0${providerId}\0${purpose}`;
}

function usageCommandKey(actor, commandId) {
  return `${actor.actorType}:${actor.actorId}:${commandId}`;
}

function validateUsageData(value) {
  invariant(value && typeof value.date === "string" && value.entries && value.commands, "PROVIDER_USAGE_STORE_INVALID", "Provider usage 数据无效", { status: 500, expose: false });
  return true;
}

export class ProviderUsageService {
  constructor({ dataRoot, providerService, clock = () => new Date(), queue } = {}) {
    invariant(path.isAbsolute(dataRoot || "") && providerService instanceof ProviderService, "PROVIDER_USAGE_DEPENDENCY_INVALID", "ProviderUsageService 缺少依赖", {
      status: 500,
      expose: false,
    });
    this.dataRoot = path.resolve(dataRoot);
    this.providerService = providerService;
    this.clock = clock;
    this.queue = queue;
  }

  #repository(date) {
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(date), "PROVIDER_USAGE_DATE_INVALID", "Usage 日期无效", { status: 500, expose: false });
    return new PlatformJsonRepository({
      dataRoot: this.dataRoot,
      relativePath: ["usage", `${date}.json`],
      schemaVersion: USAGE_STORE_SCHEMA_VERSION,
      defaultData: () => ({ date, entries: {}, commands: {} }),
      validate: validateUsageData,
      queue: this.queue,
      queueKey: `usage:${date}`,
    });
  }

  async record(actor, input) {
    exactKeys(input, ["providerId", "purpose", "metrics", "commandId"], "记录 Provider 用量");
    const providerId = assertProviderId(input.providerId);
    const purpose = assertProviderPurpose(input.purpose);
    const commandId = assertCommandId(input.commandId);
    const metrics = normalizeMetrics(input.metrics);
    const access = await this.providerService.resolve(actor, { providerId, purpose, modelId: "", requireModel: false });
    invariant(access.provider.configured, "PROVIDER_NOT_CONFIGURED", "Provider 尚未配置", { status: 409 });
    const date = nowIso(this.clock).slice(0, 10);
    const repository = this.#repository(date);
    const scopedCommandId = usageCommandKey(actor, commandId);
    const fingerprint = commandFingerprint("provider-usage", { actorType: actor.actorType, actorId: actor.actorId, providerId, purpose, metrics });
    const before = await repository.read();
    const replay = existingCommand(before.data.commands, scopedCommandId, fingerprint);
    if (replay) return { ...replay, replayed: true };
    const envelope = await repository.update((data, transaction) => {
      const duplicate = existingCommand(data.commands, scopedCommandId, fingerprint);
      if (duplicate) return data;
      const key = usageKey(actor, providerId, purpose);
      const entry = data.entries[key] || {
        actorType: actor.actorType,
        actorId: actor.actorId,
        providerId,
        purpose,
        metrics: blankMetrics(),
      };
      addMetrics(entry.metrics, metrics);
      data.entries[key] = entry;
      const result = { revision: transaction.nextRevision, date, recorded: true };
      data.commands[scopedCommandId] = commandEntry(fingerprint, result, nowIso(this.clock));
    }, { clock: this.clock });
    return { ...envelope.data.commands[scopedCommandId].result, replayed: false };
  }

  async summarize(actor, input = {}) {
    requireRole(actor, "admin");
    exactKeys(input, ["actorType", "actorId", "providerId", "purpose", "seriesDays"], "汇总 Provider 用量");
    const actorType = input.actorType == null ? null : String(input.actorType);
    if (actorType !== null) invariant(["user", "guest"].includes(actorType), "PROVIDER_USAGE_ACTOR_INVALID", "Usage actorType 无效", { status: 400 });
    const actorId = input.actorId == null ? null : String(input.actorId);
    const providerId = input.providerId == null ? null : assertProviderId(input.providerId);
    const purpose = input.purpose == null ? null : assertProviderPurpose(input.purpose);
    const seriesDays = Number(input.seriesDays ?? 14);
    invariant(Number.isSafeInteger(seriesDays) && seriesDays >= 1 && seriesDays <= 90, "PROVIDER_USAGE_SERIES_INVALID", "seriesDays 无效", { status: 400 });
    const usageRoot = path.join(this.dataRoot, "admins", "platform", "usage");
    const files = (await fs.readdir(usageRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, 10))
      .sort();
    const today = nowIso(this.clock).slice(0, 10);
    const weekStart = new Date(`${today}T00:00:00.000Z`);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    const weekStartText = weekStart.toISOString().slice(0, 10);
    const result = {
      daily: blankMetrics(),
      weekly: blankMetrics(),
      total: blankMetrics(),
      byProvider: {},
      byPurpose: {},
      byActor: {},
      series: [],
    };
    const dailySeries = new Map();
    for (const date of files) {
      const envelope = await this.#repository(date).read();
      const day = blankMetrics();
      for (const entry of Object.values(envelope.data.entries)) {
        if (actorType && entry.actorType !== actorType) continue;
        if (actorId && entry.actorId !== actorId) continue;
        if (providerId && entry.providerId !== providerId) continue;
        if (purpose && entry.purpose !== purpose) continue;
        addMetrics(day, entry.metrics);
        addMetrics(result.total, entry.metrics);
        if (date >= weekStartText && date <= today) addMetrics(result.weekly, entry.metrics);
        if (date === today) addMetrics(result.daily, entry.metrics);
        result.byProvider[entry.providerId] ||= blankMetrics();
        result.byPurpose[entry.purpose] ||= blankMetrics();
        const dimensionActor = `${entry.actorType}:${entry.actorId}`;
        result.byActor[dimensionActor] ||= blankMetrics();
        addMetrics(result.byProvider[entry.providerId], entry.metrics);
        addMetrics(result.byPurpose[entry.purpose], entry.metrics);
        addMetrics(result.byActor[dimensionActor], entry.metrics);
      }
      dailySeries.set(date, day);
    }
    const seriesStart = new Date(`${today}T00:00:00.000Z`);
    seriesStart.setUTCDate(seriesStart.getUTCDate() - (seriesDays - 1));
    result.series = Array.from({ length: seriesDays }, (_, index) => {
      const dateValue = new Date(seriesStart);
      dateValue.setUTCDate(dateValue.getUTCDate() + index);
      const date = dateValue.toISOString().slice(0, 10);
      return { date, ...(dailySeries.get(date) || blankMetrics()) };
    });
    return result;
  }
}

export const platformServiceConstants = Object.freeze({
  schemaVersion: PLATFORM_SCHEMA_VERSION,
  userProviderStoreSchemaVersion: USER_PROVIDER_STORE_SCHEMA_VERSION,
  usageStoreSchemaVersion: USAGE_STORE_SCHEMA_VERSION,
  providerIds: PLATFORM_PROVIDER_IDS,
});
