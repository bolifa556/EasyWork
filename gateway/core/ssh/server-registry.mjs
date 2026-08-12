import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { computeServerIdentity, normalizeSshHost } from "../scope.mjs";
import { validateServerId } from "./credential-vault.mjs";

const STATUSES = new Set(["disconnected", "connecting", "connected", "failed"]);
const clockDate = (clock) => {
  const value = (clock || (() => new Date()))();
  return value instanceof Date ? value : new Date(value);
};
const nowIso = (clock) => clockDate(clock).toISOString();

function normalizeProfileInput(input) {
  const host = normalizeSshHost(input.host);
  const port = Number(input.port ?? 22);
  invariant(Number.isSafeInteger(port) && port >= 1 && port <= 65535, "SSH_PORT_INVALID", "SSH 端口无效", { status: 400 });
  const username = String(input.username || "").trim();
  invariant(username && username.length <= 256, "SSH_USERNAME_REQUIRED", "SSH 用户名不能为空", { status: 400 });
  const authMethod = String(input.authMethod || "");
  invariant(["password", "private-key"].includes(authMethod), "SSH_AUTH_METHOD_INVALID", "SSH 登录方式无效", { status: 400 });
  return {
    name: String(input.name || host).trim().slice(0, 256) || host,
    host,
    port,
    username,
    authMethod,
  };
}

function validateProfile(profile, id) {
  if (!profile || profile.id !== id || !Number.isSafeInteger(profile.revision) || profile.revision < 0) return false;
  if (!profile.name || !profile.host || !profile.username || !["password", "private-key"].includes(profile.authMethod)) return false;
  if (!Number.isSafeInteger(profile.port) || profile.port < 1 || profile.port > 65535) return false;
  return profile.serverIdentity === null || /^ssh_[A-Za-z0-9_-]{32,}$/.test(profile.serverIdentity);
}

function validateState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.profiles || !data.connections || !data.bindings) return false;
  for (const [id, profile] of Object.entries(data.profiles)) if (!validateProfile(profile, id)) return false;
  for (const [id, connection] of Object.entries(data.connections)) {
    if (!data.profiles[id] || !STATUSES.has(connection?.status) || typeof connection.desiredConnection !== "boolean") return false;
  }
  const boundConversations = new Set();
  for (const [id, ids] of Object.entries(data.bindings)) {
    if (!data.profiles[id] || !Array.isArray(ids) || ids.some((value) => typeof value !== "string" || !value)) return false;
    for (const conversationId of ids) {
      if (boundConversations.has(conversationId)) return false;
      boundConversations.add(conversationId);
    }
  }
  return true;
}

export class SshServerRegistry {
  constructor({ dataRoot, actor, vault, queue, clock, networkPolicy }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.vault = vault;
    this.queue = queue;
    this.clock = clock;
    this.networkPolicy = networkPolicy;
  }

