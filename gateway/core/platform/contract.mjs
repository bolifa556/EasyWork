import crypto from "node:crypto";
import net from "node:net";

import { invariant } from "../errors.mjs";

export const PLATFORM_SCHEMA_VERSION = 1;
export const PROVIDER_PURPOSES = Object.freeze(["web", "agent", "embedding"]);
export const PROVIDER_PROTOCOLS = Object.freeze(["auto", "responses", "chat-completions", "openai-embeddings"]);
export const PLATFORM_PROVIDER_IDS = Object.freeze({
  web: "platform-web",
  agent: "platform-agent",
  embedding: "platform-embedding",
});

const PROVIDER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/;
const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function clone(value) {
  return structuredClone(value);
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  invariant(Number.isSafeInteger(number) && number >= minimum && number <= maximum, "PLATFORM_SETTING_INVALID", `${field} 超出允许范围`, {
    status: 400,
    details: { field, minimum, maximum },
  });
  return number;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))];
}

export function assertProviderPurpose(value) {
  const purpose = String(value || "");
  invariant(PROVIDER_PURPOSES.includes(purpose), "PROVIDER_PURPOSE_INVALID", "Provider purpose 无效", { status: 400 });
  return purpose;
}

export function assertProviderId(value) {
  const providerId = String(value || "");
  invariant(PROVIDER_ID_PATTERN.test(providerId), "PROVIDER_ID_INVALID", "Provider id 无效", { status: 400 });
  return providerId;
}

export function assertCommandId(value) {
  const commandId = String(value || "");
  invariant(COMMAND_ID_PATTERN.test(commandId), "COMMAND_ID_INVALID", "commandId 无效", { status: 400 });
  return commandId;
}

export function normalizeProviderName(value, fallback = "模型 API") {
  const name = String(value || fallback).normalize("NFKC").trim();
  invariant(name.length >= 1 && name.length <= 80, "PROVIDER_NAME_INVALID", "API 名称需为 1 至 80 个字符", { status: 400 });
  return name;
}

export function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    invariant(false, "PROVIDER_URL_INVALID", "API URL 无效", { status: 400 });
  }
  invariant(["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.hash, "PROVIDER_URL_INVALID", "API URL 必须是无凭据的 HTTP(S) 地址", {
    status: 400,
  });
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeProtocol(value, purpose) {
  const requested = String(value || (purpose === "embedding" ? "openai-embeddings" : "auto"));
  invariant(PROVIDER_PROTOCOLS.includes(requested), "PROVIDER_PROTOCOL_INVALID", "Provider protocol 无效", { status: 400 });
  invariant(purpose !== "embedding" || requested === "openai-embeddings", "PROVIDER_PROTOCOL_INVALID", "Embedding Provider 必须使用 embeddings 协议", {
    status: 400,
  });
  invariant(purpose === "embedding" || requested !== "openai-embeddings", "PROVIDER_PROTOCOL_INVALID", "对话 Provider 不能使用 embeddings 协议", {
    status: 400,
  });
  return requested;
}

export function normalizeEmbeddingSettings(value = {}) {
  const strategy = String(value.chunkStrategy || "semantic");
  invariant(["semantic", "fixed", "paragraph"].includes(strategy), "EMBEDDING_CHUNK_STRATEGY_INVALID", "Embedding 分块策略无效", { status: 400 });
  const chunkSize = boundedInteger(value.chunkSize ?? 3000, "chunkSize", 128, 20000);
  const chunkOverlap = boundedInteger(value.chunkOverlap ?? 600, "chunkOverlap", 0, chunkSize - 1);
  const dimensions = value.dimensions === null || value.dimensions === undefined || value.dimensions === ""
    ? null
    : boundedInteger(value.dimensions, "dimensions", 1, 65536);
  return Object.freeze({
    model: String(value.model || "").trim().slice(0, 256),
    dimensions,
    chunkStrategy: strategy,
    chunkSize,
    chunkOverlap,
    batchSize: boundedInteger(value.batchSize ?? 32, "batchSize", 1, 256),
    hybridEnabled: value.hybridEnabled !== false,
  });
}

function normalizeCidrs(values, field) {
  return unique(values).map((source) => {
    const match = source.match(/^(.+)\/(\d{1,3})$/);
    invariant(match, "SSH_CIDR_INVALID", `${field} 包含无效 CIDR`, { status: 400, details: { cidr: source } });
    const family = net.isIP(match[1]);
    const prefix = Number(match[2]);
    invariant(family && prefix >= 0 && prefix <= (family === 4 ? 32 : 128), "SSH_CIDR_INVALID", `${field} 包含无效 CIDR`, {
      status: 400,
      details: { cidr: source },
    });
    return `${match[1]}/${prefix}`;
  }).sort();
}

function normalizePorts(values, field) {
  return [...new Set((values || []).map(Number))].map((port) => {
    invariant(Number.isSafeInteger(port) && port >= 1 && port <= 65535, "SSH_POLICY_PORT_INVALID", `${field} 包含无效端口`, { status: 400 });
    return port;
  }).sort((left, right) => left - right);
}