  #repository() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["state", "servers.json"],
      schemaVersion: 1,
      defaultData: () => ({ profiles: {}, connections: {}, bindings: {} }),
      validate: validateState,
      queue: this.queue,
    });
  }

  async #update(mutator) {
    const repository = this.#repository();
    for (;;) {
      const current = await repository.read();
      try {
        return await repository.update(mutator, { expectedRevision: current.revision, clock: () => clockDate(this.clock) });
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async create(input) {
    const profileInput = normalizeProfileInput(input);
    await this.networkPolicy?.assertAllowed?.(profileInput);
    const id = validateServerId(input.id || `server_${crypto.randomUUID()}`);
    const createdAt = nowIso(this.clock);
    const profile = { id, revision: 0, ...profileInput, serverIdentity: null, fingerprint: null, createdAt, updatedAt: createdAt };
    await this.vault.put(id, { ...input.credential, method: profile.authMethod });
    try {
      await this.#update((data) => {
        invariant(!data.profiles[id], "SERVER_EXISTS", "服务器配置已存在", { status: 409 });
        data.profiles[id] = profile;
        data.connections[id] = {
          status: "disconnected", desiredConnection: false, connectedAt: null, disconnectedAt: createdAt,
          lastActiveAt: null, lastKeepAliveAt: null, generation: 0, lastError: null,
        };
        data.bindings[id] = [];
      });
    } catch (error) {
      await this.vault.clear(id).catch(() => undefined);
      throw error;
    }
    return structuredClone(profile);
  }

  async get(serverId) {
    const id = validateServerId(serverId);
    const state = await this.#repository().read();
    invariant(state.data.profiles[id], "SERVER_NOT_FOUND", "服务器配置不存在", { status: 404 });
    return {
      profile: structuredClone(state.data.profiles[id]),
      connection: structuredClone(state.data.connections[id]),
      conversationIds: structuredClone(state.data.bindings[id]),
    };
  }

  async list() {
    const state = await this.#repository().read();
    return Object.values(state.data.profiles).map((profile) => ({
      profile: structuredClone(profile),
      connection: structuredClone(state.data.connections[profile.id]),
      conversationIds: structuredClone(state.data.bindings[profile.id]),
    }));
  }

  async revealCredential(serverId) {
    const id = validateServerId(serverId);
    const { profile } = await this.get(id);
    const credential = await this.vault.get(id);
    return Object.freeze({
      serverId: id,
      method: credential.method,
      ...(credential.method === "password"
        ? { password: credential.password }
        : { fileName: credential.fileName || "private-key", hasPassphrase: Boolean(credential.passphrase) }),
      expiresAt: new Date(clockDate(this.clock).getTime() + 30_000).toISOString(),
      profileRevision: profile.revision,
    });
  }

  async update(serverId, input) {
    const id = validateServerId(serverId);
    const before = await this.get(id);
    invariant(before.profile.revision === input.expectedRevision, "SERVER_REVISION_CONFLICT", "服务器配置已被其他操作更新", { status: 409 });
    const nextInput = normalizeProfileInput({ ...before.profile, ...input });
    await this.networkPolicy?.assertAllowed?.(nextInput);
    const endpointChanged = nextInput.host !== before.profile.host || nextInput.port !== before.profile.port;
    invariant(!endpointChanged || before.connection.status !== "connected", "SERVER_ENDPOINT_CONNECTED", "请先断开 SSH 再修改服务器地址", { status: 409 });
    const previousCredential = input.credential ? await this.vault.get(id) : null;
    if (input.credential) await this.vault.put(id, { ...input.credential, method: nextInput.authMethod });
    let output;
    try {
      await this.#update((data) => {
        const current = data.profiles[id];
        invariant(current, "SERVER_NOT_FOUND", "服务器配置不存在", { status: 404 });
        invariant(current.revision === input.expectedRevision, "SERVER_REVISION_CONFLICT", "服务器配置已被其他操作更新", { status: 409 });
        output = {
          ...current,
          ...nextInput,
          fingerprint: endpointChanged ? null : current.fingerprint,
          serverIdentity: endpointChanged ? null : current.serverIdentity,
          revision: current.revision + 1,
          updatedAt: nowIso(this.clock),
        };
        data.profiles[id] = output;
        if (endpointChanged) data.connections[id] = { ...data.connections[id], desiredConnection: false, status: "disconnected", lastError: null };
      });
    } catch (error) {
      if (previousCredential) await this.vault.put(id, previousCredential).catch(() => undefined);
      throw error;
    }
    return structuredClone(output);
  }

  async setFingerprint(serverId, fingerprint) {
    const id = validateServerId(serverId);
    const normalized = String(fingerprint || "").trim();
    invariant(normalized.length >= 16 && normalized.length <= 512, "SSH_FINGERPRINT_INVALID", "SSH 主机指纹无效", { status: 400 });
    let output;
    await this.#update((data) => {
      const current = data.profiles[id];
      invariant(current, "SERVER_NOT_FOUND", "服务器配置不存在", { status: 404 });
      if (current.fingerprint && current.fingerprint !== normalized) {
        invariant(false, "SSH_HOST_KEY_CHANGED", "服务器主机指纹已变化", { status: 409, details: { serverId: id } });
      }
      const identity = computeServerIdentity({ host: current.host, port: current.port, hostKeyFingerprint: normalized });
      output = {
        ...current,
        fingerprint: normalized,
        serverIdentity: identity.serverIdentity,
        revision: current.revision + 1,
        updatedAt: nowIso(this.clock),
      };
      data.profiles[id] = output;
    });
    return structuredClone(output);
  }

  async setConnection(serverId, changes) {
    const id = validateServerId(serverId);
    let output;
    await this.#update((data) => {
      invariant(data.profiles[id], "SERVER_NOT_FOUND", "服务器配置不存在", { status: 404 });
      const current = data.connections[id];
      const next = { ...current, ...structuredClone(changes) };
      invariant(STATUSES.has(next.status), "SSH_CONNECTION_STATUS_INVALID", "SSH 连接状态无效", { status: 400 });
      next.lastError = next.lastError ? { code: String(next.lastError.code || "SSH_CONNECTION_FAILED"), message: String(next.lastError.message || "SSH 连接失败").slice(0, 2_000) } : null;
      data.connections[id] = next;
      output = next;
    });
    return structuredClone(output);
  }

  async bindConversation(serverId, conversationId) {
    const id = validateServerId(serverId);
    const conversation = String(conversationId || "");
    invariant(conversation, "CONVERSATION_ID_REQUIRED", "缺少对话 id", { status: 400 });
    await this.#update((data) => {
      invariant(data.profiles[id], "SERVER_NOT_FOUND", "服务器配置不存在", { status: 404 });
      const existingServerId = Object.entries(data.bindings).find(([, ids]) => ids.includes(conversation))?.[0] || null;
      invariant(!existingServerId || existingServerId === id, "CONVERSATION_SERVER_ALREADY_BOUND", "该对话已绑定另一台服务器，不能切换", {
        status: 409,
        details: { conversationId: conversation, serverId: existingServerId },
      });
      data.bindings[id] = [...new Set([...(data.bindings[id] || []), conversation])];
    });
    return this.get(id);
  }

  async findConversationBinding(conversationId) {
    const conversation = String(conversationId || "");
    invariant(conversation, "CONVERSATION_ID_REQUIRED", "缺少对话 id", { status: 400 });
    const state = await this.#repository().read();
    const serverId = Object.entries(state.data.bindings).find(([, ids]) => ids.includes(conversation))?.[0] || null;
    return Object.freeze({ conversationId: conversation, serverId });
  }

  async unbindConversationEverywhere(conversationId) {
    const conversation = String(conversationId || "");
    invariant(conversation, "CONVERSATION_ID_REQUIRED", "缺少对话 id", { status: 400 });
    await this.#update((data) => {
      for (const serverId of Object.keys(data.bindings)) {
        data.bindings[serverId] = data.bindings[serverId].filter((value) => value !== conversation);
      }
    });
    return Object.freeze({ conversationId: conversation, serverId: null });
  }

  async unbindConversation(serverId, conversationId) {
    const id = validateServerId(serverId);
    await this.#update((data) => {
      invariant(data.profiles[id], "SERVER_NOT_FOUND", "服务器配置不存在", { status: 404 });
      data.bindings[id] = (data.bindings[id] || []).filter((value) => value !== conversationId);
    });
    return this.get(id);
  }
}

export { normalizeProfileInput };