function normalizeHosts(values, field) {
  return unique(values).map((entry) => {
    const host = entry.toLowerCase();
    invariant(host.length <= 253 && (net.isIP(host) || HOST_PATTERN.test(host)), "SSH_POLICY_HOST_INVALID", `${field} 包含无效主机规则`, {
      status: 400,
      details: { host: entry },
    });
    return host;
  }).sort();
}

export function defaultSshPolicy() {
  return {
    idleTtlMinutes: 30 * 24 * 60,
    keepaliveIntervalSeconds: 300,
    keepaliveCountMax: 3,
    connectTimeoutSeconds: 25,
    maintenanceIntervalSeconds: 60,
    maxConnectionsPerUser: 8,
    maxTotalConnections: 128,
    allowedCidrs: [],
    deniedCidrs: [],
    allowedHosts: [],
    deniedHosts: [],
    allowedPorts: [],
    deniedPorts: [],
    allowPrivateKeyAuth: true,
    allowPasswordAuth: true,
  };
}

export function normalizeSshPolicy(value = {}) {
  const defaults = defaultSshPolicy();
  const policy = {
    idleTtlMinutes: boundedInteger(value.idleTtlMinutes ?? defaults.idleTtlMinutes, "idleTtlMinutes", 5, 365 * 24 * 60),
    keepaliveIntervalSeconds: boundedInteger(value.keepaliveIntervalSeconds ?? defaults.keepaliveIntervalSeconds, "keepaliveIntervalSeconds", 10, 3600),
    keepaliveCountMax: boundedInteger(value.keepaliveCountMax ?? defaults.keepaliveCountMax, "keepaliveCountMax", 1, 20),
    connectTimeoutSeconds: boundedInteger(value.connectTimeoutSeconds ?? defaults.connectTimeoutSeconds, "connectTimeoutSeconds", 3, 300),
    maintenanceIntervalSeconds: boundedInteger(value.maintenanceIntervalSeconds ?? defaults.maintenanceIntervalSeconds, "maintenanceIntervalSeconds", 10, 3600),
    maxConnectionsPerUser: boundedInteger(value.maxConnectionsPerUser ?? defaults.maxConnectionsPerUser, "maxConnectionsPerUser", 1, 128),
    maxTotalConnections: boundedInteger(value.maxTotalConnections ?? defaults.maxTotalConnections, "maxTotalConnections", 1, 4096),
    allowedCidrs: normalizeCidrs(value.allowedCidrs, "allowedCidrs"),
    deniedCidrs: normalizeCidrs(value.deniedCidrs, "deniedCidrs"),
    allowedHosts: normalizeHosts(value.allowedHosts, "allowedHosts"),
    deniedHosts: normalizeHosts(value.deniedHosts, "deniedHosts"),
    allowedPorts: normalizePorts(value.allowedPorts, "allowedPorts"),
    deniedPorts: normalizePorts(value.deniedPorts, "deniedPorts"),
    allowPrivateKeyAuth: value.allowPrivateKeyAuth !== false,
    allowPasswordAuth: value.allowPasswordAuth !== false,
  };
  invariant(policy.allowPrivateKeyAuth || policy.allowPasswordAuth, "SSH_AUTH_POLICY_INVALID", "SSH 策略必须至少允许一种登录方式", { status: 400 });
  invariant(policy.maxTotalConnections >= policy.maxConnectionsPerUser, "SSH_CONNECTION_LIMIT_INVALID", "平台总连接上限不能小于单用户上限", { status: 400 });
  return Object.freeze(policy);
}

export function sshRuntimeConfiguration(policyInput) {
  const policy = normalizeSshPolicy(policyInput);
  return Object.freeze({
    workerPool: Object.freeze({
      keepAliveIntervalMs: policy.keepaliveIntervalSeconds * 1000,
      inactiveTtlMs: policy.idleTtlMinutes * 60 * 1000,
      maintenanceIntervalMs: policy.maintenanceIntervalSeconds * 1000,
    }),
    networkPolicy: Object.freeze({
      allowedCidrs: Object.freeze([...policy.allowedCidrs]),
      deniedCidrs: Object.freeze([...policy.deniedCidrs]),
      allowedHosts: Object.freeze([...policy.allowedHosts]),
      deniedHosts: Object.freeze([...policy.deniedHosts]),
      allowedPorts: Object.freeze([...policy.allowedPorts]),
      deniedPorts: Object.freeze([...policy.deniedPorts]),
    }),
    transport: Object.freeze({
      connectTimeoutMs: policy.connectTimeoutSeconds * 1000,
      keepaliveCountMax: policy.keepaliveCountMax,
      allowPrivateKeyAuth: policy.allowPrivateKeyAuth,
      allowPasswordAuth: policy.allowPasswordAuth,
    }),
    limits: Object.freeze({
      maxConnectionsPerUser: policy.maxConnectionsPerUser,
      maxTotalConnections: policy.maxTotalConnections,
    }),
  });
}

export function stableFingerprint(value) {
  function normalize(entry) {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
    }
    return entry;
  }
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export function cloneContract(value) {
  return clone(value);
}
