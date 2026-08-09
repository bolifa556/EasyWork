import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import {
  access,
  chmod,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client as SshClient } from "ssh2";
import { WebSocketServer } from "ws";
import AdmZip from "adm-zip";
import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
} from "jsonc-parser";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import {
  loadRemoteRuntimeBundle,
  parseRuntimeFields,
  remoteRuntimePaths,
  safeRemoteRunId,
} from "./remote-runtime.mjs";
import {
  MANAGED_AGENT_CATALOG,
  compareAgentVersions,
  managedAgentPaths,
  managedAgentRuntimePaths,
  normalizeAgentVersion,
  readAgentArtifactManifest,
  remoteAgentPlatform,
  resolveAgentArtifact,
} from "./agent-artifacts.mjs";
import {
  activeMemoryRecords,
  agentConversationDelta,
  appendExplicitMemory,
  appendMemoryTombstone,
  cloneConversationMemoryScope,
  cloneConversationSummary,
  currentConversationHistory,
  estimateContextTokens,
  findConversationSummary,
  invalidateMemoryVersions,
  memorySnapshotAt,
  normalizeMemoryDocument,
  selectMemoryRecords,
  selectMemorySyncRecords,
  upsertConversationSummary,
} from "./memory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DATA_ROOT = path.resolve(process.env.EASYWORK_DATA_DIR || path.join(ROOT, "data"));
const SKILL_ROOT = path.resolve(process.env.EASYWORK_SKILL_DIR || path.join(ROOT, "skill"));
const PROMPT_ROOT = path.join(ROOT, "prompts");
const HELP_FILE = path.join(ROOT, "help", "help.md");
const ADMIN_ROOT = path.join(DATA_ROOT, "admins");
const ADMIN_LIST_FILE = path.join(ADMIN_ROOT, "adminList");
const PLATFORM_SETTINGS_FILE = path.join(ADMIN_ROOT, "platform-settings.json");
const PLATFORM_SECRETS_FILE = path.join(ADMIN_ROOT, "platform-secrets.json");
const PLATFORM_USAGE_FILE = path.join(ADMIN_ROOT, "api-usage.json");
const HOST = process.env.EASYWORK_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.EASYWORK_GATEWAY_PORT || 8789);
const BODY_LIMIT = 36 * 1024 * 1024;
const SESSION_MAX_AGE = 60 * 60 * 24 * 180;
const PLATFORM_WEB_PROVIDER_ID = "platform-web";
const PLATFORM_AGENT_PROVIDER_ID = "platform-agent";
const EASYWORK_OPENCODE_PROVIDER_ID = "easywork";
const DEFAULT_PROVIDER_ID = "provider-default";
const DEFAULT_AGENT_CONTEXT_LIMIT = 200_000;
const DEFAULT_AGENT_OUTPUT_LIMIT = 32_768;
const BUILTIN_SKILLS = {
  skill_cluster: path.join(SKILL_ROOT, "built-in", "cluster-ops"),
  skill_paper: path.join(SKILL_ROOT, "built-in", "paper-reading"),
  skill_debug: path.join(SKILL_ROOT, "built-in", "training-debug"),
};

const activeSockets = new Set();
const sshWorkerPool = new Map();
// Every persisted document belonging to one actor uses the same queue. This
// prevents state, memory, binding and checkpoint writes for that user from
// overtaking one another while different users still proceed independently.
const actorMutationQueues = new Map();
const stateMutationQueues = actorMutationQueues;
const secretMutationQueues = actorMutationQueues;
const agentBindingMutationQueues = actorMutationQueues;
const agentProfileMutationQueues = actorMutationQueues;
const memoryMutationQueues = actorMutationQueues;
const conversationTreeMutationQueues = actorMutationQueues;
const checkpointMutationQueues = actorMutationQueues;
const workspaceMutationQueues = actorMutationQueues;
let accountMutationQueue = Promise.resolve();
let platformMutationQueue = Promise.resolve();
let sessionSecret;
let encryptionKey;
let remoteRuntimeBundlePromise;
let runtimePlatformSettings = null;
let lastAutomaticSshCleanupAt = 0;

const DEFAULT_PLATFORM_SETTINGS = Object.freeze({
  providers: {
    web: {
      id: PLATFORM_WEB_PROVIDER_ID,
      name: "网页公共 API",
      baseUrl: "",
      model: "",
      protocol: "auto",
      configured: false,
      audience: "web",
      managedBy: "platform",
    },
    agent: {
      id: PLATFORM_AGENT_PROVIDER_ID,
      name: "Agent 公共 API",
      baseUrl: "",
      model: "",
      protocol: "auto",
      configured: false,
      audience: "agent",
      managedBy: "platform",
    },
  },
  embedding: {
    name: "平台 Embedding",
    baseUrl: "",
    model: "",
    dimensions: "",
    configured: false,
    chunkStrategy: "semantic",
    chunkSize: 3000,
    chunkOverlap: 600,
    batchSize: 32,
    hybridEnabled: true,
    rerankEnabled: false,
  },
  ssh: {
    idleTtlMinutes: 30 * 24 * 60,
    keepaliveIntervalSeconds: 60,
    keepaliveCountMax: 3,
    connectTimeoutSeconds: 25,
    cleanupIntervalMinutes: 6 * 60,
  },
});

function isoNow() {
  return new Date().toISOString();
}

function randomId(prefix = "") {
  return `${prefix}${crypto.randomUUID()}`;
}

function normalizeUsername(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
}

function displayUsername(value) {
  return String(value || "").normalize("NFKC").trim().slice(0, 48);
}

function validUsername(value) {
  return /^[\p{L}\p{N}._-]{2,48}$/u.test(value);
}

function safeSegment(value, fallback = "item") {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 90);
  return normalized || fallback;
}

function uniqueStrings(...groups) {
  return [...new Set(groups.flat(Infinity).filter(Boolean).map(String))];
}

async function renderPromptTemplate(relativePath, variables = {}) {
  const promptPath = path.resolve(PROMPT_ROOT, relativePath);
  const promptPrefix = `${path.resolve(PROMPT_ROOT)}${path.sep}`;
  if (!promptPath.startsWith(promptPrefix)) {
    throw new Error("提示词路径超出 prompts 目录");
  }
  const template = await readFile(promptPath, "utf8");
  return template
    .replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_match, name) =>
      String(variables[name] ?? ""),
    )
    .trim();
}

async function enqueueActorMutation(queues, actor, mutation) {
  const actorKey = `${actor.authenticated ? "user" : "guest"}:${actor.id}`;
  const previous = queues.get(actorKey) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => withActorMutationLock(actor, mutation));
  queues.set(actorKey, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(actorKey) === operation) queues.delete(actorKey);
  }
}

async function withActorMutationLock(actor, mutation) {
  const lockPath = path.join(actorDirectory(actor), "runtime", "mutation.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: isoNow() })}\n`,
        "utf8",
      );
      break;
    } catch (caught) {
      if (String(caught?.code || "") !== "EEXIST") throw caught;
      const lockStat = await stat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 120_000) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!handle) throw new Error("用户数据正在被另一网关进程修改，请稍后重试");
  try {
    return await mutation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

function safeRelativePath(value) {
  const parts = String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .filter((part) => part !== "." && part !== "..")
    .map((part) => safeSegment(part));
  return parts.join("/");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function remoteOpenCodePortCommand() {
  return [
    "set -eu",
    'EW_PORT=$((49152 + (($(date +%s) + $$) % 16000)))',
    "EW_ATTEMPT=0",
    'while [ "$EW_ATTEMPT" -lt 128 ]; do',
    '  if command -v ss >/dev/null 2>&1; then',
    '    EW_BUSY=$(ss -ltn 2>/dev/null | grep -Ec "[:.]${EW_PORT}([[:space:]]|$)" || true)',
    '  elif command -v netstat >/dev/null 2>&1; then',
    '    EW_BUSY=$(netstat -ltn 2>/dev/null | grep -Ec "[:.]${EW_PORT}[[:space:]]" || true)',
    "  else",
    "    EW_BUSY=0",
    "  fi",
    '  if [ "$EW_BUSY" -eq 0 ]; then printf "%s\\n" "$EW_PORT"; exit 0; fi',
    '  EW_PORT=$((49152 + ((EW_PORT - 49152 + 1) % 16000)))',
    '  EW_ATTEMPT=$((EW_ATTEMPT + 1))',
    "done",
    'printf "%s\\n" "没有找到可用的 OpenCode 本地端口" >&2',
    "exit 1",
  ].join("\n");
}

const PROVIDER_RELAY_ERROR_STATUS = 599;
const PROVIDER_ROUTE_CACHE_MS = 5 * 60 * 1000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function providerRelayTarget(baseUrl, requestUrl = "/") {
  const upstream = new URL(baseUrl);
  const incoming = new URL(String(requestUrl || "/"), "http://easywork-relay.local");
  const basePath = upstream.pathname.replace(/\/+$/, "");
  let targetPath = incoming.pathname || "/";
  if (
    basePath &&
    basePath !== "/" &&
    targetPath !== basePath &&
    !targetPath.startsWith(`${basePath}/`)
  ) {
    targetPath = `${basePath}/${targetPath.replace(/^\/+/, "")}`;
  }
  upstream.pathname = targetPath;
  upstream.search = incoming.search;
  upstream.hash = "";
  return upstream;
}

function proxyHeaders(headers, host = "") {
  const next = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    next[name] = value;
  }
  if (host) next.host = host;
  return next;
}

async function createLocalProviderRelay(baseUrl) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let target;
    try {
      target = providerRelayTarget(baseUrl, request.url);
    } catch {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: "模型 API 请求地址无效" } }));
      return;
    }
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: proxyHeaders(request.headers, target.host),
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          proxyHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.setTimeout(10 * 60 * 1000, () => {
      upstream.destroy(new Error("模型 API 响应超时"));
    });
    upstream.on("error", (error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      response.writeHead(PROVIDER_RELAY_ERROR_STATUS, {
        "content-type": "application/json; charset=utf-8",
        "x-easywork-relay-error": "upstream-unreachable",
      });
      response.end(
        JSON.stringify({
          error: {
            message: `EasyWork 主机无法访问模型 API：${String(error.code || "连接失败")}`,
          },
        }),
      );
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", () => undefined);
  server.unref?.();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("主机模型 API 中继端口分配失败");
  }
  return {
    server,
    sockets,
    localPort: address.port,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

function cookieMap(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
          ? [part, ""]
          : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function cookie(name, value, req, options = {}) {
  const secure = req.headers["x-forwarded-proto"] === "https";
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) attributes.push("Secure");
  if (typeof options.maxAge === "number") attributes.push(`Max-Age=${options.maxAge}`);
  return attributes.join("; ");
}

function signSession(userId, expires) {
  const body = `${userId}.${expires}`;
  const signature = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySession(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return null;
  const expected = crypto
    .createHmac("sha256", sessionSecret)
    .update(`${userId}.${expires}`)
    .digest("base64url");
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return userId;
}

function requestSessionToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    return url.searchParams.get("deviceToken") || "";
  } catch {
    return "";
  }
}

function issueDeviceToken(actor) {
  const expires = Date.now() + SESSION_MAX_AGE * 1000;
  return signSession(actor.id, expires);
}

async function ensureFile(filePath, bytes = 32) {
  try {
    return await readFile(filePath);
  } catch {
    const value = crypto.randomBytes(bytes);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, value, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => undefined);
    return value;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await chmod(tempPath, 0o600).catch(() => undefined);
  try {
    await rename(tempPath, filePath);
  } catch (caught) {
    // Some Windows filesystems do not replace an existing destination through
    // rename. The fallback keeps the old file in place until the copy succeeds.
    if (!["EEXIST", "EPERM", "EACCES"].includes(String(caught?.code || ""))) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw caught;
    }
    await cp(tempPath, filePath, { force: true });
    await rm(tempPath, { force: true });
  }
}

function encryptString(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decryptString(value) {
  if (!value) return "";
  try {
    const [iv, tag, ciphertext] = String(value)
      .split(".")
      .map((part) => Buffer.from(part, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored).split(".");
    const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), 64);
    const target = Buffer.from(expected, "base64url");
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
  } catch {
    return false;
  }
}

function actorDirectory(actor) {
  const family = actor.authenticated ? "users" : "guests";
  return path.join(DATA_ROOT, family, safeSegment(actor.id));
}

function actorSkillDirectory(actor) {
  const family = actor.authenticated ? "users" : "guests";
  return path.join(SKILL_ROOT, family, safeSegment(actor.id));
}

async function readUserRecord(userId) {
  const record = await readJson(actorProfilePath(userId), null);
  return record?.id === userId && record?.username ? record : null;
}

async function listUserRecords() {
  const root = path.join(DATA_ROOT, "users");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readUserRecord(entry.name)),
  );
  return records.filter(Boolean);
}

async function writeUserRecord(record) {
  await writeJson(actorProfilePath(record.id), record);
  return record;
}

async function mutateAccounts(mutation) {
  const operation = accountMutationQueue.catch(() => undefined).then(mutation);
  accountMutationQueue = operation.catch(() => undefined);
  return operation;
}

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizePlatformProvider(value = {}, audience = "web") {
  const id = audience === "agent"
    ? PLATFORM_AGENT_PROVIDER_ID
    : PLATFORM_WEB_PROVIDER_ID;
  const fallbackName = audience === "agent" ? "Agent 公共 API" : "网页公共 API";
  return {
    id,
    name: String(value.name || fallbackName).trim().slice(0, 80) || fallbackName,
    baseUrl: String(value.baseUrl || "").trim(),
    model: String(value.model || "").trim(),
    modelContextLimit: positiveInteger(value.modelContextLimit) || undefined,
    modelOutputLimit: positiveInteger(value.modelOutputLimit) || undefined,
    protocol:
      value.protocol === "chat-completions" || value.protocol === "responses"
        ? value.protocol
        : "auto",
    configured: Boolean(value.configured && value.baseUrl),
    audience,
    managedBy: "platform",
  };
}

function normalizePlatformSettings(value = {}) {
  const defaults = DEFAULT_PLATFORM_SETTINGS;
  const embedding = value.embedding || {};
  const ssh = value.ssh || {};
  const chunkSize = Math.round(
    clampNumber(embedding.chunkSize, defaults.embedding.chunkSize, 300, 20_000),
  );
  return {
    providers: {
      web: normalizePlatformProvider(value.providers?.web, "web"),
      agent: normalizePlatformProvider(value.providers?.agent, "agent"),
    },
    embedding: {
      name: String(embedding.name || defaults.embedding.name)
        .trim()
        .slice(0, 80) || defaults.embedding.name,
      baseUrl: String(embedding.baseUrl || "").trim(),
      model: String(embedding.model || "").trim(),
      dimensions: String(embedding.dimensions || "").trim(),
      configured: Boolean(embedding.configured && embedding.baseUrl && embedding.model),
      chunkStrategy: ["semantic", "fixed", "paragraph"].includes(
        String(embedding.chunkStrategy || ""),
      )
        ? String(embedding.chunkStrategy)
        : defaults.embedding.chunkStrategy,
      chunkSize,
      chunkOverlap: Math.round(
        clampNumber(
          embedding.chunkOverlap,
          defaults.embedding.chunkOverlap,
          0,
          Math.max(0, chunkSize - 1),
        ),
      ),
      batchSize: Math.round(
        clampNumber(embedding.batchSize, defaults.embedding.batchSize, 1, 128),
      ),
      hybridEnabled: embedding.hybridEnabled !== false,
      rerankEnabled: Boolean(embedding.rerankEnabled),
    },
    ssh: {
      idleTtlMinutes: Math.round(
        clampNumber(
          ssh.idleTtlMinutes,
          defaults.ssh.idleTtlMinutes,
          5,
          365 * 24 * 60,
        ),
      ),
      keepaliveIntervalSeconds: Math.round(
        clampNumber(
          ssh.keepaliveIntervalSeconds,
          defaults.ssh.keepaliveIntervalSeconds,
          10,
          600,
        ),
      ),
      keepaliveCountMax: Math.round(
        clampNumber(
          ssh.keepaliveCountMax,
          defaults.ssh.keepaliveCountMax,
          1,
          20,
        ),
      ),
      connectTimeoutSeconds: Math.round(
        clampNumber(
          ssh.connectTimeoutSeconds,
          defaults.ssh.connectTimeoutSeconds,
          5,
          120,
        ),
      ),
      cleanupIntervalMinutes: Math.round(
        clampNumber(
          ssh.cleanupIntervalMinutes,
          defaults.ssh.cleanupIntervalMinutes,
          1,
          24 * 60,
        ),
      ),
    },
  };
}

async function readPlatformSettings() {
  const stored = await readJson(PLATFORM_SETTINGS_FILE, {});
  runtimePlatformSettings = normalizePlatformSettings(stored);
  return runtimePlatformSettings;
}

async function readPlatformSecrets() {
  const stored = await readJson(PLATFORM_SECRETS_FILE, {});
  return {
    webApiKey: decryptString(stored.webApiKey),
    agentApiKey: decryptString(stored.agentApiKey),
    embeddingApiKey: decryptString(stored.embeddingApiKey),
  };
}

async function updatePlatformConfiguration(input = {}) {
  const operation = platformMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const current = await readPlatformSettings();
      const next = normalizePlatformSettings({
        ...current,
        ...input,
        providers: {
          ...current.providers,
          ...(input.providers || {}),
        },
        embedding: {
          ...current.embedding,
          ...(input.embedding || {}),
        },
        ssh: {
          ...current.ssh,
          ...(input.ssh || {}),
        },
      });
      const storedSecrets = await readJson(PLATFORM_SECRETS_FILE, {});
      const nextSecrets = { ...storedSecrets };
      for (const [field, value] of [
        ["webApiKey", input.webApiKey],
        ["agentApiKey", input.agentApiKey],
        ["embeddingApiKey", input.embeddingApiKey],
      ]) {
        if (typeof value === "string" && value.trim()) {
          assertApiKeyShape(value);
          nextSecrets[field] = encryptString(value.trim());
        }
        if (value === null) delete nextSecrets[field];
      }
      const effectiveSecrets = {
        webApiKey: decryptString(nextSecrets.webApiKey),
        agentApiKey: decryptString(nextSecrets.agentApiKey),
        embeddingApiKey: decryptString(nextSecrets.embeddingApiKey),
      };
      next.providers.web.configured = Boolean(
        next.providers.web.baseUrl && effectiveSecrets.webApiKey,
      );
      next.providers.agent.configured = Boolean(
        next.providers.agent.baseUrl && effectiveSecrets.agentApiKey,
      );
      next.embedding.configured = Boolean(
        next.embedding.baseUrl && next.embedding.model && effectiveSecrets.embeddingApiKey,
      );
      await Promise.all([
        writeJson(PLATFORM_SETTINGS_FILE, next),
        writeJson(PLATFORM_SECRETS_FILE, nextSecrets),
      ]);
      runtimePlatformSettings = next;
      return next;
    });
  platformMutationQueue = operation.catch(() => undefined);
  return operation;
}

async function readAdminNames() {
  const source = await readFile(ADMIN_LIST_FILE, "utf8").catch(() => "");
  return new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .map(normalizeUsername),
  );
}

async function writeAdminNames(names) {
  const normalized = [...new Set([...names].map(normalizeUsername).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  await mkdir(ADMIN_ROOT, { recursive: true });
  await writeFile(
    ADMIN_LIST_FILE,
    normalized.length ? `${normalized.join("\n")}\n` : "",
    "utf8",
  );
}

async function ensureAdminUsername(username) {
  const names = await readAdminNames();
  names.add(normalizeUsername(username));
  await writeAdminNames(names);
}

async function ensureInitialAdministrator() {
  const names = await readAdminNames();
  if (names.size) return;
  const records = (await listUserRecords()).sort(
    (left, right) =>
      (Date.parse(left.createdAt || "") || 0) -
      (Date.parse(right.createdAt || "") || 0),
  );
  if (records[0]?.username) {
    await ensureAdminUsername(records[0].username);
  }
}

async function isAdminUsername(username) {
  if (!username) return false;
  return (await readAdminNames()).has(normalizeUsername(username));
}

async function requireAdmin(actor) {
  if (!actor.authenticated || !(await isAdminUsername(actor.username))) {
    const error = new Error("只有管理员可以访问此页面");
    error.statusCode = 403;
    throw error;
  }
}

function deviceIdFromRequest(req) {
  const value = String(req.headers["x-easywork-device-id"] || "").trim();
  return /^[a-zA-Z0-9._:-]{16,160}$/.test(value) ? value : "";
}

async function registerDeviceVisit(actor, req) {
  const deviceId = deviceIdFromRequest(req);
  if (!deviceId) return { id: "", firstVisit: false };
  const target = path.join(DATA_ROOT, "devices", `${safeSegment(deviceId)}.json`);
  const previous = await readJson(target, null);
  await writeJson(target, {
    id: deviceId,
    firstSeenAt: String(previous?.firstSeenAt || isoNow()),
    lastSeenAt: isoNow(),
    lastActorId: actor.authenticated ? actor.id : String(previous?.lastActorId || ""),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 500),
  });
  return { id: deviceId, firstVisit: !previous };
}

async function recordPlatformUsage(category, values = {}) {
  if (!["web", "agent", "embedding"].includes(category)) return;
  const operation = platformMutationQueue
    .catch(() => undefined)
    .then(async () => {
      const document = await readJson(PLATFORM_USAGE_FILE, { days: {} });
      document.days ||= {};
      const day = isoNow().slice(0, 10);
      document.days[day] ||= {};
      const current = document.days[day][category] || {};
      document.days[day][category] = {
        requests: Number(current.requests || 0) + Number(values.requests ?? 1),
        inputTokens: Number(current.inputTokens || 0) + Number(values.inputTokens || 0),
        outputTokens: Number(current.outputTokens || 0) + Number(values.outputTokens || 0),
      };
      document.updatedAt = isoNow();
      const cutoff = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      document.days = Object.fromEntries(
        Object.entries(document.days).filter(([key]) => key >= cutoff),
      );
      await writeJson(PLATFORM_USAGE_FILE, document);
      return document;
    });
  platformMutationQueue = operation.catch(() => undefined);
  await operation;
}

async function recordProviderModelUsage(category, input, output = "") {
  if (!["web", "agent"].includes(category)) return;
  await recordPlatformUsage(category, {
    inputTokens: estimateContextTokens(String(input || "")),
    outputTokens: estimateContextTokens(String(output || "")),
  }).catch(() => undefined);
}

function usageSummary(document = {}) {
  const today = isoNow().slice(0, 10);
  const weekStart = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const categories = ["web", "agent", "embedding"];
  const blank = () => ({ requests: 0, inputTokens: 0, outputTokens: 0 });
  const totals = Object.fromEntries(categories.map((category) => [category, blank()]));
  const weekly = Object.fromEntries(categories.map((category) => [category, blank()]));
  const daily = Object.fromEntries(categories.map((category) => [category, blank()]));
  const series = Object.entries(document.days || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-14)
    .map(([date, values]) => ({
      date,
      ...Object.fromEntries(
        categories.map((category) => [category, { ...blank(), ...(values?.[category] || {}) }]),
      ),
    }));
  for (const [date, values] of Object.entries(document.days || {})) {
    for (const category of categories) {
      for (const field of ["requests", "inputTokens", "outputTokens"]) {
        const amount = Number(values?.[category]?.[field] || 0);
        totals[category][field] += amount;
        if (date >= weekStart) weekly[category][field] += amount;
        if (date === today) daily[category][field] += amount;
      }
    }
  }
  return { daily, weekly, total: totals, series };
}

async function adminPlatformSnapshot() {
  const [settings, secrets, usageDocument] = await Promise.all([
    readPlatformSettings(),
    readPlatformSecrets(),
    readJson(PLATFORM_USAGE_FILE, { days: {} }),
  ]);
  return {
    settings: {
      providers: {
        web: {
          ...settings.providers.web,
          configured: Boolean(settings.providers.web.baseUrl && secrets.webApiKey),
          apiKeyConfigured: Boolean(secrets.webApiKey),
        },
        agent: {
          ...settings.providers.agent,
          configured: Boolean(
            settings.providers.agent.baseUrl && secrets.agentApiKey,
          ),
          apiKeyConfigured: Boolean(secrets.agentApiKey),
        },
      },
      embedding: {
        ...settings.embedding,
        configured: Boolean(
          settings.embedding.baseUrl &&
            settings.embedding.model &&
            secrets.embeddingApiKey
        ),
        apiKeyConfigured: Boolean(secrets.embeddingApiKey),
      },
      ssh: settings.ssh,
    },
    usage: usageSummary(usageDocument),
  };
}

async function listAdminSshConnections() {
  const records = await listUserRecords();
  const rows = [];
  for (const record of records) {
    const actor = {
      id: record.id,
      authenticated: true,
      displayName: record.displayName,
      username: record.username,
    };
    const [state, persisted] = await Promise.all([
      getState(actor),
      readJson(sshWorkerRuntimePath(actor), {}),
    ]);
    const liveWorker = sshWorkerPool.get(sshWorkerKey(actor));
    const profiles = new Map(
      (state.settings?.servers || []).map((profile) => [profile.id, profile]),
    );
    const persistedSessions = new Map(
      (Array.isArray(persisted.sessions) ? persisted.sessions : []).map((session) => [
        safeSegment(session.serverId || ""),
        session,
      ]),
    );
    const serverIds = new Set([
      ...profiles.keys(),
      ...persistedSessions.keys(),
      ...(liveWorker ? liveWorker.sessions.keys() : []),
    ]);
    for (const serverId of serverIds) {
      const profile = profiles.get(serverId) || {};
      const storedSession = persistedSessions.get(serverId) || {};
      const liveSession = liveWorker?.sessions.get(serverId);
      const conversationCount = (state.conversations || []).filter(
        (conversation) =>
          String(conversation?.work?.serverId || "") === serverId &&
          conversation?.work?.connectionEnabled !== false,
      ).length;
      const activeTaskCount = liveWorker
        ? [...liveWorker.tasks.values()].filter(
            (task) => task.serverId === serverId && task.status === "running",
          ).length
        : 0;
      rows.push({
        id: `${record.id}:${serverId}`,
        userId: record.id,
        username: record.username,
        displayName: record.displayName,
        serverId,
        serverName: String(profile.name || storedSession.host || serverId),
        host: String(profile.host || storedSession.host || ""),
        port: Number(profile.port || storedSession.port || 22),
        status: liveSession?.status === "connected" ? "connected" : "disconnected",
        conversationCount,
        activeTaskCount,
        lastConnectedAt: String(
          liveSession?.lastConnectedAt || storedSession.lastConnectedAt || "",
        ),
        lastUserActivityAt: String(
          liveSession?.lastUserActivityAt || storedSession.lastUserActivityAt || "",
        ),
        disconnectReason: String(
          liveSession?.disconnectReason || storedSession.disconnectReason || "",
        ),
        manageable: Boolean(liveSession),
      });
    }
  }
  return rows.sort((left, right) => {
    if (left.status !== right.status) return left.status === "connected" ? -1 : 1;
    return `${left.username}\u0000${left.serverName}`.localeCompare(
      `${right.username}\u0000${right.serverName}`,
    );
  });
}

async function disconnectAdminSshConnection(userId, serverId) {
  const record = await readUserRecord(String(userId || ""));
  if (!record) return false;
  const actor = {
    id: record.id,
    authenticated: true,
    displayName: record.displayName,
    username: record.username,
  };
  const worker = sshWorkerPool.get(sshWorkerKey(actor));
  const session = worker?.sessions.get(safeSegment(serverId || ""));
  if (!session) return false;
  await closeSshSession(session);
  sessionSend(session, {
    type: "connection.status",
    serverId: session.serverId,
    status: "disconnected",
    label: "已由管理员断开",
  });
  return true;
}

function sshWorkerKey(actor) {
  return `${actor.authenticated ? "user" : "guest"}:${actor.id}`;
}

function sshWorkerRuntimePath(actor) {
  return path.join(actorDirectory(actor), "runtime", "ssh-worker.json");
}

function agentBindingsPath(actor) {
  return path.join(actorDirectory(actor), "runtime", "agent-bindings.json");
}

function memoryDocumentPath(actor) {
  return path.join(actorDirectory(actor), "memory", "memory.json");
}

function conversationTreePath(actor) {
  return path.join(actorDirectory(actor), "conversations", "tree.json");
}

function conversationTombstonePath(actor) {
  return path.join(
    actorDirectory(actor),
    "conversations",
    "deleted.json",
  );
}

function checkpointDocumentPath(actor) {
  return path.join(actorDirectory(actor), "memory", "checkpoints", "index.json");
}

function workspaceDocumentPath(actor) {
  return path.join(actorDirectory(actor), "workspaces", "index.json");
}

function workspaceIdFor(serverId, canonicalPath) {
  return `workspace-${crypto
    .createHash("sha256")
    .update(`${String(serverId || "")}\u0000${String(canonicalPath || "")}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function sshServerIdentity({ host = "", port = 22, serverId = "", demo = false } = {}) {
  const normalizedHost = String(host || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/\.$/, "");
  if (!normalizedHost || demo) return `profile:${safeSegment(serverId || "server")}`;
  return `ssh-endpoint-${crypto
    .createHash("sha256")
    .update(`${normalizedHost}\u0000${Number(port || 22)}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function workspaceVersionDomainIdFor(serverIdentity, versionRoot, canonicalPath) {
  const root = String(versionRoot || canonicalPath || "").trim();
  return `version-domain-${crypto
    .createHash("sha256")
    .update(`${String(serverIdentity || "")}\u0000${root}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function normalizedWorkspacePath(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const normalized = path.posix.normalize(input);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function workspacePathContains(parentPath, childPath) {
  const parent = normalizedWorkspacePath(parentPath);
  const child = normalizedWorkspacePath(childPath);
  if (!parent || !child) return false;
  return parent === "/" || child === parent || child.startsWith(`${parent}/`);
}

function workspaceRecordsOverlap(left, right) {
  if (!left || !right) return false;
  const leftServer = String(left.serverIdentity || left.serverId || "");
  const rightServer = String(right.serverIdentity || right.serverId || "");
  if (leftServer !== rightServer) return false;
  return (
    workspacePathContains(left.path, right.path) ||
    workspacePathContains(right.path, left.path)
  );
}

function workspaceRunConflict(activeRuns, conversationId, workspaceRecord) {
  return [...(activeRuns?.values?.() || activeRuns || [])].find(
    (run) => {
      if (
        String(run?.conversationId || "") === String(conversationId || "")
      ) {
        return true;
      }
      const sameServer =
        String(
          run?.serverIdentity ||
            run?.serverId ||
            workspaceRecord?.serverIdentity ||
            workspaceRecord?.serverId ||
            "",
        ) ===
        String(
          workspaceRecord?.serverIdentity || workspaceRecord?.serverId || "",
        );
      const sameVersionDomain = Boolean(
        sameServer &&
          run?.versionDomainId &&
          workspaceRecord?.versionDomainId &&
          String(run.versionDomainId) ===
            String(workspaceRecord.versionDomainId),
      );
      return (
        sameVersionDomain ||
        workspaceRecordsOverlap(
          {
            serverId: run?.serverId || workspaceRecord?.serverId,
            serverIdentity:
              run?.serverIdentity || workspaceRecord?.serverIdentity,
            path: run?.workspace || run?.path,
          },
          workspaceRecord,
        )
      );
    },
  );
}

function normalizeWorkspaceRecord(record = {}) {
  const serverId = safeSegment(record.serverId || "", "");
  const canonicalPath = normalizedWorkspacePath(record.path);
  if (!serverId || !canonicalPath) return null;
  const id = workspaceIdFor(serverId, canonicalPath);
  const serverIdentity = String(record.serverIdentity || serverId);
  const versionRoot = normalizedWorkspacePath(record.versionRoot) || undefined;
  const kind = record.kind === "virtual" ? "virtual" : "physical";
  return {
    id,
    serverId,
    serverIdentity,
    name:
      String(record.name || "").trim().slice(0, 120) ||
      path.posix.basename(canonicalPath) ||
      canonicalPath,
    path: canonicalPath,
    mode: ["managed", "attached", "unmanaged"].includes(
      String(record.mode || ""),
    )
      ? String(record.mode)
      : "unmanaged",
    kind,
    virtualConversationId:
      kind === "virtual"
        ? safeSegment(record.virtualConversationId || "", "") || undefined
        : undefined,
    versionRoot,
    versionDomainId: workspaceVersionDomainIdFor(
      serverIdentity,
      versionRoot,
      canonicalPath,
    ),
    writable: record.writable !== false,
    createdAt: String(record.createdAt || isoNow()),
    updatedAt: String(record.updatedAt || isoNow()),
    lastUsedAt: String(record.lastUsedAt || record.updatedAt || isoNow()),
  };
}

async function readWorkspaceDocument(actor) {
  const stored = await readJson(workspaceDocumentPath(actor), {});
  const records = Object.fromEntries(
    Object.values(stored.records || {})
      .map(normalizeWorkspaceRecord)
      .filter(Boolean)
      .map((record) => [record.id, record]),
  );
  return {
    schemaVersion: 2,
    updatedAt: String(stored.updatedAt || ""),
    records,
  };
}

async function updateWorkspaceDocument(actor, updater) {
  return enqueueActorMutation(workspaceMutationQueues, actor, async () => {
    const current = await readWorkspaceDocument(actor);
    const next = (await updater(current)) || current;
    next.schemaVersion = 2;
    next.updatedAt = isoNow();
    await writeJson(workspaceDocumentPath(actor), next);
    return next;
  });
}

function actorProfilePath(actorOrId) {
  const id = typeof actorOrId === "string" ? actorOrId : actorOrId.id;
  return path.join(DATA_ROOT, "users", safeSegment(id), "state", "profile.json");
}

function actorStatePath(actor, name) {
  return path.join(actorDirectory(actor), "state", `${safeSegment(name)}.json`);
}

function actorTaskDirectory(actor) {
  return path.join(actorDirectory(actor), "tasks");
}

function actorTaskPath(actor, runId) {
  return path.join(actorTaskDirectory(actor), `${safeRemoteRunId(runId)}.json`);
}

function actorCredentialPath(actor, name) {
  return path.join(
    actorDirectory(actor),
    "credentials",
    `${safeSegment(name)}.json`,
  );
}

function actorAttachmentPath(actor, ...segments) {
  return path.join(actorDirectory(actor), "attachments", ...segments);
}

async function readCheckpointDocument(actor) {
  const stored = await readJson(checkpointDocumentPath(actor), {});
  return {
    updatedAt: String(stored.updatedAt || ""),
    checkpoints:
      stored.checkpoints && typeof stored.checkpoints === "object"
        ? stored.checkpoints
        : {},
  };
}

async function updateCheckpointDocument(actor, updater) {
  return enqueueActorMutation(checkpointMutationQueues, actor, async () => {
    const document = await readCheckpointDocument(actor);
    const next = (await updater(document)) || document;
    next.updatedAt = isoNow();
    await writeJson(checkpointDocumentPath(actor), next);
    return next;
  });
}

async function appendConversationTreeNode(actor, node) {
  return enqueueActorMutation(
    conversationTreeMutationQueues,
    actor,
    async () => {
      const stored = await readJson(conversationTreePath(actor), {});
      const document = {
        updatedAt: isoNow(),
        nodes:
          stored.nodes && typeof stored.nodes === "object"
            ? stored.nodes
            : {},
      };
      document.nodes[node.conversationId] = node;
      await writeJson(conversationTreePath(actor), document);
      return node;
    },
  );
}

async function pruneConversationTreeDescendants(
  actor,
  parentConversationId,
  parentMessageIds = [],
) {
  return enqueueActorMutation(
    conversationTreeMutationQueues,
    actor,
    async () => {
      const stored = await readJson(conversationTreePath(actor), {});
      const nodes =
        stored.nodes && typeof stored.nodes === "object" ? stored.nodes : {};
      const messageIds = new Set(parentMessageIds.filter(Boolean).map(String));
      const removed = new Set(
        Object.values(nodes)
          .filter(
            (node) =>
              String(node?.parentConversationId || "") ===
                String(parentConversationId || "") &&
              (!messageIds.size ||
                messageIds.has(String(node?.parentMessageId || ""))),
          )
          .map((node) => String(node.conversationId || ""))
          .filter(Boolean),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of Object.values(nodes)) {
          const id = String(node?.conversationId || "");
          if (
            id &&
            !removed.has(id) &&
            removed.has(String(node?.parentConversationId || ""))
          ) {
            removed.add(id);
            changed = true;
          }
        }
      }
      for (const id of removed) delete nodes[id];
      await writeJson(conversationTreePath(actor), {
        updatedAt: isoNow(),
        nodes,
      });
      return [...removed];
    },
  );
}

async function readMemoryDocument(actor) {
  const stored = await readJson(memoryDocumentPath(actor), {});
  return normalizeMemoryDocument(stored);
}

async function updateMemoryDocument(actor, updater) {
  return enqueueActorMutation(memoryMutationQueues, actor, async () => {
    const current = await readMemoryDocument(actor);
    const next = normalizeMemoryDocument((await updater(current)) || current);
    await writeJson(memoryDocumentPath(actor), next);
    return next;
  });
}

function agentBindingKey({ serverId, workspaceId, agentId, conversationId }) {
  return [serverId, workspaceId, agentId, conversationId]
    .map((value) => String(value || ""))
    .join("::");
}

function createAgentSyncCursor({
  state,
  memoryDocument,
  conversationId,
  lastMessageId,
  taskId,
  checkpointId,
  deliveredContent,
  deliveredMemoryRecords = [],
  memoryEnabled = true,
  previous,
}) {
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  const messageIndex = (conversation?.messages || []).findIndex(
    (message) => String(message.id) === String(lastMessageId),
  );
  const contentHash = deliveredContent
    ? crypto.createHash("sha256").update(String(deliveredContent)).digest("hex")
    : "";
  return {
    projectRevision: Number(memoryDocument?.revision || 0),
    conversationEventSeq: messageIndex >= 0 ? messageIndex + 1 : 0,
    conversationCheckpointVersion:
      findConversationSummary(memoryDocument, conversationId)?.updatedAt || "",
    workspaceRevision: String(checkpointId || ""),
    contextEpoch: Number(previous?.contextEpoch || 0),
    memoryEnabled: Boolean(memoryEnabled),
    memoryVersions: memoryEnabled
      ? Object.fromEntries([
          ...Object.entries(previous?.memoryVersions || {}).filter(
            ([key]) => key !== "document",
          ),
          ...deliveredMemoryRecords.map((record) => [
            String(record.id),
            Number(record.revision || 0),
          ]),
        ])
      : {},
    memoryStatuses: memoryEnabled
      ? Object.fromEntries([
          ...Object.entries(previous?.memoryStatuses || {}),
          ...deliveredMemoryRecords.map((record) => [
            String(record.id),
            String(record.status || "active"),
          ]),
        ])
      : {},
    lastMessageId: String(lastMessageId || ""),
    deliveredTaskIds: [
      ...new Set([...(previous?.deliveredTaskIds || []), taskId].filter(Boolean)),
    ].slice(-200),
    deliveredContentHashes: [
      ...new Set(
        [
          ...(previous?.deliveredContentHashes || []),
          contentHash,
          ...(Array.isArray(deliveredContent) ? deliveredContent : [])
            .filter(Boolean)
            .map((content) =>
              crypto.createHash("sha256").update(String(content)).digest("hex"),
            ),
        ].filter(Boolean),
      ),
    ].slice(-400),
  };
}

async function readAgentBindings(actor) {
  const stored = await readJson(agentBindingsPath(actor), {});
  return {
    updatedAt: String(stored.updatedAt || ""),
    bindings:
      stored.bindings && typeof stored.bindings === "object"
        ? stored.bindings
        : {},
  };
}

async function updateAgentBinding(actor, bindingKey, updater) {
  return enqueueActorMutation(agentBindingMutationQueues, actor, async () => {
    const document = await readAgentBindings(actor);
    const current = document.bindings[bindingKey] || null;
    const next = updater(current);
    if (next) document.bindings[bindingKey] = next;
    else delete document.bindings[bindingKey];
    document.updatedAt = isoNow();
    await writeJson(agentBindingsPath(actor), document);
    return next;
  });
}

async function removeAgentBindingsForConversations(
  actor,
  conversationIds,
  { shouldRemove } = {},
) {
  const ids = new Set(conversationIds.filter(Boolean).map(String));
  if (!ids.size) return { bindings: [], nativeSessions: [] };
  const removed = await enqueueActorMutation(
    agentBindingMutationQueues,
    actor,
    async () => {
      const document = await readAgentBindings(actor);
      const matches = [];
      for (const [key, binding] of Object.entries(document.bindings)) {
        if (!ids.has(String(binding?.conversationId || ""))) continue;
        if (shouldRemove && !shouldRemove(binding)) continue;
        matches.push({ key, binding });
        delete document.bindings[key];
      }
      document.updatedAt = isoNow();
      await writeJson(agentBindingsPath(actor), document);
      return matches;
    },
  );
  const removedKeys = new Set(removed.map((item) => item.key));
  const worker = await getSshWorker(actor);
  const nativeSessions = [];
  for (const session of worker.sessions.values()) {
    for (const [key] of session.agentSessions || []) {
      if (removedKeys.has(key)) {
        session.agentSessions.delete(key);
      }
    }
  }
  for (const { binding } of removed) {
    const session = worker.sessions.get(safeSegment(binding.serverId || ""));
    if (
      (binding.adapter !== "opencode" &&
        !String(binding.agentId || "").startsWith("opencode")) ||
      !binding.agentSessionId ||
      !session?.client ||
      session.status !== "connected"
    ) {
      nativeSessions.push({
        agentSessionId: binding.agentSessionId,
        status: "detached",
      });
      continue;
    }
    try {
      const agent = (await scanRemoteAgents(session, actor)).find(
        (item) => item.id === binding.agentId && item.status === "ready",
      );
      if (!agent) throw new Error("Agent 当前不可用");
      const service = await ensureOpenCodeService(session, agent);
      await openCodeServiceRequest(session, service, {
        method: "DELETE",
        endpoint: `/session/${encodeURIComponent(binding.agentSessionId)}`,
        directory: binding.workspace,
      });
      nativeSessions.push({
        agentSessionId: binding.agentSessionId,
        status: "deleted",
      });
    } catch (caught) {
      nativeSessions.push({
        agentSessionId: binding.agentSessionId,
        status: "detached",
        diagnostic: caught instanceof Error ? caught.message : "原生会话删除失败",
      });
    }
  }
  scheduleSshWorkerPersist(worker, 0);
  return {
    bindings: removed.map((item) => item.binding),
    nativeSessions,
  };
}

async function removeWorkerTasks(actor, runIds) {
  const ids = new Set(runIds.filter(Boolean).map(String));
  if (!ids.size) return;
  const worker = await getSshWorker(actor);
  for (const runId of ids) {
    worker.tasks.delete(runId);
    await rm(actorTaskPath(actor, runId), { force: true }).catch(() => undefined);
  }
  scheduleSshWorkerPersist(worker, 0);
}

async function removeManagedBranchWorkspaces(actor, conversations) {
  const worker = await getSshWorker(actor);
  const removedWorkspaceIds = new Set();
  for (const conversation of conversations) {
    if (conversation?.work?.workspaceMode !== "managed") continue;
    const session = worker.sessions.get(safeSegment(conversation.work.serverId || ""));
    const conversationSegment = safeSegment(conversation.id, "conversation");
    const workspace = String(conversation.work.workspace || "");
    const home = String(session?.home || "");
    if (!home) continue;
    const virtual = conversation.work.workspaceKind === "virtual";
    const expectedRoot = virtual
      ? `${home}/.easywork/virtual/${conversationSegment}`
      : `${home}/.easywork/worktrees/${conversationSegment}`;
    const expectedWorkspaceRoot = virtual ? expectedRoot : `${expectedRoot}/main`;
    if (workspace !== expectedWorkspaceRoot && !workspace.startsWith(`${expectedWorkspaceRoot}/`)) continue;
    if (session?.client && session.status === "connected") {
      await remoteExec(
        session.client,
        [
          "set -eu",
          `EW_TARGET=${shellQuote(expectedRoot)}`,
          `EW_EXPECTED=${shellQuote(expectedRoot)}`,
          'test "$EW_TARGET" = "$EW_EXPECTED"',
          virtual
            ? 'case "$EW_TARGET" in "$HOME/.easywork/virtual/"*) rm -rf -- "$EW_TARGET" ;; *) exit 91 ;; esac'
            : 'case "$EW_TARGET" in "$HOME/.easywork/worktrees/"*) rm -rf -- "$EW_TARGET" ;; *) exit 91 ;; esac',
        ].join("\n"),
      ).catch(() => undefined);
    }
    if (conversation.work.workspaceId) {
      removedWorkspaceIds.add(String(conversation.work.workspaceId));
    }
  }
  if (removedWorkspaceIds.size) {
    await updateWorkspaceDocument(actor, (document) => {
      for (const workspaceId of removedWorkspaceIds) {
        delete document.records[workspaceId];
      }
      return document;
    });
  }
}

function createSshSession(worker, serverId, stored = {}) {
  const safeServerId = safeSegment(serverId || "default-server");
  const host = String(stored.host || "");
  const port = Number(stored.port || 22);
  const demo = Boolean(stored.demo);
  return {
    poolKey: `${worker.key}:${safeServerId}`,
    actorKey: worker.key,
    worker,
    serverId: safeServerId,
    socketId: crypto.randomUUID(),
    client: null,
    demo,
    status: "disconnected",
    home: "",
    host,
    port,
    serverIdentity: String(
      stored.serverIdentity ||
        sshServerIdentity({ host, port, serverId: safeServerId, demo }),
    ),
    username: String(stored.username || ""),
    latency: undefined,
    fingerprint: "",
    activeRun: null,
    activeRuns: new Map(),
    runtime: null,
    openCodeServices: new Map(),
    openCodeServicePromises: new Map(),
    apiRelays: new Map(),
    providerRoute: null,
    agentSessions: new Map(Object.entries(stored.agentSessions || {})),
    agentUpdates: new Map(),
    lastConnectedAt: String(stored.lastConnectedAt || ""),
    lastDisconnectedAt: String(stored.lastDisconnectedAt || ""),
    lastUserActivityAt: String(
      stored.lastUserActivityAt || stored.lastConnectedAt || isoNow(),
    ),
    disconnectReason: String(stored.disconnectReason || ""),
  };
}

function serializeSshWorker(worker) {
  return {
    workerId: worker.id,
    actorKey: worker.key,
    updatedAt: isoNow(),
    sessions: [...worker.sessions.values()].map((session) => ({
      serverId: session.serverId,
      status: session.status,
      host: session.host,
      port: session.port,
      serverIdentity: session.serverIdentity,
      username: session.username,
      demo: session.demo,
      lastConnectedAt: session.lastConnectedAt,
      lastDisconnectedAt: session.lastDisconnectedAt,
      lastUserActivityAt: session.lastUserActivityAt,
      disconnectReason: session.disconnectReason,
      agentSessions: Object.fromEntries(session.agentSessions || []),
    })),
  };
}

function persistSshWorker(worker) {
  const snapshot = serializeSshWorker(worker);
  worker.persistQueue = worker.persistQueue
    .catch(() => undefined)
    .then(async () => {
      await writeJson(sshWorkerRuntimePath(worker.actor), snapshot);
      await Promise.all(
        [...worker.tasks.values()].map((task) =>
          writeJson(actorTaskPath(worker.actor, task.runId), {
            ...task,
            events: Array.isArray(task.events) ? task.events.slice(-600) : [],
          }),
        ),
      );
    });
  return worker.persistQueue;
}

function scheduleSshWorkerPersist(worker, delay = 120) {
  if (worker.persistTimer) return;
  worker.persistTimer = setTimeout(() => {
    worker.persistTimer = null;
    void persistSshWorker(worker).catch(() => undefined);
  }, delay);
  worker.persistTimer.unref?.();
}

async function getSshWorker(actor) {
  const key = sshWorkerKey(actor);
  let worker = sshWorkerPool.get(key);
  if (!worker) {
    worker = {
      id: randomId("ssh-worker-"),
      key,
      actor: { ...actor },
      sockets: new Set(),
      sessions: new Map(),
      tasks: new Map(),
      hydrated: false,
      persistTimer: null,
      persistQueue: Promise.resolve(),
    };
    sshWorkerPool.set(key, worker);
  } else {
    worker.actor = { ...actor };
  }
  if (!worker.hydrated) {
    const stored = await readJson(sshWorkerRuntimePath(actor), {});
    worker.id = String(stored.workerId || worker.id);
    for (const item of Array.isArray(stored.sessions) ? stored.sessions : []) {
      const session = createSshSession(worker, item.serverId, item);
      worker.sessions.set(session.serverId, session);
    }
    const taskEntries = await readdir(actorTaskDirectory(actor), {
      withFileTypes: true,
    }).catch(() => []);
    const storedTasks = await Promise.all(
      taskEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readJson(path.join(actorTaskDirectory(actor), entry.name), null),
        ),
    );
    for (const task of storedTasks.filter(Boolean)) {
      if (!task?.runId || !task?.conversationId) continue;
      worker.tasks.set(String(task.runId), {
        ...task,
        recoveredAfterRestart: task.status === "running",
        status: task.status,
        recoveryStatus: task.status === "running" ? "pending" : undefined,
        events: Array.isArray(task.events) ? task.events : [],
        appendedInstructions: Array.isArray(task.appendedInstructions)
          ? task.appendedInstructions
          : [],
      });
    }
    worker.hydrated = true;
    scheduleSshWorkerPersist(worker, 0);
  }
  return worker;
}

function touchSshSession(session) {
  session.lastUserActivityAt = isoNow();
  session.disconnectReason = "";
  scheduleSshWorkerPersist(session.worker);
}

async function resolveActor(req, res, createGuest = true) {
  const cookies = cookieMap(req.headers.cookie);
  const signedActorId = verifySession(requestSessionToken(req) || cookies.ew_session);
  if (signedActorId) {
    const record = await readUserRecord(signedActorId);
    if (record) {
      return {
        id: record.id,
        authenticated: true,
        displayName: record.displayName,
        username: record.username,
        avatar: record.avatar || undefined,
        isAdmin: await isAdminUsername(record.username),
      };
    }
  }
  let guestId = /^[a-f0-9-]{20,}$/i.test(signedActorId || "")
    ? signedActorId
    : /^[a-f0-9-]{20,}$/i.test(cookies.ew_guest || "")
      ? cookies.ew_guest
      : "";
  if (!guestId && createGuest) {
    guestId = crypto.randomUUID();
    res.setHeader("Set-Cookie", cookie("ew_guest", guestId, req, { maxAge: SESSION_MAX_AGE }));
  }
  return {
    id: guestId || "anonymous",
    authenticated: false,
    displayName: "未登录",
  };
}

function normalizeModelProvider(value = {}, index = 0) {
  const fallbackId = index === 0 ? DEFAULT_PROVIDER_ID : `provider-${index + 1}`;
  return {
    id: safeSegment(value.id || fallbackId, fallbackId),
    name: String(value.name || `API ${index + 1}`).trim().slice(0, 80) ||
      `API ${index + 1}`,
    baseUrl: String(value.baseUrl || "https://api.openai.com/v1").trim(),
    model: String(value.model || "").trim(),
    modelContextLimit: positiveInteger(value.modelContextLimit) || undefined,
    modelOutputLimit: positiveInteger(value.modelOutputLimit) || undefined,
    protocol:
      value.protocol === "chat-completions" || value.protocol === "responses"
        ? value.protocol
        : "auto",
    configured: Boolean(value.configured),
    audience:
      value.audience === "web" || value.audience === "agent"
        ? value.audience
        : "both",
    managedBy: value.managedBy === "platform" ? "platform" : "user",
  };
}

function normalizeProviderSettings(settings = {}) {
  const source = Array.isArray(settings?.providers) && settings.providers.length
    ? settings.providers
    : [{}];
  const providers = source.map((provider, index) =>
    normalizeModelProvider(provider, index),
  );
  const requestedActiveId = safeSegment(
    settings?.activeProviderId || providers[0]?.id || DEFAULT_PROVIDER_ID,
    DEFAULT_PROVIDER_ID,
  );
  const activeProvider =
    providers.find((item) => item.id === requestedActiveId) || providers[0];
  return {
    ...settings,
    providers,
    activeProviderId: activeProvider.id,
  };
}

function modelProviderFor(settings = {}, providerId = "") {
  const normalized = normalizeProviderSettings(settings);
  return (
    normalized.providers.find(
      (provider) => provider.id === safeSegment(providerId, normalized.activeProviderId),
    ) || normalized.providers[0]
  );
}

function providerApiKeyFor(secrets = {}, providerId = DEFAULT_PROVIDER_ID) {
  const id = safeSegment(providerId, DEFAULT_PROVIDER_ID);
  return String(secrets.providerApiKeys?.[id] || "");
}

async function getSecrets(actor) {
  const stored = await readJson(actorCredentialPath(actor, "secrets"), {});
  const sshCredentials = {};
  for (const [serverId, credential] of Object.entries(stored.sshCredentials || {})) {
    sshCredentials[serverId] = {
      privateKey: decryptString(credential?.privateKey),
      password: decryptString(credential?.password),
    };
  }
  const providerApiKeys = Object.fromEntries(
    Object.entries(stored.providerApiKeys || {}).map(([providerId, value]) => [
      safeSegment(providerId, DEFAULT_PROVIDER_ID),
      decryptString(value),
    ]),
  );
  return {
    providerApiKeys,
    embeddingApiKey: decryptString(stored.embeddingApiKey),
    sshCredentials,
  };
}

async function platformProviderAccess(providerId, selectedModel = "") {
  const settings = await readPlatformSettings();
  const secrets = await readPlatformSecrets();
  const audience = providerId === PLATFORM_AGENT_PROVIDER_ID ? "agent" : "web";
  const provider = settings.providers[audience];
  const apiKey = audience === "agent" ? secrets.agentApiKey : secrets.webApiKey;
  return {
    provider: {
      ...provider,
      model: String(selectedModel || provider.model || "").trim(),
      configured: Boolean(provider.baseUrl && apiKey),
    },
    apiKey,
    category: audience,
  };
}

async function effectiveProviderAccess(actor, settings = {}, providerId = "") {
  const requestedProviderId = safeSegment(
    providerId || settings?.activeProviderId || "",
    "",
  );
  if ([PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(requestedProviderId)) {
    const selected = (settings?.providers || []).find(
      (candidate) => candidate.id === requestedProviderId,
    );
    return platformProviderAccess(requestedProviderId, selected?.model || "");
  }
  const provider = modelProviderFor(settings, providerId);
  if (
    provider.managedBy === "platform" ||
    [PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(provider.id)
  ) {
    return platformProviderAccess(provider.id, provider.model);
  }
  const secrets = await getSecrets(actor);
  const access = {
    provider,
    apiKey: providerApiKeyFor(secrets, provider.id),
    category: "user",
  };
  if (!access.apiKey && provider.audience !== "agent") {
    const sharedWeb = await platformProviderAccess(PLATFORM_WEB_PROVIDER_ID);
    if (sharedWeb.provider.configured) return sharedWeb;
  }
  return access;
}

async function platformEmbeddingAccess() {
  const settings = await readPlatformSettings();
  const secrets = await readPlatformSecrets();
  return {
    config: {
      ...settings.embedding,
      configured: Boolean(
        settings.embedding.baseUrl &&
          settings.embedding.model &&
          secrets.embeddingApiKey
      ),
    },
    apiKey: secrets.embeddingApiKey,
  };
}

async function updateSecrets(actor, patch) {
  return enqueueActorMutation(secretMutationQueues, actor, async () => {
    const secretPath = actorCredentialPath(actor, "secrets");
    const stored = await readJson(secretPath, {});
    const next = { ...stored };
    if (patch.providerCredential?.providerId && patch.providerCredential?.apiKey) {
      const providerId = safeSegment(
        patch.providerCredential.providerId,
        DEFAULT_PROVIDER_ID,
      );
      next.providerApiKeys ||= {};
      next.providerApiKeys[providerId] = encryptString(
        patch.providerCredential.apiKey,
      );
    }
    if (typeof patch.embeddingApiKey === "string" && patch.embeddingApiKey) {
      next.embeddingApiKey = encryptString(patch.embeddingApiKey);
    }
    if (
      patch.sshCredential?.serverId &&
      (patch.sshCredential?.privateKey || patch.sshCredential?.password)
    ) {
      next.sshCredentials ||= {};
      next.sshCredentials[safeSegment(patch.sshCredential.serverId)] = {
        privateKey: patch.sshCredential.privateKey
          ? encryptString(patch.sshCredential.privateKey)
          : undefined,
        password: patch.sshCredential.password
          ? encryptString(patch.sshCredential.password)
          : undefined,
        updatedAt: isoNow(),
      };
    }
    if (patch.removeSshCredentialId) {
      const serverId = safeSegment(patch.removeSshCredentialId);
      if (next.sshCredentials) delete next.sshCredentials[serverId];
    }
    await writeJson(secretPath, next);
  });
}

async function getState(actor) {
  const [settings, projects, conversations, skills, files] = await Promise.all([
    readJson(actorStatePath(actor, "settings"), {}),
    readJson(actorStatePath(actor, "projects"), []),
    readJson(path.join(actorDirectory(actor), "conversations", "index.json"), []),
    readJson(actorStatePath(actor, "skills"), []),
    readJson(actorAttachmentPath(actor, "files.json"), []),
  ]);
  return {
    settings: normalizeProviderSettings(settings),
    projects,
    conversations,
    skills,
    files,
  };
}

function conversationTimestamp(conversation) {
  const value = Date.parse(
    conversation?.updatedAt || conversation?.createdAt || "",
  );
  return Number.isFinite(value) ? value : 0;
}

function mergeConversationCollections(stored = [], incoming = [], tombstones = {}) {
  const deletedIds = new Set(Object.keys(tombstones?.ids || {}));
  const storedItems = Array.isArray(stored)
    ? stored.filter((item) => item?.id && !deletedIds.has(String(item.id)))
    : [];
  const incomingItems = Array.isArray(incoming)
    ? incoming.filter((item) => item?.id && !deletedIds.has(String(item.id)))
    : [];
  const storedById = new Map(storedItems.map((item) => [String(item.id), item]));
  const incomingById = new Map(
    incomingItems.map((item) => [String(item.id), item]),
  );
  const incomingOnly = incomingItems.filter(
    (item) => !storedById.has(String(item.id)),
  );
  const mergedStored = storedItems.map((storedItem) => {
    const incomingItem = incomingById.get(String(storedItem.id));
    if (!incomingItem) return storedItem;
    const storedTime = conversationTimestamp(storedItem);
    const incomingTime = conversationTimestamp(incomingItem);
    if (incomingTime < storedTime) return storedItem;
    return {
      ...storedItem,
      ...incomingItem,
      branch: incomingItem.branch || storedItem.branch,
      work:
        incomingItem.work || storedItem.work
          ? { ...(storedItem.work || {}), ...(incomingItem.work || {}) }
          : undefined,
    };
  });
  return [...incomingOnly, ...mergedStored];
}

async function readConversationTombstones(actor) {
  const stored = await readJson(conversationTombstonePath(actor), {});
  return {
    updatedAt: String(stored.updatedAt || ""),
    ids: stored.ids && typeof stored.ids === "object" ? stored.ids : {},
  };
}

async function tombstoneConversation(actor, conversationId) {
  return enqueueActorMutation(stateMutationQueues, actor, async () => {
    const document = await readConversationTombstones(actor);
    document.updatedAt = isoNow();
    document.ids[safeSegment(conversationId)] = document.updatedAt;
    await writeJson(conversationTombstonePath(actor), document);
    return document;
  });
}

async function saveState(actor, state) {
  const safeState = JSON.parse(JSON.stringify(state || {}));
  safeState.settings = normalizeProviderSettings(safeState.settings || {});
  for (const provider of safeState?.settings?.providers || []) {
    delete provider.apiKey;
  }
  if (safeState?.settings?.embedding) delete safeState.settings.embedding.apiKey;
  await Promise.all([
    writeJson(actorStatePath(actor, "settings"), safeState.settings || {}),
    writeJson(actorStatePath(actor, "projects"), safeState.projects || []),
    writeJson(
      path.join(actorDirectory(actor), "conversations", "index.json"),
      safeState.conversations || [],
    ),
    writeJson(actorStatePath(actor, "skills"), safeState.skills || []),
    writeJson(actorAttachmentPath(actor, "files.json"), safeState.files || []),
  ]);
  delete safeState.memories;
  delete safeState.memorySummary;
  return safeState;
}

async function updateState(actor, updater) {
  return enqueueActorMutation(stateMutationQueues, actor, async () => {
    const current = await getState(actor);
    const next = (await updater(current)) || current;
    return saveState(actor, next);
  });
}

async function persistServerProfile(actor, input, requestedId) {
  const serverId = safeSegment(requestedId || input.id || randomId("server-"));
  const host = String(input.host || "").trim();
  const username = String(input.username || "").trim();
  const port = Number(input.port || 22);
  const authMethod = input.authMethod === "password" ? "password" : "key";
  if (!host || !username) throw new Error("服务器地址和用户名不能为空");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH 端口无效");
  }

  const stateBefore = await getState(actor);
  const profilesBefore = Array.isArray(stateBefore?.settings?.servers)
    ? stateBefore.settings.servers
    : [];
  const current = profilesBefore.find((profile) => profile.id === serverId);
  const credentialTargetChanged = Boolean(
    current &&
      (current.host !== host ||
        Number(current.port || 22) !== port ||
        current.username !== username ||
        (current.authMethod || "key") !== authMethod),
  );
  if (credentialTargetChanged) {
    await updateSecrets(actor, { removeSshCredentialId: serverId });
  }
  const incomingPrivateKey =
    authMethod === "key" ? String(input.privateKey || "") : "";
  const incomingPassword =
    authMethod === "password" ? String(input.password || "") : "";
  if (incomingPrivateKey || incomingPassword) {
    await updateSecrets(actor, {
      sshCredential: {
        serverId,
        privateKey: incomingPrivateKey || undefined,
        password: incomingPassword || undefined,
      },
    });
  }
  const secrets = await getSecrets(actor);
  const credential = secrets.sshCredentials?.[serverId];
  let savedProfile;
  await updateState(actor, (state) => {
    state.settings ||= {};
    const profiles = Array.isArray(state.settings.servers)
      ? state.settings.servers
      : [];
    savedProfile = {
      id: serverId,
      name: String(input.name || host).trim().slice(0, 80) || host,
      host,
      port,
      username,
      authMethod,
      keyName: String(
        authMethod === "key" ? input.keyName || current?.keyName || "" : "",
      ).slice(0, 160),
      configured: Boolean(
        authMethod === "key" ? credential?.privateKey : credential?.password,
      ),
      lastConnectedAt: current?.lastConnectedAt,
    };
    state.settings.servers = [
      savedProfile,
      ...profiles.filter((profile) => profile.id !== serverId),
    ];
    state.settings.lastServerId = serverId;
    return state;
  });
  return savedProfile;
}

async function stateForClient(actor) {
  const state = await getState(actor);
  const secrets = await getSecrets(actor);
  const platform = await readPlatformSettings();
  const platformSecrets = await readPlatformSecrets();
  const memoryDocument = await readMemoryDocument(actor);
  state.settings = normalizeProviderSettings(state.settings || {});
  const userProviders = state.settings.providers
    .filter(
      (provider) =>
        provider.managedBy !== "platform" &&
        ![PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(provider.id),
    )
    .map((provider) => ({
      ...provider,
      audience: provider.audience || "both",
      managedBy: "user",
      configured: Boolean(providerApiKeyFor(secrets, provider.id)),
    }));
  const storedPlatformSelections = new Map(
    state.settings.providers
      .filter(
        (provider) =>
          provider.managedBy === "platform" ||
          [PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(provider.id),
      )
      .map((provider) => [provider.id, provider]),
  );
  const platformProviders = [
    {
      ...platform.providers.web,
      model:
        storedPlatformSelections.get(PLATFORM_WEB_PROVIDER_ID)?.model ||
        platform.providers.web.model,
      configured: Boolean(
        platform.providers.web.baseUrl && platformSecrets.webApiKey,
      ),
    },
    {
      ...platform.providers.agent,
      model:
        storedPlatformSelections.get(PLATFORM_AGENT_PROVIDER_ID)?.model ||
        platform.providers.agent.model,
      configured: Boolean(
        platform.providers.agent.baseUrl && platformSecrets.agentApiKey,
      ),
    },
  ].filter((provider) => provider.configured);
  state.settings.providers = [...userProviders, ...platformProviders];
  if (!state.settings.providers.length) {
    state.settings.providers = [normalizeModelProvider({}, 0)];
  }
  const requestedProvider = state.settings.providers.find(
    (provider) => provider.id === state.settings.activeProviderId,
  );
  const activeProvider =
    (requestedProvider?.configured ? requestedProvider : null) ||
    state.settings.providers.find(
      (provider) => provider.configured && provider.audience !== "agent",
    ) ||
    requestedProvider ||
    state.settings.providers.find((provider) => provider.audience !== "agent") ||
    state.settings.providers[0];
  state.settings.activeProviderId = activeProvider.id;
  const embeddingAccess = await platformEmbeddingAccess();
  state.settings.embedding = embeddingAccess.config;
  if (Array.isArray(state?.settings?.servers)) {
    state.settings.servers = state.settings.servers.map((profile) => ({
      ...profile,
      configured: Boolean(
        secrets.sshCredentials?.[safeSegment(profile.id)]?.privateKey ||
          secrets.sshCredentials?.[safeSegment(profile.id)]?.password,
      ),
    }));
  }
  const manageableMemoryRecords = memoryDocument.records.filter(
    (record) => record.status !== "deleted",
  );
  const visibleMemoryRecords = activeMemoryRecords(memoryDocument);
  state.memories = manageableMemoryRecords.map((record) => ({
    id: record.id,
    content: record.content,
    scope: record.scope,
    scopeId: record.scopeId,
    projectId: record.scope === "project" ? record.scopeId : undefined,
    kind: record.kind,
    source: record.source,
    confidence: Number(record.confidence || 0),
    enabled: record.status !== "disabled",
    portability: record.portability,
    authority: record.authority,
    sensitivity: record.sensitivity,
    validUntil: record.validUntil,
    updatedAt: record.updatedAt,
  }));
  state.memorySummary =
    memoryDocument.overview ||
    visibleMemoryRecords
      .slice(0, 4)
      .map((record) => record.summary || record.content)
      .join("；");
  return state;
}

function allowedOrigin(origin) {
  if (!origin) return "*";
  const configured = String(process.env.EASYWORK_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return origin;
  try {
    const url = new URL(origin);
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return origin;
  } catch {
    return "null";
  }
  return configured.length ? "null" : origin;
}

function applyCors(req, res) {
  const origin = allowedOrigin(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-EasyWork-Device-Id",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

async function parseJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error("请求内容超过 36 MB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("JSON 格式无效");
    error.statusCode = 400;
    throw error;
  }
}

async function extractText(buffer, filename, mime = "") {
  const extension = path.extname(filename).toLowerCase();
  if (
    mime.startsWith("text/") ||
    [".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html"].includes(
      extension,
    )
  ) {
    return buffer.toString("utf8");
  }
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (extension === ".pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }
  return "";
}

function chunksFromText(
  text,
  maxChars = 3000,
  overlap = 600,
  strategy = "semantic",
) {
  const cleaned = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!cleaned) return [];
  const chunks = [];
  let cursor = 0;
  while (cursor < cleaned.length) {
    let end = Math.min(cursor + maxChars, cleaned.length);
    if (end < cleaned.length && strategy !== "fixed") {
      const candidates =
        strategy === "paragraph"
          ? [cleaned.lastIndexOf("\n\n", end)]
          : [
              cleaned.lastIndexOf("\n\n", end),
              cleaned.lastIndexOf("。", end),
              cleaned.lastIndexOf("！", end),
              cleaned.lastIndexOf("？", end),
              cleaned.lastIndexOf(". ", end),
              cleaned.lastIndexOf("\n", end),
            ];
      const boundary = Math.max(...candidates);
      if (boundary > cursor + maxChars * 0.55) end = boundary + 1;
    }
    chunks.push(cleaned.slice(cursor, end).trim());
    if (end >= cleaned.length) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

function apiUrl(baseUrl, endpoint) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function assertApiKeyShape(apiKey) {
  if (/^https?:\/\//i.test(String(apiKey || "").trim())) {
    const error = new Error("API Key 不能填写 URL");
    error.statusCode = 400;
    throw error;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function providerModelDescriptor(item) {
  const id =
    typeof item === "string"
      ? item
      : String(item?.id || item?.model || item?.model_id || item?.name || "");
  if (!id) return null;
  const limit = item?.limit && typeof item.limit === "object" ? item.limit : {};
  const contextLimit = positiveInteger(
    limit.context ??
      item?.context_window ??
      item?.contextWindow ??
      item?.context_length ??
      item?.contextLength ??
      item?.max_context_tokens ??
      item?.maxContextTokens ??
      item?.max_input_tokens ??
      item?.maxInputTokens,
  );
  const outputLimit = positiveInteger(
    limit.output ??
      item?.max_output_tokens ??
      item?.maxOutputTokens ??
      item?.max_completion_tokens ??
      item?.maxCompletionTokens,
  );
  return {
    id,
    contextLimit: contextLimit || undefined,
    outputLimit: outputLimit || undefined,
  };
}

async function listProviderModelDescriptors(baseUrl, apiKey) {
  assertApiKeyShape(apiKey);
  const response = await fetch(apiUrl(baseUrl, "models"), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const diagnostic = (await response.text()).slice(0, 300);
    const error = new Error(
      `模型列表接口返回 ${response.status}${diagnostic ? `：${diagnostic}` : ""}`,
    );
    error.statusCode = 502;
    throw error;
  }
  const payload = await response.json();
  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const descriptors = new Map();
  for (const item of source) {
    const descriptor = providerModelDescriptor(item);
    if (!descriptor) continue;
    const previous = descriptors.get(descriptor.id) || {};
    descriptors.set(descriptor.id, { ...previous, ...descriptor });
  }
  return [...descriptors.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

async function callEmbedding(config, apiKey, inputs) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const payload = {
    model: config.model,
    input: list,
  };
  const dimensions = Number(config.dimensions);
  if (Number.isFinite(dimensions) && dimensions > 0) payload.dimensions = dimensions;
  const response = await fetch(apiUrl(config.baseUrl, "embeddings"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Embedding API 返回 ${response.status}`);
  }
  const result = await response.json();
  return Array.isArray(result.data) ? result.data.map((item) => item.embedding) : [];
}

async function indexLibraryFile(actor, item, buffer) {
  const text = await extractText(buffer, item.name, item.type);
  const { config: embedding, apiKey } = await platformEmbeddingAccess();
  const textChunks = chunksFromText(
    text,
    embedding.chunkSize,
    embedding.chunkOverlap,
    embedding.chunkStrategy,
  );
  let vectors = [];
  if (embedding.configured && apiKey && textChunks.length) {
    for (let offset = 0; offset < textChunks.length; offset += embedding.batchSize) {
      const batch = textChunks.slice(offset, offset + embedding.batchSize);
      vectors.push(...(await callEmbedding(embedding, apiKey, batch)));
      await recordPlatformUsage("embedding", {
        inputTokens: estimateContextTokens(batch.join("\n")),
      }).catch(() => undefined);
    }
  }
  const indexPath = actorAttachmentPath(actor, "library-index.json");
  const index = await readJson(indexPath, { version: 1, files: {} });
  index.files[item.id] = {
    id: item.id,
    name: item.name,
    type: item.type,
    updatedAt: isoNow(),
    chunks: textChunks.map((chunk, indexValue) => ({
      id: `${item.id}:${indexValue}`,
      text: chunk,
      vector: vectors[indexValue] || undefined,
    })),
  };
  await writeJson(indexPath, index);
  return {
    chunks: textChunks.length,
    status: vectors.length ? "ready" : "keyword-only",
  };
}

function tokenize(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const words = normalized.split(/\s+/).filter((word) => word.length > 1);
  const chinese = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  for (let index = 0; index < chinese.length - 1; index += 1) {
    words.push(`${chinese[index]}${chinese[index + 1]}`);
  }
  return [...new Set(words)];
}

function cosine(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

async function retrieveKnowledge(actor, query, state, limit = 6) {
  const index = await readJson(actorAttachmentPath(actor, "library-index.json"), {
    files: {},
  });
  const terms = tokenize(query);
  const rows = [];
  for (const file of Object.values(index.files || {})) {
    for (const chunk of file.chunks || []) {
      const tokens = tokenize(chunk.text);
      rows.push({
        file: file.name,
        chunk,
        tokens,
        keywordScore: 0,
        semanticScore: 0,
      });
    }
  }
  const averageLength =
    rows.reduce((sum, row) => sum + row.tokens.length, 0) / Math.max(rows.length, 1);
  const documentFrequency = new Map(
    terms.map((term) => [
      term,
      rows.reduce((count, row) => count + (row.tokens.includes(term) ? 1 : 0), 0),
    ]),
  );
  for (const row of rows) {
    const frequencies = new Map();
    for (const token of row.tokens) {
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
    row.keywordScore = terms.reduce((score, term) => {
      const frequency = frequencies.get(term) || 0;
      if (!frequency) return score;
      const frequencyInDocuments = documentFrequency.get(term) || 0;
      const inverseDocumentFrequency = Math.log(
        1 + (rows.length - frequencyInDocuments + 0.5) / (frequencyInDocuments + 0.5),
      );
      const k1 = 1.2;
      const b = 0.75;
      const normalization =
        frequency +
        k1 *
          (1 -
            b +
            b * (row.tokens.length / Math.max(averageLength, 1)));
      return score + inverseDocumentFrequency * ((frequency * (k1 + 1)) / normalization);
    }, 0);
  }
  const { config: embedding, apiKey } = await platformEmbeddingAccess();
  if (
    embedding.hybridEnabled &&
    embedding.configured &&
    apiKey &&
    rows.some((row) => row.chunk.vector)
  ) {
    try {
      const [queryVector] = await callEmbedding(embedding, apiKey, query);
      await recordPlatformUsage("embedding", {
        inputTokens: estimateContextTokens(query),
      }).catch(() => undefined);
      for (const row of rows) row.semanticScore = cosine(queryVector, row.chunk.vector);
    } catch {
      // Keyword retrieval remains available when the embedding endpoint is temporarily down.
    }
  }
  const keywordRanking = [...rows].sort((a, b) => b.keywordScore - a.keywordScore);
  const semanticRanking = [...rows].sort((a, b) => b.semanticScore - a.semanticScore);
  const rrf = new Map();
  for (const ranking of [keywordRanking, semanticRanking]) {
    ranking.forEach((row, indexValue) => {
      const key = row.chunk.id;
      rrf.set(key, (rrf.get(key) || 0) + 1 / (60 + indexValue + 1));
    });
  }
  const ranked = rows
    .map((row) => ({ ...row, score: rrf.get(row.chunk.id) || 0 }))
    .filter((row) => row.keywordScore > 0 || row.semanticScore > 0.15)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(limit, 20));
  if (embedding.rerankEnabled) {
    const normalizedQuery = String(query).toLowerCase().replace(/\s+/g, " ").trim();
    for (const row of ranked) {
      const normalizedText = String(row.chunk.text).toLowerCase();
      const exactBoost = normalizedQuery && normalizedText.includes(normalizedQuery) ? 0.08 : 0;
      row.score +=
        exactBoost +
        Math.min(row.keywordScore / 100, 0.05) +
        Math.max(row.semanticScore, 0) * 0.04;
    }
    ranked.sort((a, b) => b.score - a.score);
  }
  return ranked.slice(0, limit);
}

async function readMarkdownTree(directory, maxChars = 24_000) {
  const pieces = [];
  let total = 0;
  async function walk(current) {
    if (total >= maxChars) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= maxChars) break;
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(itemPath);
      } else if (/\.(md|txt)$/i.test(entry.name)) {
        const content = await readFile(itemPath, "utf8").catch(() => "");
        const clipped = content.slice(0, maxChars - total);
        pieces.push(`## ${entry.name}\n${clipped}`);
        total += clipped.length;
      }
    }
  }
  await walk(directory);
  return pieces.join("\n\n");
}

async function selectedSkillContext(actor, skillIds = []) {
  const pieces = [];
  for (const skillId of skillIds.slice(0, 8)) {
    const builtIn = BUILTIN_SKILLS[skillId];
    const directory = builtIn || path.join(actorSkillDirectory(actor), safeSegment(skillId));
    const content = await readMarkdownTree(directory);
    if (content) {
      pieces.push(
        await renderPromptTemplate("context/skill.md", {
          SKILL_ID: skillId,
          CONTENT: content,
        }),
      );
    }
  }
  return pieces.join("\n\n");
}

function memoryRecordsForContext(
  document,
  state,
  prompt,
  projectId,
  memoryMode,
  conversationId,
  workspaceId = "",
  taskId = "",
) {
  if (!state?.settings?.memoryEnabled) return [];
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  return selectMemoryRecords(document, {
    prompt,
    projectId,
    conversationId,
    workspaceId,
    taskId,
    memoryMode,
    limit: 16,
    asOfSequence: conversation?.branch
      ? Number(conversation.branch.memorySnapshotSequence || 0)
      : undefined,
    snapshotVersionIds: conversation?.branch?.memorySnapshotVersionIds || [],
    lineageConversationId: conversationId,
  });
}

function memorySyncRecordsForContext(
  document,
  state,
  projectId,
  memoryMode,
  conversationId,
  workspaceId = "",
  taskId = "",
) {
  if (!state?.settings?.memoryEnabled) return [];
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  return selectMemorySyncRecords(document, {
    projectId,
    conversationId,
    workspaceId,
    taskId,
    memoryMode,
    asOfSequence: conversation?.branch
      ? Number(conversation.branch.memorySnapshotSequence || 0)
      : undefined,
    snapshotVersionIds: conversation?.branch?.memorySnapshotVersionIds || [],
    lineageConversationId: conversationId,
  });
}

function formatMemoryContext(records) {
  return records
    .map((item) => {
      const scope =
        item.scope === "conversation"
          ? "本对话"
          : item.scope === "project"
            ? "本项目"
            : item.scope === "workspace"
              ? "工作区"
              : item.scope === "task"
                ? "本任务"
                : "全局";
      if (item.status !== "active") {
        return `- [撤销][${scope}] 不再使用键为“${item.semanticKey || item.id}”的旧记忆。`;
      }
      return `- [${scope}] ${item.content}（来源：${item.source || "未知"}；可信度：${Number(item.confidence ?? 0.5).toFixed(2)}）`;
    })
    .join("\n");
}

function historyContext(state, memoryDocument, conversationId, beforeMessageId) {
  if (!state?.settings?.referenceHistory) return "";
  const summary = findConversationSummary(memoryDocument, conversationId);
  const recent = currentConversationHistory(state, conversationId, {
    beforeMessageId,
    afterMessageId: summary?.throughMessageId,
    maxMessages: 32,
  })
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n");
  return [
    summary?.content ? `对话摘要：${summary.content}` : "",
    recent,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function conversationContextUsage(
  state,
  memoryDocument,
  conversationId,
  {
    systemText = "",
    skillsText = "",
    knowledgeText = "",
    outputReserve = 8_192,
  } = {},
) {
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  const messages = Array.isArray(conversation?.messages)
    ? conversation.messages
    : [];
  const summary = findConversationSummary(memoryDocument, conversationId);
  const activeMessages = currentConversationHistory(state, conversationId, {
    afterMessageId: summary?.throughMessageId,
    maxMessages: Math.max(1, messages.length + 1),
  });
  const records = state?.settings?.memoryEnabled
    ? selectMemoryRecords(memoryDocument, {
        prompt: messages.at(-1)?.content || "",
        projectId: conversation?.projectId,
        conversationId,
        workspaceId: conversation?.work?.workspaceId || "",
        memoryMode:
          state?.projects?.find((project) => project.id === conversation?.projectId)
            ?.memoryMode || "project-and-global",
        limit: 24,
        asOfSequence: conversation?.branch
          ? Number(conversation.branch.memorySnapshotSequence || 0)
          : undefined,
        snapshotVersionIds:
          conversation?.branch?.memorySnapshotVersionIds || [],
        lineageConversationId: conversationId,
      })
    : [];
  const tokenText = [
    summary?.content || "",
    ...activeMessages.map((message) => message.content || ""),
    ...records.map((record) => record.content || ""),
  ].join("\n");
  const messageTokens = estimateContextTokens(
    activeMessages.map((message) => message.content || "").join("\n"),
  );
  const summaryTokens = estimateContextTokens(summary?.content || "");
  const memoryTokens = estimateContextTokens(
    records.map((record) => record.content || "").join("\n"),
  );
  const systemTokens = estimateContextTokens(systemText);
  const skillTokens = estimateContextTokens(skillsText);
  const knowledgeTokens = estimateContextTokens(knowledgeText);
  const reserveTokens = Math.max(0, Number(outputReserve || 0));
  const used =
    estimateContextTokens(tokenText) +
    systemTokens +
    skillTokens +
    knowledgeTokens +
    reserveTokens;
  const limit = Number(memoryDocument.contextSettings.conversationLimit || 200_000);
  return {
    used,
    limit,
    ratio: limit ? Math.min(1, used / limit) : 0,
    automaticCompressionThreshold: Number(
      memoryDocument.contextSettings.automaticCompressionThreshold || 0.95,
    ),
    summary,
    messageCount: messages.length,
    activeMessageCount: activeMessages.length,
    memoryCount: records.length,
    breakdown: {
      messages: messageTokens,
      summary: summaryTokens,
      memory: memoryTokens,
      system: systemTokens,
      skills: skillTokens,
      knowledge: knowledgeTokens,
      outputReserve: reserveTokens,
    },
  };
}

async function measuredConversationContextUsage(
  actor,
  state,
  memoryDocument,
  conversationId,
) {
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  const lastUserMessage = [...(conversation?.messages || [])]
    .reverse()
    .find((message) => message.role === "user");
  const [systemText, skillsText] = await Promise.all([
    readFile(
      path.join(
        PROMPT_ROOT,
        conversation?.mode === "work" ? "work-system.md" : "chat-system.md",
      ),
      "utf8",
    ).catch(() => ""),
    selectedSkillContext(actor, lastUserMessage?.selectedSkills || []).catch(
      () => "",
    ),
  ]);
  const usage = conversationContextUsage(state, memoryDocument, conversationId, {
    systemText,
    skillsText,
  });
  const lastMeasuredWebUsage = [...(conversation?.messages || [])]
    .reverse()
    .find((message) => message.role === "assistant" && message.webContextUsage)
    ?.webContextUsage;
  const measuredKnowledgeTokens = Number(
    lastMeasuredWebUsage?.breakdown?.knowledge || 0,
  );
  if (measuredKnowledgeTokens > 0) {
    usage.breakdown.knowledge = measuredKnowledgeTokens;
    usage.used += measuredKnowledgeTokens;
    usage.ratio = usage.limit ? Math.min(1, usage.used / usage.limit) : 0;
  }
  return usage;
}

const CONVERSATION_CHECKPOINT_ARRAY_FIELDS = [
  "activeRequirements",
  "activeConstraints",
  "activeDecisions",
  "executionOutcomes",
  "importantFacts",
  "artifactReferences",
  "openQuestions",
  "pendingApprovals",
  "nextActions",
  "exactAnchors",
];

function boundedCheckpointText(value, limit = 1_200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function boundedCheckpointList(value, limit = 24) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => boundedCheckpointText(item, 1_000))
        .filter(Boolean),
    ),
  ].slice(-limit);
}

function exactCheckpointAnchors(messages) {
  const anchors = [];
  const add = (value) => {
    const normalized = boundedCheckpointText(value, 500);
    if (normalized && !anchors.includes(normalized)) anchors.push(normalized);
  };
  for (const message of messages) {
    const content = String(message?.content || "");
    for (const match of content.matchAll(/`([^`\r\n]{2,300})`/g)) add(match[1]);
    for (const match of content.matchAll(
      /(?:~\/[\w.\-\/]+|\/[\w.\-]+(?:\/[\w.\-]+)+|[A-Za-z]:\\[^\r\n<>:"|?*]{2,240})/g,
    )) add(match[0]);
    for (const match of content.matchAll(
      /\b(?:[A-Fa-f0-9]{12,64}|\d+(?:\.\d+)?\s*(?:ms|s|min|GB|MB|KB|GiB|MiB|%|端口)|(?:port|pid|job|task|run)[-_: ]?[A-Za-z0-9_.-]+)\b/gi,
    )) add(match[0]);
  }
  return anchors.slice(-80);
}

function normalizeConversationCheckpoint(value, existing, messages) {
  const source = value && typeof value === "object" ? value : {};
  const previous = existing && typeof existing === "object" ? existing : {};
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role !== "user");
  const checkpoint = {
    goal: boundedCheckpointText(
      source.goal || previous.goal || userMessages[0]?.content,
    ),
    currentFocus: boundedCheckpointText(
      source.currentFocus || userMessages.at(-1)?.content || previous.currentFocus,
    ),
  };
  for (const field of CONVERSATION_CHECKPOINT_ARRAY_FIELDS) {
    checkpoint[field] = boundedCheckpointList(
      source[field]?.length ? source[field] : previous[field],
    );
  }
  if (!checkpoint.executionOutcomes.length) {
    checkpoint.executionOutcomes = boundedCheckpointList(
      assistantMessages.slice(-4).map((message) => message.content),
      8,
    );
  }
  checkpoint.exactAnchors = boundedCheckpointList(
    [
      ...(previous.exactAnchors || []),
      ...exactCheckpointAnchors(messages),
    ],
    80,
  );
  checkpoint.coveredMessageIds = uniqueStrings(
    previous.coveredMessageIds || [],
    messages.map((message) => String(message.id)),
  );
  return checkpoint;
}

function conversationCheckpointContent(checkpoint) {
  const labels = {
    activeRequirements: "当前要求",
    activeConstraints: "约束",
    activeDecisions: "已定事项",
    executionOutcomes: "执行结果",
    importantFacts: "重要事实",
    artifactReferences: "产物",
    openQuestions: "待澄清",
    pendingApprovals: "待确认",
    nextActions: "下一步",
    exactAnchors: "精确锚点",
  };
  const sections = [
    checkpoint.goal ? `目标：${checkpoint.goal}` : "",
    checkpoint.currentFocus ? `当前焦点：${checkpoint.currentFocus}` : "",
  ];
  for (const field of CONVERSATION_CHECKPOINT_ARRAY_FIELDS) {
    if (!checkpoint[field]?.length) continue;
    sections.push(
      `${labels[field]}：\n${checkpoint[field].map((item) => `- ${item}`).join("\n")}`,
    );
  }
  let content = sections.filter(Boolean).join("\n\n");
  while (estimateContextTokens(content) > 8_000) {
    const reducible = CONVERSATION_CHECKPOINT_ARRAY_FIELDS
      .map((field) => ({ field, length: checkpoint[field]?.length || 0 }))
      .filter((item) => item.length > 2)
      .sort((left, right) => right.length - left.length)[0];
    if (!reducible) {
      content = content.slice(0, Math.max(1, Math.floor(content.length * 0.9)));
      break;
    }
    checkpoint[reducible.field].shift();
    content = conversationCheckpointContent(checkpoint);
  }
  return content.slice(0, 24_000);
}

async function compressConversationContext(actor, conversationId) {
  const state = await getState(actor);
  const memoryDocument = await readMemoryDocument(actor);
  const conversation = (state?.conversations || []).find(
    (item) => String(item.id) === String(conversationId),
  );
  if (!conversation) {
    const error = new Error("对话不存在");
    error.statusCode = 404;
    throw error;
  }
  const messages = (conversation.messages || []).filter(
    (message) => message?.content,
  );
  const existing = findConversationSummary(memoryDocument, conversationId);
  const throughIndex = existing?.throughMessageId
    ? messages.findIndex((message) => message.id === existing.throughMessageId)
    : -1;
  const candidates = messages.slice(throughIndex + 1, Math.max(throughIndex + 1, messages.length - 8));
  if (!candidates.length) {
    return {
      document: memoryDocument,
      summary: existing || null,
      usage: conversationContextUsage(state, memoryDocument, conversationId),
      compressed: false,
    };
  }
  const sourceText = candidates
    .map(
      (message) =>
        `[${message.id}] ${message.role === "user" ? "用户" : "EasyWork"}：${String(message.content).slice(0, 8_000)}`,
    )
    .join("\n\n");
  const { provider, apiKey, category } = await effectiveProviderAccess(
    actor,
    state?.settings,
  );
  let checkpointSource = null;
  if (provider.configured && provider.model && apiKey) {
    try {
      const prompt = await renderPromptTemplate(
        "memory/conversation-compact.md",
        {
          EXISTING_CHECKPOINT: existing?.checkpoint
            ? JSON.stringify(existing.checkpoint, null, 2)
            : "{}",
          MESSAGES: sourceText,
        },
      );
      const response = await callChatProvider(
        provider,
        apiKey,
        prompt,
      );
      const responseText = extractModelText(response.payload);
      await recordProviderModelUsage(category, prompt, responseText);
      checkpointSource = parseModelJsonObject(responseText);
    } catch {
      checkpointSource = null;
    }
  }
  let checkpoint = normalizeConversationCheckpoint(
    checkpointSource,
    existing?.checkpoint,
    candidates,
  );
  let summaryText = conversationCheckpointContent(checkpoint);
  const sourceTokens = estimateContextTokens(
    [existing?.content || "", sourceText].filter(Boolean).join("\n\n"),
  );
  let summaryTokens = estimateContextTokens(summaryText);
  let validationMode = checkpointSource ? "model-validated" : "deterministic";
  if (sourceTokens > 512 && summaryTokens >= sourceTokens * 0.95) {
    checkpoint = normalizeConversationCheckpoint(
      null,
      existing?.checkpoint,
      candidates,
    );
    summaryText = conversationCheckpointContent(checkpoint);
    summaryTokens = estimateContextTokens(summaryText);
    validationMode = "deterministic-fallback";
  }
  checkpoint.validation = {
    mode: validationMode,
    sourceTokens,
    summaryTokens,
    rawMessagesRetained: true,
    validatedAt: isoNow(),
  };
  const throughMessage = candidates.at(-1);
  const nextDocument = await updateMemoryDocument(actor, (document) =>
    upsertConversationSummary(document, {
      conversationId,
      content: summaryText,
      checkpoint,
      throughMessageId: throughMessage.id,
      sourceMessageIds: uniqueStrings(
        existing?.sourceMessageIds || [],
        candidates.map((message) => message.id),
      ),
    }),
  );
  return {
    document: nextDocument,
    summary: findConversationSummary(nextDocument, conversationId),
    usage: conversationContextUsage(state, nextDocument, conversationId),
    compressed: true,
  };
}

async function buildContext({
  actor,
  mode,
  prompt,
  skillIds,
  projectId,
  memoryMode,
  conversationId,
  currentUserMessageId,
  workspaceId = "",
  taskId = "",
}) {
  const state = await getState(actor);
  let memoryDocument = await readMemoryDocument(actor);
  const system = await readFile(
    path.join(PROMPT_ROOT, mode === "work" ? "work-system.md" : "chat-system.md"),
    "utf8",
  );
  const skills = await selectedSkillContext(actor, skillIds);
  const usage = conversationContextUsage(state, memoryDocument, conversationId, {
    systemText: system,
    skillsText: skills,
  });
  if (
    usage.messageCount > 12 &&
    usage.ratio >= usage.automaticCompressionThreshold
  ) {
    const compressed = await compressConversationContext(
      actor,
      conversationId,
    ).catch(() => null);
    if (compressed?.document) memoryDocument = compressed.document;
  }
  const memoryRecords = memoryRecordsForContext(
    memoryDocument,
    state,
    prompt,
    projectId,
    memoryMode,
    conversationId,
    workspaceId,
    taskId,
  );
  const memorySyncRecords = memorySyncRecordsForContext(
    memoryDocument,
    state,
    projectId,
    memoryMode,
    conversationId,
    workspaceId,
    taskId,
  );
  const memories = formatMemoryContext(memoryRecords);
  const history = historyContext(
    state,
    memoryDocument,
    conversationId,
    currentUserMessageId,
  );
  const knowledge = await retrieveKnowledge(actor, prompt, state).catch(() => []);
  const knowledgeText = (
    await Promise.all(
      knowledge.map((item, indexValue) =>
        renderPromptTemplate("context/knowledge-item.md", {
          INDEX: indexValue + 1,
          FILE: item.file,
          CONTENT: item.chunk.text.slice(0, 1800),
        }),
      ),
    )
  ).join("\n\n");
  const optionalSection = async (template, content) =>
    content
      ? renderPromptTemplate(template, {
          CONTENT: content,
        })
      : "";
  const text = await renderPromptTemplate("context/layout.md", {
    SYSTEM: system,
    MEMORY_SECTION: await optionalSection("context/memory.md", memories),
    HISTORY_SECTION: await optionalSection("context/history.md", history),
    SKILLS_SECTION: await optionalSection("context/skills.md", skills),
    KNOWLEDGE_SECTION: await optionalSection("context/knowledge.md", knowledgeText),
    REQUEST_SECTION: await renderPromptTemplate("context/request.md", {
      CONTENT: prompt,
    }),
  });
  const contextUsage = conversationContextUsage(
    state,
    memoryDocument,
    conversationId,
    {
      systemText: system,
      skillsText: skills,
      knowledgeText,
    },
  );
  return {
    state,
    memoryDocument,
    text,
    sections: {
      system,
      memories,
      history,
      conversationSummary:
        findConversationSummary(memoryDocument, conversationId)?.content || "",
      skills,
      knowledge: knowledgeText,
      request: prompt,
    },
    memoryRecords,
    memorySyncRecords,
    contextUsage,
    sources: [...new Set(knowledge.map((item) => item.file))],
  };
}

function extractModelText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (typeof payload?.choices?.[0]?.message?.content === "string") {
    return payload.choices[0].message.content;
  }
  const blocks = Array.isArray(payload?.output) ? payload.output : [];
  return blocks
    .filter(
      (item) => !/reasoning|thinking/i.test(String(item?.type || "")),
    )
    .flatMap((item) =>
      Array.isArray(item?.content) ? item.content : [item],
    )
    .filter(
      (item) => !/reasoning|thinking/i.test(String(item?.type || "")),
    )
    .map((item) => item.text || item.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function parseModelJsonObject(value) {
  const source = String(value || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, source]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      const start = candidate.indexOf("{");
      const end = candidate.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // The caller treats malformed model output as an empty result.
      }
    }
  }
  return null;
}

async function modelRequest(protocol, model, context, test = false) {
  const systemPrompt = await renderPromptTemplate("model/request-system.md");
  const connectivityPrompt = await renderPromptTemplate("model/connectivity-test.md");
  if (protocol === "chat-completions") {
    return {
      endpoint: "chat/completions",
      body: {
        model,
        messages: test
          ? [{ role: "user", content: connectivityPrompt }]
          : [
              { role: "system", content: systemPrompt },
              { role: "user", content: context },
            ],
        ...(test ? { max_tokens: 4 } : {}),
      },
    };
  }
  return {
    endpoint: "responses",
    body: {
      model,
      input: test
        ? connectivityPrompt
        : [
            { role: "system", content: systemPrompt },
            { role: "user", content: context },
          ],
      ...(test ? { max_output_tokens: 4 } : {}),
    },
  };
}

async function callChatProvider(provider, apiKey, context, { test = false } = {}) {
  assertApiKeyShape(apiKey);
  const protocols =
    provider.protocol === "responses" || provider.protocol === "chat-completions"
      ? [provider.protocol]
      : ["responses", "chat-completions"];
  let lastError;
  for (const protocol of protocols) {
    const request = await modelRequest(protocol, provider.model, context, test);
    const response = await fetch(apiUrl(provider.baseUrl, request.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(test ? 30_000 : 120_000),
    });
    if (response.ok) {
      return { payload: await response.json(), protocol };
    }
    const diagnostic = (await response.text()).slice(0, 400);
    lastError = new Error(
      `模型 API 返回 ${response.status}${diagnostic ? `：${diagnostic}` : ""}`,
    );
    lastError.statusCode = 502;
    if ([401, 403, 429].includes(response.status)) break;
  }
  throw lastError || new Error("模型 API 请求失败");
}

function textFromContentPart(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return textFromContentPart(
      value.text || value.content || value.output_text || value.delta || "",
    );
  }
  if (!Array.isArray(value)) return "";
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : String(item?.text || item?.content || item?.output_text || ""),
    )
    .join("");
}

function extractModelReasoning(payload) {
  const message = payload?.choices?.[0]?.message;
  const chatReasoning =
    message?.reasoning_content || message?.reasoning || message?.thinking;
  if (typeof chatReasoning === "string") return chatReasoning;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  return output
    .filter((item) => /reasoning|thinking/i.test(String(item?.type || "")))
    .flatMap((item) => item?.summary || item?.content || [])
    .map((item) =>
      typeof item === "string"
        ? item
        : String(item?.text || item?.content || ""),
    )
    .filter(Boolean)
    .join("\n");
}

function providerStreamDelta(payload, protocol) {
  let content = "";
  let reasoning = "";
  if (protocol === "chat-completions") {
    const delta = payload?.choices?.[0]?.delta || {};
    content = textFromContentPart(delta.content);
    reasoning = textFromContentPart(
      delta.reasoning_content || delta.reasoning || delta.thinking,
    );
    return { content, reasoning };
  }

  const type = String(payload?.type || "");
  if (
    type === "response.output_text.delta" ||
    type === "response.content_part.delta"
  ) {
    content = textFromContentPart(payload.delta || payload.text);
  } else if (type === "response.content_part.added") {
    const part = payload.part || payload.content_part;
    if (/output_text|text/i.test(String(part?.type || "output_text"))) {
      content = textFromContentPart(part);
    }
  } else if (type === "response.output_item.added") {
    const item = payload.item || payload.output_item;
    if (/message|output_text|text/i.test(String(item?.type || ""))) {
      content = textFromContentPart(item?.content || item);
    }
  } else if (
    /reasoning.*delta|thinking.*delta/i.test(type) ||
    type === "response.reasoning_summary_text.delta"
  ) {
    reasoning = textFromContentPart(payload.delta || payload.text);
  }
  return { content, reasoning };
}

function trailingTagPrefixLength(value, tag) {
  const source = String(value || "").toLowerCase();
  const target = tag.toLowerCase();
  const maximum = Math.min(source.length, target.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (source.endsWith(target.slice(0, length))) return length;
  }
  return 0;
}

function createThinkTagRouter(onDelta) {
  let pending = "";
  let insideReasoning = false;
  let content = "";
  let reasoning = "";

  const emit = (kind, value) => {
    const delta = String(value || "");
    if (!delta) return;
    if (kind === "reasoning") reasoning += delta;
    else content += delta;
    onDelta(kind, delta);
  };

  const pushContent = (value) => {
    pending += String(value || "");
    while (pending) {
      const tag = insideReasoning ? "</think>" : "<think>";
      const index = pending.toLowerCase().indexOf(tag);
      if (index >= 0) {
        emit(insideReasoning ? "reasoning" : "content", pending.slice(0, index));
        pending = pending.slice(index + tag.length);
        insideReasoning = !insideReasoning;
        continue;
      }
      const retainedLength = trailingTagPrefixLength(pending, tag);
      const readyLength = pending.length - retainedLength;
      emit(insideReasoning ? "reasoning" : "content", pending.slice(0, readyLength));
      pending = pending.slice(readyLength);
      break;
    }
  };

  return {
    pushContent,
    pushReasoning(value) {
      emit("reasoning", value);
    },
    flush() {
      emit(insideReasoning ? "reasoning" : "content", pending);
      pending = "";
    },
    result() {
      return { content, reasoning };
    },
  };
}

async function callChatProviderStream(
  provider,
  apiKey,
  context,
  onDelta,
  options = {},
) {
  assertApiKeyShape(apiKey);
  const protocols =
    provider.protocol === "responses" || provider.protocol === "chat-completions"
      ? [provider.protocol]
      : ["responses", "chat-completions"];
  let lastError;

  for (const protocol of protocols) {
    const request = await modelRequest(protocol, provider.model, context, false);
    const response = await fetch(apiUrl(provider.baseUrl, request.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...request.body, stream: true }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const diagnostic = (await response.text()).slice(0, 400);
      lastError = new Error(
        `模型 API 返回 ${response.status}${diagnostic ? `：${diagnostic}` : ""}`,
      );
      lastError.statusCode = 502;
      if ([401, 403, 429].includes(response.status)) break;
      continue;
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!response.body || /application\/json/i.test(contentType)) {
      const payload = await response.json();
      const router = createThinkTagRouter(onDelta);
      router.pushReasoning(extractModelReasoning(payload));
      router.pushContent(extractModelText(payload));
      router.flush();
      return { ...router.result(), protocol };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let completedPayload;
    let completedContent = "";
    let completedReasoning = "";
    const router = createThinkTagRouter(onDelta);

    const consumeLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("event:") || line.startsWith(":")) return;
      const data = line.startsWith("data:") ? line.slice(5).trim() : line;
      if (!data || data === "[DONE]") return;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }
      if (payload?.type === "response.completed") {
        completedPayload = payload.response;
      }
      if (payload?.type === "response.output_text.done") {
        completedContent = textFromContentPart(payload.text || payload.delta);
      } else if (payload?.type === "response.content_part.done") {
        const part = payload.part || payload.content_part;
        if (/output_text|text/i.test(String(part?.type || "output_text"))) {
          completedContent = textFromContentPart(part);
        }
      } else if (/reasoning.*done|thinking.*done/i.test(String(payload?.type || ""))) {
        completedReasoning = textFromContentPart(payload.text || payload.delta);
      }
      const delta = providerStreamDelta(payload, protocol);
      if (delta.reasoning) {
        router.pushReasoning(delta.reasoning);
      }
      if (delta.content) {
        router.pushContent(delta.content);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    }
    pending += decoder.decode();
    if (pending.trim()) consumeLine(pending);

    router.flush();
    const streamedResult = router.result();
    const exactContent =
      extractModelText(completedPayload) || completedContent;
    const exactReasoning =
      extractModelReasoning(completedPayload) || completedReasoning;
    if (!exactContent && !exactReasoning) {
      return { ...streamedResult, protocol };
    }
    const exactRouter = createThinkTagRouter(() => undefined);
    exactRouter.pushReasoning(exactReasoning);
    exactRouter.pushContent(exactContent);
    exactRouter.flush();
    const exactResult = exactRouter.result();
    return {
      content: exactResult.content || streamedResult.content,
      reasoning: exactResult.reasoning || streamedResult.reasoning,
      protocol,
    };
  }
  throw lastError || new Error("模型 API 请求失败");
}

async function runChatModelStream(actor, context, state, onDelta) {
  const { provider, apiKey, category } = await effectiveProviderAccess(
    actor,
    state?.settings,
  );
  if (!provider.configured || !apiKey) {
    const content =
      "尚未配置模型 API。请登录后在个人资料 → 模型 API 中完成设置。";
    onDelta("content", content);
    return { content, reasoning: "", demo: true };
  }
  const result = await callChatProviderStream(
    provider,
    apiKey,
    context,
    onDelta,
  );
  if (!result.content) {
    result.content = "模型返回了空内容。";
    onDelta("content", result.content);
  }
  if (category === "web") {
    await recordPlatformUsage("web", {
      inputTokens: estimateContextTokens(context),
      outputTokens: estimateContextTokens(
        `${result.reasoning || ""}\n${result.content || ""}`,
      ),
    }).catch(() => undefined);
  }
  return { ...result, demo: false };
}

async function persistChatTurnStart(actor, body, fallbackTitle) {
  const conversationId = String(body.conversationId || "");
  const userMessageId = String(body.userMessageId || "");
  const assistantMessageId = String(body.assistantMessageId || "");
  const createdAt = isoNow();
  await updateState(actor, (state) => {
    state.conversations = Array.isArray(state.conversations)
      ? state.conversations
      : [];
    let conversation = state.conversations.find(
      (item) => String(item.id) === conversationId,
    );
    if (!conversation) {
      conversation = {
        id: conversationId,
        title: fallbackTitle || "新对话",
        mode: "chat",
        projectId: body.projectId ? String(body.projectId) : undefined,
        messages: [],
        updatedAt: createdAt,
      };
      state.conversations.unshift(conversation);
    }
    conversation.mode = "chat";
    conversation.projectId ||= body.projectId
      ? String(body.projectId)
      : undefined;
    conversation.updatedAt = createdAt;
    conversation.messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
    if (
      userMessageId &&
      !conversation.messages.some((message) => message.id === userMessageId)
    ) {
      conversation.messages.push({
        id: userMessageId,
        role: "user",
        content: String(body.prompt || ""),
        createdAt,
        mode: "chat",
        selectedSkills: Array.isArray(body.skillIds) ? body.skillIds : [],
      });
    }
    if (
      assistantMessageId &&
      !conversation.messages.some(
        (message) => message.id === assistantMessageId,
      )
    ) {
      conversation.messages.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
        createdAt,
        mode: "chat",
        reasoningStatus: "running",
      });
    }
    return state;
  });
}

async function broadcastActorEvent(actor, payload) {
  const worker = await getSshWorker(actor);
  sessionSend({ worker }, payload);
}

async function persistChatTurnResult(actor, body, result) {
  const conversationId = String(body.conversationId || "");
  const assistantMessageId = String(body.assistantMessageId || "");
  await updateState(actor, (state) => {
    const conversation = (state.conversations || []).find(
      (item) => String(item.id) === conversationId,
    );
    if (!conversation) return state;
    conversation.updatedAt = isoNow();
    const assistant = (conversation.messages || []).find(
      (message) => message.id === assistantMessageId,
    );
    if (assistant) {
      assistant.content = result.content;
      assistant.reasoning = result.reasoning || undefined;
      assistant.reasoningStatus = "done";
    }
    return state;
  });
}

async function finalizeChatTurn(actor, body, result, fallbackTitle) {
  const conversationId = String(body.conversationId || "");
  const title = body.firstTurn
    ? await generateConversationTitle(
        actor,
        String(body.prompt || ""),
        result.content,
      ).catch(() => fallbackTitle)
    : "";
  await updateState(actor, (state) => {
    const conversation = (state.conversations || []).find(
      (item) => String(item.id) === conversationId,
    );
    if (!conversation) return state;
    if (title) conversation.title = title;
    conversation.updatedAt = isoNow();
    return state;
  });
  if (title) {
    await broadcastActorEvent(actor, {
      type: "conversation.title",
      conversationId,
      title,
    });
  }
  await Promise.allSettled([
    captureMemory(
      actor,
      String(body.prompt || ""),
      body.projectId ? String(body.projectId) : undefined,
      body.memoryMode === "project-only"
        ? "project-only"
        : "project-and-global",
      conversationId,
      String(body.userMessageId || ""),
    ),
    distillPortableMemory(actor, {
      conversationId,
      projectId: body.projectId ? String(body.projectId) : undefined,
      userRequest: String(body.prompt || ""),
      finalResult: result.content,
      source: "chat-result-distillation",
      sourceMessageIds: [body.userMessageId, body.assistantMessageId].filter(Boolean),
    }),
  ]);
}

async function runWorkHandoffModel(
  actor,
  currentRequest,
  context,
  state,
  onReasoning,
  signal,
) {
  const { provider, apiKey, category } = await effectiveProviderAccess(
    actor,
    state?.settings,
  );
  if (!provider.configured || !provider.model || !apiKey) {
    return { content: "", reasoning: "", skipped: true };
  }
  const handoffPrompt = await renderPromptTemplate("web/work-context-router.md", {
    CURRENT_REQUEST: currentRequest,
    CONTEXT: context,
  });
  const result = await callChatProviderStream(
    provider,
    apiKey,
    handoffPrompt,
    (kind, delta) => {
      if (kind === "reasoning") onReasoning(delta);
    },
    { signal },
  );
  await recordProviderModelUsage(
    category,
    handoffPrompt,
    `${result.reasoning || ""}\n${result.content || ""}`,
  );
  return { ...result, skipped: false };
}

async function captureMemory(
  actor,
  prompt,
  projectId,
  memoryMode,
  conversationId,
  sourceMessageId = "",
) {
  if (!/(请记住|记住这|以后请|我的偏好|我习惯)/i.test(prompt)) return;
  const content = String(prompt)
    .replace(/^.*?(请记住|记住这|以后请)[：:，,\s]*/i, "")
    .trim()
    .slice(0, 280);
  if (!content) return;
  const state = await getState(actor);
  if (!state?.settings?.memoryEnabled || !state?.settings?.autoCapture) return;
  const scope = memoryMode === "project-only" ? "project" : "user";
  await updateMemoryDocument(actor, (document) =>
    appendExplicitMemory(document, {
      content,
      scope,
      scopeId: scope === "project" ? projectId : "",
      kind: "preference",
      source: "用户明确要求",
      sourceConversationId: conversationId,
      sourceMessageIds: [sourceMessageId].filter(Boolean),
      portability: scope === "project" ? "project-shared" : "universal",
      authority: "user-explicit",
    }),
  );
}

async function distillPortableMemory(actor, {
  conversationId,
  projectId,
  userRequest,
  finalResult,
  location = "当前网页对话",
  source = "result-distillation",
  sourceTaskId,
  sourceCheckpointId,
  serverId,
  workspaceId,
  sourceAgentId,
  sourceAgentSessionId,
  sourceMessageIds = [],
}) {
  const request = String(userRequest || "").trim();
  const result = String(finalResult || "").trim();
  if (!request || !result) return [];

  const state = await getState(actor);
  if (!state?.settings?.memoryEnabled || !state?.settings?.autoCapture) return [];
  const { provider, apiKey, category } = await effectiveProviderAccess(
    actor,
    state?.settings,
  );
  if (!provider.configured || !provider.model || !apiKey) {
    return [];
  }

  const prompt = await renderPromptTemplate("memory/memory-candidate-extract.md", {
    USER_REQUEST: request.slice(0, 8_000),
    LOCATION: String(location || "当前网页对话").slice(0, 1_000),
    FINAL_RESULT: result.slice(0, 16_000),
  });
  const response = await callChatProvider(
    provider,
    apiKey,
    prompt,
  );
  const responseText = extractModelText(response.payload);
  await recordProviderModelUsage(category, prompt, responseText);
  const parsed = parseModelJsonObject(responseText);
  const allowedKinds = new Set(["workflow", "fact", "decision", "constraint"]);
  const allowedScopes = new Set(["project", "workspace", "conversation"]);
  const allowedPortability = new Set([
    "project-shared",
    "reusable-after-validation",
    "workspace-bound",
    "agent-session-only",
  ]);
  const records = (Array.isArray(parsed?.records) ? parsed.records : [])
    .map((record) => ({
      content: String(record?.content || "").trim().slice(0, 2_000),
      semanticKey: String(record?.semanticKey || "").trim().slice(0, 300),
      kind: allowedKinds.has(String(record?.kind || ""))
        ? String(record.kind)
        : "fact",
      scope: allowedScopes.has(String(record?.scope || ""))
        ? String(record.scope)
        : projectId
          ? "project"
          : "conversation",
      portability: allowedPortability.has(String(record?.portability || ""))
        ? String(record.portability)
        : "workspace-bound",
    }))
    .filter((record) => record.content)
    .slice(0, 8);
  if (!records.length) return [];

  const storedIds = [];
  const updated = await updateMemoryDocument(actor, (document) => {
    let next = document;
    for (const record of records) {
      const scope =
        record.scope === "workspace" && workspaceId
          ? "workspace"
          : record.scope === "project" && projectId
            ? "project"
            : "conversation";
      const scopeId =
        scope === "workspace"
          ? workspaceId
          : scope === "project"
            ? projectId
            : conversationId;
      next = appendExplicitMemory(next, {
        content: record.content,
        semanticKey: record.semanticKey,
        scope,
        scopeId,
        kind: record.kind,
        source: sourceTaskId ? `${source}:${sourceTaskId}` : source,
        sourceConversationId: conversationId,
        sourceMessageIds,
        sourceTaskId,
        sourceCheckpointId,
        sourceWorkspaceId: workspaceId,
        sourceAgentId,
        sourceAgentSessionId,
        evidenceRefs: serverId ? [`server:${serverId}`] : [],
        portability:
          scope === "workspace"
            ? "workspace-bound"
            : record.portability,
        authority: sourceTaskId
          ? "agent-reported-execution"
          : "model-inferred",
        confidence: sourceTaskId ? 0.86 : 0.58,
      });
      const stored = next.records.find(
        (item) =>
          item.scope === scope &&
          String(item.scopeId || "") === String(scopeId || "") &&
          item.semanticKey ===
            String(record.semanticKey || record.content)
              .normalize("NFKC")
              .toLocaleLowerCase()
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300),
      );
      if (stored) storedIds.push(stored.id);
    }
    return next;
  });
  return updated.records.filter((record) => storedIds.includes(record.id));
}

async function copyGuestDataToUser(guestActor, userActor) {
  const guestData = actorDirectory(guestActor);
  const guestSkills = actorSkillDirectory(guestActor);
  const userData = actorDirectory(userActor);
  const userSkills = actorSkillDirectory(userActor);
  const guestWorker = sshWorkerPool.get(sshWorkerKey(guestActor));
  if (guestWorker?.persistTimer) {
    clearTimeout(guestWorker.persistTimer);
    guestWorker.persistTimer = null;
  }
  if (guestWorker) {
    await persistSshWorker(guestWorker).catch(() => undefined);
  }
  try {
    await access(guestData, fsConstants.F_OK);
    await mkdir(userData, { recursive: true });
    await cp(guestData, userData, { recursive: true, force: false, errorOnExist: false });
  } catch {
    // A new account can legitimately have no guest data to transfer.
  }
  try {
    await access(guestSkills, fsConstants.F_OK);
    await mkdir(userSkills, { recursive: true });
    await cp(guestSkills, userSkills, { recursive: true, force: false, errorOnExist: false });
  } catch {
    // No uploaded guest skills.
  }
  if (guestWorker) {
    sshWorkerPool.delete(sshWorkerKey(guestActor));
    guestWorker.key = sshWorkerKey(userActor);
    guestWorker.actor = { ...userActor };
    for (const session of guestWorker.sessions.values()) {
      session.worker = guestWorker;
      session.actorKey = guestWorker.key;
      session.poolKey = `${guestWorker.key}:${session.serverId}`;
    }
    sshWorkerPool.set(guestWorker.key, guestWorker);
    await persistSshWorker(guestWorker).catch(() => undefined);
  }
}

async function handleHttp(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "easywork-gateway",
        version: "0.1.0",
        activeWorkSessions: activeSockets.size,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/help") {
      try {
        const [content, metadata] = await Promise.all([
          readFile(HELP_FILE, "utf8"),
          stat(HELP_FILE),
        ]);
        sendJson(res, 200, {
          content,
          updatedAt: metadata.mtime.toISOString(),
        });
      } catch (caught) {
        sendJson(res, 404, {
          error:
            caught?.code === "ENOENT"
              ? "未找到 help/help.md"
              : "帮助内容读取失败",
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/help/events") {
      let helpWatcher;
      let changeTimer = null;
      try {
        helpWatcher = watch(
          path.dirname(HELP_FILE),
          { persistent: false },
          (_eventType, filename) => {
            if (filename && String(filename) !== path.basename(HELP_FILE)) return;
            if (changeTimer) clearTimeout(changeTimer);
            changeTimer = setTimeout(() => {
              if (!res.writableEnded) {
                res.write(`event: help.changed\ndata: ${JSON.stringify({ changedAt: isoNow() })}\n\n`);
              }
            }, 90);
          },
        );
      } catch {
        sendJson(res, 404, { error: "无法监听 help/help.md" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = null;
        helpWatcher?.close();
      };
      helpWatcher.once("error", () => {
        cleanup();
        if (!res.writableEnded) res.end();
      });
      req.once("close", cleanup);
      res.once("close", cleanup);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const actor = await resolveActor(req, res);
      await mkdir(actorDirectory(actor), { recursive: true });
      await mkdir(actorSkillDirectory(actor), { recursive: true });
      await updateMemoryDocument(actor, (document) => document);
      const device = await registerDeviceVisit(actor, req);
      sendJson(res, 200, {
        actor,
        device,
        deviceToken: issueDeviceToken(actor),
        state: await stateForClient(actor),
        capabilities: {
          chatStream: true,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      const actor = await resolveActor(req, res);
      await requireAdmin(actor);
      const [platform, sshConnections, users] = await Promise.all([
        adminPlatformSnapshot(),
        listAdminSshConnections(),
        listUserRecords(),
      ]);
      sendJson(res, 200, {
        ...platform,
        sshConnections,
        userCount: users.length,
        adminCount: (await readAdminNames()).size,
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/admin/platform") {
      const actor = await resolveActor(req, res);
      await requireAdmin(actor);
      const body = await parseJsonBody(req);
      await updatePlatformConfiguration({
        providers: body.providers,
        embedding: body.embedding,
        webApiKey:
          Object.prototype.hasOwnProperty.call(body, "webApiKey")
            ? body.webApiKey
            : undefined,
        agentApiKey:
          Object.prototype.hasOwnProperty.call(body, "agentApiKey")
            ? body.agentApiKey
            : undefined,
        embeddingApiKey:
          Object.prototype.hasOwnProperty.call(body, "embeddingApiKey")
            ? body.embeddingApiKey
            : undefined,
      });
      sendJson(res, 200, await adminPlatformSnapshot());
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/admin/ssh-policy") {
      const actor = await resolveActor(req, res);
      await requireAdmin(actor);
      const body = await parseJsonBody(req);
      await updatePlatformConfiguration({ ssh: body.ssh || body });
      sendJson(res, 200, await adminPlatformSnapshot());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/providers/models") {
      const actor = await resolveActor(req, res);
      await requireAdmin(actor);
      const body = await parseJsonBody(req);
      const category = ["web", "agent", "embedding"].includes(body.category)
        ? body.category
        : "web";
      const snapshot = await adminPlatformSnapshot();
      const secrets = await readPlatformSecrets();
      const configured =
        category === "embedding"
          ? snapshot.settings.embedding
          : snapshot.settings.providers[category];
      const baseUrl = String(body.baseUrl || configured.baseUrl || "").trim();
      const apiKey = String(
        body.apiKey ||
          (category === "embedding"
            ? secrets.embeddingApiKey
            : category === "agent"
              ? secrets.agentApiKey
              : secrets.webApiKey) ||
          "",
      );
      if (!baseUrl || !apiKey) {
        sendJson(res, 400, { error: "请先填写 API URL 和 API Key" });
        return;
      }
      const descriptors = await listProviderModelDescriptors(baseUrl, apiKey);
      const models = descriptors
        .filter((descriptor) =>
          category === "embedding"
            ? /(embedding|embed|bge|e5|gte|nomic|jina|m3)/i.test(descriptor.id)
            : !/(embedding|embed|moderation|whisper|tts|dall-e|image|audio|transcrib|realtime)/i.test(
                descriptor.id,
              ),
        )
        .map((descriptor) => descriptor.id);
      sendJson(res, 200, {
        models: models.length ? models : descriptors.map((descriptor) => descriptor.id),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/ssh/disconnect") {
      const actor = await resolveActor(req, res);
      await requireAdmin(actor);
      const body = await parseJsonBody(req);
      const disconnected = await disconnectAdminSshConnection(
        String(body.userId || ""),
        String(body.serverId || ""),
      );
      if (!disconnected) {
        sendJson(res, 409, { error: "该 SSH 连接当前不在本机 worker 池中" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sshConnections: await listAdminSshConnections(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspaces/browse") {
      const actor = await resolveActor(req, res);
      const serverId = safeSegment(
        url.searchParams.get("serverId") || "",
        "",
      );
      if (!serverId) {
        sendJson(res, 400, { error: "缺少服务器" });
        return;
      }
      const worker = await getSshWorker(actor);
      const session = worker.sessions.get(serverId);
      if (!session || session.status !== "connected") {
        sendJson(res, 409, { error: "SSH 尚未连接" });
        return;
      }
      if (session.demo) {
        const currentPath = remotePathForSession(
          session,
          url.searchParams.get("path") || "~",
        );
        sendJson(res, 200, {
          path: currentPath,
          home: session.home,
          parent:
            currentPath === session.home
              ? null
              : path.posix.dirname(currentPath),
          entries: [],
        });
        return;
      }
      sendJson(
        res,
        200,
        await listRemoteFiles(session, url.searchParams.get("path") || "~"),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      const actor = await resolveActor(req, res);
      const serverId = safeSegment(
        url.searchParams.get("serverId") || "",
        "",
      );
      const worker = await getSshWorker(actor);
      const session = worker.sessions.get(serverId);
      const conversationId = safeSegment(
        url.searchParams.get("conversationId") || "",
        "",
      );
      if (session?.status === "connected" && session.home) {
        await registerWorkspace(actor, session, "~").catch(() => undefined);
      }
      const document = await readWorkspaceDocument(actor);
      const workspaces = Object.values(document.records)
        .filter((record) => !serverId || record.serverId === serverId)
        .filter(
          (record) =>
            record.kind !== "virtual" ||
            (conversationId && record.virtualConversationId === conversationId),
        )
        .sort((left, right) =>
          String(right.lastUsedAt || "").localeCompare(
            String(left.lastUsedAt || ""),
          ),
        );
      sendJson(res, 200, {
        workspaces,
        connected: session?.status === "connected",
        home: session?.home || "",
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/virtual") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const serverId = safeSegment(body.serverId || "", "");
      const conversationId = safeSegment(body.conversationId || "", "");
      if (!serverId || !conversationId) {
        sendJson(res, 400, { error: "虚拟工作区缺少服务器或对话标识" });
        return;
      }
      const worker = await getSshWorker(actor);
      const session = worker.sessions.get(serverId);
      if (!session || session.status !== "connected") {
        sendJson(res, 409, { error: "SSH 尚未连接" });
        return;
      }
      const workspace = await ensureVirtualWorkspace(
        actor,
        session,
        conversationId,
      );
      sendJson(res, 200, { workspace });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const serverId = safeSegment(body.serverId || "", "");
      if (!serverId) {
        sendJson(res, 400, { error: "缺少服务器" });
        return;
      }
      const worker = await getSshWorker(actor);
      const session = worker.sessions.get(serverId);
      if (!session || session.status !== "connected") {
        sendJson(res, 409, { error: "SSH 尚未连接" });
        return;
      }
      const workspace = await registerWorkspace(
        actor,
        session,
        body.path || "~",
        { name: body.name },
      );
      sendJson(res, 200, { workspace });
      return;
    }

    const conversationWorkspaceMatch = url.pathname.match(
      /^\/api\/conversations\/([^/]+)\/workspace$/,
    );
    if (req.method === "PATCH" && conversationWorkspaceMatch) {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const conversationId = safeSegment(
        decodeURIComponent(conversationWorkspaceMatch[1]),
      );
      const workspaceId = String(body.workspaceId || "");
      const workspaceDocument = await readWorkspaceDocument(actor);
      const storedWorkspace = workspaceDocument.records[workspaceId];
      if (!storedWorkspace) {
        sendJson(res, 404, { error: "所选工作区不存在，请重新选择" });
        return;
      }
      const worker = await getSshWorker(actor);
      const session = worker.sessions.get(storedWorkspace.serverId);
      if (!session || session.status !== "connected") {
        sendJson(res, 409, { error: "SSH 尚未连接" });
        return;
      }
      const workspace = await registeredWorkspaceForRun(
        actor,
        session,
        workspaceId,
        conversationId,
      );
      const running = [...worker.tasks.values()].some(
        (task) =>
          task.conversationId === conversationId && task.status === "running",
      );
      if (running) {
        sendJson(res, 409, { error: "任务运行期间不能切换工作区" });
        return;
      }
      let updatedConversation = null;
      await updateState(actor, (state) => {
        const conversation = (state.conversations || []).find(
          (item) => item.id === conversationId,
        );
        if (!conversation) throw new Error("对话不存在");
        if (conversation.mode !== "work") throw new Error("只有工作对话可以选择工作区");
        const boundServerId = String(conversation.work?.serverId || "");
        if (boundServerId && boundServerId !== workspace.serverId) {
          throw new Error("所选工作区不属于当前对话的服务器");
        }
        const previousWorkspaceId = String(conversation.work?.workspaceId || "");
        const history = Array.isArray(conversation.work?.workspaceHistory)
          ? conversation.work.workspaceHistory
          : [];
        conversation.work = {
          ...(conversation.work || {}),
          serverId: workspace.serverId,
          connectionEnabled: true,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspace: workspace.path,
          workspaceMode: workspace.mode,
          workspaceKind: workspace.kind,
          versionDomainId: workspace.versionDomainId,
          sourceCheckpointId: undefined,
          workspaceHistory:
            previousWorkspaceId === workspace.id
              ? history
              : [
                  ...history,
                  {
                    workspaceId: workspace.id,
                    serverId: workspace.serverId,
                    name: workspace.name,
                    path: workspace.path,
                    kind: workspace.kind,
                    versionDomainId: workspace.versionDomainId,
                    activatedAt: isoNow(),
                  },
                ].slice(-100),
        };
        conversation.updatedAt = isoNow();
        updatedConversation = JSON.parse(JSON.stringify(conversation));
        return state;
      });
      await updateWorkspaceDocument(actor, (document) => {
        if (document.records[workspace.id]) {
          document.records[workspace.id].lastUsedAt = isoNow();
          document.records[workspace.id].updatedAt = isoNow();
        }
        return document;
      });
      sendJson(res, 200, {
        conversation: updatedConversation,
        workspace,
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/state") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      await updateState(actor, async (storedState) => {
        const nextState = JSON.parse(JSON.stringify(body.state || {}));
        nextState.settings ||= {};
        const storedSettings = storedState?.settings || {};
        const persistedSettings = await readJson(
          actorStatePath(actor, "settings"),
          {},
        );
        // These account-level settings have dedicated endpoints. Keeping the
        // server copy prevents a concurrent browser tab from erasing a key or
        // SSH profile that was just saved on another device.
        for (const key of [
          "provider",
          "providers",
          "activeProviderId",
          "embedding",
          "servers",
          "lastServerId",
        ]) {
          if (Object.hasOwn(persistedSettings, key)) {
            nextState.settings[key] = storedSettings[key];
          }
        }
        const tombstones = await readConversationTombstones(actor);
        nextState.conversations = mergeConversationCollections(
          storedState?.conversations,
          nextState.conversations,
          tombstones,
        );
        return nextState;
      });
      const worker = sshWorkerPool.get(sshWorkerKey(actor));
      for (const task of worker?.tasks.values() || []) {
        if (task.status === "running") {
          await persistWorkerTaskConversation(actor, task);
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (
      req.method === "DELETE" &&
      url.pathname.startsWith("/api/conversations/")
    ) {
      const actor = await resolveActor(req, res);
      const conversationId = safeSegment(
        decodeURIComponent(url.pathname.slice("/api/conversations/".length)),
      );
      if (!conversationId) {
        sendJson(res, 400, { error: "对话标识不能为空" });
        return;
      }
      const stateBeforeDelete = await getState(actor);
      const deletedConversation = (stateBeforeDelete.conversations || []).find(
        (conversation) => conversation.id === conversationId,
      );
      const deletedRunIds = [
        ...new Set(
          (deletedConversation?.messages || [])
            .map((message) => String(message.runId || message.trace?.runId || ""))
            .filter(Boolean),
        ),
      ];
      await tombstoneConversation(actor, conversationId);
      await updateState(actor, (state) => {
        state.conversations = (state.conversations || []).filter(
          (conversation) => conversation.id !== conversationId,
        );
        return state;
      });
      await updateMemoryDocument(actor, (current) => {
        const next = invalidateMemoryVersions(current, {
          sourceConversationIds: [conversationId],
          reason: "conversation-deleted",
          invalidatedBy: conversationId,
        });
        next.summaries = next.summaries.map((summary) =>
          String(summary.conversationId || "") === conversationId
            ? { ...summary, status: "invalidated", invalidatedAt: isoNow() }
            : summary,
        );
        next.overview = "";
        return next;
      });
      await removeAgentBindingsForConversations(actor, [conversationId]);
      await removeWorkerTasks(actor, deletedRunIds);
      if (deletedConversation) {
        await removeManagedBranchWorkspaces(actor, [deletedConversation]);
      }
      sendJson(res, 200, { ok: true, conversationId });
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/conversations/action"
    ) {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const action = String(body.action || "branch");
      if (!["branch", "edit", "reset", "rewind"].includes(action)) {
        sendJson(res, 400, { error: "不支持的对话操作" });
        return;
      }
      const sourceConversationId = String(body.conversationId || "");
      const sourceMessageId = String(body.messageId || "");
      const state = await getState(actor);
      const source = (state.conversations || []).find(
        (conversation) => conversation.id === sourceConversationId,
      );
      if (!source) {
        sendJson(res, 404, { error: "原对话不存在" });
        return;
      }
      const messages = Array.isArray(source.messages) ? source.messages : [];
      const messageIndex = messages.findIndex(
        (message) => message.id === sourceMessageId,
      );
      if (messageIndex < 0) {
        sendJson(res, 404, { error: "目标消息不存在" });
        return;
      }
      const sourceMessage = messages[messageIndex];

      if (action === "branch") {
        const newConversationId = safeSegment(
          body.newConversationId || randomId("chat-"),
        );
        const retainedMessages = messages.slice(0, messageIndex + 1);
        const memoryDocument = await readMemoryDocument(actor);
        const createdAt = isoNow();
        const memorySnapshot = memorySnapshotAt(
          memoryDocument,
          sourceMessage.createdAt || createdAt,
          {
            sourceMessageIds: [sourceMessage.id],
            sourceTaskIds: [
              String(sourceMessage.runId || sourceMessage.trace?.runId || ""),
            ].filter(Boolean),
          },
        );
        const memorySnapshotSequence = memorySnapshot.sequence;
        const memorySnapshotVersionIds = memorySnapshot.versionIds;
        const branchConversation = {
          ...JSON.parse(JSON.stringify(source)),
          id: newConversationId,
          messages: JSON.parse(JSON.stringify(retainedMessages)),
          updatedAt: createdAt,
          branch: {
            parentConversationId: sourceConversationId,
            parentMessageId: sourceMessageId,
            action: "branch",
            memorySnapshotSequence,
            memorySnapshotVersionIds,
            createdAt,
          },
          work: source.work ? { ...source.work } : undefined,
        };
        const workspaceCapability = {
          workspace:
            branchConversation.mode === "work"
              ? "unavailable"
              : "not-applicable",
          workspaceMessage: "",
          sourceCheckpointId: "",
        };
        if (branchConversation.mode === "work") {
          const sourceRunId = String(
            sourceMessage.runId || sourceMessage.trace?.runId || "",
          );
          const checkpoint = checkpointForRun(
            await readCheckpointDocument(actor),
            sourceRunId,
            sourceMessage.role === "assistant" ? "after" : "before",
          );
          const worker = await getSshWorker(actor);
          const targetSession = worker.sessions.get(
            safeSegment(branchConversation.work?.serverId || ""),
          );
          if (checkpoint?.status !== "available") {
            sendJson(res, 409, {
              error: "该位置没有可用的工作区检查点，无法安全创建工作分支",
            });
            return;
          }
          if (!targetSession?.client || targetSession.status !== "connected") {
            sendJson(res, 409, {
              error: "对应服务器当前未连接，无法创建工作分支",
            });
            return;
          }
          const restored = await restoreWorkspaceCheckpoint(
            targetSession,
            checkpoint,
            newConversationId,
          );
          const restoredWorkspace = await registerWorkspace(
            actor,
            targetSession,
            restored.workspace,
            { name: `${source.title || "工作分支"} · 分支` },
          );
          branchConversation.work = {
            ...(branchConversation.work || {}),
            workspaceId: restoredWorkspace.id,
            workspaceName: restoredWorkspace.name,
            workspace: restoredWorkspace.path,
            workspaceMode: restoredWorkspace.mode,
            sourceCheckpointId: checkpoint.id,
            workspaceHistory: [
              {
                workspaceId: restoredWorkspace.id,
                serverId: restoredWorkspace.serverId,
                name: restoredWorkspace.name,
                path: restoredWorkspace.path,
                activatedAt: createdAt,
              },
            ],
          };
          workspaceCapability.workspace = "restored-managed-branch";
          workspaceCapability.workspaceMessage =
            "已从该消息的检查点建立独立工作分支；原对话和原工作区未改动。";
          workspaceCapability.sourceCheckpointId = checkpoint.id;
        }
        await updateState(actor, (current) => {
          current.conversations = [
            branchConversation,
            ...(current.conversations || []).filter(
              (conversation) => conversation.id !== newConversationId,
            ),
          ];
          return current;
        });
        await updateMemoryDocument(actor, (current) => {
          let next = cloneConversationMemoryScope(current, {
            sourceConversationId,
            targetConversationId: newConversationId,
            asOfSequence: memorySnapshotSequence,
            snapshotVersionIds: memorySnapshotVersionIds,
          });
          next = cloneConversationSummary(next, {
            sourceConversationId,
            targetConversationId: newConversationId,
            retainedMessageIds: retainedMessages.map((message) => message.id),
          });
          if (!findConversationSummary(next, newConversationId) && retainedMessages.length > 8) {
            const summarizedMessages = retainedMessages.slice(0, -8);
            const checkpoint = normalizeConversationCheckpoint(
              null,
              null,
              summarizedMessages,
            );
            next = upsertConversationSummary(next, {
              conversationId: newConversationId,
              content: conversationCheckpointContent(checkpoint),
              checkpoint,
              throughMessageId: summarizedMessages.at(-1)?.id,
              sourceMessageIds: summarizedMessages.map((message) => message.id),
            });
          }
          return next;
        });
        await appendConversationTreeNode(actor, {
          conversationId: newConversationId,
          parentConversationId: sourceConversationId,
          parentMessageId: sourceMessageId,
          action: "branch",
          memorySnapshotSequence,
          memorySnapshotVersionIds,
          mode: branchConversation.mode,
          projectId: branchConversation.projectId,
          serverId: branchConversation.work?.serverId,
          workspaceId: branchConversation.work?.workspaceId,
          workspaceName: branchConversation.work?.workspaceName,
          workspace: branchConversation.work?.workspace,
          workspaceMode: branchConversation.work?.workspaceMode,
          sourceCheckpointId:
            workspaceCapability.sourceCheckpointId || undefined,
          createdAt,
        });
        sendJson(res, 200, {
          conversation: branchConversation,
          seedPrompt: "",
          capability: {
            conversation: true,
            agentMemory: "new-session-bootstrap",
            ...workspaceCapability,
          },
        });
        return;
      }

      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role === "user");
      const lastAssistantMessage = [...messages]
        .reverse()
        .find((message) => message.role === "assistant");
      let truncateIndex = messageIndex;
      let originalUserMessage = null;
      let seedPrompt = "";
      if (action === "edit") {
        if (
          sourceMessage.role !== "user" ||
          lastUserMessage?.id !== sourceMessage.id
        ) {
          sendJson(res, 409, { error: "只能编辑当前对话最新一轮的用户提问" });
          return;
        }
        originalUserMessage = sourceMessage;
        seedPrompt = String(body.content || sourceMessage.content).trim();
      } else if (action === "reset") {
        if (
          sourceMessage.role !== "assistant" ||
          lastAssistantMessage?.id !== sourceMessage.id
        ) {
          sendJson(res, 409, { error: "只能重置当前对话的最新回复" });
          return;
        }
        truncateIndex = messageIndex - 1;
        while (
          truncateIndex >= 0 &&
          messages[truncateIndex].role !== "user"
        ) {
          truncateIndex -= 1;
        }
        if (truncateIndex < 0) {
          sendJson(res, 409, { error: "没有找到该回复对应的用户提问" });
          return;
        }
        originalUserMessage = messages[truncateIndex];
        seedPrompt = String(originalUserMessage.content || "").trim();
      } else {
        if (sourceMessage.role !== "assistant") {
          sendJson(res, 409, { error: "只能回溯到 EasyWork 的回复" });
          return;
        }
        truncateIndex = messageIndex + 1;
        if (truncateIndex >= messages.length) {
          sendJson(res, 409, { error: "当前已经是该回复对应的状态" });
          return;
        }
      }
      if (action !== "rewind" && !seedPrompt) {
        sendJson(res, 400, { error: "重新生成的提问不能为空" });
        return;
      }
      const affectedMessages = messages.slice(truncateIndex);
      const affectedMessageIds = affectedMessages.map((message) => message.id);
      const affectedRunIds = [
        ...new Set(
          affectedMessages
            .map((message) => String(message.runId || message.trace?.runId || ""))
            .filter(Boolean),
        ),
      ];
      let resetCapability = {
        workspace: source.mode === "work" ? "unchanged" : "not-applicable",
        workspaceMessage: "",
      };
      if (source.mode === "work" && affectedRunIds.length) {
        const checkpointDocument = await readCheckpointDocument(actor);
        const checkpointPairs = affectedRunIds.map((runId) => ({
          runId,
          before: checkpointForRun(checkpointDocument, runId, "before"),
          after: checkpointForRun(checkpointDocument, runId, "after"),
        }));
        const worker = await getSshWorker(actor);
        const groupedPairs = new Map();
        for (const pair of checkpointPairs) {
          const before = pair.before;
          const after = pair.after;
          if (!before || !after) {
            throw new Error(`任务 ${pair.runId} 缺少工作区检查点`);
          }
          const serverId = String(before.serverId || after.serverId || "");
          const workspaceId = String(
            before.workspaceId || after.workspaceId || "",
          );
          const workspace = String(before.workspace || after.workspace || "");
          if (!serverId || !workspaceId || !workspace) {
            throw new Error(`任务 ${pair.runId} 的工作区身份不完整`);
          }
          if (
            String(after.serverId || serverId) !== serverId ||
            String(after.workspaceId || workspaceId) !== workspaceId
          ) {
            throw new Error(`任务 ${pair.runId} 的前后检查点不属于同一工作区`);
          }
          const key = `${serverId}\u0000${workspaceId}`;
          const group = groupedPairs.get(key) || {
            serverId,
            workspaceId,
            workspace,
            workspaceName: String(before.workspaceName || after.workspaceName || ""),
            workspaceKind: String(before.workspaceKind || after.workspaceKind || "physical"),
            versionRoot: String(before.versionRoot || after.versionRoot || ""),
            versionDomainId: String(
              before.versionDomainId || after.versionDomainId || "",
            ),
            checkpoints: [],
          };
          group.checkpoints.push(pair);
          groupedPairs.set(key, group);
        }
        const revertedFiles = [];
        for (const group of groupedPairs.values()) {
          const targetSession = worker.sessions.get(
            safeSegment(group.serverId, ""),
          );
          const reverted = await selectivelyRevertWorkspaceRuns(
            targetSession,
            actor,
            {
              conversationId: sourceConversationId,
              serverId: group.serverId,
              workspaceId: group.workspaceId,
              workspace: group.workspace,
              workspaceName: group.workspaceName,
              workspaceKind: group.workspaceKind,
              versionRoot: group.versionRoot,
              versionDomainId: group.versionDomainId,
              checkpoints: group.checkpoints,
            },
          );
          revertedFiles.push(...reverted.files);
        }
        resetCapability = {
          workspace: "selectively-reset",
          workspaceMessage: revertedFiles.length
            ? `已仅撤销本轮对 ${new Set(revertedFiles).size} 个可快照文件的修改；其他对话保持不变，工作区外副作用不在可重置范围内。`
            : "本轮没有需要撤销的可快照文件修改；工作区外副作用不在可重置范围内。",
        };
      }
      const descendantTriggerMessageIds =
        action === "rewind"
          ? [sourceMessage.id, ...affectedMessageIds]
          : affectedMessageIds;
      const descendantIds = await pruneConversationTreeDescendants(
        actor,
        sourceConversationId,
        descendantTriggerMessageIds,
      );
      const descendantSet = new Set(descendantIds);
      const descendantConversations = (state.conversations || []).filter(
        (conversation) => descendantSet.has(String(conversation.id)),
      );
      let resetConversation;
      await updateState(actor, (current) => {
        const target = (current.conversations || []).find(
          (conversation) => conversation.id === sourceConversationId,
        );
        if (!target) throw new Error("原对话不存在");
        target.messages = (target.messages || []).slice(0, truncateIndex);
        target.updatedAt = isoNow();
        resetConversation = JSON.parse(JSON.stringify(target));
        current.conversations = (current.conversations || []).filter(
          (conversation) => !descendantSet.has(String(conversation.id)),
        );
        return current;
      });
      await updateMemoryDocument(actor, (current) => {
        let next = current;
        if (affectedRunIds.length) {
          next = invalidateMemoryVersions(next, {
            sourceConversationIds: [sourceConversationId],
            sourceTaskIds: affectedRunIds,
            reason: `${action}-run-reset`,
            invalidatedBy: sourceConversationId,
          });
        }
        next = invalidateMemoryVersions(next, {
          sourceConversationIds: [sourceConversationId],
          ...(action === "rewind"
            ? { sourceMessageIds: affectedMessageIds }
            : originalUserMessage?.createdAt
              ? { afterTimestamp: originalUserMessage.createdAt }
              : { sourceMessageIds: affectedMessageIds }),
          reason: `${action}-conversation-reset`,
          invalidatedBy: sourceConversationId,
        });
        if (descendantIds.length) {
          next = invalidateMemoryVersions(next, {
            sourceConversationIds: descendantIds,
            reason: `${action}-descendant-removed`,
            invalidatedBy: sourceConversationId,
          });
        }
        const invalidSummaryConversations = new Set([
          sourceConversationId,
          ...descendantIds,
        ]);
        next.summaries = next.summaries.map((summary) =>
          invalidSummaryConversations.has(String(summary.conversationId || "")) &&
          (summary.conversationId !== sourceConversationId ||
            affectedMessageIds.includes(String(summary.throughMessageId || "")))
            ? { ...summary, status: "invalidated", invalidatedAt: isoNow() }
            : summary,
        );
        next.overview = "";
        return next;
      });
      const affectedTaskSet = new Set(affectedRunIds.map(String));
      const affectedMessageSet = new Set(affectedMessageIds.map(String));
      const removedAgentState = await removeAgentBindingsForConversations(
        actor,
        [sourceConversationId, ...descendantIds],
        {
          shouldRemove: (binding) => {
            const bindingConversationId = String(
              binding?.conversationId || "",
            );
            if (descendantSet.has(bindingConversationId)) return true;
            const deliveredTaskIds = binding?.syncCursor?.deliveredTaskIds || [];
            return (
              affectedTaskSet.has(String(binding?.lastRunId || "")) ||
              affectedTaskSet.has(String(binding?.deliveryState?.runId || "")) ||
              deliveredTaskIds.some((id) => affectedTaskSet.has(String(id))) ||
              affectedMessageSet.has(
                String(binding?.syncCursor?.lastMessageId || ""),
              )
            );
          },
        },
      );
      await removeWorkerTasks(actor, affectedRunIds);
      await removeManagedBranchWorkspaces(actor, descendantConversations);
      for (const descendantId of descendantIds) {
        await tombstoneConversation(actor, descendantId);
      }
      sendJson(res, 200, {
        conversation: resetConversation,
        seedPrompt,
        removedConversationIds: descendantIds,
        capability: {
          conversation: true,
          agentMemory: removedAgentState.nativeSessions.every(
            (item) => item.status === "deleted",
          )
            ? "native-session-reset"
            : "detached-new-session-bootstrap",
          agentMemoryMessage: removedAgentState.nativeSessions.some(
            (item) => item.status === "detached",
          )
            ? "旧 Agent 原生会话无法删除，EasyWork 已解除绑定；重新生成会使用全新 Agent 会话。"
            : "",
          ...resetCapability,
          removedBranches: descendantIds.length,
          rewoundToMessageId:
            action === "rewind" ? sourceMessage.id : undefined,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/memories") {
      const actor = await resolveActor(req, res);
      const document = await readMemoryDocument(actor);
      sendJson(res, 200, {
        records: document.records.filter((record) => record.status !== "deleted"),
        overview: document.overview,
        revision: document.revision,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/memories") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const content = String(body.content || "").trim();
      const allowedScopes = new Set([
        "user",
        "project",
        "conversation",
        "workspace",
        "task",
      ]);
      const scope = allowedScopes.has(String(body.scope || ""))
        ? String(body.scope)
        : "user";
      const scopeId = scope === "user" ? "" : String(body.scopeId || "").trim();
      const sensitivity = ["normal", "personal", "restricted", "secret"].includes(
        String(body.sensitivity || ""),
      )
        ? String(body.sensitivity)
        : "normal";
      const validUntil = String(body.validUntil || "").trim();
      if (validUntil && !Number.isFinite(Date.parse(validUntil))) {
        throw new Error("记忆有效期格式无效");
      }
      if (!content) throw new Error("记忆内容不能为空");
      if (scope !== "user" && !scopeId) throw new Error("该记忆缺少作用域标识");
      let record;
      const document = await updateMemoryDocument(actor, (current) => {
        const next = appendExplicitMemory(current, {
          content,
          scope,
          scopeId,
          kind: String(body.kind || "preference"),
          semanticKey: String(body.semanticKey || ""),
          source: "用户手动添加",
          sourceConversationId: String(body.sourceConversationId || ""),
          portability:
            scope === "workspace"
              ? "workspace-bound"
              : scope === "project"
                ? "project-shared"
                : "universal",
          authority: "user-explicit",
          sensitivity,
          validUntil,
        });
        record = next.records.find(
          (item) =>
            item.scope === scope &&
            String(item.scopeId || "") === scopeId &&
            item.content === content,
        );
        return next;
      });
      sendJson(res, 200, { record, revision: document.revision });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/memories/overview") {
      const actor = await resolveActor(req, res);
      const document = await updateMemoryDocument(actor, (current) => {
        const active = activeMemoryRecords(current).slice(0, 8);
        const timestamp = isoNow();
        return {
          ...current,
          overview: active
            .map((record) => record.summary || record.content)
            .join("；")
            .slice(0, 2_000),
          revision: Number(current.revision || 0) + 1,
          updatedAt: timestamp,
          ledger: [
            ...(current.ledger || []),
            {
              id: randomId("event-"),
              type: "memory.overview-updated",
              timestamp,
            },
          ],
        };
      });
      sendJson(res, 200, { overview: document.overview });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/memories/instruction") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const instruction = String(body.instruction || "").trim();
      if (!instruction) throw new Error("请输入要更新的记忆");
      const deletion = /^(?:忘记|删除)(?:关于|掉)?[：:，,\s]*/.exec(instruction);
      const document = await updateMemoryDocument(actor, (current) => {
        if (deletion) {
          const target = instruction.slice(deletion[0].length).trim();
          let next = current;
          for (const record of activeMemoryRecords(current).filter(
            (item) => !target || item.content.includes(target),
          )) {
            next = appendMemoryTombstone(next, {
              memoryId: record.id,
              reason: target ? `用户要求忘记：${target}` : "用户要求清空记忆",
              source: "用户手动删除",
            });
          }
          next.overview = "";
          return next;
        }
        return appendExplicitMemory(current, {
          content: instruction,
          scope: "user",
          kind: "preference",
          source: "用户手动修正",
          portability: "universal",
          authority: "user-explicit",
        });
      });
      sendJson(res, 200, {
        records: activeMemoryRecords(document),
        overview: document.overview,
      });
      return;
    }

    if (url.pathname.startsWith("/api/memories/") && ["PATCH", "DELETE"].includes(req.method)) {
      const actor = await resolveActor(req, res);
      const memoryId = safeSegment(
        decodeURIComponent(url.pathname.slice("/api/memories/".length)),
        "",
      );
      if (!memoryId) throw new Error("记忆标识无效");
      const body = req.method === "PATCH" ? await parseJsonBody(req) : {};
      let record = null;
      const document = await updateMemoryDocument(actor, (current) => {
        const index = current.records.findIndex((item) => item.id === memoryId);
        if (index < 0) {
          const error = new Error("记忆不存在");
          error.statusCode = 404;
          throw error;
        }
        if (req.method === "DELETE") {
          return appendMemoryTombstone(current, {
            memoryId,
            reason: "用户删除",
            source: "用户手动删除",
          });
        } else {
          const existing = current.records[index];
          const content = String(body.content ?? existing.content).trim();
          if (!content) throw new Error("记忆内容不能为空");
          const enabled =
            typeof body.enabled === "boolean"
              ? body.enabled
              : existing.status === "active";
          const sensitivity = [
            "normal",
            "personal",
            "restricted",
            "secret",
          ].includes(String(body.sensitivity || ""))
            ? String(body.sensitivity)
            : existing.sensitivity;
          const validUntil = String(body.validUntil ?? existing.validUntil ?? "");
          if (validUntil && !Number.isFinite(Date.parse(validUntil))) {
            throw new Error("记忆有效期格式无效");
          }
          const next = appendExplicitMemory(current, {
            content,
            summary: String(body.summary ?? existing.summary ?? content),
            scope: existing.scope,
            scopeId: existing.scopeId,
            kind: existing.kind,
            semanticKey: existing.semanticKey,
            source: "用户手动修正",
            authority: "user-explicit",
            confidence: 1,
            sensitivity,
            portability: existing.portability,
            validUntil,
            status: enabled ? "active" : "disabled",
          });
          record = next.records.find((item) => item.id === memoryId) || null;
          next.overview = "";
          return next;
        }
      });
      sendJson(res, 200, {
        ok: true,
        record,
        revision: document.revision,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/context") {
      const actor = await resolveActor(req, res);
      const conversationId = String(url.searchParams.get("conversationId") || "");
      const state = await getState(actor);
      const memoryDocument = await readMemoryDocument(actor);
      const contextConversation = (state.conversations || []).find(
        (item) => String(item.id) === conversationId,
      );
      const usage = await measuredConversationContextUsage(
        actor,
        state,
        memoryDocument,
        conversationId,
      );
      const conversation = contextConversation;
      const bindings = await readAgentBindings(actor);
      const requestedServerId = String(
        url.searchParams.get("serverId") || conversation?.work?.serverId || "",
      );
      const requestedAgentId = String(
        url.searchParams.get("agentId") || conversation?.work?.agentId || "",
      );
      const requestedWorkspaceId = String(
        url.searchParams.get("workspaceId") ||
          conversation?.work?.workspaceId ||
          "",
      );
      const bindingCandidates = Object.values(bindings.bindings)
        .filter(
          (item) =>
          String(item?.conversationId || "") === conversationId &&
          (!requestedServerId || item?.serverId === requestedServerId) &&
          (!requestedAgentId || item?.agentId === requestedAgentId),
        )
        .sort(
          (left, right) =>
            (Date.parse(String(right?.updatedAt || "")) || 0) -
            (Date.parse(String(left?.updatedAt || "")) || 0),
        );
      const exactBinding = requestedWorkspaceId
        ? bindingCandidates.find(
            (item) => String(item?.workspaceId || "") === requestedWorkspaceId,
          )
        : bindingCandidates[0];
      const binding =
        exactBinding ||
        (conversation?.work?.workspaceKind === "virtual"
          ? bindingCandidates[0]
          : null);
      const nativeAgentContext = await inspectNativeAgentContext(actor, binding, {
        serverId: requestedServerId,
        agentId: requestedAgentId,
        agentAdapter: String(url.searchParams.get("agentAdapter") || ""),
        conversationId,
        workspaceId: requestedWorkspaceId,
      });
      const agentUsage = nativeAgentContext.usage || null;
      const agentUsed = agentUsage
        ? Number(
            agentUsage.total ||
              Number(agentUsage.input || 0) +
                Number(agentUsage.output || 0) +
                Number(agentUsage.reasoning || 0),
          )
        : nativeAgentContext.readable && !nativeAgentContext.bound
          ? 0
          : null;
      const agentLimit = positiveInteger(nativeAgentContext.limit);
      sendJson(res, 200, {
        web: {
          used: usage.used,
          limit: usage.limit,
          ratio: usage.ratio,
          automaticCompressionThreshold: usage.automaticCompressionThreshold,
          modifiable: true,
          compressible: usage.messageCount > 8,
          breakdown: usage.breakdown,
        },
        agent: {
          bound: Boolean(nativeAgentContext.bound),
          readable: Boolean(nativeAgentContext.readable),
          available: nativeAgentContext.available,
          used: agentUsed,
          limit: agentLimit,
          ratio:
            agentUsed !== null && agentLimit
              ? Math.min(1, agentUsed / agentLimit)
              : null,
          modifiable: Boolean(nativeAgentContext.modifiable),
          compressible: Boolean(
            nativeAgentContext.bound &&
              nativeAgentContext.compression?.supported,
          ),
          compressionSupported: Boolean(
            nativeAgentContext.compression?.supported,
          ),
          status: nativeAgentContext.status,
          diagnostic: nativeAgentContext.diagnostic || "",
          model: nativeAgentContext.model || "",
          limitSource: nativeAgentContext.limitSource || "",
          binding: binding
            ? {
                serverId: binding.serverId,
                agentId: binding.agentId,
                agentSessionId: binding.agentSessionId,
                workspaceId: binding.workspaceId,
                workspaceName: binding.workspaceName,
                workspace: binding.workspace,
                updatedAt: binding.updatedAt,
              }
            : null,
        },
      });
      return;
    }

    if (
      req.method === "PATCH" &&
      url.pathname === "/api/context/agent/settings"
    ) {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const result = await updateNativeAgentContextLimit(actor, {
        serverId: String(body.serverId || ""),
        agentId: String(body.agentId || ""),
        agentAdapter: String(body.agentAdapter || ""),
        conversationId: String(body.conversationId || ""),
        workspaceId: String(body.workspaceId || ""),
        contextLimit: body.contextLimit,
      });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/context/settings") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const conversationId = String(body.conversationId || "");
      const limit = Number(body.conversationLimit);
      const threshold = Number(body.automaticCompressionThreshold);
      if (!Number.isFinite(limit) || limit < 8_000 || limit > 2_000_000) {
        sendJson(res, 400, { error: "上下文上限应在 8k 到 2M 之间" });
        return;
      }
      if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
        sendJson(res, 400, { error: "自动压缩阈值应在 0.5 到 1 之间" });
        return;
      }
      const document = await updateMemoryDocument(actor, (current) => ({
        ...current,
        revision: Number(current.revision || 0) + 1,
        updatedAt: isoNow(),
        contextSettings: {
          conversationLimit: Math.floor(limit),
          automaticCompressionThreshold: threshold,
        },
        ledger: [
          ...(current.ledger || []),
          {
            id: randomId("event-"),
            type: "context.settings-updated",
            conversationLimit: Math.floor(limit),
            automaticCompressionThreshold: threshold,
            timestamp: isoNow(),
          },
        ],
      }));
      let autoCompression = {
        triggered: false,
        compressed: false,
        error: "",
      };
      let usage = null;
      if (conversationId) {
        const state = await getState(actor);
        usage = await measuredConversationContextUsage(
          actor,
          state,
          document,
          conversationId,
        );
        if (
          usage.messageCount > 8 &&
          usage.ratio >= document.contextSettings.automaticCompressionThreshold
        ) {
          autoCompression.triggered = true;
          try {
            const compressed = await compressConversationContext(
              actor,
              conversationId,
            );
            autoCompression.compressed = Boolean(compressed.compressed);
            const nextState = await getState(actor);
            const nextDocument = compressed.document || (await readMemoryDocument(actor));
            usage = await measuredConversationContextUsage(
              actor,
              nextState,
              nextDocument,
              conversationId,
            );
          } catch (caught) {
            autoCompression.error =
              caught instanceof Error ? caught.message : "自动压缩失败";
          }
        }
      }
      sendJson(res, 200, {
        settings: document.contextSettings,
        autoCompression,
        usage,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/context/compress") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const result = await compressConversationContext(
        actor,
        String(body.conversationId || ""),
      );
      sendJson(res, 200, {
        compressed: result.compressed,
        summary: result.summary,
        usage: result.usage,
      });
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/context/agent/compress"
    ) {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const conversationId = String(body.conversationId || "");
      const serverId = String(body.serverId || "");
      const agentId = String(body.agentId || "");
      const workspaceId = String(body.workspaceId || "");
      const bindings = await readAgentBindings(actor);
      const state = await getState(actor);
      const conversation = (state.conversations || []).find(
        (item) => String(item.id || "") === conversationId,
      );
      const candidates = Object.values(bindings.bindings)
        .filter(
          (item) =>
          String(item?.conversationId || "") === conversationId &&
          (!serverId || String(item?.serverId || "") === serverId) &&
          (!agentId || String(item?.agentId || "") === agentId),
        )
        .sort(
          (left, right) =>
            (Date.parse(String(right?.updatedAt || "")) || 0) -
            (Date.parse(String(left?.updatedAt || "")) || 0),
        );
      const binding =
        (workspaceId
          ? candidates.find(
              (item) => String(item?.workspaceId || "") === workspaceId,
            )
          : candidates[0]) ||
        (conversation?.work?.workspaceKind === "virtual"
          ? candidates[0]
          : null);
      const result = await compactNativeAgentContext(actor, binding);
      sendJson(res, 202, result);
      return;
    }

    if (
      req.method === "POST" &&
      ["/api/auth/register", "/api/auth/login"].includes(url.pathname)
    ) {
      const guestActor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const submittedUsername = displayUsername(body.username);
      const username = normalizeUsername(submittedUsername);
      const password = String(body.password || "");
      if (!validUsername(username)) {
        sendJson(res, 400, {
          error: "用户名需为 2-48 位中文、字母、数字、点、下划线或短横线",
        });
        return;
      }
      if (password.length < 8) {
        sendJson(res, 400, { error: "密码至少需要 8 位" });
        return;
      }
      let record;
      if (url.pathname.endsWith("/register")) {
        const result = await mutateAccounts(async () => {
          const records = await listUserRecords();
          if (records.some((item) => item.username === username)) {
            return { conflict: true };
          }
          const created = {
            id: crypto.randomUUID(),
            username,
            passwordHash: hashPassword(password),
            displayName: submittedUsername,
            avatar: "",
            createdAt: isoNow(),
          };
          if (!guestActor.authenticated) {
            await copyGuestDataToUser(guestActor, {
              ...created,
              authenticated: true,
            });
          }
          await writeUserRecord(created);
          if (!records.length) await ensureAdminUsername(created.username);
          return { record: created, firstAccount: !records.length };
        });
        if (result.conflict) {
          sendJson(res, 409, { error: "该用户名已注册" });
          return;
        }
        record = result.record;
      } else {
        const records = await listUserRecords();
        record = records.find((item) => item.username === username);
        if (!record || !verifyPassword(password, record.passwordHash)) {
          sendJson(res, 401, { error: "用户名或密码不正确" });
          return;
        }
      }
      const expires = Date.now() + SESSION_MAX_AGE * 1000;
      const session = signSession(record.id, expires);
      res.setHeader("Set-Cookie", cookie("ew_session", session, req, { maxAge: SESSION_MAX_AGE }));
      sendJson(res, 200, {
        actor: {
          id: record.id,
          authenticated: true,
          displayName: record.displayName,
          username: record.username,
          avatar: record.avatar || undefined,
          isAdmin: await isAdminUsername(record.username),
        },
        deviceToken: session,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const guestActor = {
        id: crypto.randomUUID(),
        authenticated: false,
        displayName: "未登录",
      };
      res.setHeader("Set-Cookie", [
        cookie("ew_session", "", req, { maxAge: 0 }),
        cookie("ew_guest", guestActor.id, req, { maxAge: SESSION_MAX_AGE }),
      ]);
      sendJson(res, 200, {
        ok: true,
        actor: guestActor,
        deviceToken: issueDeviceToken(guestActor),
      });
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/profile") {
      const actor = await resolveActor(req, res);
      if (!actor.authenticated) {
        sendJson(res, 401, { error: "请先登录" });
        return;
      }
      const body = await parseJsonBody(req);
      const submittedUsername = displayUsername(body.username);
      const username = normalizeUsername(submittedUsername);
      if (!validUsername(username)) {
        sendJson(res, 400, {
          error: "用户名需为 2-48 位中文、字母、数字、点、下划线或短横线",
        });
        return;
      }
      const result = await mutateAccounts(async () => {
        const records = await listUserRecords();
        if (
          records.some(
            (item) => item.id !== actor.id && item.username === username,
          )
        ) {
          return { conflict: true };
        }
        const record = records.find((item) => item.id === actor.id);
        if (!record) return { missing: true };
        const previousUsername = record.username;
        const wasAdmin = await isAdminUsername(previousUsername);
        record.username = username;
        record.displayName = submittedUsername;
        if (typeof body.avatar === "string" && body.avatar.length < 3_000_000) {
          record.avatar = body.avatar;
        }
        await writeUserRecord(record);
        if (wasAdmin && previousUsername !== username) {
          const names = await readAdminNames();
          names.delete(normalizeUsername(previousUsername));
          names.add(username);
          await writeAdminNames(names);
        }
        return { record };
      });
      if (result.conflict) {
        sendJson(res, 409, { error: "该用户名已注册" });
        return;
      }
      if (result.missing || !result.record) {
        sendJson(res, 404, { error: "账号不存在" });
        return;
      }
      const record = result.record;
      sendJson(res, 200, {
        actor: {
          id: record.id,
          authenticated: true,
          displayName: record.displayName,
          username: record.username,
          avatar: record.avatar || undefined,
          isAdmin: await isAdminUsername(record.username),
        },
      });
      return;
    }

    if (
      (req.method === "DELETE" && url.pathname === "/api/guest") ||
      (req.method === "POST" && url.pathname === "/api/guest/close")
    ) {
      const actor = await resolveActor(req, res, false);
      if (!actor.authenticated && actor.id !== "anonymous") {
        const dataTarget = path.resolve(actorDirectory(actor));
        const skillTarget = path.resolve(actorSkillDirectory(actor));
        if (dataTarget.startsWith(path.join(DATA_ROOT, "guests") + path.sep)) {
          await rm(dataTarget, { recursive: true, force: true });
        }
        if (skillTarget.startsWith(path.join(SKILL_ROOT, "guests") + path.sep)) {
          await rm(skillTarget, { recursive: true, force: true });
        }
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/provider/models") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const clientState = await stateForClient(actor);
      const { provider: selectedProvider, apiKey: storedApiKey } =
        await effectiveProviderAccess(
          actor,
          clientState.settings,
          String(body.providerId || ""),
        );
      const apiKey = String(body.apiKey || storedApiKey || "");
      if (!apiKey) {
        sendJson(res, 400, { error: "请输入 API Key" });
        return;
      }
      const baseUrl = String(body.baseUrl || selectedProvider?.baseUrl || "");
      const descriptors = await listProviderModelDescriptors(baseUrl, apiKey);
      const models = descriptors.map((descriptor) => descriptor.id);
      const available = models.filter(
        (model) =>
          !/(embedding|embed|moderation|whisper|tts|dall-e|image|audio|transcrib|realtime)/i.test(
            model,
          ),
      );
      const visibleModels = available.length ? available : models;
      if (!visibleModels.length) {
        sendJson(res, 404, { error: "接口没有返回可用模型" });
        return;
      }
      sendJson(res, 200, {
        providerId: selectedProvider?.id,
        providerName: selectedProvider?.name,
        models: visibleModels,
        modelDetails: Object.fromEntries(
          descriptors
            .filter((descriptor) => visibleModels.includes(descriptor.id))
            .map((descriptor) => [descriptor.id, descriptor]),
        ),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/provider/key") {
      const actor = await resolveActor(req, res);
      const state = await getState(actor);
      const secrets = await getSecrets(actor);
      const requestedProviderId = String(
        url.searchParams.get("providerId") || "",
      );
      const provider = [PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(
        requestedProviderId,
      )
        ? (await platformProviderAccess(requestedProviderId)).provider
        : modelProviderFor(state.settings, requestedProviderId);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, {
        providerId: provider.id,
        apiKey:
          provider.managedBy === "platform" ||
          [PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(provider.id)
            ? ""
            : providerApiKeyFor(secrets, provider.id),
      });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/provider") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const currentState = await getState(actor);
      const currentSettings = normalizeProviderSettings(
        currentState?.settings || {},
      );
      const requestedProviderId = safeSegment(
        body.providerId || currentSettings.activeProviderId || DEFAULT_PROVIDER_ID,
        DEFAULT_PROVIDER_ID,
      );
      const currentProvider =
        currentSettings.providers.find(
          (provider) => provider.id === requestedProviderId,
        ) || normalizeModelProvider({ id: requestedProviderId }, currentSettings.providers.length);
      const activate = body.activate !== false;
      if ([PLATFORM_WEB_PROVIDER_ID, PLATFORM_AGENT_PROVIDER_ID].includes(requestedProviderId)) {
        const access = await platformProviderAccess(
          requestedProviderId,
          Object.prototype.hasOwnProperty.call(body, "model")
            ? String(body.model || "")
            : "",
        );
        if (!access.provider.configured) {
          sendJson(res, 409, { error: "平台管理员尚未配置该公共 API" });
          return;
        }
        const selectedModel = String(body.model || access.provider.model || "").trim();
        const provider = { ...access.provider, model: selectedModel };
        await updateState(actor, (state) => {
          state.settings = normalizeProviderSettings(state.settings || {});
          state.settings.providers = [
            ...state.settings.providers.filter((item) => item.id !== requestedProviderId),
            provider,
          ];
          if (activate || !state.settings.activeProviderId) {
            state.settings.activeProviderId = requestedProviderId;
          }
          return state;
        });
        const savedState = await stateForClient(actor);
        sendJson(res, 200, {
          ok: true,
          providers: savedState.settings.providers,
          activeProviderId: savedState.settings.activeProviderId,
        });
        return;
      }
      if (body.apiKey) {
        await updateSecrets(actor, {
          providerCredential: {
            providerId: requestedProviderId,
            apiKey: String(body.apiKey),
          },
        });
      }
      const baseUrl = String(
        body.baseUrl || currentProvider.baseUrl || "https://api.openai.com/v1",
      );
      const modelWasProvided = Object.prototype.hasOwnProperty.call(body, "model");
      const selectedModel = modelWasProvided
        ? String(body.model || "")
        : String(currentProvider.model || "");
      let modelContextLimit =
        !modelWasProvided || selectedModel === String(currentProvider.model || "")
          ? positiveInteger(currentProvider.modelContextLimit)
          : null;
      let modelOutputLimit =
        !modelWasProvided || selectedModel === String(currentProvider.model || "")
          ? positiveInteger(currentProvider.modelOutputLimit)
          : null;
      const providerSecrets = await getSecrets(actor);
      const selectedProviderApiKey = providerApiKeyFor(
        providerSecrets,
        requestedProviderId,
      );
      if (selectedModel && selectedProviderApiKey) {
        try {
          const descriptors = await listProviderModelDescriptors(
            baseUrl,
            selectedProviderApiKey,
          );
          const descriptor = descriptors.find((item) => item.id === selectedModel);
          modelContextLimit = positiveInteger(descriptor?.contextLimit);
          modelOutputLimit = positiveInteger(descriptor?.outputLimit);
        } catch {
          // Saving a valid provider/model selection does not depend on optional
          // limit metadata. OpenCode's own config remains the next authority.
        }
      }
      const provider = {
        id: requestedProviderId,
        name: String(body.name || currentProvider.name || "默认 API")
          .trim()
          .slice(0, 80) || "默认 API",
        baseUrl,
        model: modelWasProvided
          ? selectedModel
          : baseUrl !== currentProvider.baseUrl
            ? ""
            : String(currentProvider.model || ""),
        modelContextLimit: modelContextLimit || undefined,
        modelOutputLimit: modelOutputLimit || undefined,
        protocol:
          body.protocol === "chat-completions" || body.protocol === "responses"
            ? body.protocol
            : currentProvider.protocol === "chat-completions" ||
                currentProvider.protocol === "responses"
              ? currentProvider.protocol
              : "auto",
        configured: Boolean(body.apiKey || selectedProviderApiKey),
        audience:
          body.audience === "web" || body.audience === "agent"
            ? body.audience
            : currentProvider.audience || "both",
        managedBy: "user",
      };
      await updateState(actor, (state) => {
        state.settings = normalizeProviderSettings(state.settings || {});
        const existingIndex = state.settings.providers.findIndex(
          (item) => item.id === requestedProviderId,
        );
        if (existingIndex >= 0) {
          state.settings.providers = state.settings.providers.map((item) =>
            item.id === requestedProviderId ? provider : item,
          );
        } else {
          state.settings.providers = [...state.settings.providers, provider];
        }
        if (activate || !state.settings.activeProviderId) {
          state.settings.activeProviderId = requestedProviderId;
        }
        return state;
      });
      const shouldSyncManagedAgents = Boolean(body.apiKey) ||
        (Object.prototype.hasOwnProperty.call(body, "baseUrl") &&
          baseUrl !== currentProvider.baseUrl);
      if (shouldSyncManagedAgents) {
        void syncManagedAgentsForActor(actor).catch((caught) => {
          console.warn(
            `[EasyWork Agent] provider sync skipped: ${
              caught instanceof Error ? caught.message : "unknown error"
            }`,
          );
        });
      }
      const savedState = await stateForClient(actor);
      sendJson(res, 200, {
        ok: true,
        providers: savedState.settings.providers,
        activeProviderId: savedState.settings.activeProviderId,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/provider/test") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const state = await stateForClient(actor);
      const { provider, apiKey: storedApiKey } = await effectiveProviderAccess(
        actor,
        state.settings,
        String(body.providerId || ""),
      );
      const apiKey = String(body.apiKey || storedApiKey || "");
      if (!apiKey) {
        sendJson(res, 400, { error: "缺少模型 API Key" });
        return;
      }
      const result = await callChatProvider(
        { ...provider, ...body, baseUrl: body.baseUrl || provider.baseUrl },
        apiKey,
        "",
        { test: true },
      );
      sendJson(res, 200, { ok: true, protocol: result.protocol });
      return;
    }

    if (
      ["/api/settings/embedding", "/api/settings/embedding/models", "/api/settings/embedding/test"].includes(
        url.pathname,
      )
    ) {
      sendJson(res, 403, { error: "Embedding 由平台管理员统一配置" });
      return;
    }

    if (req.method === "PUT" && url.pathname.startsWith("/api/settings/servers/")) {
      const actor = await resolveActor(req, res);
      const serverId = decodeURIComponent(
        url.pathname.slice("/api/settings/servers/".length),
      );
      const body = await parseJsonBody(req);
      const profile = await persistServerProfile(actor, body, serverId);
      sendJson(res, 200, { ok: true, profile });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/files") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const id = safeSegment(body.id || randomId("file_"));
      const name = safeSegment(body.name || "upload.bin");
      const buffer = Buffer.from(String(body.contentBase64 || ""), "base64");
      if (!buffer.length) {
        sendJson(res, 400, { error: "文件为空" });
        return;
      }
      const fileDir = actorAttachmentPath(actor, "library");
      await mkdir(fileDir, { recursive: true });
      await writeFile(path.join(fileDir, `${id}-${name}`), buffer);
      const result = await indexLibraryFile(
        actor,
        { id, name: String(body.name || name), type: String(body.type || "") },
        buffer,
      );
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/files/")) {
      const actor = await resolveActor(req, res);
      const id = safeSegment(decodeURIComponent(url.pathname.slice("/api/files/".length)));
      const fileDir = actorAttachmentPath(actor, "library");
      const entries = await readdir(fileDir).catch(() => []);
      for (const entry of entries) {
        if (entry === id || entry.startsWith(`${id}-`)) {
          const target = path.resolve(fileDir, entry);
          if (target.startsWith(path.resolve(fileDir) + path.sep)) {
            await rm(target, { force: true });
          }
        }
      }
      const indexPath = actorAttachmentPath(actor, "library-index.json");
      const index = await readJson(indexPath, { version: 1, files: {} });
      delete index.files?.[id];
      await writeJson(indexPath, index);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skills") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const id = safeSegment(body.id || randomId("skill_"));
      const target = path.join(actorSkillDirectory(actor), id);
      await mkdir(target, { recursive: true });
      for (const file of Array.isArray(body.files) ? body.files.slice(0, 300) : []) {
        const relative = safeRelativePath(file.path || "file");
        if (!relative) continue;
        const buffer = Buffer.from(String(file.contentBase64 || ""), "base64");
        const extension = path.extname(relative).toLowerCase();
        if (extension === ".zip") {
          const zip = new AdmZip(buffer);
          for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const zipRelative = safeRelativePath(entry.entryName);
            if (!zipRelative) continue;
            const destination = path.resolve(target, zipRelative);
            if (!destination.startsWith(path.resolve(target) + path.sep)) continue;
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, entry.getData());
          }
        } else {
          const destination = path.resolve(target, relative);
          if (!destination.startsWith(path.resolve(target) + path.sep)) continue;
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, buffer);
        }
      }
      const metadata = {
        id,
        name: String(body.name || id),
        uploadedAt: isoNow(),
      };
      await writeJson(path.join(target, ".easywork-skill.json"), metadata);
      sendJson(res, 200, { ok: true, id });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/skills/")) {
      const actor = await resolveActor(req, res);
      const id = safeSegment(decodeURIComponent(url.pathname.slice("/api/skills/".length)));
      const root = path.resolve(actorSkillDirectory(actor));
      const target = path.resolve(root, id);
      if (!target.startsWith(root + path.sep)) {
        sendJson(res, 400, { error: "技能路径无效" });
        return;
      }
      await rm(target, { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/chat/stream") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const fallbackTitle = body.firstTurn
        ? fallbackConversationTitle(String(body.prompt || ""))
        : "";
      await persistChatTurnStart(actor, body, fallbackTitle);
      const context = await buildContext({
        actor,
        mode: "chat",
        prompt: String(body.prompt || ""),
        skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
        projectId: body.projectId ? String(body.projectId) : undefined,
        memoryMode:
          body.memoryMode === "project-only" ? "project-only" : "project-and-global",
        conversationId: String(body.conversationId || ""),
        currentUserMessageId: String(body.userMessageId || ""),
      });
      await updateState(actor, (state) => {
        const conversation = (state.conversations || []).find(
          (item) => item.id === String(body.conversationId || ""),
        );
        const assistant = (conversation?.messages || []).find(
          (message) => message.id === String(body.assistantMessageId || ""),
        );
        if (assistant) assistant.webContextUsage = context.contextUsage;
        return state;
      });
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();
      const sendEvent = (event) => {
        if (!res.destroyed && !res.writableEnded) {
          res.write(`${JSON.stringify(event)}\n`);
        }
      };
      sendEvent({ type: "meta", sources: context.sources });
      if (fallbackTitle) sendEvent({ type: "title", title: fallbackTitle });
      try {
        const result = await runChatModelStream(
          actor,
          context.text,
          context.state,
          (kind, delta) => sendEvent({ type: `${kind}_delta`, delta }),
        );
        await persistChatTurnResult(actor, body, result);
        sendEvent({
          type: "done",
          content: result.content,
          reasoning: result.reasoning,
          demo: result.demo,
        });
        if (!res.writableEnded) res.end();
        if (actor.authenticated) {
          void finalizeChatTurn(actor, body, result, fallbackTitle).catch(
            (caught) =>
              console.warn(
                `[EasyWork Chat] background finalization failed: ${
                  caught instanceof Error ? caught.message : "unknown"
                }`,
              ),
          );
        }
        return;
      } catch (caught) {
        sendEvent({
          type: "error",
          error:
            caught instanceof Error ? caught.message : "模型流式请求失败",
        });
      }
      if (!res.writableEnded) res.end();
      return;
    }

    sendJson(res, 404, { error: "未找到接口" });
  } catch (caught) {
    const status = Number(caught?.statusCode || 500);
    const message = caught instanceof Error ? caught.message : "网关发生未知错误";
    console.error(`[easywork] ${req.method} ${req.url}:`, message);
    sendJson(res, status, { error: message });
  }
}

function wsSend(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function sessionSend(session, payload) {
  for (const socket of session.worker?.sockets || []) wsSend(socket, payload);
}

function createWorkerTask(session, payload) {
  const now = isoNow();
  const task = {
    runId: String(payload.runId || randomId("run-")),
    conversationId: String(payload.conversationId || randomId("chat-")),
    serverId: session.serverId,
    serverIdentity: session.serverIdentity,
    agentId: String(payload.agentId || "opencode"),
    projectId: payload.projectId ? String(payload.projectId) : undefined,
    memoryMode:
      payload.memoryMode === "project-only"
        ? "project-only"
        : "project-and-global",
    workspace: String(payload.workspace || ""),
    workspaceId: String(payload.workspaceId || ""),
    workspaceName: String(payload.workspaceName || ""),
    workspaceKind: payload.workspaceKind === "virtual" ? "virtual" : "physical",
    versionRoot: String(payload.versionRoot || ""),
    versionDomainId: String(payload.versionDomainId || ""),
    conversationWorkspaceId: String(
      payload.conversationWorkspaceId || payload.workspaceId || "",
    ),
    conversationWorkspaceName: String(
      payload.conversationWorkspaceName || payload.workspaceName || "",
    ),
    conversationWorkspace: String(
      payload.conversationWorkspace || payload.workspace || "",
    ),
    conversationWorkspaceMode: ["managed", "attached", "unmanaged"].includes(
      String(payload.conversationWorkspaceMode || ""),
    )
      ? String(payload.conversationWorkspaceMode)
      : ["managed", "attached", "unmanaged"].includes(
            String(payload.workspaceMode || ""),
          )
        ? String(payload.workspaceMode)
        : "unmanaged",
    conversationWorkspaceKind:
      payload.conversationWorkspaceKind === "virtual" ? "virtual" : "physical",
    dynamicWorkspace: Boolean(payload.dynamicWorkspace),
    prompt: String(payload.prompt || ""),
    firstTurn: Boolean(payload.firstTurn),
    userMessageId: String(payload.userMessageId || `${payload.runId}_user`),
    assistantMessageId: String(
      payload.assistantMessageId || `${payload.runId}_assistant`,
    ),
    branchId: String(payload.branchId || payload.conversationId || ""),
    workspaceMode: ["managed", "attached", "unmanaged"].includes(
      String(payload.workspaceMode || ""),
    )
      ? String(payload.workspaceMode)
      : "unmanaged",
    checkpointBeforeId: "",
    checkpointAfterId: "",
    title: "",
    status: "running",
    steps: [],
    events: [],
    appendedInstructions: [],
    result: "",
    error: "",
    startedAt: now,
    updatedAt: now,
    finishedAt: "",
  };
  session.worker.tasks.set(task.runId, task);
  scheduleSshWorkerPersist(session.worker, 0);
  return task;
}

function recordWorkerEvent(session, payload) {
  const runId = String(payload.runId || "");
  if (!runId) return;
  const task = session.worker?.tasks.get(runId);
  if (!task) return;
  task.updatedAt = isoNow();
  if (payload.type === "conversation.title") {
    task.title = String(payload.title || "");
  } else if (payload.type === "workflow") {
    task.steps = Array.isArray(payload.steps)
      ? payload.steps.map((step, index) => ({
          id: String(step?.id || `${runId}_step_${index}`),
          title: String(step?.title || step || ""),
          status: String(step?.status || "pending"),
        }))
      : [];
  } else if (payload.type === "agent.event" && payload.event?.id) {
    const incoming = JSON.parse(JSON.stringify(payload.event));
    const existingIndex = task.events.findIndex(
      (event) => event.id === incoming.id,
    );
    if (existingIndex >= 0) {
      const existing = task.events[existingIndex];
      task.events[existingIndex] = {
        ...existing,
        ...incoming,
        // Several providers finish a streamed item with a status-only event.
        // Keep the accumulated text so the completed conversation can be
        // persisted and reloaded with the same visible reasoning content.
        output:
          typeof incoming.output === "string" && incoming.output.length
            ? incoming.output
            : existing.output,
        detail:
          typeof incoming.detail === "string" && incoming.detail.length
            ? incoming.detail
            : existing.detail,
      };
    } else {
      task.events.push(incoming);
    }
  } else if (payload.type === "task.complete") {
    task.status = "done";
    task.result = String(payload.result || "");
    task.finishedAt = isoNow();
  } else if (payload.type === "task.error") {
    task.status = "error";
    task.error = String(payload.result || "远程任务执行失败");
    task.result = task.error;
    task.finishedAt = isoNow();
    task.steps = task.steps.map((step) => ({
      ...step,
      status: step.status === "running" ? "error" : step.status,
    }));
  } else if (payload.type === "task.aborted") {
    task.status = "aborted";
    task.error = "";
    task.result = String(payload.result || "任务已停止");
    task.finishedAt = isoNow();
    task.events = task.events.map((event) => ({
      ...event,
      status: event.status === "running" ? "cancelled" : event.status,
    }));
    task.steps = task.steps.map((step) => ({
      ...step,
      status: step.status === "running" ? "cancelled" : step.status,
    }));
  }
  scheduleSshWorkerPersist(session.worker);
}

function publishWorkerEvent(session, payload) {
  const published =
    payload?.type === "agent.event" && typeof payload.event?.output === "string"
      ? {
          ...payload,
          event: {
            ...payload.event,
            output: stripEasyWorkProtocolMarkers(payload.event.output),
          },
        }
      : payload;
  recordWorkerEvent(session, published);
  sessionSend(session, published);
}

function replayWorkerTasks(socket, worker) {
  const tasks = [...worker.tasks.values()]
    .filter((task) => task.status === "running")
    .sort((left, right) =>
      String(left.startedAt || "").localeCompare(String(right.startedAt || "")),
    );
  for (const task of tasks) {
    if (task.title) {
      wsSend(socket, {
        type: "conversation.title",
        conversationId: task.conversationId,
        runId: task.runId,
        title: task.title,
      });
    }
    if (task.steps.length) {
      wsSend(socket, {
        type: "workflow",
        conversationId: task.conversationId,
        runId: task.runId,
        steps: task.steps,
      });
    }
    for (const event of task.events) {
      wsSend(socket, {
        type: "agent.event",
        conversationId: task.conversationId,
        runId: task.runId,
        event,
      });
    }
  }
}

async function ensureWorkerTaskConversation(actor, task) {
  await updateState(actor, (state) => {
    state.conversations = Array.isArray(state.conversations)
      ? state.conversations
      : [];
    let conversation = state.conversations.find(
      (item) => item.id === task.conversationId,
    );
    if (!conversation) {
      conversation = {
        id: task.conversationId,
        title: task.title || "新对话",
        mode: "work",
        projectId: task.projectId,
        messages: [],
        updatedAt: task.updatedAt,
        work: {
          agentId: task.agentId,
          serverId: task.serverId,
          connectionEnabled: true,
          workspace: task.conversationWorkspace,
          workspaceMode: task.conversationWorkspaceMode,
          workspaceId: task.conversationWorkspaceId,
          workspaceName: task.conversationWorkspaceName,
          workspaceKind: task.conversationWorkspaceKind,
        },
      };
      state.conversations.unshift(conversation);
    }
    conversation.mode = "work";
    conversation.updatedAt = task.updatedAt;
    conversation.projectId ||= task.projectId;
    conversation.work = {
      ...(conversation.work || {}),
      agentId: task.agentId,
      serverId: task.serverId,
      connectionEnabled: true,
      workspace: task.conversationWorkspace,
      workspaceMode: task.conversationWorkspaceMode,
      workspaceId: task.conversationWorkspaceId,
      workspaceName: task.conversationWorkspaceName,
      workspaceKind: task.conversationWorkspaceKind,
    };
    conversation.messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
    let userMessage = conversation.messages.find(
      (message) => message.runId === task.runId && message.role === "user",
    );
    if (!userMessage) {
      userMessage = {
        id: task.userMessageId,
        role: "user",
        content: task.prompt,
        createdAt: task.startedAt,
        mode: "work",
        runId: task.runId,
        workspaceId: task.workspaceId,
        workspaceName: task.workspaceName,
        workspaceKind: task.workspaceKind,
        dynamicWorkspace: task.dynamicWorkspace,
        trace: {
          runId: task.runId,
          status: "running",
          steps: [],
          startedAt: task.startedAt,
        },
      };
      conversation.messages.push(userMessage);
    }
    let assistantMessage = conversation.messages.find(
      (message) => message.runId === task.runId && message.role === "assistant",
    );
    if (!assistantMessage) {
      assistantMessage = {
        id: task.assistantMessageId,
        role: "assistant",
        content: "",
        createdAt: task.startedAt,
        mode: "work",
        runId: task.runId,
        agentId: task.agentId,
        workspaceId: task.workspaceId,
        workspaceName: task.workspaceName,
        workspaceKind: task.workspaceKind,
        dynamicWorkspace: task.dynamicWorkspace,
        reasoningStatus: "running",
        events: [],
      };
      conversation.messages.push(assistantMessage);
    }
    return state;
  });
}

async function persistAppendedInstruction(actor, task, instruction) {
  task.appendedInstructions = Array.isArray(task.appendedInstructions)
    ? task.appendedInstructions
    : [];
  const existing = task.appendedInstructions.find(
    (item) => item.messageId === instruction.messageId,
  );
  if (existing) Object.assign(existing, instruction);
  else task.appendedInstructions.push(instruction);
  task.updatedAt = isoNow();
  await ensureWorkerTaskConversation(actor, task);
  await updateState(actor, (state) => {
    const conversation = (state.conversations || []).find(
      (item) => item.id === task.conversationId,
    );
    if (!conversation) return state;
    conversation.updatedAt = task.updatedAt;
    conversation.messages = Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
    if (
      conversation.messages.some(
        (message) => message.id === instruction.messageId,
      )
    ) {
      return state;
    }
    const appendedMessage = {
      id: instruction.messageId,
      role: "user",
      content: instruction.content,
      createdAt: instruction.createdAt,
      mode: "work",
      appendedToRunId: task.runId,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
    };
    const assistantIndex = conversation.messages.findIndex(
      (message) => message.id === task.assistantMessageId,
    );
    if (assistantIndex >= 0) {
      conversation.messages.splice(assistantIndex, 0, appendedMessage);
    } else {
      conversation.messages.push(appendedMessage);
    }
    return state;
  });
}

async function deliverAppendedInstruction(session, task, activeRun, instruction) {
  if (!activeRun?.agentControl) return false;
  instruction.status = "sending";
  instruction.updatedAt = isoNow();
  scheduleSshWorkerPersist(session.worker);
  try {
    if (activeRun.agentControl.adapter === "opencode") {
      await appendOpenCodeInstruction(
        session,
        activeRun.agentControl,
        instruction.content,
      );
    } else if (activeRun.agentControl.adapter === "claude") {
      await sendRemoteRuntimeInput(session, activeRun.remoteRun, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: instruction.content }],
        },
      });
    } else if (activeRun.agentControl.adapter === "codex") {
      const deadline = Date.now() + 15_000;
      while (
        (!activeRun.agentControl.sessionId || !activeRun.agentControl.turnId) &&
        Date.now() < deadline
      ) {
        await waitFor(80);
      }
      if (!activeRun.agentControl.sessionId || !activeRun.agentControl.turnId) {
        throw new Error("Codex 当前轮次尚未进入可追加状态");
      }
      await sendRemoteRuntimeInput(session, activeRun.remoteRun, {
        id: `easywork-steer-${safeSegment(instruction.messageId)}`,
        method: "turn/steer",
        params: {
          threadId: activeRun.agentControl.sessionId,
          expectedTurnId: activeRun.agentControl.turnId,
          input: [
            { type: "text", text: instruction.content, text_elements: [] },
          ],
        },
      });
    } else {
      throw new Error("当前 Agent 不支持运行中追加输入");
    }
    instruction.status = "sent";
    instruction.sentAt = isoNow();
    instruction.updatedAt = instruction.sentAt;
    task.updatedAt = instruction.sentAt;
    scheduleSshWorkerPersist(session.worker, 0);
    sessionSend(session, {
      type: "work.append.delivered",
      serverId: session.serverId,
      conversationId: task.conversationId,
      runId: task.runId,
      messageId: instruction.messageId,
    });
    return true;
  } catch (caught) {
    instruction.status = "error";
    instruction.error =
      caught instanceof Error ? caught.message : "追加指令发送失败";
    instruction.updatedAt = isoNow();
    scheduleSshWorkerPersist(session.worker, 0);
    throw caught;
  }
}

async function flushAppendedInstructions(session, task, activeRun) {
  for (const instruction of task.appendedInstructions || []) {
    if (["sent", "sending"].includes(instruction.status)) continue;
    await deliverAppendedInstruction(session, task, activeRun, instruction);
  }
}

async function persistWorkerTaskConversation(actor, task) {
  await ensureWorkerTaskConversation(actor, task);
  await updateState(actor, (state) => {
    const conversation = (state.conversations || []).find(
      (item) => item.id === task.conversationId,
    );
    if (!conversation) return state;
    if (task.title) conversation.title = task.title;
    conversation.updatedAt = task.updatedAt;
    const userMessage = (conversation.messages || []).find(
      (message) => message.runId === task.runId && message.role === "user",
    );
    const assistantMessage = (conversation.messages || []).find(
      (message) => message.runId === task.runId && message.role === "assistant",
    );
    if (userMessage) {
      userMessage.trace = {
        runId: task.runId,
        status:
          task.status === "done"
            ? "done"
            : task.status === "error"
              ? "error"
              : task.status === "aborted"
                ? "aborted"
                : "running",
        steps: task.steps,
        result: task.result || undefined,
        startedAt: task.startedAt,
        checkpointBeforeId: task.checkpointBeforeId || undefined,
        checkpointAfterId: task.checkpointAfterId || undefined,
        workspaceId: task.workspaceId || undefined,
        workspaceName: task.workspaceName || undefined,
        workspaceKind: task.workspaceKind || undefined,
        dynamicWorkspace: Boolean(task.dynamicWorkspace),
        versionDomainId: task.versionDomainId || undefined,
      };
    }
    if (assistantMessage) {
      const reasoning = task.events
        .filter((event) => event.kind === "reasoning")
        .map((event) => event.output || event.detail)
        .filter(Boolean)
        .at(-1);
      const finalMessage = task.events
        .filter((event) => event.kind === "message" && event.output)
        .at(-1);
      assistantMessage.content =
        finalMessage?.output ||
        (["error", "aborted"].includes(task.status)
          ? task.error || task.result
          : task.result) ||
        assistantMessage.content ||
        "";
      assistantMessage.reasoning = reasoning || assistantMessage.reasoning;
      assistantMessage.reasoningStatus =
        task.status === "running"
          ? "running"
          : task.status === "error"
            ? "error"
             : "done";
      assistantMessage.checkpointBeforeId = task.checkpointBeforeId || undefined;
      assistantMessage.checkpointAfterId = task.checkpointAfterId || undefined;
      assistantMessage.workspaceId = task.workspaceId || undefined;
      assistantMessage.workspaceName = task.workspaceName || undefined;
      assistantMessage.workspaceKind = task.workspaceKind || undefined;
      assistantMessage.dynamicWorkspace = Boolean(task.dynamicWorkspace);
      assistantMessage.webContextUsage = task.webContextUsage || undefined;
      assistantMessage.events = task.events.filter(
        (event) => !["message", "reasoning"].includes(event.kind),
      );
    }
    return state;
  });
}

function remoteExec(client, command, options = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: options.pty || false }, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      options.onStream?.(stream);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeout = options.timeoutMs
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            stream.close();
            reject(new Error("远端命令等待超时"));
          }, options.timeoutMs)
        : null;
      stream.on("data", (chunk) => {
        stdout += chunk.toString();
        options.onStdout?.(chunk.toString());
      });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        options.onStderr?.(chunk.toString());
      });
      stream.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        const result = { code: Number(code || 0), signal, stdout, stderr };
        if (code && !options.allowFailure) {
          const failure = new Error(stderr.trim() || `远端命令退出码 ${code}`);
          failure.result = result;
          reject(failure);
        } else {
          resolve(result);
        }
      });
      if (options.input !== undefined) {
        stream.end(options.input);
      }
    });
  });
}

function remoteSftpWrite(client, remotePath, content, mode = 0o600) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.writeFile(remotePath, content, { mode }, (writeError) => {
        sftp.end();
        if (writeError) reject(writeError);
        else resolve();
      });
    });
  });
}

function remoteSftpFastPut(client, localPath, remotePath, onProgress = () => undefined) {
  return withRemoteSftp(
    client,
    (sftp) =>
      new Promise((resolve, reject) => {
        let lastReported = -1;
        sftp.fastPut(
          localPath,
          remotePath,
          {
            step(transferred, _chunk, total) {
              const percent = total > 0 ? Math.floor((transferred / total) * 100) : 0;
              if (percent === 100 || percent >= lastReported + 5) {
                lastReported = percent;
                onProgress(percent);
              }
            },
          },
          (error) => {
            if (error) reject(error);
            else resolve();
          },
        );
      }),
  );
}

async function remoteSftpReadOptional(client, remotePath) {
  try {
    return await remoteSftpRead(client, remotePath);
  } catch (caught) {
    if (
      caught?.code === 2 ||
      caught?.code === "ENOENT" ||
      /no such file/i.test(String(caught?.message || ""))
    ) {
      return null;
    }
    throw caught;
  }
}

async function remoteSftpWriteAtomic(client, remotePath, content, mode = 0o600) {
  const tempPath = `${remotePath}.easywork-${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await remoteSftpWrite(client, tempPath, content, mode);
    await remoteExec(
      client,
      [
        `chmod ${Number(mode).toString(8)} ${shellQuote(tempPath)}`,
        `mv -f ${shellQuote(tempPath)} ${shellQuote(remotePath)}`,
      ].join(" && "),
    );
  } catch (caught) {
    await remoteExec(client, `rm -f ${shellQuote(tempPath)}`, {
      allowFailure: true,
    }).catch(() => undefined);
    throw caught;
  }
}

function withRemoteSftp(client, operation) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      Promise.resolve()
        .then(() => operation(sftp))
        .then(resolve, reject)
        .finally(() => sftp.end());
    });
  });
}

function remoteSftpRead(client, remotePath) {
  return withRemoteSftp(
    client,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readFile(remotePath, (error, data) => {
          if (error) reject(error);
          else resolve(data);
        });
      }),
  );
}

function remoteSftpList(client, remotePath) {
  return withRemoteSftp(
    client,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (error, list) => {
          if (error) reject(error);
          else resolve(list || []);
        });
      }),
  );
}

function remoteSftpMkdir(client, remotePath) {
  return withRemoteSftp(
    client,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.mkdir(remotePath, (error) => {
          if (error && error.code !== 4) reject(error);
          else resolve();
        });
      }),
  );
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function forwardRemotePort(client, address, port) {
  return new Promise((resolve, reject) => {
    client.forwardIn(address, port, (error, assignedPort) => {
      if (error) reject(error);
      else resolve(Number(assignedPort || port));
    });
  });
}

function unforwardRemotePort(client, address, port) {
  return new Promise((resolve) => {
    client.unforwardIn(address, port, () => resolve());
  });
}

function attachProviderRelayHandler(session, client) {
  client.on("tcp connection", (details, accept, reject) => {
    const relay = session.apiRelays?.get(Number(details.destPort));
    if (!relay || relay.client !== client) {
      reject();
      return;
    }
    const channel = accept();
    const localSocket = net.createConnection({
      host: "127.0.0.1",
      port: relay.localPort,
    });
    channel.pipe(localSocket).pipe(channel);
    channel.on("error", () => localSocket.destroy());
    channel.on("close", () => localSocket.destroy());
    localSocket.on("error", () => channel.destroy());
    localSocket.on("close", () => channel.destroy());
  });
}

function clearProviderRelays(session) {
  for (const relay of session.apiRelays?.values() || []) relay.close();
  session.apiRelays?.clear();
  session.providerRoute = null;
}

async function stopProviderRelay(session, relay) {
  if (!relay) return;
  session.apiRelays?.delete(relay.remotePort);
  if (session.providerRoute === relay) session.providerRoute = null;
  if (session.client === relay.client) {
    await unforwardRemotePort(relay.client, relay.bindAddress, relay.remotePort).catch(
      () => undefined,
    );
  }
  relay.close();
}

function providerProbeCommand(baseUrl) {
  return [
    "set +e",
    `EW_PROVIDER_URL=${shellQuote(baseUrl)}`,
    'EW_HTTP=$(curl --silent --show-error --output /dev/null --head --connect-timeout 5 --max-time 8 --write-out "%{http_code}" "$EW_PROVIDER_URL" 2>"$HOME/.easywork/tmp/provider-probe.err")',
    "EW_CODE=$?",
    'printf "CODE=%s\\nHTTP=%s\\n" "$EW_CODE" "$EW_HTTP"',
    'if [ -s "$HOME/.easywork/tmp/provider-probe.err" ]; then tail -n 2 "$HOME/.easywork/tmp/provider-probe.err"; fi',
    'rm -f "$HOME/.easywork/tmp/provider-probe.err"',
    'exit "$EW_CODE"',
  ].join("\n");
}

async function probeRemoteProvider(session, baseUrl) {
  await remoteExec(
    session.client,
    'mkdir -p "$HOME/.easywork/tmp" && chmod 700 "$HOME/.easywork/tmp"',
  );
  const result = await remoteExec(session.client, providerProbeCommand(baseUrl), {
    allowFailure: true,
  });
  const fields = parseRuntimeFields(result.stdout);
  const status = Number(fields.HTTP || 0);
  return {
    reachable:
      status >= 100 &&
      status <= 599 &&
      status !== PROVIDER_RELAY_ERROR_STATUS,
    status,
    diagnostic: String(result.stderr || result.stdout || "连接失败")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400),
  };
}

function relayBaseUrl(remotePort, providerBaseUrl) {
  const upstream = new URL(providerBaseUrl);
  return `http://127.0.0.1:${remotePort}${upstream.pathname || "/"}${upstream.search || ""}`;
}

async function ensureRemoteProviderRoute(session, provider) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const providerBaseUrl = String(provider.baseUrl || "").trim();
  const routeKey = crypto.createHash("sha256").update(providerBaseUrl).digest("hex");
  const cached = session.providerRoute;
  if (
    cached?.key === routeKey &&
    cached.client === session.client &&
    (cached.mode === "relay" || Date.now() - cached.checkedAt < PROVIDER_ROUTE_CACHE_MS)
  ) {
    return cached;
  }
  if (cached?.mode === "relay") await stopProviderRelay(session, cached);

  const direct = await probeRemoteProvider(session, providerBaseUrl);
  if (direct.reachable) {
    const route = {
      key: routeKey,
      mode: "direct",
      baseUrl: providerBaseUrl,
      checkedAt: Date.now(),
      client: session.client,
    };
    session.providerRoute = route;
    return route;
  }

  const localRelay = await createLocalProviderRelay(providerBaseUrl).catch(
    (error) => {
      throw new Error(
        `远端无法直连模型 API（${direct.diagnostic || "连接失败"}），主机中继启动失败：${error instanceof Error ? error.message : "未知错误"}`,
      );
    },
  );
  let relay;
  try {
    const portResult = await remoteExec(session.client, remoteOpenCodePortCommand());
    const requestedPort = Number(portResult.stdout.trim());
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      throw new Error("无法分配远端回环端口");
    }
    const bindAddress = "127.0.0.1";
    const remotePort = await forwardRemotePort(
      session.client,
      bindAddress,
      requestedPort,
    );
    relay = {
      key: routeKey,
      mode: "relay",
      baseUrl: relayBaseUrl(remotePort, providerBaseUrl),
      upstreamBaseUrl: providerBaseUrl,
      checkedAt: Date.now(),
      client: session.client,
      bindAddress,
      remotePort,
      localPort: localRelay.localPort,
      close: localRelay.close,
    };
    session.apiRelays.set(remotePort, relay);
    const relayed = await probeRemoteProvider(session, relay.baseUrl);
    if (!relayed.reachable) {
      throw new Error(
        `SSH 模型 API 中继不可用：${relayed.diagnostic || `HTTP ${relayed.status || 0}`}`,
      );
    }
    session.providerRoute = relay;
    return relay;
  } catch (error) {
    if (relay) await stopProviderRelay(session, relay);
    else localRelay.close();
    throw new Error(
      `远端无法直连模型 API（${direct.diagnostic || "连接失败"}），且 SSH 中继建立失败：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}

function openCodeServicePaths(session, agent) {
  const serviceKey = String(
    agent.serviceKey ||
      `${agent.id || "opencode"}:${agent.runtimeId || agent.configPath || "default"}`,
  );
  const serviceId = crypto
    .createHash("sha256")
    .update(`${String(agent.path || agent.id || "opencode")}\u0000${serviceKey}`)
    .digest("hex")
    .slice(0, 16);
  const root = `${session.home}/.easywork/services/opencode/${serviceId}`;
  return {
    serviceId,
    root,
    portPath: `${root}/port`,
    passwordPath: `${root}/password`,
    curlConfigPath: `${root}/curl.conf`,
    launcherPath: `${root}/launch.sh`,
    pidPath: `${root}/pid`,
    logPath: `${root}/server.log`,
    requestsPath: `${root}/requests`,
    serviceKey,
  };
}

async function stopOpenCodeService(session, agent) {
  if (!session.client || !session.home || !agent?.path) return;
  const paths = openCodeServicePaths(session, agent);
  await remoteExec(
    session.client,
    [
      "set +e",
      `EW_PID_FILE=${shellQuote(paths.pidPath)}`,
      `EW_AGENT=${shellQuote(agent.path)}`,
      'EW_PID=$(cat "$EW_PID_FILE" 2>/dev/null)',
      'case "$EW_PID" in ""|*[!0-9]*) exit 0 ;; esac',
      'EW_COMMAND=$(ps -p "$EW_PID" -o args= 2>/dev/null)',
      'case "$EW_COMMAND" in *"$EW_AGENT"*" serve"*) ;; *) rm -f "$EW_PID_FILE"; exit 0 ;; esac',
      'kill -TERM "$EW_PID" 2>/dev/null || true',
      'EW_WAIT=0; while kill -0 "$EW_PID" 2>/dev/null && test "$EW_WAIT" -lt 5; do sleep 1; EW_WAIT=$((EW_WAIT + 1)); done',
      'if kill -0 "$EW_PID" 2>/dev/null; then EW_COMMAND=$(ps -p "$EW_PID" -o args= 2>/dev/null); case "$EW_COMMAND" in *"$EW_AGENT"*" serve"*) kill -KILL "$EW_PID" 2>/dev/null || true ;; esac; fi',
      'rm -f "$EW_PID_FILE"',
    ].join("\n"),
    { allowFailure: true },
  );
  session.openCodeServices?.delete(paths.serviceKey);
  session.openCodeServicePromises?.delete(paths.serviceKey);
}

async function probeOpenCodeService(session, service) {
  const result = await remoteExec(
    session.client,
    [
      "set +e",
      `EW_PID_FILE=${shellQuote(service.pidPath)}`,
      `EW_CURL_CONFIG=${shellQuote(service.curlConfigPath)}`,
      `EW_PORT_FILE=${shellQuote(service.portPath)}`,
      '[ -r "$EW_PID_FILE" ] && [ -r "$EW_CURL_CONFIG" ] && [ -r "$EW_PORT_FILE" ] || exit 1',
      'EW_PID=$(cat "$EW_PID_FILE" 2>/dev/null)',
      'EW_PORT=$(cat "$EW_PORT_FILE" 2>/dev/null)',
      'case "$EW_PID:$EW_PORT" in *[!0-9:]*|:|*:) exit 1 ;; esac',
      'kill -0 "$EW_PID" 2>/dev/null || exit 1',
      'curl --config "$EW_CURL_CONFIG" --silent --show-error --fail --max-time 4 -o /dev/null "http://127.0.0.1:$EW_PORT/global/health" || exit 1',
      'printf "READY\\t%s\\t%s\\n" "$EW_PORT" "$EW_PID"',
    ].join("\n"),
    { allowFailure: true },
  );
  if (result.code !== 0) return null;
  const [, portText, pid] = result.stdout.trim().split("\t");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    ...service,
    port,
    pid: String(pid || ""),
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function startOpenCodeService(session, agent) {
  if (!session.client || !session.home) throw new Error("SSH 尚未连接");
  const paths = openCodeServicePaths(session, agent);
  const cached = session.openCodeServices?.get(paths.serviceKey);
  const live = await probeOpenCodeService(session, cached || paths);
  if (live) {
    session.openCodeServices.set(paths.serviceKey, live);
    return live;
  }

  await remoteExec(
    session.client,
    [
      "set -eu",
      `EW_ROOT=${shellQuote(paths.root)}`,
      `EW_PID_FILE=${shellQuote(paths.pidPath)}`,
      `EW_AGENT=${shellQuote(agent.path)}`,
      'mkdir -p "$EW_ROOT" "$EW_ROOT/requests"',
      'chmod 700 "$EW_ROOT" "$EW_ROOT/requests"',
      'if [ -r "$EW_PID_FILE" ]; then',
      '  EW_OLD_PID=$(cat "$EW_PID_FILE" 2>/dev/null || true)',
      '  case "$EW_OLD_PID" in ""|*[!0-9]*) ;; *)',
      '    if kill -0 "$EW_OLD_PID" 2>/dev/null; then',
      '      EW_OLD_COMMAND=$(ps -p "$EW_OLD_PID" -o args= 2>/dev/null || true)',
      '      case "$EW_OLD_COMMAND" in *"$EW_AGENT"*" serve"*) kill "$EW_OLD_PID" 2>/dev/null || true ;; esac',
      '    fi',
      '  ;; esac',
      'fi',
      'rm -f "$EW_PID_FILE"',
    ].join("\n"),
  );

  const portResult = await remoteExec(
    session.client,
    remoteOpenCodePortCommand(),
  );
  const port = Number(portResult.stdout.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("无法为 OpenCode 会话服务分配本地端口");
  }
  const password = crypto.randomBytes(32).toString("hex");
  const baseManagedConfig = agent.managed
    ? agentConfigFor("opencode", session.home, {
        managed: true,
        agentId: agent.id,
      })
    : null;
  const managedConfig = baseManagedConfig
    ? {
        ...baseManagedConfig,
        configPath: agent.configPath || baseManagedConfig.configPath,
        dataPath: agent.dataPath || baseManagedConfig.dataPath,
        configRoot: agent.configRoot || baseManagedConfig.configRoot,
      }
    : null;
  const launcher = [
    "#!/bin/sh",
    "set -eu",
    `EW_ROOT=${shellQuote(paths.root)}`,
    `EW_PID_FILE=${shellQuote(paths.pidPath)}`,
    `EW_PASSWORD_FILE=${shellQuote(paths.passwordPath)}`,
    `EW_AGENT=${shellQuote(agent.path)}`,
    `EW_PORT=${shellQuote(String(port))}`,
    'umask 077',
    'mkdir -p "$EW_ROOT/tmp"',
    'chmod 700 "$EW_ROOT/tmp"',
    'export TMPDIR="$EW_ROOT/tmp"',
    'export TMP="$TMPDIR"',
    'export TEMP="$TMPDIR"',
    'printf "%s\\n" "$$" > "$EW_PID_FILE.tmp"',
    'mv -f "$EW_PID_FILE.tmp" "$EW_PID_FILE"',
    'export OPENCODE_SERVER_USERNAME=opencode',
    'export OPENCODE_SERVER_PASSWORD="$(cat "$EW_PASSWORD_FILE")"',
    managedConfig
      ? `export OPENCODE_CONFIG=${shellQuote(managedConfig.configPath)}`
      : "",
    managedConfig
      ? `export XDG_DATA_HOME=${shellQuote(managedConfig.dataPath)}`
      : "",
    managedConfig
      ? `export OPENCODE_CONFIG_DIR=${shellQuote(managedConfig.configRoot)}`
      : "",
    'exec "$EW_AGENT" serve --hostname 127.0.0.1 --port "$EW_PORT" --log-level WARN',
  ].filter(Boolean).join("\n");
  const curlConfig = [
    "silent",
    "show-error",
    "connect-timeout = 4",
    "max-time = 30",
    `user = \"opencode:${password}\"`,
    "",
  ].join("\n");
  for (const [targetPath, content, mode] of [
    [paths.passwordPath, `${password}\n`, 0o600],
    [paths.curlConfigPath, curlConfig, 0o600],
    [paths.portPath, `${port}\n`, 0o600],
    [paths.launcherPath, `${launcher}\n`, 0o700],
  ]) {
    await remoteSftpWriteAtomic(session.client, targetPath, content, mode);
  }
  await remoteExec(
    session.client,
    [
      `: > ${shellQuote(paths.logPath)}`,
      `setsid ${shellQuote(paths.launcherPath)} </dev/null >>${shellQuote(paths.logPath)} 2>&1 &`,
    ].join("\n"),
  );
  const descriptor = {
    ...paths,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  };
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await probeOpenCodeService(session, descriptor);
    if (ready) {
      session.openCodeServices.set(paths.serviceKey, ready);
      return ready;
    }
    await waitFor(500);
  }
  const diagnostic = await remoteExec(
    session.client,
    `tail -n 8 ${shellQuote(paths.logPath)}`,
    { allowFailure: true },
  );
  throw new Error(
    `OpenCode 会话服务启动失败${diagnostic.stdout.trim() ? `：${diagnostic.stdout.trim()}` : ""}`,
  );
}

async function ensureOpenCodeService(session, agent) {
  session.openCodeServicePromises ||= new Map();
  const serviceKey = openCodeServicePaths(session, agent).serviceKey;
  const current = session.openCodeServicePromises.get(serviceKey);
  if (current) return current;
  const operation = startOpenCodeService(session, agent);
  session.openCodeServicePromises.set(serviceKey, operation);
  try {
    return await operation;
  } finally {
    if (session.openCodeServicePromises.get(serviceKey) === operation) {
      session.openCodeServicePromises.delete(serviceKey);
    }
  }
}

function openCodePathFromTemplate(template, sessionId) {
  return String(template || "")
    .replace(/\{(?:sessionID|sessionId|id)\}/g, encodeURIComponent(sessionId));
}

async function detectOpenCodeContextCapabilities(session, service) {
  session.agentContextCapabilityCache ||= new Map();
  const cacheKey = service.serviceId || service.root;
  const cached = session.agentContextCapabilityCache.get(cacheKey);
  if (
    cached &&
    Date.now() - Number(cached.checkedAt || 0) < 60_000
  ) {
    return cached;
  }
  let specification = null;
  for (const endpoint of ["/doc", "/openapi.json"]) {
    try {
      const response = await openCodeServiceRequest(session, service, {
        endpoint,
      });
      if (response.json?.paths && typeof response.json.paths === "object") {
        specification = response.json;
        break;
      }
    } catch {
      // A missing OpenAPI document means that native context controls cannot
      // be established reliably; no guessed endpoint is used.
    }
  }
  const paths = Object.keys(specification?.paths || {});
  const compactPath = paths.find((item) => /\/compact\/?$/i.test(item)) || "";
  const summarizePath = paths.find((item) => /\/summarize\/?$/i.test(item)) || "";
  const commandPath = paths.find((item) => /\/command\/?$/i.test(item)) || "";
  const result = {
    checkedAt: Date.now(),
    readable: true,
    compression:
      compactPath || summarizePath || commandPath
        ? {
            supported: true,
            pathTemplate: compactPath || summarizePath || commandPath,
            mode: compactPath
              ? "compact"
              : summarizePath
                ? "summarize"
                : "command",
          }
        : {
            supported: false,
            pathTemplate: "",
            mode: "",
          },
  };
  session.agentContextCapabilityCache.set(cacheKey, result);
  return result;
}

function openCodeUsageFromMessages(value) {
  const messages = Array.isArray(value) ? value : [];
  for (const message of messages.slice().reverse()) {
    const tokens = message?.info?.tokens || message?.tokens || message?.usage;
    if (!tokens || typeof tokens !== "object") continue;
    const input = Number(
      tokens.input || tokens.input_tokens || tokens.prompt_tokens || 0,
    );
    const output = Number(
      tokens.output || tokens.output_tokens || tokens.completion_tokens || 0,
    );
    const reasoning = Number(tokens.reasoning || tokens.reasoning_tokens || 0);
    const total = Number(
      tokens.total || tokens.total_tokens || input + output + reasoning,
    );
    if (input || output || reasoning || total) {
      return { input, output, reasoning, total, observedAt: isoNow() };
    }
  }
  return null;
}

function contextLimitFromModelValue(value) {
  if (!value || typeof value !== "object") return null;
  return positiveInteger(
    value.limit?.context ??
      value.context_window ??
      value.contextWindow ??
      value.context_length ??
      value.contextLength ??
      value.max_context_tokens ??
      value.maxContextTokens ??
      value.max_input_tokens ??
      value.maxInputTokens,
  );
}

function openCodeProviderContextLimit(payload, providerId, modelId) {
  const wantedProvider = String(providerId || "").toLowerCase();
  const wantedModel = String(modelId || "").toLowerCase();
  if (!wantedModel) return null;
  const visited = new Set();
  const walk = (value, key = "", providerHint = "", depth = 0) => {
    if (!value || typeof value !== "object" || depth > 9 || visited.has(value)) {
      return null;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, "", providerHint, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const objectProvider = String(
      value.providerID || value.providerId || value.provider || providerHint || "",
    ).toLowerCase();
    const objectModel = String(
      value.modelID || value.modelId || value.model || value.id || key || "",
    ).toLowerCase();
    const providerMatches = !wantedProvider || !objectProvider || objectProvider === wantedProvider;
    const modelMatches =
      objectModel === wantedModel ||
      objectModel === `${wantedProvider}/${wantedModel}` ||
      String(key || "").toLowerCase() === wantedModel;
    if (providerMatches && modelMatches) {
      const limit = contextLimitFromModelValue(value);
      if (limit) return limit;
    }
    const nextProvider =
      objectProvider ||
      (String(key || "").toLowerCase() === wantedProvider ? wantedProvider : providerHint);
    for (const [childKey, child] of Object.entries(value)) {
      const found = walk(child, childKey, nextProvider, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload);
}

async function inspectOpenCodeProviderContextLimit(
  session,
  service,
  providerId,
  modelId,
) {
  session.agentModelLimitCache ||= new Map();
  const cacheKey = `${service.serviceId || service.root}:${providerId}/${modelId}`;
  const cached = session.agentModelLimitCache.get(cacheKey);
  if (cached && Date.now() - Number(cached.checkedAt || 0) < 60_000) {
    return cached;
  }
  let contextLimit = null;
  try {
    const response = await openCodeServiceRequest(session, service, {
      endpoint: "/provider",
    });
    contextLimit = openCodeProviderContextLimit(
      response.json,
      providerId,
      modelId,
    );
  } catch {
    // The config file remains authoritative when the service does not expose
    // provider metadata.
  }
  const result = {
    checkedAt: Date.now(),
    contextLimit: contextLimit || null,
  };
  session.agentModelLimitCache.set(cacheKey, result);
  return result;
}

async function inspectNativeAgentContext(actor, binding, target = {}) {
  const serverId = String(binding?.serverId || target.serverId || "");
  const agentId = String(binding?.agentId || target.agentId || "");
  const requestedAdapter = String(binding?.adapter || target.agentAdapter || "");
  if (!serverId || !agentId) {
    return {
      bound: Boolean(binding),
      readable: false,
      available: false,
      status: "agent-not-selected",
      usage: null,
      limit: null,
      compression: { supported: false },
    };
  }
  const adapterIsReadable = ["opencode", "codex", "claude"].includes(
    requestedAdapter,
  );
  const worker = await getSshWorker(actor);
  const session = worker.sessions.get(safeSegment(serverId));
  if (!session?.client || session.status !== "connected") {
    return {
      bound: Boolean(binding),
      readable: adapterIsReadable || Boolean(binding?.contextUsage),
      available: Boolean(binding?.contextUsage),
      status: "connection-unavailable",
      usage: binding?.contextUsage || null,
      limit: positiveInteger(binding?.contextLimit),
      compression: { supported: false },
    };
  }
  try {
    const scope = {
      conversationId: String(binding?.conversationId || target.conversationId || ""),
      workspaceId: String(binding?.workspaceId || target.workspaceId || ""),
    };
    const agents = await scanRemoteAgents(session, actor, scope);
    const agent = agents.find(
      (item) => item.id === agentId && item.status === "ready",
    );
    if (!agent) throw new Error("绑定的 Agent 当前不可用");
    if (agent.adapter !== "opencode") {
      const profile =
        (await getAgentRuntimeProfile(actor, session, agent.id, scope)) || {};
      const usage = binding?.contextUsage || null;
      const contextLimit =
        positiveInteger(profile.contextLimit) ||
        positiveInteger(binding?.contextLimit) ||
        null;
      return {
        bound: Boolean(binding),
        readable: true,
        available: Boolean(usage),
        status: usage
          ? "measured"
          : binding?.agentSessionId
            ? "usage-empty"
            : "ready-no-session",
        usage,
        limit: contextLimit,
        limitSource: positiveInteger(profile.contextLimit) ? "config" : "",
        model: profile.model || binding?.model || agent.model || "",
        modifiable: Boolean(agent.managed),
        compression: {
          supported: Boolean(binding?.agentSessionId),
          mode: "native-command",
        },
        control: { session, agent, profile, scope },
      };
    }
    const runtimeConfiguration = agent.managed
      ? await ensureManagedAgentRuntimeConfig(session, actor, agent, scope)
      : null;
    const runtimePaths = agent.managed
      ? managedAgentRuntimePaths(
          session.home,
          agent.id,
          binding?.runtimeId || runtimeConfiguration?.runtimeId || agent.runtimeId,
        )
      : null;
    const contextAgent = runtimePaths
      ? {
          ...agent,
          runtimeId: binding.runtimeId,
          serviceKey: `${agent.id}:${binding.runtimeId}`,
          configPath: runtimePaths.opencodeConfigPath,
          authPath: runtimePaths.opencodeAuthPath,
          dataPath: runtimePaths.opencodeDataHome,
          configRoot: runtimePaths.configRoot,
        }
      : agent;
    const configuration = await inspectOpenCodeNativeConfiguration(
      session,
      contextAgent,
    );
    const configuredModel = openCodeConfiguredModelDetails(
      parseJsoncObject(configuration.configContent),
      binding?.model ||
        (configuration.providerId && configuration.model
          ? `${configuration.providerId}/${configuration.model}`
          : configuration.model || agent.model || ""),
    );
    let service = null;
    let capabilities = {
      readable: true,
      compression: { supported: false, pathTemplate: "", mode: "" },
    };
    let serviceDiagnostic = "";
    try {
      service = await ensureOpenCodeService(session, contextAgent);
      capabilities = await detectOpenCodeContextCapabilities(session, service);
    } catch (caught) {
      serviceDiagnostic =
        caught instanceof Error
          ? caught.message
          : "OpenCode 原生会话服务暂时不可用";
    }
    const providerLimit =
      configuredModel.contextLimit || !service
        ? { contextLimit: configuredModel.contextLimit || null }
        : await inspectOpenCodeProviderContextLimit(
            session,
            service,
            configuredModel.providerId,
            configuredModel.modelId,
          );
    const contextLimit =
      positiveInteger(configuredModel.contextLimit) ||
      positiveInteger(providerLimit.contextLimit) ||
      positiveInteger(binding?.contextLimit) ||
      null;
    let usage = null;
    let sessionDiagnostic = serviceDiagnostic;
    if (binding?.agentSessionId && service) {
      try {
        await openCodeServiceRequest(session, service, {
          endpoint: `/session/${encodeURIComponent(binding.agentSessionId)}`,
          directory: binding.workspace,
        });
        const response = await openCodeServiceRequest(session, service, {
          endpoint: `/session/${encodeURIComponent(binding.agentSessionId)}/message`,
          directory: binding.workspace,
        });
        usage = openCodeUsageFromMessages(response.json) || binding.contextUsage || null;
      } catch (caught) {
        usage = binding.contextUsage || null;
        sessionDiagnostic =
          caught instanceof Error ? caught.message : "原生 Agent 会话暂时不可读";
      }
    }
    return {
      bound: Boolean(binding?.agentSessionId),
      readable: Boolean(capabilities.readable),
      available: Boolean(usage),
      status: usage
        ? "measured"
        : serviceDiagnostic
          ? "service-unavailable"
        : binding?.agentSessionId
          ? "usage-empty"
          : "ready-no-session",
      usage,
      limit: contextLimit,
      limitSource: configuredModel.contextLimit
        ? "config"
        : providerLimit.contextLimit
          ? "provider"
          : "",
      model: configuredModel.model || binding?.model || agent.model || "",
      modifiable: Boolean(
        configuration.configPath &&
          configuredModel.providerId &&
          configuredModel.modelId,
      ),
      diagnostic: sessionDiagnostic,
      compression: capabilities.compression,
      control: {
        session,
        service,
        agent: contextAgent,
        configuration,
        configuredModel,
      },
    };
  } catch (caught) {
    const knownAgent =
      adapterIsReadable ||
      agentId.startsWith("opencode") ||
      agentId.startsWith("codex") ||
      agentId.startsWith("claude");
    return {
      bound: Boolean(binding),
      readable: knownAgent,
      available: Boolean(binding?.contextUsage),
      status: knownAgent ? "service-unavailable" : "unreadable",
      diagnostic:
        caught instanceof Error ? caught.message : "无法读取 Agent 上下文",
      usage: binding?.contextUsage || null,
      limit: positiveInteger(binding?.contextLimit),
      compression: { supported: false },
    };
  }
}

async function compactNativeAgentContext(actor, binding) {
  const inspected = await inspectNativeAgentContext(actor, binding);
  if (!inspected.bound) {
    const error = new Error("当前对话尚未绑定 Agent 会话");
    error.statusCode = 409;
    throw error;
  }
  if (!inspected.compression?.supported || !inspected.control) {
    const error = new Error("当前 Agent 未提供可验证的原生压缩接口");
    error.statusCode = 409;
    throw error;
  }
  if (inspected.control.agent.adapter === "opencode") {
    const endpoint = openCodePathFromTemplate(
      inspected.compression.pathTemplate,
      binding.agentSessionId,
    );
    const model = String(binding.model || "");
    const body =
      inspected.compression.mode === "summarize"
        ? {
            providerID: model.includes("/")
              ? model.split("/")[0]
              : EASYWORK_OPENCODE_PROVIDER_ID,
            modelID: model.includes("/")
              ? model.split("/").slice(1).join("/")
              : model,
          }
        : inspected.compression.mode === "command"
          ? { command: "compact", arguments: "" }
          : {};
    if (inspected.compression.mode === "summarize" && !body.modelID) {
      const error = new Error("Agent 未暴露当前模型，无法调用其原生压缩接口");
      error.statusCode = 409;
      throw error;
    }
    await openCodeServiceRequest(
      inspected.control.session,
      inspected.control.service,
      {
        method: "POST",
        endpoint,
        directory: binding.workspace,
        body,
      },
    );
  } else {
    const { session, agent, scope } = inspected.control;
    const runtime = await ensureManagedAgentRuntimeConfig(
      session,
      actor,
      agent,
      scope,
    );
    if (!runtime.configured && agent.managed) {
      throw new Error(`${agent.name} 隔离配置不可用，无法压缩原生会话`);
    }
    const compactPrompt = shellQuote("/compact");
    const command =
      agent.adapter === "codex"
        ? [
            runtime.managed
              ? `export CODEX_HOME=${shellQuote(runtime.paths.codexHome)}`
              : "",
            runtime.managed
              ? `export CODEX_API_KEY="$(cat ${shellQuote(runtime.paths.apiKeyPath)})"`
              : "",
            `cd ${shellQuote(binding.workspace || session.home)}`,
            `${shellQuote(agent.path)} exec --json --skip-git-repo-check resume ${shellQuote(binding.agentSessionId)} ${compactPrompt} >/dev/null`,
          ]
        : [
            runtime.managed
              ? `export CLAUDE_CONFIG_DIR=${shellQuote(runtime.paths.claudeConfigDir)}`
              : "",
            runtime.managed
              ? `export ANTHROPIC_AUTH_TOKEN="$(cat ${shellQuote(runtime.paths.apiKeyPath)})"`
              : "",
            runtime.managed
              ? 'export ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN"'
              : "",
            `cd ${shellQuote(binding.workspace || session.home)}`,
            `${shellQuote(agent.path)} -p ${compactPrompt} --resume ${shellQuote(binding.agentSessionId)} --output-format json >/dev/null`,
          ];
    await remoteExec(session.client, command.filter(Boolean).join("\n"));
  }
  await updateAgentBinding(actor, binding.bindingKey, (current) => ({
    ...(current || binding),
    contextUsage: undefined,
    nativeCompactedAt: isoNow(),
    updatedAt: isoNow(),
  }));
  const worker = await getSshWorker(actor);
  const boundSession = worker.sessions.get(safeSegment(binding.serverId || ""));
  if (boundSession?.agentSessions?.has(binding.bindingKey)) {
    boundSession.agentSessions.set(binding.bindingKey, {
      ...boundSession.agentSessions.get(binding.bindingKey),
      contextUsage: undefined,
      nativeCompactedAt: isoNow(),
      updatedAt: isoNow(),
    });
    scheduleSshWorkerPersist(worker, 0);
  }
  return { accepted: true, mode: inspected.compression.mode };
}

async function updateNativeAgentContextLimit(
  actor,
  {
    serverId,
    agentId,
    agentAdapter = "",
    conversationId = "",
    workspaceId = "",
    contextLimit,
  },
) {
  const limit = positiveInteger(contextLimit);
  if (!limit || limit < 8_000 || limit > 4_000_000) {
    const error = new Error("Agent 上下文上限应在 8k 到 4M 之间");
    error.statusCode = 400;
    throw error;
  }
  const inspected = await inspectNativeAgentContext(actor, null, {
    serverId,
    agentId,
    agentAdapter,
    conversationId,
    workspaceId,
  });
  if (!inspected.readable || !inspected.modifiable || !inspected.control) {
    const error = new Error("当前 Agent 原生模型配置不支持修改上下文上限");
    error.statusCode = 409;
    throw error;
  }
  const { session, agent, configuration, configuredModel } = inspected.control;
  if (agent.adapter !== "opencode") {
    const scope = { conversationId, workspaceId };
    await updateAgentRuntimeProfile(actor, session, agent.id, scope, {
      contextLimit: limit,
    });
    await ensureManagedAgentRuntimeConfig(session, actor, agent, scope);
    return {
      contextLimit: limit,
      model: inspected.model || "",
      configPath:
        agent.adapter === "codex"
          ? managedAgentRuntimePaths(
              session.home,
              agent.id,
              agentRuntimeId(session, agent.id, scope),
            ).codexConfigPath
          : managedAgentRuntimePaths(
              session.home,
              agent.id,
              agentRuntimeId(session, agent.id, scope),
            ).claudeSettingsPath,
    };
  }
  const nextContent = setJsoncValue(
    configuration.configContent,
    [
      "provider",
      configuredModel.providerId,
      "models",
      configuredModel.modelId,
      "limit",
      "context",
    ],
    limit,
  );
  parseJsoncObject(nextContent);
  await remoteSftpWriteAtomic(
    session.client,
    configuration.configPath,
    `${nextContent.trimEnd()}\n`,
    0o600,
  );
  if (configuredModel.providerId === EASYWORK_OPENCODE_PROVIDER_ID) {
    await updateAgentRuntimeProfile(
      actor,
      session,
      agent.id,
      { conversationId, workspaceId },
      { contextLimit: limit },
    );
  }
  await stopOpenCodeService(session, agent);
  session.agentContextCapabilityCache?.clear();
  session.agentModelLimitCache?.clear();
  return {
    contextLimit: limit,
    model: configuredModel.model,
    configPath: configuration.configPath,
  };
}

async function openCodeServiceRequest(
  session,
  service,
  { method = "GET", endpoint, directory = "", body },
) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const requestId = crypto.randomBytes(10).toString("hex");
  const requestPath = `${service.requestsPath}/${requestId}.json`;
  const query = directory
    ? `${endpoint.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`
    : "";
  const url = `${service.baseUrl}${endpoint}${query}`;
  if (body !== undefined) {
    await remoteSftpWriteAtomic(
      session.client,
      requestPath,
      `${JSON.stringify(body)}\n`,
      0o600,
    );
  }
  try {
    const args = [
      "curl",
      `--config ${shellQuote(service.curlConfigPath)}`,
      `--request ${shellQuote(method)}`,
      "--header 'Content-Type: application/json'",
      body !== undefined ? `--data-binary @${shellQuote(requestPath)}` : "",
      "--write-out '\\n__EASYWORK_HTTP__:%{http_code}'",
      shellQuote(url),
    ]
      .filter(Boolean)
      .join(" ");
    const response = await remoteExec(session.client, args, {
      allowFailure: true,
    });
    const marker = "\n__EASYWORK_HTTP__:";
    const markerIndex = response.stdout.lastIndexOf(marker);
    const responseBody =
      markerIndex >= 0
        ? response.stdout.slice(0, markerIndex)
        : response.stdout;
    const status = Number(
      markerIndex >= 0
        ? response.stdout.slice(markerIndex + marker.length).trim()
        : 0,
    );
    const ok = status >= 200 && status < 300 && response.code === 0;
    if (!ok) {
      const detail = responseBody.trim() || response.stderr.trim();
      const error = new Error(
        detail || `OpenCode 会话接口返回 HTTP ${status || "错误"}`,
      );
      error.statusCode = status || 502;
      throw error;
    }
    return {
      status,
      text: responseBody,
      json: responseBody.trim() ? JSON.parse(responseBody) : null,
    };
  } finally {
    if (body !== undefined) {
      await remoteExec(session.client, `rm -f ${shellQuote(requestPath)}`, {
        allowFailure: true,
      }).catch(() => undefined);
    }
  }
}

async function ensureOpenCodeSession(
  session,
  service,
  { sessionId = "", directory, title = "EasyWork" },
) {
  if (sessionId) {
    try {
      await openCodeServiceRequest(session, service, {
        endpoint: `/session/${encodeURIComponent(sessionId)}`,
        directory,
      });
      return { sessionId, created: false };
    } catch (caught) {
      if (Number(caught?.statusCode) !== 404) throw caught;
    }
  }
  const created = await openCodeServiceRequest(session, service, {
    method: "POST",
    endpoint: "/session",
    directory,
    body: { title: String(title || "EasyWork").slice(0, 120) },
  });
  const createdId = String(created.json?.id || "");
  if (!createdId.startsWith("ses")) {
    throw new Error("OpenCode 未返回有效的原生会话标识");
  }
  return { sessionId: createdId, created: true };
}

async function appendOpenCodeInstruction(session, control, content) {
  await openCodeServiceRequest(session, control.service, {
    method: "POST",
    endpoint: `/session/${encodeURIComponent(control.sessionId)}/prompt_async`,
    directory: control.directory,
    body: {
      parts: [{ type: "text", text: String(content || "") }],
    },
  });
}

async function abortOpenCodeSession(session, control) {
  if (!control?.sessionId || !control?.service) return false;
  try {
    await openCodeServiceRequest(session, control.service, {
      method: "POST",
      endpoint: `/session/${encodeURIComponent(control.sessionId)}/abort`,
      directory: control.directory,
    });
    return true;
  } catch {
    return false;
  }
}

function openCodeSseAgentEvent(value, { sessionId, directory } = {}) {
  let envelope;
  try {
    envelope = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  const event = envelope?.payload || envelope;
  if (!event || !event.type) return null;
  const properties = event.properties || {};
  const eventSessionId = String(
    properties.sessionID ||
      properties.part?.sessionID ||
      properties.info?.sessionID ||
      event.sessionID ||
      "",
  );
  if (eventSessionId !== String(sessionId || "")) {
    return null;
  }
  if (
    envelope.directory &&
    directory &&
    String(envelope.directory) !== String(directory)
  ) {
    return null;
  }
  if (event.type === "message.part.updated") {
    const part = properties.part;
    if (!part) return null;
    return {
      sessionID: eventSessionId,
      part,
    };
  }
  if (
    [
      "message.updated",
      "todo.updated",
      "plan.updated",
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.replied",
      "question.rejected",
      "session.status",
      "session.error",
      "session.diff",
    ].includes(event.type)
  ) {
    return {
      type: event.type,
      sessionID: eventSessionId,
      ...properties,
    };
  }
  return null;
}

async function replyOpenCodePermission(session, control, requestId, approved) {
  if (!control?.service || !control?.sessionId) {
    throw new Error("OpenCode 原生会话当前不可控制");
  }
  const normalizedId = String(requestId || "").trim();
  if (!normalizedId || normalizedId.length > 240) {
    throw new Error("权限请求标识无效");
  }
  await openCodeServiceRequest(session, control.service, {
    method: "POST",
    endpoint: `/permission/${encodeURIComponent(normalizedId)}/reply`,
    directory: control.directory,
    body: { reply: approved ? "once" : "reject" },
  });
}

async function replyOpenCodeQuestion(
  session,
  control,
  requestId,
  answers = [],
  rejected = false,
) {
  if (!control?.service || !control?.sessionId) {
    throw new Error("OpenCode 原生会话当前不可控制");
  }
  const normalizedId = String(requestId || "").trim();
  if (!normalizedId || normalizedId.length > 240) {
    throw new Error("问题请求标识无效");
  }
  const normalizedAnswers = (Array.isArray(answers) ? answers : [answers])
    .map((answer) =>
      Array.isArray(answer)
        ? answer.map((item) => String(item || "").trim()).filter(Boolean)
        : [String(answer || "").trim()].filter(Boolean),
    );
  if (!rejected && !normalizedAnswers.some((answer) => answer.length)) {
    throw new Error("请输入对 Agent 问题的回答");
  }
  await openCodeServiceRequest(session, control.service, {
    method: "POST",
    endpoint: `/question/${encodeURIComponent(normalizedId)}/${
      rejected ? "reject" : "reply"
    }`,
    directory: control.directory,
    ...(rejected ? {} : { body: { answers: normalizedAnswers } }),
  });
}

async function waitForOpenCodeRunAdmission(session, control, remoteRun) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const status = await openCodeServiceRequest(session, control.service, {
        endpoint: "/session/status",
        directory: control.directory,
      });
      if (status.json?.[control.sessionId]) return;
      const snapshot = await readRemoteRuntimeRun(session, remoteRun);
      if (
        snapshot.stdout.length > 0 ||
        ["done", "error", "aborted", "lost"].includes(snapshot.status)
      ) {
        return;
      }
    } catch {
      // The attached CLI may still be negotiating with the local service.
    }
    await waitFor(100);
  }
}

function getRemoteRuntimeBundle() {
  remoteRuntimeBundlePromise ||= loadRemoteRuntimeBundle();
  return remoteRuntimeBundlePromise;
}

async function ensureRemoteRuntime(session) {
  if (!session.client || !session.home) throw new Error("SSH 尚未连接");
  const bundle = await getRemoteRuntimeBundle();
  const paths = remoteRuntimePaths(session.home, bundle.releaseId);
  if (session.runtime?.releaseId === bundle.releaseId) return session.runtime;

  const currentManifest = await remoteSftpReadOptional(
    session.client,
    `${paths.current}/manifest.json`,
  );
  if (currentManifest) {
    try {
      const parsed = JSON.parse(currentManifest.toString("utf8"));
      if (parsed.digest === bundle.digest) {
        const check = await remoteExec(
          session.client,
          `${shellQuote(paths.entrypoint)} self-test`,
          { allowFailure: true },
        );
        const fields = parseRuntimeFields(check.stdout);
        if (check.code === 0 && fields.status === "ready") {
          session.runtime = {
            ...paths,
            digest: bundle.digest,
            protocolVersion: Number(fields.protocol || 1),
            releaseId: bundle.releaseId,
          };
          return session.runtime;
        }
      }
    } catch {
      // An invalid deployment is replaced atomically below.
    }
  }

  const staging = `${paths.runtimeRoot}/.staging-${bundle.releaseId}-${crypto
    .randomBytes(5)
    .toString("hex")}`;
  await remoteExec(
    session.client,
    [
      `umask 077`,
      `mkdir -p ${shellQuote(paths.root)} ${shellQuote(paths.runsRoot)} ${shellQuote(paths.releasesRoot)} ${shellQuote(`${staging}/bin`)}`,
      `chmod 700 ${shellQuote(paths.root)} ${shellQuote(paths.runsRoot)} ${shellQuote(paths.runtimeRoot)} ${shellQuote(paths.releasesRoot)} ${shellQuote(staging)} ${shellQuote(`${staging}/bin`)}`,
    ].join(" && "),
  );
  try {
    for (const file of bundle.files) {
      await remoteSftpWrite(
        session.client,
        `${staging}/${file.relativePath}`,
        file.content,
        file.mode,
      );
    }
    const stagedEntrypoint = `${staging}/bin/easywork-runner`;
    const selfTest = await remoteExec(
      session.client,
      `${shellQuote(stagedEntrypoint)} self-test`,
      { allowFailure: true },
    );
    const selfTestFields = parseRuntimeFields(selfTest.stdout);
    if (selfTest.code !== 0 || selfTestFields.status !== "ready") {
      throw new Error(
        selfTest.stderr.trim() ||
          `远端 Runtime 自检失败${selfTestFields.missing ? `：缺少 ${selfTestFields.missing}` : ""}`,
      );
    }
    await remoteExec(
      session.client,
      [
        `if [ -d ${shellQuote(paths.releaseRoot)} ]; then rm -rf ${shellQuote(staging)}; else mv ${shellQuote(staging)} ${shellQuote(paths.releaseRoot)}; fi`,
        `rm -f ${shellQuote(`${paths.runtimeRoot}/current.next`)}`,
        `ln -s ${shellQuote(`releases/${bundle.releaseId}`)} ${shellQuote(`${paths.runtimeRoot}/current.next`)}`,
        `mv -Tf ${shellQuote(`${paths.runtimeRoot}/current.next`)} ${shellQuote(paths.current)}`,
      ].join(" && "),
    );
  } catch (caught) {
    await remoteExec(session.client, `rm -rf ${shellQuote(staging)}`, {
      allowFailure: true,
    }).catch(() => undefined);
    throw caught;
  }

  session.runtime = {
    ...paths,
    digest: bundle.digest,
    protocolVersion: Number(bundle.manifest.protocolVersion || 1),
    releaseId: bundle.releaseId,
  };
  return session.runtime;
}

async function createRemoteRuntimeRun(session, options) {
  const runtime = await ensureRemoteRuntime(session);
  const runId = safeRemoteRunId(options.runId);
  const runDirectory = `${runtime.runsRoot}/${runId}`;
  await remoteExec(
    session.client,
    `umask 077 && mkdir -p ${shellQuote(runDirectory)} && chmod 700 ${shellQuote(runDirectory)}`,
  );
  const metadata = {
    schemaVersion: 1,
    runId,
    conversationId: String(options.conversationId || ""),
    serverId: String(session.serverId || ""),
    agentId: String(options.agentId || ""),
    workspaceId: String(options.workspaceId || ""),
    workspaceName: String(options.workspaceName || ""),
    workspaceKind: options.workspaceKind === "virtual" ? "virtual" : "physical",
    versionDomainId: String(options.versionDomainId || ""),
    workspace: String(options.workspace || ""),
    createdAt: isoNow(),
  };
  await remoteSftpWriteAtomic(
    session.client,
    `${runDirectory}/request.json`,
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  await remoteSftpWriteAtomic(
    session.client,
    `${runDirectory}/prompt.txt`,
    String(options.prompt || ""),
  );
  await remoteSftpWriteAtomic(
    session.client,
    `${runDirectory}/command.sh`,
    String(
      typeof options.command === "function"
        ? options.command({ runDirectory, runtime })
        : options.command || "",
    ),
    0o700,
  );
  const started = await remoteExec(
    session.client,
    `${shellQuote(runtime.entrypoint)} run-start ${shellQuote(runId)}`,
  );
  return {
    ...parseRuntimeFields(started.stdout),
    runId,
    runDirectory,
    runtime,
  };
}

async function readRemoteRuntimeRun(session, remoteRun) {
  const files = await withRemoteSftp(session.client, async (sftp) => {
    const readText = (name) =>
      new Promise((resolve, reject) => {
        sftp.readFile(
          `${remoteRun.runDirectory}/${name}`,
          (error, content) => {
            if (
              error?.code === 2 ||
              error?.code === "ENOENT" ||
              /no such file/i.test(String(error?.message || ""))
            ) {
              resolve(Buffer.alloc(0));
              return;
            }
            if (error) {
              reject(error);
              return;
            }
            resolve(content || Buffer.alloc(0));
          },
        );
      });
    const result = {};
    for (const name of [
      "status",
      "pid",
      "exit_code",
      "stdout.log",
      "stderr.log",
      "agent-events.sse",
    ]) {
      result[name] = await readText(name);
    }
    return result;
  });
  const status = files.status;
  const pid = files.pid;
  const exitCode = files.exit_code;
  const stdout = files["stdout.log"];
  const stderr = files["stderr.log"];
  const agentEvents = files["agent-events.sse"];
  return {
    status: status.toString("utf8").trim() || "starting",
    pid: pid.toString("utf8").trim(),
    exitCode: exitCode.toString("utf8").trim(),
    stdout,
    stderr,
    agentEvents,
  };
}

async function monitorRemoteRuntimeRun(session, remoteRun, handlers = {}) {
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let agentEventsOffset = 0;
  let snapshot;
  for (;;) {
    if (!session.client) {
      handlers.onUnavailable?.();
      await waitFor(500);
      continue;
    }
    try {
      snapshot = await readRemoteRuntimeRun(session, remoteRun);
    } catch (caught) {
      if (
        !session.client ||
        /ECONNRESET|not connected|connection.*closed|No response from server/i.test(
          String(caught?.message || ""),
        )
      ) {
        handlers.onUnavailable?.();
        await waitFor(500);
        continue;
      }
      throw caught;
    }
    if (snapshot.stdout.length > stdoutOffset) {
      handlers.onStdout?.(snapshot.stdout.subarray(stdoutOffset).toString("utf8"));
      stdoutOffset = snapshot.stdout.length;
    }
    if (snapshot.stderr.length > stderrOffset) {
      handlers.onStderr?.(snapshot.stderr.subarray(stderrOffset).toString("utf8"));
      stderrOffset = snapshot.stderr.length;
    }
    if (snapshot.agentEvents.length > agentEventsOffset) {
      handlers.onAgentEvents?.(
        snapshot.agentEvents.subarray(agentEventsOffset).toString("utf8"),
      );
      agentEventsOffset = snapshot.agentEvents.length;
    }
    handlers.onStatus?.(snapshot);
    if (["done", "error", "aborted", "lost"].includes(snapshot.status)) break;
    await waitFor(240);
  }
  return {
    code: Number(snapshot.exitCode || (snapshot.status === "done" ? 0 : 1)),
    status: snapshot.status,
    stdout: snapshot.stdout.toString("utf8"),
    stderr: snapshot.stderr.toString("utf8"),
  };
}

async function sendRemoteRuntimeInput(session, remoteRun, payload) {
  if (!session.client || !remoteRun?.runtime?.entrypoint) {
    throw new Error("远端 Agent 当前不接受追加输入");
  }
  const line =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  await remoteExec(
    session.client,
    `${shellQuote(remoteRun.runtime.entrypoint)} run-input ${shellQuote(remoteRun.runId)}`,
    {
      input: `${line.replace(/[\r\n]+$/g, "")}\n`,
      timeoutMs: 10_000,
    },
  );
}

async function cancelRemoteRuntimeRun(session, activeRun) {
  if (!session.client || !activeRun?.remoteRun?.runtime) return false;
  activeRun.abortRequested = true;
  if (activeRun.agentControl?.adapter === "opencode") {
    await abortOpenCodeSession(session, activeRun.agentControl);
  } else if (
    activeRun.agentControl?.adapter === "codex" &&
    activeRun.agentControl.sessionId &&
    activeRun.agentControl.turnId
  ) {
    await sendRemoteRuntimeInput(session, activeRun.remoteRun, {
      id: `easywork-interrupt-${safeSegment(activeRun.runId || randomId("run"))}`,
      method: "turn/interrupt",
      params: {
        threadId: activeRun.agentControl.sessionId,
        turnId: activeRun.agentControl.turnId,
      },
    }).catch(() => undefined);
    // Give Codex app-server a brief chance to record an interrupted turn in
    // its native thread before the remote process-group fallback is applied.
    await waitFor(240);
  }
  await remoteExec(
    session.client,
    `${shellQuote(activeRun.remoteRun.runtime.entrypoint)} run-cancel ${shellQuote(activeRun.remoteRun.runId)}`,
    { allowFailure: true },
  );
  return true;
}

function reconstructNativeAgentTranscript(stdout, runId, adapter = "opencode") {
  const parserState = {
    sessionId: "",
    finalText: "",
    latestText: "",
    textParts: new Map(),
    textOrder: [],
    reasoningText: "",
    reasoningParts: new Map(),
    reasoningOrder: [],
    lastError: "",
    eventIndex: 0,
    eventOrder: [],
    forwardedEvents: new Map(),
    activeThought: null,
    activeFinal: null,
    contextUsage: null,
  };
  const events = [];
  let steps = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    for (const parsed of parseNativeAgentLine(adapter, line, parserState)) {
      if (!parsed) continue;
      const { sourceId, planSteps, ...event } = parsed;
      if (Array.isArray(planSteps)) steps = planSteps;
      const id = sourceId
        ? `${runId}_${safeSegment(event.kind)}_${safeSegment(sourceId)}`
        : `${runId}_recovered_${events.length}`;
      events.push({ id, ...event, timestamp: isoNow() });
      parserState.eventOrder.push({ id, kind: event.kind });
      parserState.forwardedEvents.set(id, event);
    }
  }
  const finalCandidates = events.filter(
    (event) => event.kind === "message" && event.output,
  );
  const finalText = stripEasyWorkProtocolMarkers(
    String(
      finalCandidates.at(-1)?.output ||
        parserState.finalText ||
        parserState.latestText ||
        "",
    ).trim(),
    true,
  );
  return {
    events,
    steps,
    finalText,
    sessionId: parserState.sessionId,
    error: parserState.lastError,
    contextUsage: parserState.contextUsage,
  };
}

async function finishRecoveredWorkerTask(session, actor, task, result) {
  const reconstructed = reconstructNativeAgentTranscript(
    result.stdout,
    task.runId,
    task.agentControl?.adapter || "opencode",
  );
  const recoveredWasAborted = Boolean(
    task.abortRequested || result.status === "aborted",
  );
  let recoveredBinding = null;
  let recoveredBindingKey = "";
  for (const event of reconstructed.events) {
    publishWorkerEvent(session, {
      type: "agent.event",
      conversationId: task.conversationId,
      runId: task.runId,
      event,
    });
  }
  if (reconstructed.steps.length) {
    publishWorkerEvent(session, {
      type: "workflow",
      conversationId: task.conversationId,
      runId: task.runId,
      steps: reconstructed.steps,
    });
  }
  if (reconstructed.sessionId) {
    const workspace = remotePathForSession(session, task.workspace || "~");
    const bindingKey = agentBindingKey({
      serverId: session.serverId,
      workspaceId: task.workspaceId,
      agentId: task.agentId,
      conversationId: task.conversationId,
    });
    const [state, memoryDocument, bindings] = await Promise.all([
      getState(actor),
      readMemoryDocument(actor),
      readAgentBindings(actor),
    ]);
    const previousBinding = bindings.bindings[bindingKey] || null;
    const binding = {
      bindingKey,
      conversationId: task.conversationId,
      serverId: session.serverId,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
      workspace,
      agentId: task.agentId,
      adapter: task.agentControl?.adapter || "opencode",
      agentSessionId: reconstructed.sessionId,
      lastRunId: task.runId,
      syncMode: "recovered",
      // A native session has already accepted this turn even when execution was
      // interrupted later. Advancing the delivery cursor prevents the same web
      // turn and memory delta from being injected twice when the user resumes.
      syncCursor: createAgentSyncCursor({
        state,
        memoryDocument,
        conversationId: task.conversationId,
        lastMessageId: task.assistantMessageId,
        taskId: task.runId,
        checkpointId: task.checkpointAfterId,
        deliveredContent: [`user\u0000${task.prompt}`],
        deliveredMemoryRecords: task.deliveredMemoryRecords || [],
        memoryEnabled: state?.settings?.memoryEnabled !== false,
        previous: previousBinding?.syncCursor,
      }),
      deliveryState: {
        runId: task.runId,
        status:
          result.status === "done" && !recoveredWasAborted
            ? "acknowledged"
            : "interrupted",
      },
      contextUsage: reconstructed.contextUsage || undefined,
      updatedAt: isoNow(),
    };
    recoveredBinding = binding;
    recoveredBindingKey = bindingKey;
  }

  if (!task.checkpointAfterId) {
    const checkpoint = await createWorkspaceCheckpoint(
      session,
      actor,
      task,
      "after",
    ).catch(() => null);
    task.checkpointAfterId = checkpoint?.id || "";
  }

  if (recoveredBinding && recoveredBindingKey) {
    recoveredBinding.syncCursor.workspaceRevision = task.checkpointAfterId || "";
    recoveredBinding.updatedAt = isoNow();
    session.agentSessions.set(recoveredBindingKey, recoveredBinding);
    await updateAgentBinding(
      actor,
      recoveredBindingKey,
      () => recoveredBinding,
    );
  }

  if (result.status === "done" && !recoveredWasAborted) {
    const finalText =
      reconstructed.finalText || "Agent 已完成任务，未返回额外文本。";
    publishWorkerEvent(session, {
      type: "agent.event",
      conversationId: task.conversationId,
      runId: task.runId,
      event: {
        id: `${task.runId}_recovered_final`,
        kind: "message",
        title: "Agent 最终回复",
        output: finalText,
        status: "done",
        timestamp: isoNow(),
      },
    });
    publishWorkerEvent(session, {
      type: "task.complete",
      conversationId: task.conversationId,
      runId: task.runId,
      result: finalText,
    });
  } else if (recoveredWasAborted) {
    publishWorkerEvent(session, {
      type: "task.aborted",
      conversationId: task.conversationId,
      runId: task.runId,
      result: "任务已停止。",
    });
  } else {
    publishWorkerEvent(session, {
      type: "task.error",
      conversationId: task.conversationId,
      runId: task.runId,
      result:
        reconstructed.error ||
        result.stderr.trim() ||
        "远端任务在主机恢复期间失败",
    });
  }
  task.recoveryStatus = "complete";
  session.activeRuns.delete(task.runId);
  session.activeRun = session.activeRuns.values().next().value || null;
  await persistWorkerTaskConversation(actor, task);
  await persistSshWorker(session.worker);
}

async function reconcileRecoveredWorkerTasks(session, actor) {
  const pending = [...session.worker.tasks.values()].filter(
    (task) =>
      task.serverId === session.serverId &&
      task.status === "running" &&
      task.remoteRun?.runId &&
      task.recoveryStatus !== "watching",
  );
  if (!pending.length || !session.client) return;
  const runtime = await ensureRemoteRuntime(session);
  for (const task of pending) {
    const remoteRun = {
      runId: task.remoteRun.runId,
      runDirectory: `${runtime.runsRoot}/${task.remoteRun.runId}`,
      runtime,
    };
    const serviceRoot = String(
      task.agentControl?.serviceRoot || task.remoteRun?.serviceRoot || "",
    );
    const servicePort = Number(
      task.agentControl?.servicePort || task.remoteRun?.servicePort || 0,
    );
    const agentSessionId = String(
      task.agentControl?.sessionId ||
        task.remoteRun?.agentSessionId ||
        task.agentSessionId ||
        "",
    );
    const restoredService =
      serviceRoot && servicePort
        ? {
            serviceId: String(
              task.agentControl?.serviceId || task.remoteRun?.serviceId || "",
            ),
            root: serviceRoot,
            port: servicePort,
            baseUrl: `http://127.0.0.1:${servicePort}`,
            portPath: `${serviceRoot}/port`,
            passwordPath: `${serviceRoot}/password`,
            curlConfigPath: `${serviceRoot}/curl.conf`,
            launcherPath: `${serviceRoot}/launch.sh`,
            pidPath: `${serviceRoot}/pid`,
            logPath: `${serviceRoot}/server.log`,
            requestsPath: `${serviceRoot}/requests`,
          }
        : null;
    const activeRun = {
      serverId: task.serverId || session.serverId,
      serverIdentity: task.serverIdentity || session.serverIdentity,
      conversationId: task.conversationId,
      runId: task.runId,
      workspace: task.workspace,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceName,
      versionRoot: task.versionRoot,
      versionDomainId: task.versionDomainId,
      remoteRun,
      recovered: true,
      supportsLiveInput: Boolean(restoredService && agentSessionId),
      agentControl:
        restoredService && agentSessionId
          ? {
              adapter: "opencode",
              service: restoredService,
              sessionId: agentSessionId,
              directory: String(
                task.agentControl?.directory ||
                  task.remoteRun?.directory ||
                  remotePathForSession(session, task.workspace || "~"),
              ),
            }
          : null,
    };
    task.recoveryStatus = "watching";
    session.activeRuns.set(task.runId, activeRun);
    session.activeRun ||= activeRun;
    if (task.abortRequested) {
      void cancelRemoteRuntimeRun(session, activeRun).catch(() => undefined);
    } else if (activeRun.agentControl) {
      void flushAppendedInstructions(session, task, activeRun).catch(
        () => undefined,
      );
    }
    void monitorRemoteRuntimeRun(session, remoteRun, {
      onStatus: (snapshot) => {
        task.remoteRun.status = snapshot.status;
        task.remoteRun.pid = snapshot.pid || undefined;
        task.updatedAt = isoNow();
        scheduleSshWorkerPersist(session.worker);
      },
    })
      .then((result) => finishRecoveredWorkerTask(session, actor, task, result))
      .catch(async (caught) => {
        task.recoveryStatus = "pending";
        session.activeRuns.delete(task.runId);
        session.activeRun = session.activeRuns.values().next().value || null;
        task.updatedAt = isoNow();
        task.recoveryError =
          caught instanceof Error ? caught.message : "远端任务恢复失败";
        await persistSshWorker(session.worker).catch(() => undefined);
      });
  }
}

function remotePathForSession(session, value = "~") {
  const input = String(value || "~").trim();
  if (!session.home) throw new Error("尚未读取远端主目录");
  if (!input || /[\r\n\x00]/.test(input)) throw new Error("工作区路径无效");
  if (input === "~") return session.home;
  if (input.startsWith("~/")) return path.posix.join(session.home, input.slice(2));
  if (input.startsWith("/")) return path.posix.normalize(input);
  return path.posix.join(session.home, input);
}

function workspaceDisplayName(session, canonicalPath) {
  if (canonicalPath === session.home) return "主目录";
  return path.posix.basename(canonicalPath) || canonicalPath;
}

async function inspectRemoteWorkspace(session, requestedPath = "~") {
  if (session.status !== "connected") throw new Error("SSH 尚未连接");
  if (session.demo) {
    const canonicalPath = remotePathForSession(session, requestedPath);
    return {
      path: canonicalPath,
      name: workspaceDisplayName(session, canonicalPath),
      mode: canonicalPath.startsWith(`${session.home}/.easywork/`)
        ? "managed"
        : "attached",
      versionRoot: canonicalPath,
      writable: true,
    };
  }
  if (!session.client) throw new Error("SSH 尚未连接");
  const candidate = remotePathForSession(session, requestedPath);
  const result = await remoteExec(
    session.client,
    [
      "set -eu",
      `EW_INPUT=${shellQuote(candidate)}`,
      'test -d "$EW_INPUT" || { printf "%s\\n" "所选工作区不存在或不是文件夹" >&2; exit 40; }',
      'test -r "$EW_INPUT" && test -x "$EW_INPUT" || { printf "%s\\n" "没有读取所选工作区的权限" >&2; exit 41; }',
      'EW_PATH="$(cd "$EW_INPUT" && pwd -P)"',
      'EW_WRITABLE=0; test -w "$EW_PATH" && EW_WRITABLE=1',
      'EW_GIT=0; EW_REPO=""; if command -v git >/dev/null 2>&1; then EW_GIT=1; EW_REPO="$(cd "$EW_PATH" && git rev-parse --show-toplevel 2>/dev/null || true)"; fi',
      'printf "PATH=%s\\n" "$EW_PATH"',
      'printf "WRITABLE=%s\\n" "$EW_WRITABLE"',
      'printf "GIT_AVAILABLE=%s\\n" "$EW_GIT"',
      'printf "REPO_ROOT=%s\\n" "$EW_REPO"',
    ].join("\n"),
  );
  const fields = parseRuntimeFields(result.stdout);
  const canonicalPath = String(fields.PATH || "").trim();
  if (!canonicalPath.startsWith("/")) {
    throw new Error("服务器没有返回有效的工作区路径");
  }
  const managedRoots = [
    `${session.home}/.easywork/workspaces/`,
    `${session.home}/.easywork/worktrees/`,
    `${session.home}/.easywork/virtual/`,
  ];
  const gitAvailable = String(fields.GIT_AVAILABLE || "0") === "1";
  const versionRoot = gitAvailable
    ? String(fields.REPO_ROOT || "").trim() || canonicalPath
    : undefined;
  return {
    path: canonicalPath,
    name: workspaceDisplayName(session, canonicalPath),
    mode: managedRoots.some((root) => canonicalPath.startsWith(root))
      ? "managed"
      : gitAvailable
        ? "attached"
        : "unmanaged",
    versionRoot,
    writable: String(fields.WRITABLE || "0") === "1",
  };
}

async function registerWorkspace(actor, session, requestedPath = "~", options = {}) {
  const inspected = await inspectRemoteWorkspace(session, requestedPath);
  const timestamp = isoNow();
  const record = normalizeWorkspaceRecord({
    ...inspected,
    serverId: session.serverId,
    serverIdentity: session.serverIdentity,
    name: String(options.name || "").trim() || inspected.name,
    kind: options.kind,
    virtualConversationId: options.virtualConversationId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: timestamp,
  });
  if (!record) throw new Error("无法登记工作区");
  await updateWorkspaceDocument(actor, (document) => {
    const previous = document.records[record.id];
    document.records[record.id] = {
      ...record,
      createdAt: previous?.createdAt || record.createdAt,
    };
    return document;
  });
  return record;
}

async function ensureVirtualWorkspace(actor, session, conversationId) {
  const safeConversationId = safeSegment(conversationId || "", "");
  if (!safeConversationId) throw new Error("虚拟工作区缺少对话标识");
  if (session.status !== "connected") throw new Error("SSH 尚未连接");
  if (!session.home) throw new Error("尚未读取远端主目录");
  const virtualPath = `${session.home}/.easywork/virtual/${safeConversationId}`;
  if (!session.demo) {
    if (!session.client) throw new Error("SSH 尚未连接");
    await remoteExec(
      session.client,
      [
        "set -eu",
        `EW_DIR=${shellQuote(virtualPath)}`,
        'mkdir -p "$EW_DIR"',
        'chmod 700 "$HOME/.easywork" "$HOME/.easywork/virtual" "$EW_DIR" 2>/dev/null || true',
        'if command -v git >/dev/null 2>&1 && ! (cd "$EW_DIR" && git rev-parse --git-dir >/dev/null 2>&1); then (cd "$EW_DIR" && git init -q); fi',
      ].join("\n"),
    );
  }
  return registerWorkspace(actor, session, virtualPath, {
    name: "虚拟工作区",
    kind: "virtual",
    virtualConversationId: safeConversationId,
  });
}

async function registeredWorkspaceForRun(
  actor,
  session,
  workspaceId,
  expectedConversationId = "",
) {
  const requestedId = String(workspaceId || "").trim();
  if (!requestedId) throw new Error("请先选择工作区");
  const document = await readWorkspaceDocument(actor);
  const stored = document.records[requestedId];
  if (!stored || stored.serverId !== session.serverId) {
    throw new Error("所选工作区不存在，请重新选择");
  }
  if (
    String(stored.serverIdentity || "") !== String(session.serverIdentity || "")
  ) {
    throw new Error("服务器连接目标已经变化，请重新选择工作区");
  }
  if (
    stored.kind === "virtual" &&
    expectedConversationId &&
    String(stored.virtualConversationId || "") !==
      safeSegment(expectedConversationId, "")
  ) {
    const error = new Error("虚拟工作区只属于创建它的对话");
    error.statusCode = 409;
    throw error;
  }
  const inspected = await inspectRemoteWorkspace(session, stored.path);
  const currentId = workspaceIdFor(session.serverId, inspected.path);
  if (currentId !== requestedId) {
    throw new Error("工作区真实路径已经变化，请重新选择");
  }
  const timestamp = isoNow();
  const record = {
    ...stored,
    ...inspected,
    id: requestedId,
    serverId: session.serverId,
    serverIdentity: session.serverIdentity,
    kind: stored.kind === "virtual" ? "virtual" : "physical",
    virtualConversationId: stored.virtualConversationId,
    versionDomainId: workspaceVersionDomainIdFor(
      session.serverIdentity,
      inspected.versionRoot,
      inspected.path,
    ),
    updatedAt: timestamp,
    lastUsedAt: timestamp,
  };
  await updateWorkspaceDocument(actor, (next) => {
    next.records[requestedId] = record;
    return next;
  });
  return record;
}

async function ensureTaskWorkspace(session, task, workspace) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const managedPrefixes = [
    `${session.home}/.easywork/workspaces/`,
    `${session.home}/.easywork/virtual/`,
    `${session.home}/.easywork/worktrees/`,
  ];
  const requestedManaged =
    task.workspaceMode === "managed" &&
    managedPrefixes.some((prefix) => workspace.startsWith(prefix));
  if (!requestedManaged) return;
  await remoteExec(
    session.client,
    [
      "set -eu",
      `EW_DIR=${shellQuote(workspace)}`,
      'mkdir -p "$EW_DIR"',
      'chmod 700 "$HOME/.easywork" "$HOME/.easywork/workspaces" 2>/dev/null || true',
      'if command -v git >/dev/null 2>&1 && ! (cd "$EW_DIR" && git rev-parse --git-dir >/dev/null 2>&1); then (cd "$EW_DIR" && git init -q); fi',
    ].join("\n"),
  );
}

function checkpointIdForTask(task, phase) {
  return safeRemoteRunId(`checkpoint-${task.runId}-${phase}`);
}

function checkpointWorkspaceLayout(session, task, workspaceValue) {
  const workspace = normalizedWorkspacePath(
    remotePathForSession(session, workspaceValue),
  );
  const requestedRoot = normalizedWorkspacePath(
    remotePathForSession(session, task.versionRoot || workspace),
  );
  const versionRoot = workspacePathContains(requestedRoot, workspace)
    ? requestedRoot
    : workspace;
  const repoRelativePath =
    versionRoot === workspace
      ? ""
      : path.posix.relative(versionRoot, workspace).replace(/\/+$/, "");
  if (
    repoRelativePath === ".." ||
    repoRelativePath.startsWith("../") ||
    path.posix.isAbsolute(repoRelativePath)
  ) {
    throw new Error("工作区不在版本根目录内");
  }
  return { workspace, versionRoot, repoRelativePath };
}

async function createWorkspaceCheckpoint(session, actor, task, phase) {
  const checkpointId = checkpointIdForTask(task, phase);
  const { workspace, versionRoot, repoRelativePath } =
    checkpointWorkspaceLayout(session, task, task.workspace);
  const workspaceSegment = safeSegment(task.workspaceId, "workspace");
  const versionDomainId =
    String(task.versionDomainId || "") ||
    workspaceVersionDomainIdFor(
      task.serverIdentity || task.serverId,
      versionRoot,
      workspace,
    );
  const versionDomainSegment = safeSegment(versionDomainId, "version-domain");
  const versioningRoot = `${session.home}/.easywork/versioning/${versionDomainSegment}`;
  const shadowRepository = `${versioningRoot}/repository.git`;
  const gitConfigHome = `${versioningRoot}/git-home`;
  const checkpointRoot = `${versioningRoot}/checkpoints/${workspaceSegment}`;
  const indexRoot = `${versioningRoot}/indexes`;
  const bundlePath = `${checkpointRoot}/${checkpointId}.bundle`;
  const metadataPath = `${checkpointRoot}/${checkpointId}.json`;
  const temporaryIndex = `${indexRoot}/${checkpointId}.index`;
  const temporaryBundle = `${bundlePath}.tmp`;
  const refName = `refs/easywork-snapshot/${crypto
    .createHash("sha256")
    .update(checkpointId)
    .digest("hex")
    .slice(0, 24)}`;
  const result = await remoteExec(
    session.client,
    [
      "set -eu",
      `EW_DIR=${shellQuote(workspace)}`,
      `EW_ROOT=${shellQuote(checkpointRoot)}`,
      `EW_VERSION_ROOT=${shellQuote(versionRoot)}`,
      `EW_SCOPE=${shellQuote(repoRelativePath)}`,
      `EW_SHADOW=${shellQuote(shadowRepository)}`,
      `EW_GIT_HOME=${shellQuote(gitConfigHome)}`,
      `EW_INDEX_ROOT=${shellQuote(indexRoot)}`,
      `EW_BUNDLE=${shellQuote(bundlePath)}`,
      `EW_BUNDLE_TMP=${shellQuote(temporaryBundle)}`,
      `EW_INDEX=${shellQuote(temporaryIndex)}`,
      `EW_REF=${shellQuote(refName)}`,
      'EW_EASYWORK="$HOME/.easywork"',
      'umask 077',
      'mkdir -p "$EW_ROOT" "$EW_INDEX_ROOT" "$EW_GIT_HOME/.config"',
      'if ! test -d "$EW_DIR"; then echo "MODE=missing"; exit 0; fi',
      'if ! command -v git >/dev/null 2>&1; then echo "MODE=unmanaged"; exit 0; fi',
      'test -d "$EW_VERSION_ROOT" || { echo "MODE=missing"; exit 0; }',
      'EW_GIT_BIN="$(command -v git)"',
      'ew_git() { env HOME="$EW_GIT_HOME" XDG_CONFIG_HOME="$EW_GIT_HOME/.config" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_DIR="$EW_SHADOW" GIT_WORK_TREE="$EW_VERSION_ROOT" "$EW_GIT_BIN" "$@"; }',
      'if ! test -d "$EW_SHADOW"; then env HOME="$EW_GIT_HOME" XDG_CONFIG_HOME="$EW_GIT_HOME/.config" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "$EW_GIT_BIN" init -q --bare "$EW_SHADOW"; fi',
      'mkdir -p "$EW_SHADOW/info"',
      'printf "%s\\n" "/.easywork/" > "$EW_SHADOW/info/exclude"',
      'EW_PARENT="$(ew_git rev-parse -q --verify refs/easywork/latest^{commit} 2>/dev/null || true)"',
      'rm -f "$EW_INDEX" "$EW_BUNDLE_TMP"',
      'if test -n "$EW_PARENT"; then GIT_INDEX_FILE="$EW_INDEX" ew_git read-tree "$EW_PARENT^{tree}"; else GIT_INDEX_FILE="$EW_INDEX" ew_git read-tree --empty; fi',
      'trap \'rm -f "$EW_INDEX" "$EW_BUNDLE_TMP"\' EXIT HUP INT TERM',
      'if test -n "$EW_SCOPE"; then (cd "$EW_VERSION_ROOT" && GIT_INDEX_FILE="$EW_INDEX" ew_git add -A -- "$EW_SCOPE"); else (cd "$EW_VERSION_ROOT" && GIT_INDEX_FILE="$EW_INDEX" ew_git add -A -- .); fi',
      'case "$EW_EASYWORK/" in "$EW_VERSION_ROOT"/*) EW_REL="${EW_EASYWORK#"$EW_VERSION_ROOT"/}"; GIT_INDEX_FILE="$EW_INDEX" ew_git rm -r -q --cached --ignore-unmatch -- "$EW_REL" ;; esac',
      'GIT_INDEX_FILE="$EW_INDEX" ew_git rm -r -q --cached --ignore-unmatch -- .git 2>/dev/null || true',
      'EW_TREE="$(GIT_INDEX_FILE="$EW_INDEX" ew_git write-tree)"',
      'if test -n "$EW_PARENT"; then EW_COMMIT="$(printf "%s\\n" "EasyWork checkpoint" | env HOME="$EW_GIT_HOME" XDG_CONFIG_HOME="$EW_GIT_HOME/.config" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_DIR="$EW_SHADOW" GIT_AUTHOR_NAME=EasyWork GIT_AUTHOR_EMAIL=runtime@easywork.local GIT_COMMITTER_NAME=EasyWork GIT_COMMITTER_EMAIL=runtime@easywork.local "$EW_GIT_BIN" commit-tree "$EW_TREE" -p "$EW_PARENT")"; else EW_COMMIT="$(printf "%s\\n" "EasyWork checkpoint" | env HOME="$EW_GIT_HOME" XDG_CONFIG_HOME="$EW_GIT_HOME/.config" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_DIR="$EW_SHADOW" GIT_AUTHOR_NAME=EasyWork GIT_AUTHOR_EMAIL=runtime@easywork.local GIT_COMMITTER_NAME=EasyWork GIT_COMMITTER_EMAIL=runtime@easywork.local "$EW_GIT_BIN" commit-tree "$EW_TREE")"; fi',
      'ew_git update-ref "$EW_REF" "$EW_COMMIT"',
      'ew_git update-ref refs/easywork/latest "$EW_COMMIT"',
      'ew_git bundle create "$EW_BUNDLE_TMP" "$EW_REF" >/dev/null',
      'mv -f "$EW_BUNDLE_TMP" "$EW_BUNDLE"',
      'chmod 600 "$EW_BUNDLE"',
      'echo "MODE=shadow-git"',
      'echo "REPO_ROOT=$EW_VERSION_ROOT"',
      'echo "REPO_SCOPE=$EW_SCOPE"',
      'echo "SHADOW_REPO=$EW_SHADOW"',
      'echo "COMMIT=$EW_COMMIT"',
      'echo "REF=$EW_REF"',
      'echo "BUNDLE=$EW_BUNDLE"',
    ].join("\n"),
    { allowFailure: true },
  );
  const fields = parseRuntimeFields(result.stdout);
  const mode = String(fields.MODE || (result.code === 0 ? "unmanaged" : "error"));
  const checkpoint = {
    id: checkpointId,
    conversationId: task.conversationId,
    branchId: task.branchId || task.conversationId,
    taskId: task.runId,
    runId: task.runId,
    phase,
    serverId: task.serverId,
    serverIdentity: task.serverIdentity || session.serverIdentity,
    workspaceId: String(task.workspaceId || ""),
    workspaceName: String(task.workspaceName || "") || undefined,
    workspaceKind: task.workspaceKind === "virtual" ? "virtual" : "physical",
    versionDomainId,
    versionRoot,
    workspace,
    workspaceMode:
      mode === "shadow-git"
        ? workspace.startsWith(`${session.home}/.easywork/worktrees/`) ||
          workspace.startsWith(`${session.home}/.easywork/workspaces/`)
          ? "managed"
          : "attached"
        : "unmanaged",
    status: mode === "shadow-git" ? "available" : "unavailable",
    repoRoot: fields.REPO_ROOT || undefined,
    repoRelativePath: fields.REPO_SCOPE || repoRelativePath,
    versionEngine: mode === "shadow-git" ? "easywork-shadow-git" : undefined,
    shadowRepositoryPath: fields.SHADOW_REPO || undefined,
    snapshotCommit: fields.COMMIT || undefined,
    snapshotRef: fields.REF || undefined,
    remoteBundlePath: fields.BUNDLE || undefined,
    remoteMetadataPath: metadataPath,
    exclusions:
      mode === "shadow-git"
        ? ["ignored files", "nested repository contents", "workspace-external effects"]
        : ["Git unavailable", "workspace-external effects"],
    diagnostic:
      mode === "shadow-git"
        ? ""
        : String(result.stderr || "服务器没有可用于 EasyWork 快照的 Git 可执行文件")
            .trim()
            .slice(0, 1_000),
    createdAt: isoNow(),
  };
  await remoteSftpWriteAtomic(
    session.client,
    metadataPath,
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    0o600,
  ).catch(() => undefined);
  await updateCheckpointDocument(actor, (document) => {
    document.checkpoints[checkpointId] = checkpoint;
    return document;
  });
  return checkpoint;
}

function checkpointForRun(document, runId, phase) {
  return Object.values(document?.checkpoints || {})
    .filter(
      (checkpoint) =>
        checkpoint?.runId === runId && checkpoint?.phase === phase,
    )
    .sort((left, right) =>
      String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
    )[0];
}

async function restoreWorkspaceCheckpoint(session, checkpoint, conversationId) {
  if (!checkpoint || checkpoint.status !== "available") {
    throw new Error("该消息没有可恢复的 Git 工作区快照");
  }
  if (!session?.client || session.status !== "connected") {
    throw new Error("对应服务器当前未连接，无法恢复工作区快照");
  }
  const conversationSegment = safeSegment(conversationId, "conversation");
  const target = `${session.home}/.easywork/worktrees/${conversationSegment}/main`;
  const relativeWorkspace = String(checkpoint.repoRelativePath || "").trim();
  if (
    relativeWorkspace.startsWith("/") ||
    relativeWorkspace.split("/").includes("..")
  ) {
    throw new Error("工作区检查点包含无效的相对路径");
  }
  const targetWorkspace = relativeWorkspace
    ? path.posix.join(target, relativeWorkspace)
    : target;
  const result = await remoteExec(
    session.client,
    [
      "set -eu",
      `EW_BUNDLE=${shellQuote(checkpoint.remoteBundlePath)}`,
      `EW_REF=${shellQuote(checkpoint.snapshotRef)}`,
      `EW_TARGET=${shellQuote(target)}`,
      'test -f "$EW_BUNDLE"',
      'test ! -e "$EW_TARGET"',
      'mkdir -p "$EW_TARGET"',
      '(cd "$EW_TARGET" && git init -q)',
      'if ! (cd "$EW_TARGET" && git fetch -q "$EW_BUNDLE" "$EW_REF"); then rm -rf "$EW_TARGET"; exit 1; fi',
      'if ! (cd "$EW_TARGET" && git checkout -q --detach FETCH_HEAD); then rm -rf "$EW_TARGET"; exit 1; fi',
      `mkdir -p ${shellQuote(targetWorkspace)}`,
      `printf "WORKSPACE=%s\\n" ${shellQuote(targetWorkspace)}`,
      'echo "COMMIT=$(cd "$EW_TARGET" && git rev-parse HEAD)"',
    ].join("\n"),
  );
  const fields = parseRuntimeFields(result.stdout);
  if (!fields.WORKSPACE || fields.WORKSPACE !== targetWorkspace) {
    throw new Error("工作区快照恢复结果无法验证");
  }
  return {
    workspace: targetWorkspace,
    repoRoot: target,
    commit: fields.COMMIT,
    mode: "managed",
    sourceCheckpointId: checkpoint.id,
  };
}

async function selectivelyRevertWorkspaceRuns(
  session,
  actor,
  {
    conversationId,
    serverId,
    workspace,
    workspaceId,
    workspaceName,
    workspaceKind,
    versionRoot,
    versionDomainId,
    checkpoints,
  },
) {
  if (!checkpoints.length) return { reverted: false, files: [] };
  if (!session?.client || session.status !== "connected") {
    throw new Error("对应服务器当前未连接，无法重置本轮工作区修改");
  }
  for (const pair of checkpoints) {
    if (pair.before?.status !== "available" || pair.after?.status !== "available") {
      throw new Error(`任务 ${pair.runId} 缺少可用的前后工作区检查点`);
    }
    if (
      workspaceId &&
      [pair.before.workspaceId, pair.after.workspaceId].some(
        (value) => value && String(value) !== String(workspaceId),
      )
    ) {
      throw new Error(`任务 ${pair.runId} 不属于当前工作区，已停止重置`);
    }
  }
  const resetId = safeRemoteRunId(randomId("reset-"));
  const currentCheckpoint = await createWorkspaceCheckpoint(
    session,
    actor,
    {
      conversationId,
      branchId: conversationId,
      runId: resetId,
      serverId,
      workspace,
      workspaceId,
      workspaceName,
      workspaceKind,
      versionRoot,
      versionDomainId,
    },
    "current",
  );
  if (currentCheckpoint.status !== "available") {
    throw new Error(
      currentCheckpoint.diagnostic || "当前工作区无法创建安全快照，已停止重置",
    );
  }
  const previewId = `reset-preview-${resetId}`;
  const preview = await restoreWorkspaceCheckpoint(
    session,
    currentCheckpoint,
    previewId,
  );
  const tempRoot = `${session.home}/.easywork/tmp/${resetId}`;
  const repoScope = String(currentCheckpoint.repoRelativePath || "");
  const commands = [
    "set -eu",
    `EW_PREVIEW=${shellQuote(preview.repoRoot)}`,
    `EW_ACTUAL=${shellQuote(currentCheckpoint.repoRoot || workspace)}`,
    `EW_SCOPE=${shellQuote(repoScope)}`,
    `EW_TMP=${shellQuote(tempRoot)}`,
    'case "$EW_PREVIEW" in "$HOME/.easywork/worktrees/reset-preview-"*) ;; *) echo "预演工作区路径校验失败" >&2; exit 91 ;; esac',
    'case "$EW_TMP" in "$HOME/.easywork/tmp/reset-"*) ;; *) echo "临时目录路径校验失败" >&2; exit 92 ;; esac',
    'mkdir -p "$EW_TMP"',
    'cleanup_reset() { rm -rf -- "$EW_PREVIEW" "$EW_TMP"; }',
    "trap cleanup_reset EXIT HUP INT TERM",
  ];
  checkpoints
    .slice()
    .reverse()
    .forEach((pair, index) => {
      const beforeRef = `refs/easywork-reset/${resetId}/${index}/before`;
      const afterRef = `refs/easywork-reset/${resetId}/${index}/after`;
      const patchPath = `${tempRoot}/${index}.patch`;
      commands.push(
        `(cd "$EW_PREVIEW" && git fetch -q ${shellQuote(pair.before.remoteBundlePath)} ${shellQuote(`${pair.before.snapshotRef}:${beforeRef}`)})`,
        `(cd "$EW_PREVIEW" && git fetch -q ${shellQuote(pair.after.remoteBundlePath)} ${shellQuote(`${pair.after.snapshotRef}:${afterRef}`)})`,
        `(cd "$EW_PREVIEW" && if test -n "$EW_SCOPE"; then git diff --binary --no-ext-diff ${shellQuote(afterRef)} ${shellQuote(beforeRef)} -- "$EW_SCOPE"; else git diff --binary --no-ext-diff ${shellQuote(afterRef)} ${shellQuote(beforeRef)} -- .; fi > ${shellQuote(patchPath)})`,
        `if test -s ${shellQuote(patchPath)}; then (cd "$EW_PREVIEW" && git apply --check ${shellQuote(patchPath)} && git apply ${shellQuote(patchPath)}); fi`,
      );
    });
  const combinedPatch = `${tempRoot}/combined.patch`;
  commands.push(
    `(cd "$EW_PREVIEW" && if test -n "$EW_SCOPE"; then git diff --binary --no-ext-diff HEAD -- "$EW_SCOPE"; else git diff --binary --no-ext-diff HEAD -- .; fi > ${shellQuote(combinedPatch)})`,
    '(cd "$EW_PREVIEW" && if test -n "$EW_SCOPE"; then git diff --name-only HEAD -- "$EW_SCOPE"; else git diff --name-only HEAD -- .; fi)',
    `if test -s ${shellQuote(combinedPatch)}; then (cd "$EW_ACTUAL" && git apply --no-index --check ${shellQuote(combinedPatch)}); fi`,
    `if test -s ${shellQuote(combinedPatch)}; then (cd "$EW_ACTUAL" && git apply --no-index ${shellQuote(combinedPatch)}); fi`,
  );
  const result = await remoteExec(session.client, commands.join("\n"));
  return {
    reverted: true,
    files: result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
    sourceCheckpointId: currentCheckpoint.id,
  };
}

async function readOpenCodeFailureLog(session) {
  const result = await remoteExec(
    session.client,
    [
      "set +e",
      'for root in "$HOME/.local/share/opencode/log" "$HOME/.local/share/opencode/logs"; do',
      '  [ -d "$root" ] || continue',
      '  latest="$(ls -1t "$root"/* 2>/dev/null | head -n 1)"',
      '  [ -n "$latest" ] || continue',
      '  tail -n 120 "$latest"',
      "  break",
      "done",
    ].join("\n"),
    { allowFailure: true },
  );
  const diagnosticText = `${result.stdout}\n${result.stderr}`;
  return conciseOpenCodeDiagnostic(diagnosticText);
}

function conciseOpenCodeDiagnostic(value) {
  const candidates = String(value || "")
    .split(/\r?\n/)
    .filter((line) => /error|fail|exception|provider|api[_ -]?call/i.test(line));
  if (!candidates.length) return "";
  let message = candidates.at(-1).trim();
  const embedded = message.match(/error(?:\.error)?=(?:"|')?(.+)$/i);
  if (embedded?.[1]) message = embedded[1];
  message = message
    .replace(/\\n\s*at[\s\S]*$/i, "")
    .replace(/\n\s*at[\s\S]*$/i, "")
    .replace(/(?:"|')?\s+cause=(?:"|')[\s\S]*$/i, "")
    .replace(/api_key:\s*[a-f0-9]{24,}/gi, "api_key: [已配置]")
    .replace(/\\(["'\\])/g, "$1")
    .replace(/^(?:"|')|(?:"|')$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...message].slice(0, 720).join("");
}

function fallbackConversationTitle(prompt) {
  const compact = String(prompt || "")
    .replace(/[`*_>#\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(请|帮我|麻烦|我想|能否|可以|一下)+/g, "")
    .trim();
  return [...(compact || "新对话")].slice(0, 14).join("");
}

function normalizeConversationTitle(value, prompt) {
  let source = String(value || "").trim();
  const objectMatch = source.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (typeof parsed?.title === "string") source = parsed.title;
    } catch {
      // Continue with the plain-text title candidate.
    }
  }
  const normalized = source
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^[#*`_\-]+\s*/, "")
    .replace(/^[\s"'“”‘’《》【】]+|[\s"'“”‘’《》【】。！？!?：:]+$/g, "")
    .replace(/^(标题|title)\s*[：:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim() || "";
  const metaTitle =
    /(?:生成|拟定|概括|总结).{0,8}(?:标题|题目)|(?:标题|题目).{0,6}(?:是|为)|根据.{0,16}(?:对话|请求|回答)|(?:用户|助手).{0,8}(?:请求|回答|询问)|(?:不超过|不要|要求)[一二三四五六七八九十\d]/.test(
      normalized,
    );
  if (
    !normalized ||
    [...normalized].length > 22 ||
    /[。！？!?；;]/.test(normalized) ||
    metaTitle
  ) {
    return fallbackConversationTitle(prompt);
  }
  return [...normalized].slice(0, 14).join("");
}

async function generateConversationTitle(actor, prompt, response = "") {
  const state = await getState(actor);
  const { provider, apiKey, category } = await effectiveProviderAccess(
    actor,
    state?.settings,
  );
  if (!provider.configured || !provider.model || !apiKey) {
    return fallbackConversationTitle(prompt);
  }
  const titlePrompt = await renderPromptTemplate("tasks/conversation-title.md", {
    USER_PROMPT: String(prompt || "").slice(0, 1_500),
    ASSISTANT_RESPONSE: String(response || "").slice(0, 1_500),
  });
  try {
    const { payload } = await callChatProvider(
      provider,
      apiKey,
      titlePrompt,
    );
    const responseText = extractModelText(payload);
    await recordProviderModelUsage(category, titlePrompt, responseText);
    return normalizeConversationTitle(responseText, prompt);
  } catch {
    return fallbackConversationTitle(prompt);
  }
}

async function agentPromptWithNativePlanning(
  context,
  webHandoff = "",
  workspaceScope = "",
  adapter = "opencode",
) {
  const agentBrief = webHandoff
    ? await renderPromptTemplate("web/agent-brief.md", {
        CONTENT: webHandoff,
      })
    : "";
  const [agentSystem, eventProtocol] = await Promise.all([
    renderPromptTemplate("agents/common.md"),
    renderPromptTemplate("agents/protocol.md"),
  ]);
  const template =
    adapter === "codex"
      ? "agents/codex.md"
      : adapter === "claude"
        ? "agents/claudecode.md"
        : "agents/opencode.md";
  return renderPromptTemplate(template, {
    AGENT_SYSTEM: agentSystem,
    SYNC_CONTEXT:
      typeof context === "string" ? context : String(context?.text || ""),
    AGENT_BRIEF: agentBrief,
    WORKSPACE_SCOPE: workspaceScope,
    EVENT_PROTOCOL: eventProtocol,
  });
}

function formatAgentDelta(delta) {
  if (!delta?.messages?.length) return "";
  return delta.messages
    .map((message) => {
      const speaker = message.role === "user" ? "用户" : "EasyWork";
      const agent = message.agentId ? ` / Agent ${message.agentId}` : "";
      const workspace = message.workspaceName
        ? ` / 工作区 ${message.workspaceName}`
        : "";
      return `${speaker}${agent}${workspace}：${message.content}`;
    })
    .join("\n\n");
}

async function buildAgentSyncContext(context, delta, memoryDelta) {
  const optionalSection = async (template, content) =>
    content
      ? renderPromptTemplate(template, {
          CONTENT: content,
        })
      : "";
  return renderPromptTemplate("context/agent-sync.md", {
    SUMMARY_SECTION: await optionalSection(
      "context/conversation-summary.md",
      delta.bootstrap || delta.truncated
        ? context.sections.conversationSummary
        : "",
    ),
    MEMORY_SECTION: await optionalSection(
      "context/agent-memory-delta.md",
      formatMemoryContext(memoryDelta),
    ),
    DELTA_SECTION: await optionalSection(
      "context/agent-delta.md",
      formatAgentDelta(delta),
    ),
  });
}

function agentMemoryDelta(context, binding) {
  const versions = binding?.syncCursor?.memoryVersions || {};
  const statuses = binding?.syncCursor?.memoryStatuses || {};
  if (!context?.state?.settings?.memoryEnabled) {
    if (binding?.syncCursor?.memoryEnabled === false) return [];
    return Object.entries(versions).map(([id, revision]) => ({
      id,
      revision: Number(revision || 0) + 1,
      status: "deleted",
      scope: "conversation",
      semanticKey: id,
      source: "memory-disabled",
    }));
  }
  const candidates = binding?.agentSessionId
    ? context?.memorySyncRecords || []
    : context?.memoryRecords || [];
  const candidateIds = new Set(candidates.map((record) => String(record.id)));
  const changed = candidates.filter(
    (record) =>
      !binding?.agentSessionId ||
      Number(record.revision || 0) > Number(versions[record.id] || 0) ||
      String(record.status || "active") !==
        String(statuses[record.id] || "active"),
  );
  const outOfScopeRetractions = binding?.agentSessionId
    ? Object.entries(versions)
        .filter(
          ([id]) =>
            !candidateIds.has(String(id)) &&
            String(statuses[id] || "active") !== "deleted",
        )
        .map(([id, revision]) => ({
          id,
          revision: Number(revision || 0),
          status: "deleted",
          scope: "conversation",
          semanticKey: id,
          source: "memory-out-of-scope",
        }))
    : [];
  return [...changed, ...outOfScopeRetractions];
}

function workHandoffContext(context, delta, memoryDelta) {
  const separatelySynchronized = [
    delta.bootstrap || delta.truncated
      ? context.sections.conversationSummary
      : "",
    formatAgentDelta(delta),
    formatMemoryContext(memoryDelta),
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    context.sections.system,
    context.sections.skills
      ? `## 本轮技能\n\n${context.sections.skills}`
      : "",
    context.sections.knowledge
      ? `## 相关文件片段\n\n${context.sections.knowledge}`
      : "",
    separatelySynchronized
      ? `## 独立同步给 Agent 的上下文\n\n${separatelySynchronized}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function deterministicWorkHandoff(context) {
  const sections = [
    `## 本轮用户原文\n\n${context.sections.request}`,
    context.sections.skills
      ? `## 本轮技能\n\n${context.sections.skills}`
      : "",
    context.sections.knowledge
      ? `## 相关文件片段\n\n${context.sections.knowledge}`
      : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function providerConfigForOpenCode(provider) {
  const contextLimit =
    positiveInteger(provider.contextLimit || provider.modelContextLimit) ||
    DEFAULT_AGENT_CONTEXT_LIMIT;
  const outputLimit =
    positiveInteger(provider.outputLimit || provider.modelOutputLimit) ||
    DEFAULT_AGENT_OUTPUT_LIMIT;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [EASYWORK_OPENCODE_PROVIDER_ID]: {
        npm:
          provider.protocol === "responses"
            ? "@ai-sdk/openai"
            : "@ai-sdk/openai-compatible",
        name: "EasyWork",
        options: {
          baseURL: provider.baseUrl,
        },
        models: {
          [provider.model]: {
            name: provider.model,
            ...(contextLimit || outputLimit
              ? {
                  limit: {
                    ...(contextLimit ? { context: contextLimit } : {}),
                    ...(outputLimit ? { output: outputLimit } : {}),
                  },
                }
              : {}),
          },
        },
      },
    },
  };
}

function managedOpenCodeModel(agent, provider, hasApiKey) {
  const model = String(agent?.model || provider?.model || "").trim();
  return agent?.managed && model && hasApiKey
    ? `${EASYWORK_OPENCODE_PROVIDER_ID}/${model}`
    : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsoncObject(content, label = "OpenCode 配置") {
  const source = String(content || "").trim() ? String(content) : "{}";
  const errors = [];
  const value = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length || !isPlainObject(value)) {
    throw new Error(`${label}不是有效的 JSON/JSONC，已保留原文件`);
  }
  return value;
}

function setJsoncValue(content, propertyPath, value) {
  const source = String(content || "").trim() ? String(content) : "{}\n";
  return applyJsoncEdits(
    source,
    modifyJsonc(source, propertyPath, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: "\n",
      },
    }),
  );
}

function mergeOpenCodeConfigContent(content, provider) {
  const current = parseJsoncObject(content);
  let next = String(content || "").trim() ? String(content) : "{}\n";
  if (!current.$schema) {
    next = setJsoncValue(next, ["$schema"], "https://opencode.ai/config.json");
  }
  const managedProvider =
    providerConfigForOpenCode(provider).provider[EASYWORK_OPENCODE_PROVIDER_ID];
  next = setJsoncValue(
    next,
    ["provider", EASYWORK_OPENCODE_PROVIDER_ID],
    managedProvider,
  );
  return `${next.trimEnd()}\n`;
}

function parseOpenCodeAuth(content) {
  if (!String(content || "").trim()) return {};
  try {
    const value = JSON.parse(String(content));
    if (isPlainObject(value)) return value;
  } catch {
    // Report one stable error below without leaking credential content.
  }
  throw new Error("OpenCode 原生认证文件不是有效 JSON，已保留原文件");
}

function mergeOpenCodeAuthContent(content, apiKey) {
  const auth = parseOpenCodeAuth(content);
  auth[EASYWORK_OPENCODE_PROVIDER_ID] = {
    type: "api",
    key: String(apiKey),
  };
  return `${JSON.stringify(auth, null, 2)}\n`;
}

function hasOpenCodeCredential(value) {
  if (!isPlainObject(value)) return false;
  if (value.type === "api") return Boolean(value.key);
  if (value.type === "oauth") return Boolean(value.access || value.refresh);
  return Object.values(value).some((item) => typeof item === "string" && item);
}

function openCodeConfiguredModelDetails(config, preferredModel = "") {
  const providers = isPlainObject(config?.provider) ? config.provider : {};
  const configuredFullModel = String(preferredModel || config?.model || "").trim();
  const configuredParts = configuredFullModel.includes("/")
    ? [configuredFullModel.split("/")[0], configuredFullModel.split("/").slice(1).join("/")]
    : [];
  const candidates = [];
  if (configuredParts.length === 2) candidates.push(configuredParts);
  if (configuredFullModel && !configuredParts.length) {
    for (const [providerId, providerValue] of Object.entries(providers)) {
      if (isPlainObject(providerValue?.models?.[configuredFullModel])) {
        candidates.push([providerId, configuredFullModel]);
      }
    }
  }
  const easyworkModels = Object.keys(
    isPlainObject(providers[EASYWORK_OPENCODE_PROVIDER_ID]?.models)
      ? providers[EASYWORK_OPENCODE_PROVIDER_ID].models
      : {},
  );
  for (const modelId of easyworkModels) {
    candidates.push([EASYWORK_OPENCODE_PROVIDER_ID, modelId]);
  }
  for (const [providerId, providerValue] of Object.entries(providers)) {
    for (const modelId of Object.keys(
      isPlainObject(providerValue?.models) ? providerValue.models : {},
    )) {
      candidates.push([providerId, modelId]);
    }
  }
  const seen = new Set();
  for (const [providerId, modelId] of candidates) {
    const key = `${providerId}/${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const modelConfig = providers[providerId]?.models?.[modelId];
    if (!isPlainObject(modelConfig)) continue;
    return {
      providerId,
      modelId,
      model: key,
      contextLimit: positiveInteger(modelConfig.limit?.context),
      outputLimit: positiveInteger(modelConfig.limit?.output),
    };
  }
  return {
    providerId: configuredParts[0] || "",
    modelId: configuredParts[1] || configuredFullModel,
    model: configuredFullModel,
    contextLimit: null,
    outputLimit: null,
  };
}

function openCodeConfigurationStatus(
  configContent,
  authContent,
  { managed = false } = {},
) {
  let config;
  let auth;
  try {
    config = parseJsoncObject(configContent);
    auth = parseOpenCodeAuth(authContent);
  } catch (caught) {
    return {
      configured: false,
      error: caught instanceof Error ? caught.message : "OpenCode 配置无法解析",
    };
  }

  const providers = isPlainObject(config.provider) ? config.provider : {};
  const configuredModel = openCodeConfiguredModelDetails(config);
  const authenticatedProviderIds = Object.entries(auth)
    .filter(([, credential]) => hasOpenCodeCredential(credential))
    .map(([providerId]) => providerId);
  const easyworkProvider = providers[EASYWORK_OPENCODE_PROVIDER_ID];
  const easyworkModels = Object.keys(easyworkProvider?.models || {});
  const easyworkConfigured = Boolean(
    easyworkProvider?.options?.baseURL &&
      easyworkModels.length &&
      (hasOpenCodeCredential(auth[EASYWORK_OPENCODE_PROVIDER_ID]) ||
        easyworkProvider?.options?.apiKey),
  );
  if (managed) {
    return {
      configured: easyworkConfigured,
      providerId: EASYWORK_OPENCODE_PROVIDER_ID,
      model: easyworkModels[0] || "",
      contextLimit:
        positiveInteger(
          providers[EASYWORK_OPENCODE_PROVIDER_ID]?.models?.[easyworkModels[0]]
            ?.limit?.context,
        ) || undefined,
      outputLimit:
        positiveInteger(
          providers[EASYWORK_OPENCODE_PROVIDER_ID]?.models?.[easyworkModels[0]]
            ?.limit?.output,
        ) || undefined,
    };
  }

  const configuredProvider = Object.entries(providers).some(
    ([providerId, providerValue]) => {
      if (!isPlainObject(providerValue)) return false;
      const modelCount = Object.keys(providerValue.models || {}).length;
      const hasInlineCredential = Boolean(providerValue.options?.apiKey);
      const hasNativeCredential = authenticatedProviderIds.includes(providerId);
      const allowsKeylessEndpoint = Boolean(
        providerValue.options?.baseURL && modelCount,
      );
      return Boolean(
        modelCount &&
          (hasInlineCredential || hasNativeCredential || allowsKeylessEndpoint),
      );
    },
  );
  return {
    configured: Boolean(
      easyworkConfigured ||
        authenticatedProviderIds.length ||
        String(config.model || "").trim() ||
      configuredProvider,
    ),
    providerId: configuredModel.providerId || undefined,
    model: configuredModel.modelId || undefined,
    contextLimit: configuredModel.contextLimit || undefined,
    outputLimit: configuredModel.outputLimit || undefined,
  };
}

function agentConfigFor(adapter, home, { managed = false, agentId = "" } = {}) {
  if (managed) {
    const id = agentId || (adapter === "claude" ? "claudecode" : adapter);
    const managedPaths = managedAgentPaths(home, id);
    if (adapter === "opencode") {
      return {
        configPath: managedPaths.opencodeConfigPath,
        authPath: managedPaths.opencodeAuthPath,
        dataPath: managedPaths.dataRoot,
        configRoot: managedPaths.configRoot,
      };
    }
    if (adapter === "codex") {
      return {
        configPath: managedPaths.codexConfigPath,
        dataPath: managedPaths.codexHome,
        configRoot: managedPaths.configRoot,
        apiKeyPath: managedPaths.apiKeyPath,
      };
    }
    if (adapter === "claude") {
      return {
        configPath: managedPaths.claudeSettingsPath,
        dataPath: managedPaths.claudeConfigDir,
        configRoot: managedPaths.configRoot,
        apiKeyPath: managedPaths.apiKeyPath,
      };
    }
  }
  if (adapter === "opencode") {
    return {
      configPath: `${home}/.config/opencode/opencode.json`,
      alternateConfigPath: `${home}/.config/opencode/opencode.jsonc`,
      dataPath: `${home}/.local/share/opencode`,
    };
  }
  if (adapter === "claude") {
    return {
      configPath: `${home}/.claude/settings.json`,
      dataPath: `${home}/.claude`,
    };
  }
  if (adapter === "codex") {
    return {
      configPath: `${home}/.codex/config.toml`,
      dataPath: `${home}/.codex`,
    };
  }
  return {};
}

function agentRuntimeCapabilities(
  adapter,
  status = "ready",
  { liveControl = true } = {},
) {
  const available = status === "ready";
  const supported = ["opencode", "codex", "claude"].includes(adapter) && available;
  return {
    // All built-in adapters accept instructions while a run is active.
    // OpenCode consumes them immediately. Codex and Claude Code execute the
    // queued text as the next turn on the same native session.
    liveInput: supported && liveControl,
    nativeAbort: supported && liveControl,
    resumeSession: supported,
    nativePlanning: supported,
    workspaceCheckpoint: true,
    contextReadable: supported,
    permissions: supported,
  };
}

function remoteAgentRegistryPath(actor) {
  return path.join(actorDirectory(actor), "runtime", "remote-agents.json");
}

function agentRuntimeProfilesPath(actor) {
  return path.join(actorDirectory(actor), "runtime", "agent-profiles.json");
}

function normalizeAgentRuntimeScope(scope = {}) {
  return {
    conversationId: String(scope.conversationId || ""),
    workspaceId: String(scope.workspaceId || ""),
  };
}

function agentRuntimeProfileKey(session, agentId, scope = {}) {
  const normalized = normalizeAgentRuntimeScope(scope);
  return [
    remoteServerKey(session),
    safeSegment(agentId),
    normalized.conversationId ? safeSegment(normalized.conversationId) : "default",
    normalized.workspaceId ? safeSegment(normalized.workspaceId) : "default",
  ].join(":");
}

function agentRuntimeId(session, agentId, scope = {}) {
  return crypto
    .createHash("sha256")
    .update(agentRuntimeProfileKey(session, agentId, scope))
    .digest("hex")
    .slice(0, 24);
}

async function readAgentRuntimeProfiles(actor) {
  const document = await readJson(agentRuntimeProfilesPath(actor), {
    schemaVersion: 1,
    profiles: {},
  });
  return {
    schemaVersion: 1,
    profiles:
      document?.profiles && typeof document.profiles === "object"
        ? document.profiles
        : {},
  };
}

async function getAgentRuntimeProfile(actor, session, agentId, scope = {}) {
  const document = await readAgentRuntimeProfiles(actor);
  const scoped =
    document.profiles[agentRuntimeProfileKey(session, agentId, scope)] || null;
  if (scoped) return scoped;
  const normalized = normalizeAgentRuntimeScope(scope);
  if (normalized.conversationId || normalized.workspaceId) {
    return (
      document.profiles[agentRuntimeProfileKey(session, agentId)] || null
    );
  }
  return null;
}

async function updateAgentRuntimeProfile(
  actor,
  session,
  agentId,
  scopeOrPatch,
  maybePatch,
) {
  const hasExplicitScope = maybePatch !== undefined;
  const scope = hasExplicitScope ? normalizeAgentRuntimeScope(scopeOrPatch) : {};
  const patch = hasExplicitScope ? maybePatch : scopeOrPatch;
  return enqueueActorMutation(agentProfileMutationQueues, actor, async () => {
    const document = await readAgentRuntimeProfiles(actor);
    const key = agentRuntimeProfileKey(session, agentId, scope);
    const previous = document.profiles[key] || {};
    document.profiles[key] = {
      ...previous,
      ...patch,
      serverId: session.serverId,
      agentId,
      conversationId: scope.conversationId || undefined,
      workspaceId: scope.workspaceId || undefined,
      updatedAt: isoNow(),
    };
    await writeJson(agentRuntimeProfilesPath(actor), document);
    return document.profiles[key];
  });
}

function remoteServerKey(session) {
  return safeSegment(
    session.serverId ||
      crypto
        .createHash("sha256")
        .update(`${session.host}:${session.port || 22}:${session.username}`)
        .digest("hex")
        .slice(0, 16),
  );
}

async function storedRemoteAgents(actor, session) {
  const registry = await readJson(remoteAgentRegistryPath(actor), {});
  return Array.isArray(registry[remoteServerKey(session)])
    ? registry[remoteServerKey(session)]
    : [];
}

async function inspectOpenCodeNativeConfiguration(session, agent = {}) {
  const defaults = agentConfigFor("opencode", session.home, {
    managed: Boolean(agent.managed),
    agentId: agent.id || "opencode",
  });
  const jsonPath = agent.configPath || defaults.configPath;
  const jsoncPath = agent.alternateConfigPath || defaults.alternateConfigPath;
  const authPath =
    agent.authPath ||
    defaults.authPath ||
    `${session.home}/.local/share/opencode/auth.json`;
  const jsonBuffer = jsonPath
    ? await remoteSftpReadOptional(session.client, jsonPath)
    : null;
  const jsoncBuffer = jsoncPath
    ? await remoteSftpReadOptional(session.client, jsoncPath)
    : null;
  const authBuffer = await remoteSftpReadOptional(session.client, authPath);
  const useJsonc = Boolean(jsoncBuffer?.length);
  const configPath = useJsonc ? jsoncPath : jsonPath;
  const configContent = String(
    (useJsonc ? jsoncBuffer : jsonBuffer) || "",
  );
  const authContent = String(authBuffer || "");
  return {
    configPath,
    authPath,
    dataPath: agent.dataPath || defaults.dataPath,
    configContent,
    authContent,
    ...openCodeConfigurationStatus(configContent, authContent, {
      managed: Boolean(agent.managed),
    }),
  };
}

async function scanRemoteAgents(session, actor, scope = {}) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const liveControlCheck = await remoteExec(
    session.client,
    "command -v curl >/dev/null 2>&1 && command -v setsid >/dev/null 2>&1",
    { allowFailure: true },
  );
  const liveControlAvailable = liveControlCheck.code === 0;
  const command = [
    "set +e",
    'emit_agent() { EW_ID="$1"; EW_FOLDER="$2"; EW_BIN="$3"; EW_ADAPTER="$4"; EW_DEPLOYMENT="$5"; test -n "$EW_BIN" && test -x "$EW_BIN" || return 0; EW_VERSION="$("$EW_BIN" --version 2>/dev/null | head -n 1)"; printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$EW_ID" "$EW_FOLDER" "$EW_BIN" "$EW_VERSION" "$EW_ADAPTER" "$EW_DEPLOYMENT"; }',
    'emit_agent opencode "$HOME/.easywork/agents/opencode" "$HOME/.easywork/agents/opencode/bin/opencode" opencode easywork',
    'emit_agent codex "$HOME/.easywork/agents/codex" "$HOME/.easywork/agents/codex/bin/codex" codex easywork',
    'emit_agent claudecode "$HOME/.easywork/agents/claudecode" "$HOME/.easywork/agents/claudecode/bin/claude" claude easywork',
  ].join("\n");
  const result = await remoteExec(session.client, command, { allowFailure: true });
  const discovered = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, folder, binaryPath, version, adapter = "plain", deployment] = line.split("\t");
      const managed = deployment === "easywork";
      const managedId = managed ? id : "";
      const config = agentConfigFor(adapter, session.home, {
        managed,
        agentId: managedId,
      });
      return {
        id,
        name:
          adapter === "opencode"
            ? "OpenCode"
            : adapter === "codex"
              ? "Codex"
              : "Claude Code",
        folder,
        path: binaryPath,
        version: version || undefined,
        status: "ready",
        adapter,
        managed,
        deployment: managed ? "easywork" : "user",
        capabilities: agentRuntimeCapabilities(
          adapter,
          "ready",
          { liveControl: liveControlAvailable },
        ),
        ...config,
      };
    })
    .filter(
      (agent, index, agents) =>
        agents.findIndex((candidate) => candidate.path === agent.path) === index,
    );

  const custom = await storedRemoteAgents(actor, session);
  for (const stored of custom) {
    if (
      discovered.some(
        (agent) =>
          agent.id === stored.id ||
          agent.path === stored.path,
      )
    ) {
      continue;
    }
    const binaryResult = await remoteExec(
      session.client,
      `test -x ${shellQuote(stored.path)} && ${shellQuote(stored.path)} --version 2>/dev/null | head -n 1`,
      { allowFailure: true },
    );
    if (binaryResult.code !== 0 || !["opencode", "codex", "claude"].includes(stored.adapter)) continue;
    discovered.push({
      ...stored,
      version: binaryResult.stdout.trim() || stored.version,
      status: "ready",
      managed: false,
      deployment: "user",
      configured: true,
      capabilities: agentRuntimeCapabilities(
        stored.adapter,
        "ready",
        { liveControl: liveControlAvailable },
      ),
    });
  }

  const runtimeProfiles = await readAgentRuntimeProfiles(actor);
  const accountState = await getState(actor);
  const accountSettings = normalizeProviderSettings(accountState?.settings || {});
  const sharedAgentProvider = (await readPlatformSettings()).providers.agent;
  for (const agent of discovered) {
    const runtimeProfile =
      runtimeProfiles.profiles[agentRuntimeProfileKey(session, agent.id, scope)] ||
      runtimeProfiles.profiles[agentRuntimeProfileKey(session, agent.id)] || {};
    if (agent.managed) {
      const {
        provider: accountProvider,
        apiKey: accountProviderApiKey,
      } = await effectiveProviderAccess(
        actor,
        accountSettings,
        runtimeProfile.providerId ||
          accountSettings.providers.find((provider) => provider.audience === "agent")?.id ||
          (sharedAgentProvider.configured ? PLATFORM_AGENT_PROVIDER_ID : "") ||
          accountSettings.activeProviderId,
      );
      const model = String(runtimeProfile.model || accountProvider.model || "").trim();
      const runtimeId = agentRuntimeId(session, agent.id, scope);
      const runtimePaths = managedAgentRuntimePaths(session.home, agent.id, runtimeId);
      agent.runtimeId = runtimeId;
      agent.providerId = accountProvider.id;
      agent.model = model || undefined;
      agent.contextLimit =
        positiveInteger(runtimeProfile.contextLimit) ||
        positiveInteger(accountProvider.modelContextLimit) ||
        undefined;
      agent.outputLimit =
        positiveInteger(runtimeProfile.outputLimit) ||
        positiveInteger(accountProvider.modelOutputLimit) ||
        undefined;
      agent.configured = Boolean(
        accountProvider.baseUrl && accountProviderApiKey && model,
      );
      agent.configPath =
        agent.adapter === "opencode"
          ? runtimePaths.opencodeConfigPath
          : agent.adapter === "codex"
            ? runtimePaths.codexConfigPath
            : runtimePaths.claudeSettingsPath;
      agent.dataPath =
        agent.adapter === "opencode"
          ? runtimePaths.opencodeDataHome
          : agent.adapter === "codex"
            ? runtimePaths.codexHome
            : runtimePaths.claudeConfigDir;
      agent.configRoot = runtimePaths.configRoot;
      if (agent.adapter === "opencode") {
        agent.authPath = runtimePaths.opencodeAuthPath;
        delete agent.apiKeyPath;
      } else {
        agent.apiKeyPath = runtimePaths.apiKeyPath;
        delete agent.authPath;
      }
    } else {
      // User deployments keep their native config and credentials. EasyWork
      // intentionally does not inspect or rewrite them.
      agent.configured = true;
    }
    agent.model = runtimeProfile.model || agent.model || undefined;
    agent.reasoningEffort = runtimeProfile.reasoningEffort || undefined;
    agent.permissionMode = runtimeProfile.permissionMode || undefined;
    agent.sandboxMode = runtimeProfile.sandboxMode || undefined;
    agent.configurationSchema = agent.managed
      ? managedAgentCapabilitySchema(agent, runtimeProfile)
      : undefined;
    delete agent.alternateConfigPath;
  }

  let hostManifest = null;
  try {
    hostManifest = (await readAgentArtifactManifest()).manifest;
  } catch {
    // Scanning remains useful before the host artifact cache is initialized.
  }
  for (const catalog of Object.values(MANAGED_AGENT_CATALOG).reverse()) {
    const existing = discovered.find((agent) => agent.id === catalog.id);
    const hostVersion = normalizeAgentVersion(
      hostManifest?.agents?.[catalog.id]?.version,
    );
    if (existing) {
      existing.hostVersion = hostVersion || undefined;
      existing.updateAvailable = Boolean(
        hostVersion &&
          compareAgentVersions(existing.version, hostVersion) < 0,
      );
      continue;
    }
    const paths = managedAgentPaths(session.home, catalog.id);
    discovered.unshift({
      id: catalog.id,
      name: catalog.name,
      folder: paths.root,
      path: paths.binaryPath,
      status: "missing",
      adapter: catalog.adapter,
      managed: true,
      deployment: "easywork",
      configured: false,
      hostVersion: hostVersion || undefined,
      capabilities: agentRuntimeCapabilities(catalog.adapter, "missing", {
        liveControl: liveControlAvailable,
      }),
      configurationSchema: managedAgentCapabilitySchema(
        { adapter: catalog.adapter },
        runtimeProfiles.profiles[
          agentRuntimeProfileKey(session, catalog.id, scope)
        ] || {},
      ),
      ...agentConfigFor(catalog.adapter, session.home, {
        managed: true,
        agentId: catalog.id,
      }),
    });
  }
  return discovered;
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function managedCodexConfigContent(provider, profile, providerRoute) {
  const contextLimit =
    positiveInteger(profile?.contextLimit) ||
    positiveInteger(provider.modelContextLimit) ||
    DEFAULT_AGENT_CONTEXT_LIMIT;
  return [
    `model = ${tomlString(profile.model)}`,
    'model_provider = "easywork"',
    `model_context_window = ${contextLimit}`,
    `model_reasoning_effort = ${tomlString(profile.reasoningEffort || "medium")}`,
    `approval_policy = ${tomlString(profile.permissionMode || "never")}`,
    `sandbox_mode = ${tomlString(profile.sandboxMode || "workspace-write")}`,
    "",
    "[sandbox_workspace_write]",
    `network_access = ${profile.networkAccess === false ? "false" : "true"}`,
    "",
    "[model_providers.easywork]",
    'name = "EasyWork"',
    `base_url = ${tomlString(providerRoute.baseUrl)}`,
    'env_key = "EASYWORK_AGENT_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

function managedClaudeSettingsContent(provider, profile, providerRoute) {
  const persistentEffort = ["low", "medium", "high", "xhigh"].includes(
    profile.reasoningEffort,
  )
    ? profile.reasoningEffort
    : "";
  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      autoMemoryEnabled: false,
      ...(persistentEffort ? { effortLevel: persistentEffort } : {}),
      permissions: {
        defaultMode: profile.permissionMode || "acceptEdits",
        allow: Array.isArray(profile.allowedTools)
          ? profile.allowedTools
          : ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
        ask: Array.isArray(profile.askTools) ? profile.askTools : [],
        deny: Array.isArray(profile.deniedTools) ? profile.deniedTools : [],
      },
      env: {
        ANTHROPIC_BASE_URL: providerRoute.baseUrl,
        ANTHROPIC_MODEL: profile.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
      },
    },
    null,
    2,
  )}\n`;
}

function managedAgentCapabilitySchema(agent, profile = {}) {
  if (agent?.adapter === "codex") {
    return {
      reasoning: {
        label: "思考强度",
        value: profile.reasoningEffort || "medium",
        options: ["minimal", "low", "medium", "high", "xhigh"],
      },
      permission: {
        label: "审批策略",
        value: profile.permissionMode || "never",
        options: ["untrusted", "on-request", "never"],
      },
      sandbox: {
        label: "沙箱权限",
        value: profile.sandboxMode || "workspace-write",
        options: ["read-only", "workspace-write", "danger-full-access"],
      },
    };
  }
  if (agent?.adapter === "claude") {
    const effortOptions = ["low", "medium", "high", "xhigh", "max"];
    if (
      !agent.version ||
      compareAgentVersions(agent.version, "2.1.203") >= 0
    ) {
      effortOptions.push("ultracode");
    }
    return {
      reasoning: {
        label: "思考强度",
        value: profile.reasoningEffort || "high",
        options: effortOptions,
      },
      permission: {
        label: "权限模式",
        value: profile.permissionMode || "acceptEdits",
        options: [
          "default",
          "acceptEdits",
          "plan",
          "auto",
          "dontAsk",
          "bypassPermissions",
        ],
      },
    };
  }
  if (agent?.adapter === "opencode") {
    return {
      permission: {
        label: "全局工具权限",
        value: profile.permissionMode || "allow",
        options: ["ask", "allow", "deny"],
      },
    };
  }
  return {};
}

async function ensureManagedAgentRuntimeConfig(
  session,
  actor,
  agent,
  scope = {},
  onProgress = () => undefined,
) {
  if (!agent?.managed) {
    return {
      configured: true,
      managed: false,
      model: agent?.model || "",
      profile: {},
      paths: agentConfigFor(agent?.adapter, session.home),
    };
  }
  const state = await getState(actor);
  const sharedAgentProvider = (await readPlatformSettings()).providers.agent;
  const previousProfile =
    (await getAgentRuntimeProfile(actor, session, agent.id, scope)) || {};
  const { provider, apiKey: providerApiKey } = await effectiveProviderAccess(
    actor,
    state?.settings,
    previousProfile.providerId ||
      normalizeProviderSettings(state?.settings || {}).providers.find(
        (candidate) => candidate.audience === "agent",
      )?.id ||
      (sharedAgentProvider.configured ? PLATFORM_AGENT_PROVIDER_ID : "") ||
      state?.settings?.activeProviderId,
  );
  if (!provider.baseUrl || !providerApiKey) {
    return { configured: false, reason: "missing-provider" };
  }
  const model = String(previousProfile.model || provider.model || "").trim();
  if (!model) return { configured: false, reason: "missing-model" };
  const defaults =
    agent.adapter === "codex"
      ? { reasoningEffort: "medium", permissionMode: "never", sandboxMode: "workspace-write" }
      : agent.adapter === "claude"
        ? { reasoningEffort: "high", permissionMode: "acceptEdits" }
        : { permissionMode: "allow" };
  const profile = await updateAgentRuntimeProfile(actor, session, agent.id, scope, {
    ...defaults,
    ...previousProfile,
    providerId: provider.id,
    model,
    contextLimit:
      positiveInteger(previousProfile.contextLimit) ||
      positiveInteger(provider.modelContextLimit) ||
      DEFAULT_AGENT_CONTEXT_LIMIT,
    outputLimit:
      positiveInteger(previousProfile.outputLimit) ||
      positiveInteger(provider.modelOutputLimit) ||
      DEFAULT_AGENT_OUTPUT_LIMIT,
  });
  onProgress("network", "检测远端模型 API 连接");
  const providerRoute = await ensureRemoteProviderRoute(session, provider);
  const runtimeId = agentRuntimeId(session, agent.id, scope);
  const paths = managedAgentRuntimePaths(session.home, agent.id, runtimeId);
  const runtimeProvider = {
    ...provider,
    baseUrl: providerRoute.baseUrl,
    model,
    modelContextLimit: profile.contextLimit,
    modelOutputLimit: profile.outputLimit,
  };
  onProgress("configure", `同步 ${agent.name} 对话隔离配置`);
  await remoteExec(
    session.client,
    [
      `mkdir -p ${shellQuote(paths.configRoot)} ${shellQuote(paths.dataRoot)}`,
      `chmod 700 ${shellQuote(paths.root)} ${shellQuote(paths.configRoot)} ${shellQuote(paths.dataRoot)}`,
    ].join(" && "),
  );
  if (agent.adapter === "opencode") {
    await remoteExec(
      session.client,
      `mkdir -p ${shellQuote(path.posix.dirname(paths.opencodeAuthPath))} && chmod 700 ${shellQuote(path.posix.dirname(paths.opencodeAuthPath))}`,
    );
    let configContent = mergeOpenCodeConfigContent("{}\n", runtimeProvider);
    configContent = setJsoncValue(
      configContent,
      ["permission"],
      ["ask", "allow", "deny"].includes(profile.permissionMode)
        ? profile.permissionMode
        : "allow",
    );
    const authContent = mergeOpenCodeAuthContent("{}\n", providerApiKey);
    await remoteSftpWriteAtomic(
      session.client,
      paths.opencodeConfigPath,
      configContent,
      0o600,
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.opencodeAuthPath,
      authContent,
      0o600,
    );
  } else if (agent.adapter === "codex") {
    await remoteExec(
      session.client,
      `mkdir -p ${shellQuote(paths.codexHome)} && chmod 700 ${shellQuote(paths.codexHome)}`,
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.codexConfigPath,
      managedCodexConfigContent(runtimeProvider, profile, providerRoute),
      0o600,
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.apiKeyPath,
      `${String(providerApiKey)}\n`,
      0o600,
    );
  } else if (agent.adapter === "claude") {
    await remoteExec(
      session.client,
      `mkdir -p ${shellQuote(paths.claudeConfigDir)} && chmod 700 ${shellQuote(paths.claudeConfigDir)}`,
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.claudeSettingsPath,
      managedClaudeSettingsContent(runtimeProvider, profile, providerRoute),
      0o600,
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.apiKeyPath,
      `${String(providerApiKey)}\n`,
      0o600,
    );
  }
  return {
    configured: true,
    managed: true,
    runtimeId,
    model,
    profile,
    providerRoute,
    paths,
    configPath:
      agent.adapter === "opencode"
        ? paths.opencodeConfigPath
        : agent.adapter === "codex"
          ? paths.codexConfigPath
          : paths.claudeSettingsPath,
  };
}

async function configureManagedAgentModel(
  session,
  actor,
  payload,
  onProgress = () => undefined,
) {
  const agent = await agentForSession(session, actor, payload.agentId);
  if (!agent.managed || !["opencode", "codex", "claude"].includes(agent.adapter)) {
    throw new Error("用户部署的 Agent 使用其自身模型配置，EasyWork 不会改写");
  }
  const model = String(payload.model || "").trim();
  if (!model) throw new Error("请选择一个模型");
  const state = await getState(actor);
  const { provider, apiKey: providerApiKey } = await effectiveProviderAccess(
    actor,
    state?.settings,
    String(payload.providerId || ""),
  );
  if (!provider.baseUrl || !providerApiKey) {
    throw new Error("请先在个人资料中配置 API URL 和 API Key");
  }
  onProgress("正在核对模型");
  const descriptors = await listProviderModelDescriptors(
    provider.baseUrl,
    providerApiKey,
  );
  const selected = descriptors.find((item) => item.id === model);
  if (!selected) throw new Error("当前 API 已不再返回所选模型，请重新检测");
  const scope = {
    conversationId: String(payload.conversationId || ""),
    workspaceId: String(payload.workspaceId || ""),
  };
  await updateAgentRuntimeProfile(actor, session, agent.id, scope, {
    providerId: provider.id,
    model,
    contextLimit:
      positiveInteger(selected.contextLimit) || DEFAULT_AGENT_CONTEXT_LIMIT,
    outputLimit:
      positiveInteger(selected.outputLimit) || DEFAULT_AGENT_OUTPUT_LIMIT,
  });
  onProgress(`正在写入 ${agent.name} 隔离配置`);
  const result = await ensureManagedAgentRuntimeConfig(
    session,
    actor,
    agent,
    scope,
    (_stage, label) => onProgress(label),
  );
  if (!result.configured) throw new Error(`${agent.name} 配置未完成`);
  return {
    model,
    configPath: result.configPath,
    agents: await scanRemoteAgents(session, actor, scope),
  };
}

async function configureManagedAgentRuntime(
  session,
  actor,
  payload,
  onProgress = () => undefined,
) {
  const agent = await agentForSession(session, actor, payload.agentId);
  if (!agent.managed || !["opencode", "codex", "claude"].includes(agent.adapter)) {
    throw new Error("用户部署的 Agent 使用自己的原生配置，EasyWork 不会改写");
  }
  const scope = {
    conversationId: String(payload.conversationId || ""),
    workspaceId: String(payload.workspaceId || ""),
  };
  const current =
    (await getAgentRuntimeProfile(actor, session, agent.id, scope)) || {};
  const schema = managedAgentCapabilitySchema(agent, current);
  const field = String(payload.field || "");
  const descriptor = schema[field];
  const value = String(payload.value || "");
  if (!descriptor || !descriptor.options.includes(value)) {
    throw new Error("当前 Agent 不支持这个运行选项");
  }
  const profileField =
    field === "reasoning"
      ? "reasoningEffort"
      : field === "permission"
        ? "permissionMode"
        : "sandboxMode";
  await updateAgentRuntimeProfile(actor, session, agent.id, scope, {
    [profileField]: value,
  });
  onProgress(`正在写入 ${agent.name} 对话隔离配置`);
  const runtime = await ensureManagedAgentRuntimeConfig(
    session,
    actor,
    agent,
    scope,
  );
  if (!runtime.configured) throw new Error(`${agent.name} 隔离配置未完成`);
  return {
    agentId: agent.id,
    field,
    value,
    agents: await scanRemoteAgents(session, actor, scope),
  };
}

async function prepareRemoteAgents(
  session,
  actor,
  scope = {},
) {
  return scanRemoteAgents(session, actor, scope);
}

async function publishRemoteAgentScan(
  session,
  actor,
  send = (payload) => sessionSend(session, payload),
  scope = {},
) {
  send({
    type: "agent.scan.status",
    serverId: session.serverId,
    status: "scanning",
  });
  try {
    const agents = await prepareRemoteAgents(session, actor, scope);
    send({
      type: "agent.list",
      serverId: session.serverId,
      agents,
    });
    send({
      type: "agent.scan.status",
      serverId: session.serverId,
      status: "done",
    });
    return agents;
  } catch (error) {
    send({
      type: "agent.scan.status",
      serverId: session.serverId,
      status: "error",
      label: error instanceof Error ? error.message : "Agent 扫描失败",
    });
    throw error;
  }
}

async function syncManagedAgentsForActor(actor) {
  const worker = await getSshWorker(actor);
  const sessions = [...worker.sessions.values()].filter(
    (session) =>
      session.status === "connected" &&
      session.client &&
      !session.demo &&
      !session.activeRuns?.size,
  );
  const results = await Promise.allSettled(
    sessions.map(async (session) => {
      const agents = await prepareRemoteAgents(session, actor);
      sessionSend(session, {
        type: "agent.list",
        serverId: session.serverId,
        agents,
      });
      return agents;
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function readRemoteAgentPlatform(session) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const result = await remoteExec(
    session.client,
    [
      'EW_OS="$(uname -s | tr "[:upper:]" "[:lower:]")"',
      'EW_ARCH="$(uname -m)"',
      'EW_MUSL=0; if test -f /etc/alpine-release || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then EW_MUSL=1; fi',
      'printf "os=%s\\narch=%s\\nmusl=%s\\n" "$EW_OS" "$EW_ARCH" "$EW_MUSL"',
    ].join("\n"),
  );
  const fields = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.split("="))
      .filter((parts) => parts.length === 2),
  );
  const platform = remoteAgentPlatform(fields);
  if (!platform) {
    throw new Error(
      `Agent 暂不支持该服务器平台：${fields.os || "未知"}/${fields.arch || "未知"}`,
    );
  }
  return platform;
}

async function deployManagedAgentArtifact(
  session,
  actor,
  agentId,
  onProgress = () => undefined,
) {
  if (!session.client || !session.home) throw new Error("SSH 尚未连接");
  const catalog = MANAGED_AGENT_CATALOG[agentId];
  if (!catalog) throw new Error("不支持安装这个 Agent");
  const running = [...(session.activeRuns?.values() || [])].find(
    (run) => String(run.agentId || "") === agentId,
  );
  if (running) throw new Error(`请先结束正在使用 ${catalog.name} 的任务`);
  onProgress("prepare", "正在识别服务器架构");
  const platform = await readRemoteAgentPlatform(session);
  const artifact = await resolveAgentArtifact(agentId, platform);
  const paths = managedAgentPaths(session.home, agentId);
  if (agentId === "opencode") {
    await stopOpenCodeService(session, {
      id: agentId,
      path: paths.binaryPath,
      managed: true,
    });
  }
  const incomingRoot = `${paths.root}/.incoming-${crypto.randomBytes(6).toString("hex")}`;
  const remoteArtifact = `${incomingRoot}/${path.basename(artifact.localPath)}`;
  await remoteExec(
    session.client,
    `umask 077 && mkdir -p ${shellQuote(incomingRoot)} ${shellQuote(`${paths.root}/bin`)} ${shellQuote(paths.configRoot)} ${shellQuote(paths.dataRoot)}`,
  );
  try {
    onProgress("upload", `正在上传 ${catalog.name}`);
    await remoteSftpFastPut(
      session.client,
      artifact.localPath,
      remoteArtifact,
      (percent) => onProgress("upload", `正在上传 ${catalog.name} · ${percent}%`),
    );
    onProgress("verify", `正在校验 ${catalog.name}`);
    const extraction =
      artifact.archive === "tar.gz"
        ? [
            'mkdir -p "$EW_INCOMING/unpacked"',
            'tar -xzf "$EW_ARTIFACT" -C "$EW_INCOMING/unpacked"',
            agentId === "codex"
              ? 'EW_SOURCE="$(find "$EW_INCOMING/unpacked" -type f -name \"codex-*unknown-linux-*\" | head -n 1)"'
              : `EW_SOURCE="$(find "$EW_INCOMING/unpacked" -type f -name ${shellQuote(catalog.binary)} | head -n 1)"`,
          ]
        : ['EW_SOURCE="$EW_ARTIFACT"'];
    const verified = await remoteExec(
      session.client,
      [
        "set -eu",
        `EW_INCOMING=${shellQuote(incomingRoot)}`,
        `EW_ARTIFACT=${shellQuote(remoteArtifact)}`,
        `EW_EXPECTED=${shellQuote(artifact.sha256)}`,
        `EW_DESTINATION=${shellQuote(paths.binaryPath)}`,
        'if command -v sha256sum >/dev/null 2>&1; then EW_ACTUAL="$(sha256sum "$EW_ARTIFACT" | awk \'{print $1}\')"; elif command -v openssl >/dev/null 2>&1; then EW_ACTUAL="$(openssl dgst -sha256 "$EW_ARTIFACT" | awk \'{print $NF}\')"; else echo "服务器缺少 SHA-256 校验工具" >&2; exit 1; fi',
        'test "$EW_ACTUAL" = "$EW_EXPECTED"',
        ...extraction,
        'test -n "$EW_SOURCE" && test -f "$EW_SOURCE"',
        'chmod 755 "$EW_SOURCE"',
        '"$EW_SOURCE" --version >/dev/null',
        'cp "$EW_SOURCE" "$EW_DESTINATION.new"',
        'chmod 755 "$EW_DESTINATION.new"',
        'mv -f "$EW_DESTINATION.new" "$EW_DESTINATION"',
        'find "$(dirname "$EW_DESTINATION")" -maxdepth 1 -type f ! -name "$(basename "$EW_DESTINATION")" -delete',
        '"$EW_DESTINATION" --version | head -n 1',
      ].join("\n"),
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.versionPath,
      `${artifact.version}\n`,
      0o600,
    );
    await remoteSftpWriteAtomic(
      session.client,
      paths.manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          agentId,
          version: artifact.version,
          platform,
          sha256: artifact.sha256,
          deployedAt: isoNow(),
          reportedVersion: verified.stdout.trim(),
        },
        null,
        2,
      )}\n`,
      0o600,
    );
    const installed = {
      id: agentId,
      name: catalog.name,
      adapter: catalog.adapter,
      managed: true,
      path: paths.binaryPath,
    };
    const configured = await ensureManagedAgentRuntimeConfig(
      session,
      actor,
      installed,
      {},
      onProgress,
    );
    return {
      agentId,
      version: artifact.version,
      platform,
      configured: Boolean(configured.configured),
      agents: await scanRemoteAgents(session, actor),
    };
  } finally {
    await remoteExec(session.client, `rm -rf ${shellQuote(incomingRoot)}`, {
      allowFailure: true,
    }).catch(() => undefined);
  }
}

async function installManagedAgent(
  session,
  actor,
  agentId,
  onProgress = () => undefined,
) {
  const agents = await scanRemoteAgents(session, actor);
  const existing = agents.find(
    (agent) => agent.id === agentId && agent.managed && agent.status === "ready",
  );
  if (!existing) {
    return (await deployManagedAgentArtifact(session, actor, agentId, onProgress))
      .agents;
  }
  await ensureManagedAgentRuntimeConfig(session, actor, existing, {}, onProgress);
  return scanRemoteAgents(session, actor);
}

async function uninstallManagedAgent(session, actor, agentId) {
  if (!session.client || !session.home) throw new Error("SSH 尚未连接");
  const catalog = MANAGED_AGENT_CATALOG[agentId];
  if (!catalog) throw new Error("不支持卸载这个 Agent");
  const running = [...(session.activeRuns?.values() || [])].find(
    (run) => String(run.agentId || "") === agentId,
  );
  if (running) throw new Error(`请先结束正在使用 ${catalog.name} 的任务`);
  const paths = managedAgentPaths(session.home, agentId);
  const expectedPrefix = `${session.home}/.easywork/agents/`;
  if (!paths.root.startsWith(expectedPrefix)) {
    throw new Error("Agent 卸载目录无效");
  }
  if (agentId === "opencode") {
    await remoteExec(
      session.client,
      [
        "set +e",
        `EW_AGENT=${shellQuote(paths.binaryPath)}`,
        `EW_SERVICE_ROOT=${shellQuote(`${session.home}/.easywork/services/opencode`)}`,
        'find "$EW_SERVICE_ROOT" -type f -name pid 2>/dev/null | while IFS= read -r EW_PID_FILE; do',
        '  EW_PID=$(cat "$EW_PID_FILE" 2>/dev/null)',
        '  case "$EW_PID" in ""|*[!0-9]*) continue ;; esac',
        '  EW_COMMAND=$(ps -p "$EW_PID" -o args= 2>/dev/null)',
        '  case "$EW_COMMAND" in *"$EW_AGENT"*" serve"*) kill -TERM "$EW_PID" 2>/dev/null || true ;; esac',
        "done",
      ].join("\n"),
      { allowFailure: true },
    );
    session.openCodeServices?.clear();
    session.openCodeServicePromises?.clear();
  }
  await remoteExec(
    session.client,
    `rm -rf -- ${shellQuote(paths.root)}`,
  );
  return scanRemoteAgents(session, actor);
}

async function checkManagedAgentUpdate(session, actor, agentId) {
  const agents = await scanRemoteAgents(session, actor);
  const agent = agents.find(
    (candidate) =>
      candidate.id === agentId && candidate.managed && candidate.status === "ready",
  );
  if (!agent) throw new Error("只能更新由 EasyWork 部署的 Agent");
  const platform = await readRemoteAgentPlatform(session);
  const artifact = await resolveAgentArtifact(agentId, platform);
  const currentVersion = normalizeAgentVersion(agent.version);
  const latestVersion = normalizeAgentVersion(artifact.version);
  if (!currentVersion || !latestVersion) throw new Error("未能识别 Agent 版本");
  const update = {
    agentId,
    currentVersion,
    latestVersion,
    updateAvailable: compareAgentVersions(currentVersion, latestVersion) < 0,
    checkedAt: isoNow(),
  };
  session.agentUpdates ||= new Map();
  session.agentUpdates.set(agentId, update);
  return update;
}

async function applyManagedAgentUpdate(
  session,
  actor,
  agentId,
  onProgress = () => undefined,
) {
  let update = session.agentUpdates?.get(agentId);
  if (!update?.updateAvailable) {
    update = await checkManagedAgentUpdate(session, actor, agentId);
  }
  if (!update.updateAvailable) {
    return { ...update, agents: await scanRemoteAgents(session, actor) };
  }
  onProgress("updating", `正在部署 ${MANAGED_AGENT_CATALOG[agentId].name} ${update.latestVersion}`);
  const deployed = await deployManagedAgentArtifact(
    session,
    actor,
    agentId,
    onProgress,
  );
  if (normalizeAgentVersion(deployed.version) !== update.latestVersion) {
    throw new Error("更新后的 Agent 版本与主机清单不一致");
  }
  const completed = {
    agentId,
    currentVersion: update.currentVersion,
    latestVersion: deployed.version,
    updateAvailable: false,
    checkedAt: isoNow(),
    agents: deployed.agents,
  };
  session.agentUpdates?.set(agentId, completed);
  return completed;
}

function diffPathLabel(filePath) {
  const normalized = String(filePath || "file")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return normalized || "file";
}

function unifiedTextDiff(filePath, before, after, { created = false } = {}) {
  const oldText = String(before ?? "").replace(/\r\n/g, "\n");
  const newText = String(after ?? "").replace(/\r\n/g, "\n");
  if (!oldText && !newText) return "";
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const label = diffPathLabel(filePath);
  return [
    `--- ${created ? "/dev/null" : `a/${label}`}`,
    `+++ b/${label}`,
    `@@ -${oldLines.length ? `1,${oldLines.length}` : "0,0"} +${
      newLines.length ? `1,${newLines.length}` : "0,0"
    } @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ]
    .join("\n")
    .slice(0, 48_000);
}

function openCodeFileDiff(tool, input, part, filePath) {
  const explicit =
    input?.diff ||
    input?.patch ||
    input?.unifiedDiff ||
    input?.unified_diff ||
    part?.diff ||
    part?.patch;
  if (explicit) return String(explicit).slice(0, 48_000);

  const before =
    input?.oldString ??
    input?.old_string ??
    input?.oldText ??
    input?.before;
  const after =
    input?.newString ??
    input?.new_string ??
    input?.newText ??
    input?.after ??
    input?.content;
  if (before !== undefined || after !== undefined) {
    return unifiedTextDiff(filePath, before, after, {
      created: before === undefined && /write|create/.test(String(tool).toLowerCase()),
    });
  }
  return "";
}

function mergeStreamPart(state, mapName, orderName, sourceId, text, fallback) {
  if (!(state[mapName] instanceof Map)) state[mapName] = new Map();
  if (!Array.isArray(state[orderName])) state[orderName] = [];
  const key = sourceId || fallback;
  const previous = String(state[mapName].get(key) || "");
  const incoming = String(text || "");
  const merged = !previous
    ? incoming
    : incoming === previous || incoming.startsWith(previous)
      ? incoming
      : previous.endsWith(incoming)
        ? previous
        : `${previous}${incoming}`;
  if (!state[mapName].has(key)) state[orderName].push(key);
  state[mapName].set(key, merged);
  return { key, text: merged };
}

const EASYWORK_PROGRESS_MARKER = "[[EASYWORK_PROGRESS]]";
const EASYWORK_FINAL_MARKER = "[[EASYWORK_FINAL]]";

function stripTrailingEasyWorkMarkerPrefix(value) {
  const source = String(value || "");
  const withoutTrailingWhitespace = source.trimEnd();
  for (const marker of [EASYWORK_FINAL_MARKER, EASYWORK_PROGRESS_MARKER]) {
    for (let length = marker.length - 1; length >= 2; length -= 1) {
      const prefix = marker.slice(0, length);
      if (withoutTrailingWhitespace.endsWith(prefix)) {
        return withoutTrailingWhitespace.slice(0, -prefix.length);
      }
    }
  }
  return source;
}

function stripEasyWorkProtocolMarkers(value, preferFinal = false) {
  const source = String(value || "");
  const finalIndex = source.lastIndexOf(EASYWORK_FINAL_MARKER);
  if (preferFinal && finalIndex >= 0) {
    return source.slice(finalIndex + EASYWORK_FINAL_MARKER.length).trimStart();
  }
  return stripTrailingEasyWorkMarkerPrefix(
    source
      .replaceAll(EASYWORK_FINAL_MARKER, "")
      .replaceAll(EASYWORK_PROGRESS_MARKER, ""),
  ).trimStart();
}

function classifyOpenCodeText(value) {
  const source = String(value || "");
  const finalIndex = source.lastIndexOf(EASYWORK_FINAL_MARKER);
  if (finalIndex >= 0) {
    const output = source
      .slice(finalIndex + EASYWORK_FINAL_MARKER.length)
      .trimStart();
    return { kind: "message", output, pending: !output.trim() };
  }
  const progressIndex = source.lastIndexOf(EASYWORK_PROGRESS_MARKER);
  if (progressIndex >= 0) {
    const output = source
      .slice(progressIndex + EASYWORK_PROGRESS_MARKER.length)
      .trimStart();
    return { kind: "agent_message", output, pending: !output.trim() };
  }
  let leading = source.trimStart();
  const waitingForMarker = [
    EASYWORK_FINAL_MARKER,
    EASYWORK_PROGRESS_MARKER,
  ].some((marker) => leading.startsWith("[") && marker.startsWith(leading));
  if (waitingForMarker) {
    return { kind: "agent_message", output: "", pending: true };
  }
  leading = stripTrailingEasyWorkMarkerPrefix(leading);
  return {
    kind: "agent_message",
    output: stripEasyWorkProtocolMarkers(leading),
    pending: false,
  };
}

function isNativePlanTool(tool) {
  const normalized = String(tool || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return [
    "todo",
    "todoupdated",
    "todowrite",
    "updatetodo",
    "updatetodos",
    "plan",
    "planupdated",
    "planwrite",
    "writeplan",
    "setplan",
    "updateplan",
  ].includes(normalized);
}

function nativePlanItems(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return null;
  for (const key of ["todos", "plan", "steps", "items", "goals", "tasks"]) {
    const value = input[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const nestedKey of ["todos", "steps", "items", "goals", "tasks"]) {
        if (Array.isArray(value[nestedKey])) return value[nestedKey];
      }
    }
  }
  return null;
}

function normalizeAgentPlanStatus(value) {
  const normalized = String(value || "pending")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["completed", "complete", "done", "success", "succeeded"].includes(normalized)) {
    return "done";
  }
  if (["in_progress", "running", "active", "started", "doing"].includes(normalized)) {
    return "running";
  }
  if (["cancelled", "canceled", "skipped"].includes(normalized)) return "cancelled";
  if (["error", "failed", "blocked"].includes(normalized)) return "error";
  return "pending";
}

function normalizeAgentPlanSteps(tool, input) {
  if (!isNativePlanTool(tool)) return null;
  const items = nativePlanItems(input);
  if (!items) return null;
  return items
    .map((item, index) => {
      const value = item && typeof item === "object" ? item : { content: item };
      const title = String(
        value.content ||
          value.step ||
          value.title ||
          value.text ||
          value.description ||
          value.goal ||
          value.name ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim();
      if (!title) return null;
      return {
        id: String(value.id || value.key || `${safeSegment(title, "step")}_${index}`),
        title,
        status: normalizeAgentPlanStatus(value.status || value.state),
      };
    })
    .filter(Boolean);
}

function agentPlanEventStatus(steps, toolStatus) {
  if (toolStatus === "error" || steps.some((step) => step.status === "error")) {
    return "error";
  }
  if (
    steps.length > 0 &&
    steps.every((step) => ["done", "cancelled"].includes(step.status))
  ) {
    return "done";
  }
  return "running";
}

function trailingFinalMessages(eventOrder) {
  const ordered = Array.isArray(eventOrder) ? eventOrder : [];
  const lastExplicitFinal = ordered.findLast((item) => item.kind === "message");
  if (lastExplicitFinal) return [lastExplicitFinal];

  const trailing = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    if (item.kind !== "agent_message") break;
    trailing.unshift(item);
  }
  if (trailing.length) return trailing;

  const lastAgentMessage = ordered.findLast(
    (item) => item.kind === "agent_message",
  );
  return lastAgentMessage ? [lastAgentMessage] : [];
}

function parseOpenCodeLine(line, state) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (payload.sessionID) state.sessionId = payload.sessionID;
  const type = String(payload.type || payload.part?.type || "");
  const part = payload.part || payload;
  const tokenSource =
    part.tokens ||
    payload.tokens ||
    part.usage ||
    payload.usage ||
    part.info?.tokens ||
    payload.info?.tokens;
  if (tokenSource && typeof tokenSource === "object") {
    const input = Number(
      tokenSource.input ||
        tokenSource.input_tokens ||
        tokenSource.prompt_tokens ||
        0,
    );
    const output = Number(
      tokenSource.output ||
        tokenSource.output_tokens ||
        tokenSource.completion_tokens ||
        0,
    );
    const reasoning = Number(
      tokenSource.reasoning || tokenSource.reasoning_tokens || 0,
    );
    const cacheRead = Number(
      tokenSource.cache?.read ||
        tokenSource.cache_read ||
        tokenSource.cached_tokens ||
        0,
    );
    const total = Number(
      tokenSource.total ||
        tokenSource.total_tokens ||
        input + output + reasoning,
    );
    state.contextUsage = {
      input,
      output,
      reasoning,
      cacheRead,
      total,
      observedAt: isoNow(),
    };
  }
  const sourceId = String(part.id || payload.id || "");
  if (type === "message.updated") {
    const info = part.info || payload.info || {};
    const messageId = String(info.id || info.messageID || "");
    const role = String(info.role || "").toLowerCase();
    if (messageId && role) {
      state.messageRoles ||= new Map();
      state.messageRoles.set(messageId, role);
    }
    return null;
  }
  const messageId = String(part.messageID || part.messageId || "");
  if (messageId && state.messageRoles?.get(messageId) === "user") {
    return null;
  }
  if (type === "tool_use" || type === "tool") {
    const tool = String(part.tool || part.name || "tool");
    const input = part.state?.input || part.input || {};
    const command = String(input.command || "");
    const filePath = String(
      input.filePath || input.file_path || input.path || input.filename || "",
    );
    const output =
      part.state?.output ||
      part.state?.metadata?.output ||
      part.output ||
      part.state?.error ||
      "";
    const statusValue = part.state?.status || part.status;
    const normalizedTool = `${tool} ${command}`.toLowerCase();
    const normalizedToolName = tool.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const status =
      statusValue === "error"
        ? "error"
        : ["completed", "done", "success"].includes(statusValue)
          ? "done"
          : "running";
    const planSteps = normalizeAgentPlanSteps(tool, input);
    if (planSteps) {
      return {
        sourceId: "agent-native-plan",
        kind: "plan",
        title: "执行计划",
        planSteps,
        status: agentPlanEventStatus(planSteps, status),
      };
    }
    if (isNativePlanTool(tool)) return null;
    const fileTool =
      /^(?:write|edit|multiedit|patch|applypatch|replace|createfile|strreplace)$/.test(
        normalizedToolName,
      );
    const kind = fileTool
      ? "file_change"
      : /\b(?:sbatch|srun|salloc|sinfo|squeue|sacct|scontrol|scancel|qsub|qstat|qdel)\b/.test(
            normalizedTool,
          )
        ? "job_status"
        : /artifact|export|download|archive/.test(normalizedTool)
          ? "artifact"
          : "tool_call";
    const title =
      kind === "file_change"
        ? `${status === "done" ? "已修改" : "正在修改"} ${path.basename(filePath || tool)}`
        : kind === "job_status"
          ? command
            ? command.slice(0, 120)
            : `更新作业状态 · ${tool}`
          : command
            ? command.slice(0, 120)
            : `调用 ${tool}`;
    return {
      sourceId,
      kind,
      title,
      detail: `OpenCode · ${tool}`,
      output: String(output || "").slice(0, 12_000),
      diff:
        kind === "file_change"
          ? openCodeFileDiff(tool, input, part, filePath)
          : undefined,
      command: command || undefined,
      path: filePath || undefined,
      status,
    };
  }
  if (/^(?:todo|plan)[._-](?:updated|changed)$/.test(type.toLowerCase())) {
    const planSteps = normalizeAgentPlanSteps(
      type,
      part.input || part.properties || part,
    );
    if (planSteps) {
      return {
        sourceId: "agent-native-plan",
        kind: "plan",
        title: "执行计划",
        planSteps,
        status: agentPlanEventStatus(planSteps, part.status),
      };
    }
  }
  if (type === "session.status") {
    const status = part.status || payload.status || {};
    if (status?.type !== "retry") return null;
    return {
      sourceId: `retry-${status.attempt || 1}`,
      kind: "job_status",
      title: `Agent 正在重试（第 ${status.attempt || 1} 次）`,
      detail: String(status.message || "模型服务暂时不可用").slice(0, 800),
      status: "running",
    };
  }
  if (type === "text") {
    const text = String(part.text || payload.text || "");
    if (!text.trim()) return null;
    const textPart = mergeStreamPart(
      state,
      "textParts",
      "textOrder",
      sourceId,
      text,
      "message",
    );
    const classified = classifyOpenCodeText(textPart.text);
    if (classified.pending || !classified.output.trim()) return null;
    state.latestText = classified.output;
    if (classified.kind === "message") state.finalText = classified.output;
    return {
      sourceId: textPart.key,
      kind: classified.kind,
      title:
        classified.kind === "message" ? "Agent 最终回复" : "Agent思考中",
      output: classified.output.slice(-16_000),
      status: "running",
    };
  }
  if (type === "reasoning") {
    const reasoningText = String(part.text || payload.text || "");
    if (!reasoningText.trim()) return null;
    const reasoningPart = mergeStreamPart(
      state,
      "reasoningParts",
      "reasoningOrder",
      sourceId,
      reasoningText,
      "agent_reasoning",
    );
    state.reasoningText = reasoningPart.text;
    return {
      sourceId: reasoningPart.key,
      kind: "agent_reasoning",
      title: "Agent思考中",
      output: reasoningPart.text.slice(-16_000),
      status: "running",
    };
  }
  if (type === "step_start") {
    return null;
  }
  if (/permission|approval/.test(type)) {
    const approvalId = String(
      part.id || part.requestID || part.requestId || sourceId,
    );
    const permission = String(
      part.permission || part.title || part.name || "受限操作",
    );
    const patterns = Array.isArray(part.patterns)
      ? part.patterns.map(String).filter(Boolean)
      : [];
    const resolved = /replied|resolved|approved|denied|rejected/.test(type);
    const rejected = /denied|rejected/.test(type) || part.reply === "reject";
    return {
      sourceId: approvalId || sourceId,
      kind: "approval_request",
      title: resolved
        ? rejected
          ? "操作已拒绝"
          : "操作已允许"
        : `Agent 请求权限 · ${permission}`,
      detail:
        patterns.join("\n") ||
        String(part.description || part.message || "").slice(0, 800),
      approvalId,
      approvalType: "permission",
      status: resolved ? (rejected ? "error" : "done") : "pending",
    };
  }
  if (/question/.test(type)) {
    const approvalId = String(
      part.id || part.requestID || part.requestId || sourceId,
    );
    const questions = Array.isArray(part.questions) ? part.questions : [];
    return {
      sourceId: approvalId || sourceId,
      kind: "approval_request",
      title: String(
        questions[0]?.header || questions[0]?.question || "Agent 等待用户输入",
      ),
      detail: questions
        .map((question) => String(question?.question || "").trim())
        .filter(Boolean)
        .join("\n"),
      output: questions.length ? JSON.stringify(questions, null, 2) : undefined,
      approvalId,
      approvalType: "question",
      status: /replied/.test(type)
        ? "done"
        : /rejected/.test(type)
          ? "error"
          : "pending",
    };
  }
  if (/file_change|file_update|session\.diff/.test(type)) {
    const filePath = String(part.path || part.filePath || "");
    const changes = Array.isArray(part.diff)
      ? part.diff
      : Array.isArray(part.changes)
        ? part.changes
        : [];
    const combinedDiff = changes
      .map((change) =>
        String(change?.diff || change?.patch || change?.content || ""),
      )
      .filter(Boolean)
      .join("\n")
      .slice(0, 48_000);
    if (!filePath && !changes.length && !combinedDiff) return null;
    return {
      sourceId,
      kind: "file_change",
      title: `${
        part.status === "completed" || type === "session.diff"
          ? "已修改"
          : "正在修改"
      } ${path.basename(filePath || (changes.length === 1 ? changes[0]?.path : "文件"))}`,
      detail: String(part.summary || "").slice(0, 500),
      path:
        filePath ||
        (changes.length === 1 ? String(changes[0]?.path || "") : undefined),
      diff:
        combinedDiff || openCodeFileDiff("file_change", part, part, filePath),
      output:
        changes.length > 1
          ? changes
              .map((change) => String(change?.path || ""))
              .filter(Boolean)
              .join("\n")
          : undefined,
      status:
        part.status === "completed" || type === "session.diff"
          ? "done"
          : "running",
    };
  }
  if (/artifact/.test(type)) {
    return {
      sourceId,
      kind: "artifact",
      title: String(part.title || part.name || "生成结果文件"),
      detail: String(part.description || "").slice(0, 500),
      path: String(part.path || part.url || "") || undefined,
      status: part.status === "error" ? "error" : "done",
    };
  }
  if (type === "error" || type === "session.error") {
    const errorPayload = payload.error;
    const errorMessage =
      errorPayload?.data?.message ||
      errorPayload?.message ||
      (typeof errorPayload === "string" ? errorPayload : "") ||
      payload.message ||
      "未知错误";
    state.lastError = String(errorMessage);
    return {
      sourceId,
      kind: "error",
      title: "Agent 执行错误",
      output: state.lastError,
      status: "error",
    };
  }
  return null;
}

function canonicalAgentEventStatus(value, fallback = "done") {
  const status = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  if (["in_progress", "running", "started", "pending"].includes(status)) {
    return "running";
  }
  if (["failed", "error", "denied"].includes(status)) return "error";
  if (["cancelled", "canceled", "aborted", "interrupted"].includes(status)) {
    return "cancelled";
  }
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) {
    return "done";
  }
  return fallback;
}

function codexPlanSteps(item) {
  const entries = Array.isArray(item?.items)
    ? item.items
    : Array.isArray(item?.plan)
      ? item.plan
      : Array.isArray(item?.steps)
        ? item.steps
        : [];
  return entries
    .map((step, index) => ({
      id: String(step?.id || `codex-plan-${index}`),
      title: String(step?.text || step?.title || step?.step || "").trim(),
      status: canonicalAgentEventStatus(step?.status, "pending"),
    }))
    .filter((step) => step.title);
}

function codexApplyPatchChanges(item, sourceId, status) {
  const command = String(item?.command || item?.command_line || "");
  const output = String(item?.aggregated_output || item?.output || "");
  if (
    status !== "done" ||
    !/(?:^|[\s;&|])apply_patch(?:\s|$)/m.test(command) ||
    !/Success\. Updated the following files:/i.test(output)
  ) {
    return [];
  }

  const patchStart = command.indexOf("*** Begin Patch");
  const patchEnd = command.indexOf("*** End Patch", patchStart);
  if (patchStart < 0 || patchEnd < 0) return [];
  const patch = command.slice(patchStart, patchEnd + "*** End Patch".length);
  const headers = [
    ...patch.matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/gm),
  ];
  return headers.map((match, index) => {
    const nextOffset = headers[index + 1]?.index ?? patch.length;
    const diff = patch.slice(match.index, nextOffset).trimEnd();
    const path = String(match[2] || "").trim();
    return {
      sourceId: `${sourceId}-patch-${index}`,
      kind: "file_change",
      title: path.split(/[\\/]/).at(-1) || "文件",
      detail: `Codex · ${String(match[1] || "edit").toLowerCase()}`,
      path,
      diff,
      status,
    };
  });
}

function parseCodexLine(line, state) {
  let payload;
  try {
    payload = JSON.parse(String(line || ""));
  } catch {
    return [];
  }
  if (payload.id === "easywork-thread" && payload.result?.thread?.id) {
    state.sessionId = String(payload.result.thread.id);
    return [];
  }
  if (payload.id && payload.error) {
    const message = String(
      payload.error?.message || payload.error?.data?.message || "Codex 控制请求失败",
    );
    state.lastError = message;
    return [
      {
        sourceId: String(payload.id),
        kind: "error",
        title: "Codex 实时控制失败",
        output: message,
        status: "error",
      },
    ];
  }
  const appServerMethod = String(payload.method || "");
  if (appServerMethod) {
    const params = payload.params || {};
    if (appServerMethod === "thread/started") {
      state.sessionId = String(params.thread?.id || params.threadId || "");
      return [];
    }
    if (appServerMethod === "turn/started") {
      state.sessionId = String(params.threadId || state.sessionId || "");
      state.activeTurnId = String(params.turn?.id || params.turnId || "");
      return [];
    }
    if (appServerMethod === "turn/completed") {
      const turn = params.turn || {};
      state.activeTurnId = String(turn.id || params.turnId || state.activeTurnId || "");
      if (canonicalAgentEventStatus(turn.status) === "error") {
        const message = String(turn.error?.message || "Codex 执行失败");
        state.lastError = message;
        return [
          {
            sourceId: `codex-turn-${state.activeTurnId || state.eventIndex++}`,
            kind: "error",
            title: "Codex 执行错误",
            output: message,
            status: "error",
          },
        ];
      }
      return [];
    }
    if (appServerMethod === "thread/tokenUsage/updated") {
      const usage = params.tokenUsage?.total || params.tokenUsage || {};
      const input = Number(
        usage.inputTokens || usage.input_tokens || usage.promptTokens || 0,
      );
      const output = Number(
        usage.outputTokens || usage.output_tokens || usage.completionTokens || 0,
      );
      const cachedInput = Number(
        usage.cachedInputTokens || usage.cached_input_tokens || 0,
      );
      state.contextUsage = {
        input,
        cachedInput,
        output,
        reasoning: Number(
          usage.reasoningOutputTokens || usage.reasoning_output_tokens || 0,
        ),
        total: Number(usage.totalTokens || usage.total_tokens || input + output),
        observedAt: isoNow(),
      };
      return [];
    }
    if (appServerMethod === "turn/plan/updated") {
      const planSteps = (params.plan || [])
        .map((step, index) => ({
          id: String(step.id || `codex-plan-${index}`),
          title: String(step.step || step.title || "").trim(),
          status: canonicalAgentEventStatus(step.status, "pending"),
        }))
        .filter((step) => step.title);
      if (!planSteps.length) return [];
      return [
        {
          sourceId: "agent-native-plan",
          kind: "plan",
          title: "执行计划",
          status: agentPlanEventStatus(planSteps, "running"),
          planSteps,
        },
      ];
    }
    if (appServerMethod === "item/agentMessage/delta") {
      const message = mergeStreamPart(
        state,
        "codexMessageParts",
        "codexMessageOrder",
        String(params.itemId || "codex-agent-message"),
        String(params.delta || ""),
        "codex-agent-message",
      );
      const classified = classifyOpenCodeText(message.text);
      if (classified.pending || !classified.output.trim()) return [];
      state.latestText = classified.output;
      if (classified.kind === "message") state.finalText = classified.output;
      return [
        {
          sourceId: message.key,
          kind: classified.kind,
          title:
            classified.kind === "message" ? "Agent 最终回复" : "Agent 输出",
          output: classified.output,
          status: "running",
        },
      ];
    }
    if (
      appServerMethod === "item/reasoning/summaryTextDelta" ||
      appServerMethod === "item/reasoning/textDelta"
    ) {
      const reasoning = mergeStreamPart(
        state,
        "codexReasoningParts",
        "codexReasoningOrder",
        String(params.itemId || "codex-reasoning"),
        String(params.delta || ""),
        "codex-reasoning",
      );
      if (!reasoning.text.trim()) return [];
      return [
        {
          sourceId: reasoning.key,
          kind: "agent_reasoning",
          title: "Agent",
          output: reasoning.text,
          status: "running",
        },
      ];
    }
    if (
      appServerMethod === "item/started" ||
      appServerMethod === "item/completed"
    ) {
      state.codexItems ||= new Map();
      const item = params.item || {};
      if (item.id) state.codexItems.set(String(item.id), item);
      payload = {
        type:
          appServerMethod === "item/started" ? "item.started" : "item.completed",
        item,
      };
    } else if (
      appServerMethod === "item/commandExecution/outputDelta" ||
      appServerMethod === "item/fileChange/outputDelta"
    ) {
      state.codexItems ||= new Map();
      const itemId = String(params.itemId || "");
      const previous = state.codexItems.get(itemId);
      if (!previous) return [];
      const item = {
        ...previous,
        ...(appServerMethod === "item/commandExecution/outputDelta"
          ? {
              aggregatedOutput: `${previous.aggregatedOutput || previous.aggregated_output || ""}${String(params.delta || "")}`,
            }
          : {
              diff: `${previous.diff || previous.patch || ""}${String(params.delta || "")}`,
            }),
      };
      state.codexItems.set(itemId, item);
      payload = { type: "item.started", item };
    } else if (appServerMethod === "error") {
      payload = { type: "error", error: params.error || params };
    } else {
      return [];
    }
  }
  const type = String(payload.type || "");
  if (type === "thread.started") {
    state.sessionId = String(payload.thread_id || payload.thread?.id || "");
    return [];
  }
  if (type === "turn.completed") {
    const usage = payload.usage || {};
    state.contextUsage = {
      input: Number(usage.input_tokens || 0),
      cachedInput: Number(usage.cached_input_tokens || 0),
      output: Number(usage.output_tokens || 0),
      reasoning: Number(usage.reasoning_output_tokens || 0),
      total:
        Number(usage.input_tokens || 0) +
        Number(usage.output_tokens || 0),
      observedAt: isoNow(),
    };
    return [];
  }
  if (type === "turn.failed" || type === "error") {
    const message = String(
      payload.error?.message || payload.message || payload.error || "Codex 执行失败",
    );
    state.lastError = message;
    return [
      {
        sourceId: String(payload.id || `codex-error-${state.eventIndex++}`),
        kind: "error",
        title: "Codex 执行错误",
        output: message,
        status: "error",
      },
    ];
  }
  if (!type.startsWith("item.")) return [];
  const item = payload.item || {};
  const itemType = String(item.type || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  // app-server echoes client input as a userMessage item. The user message is
  // already rendered and persisted by EasyWork, so exposing this protocol
  // acknowledgement as an Agent activity duplicates the prompt and leaks the
  // transport envelope into the conversation.
  if (["user_message", "input_message"].includes(itemType)) return [];
  const sourceId = String(item.id || `codex-${itemType}-${state.eventIndex++}`);
  const status = canonicalAgentEventStatus(
    item.status,
    type === "item.started" ? "running" : "done",
  );
  if (itemType === "agent_message") {
    const text = stripEasyWorkProtocolMarkers(
      String(item.text || item.content || ""),
      true,
    );
    if (!text.trim()) return [];
    state.latestText = text;
    if (status === "done") state.finalText = text;
    return [{ sourceId, kind: "message", title: "Agent 最终回复", output: text, status }];
  }
  if (itemType === "reasoning") {
    const text = stripEasyWorkProtocolMarkers(
      String(item.text || item.summary || item.content || ""),
    );
    if (!text.trim()) return [];
    return [{ sourceId, kind: "agent_reasoning", title: "Agent", output: text, status }];
  }
  if (itemType === "command_execution") {
    const fileChanges = codexApplyPatchChanges(item, sourceId, status);
    if (fileChanges.length) return fileChanges;
    return [
      {
        sourceId,
        kind: "tool_call",
        title: status === "running" ? "正在运行命令" : "运行了命令",
        detail: "Codex · shell",
        command: String(item.command || item.command_line || ""),
        output: String(
          item.aggregatedOutput || item.aggregated_output || item.output || "",
        ),
        status,
      },
    ];
  }
  if (itemType === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    if (!changes.length) {
      return [
        {
          sourceId,
          kind: "file_change",
          title: "编辑文件",
          path: String(item.path || ""),
          diff: String(item.diff || item.patch || ""),
          status,
        },
      ];
    }
    return changes.map((change, index) => ({
      sourceId: `${sourceId}-${index}`,
      kind: "file_change",
      title: String(change.path || "文件").split("/").at(-1) || "文件",
      detail: `Codex · ${String(change.kind || "edit")}`,
      path: String(change.path || ""),
      diff: String(change.diff || change.patch || ""),
      status,
    }));
  }
  if (
    ["plan", "plan_update", "update_plan", "todo_list", "todo_update"].includes(
      itemType,
    )
  ) {
    const planSteps = codexPlanSteps(item);
    return [
      {
        sourceId,
        kind: "plan",
        title: "执行计划",
        status,
        planSteps,
      },
    ];
  }
  if (itemType === "mcp_tool_call") {
    return [
      {
        sourceId,
        kind: "tool_call",
        title: String(item.tool || item.name || "MCP 工具调用"),
        detail: String(item.server || "Codex · MCP"),
        command: String(item.tool || item.name || ""),
        output: item.result
          ? typeof item.result === "string"
            ? item.result
            : JSON.stringify(item.result, null, 2)
          : item.error
            ? String(item.error)
            : "",
        status: item.error ? "error" : status,
      },
    ];
  }
  if (itemType === "web_search") {
    return [
      {
        sourceId,
        kind: "tool_call",
        title: "网页搜索",
        detail: "Codex · web_search",
        command: String(item.query || ""),
        output: String(item.result || ""),
        status,
      },
    ];
  }
  return [
    {
      sourceId,
      kind: "job_status",
      title: String(itemType || "Codex 事件").replaceAll("_", " "),
      output: JSON.stringify(item, null, 2).slice(0, 16_000),
      status,
    },
  ];
}

function parsePartialJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function claudeTaskPlanEvent(block, state) {
  if (!state) return null;
  state.claudeTasks ||= new Map();
  state.claudeTaskOrder ||= 0;
  const input = block?.input && typeof block.input === "object" ? block.input : {};
  const name = String(block?.name || block?.tool_name || "").toLowerCase();
  if (name === "taskcreate") {
    const pendingId = `pending:${String(block?.id || "task")}`;
    const taskId = String(input.taskId || input.id || pendingId);
    const previous = state.claudeTasks.get(taskId) || state.claudeTasks.get(pendingId);
    const title = String(
      input.subject || input.activeForm || input.description || previous?.title || "",
    ).trim();
    if (title) {
      if (taskId !== pendingId) state.claudeTasks.delete(pendingId);
      state.claudeTasks.set(taskId, {
        id: taskId,
        title,
        status: canonicalAgentEventStatus(input.status, previous?.status || "pending"),
        order: previous?.order ?? state.claudeTaskOrder++,
      });
    }
  } else if (name === "taskupdate") {
    const taskId = String(input.taskId || input.id || "");
    if (taskId) {
      const previous = state.claudeTasks.get(taskId) || {
        id: taskId,
        title: String(input.subject || input.activeForm || `任务 ${taskId}`),
        order: state.claudeTaskOrder++,
      };
      state.claudeTasks.set(taskId, {
        ...previous,
        title: String(input.subject || input.activeForm || previous.title),
        status: canonicalAgentEventStatus(input.status, previous.status || "pending"),
      });
    }
  } else if (["tasklist", "taskget"].includes(name)) {
    const tasks = Array.isArray(input.tasks)
      ? input.tasks
      : input.task && typeof input.task === "object"
        ? [input.task]
        : [];
    for (const task of tasks) {
      const taskId = String(task.id || task.taskId || "");
      const title = String(task.subject || task.title || task.activeForm || "").trim();
      if (!taskId || !title) continue;
      const previous = state.claudeTasks.get(taskId);
      state.claudeTasks.set(taskId, {
        id: taskId,
        title,
        status: canonicalAgentEventStatus(task.status, previous?.status || "pending"),
        order: previous?.order ?? state.claudeTaskOrder++,
      });
    }
  }
  const planSteps = [...state.claudeTasks.values()]
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
    .map(({ id, title, status: taskStatus }) => ({ id, title, status: taskStatus }));
  if (!planSteps.length) return null;
  return {
    sourceId: "agent-native-plan",
    kind: "plan",
    title: "执行计划",
    status: planSteps.every((step) => step.status === "done") ? "done" : "running",
    planSteps,
  };
}

function claudeToolEvent(block, status = "running", output = "", state = null) {
  const name = String(block?.name || block?.tool_name || "工具调用");
  const input = block?.input && typeof block.input === "object" ? block.input : {};
  const lowerName = name.toLowerCase();
  const filePath = String(input.file_path || input.path || input.filename || "");
  if (["write", "edit", "multiedit", "notebookedit"].includes(lowerName)) {
    return {
      kind: "file_change",
      title: filePath.split("/").at(-1) || name,
      detail: `Claude Code · ${name}`,
      path: filePath,
      diff: openCodeFileDiff(lowerName, input, {}, filePath),
      output,
      status,
    };
  }
  if (lowerName === "todowrite") {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    const planSteps = todos.map((todo, index) => ({
      id: String(todo.id || `claude-plan-${index}`),
      title: String(todo.content || todo.title || "").trim(),
      status: canonicalAgentEventStatus(todo.status, "pending"),
    })).filter((todo) => todo.title);
    if (!planSteps.length) return null;
    return {
      sourceId: "agent-native-plan",
      kind: "plan",
      title: "执行计划",
      status,
      planSteps,
    };
  }
  if (["taskcreate", "taskupdate", "tasklist", "taskget"].includes(lowerName)) {
    return claudeTaskPlanEvent(block, state);
  }
  const command = String(
    input.command || input.query || input.pattern || input.prompt || name,
  );
  return {
    kind: "tool_call",
    title: lowerName === "bash" ? (status === "running" ? "正在运行命令" : "运行了命令") : name,
    detail: `Claude Code · ${name}`,
    command,
    output,
    status,
  };
}

function parseClaudeCodeLine(line, state) {
  let payload;
  try {
    payload = JSON.parse(String(line || ""));
  } catch {
    return [];
  }
  state.blocks ||= new Map();
  state.tools ||= new Map();
  const sessionId = String(payload.session_id || payload.sessionId || "");
  if (sessionId) state.sessionId = sessionId;
  if (payload.type === "system") {
    if (payload.subtype === "api_retry") {
      return [
        {
          sourceId: String(payload.uuid || `claude-retry-${payload.attempt || 1}`),
          kind: "job_status",
          title: "模型请求重试",
          detail: `${payload.attempt || 1} / ${payload.max_retries || "?"}`,
          output: payload.retry_delay_ms
            ? `${Math.round(Number(payload.retry_delay_ms) / 1000)} 秒后重试`
            : "",
          status: "running",
        },
      ];
    }
    if (payload.subtype === "compact_boundary") {
      return [
        {
          sourceId: String(payload.uuid || "claude-compact-boundary"),
          kind: "job_status",
          title: "Agent 上下文已压缩",
          detail: "Claude Code · compact",
          status: "done",
        },
      ];
    }
    if (payload.subtype === "task_notification") {
      return [
        {
          sourceId: String(payload.tool_use_id || payload.task_id || payload.uuid),
          kind: payload.output_file ? "artifact" : "job_status",
          title: String(payload.summary || "后台任务状态更新"),
          detail: `Claude Code · ${payload.status || "task"}`,
          path: String(payload.output_file || "") || undefined,
          status: canonicalAgentEventStatus(payload.status, "done"),
        },
      ];
    }
    return [];
  }
  if (payload.type === "stream_event") {
    const event = payload.event || {};
    const index = Number(event.index ?? event.content_block?.index ?? 0);
    if (event.type === "content_block_start") {
      const block = {
        ...(event.content_block || {}),
        inputText: "",
        text: String(event.content_block?.text || ""),
      };
      state.blocks.set(index, block);
      const sourceId = String(block.id || `claude-block-${index}`);
      if (block.type === "tool_use") {
        state.tools.set(sourceId, block);
        const toolEvent = claudeToolEvent(block, "running", "", state);
        return toolEvent ? [{ sourceId, ...toolEvent }] : [];
      }
      if (block.type === "thinking" && block.text) {
        return [{ sourceId, kind: "agent_reasoning", title: "Agent", output: block.text, status: "running" }];
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const block = state.blocks.get(index) || { id: `claude-block-${index}` };
      const delta = event.delta || {};
      const sourceId = String(block.id || `claude-block-${index}`);
      if (delta.type === "thinking_delta") {
        block.text = `${block.text || ""}${String(delta.thinking || "")}`;
        state.blocks.set(index, block);
        state.latestThinking = block.text;
        return [{ sourceId, kind: "agent_reasoning", title: "Agent", output: block.text, status: "running" }];
      }
      if (delta.type === "text_delta") {
        block.text = `${block.text || ""}${String(delta.text || "")}`;
        state.blocks.set(index, block);
        const classified = classifyOpenCodeText(block.text);
        state.latestText = classified.output;
        if (!classified.output.trim()) return [];
        if (classified.kind === "message") state.finalSourceId = sourceId;
        return [{
          sourceId,
          kind: classified.kind,
          title: classified.kind === "message" ? "Agent 最终回复" : "Agent 输出",
          output: classified.output,
          status: "running",
        }];
      }
      if (delta.type === "input_json_delta") {
        block.inputText = `${block.inputText || ""}${String(delta.partial_json || "")}`;
        block.input = parsePartialJson(block.inputText) || block.input || {};
        state.blocks.set(index, block);
        state.tools.set(sourceId, block);
        const toolEvent = claudeToolEvent(block, "running", "", state);
        return toolEvent ? [{ sourceId, ...toolEvent }] : [];
      }
      return [];
    }
    if (event.type === "content_block_stop") {
      const block = state.blocks.get(index);
      if (!block) return [];
      const sourceId = String(block.id || `claude-block-${index}`);
      if (block.type === "tool_use") {
        const toolEvent = claudeToolEvent(block, "done", "", state);
        return toolEvent ? [{ sourceId, ...toolEvent }] : [];
      }
      if (block.type === "thinking") {
        state.latestThinking = block.text || "";
        return [{ sourceId, kind: "agent_reasoning", title: "Agent", output: block.text || "", status: "done" }];
      }
      if (block.type === "text") {
        const classified = classifyOpenCodeText(block.text || "");
        if (!classified.output.trim()) return [];
        if (classified.kind === "message") state.finalSourceId = sourceId;
        return [{
          sourceId,
          kind: classified.kind,
          title: classified.kind === "message" ? "Agent 最终回复" : "Agent 输出",
          output: classified.output,
          status: "done",
        }];
      }
      return [];
    }
    return [];
  }
  if (payload.type === "assistant") {
    const content = Array.isArray(payload.message?.content)
      ? payload.message.content
      : [];
    const events = [];
    for (const [index, block] of content.entries()) {
      const sourceId = String(block.id || `claude-assistant-${index}`);
      if (block.type === "thinking" && block.thinking) {
        const thinking = String(block.thinking);
        if (thinking !== state.latestThinking) {
          state.latestThinking = thinking;
          events.push({ sourceId, kind: "agent_reasoning", title: "Agent", output: thinking, status: "done" });
        }
      } else if (block.type === "tool_use") {
        state.tools.set(sourceId, block);
        const toolEvent = claudeToolEvent(block, "running", "", state);
        if (toolEvent) events.push({ sourceId, ...toolEvent });
      } else if (
        block.type === "text" &&
        String(block.text || "").trim()
      ) {
        const classified = classifyOpenCodeText(block.text || "");
        if (
          classified.output.trim() &&
          classified.output !== state.latestText
        ) {
          state.latestText = classified.output;
          if (classified.kind === "message") state.finalSourceId = sourceId;
          events.push({
            sourceId,
            kind: classified.kind,
            title:
              classified.kind === "message"
                ? "Agent 最终回复"
                : "Agent 输出",
            output: state.latestText,
            status: "done",
          });
        }
      }
    }
    return events;
  }
  if (payload.type === "user") {
    const content = Array.isArray(payload.message?.content)
      ? payload.message.content
      : [];
    return content
      .filter((block) => block.type === "tool_result")
      .map((block, index) => {
        const sourceId = String(
          block.tool_use_id || `claude-tool-result-${index}`,
        );
        const output =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content || "", null, 2);
        const tool = state.tools.get(sourceId);
        const nativeTask = payload.tool_use_result?.task;
        if (
          tool &&
          String(tool.name || "").toLowerCase() === "taskcreate" &&
          nativeTask?.id
        ) {
          tool.input = {
            ...(tool.input || {}),
            taskId: String(nativeTask.id),
            subject: String(nativeTask.subject || tool.input?.subject || ""),
          };
        }
        if (tool) {
          const toolEvent = claudeToolEvent(
            tool,
            block.is_error ? "error" : "done",
            output,
            state,
          );
          if (toolEvent) {
            return {
              sourceId,
              ...toolEvent,
            };
          }
        }
        return {
          sourceId,
          kind: "tool_call",
          title: "工具执行结果",
          detail: "Claude Code",
          output,
          status: block.is_error ? "error" : "done",
        };
      });
  }
  if (payload.type === "result") {
    const usage = payload.usage || {};
    state.contextUsage = {
      input: Number(usage.input_tokens || 0),
      cachedInput:
        Number(usage.cache_read_input_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0),
      output: Number(usage.output_tokens || 0),
      total:
        Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0),
      observedAt: isoNow(),
    };
    const permissionEvents = Array.isArray(payload.permission_denials)
      ? payload.permission_denials.map((denial, index) => ({
          sourceId: String(
            denial.tool_use_id || denial.id || `claude-permission-${index}`,
          ),
          kind: "approval_request",
          title: "权限请求未获批准",
          detail: String(denial.tool_name || denial.tool || "Claude Code"),
          output:
            typeof denial.tool_input === "string"
              ? denial.tool_input
              : JSON.stringify(denial.tool_input || denial, null, 2),
          status: "error",
        }))
      : [];
    if (payload.is_error) {
      state.lastError = String(payload.result || payload.error || "Claude Code 执行失败");
      return [
        ...permissionEvents,
        { sourceId: "claude-result", kind: "error", title: "Claude Code 执行错误", output: state.lastError, status: "error" },
      ];
    }
    const finalText = stripEasyWorkProtocolMarkers(
      String(payload.result || "").trim(),
      true,
    );
    if (!finalText) return permissionEvents;
    state.finalText = finalText;
    return [
      ...permissionEvents,
      {
        sourceId: state.finalSourceId || "claude-result",
        kind: "message",
        title: "Agent 最终回复",
        output: finalText,
        status: "done",
      },
    ];
  }
  if (payload.type === "tool_progress") {
    const sourceId = String(payload.tool_use_id || payload.uuid || "claude-tool-progress");
    const tool = state.tools.get(sourceId);
    if (tool) {
      const toolEvent = claudeToolEvent(
        tool,
        "running",
        String(payload.content || payload.summary || ""),
        state,
      );
      if (toolEvent) {
        return [{
          sourceId,
          ...toolEvent,
        }];
      }
    }
    return [
      {
        sourceId,
        kind: "job_status",
        title: String(payload.tool_name || "工具仍在运行"),
        detail: payload.elapsed_time_seconds
          ? `${payload.elapsed_time_seconds} 秒`
          : "Claude Code",
        output: String(payload.content || ""),
        status: "running",
      },
    ];
  }
  if (payload.type === "tool_use_summary") {
    const summary = String(payload.summary || "").trim();
    if (!summary) return [];
    return [
      {
        sourceId: String(payload.uuid || `claude-tool-summary-${state.eventIndex++}`),
        kind: "agent_message",
        title: "Agent 输出",
        output: summary,
        status: "done",
      },
    ];
  }
  if (payload.type === "rate_limit_event") {
    const info = payload.rate_limit_info || {};
    return [
      {
        sourceId: String(payload.uuid || "claude-rate-limit"),
        kind: "job_status",
        title:
          info.status === "rejected" ? "模型限流" : "模型用量提醒",
        detail:
          info.utilization !== undefined
            ? `当前利用率 ${Math.round(Number(info.utilization) * 100)}%`
            : "Claude Code",
        status: info.status === "rejected" ? "error" : "running",
      },
    ];
  }
  return [];
}

function parseNativeAgentLine(adapter, line, state) {
  if (adapter === "codex") return parseCodexLine(line, state);
  if (adapter === "claude") return parseClaudeCodeLine(line, state);
  const event = parseOpenCodeLine(line, state);
  return event ? [event] : [];
}

function nativeAgentCommand({
  agent,
  runtimeConfiguration,
  nativeSession,
  workspace,
  runDirectory,
  openCodeService,
  managedModel,
  prompt,
}) {
  if (agent.adapter === "opencode") {
    const [providerID, ...modelParts] = String(managedModel || "").split("/");
    const modelID = modelParts.join("/");
    const body = {
      parts: [{ type: "text", text: String(prompt || "") }],
      ...(providerID && modelID ? { model: { providerID, modelID } } : {}),
    };
    const promptBodyPath = `${runDirectory}/opencode-prompt.json`;
    const promptUrl = `${openCodeService.baseUrl}/session/${encodeURIComponent(
      nativeSession.sessionId,
    )}/prompt_async?directory=${encodeURIComponent(workspace)}`;
    return [
      `printf '%s' ${shellQuote(JSON.stringify(body))} > ${shellQuote(promptBodyPath)}`,
      [
        "curl --silent --show-error --fail",
        `--config ${shellQuote(openCodeService.curlConfigPath)}`,
        "--request POST",
        "--header 'Content-Type: application/json'",
        `--data-binary @${shellQuote(promptBodyPath)}`,
        shellQuote(promptUrl),
        `2>> ${shellQuote(`${runDirectory}/agent-events.err`)}`,
      ].join(" "),
      "EW_EVENT_WAIT=0",
      'while test ! -s "$EW_EVENT_DONE"; do',
      '  if ! kill -0 "$EW_EVENT_PID" 2>/dev/null; then',
      '    echo "OpenCode event stream ended before the session became idle" >&2',
      "    exit 1",
      "  fi",
      "  EW_EVENT_WAIT=$((EW_EVENT_WAIT + 1))",
      '  if test "$EW_EVENT_WAIT" -ge 86400; then',
      '    echo "OpenCode session did not finish within 24 hours" >&2',
      "    exit 1",
      "  fi",
      "  sleep 1",
      "done",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (agent.adapter === "codex") {
    const profile = runtimeConfiguration.profile || {};
    const inputFifo = `${runDirectory}/input.fifo`;
    const outputFifo = `${runDirectory}/codex-output.fifo`;
    const initializeRequest = JSON.stringify({
      id: "easywork-initialize",
      method: "initialize",
      params: {
        clientInfo: { name: "easywork", title: "EasyWork", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });
    const threadRequest = JSON.stringify({
      id: "easywork-thread",
      method: nativeSession.created ? "thread/start" : "thread/resume",
      params: nativeSession.created
        ? {
            model: runtimeConfiguration.model,
            cwd: workspace,
            sandbox: profile.sandboxMode || "workspace-write",
            approvalPolicy: profile.permissionMode || "never",
          }
        : {
            threadId: nativeSession.sessionId,
            excludeTurns: true,
            model: runtimeConfiguration.model,
            cwd: workspace,
            sandbox: profile.sandboxMode || "workspace-write",
            approvalPolicy: profile.permissionMode || "never",
          },
    });
    const turnRequest = JSON.stringify({
      id: "easywork-turn-start",
      method: "turn/start",
      params: {
        threadId: "__EASYWORK_THREAD_ID__",
        input: [{ type: "text", text: String(prompt || ""), text_elements: [] }],
        cwd: workspace,
        approvalPolicy: profile.permissionMode || "never",
        effort: profile.reasoningEffort || undefined,
      },
    });
    return [
      agent.managed
        ? `export CODEX_HOME=${shellQuote(runtimeConfiguration.paths.codexHome)}`
        : "",
      agent.managed
        ? `export EASYWORK_AGENT_API_KEY="$(cat ${shellQuote(runtimeConfiguration.paths.apiKeyPath)})"`
        : "",
      agent.managed
        ? `export CODEX_API_KEY="$EASYWORK_AGENT_API_KEY"`
        : "",
      agent.managed
        ? `EW_AGENT_TMP=${shellQuote(`${runtimeConfiguration.paths.root}/tmp`)}`
        : "",
      agent.managed ? 'mkdir -p "$EW_AGENT_TMP" && chmod 700 "$EW_AGENT_TMP"' : "",
      agent.managed ? 'export TMPDIR="$EW_AGENT_TMP" TMP="$EW_AGENT_TMP" TEMP="$EW_AGENT_TMP"' : "",
      `cd "$EW_DIR"`,
      `EW_INPUT_FIFO=${shellQuote(inputFifo)}`,
      `EW_OUTPUT_FIFO=${shellQuote(outputFifo)}`,
      'rm -f "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      'mkfifo "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      'chmod 600 "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      `${shellQuote(agent.path)} app-server --listen stdio:// < "$EW_INPUT_FIFO" > "$EW_OUTPUT_FIFO" 2>&2 &`,
      "EW_AGENT_PID=$!",
      'cleanup_agent() { exec 3>&- 2>/dev/null || true; kill "$EW_AGENT_PID" 2>/dev/null || true; rm -f "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"; }',
      "trap cleanup_agent EXIT INT TERM",
      'exec 3> "$EW_INPUT_FIFO"',
      `printf '%s\n' ${shellQuote(initializeRequest)} >&3`,
      "EW_THREAD_ID=''",
      'while IFS= read -r EW_LINE; do',
      "  printf '%s\\n' \"$EW_LINE\"",
      "  if printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"id\"[[:space:]]*:[[:space:]]*\"easywork-initialize\"'; then",
      "      if ! printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"result\"[[:space:]]*:'; then printf '%s\\n' \"$EW_LINE\" >&2; exit 70; fi",
      `      printf '%s\n' ${shellQuote(JSON.stringify({ method: "initialized" }))} >&3`,
      `      printf '%s\n' ${shellQuote(threadRequest)} >&3`,
      "      continue",
      "  fi",
      "  if printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"id\"[[:space:]]*:[[:space:]]*\"easywork-thread\"'; then",
      "      if ! printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"result\"[[:space:]]*:'; then printf '%s\\n' \"$EW_LINE\" >&2; exit 71; fi",
      '      EW_THREAD_ID=$(printf "%s\\n" "$EW_LINE" | sed -n "s/.*\\\"thread\\\":{\\\"id\\\":\\\"\\([^\\\"]*\\)\\\".*/\\1/p")',
      nativeSession.sessionId
        ? `      [ -n "$EW_THREAD_ID" ] || EW_THREAD_ID=${shellQuote(nativeSession.sessionId)}`
        : '      [ -n "$EW_THREAD_ID" ] || { printf "%s\\n" "Codex 未返回 thread id" >&2; exit 72; }',
      `      printf '%s\n' "$EW_THREAD_ID" > ${shellQuote(`${runDirectory}/thread_id`)}`,
      `      printf '%s\n' ${shellQuote(turnRequest)} | sed "s|__EASYWORK_THREAD_ID__|$EW_THREAD_ID|g" >&3`,
      "      continue",
      "  fi",
      "  if printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"method\"[[:space:]]*:[[:space:]]*\"turn/started\"'; then",
      '      EW_TURN_ID=$(printf "%s\\n" "$EW_LINE" | sed -n "s/.*\\\"turn\\\":{\\\"id\\\":\\\"\\([^\\\"]*\\)\\\".*/\\1/p")',
      `      [ -z "$EW_TURN_ID" ] || printf '%s\n' "$EW_TURN_ID" > ${shellQuote(`${runDirectory}/active_turn_id`)}`,
      "      continue",
      "  fi",
      "  if printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"method\"[[:space:]]*:[[:space:]]*\"turn/completed\"'; then break; fi",
      'done < "$EW_OUTPUT_FIFO"',
      'exec 3>&-',
      'wait "$EW_AGENT_PID"',
      "EW_NATIVE_STATUS=$?",
      "trap - EXIT INT TERM",
      'rm -f "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      '(exit "$EW_NATIVE_STATUS")',
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (agent.adapter === "claude") {
    const profile = runtimeConfiguration.profile || {};
    const sessionOption = nativeSession.created
      ? `--session-id ${shellQuote(nativeSession.sessionId)}`
      : `--resume ${shellQuote(nativeSession.sessionId)}`;
    const managedOptions = agent.managed
      ? [
          "--setting-sources user",
          `--model ${shellQuote(runtimeConfiguration.model)}`,
          `--effort ${shellQuote(profile.reasoningEffort || "medium")}`,
          `--permission-mode ${shellQuote(profile.permissionMode || "acceptEdits")}`,
        ].join(" ")
      : "";
    const inputFifo = `${runDirectory}/input.fifo`;
    const outputFifo = `${runDirectory}/claude-output.fifo`;
    const initialMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: String(prompt || "") }],
      },
    });
    return [
      agent.managed
        ? `export CLAUDE_CONFIG_DIR=${shellQuote(runtimeConfiguration.paths.claudeConfigDir)}`
        : "",
      agent.managed
        ? `export ANTHROPIC_AUTH_TOKEN="$(cat ${shellQuote(runtimeConfiguration.paths.apiKeyPath)})"`
        : "",
      agent.managed ? 'export ANTHROPIC_API_KEY="$ANTHROPIC_AUTH_TOKEN"' : "",
      agent.managed
        ? `export CLAUDE_CODE_EFFORT_LEVEL=${shellQuote(profile.reasoningEffort || "medium")}`
        : "",
      agent.managed
        ? `EW_AGENT_TMP=${shellQuote(`${runtimeConfiguration.paths.root}/tmp`)}`
        : "",
      agent.managed ? 'mkdir -p "$EW_AGENT_TMP" && chmod 700 "$EW_AGENT_TMP"' : "",
      agent.managed ? 'export TMPDIR="$EW_AGENT_TMP" TMP="$EW_AGENT_TMP" TEMP="$EW_AGENT_TMP"' : "",
      `cd "$EW_DIR"`,
      `EW_INPUT_FIFO=${shellQuote(inputFifo)}`,
      `EW_OUTPUT_FIFO=${shellQuote(outputFifo)}`,
      'rm -f "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      'mkfifo "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      'chmod 600 "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      [
        shellQuote(agent.path),
        "-p",
        "--output-format stream-json",
        "--input-format stream-json",
        "--verbose",
        "--include-partial-messages",
        "--forward-subagent-text",
        managedOptions,
        sessionOption,
        '< "$EW_INPUT_FIFO" > "$EW_OUTPUT_FIFO"',
        "&",
      ]
        .filter(Boolean)
        .join(" "),
      "EW_AGENT_PID=$!",
      'cleanup_agent() { exec 3>&- 2>/dev/null || true; kill "$EW_AGENT_PID" 2>/dev/null || true; rm -f "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"; }',
      "trap cleanup_agent EXIT INT TERM",
      'exec 3> "$EW_INPUT_FIFO"',
      `printf '%s\n' ${shellQuote(initialMessage)} >&3`,
      'while IFS= read -r EW_LINE; do',
      "  printf '%s\\n' \"$EW_LINE\"",
      "  if printf '%s\\n' \"$EW_LINE\" | grep -Eq '\"type\"[[:space:]]*:[[:space:]]*\"result\"'; then break; fi",
      'done < "$EW_OUTPUT_FIFO"',
      'exec 3>&-',
      'wait "$EW_AGENT_PID"',
      "EW_NATIVE_STATUS=$?",
      "trap - EXIT INT TERM",
      'rm -f "$EW_INPUT_FIFO" "$EW_OUTPUT_FIFO"',
      '(exit "$EW_NATIVE_STATUS")',
    ]
      .filter(Boolean)
      .join("\n");
  }
  throw new Error(`不支持的 Agent 适配器：${agent.adapter}`);
}

async function runRemoteWork(socket, session, actor, payload) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const workspaceRecord = await registeredWorkspaceForRun(
    actor,
    session,
    payload.workspaceId,
    payload.conversationId,
  );
  const conversationWorkspaceRecord =
    payload.conversationWorkspaceId &&
    String(payload.conversationWorkspaceId) !== workspaceRecord.id
      ? await registeredWorkspaceForRun(
          actor,
          session,
          payload.conversationWorkspaceId,
          payload.conversationId,
        )
      : workspaceRecord;
  const dynamicWorkspace = Boolean(
    payload.dynamicWorkspace &&
      conversationWorkspaceRecord.kind === "virtual" &&
      conversationWorkspaceRecord.id !== workspaceRecord.id,
  );
  if (dynamicWorkspace && !workspaceRecord.writable) {
    throw new Error("动态写入目标是只读目录，请选择具有写权限的工作区");
  }
  const workspace = workspaceRecord.path;
  const workerActiveRuns = [...session.worker.sessions.values()].flatMap(
    (candidateSession) => [...candidateSession.activeRuns.values()],
  );
  const conflictingRun = workspaceRunConflict(
    workerActiveRuns,
    String(payload.conversationId || ""),
    workspaceRecord,
  );
  if (conflictingRun) {
    const overlaps =
      conflictingRun &&
      workspaceRecordsOverlap(
        { serverId: session.serverId, path: conflictingRun.workspace },
        workspaceRecord,
      );
    const sameVersionDomain = Boolean(
      conflictingRun.versionDomainId &&
        workspaceRecord.versionDomainId &&
        String(conflictingRun.versionDomainId) ===
          String(workspaceRecord.versionDomainId),
    );
    throw new Error(
      overlaps
        ? `工作区与正在运行的目录范围重叠：${conflictingRun.workspaceName || conflictingRun.workspace}`
        : sameVersionDomain
          ? `同一 Git 仓库已有任务运行：${conflictingRun.workspaceName || conflictingRun.workspace}`
        : "这个对话仍有任务在运行",
    );
  }
  touchSshSession(session);
  const workerTask = createWorkerTask(session, {
    ...payload,
    workspaceId: workspaceRecord.id,
    workspaceName: workspaceRecord.name,
    workspace,
    workspaceMode: workspaceRecord.mode,
    workspaceKind: workspaceRecord.kind,
    versionRoot: workspaceRecord.versionRoot,
    versionDomainId: workspaceRecord.versionDomainId,
    conversationWorkspaceId: conversationWorkspaceRecord.id,
    conversationWorkspaceName: conversationWorkspaceRecord.name,
    conversationWorkspace: conversationWorkspaceRecord.path,
    conversationWorkspaceMode: conversationWorkspaceRecord.mode,
    conversationWorkspaceKind: conversationWorkspaceRecord.kind,
    dynamicWorkspace,
  });
  const webAbortController = new AbortController();
  const activeRun = {
    serverId: session.serverId,
    serverIdentity: session.serverIdentity,
    conversationId: workerTask.conversationId,
    runId: workerTask.runId,
    workspaceId: workspaceRecord.id,
    workspaceName: workspaceRecord.name,
    workspace,
    versionRoot: workspaceRecord.versionRoot,
    versionDomainId: workspaceRecord.versionDomainId,
    agentId: workerTask.agentId,
    supportsLiveInput: false,
    abortController: webAbortController,
  };
  session.activeRun = activeRun;
  session.activeRuns.set(workerTask.runId, activeRun);
  await ensureWorkerTaskConversation(actor, workerTask);
  const emit = (event) => publishWorkerEvent(session, event);
  emit({
    type: "agent.event",
    conversationId: workerTask.conversationId,
    runId: workerTask.runId,
    event: {
      id: `${workerTask.runId}_workspace_scope`,
      kind: "workspace_scope",
      title: dynamicWorkspace
        ? "已附加动态工作区"
        : workspaceRecord.kind === "virtual"
          ? "虚拟工作区"
          : "工作区版本范围",
      detail:
        workspaceRecord.mode === "unmanaged"
          ? "未检测到 Git，本轮文件修改不可自动重置"
          : "已纳入共享版本域，可创建运行前后检查点",
      path: workspaceRecord.path,
      output: dynamicWorkspace
        ? `本轮使用 ${workspaceRecord.name} 对应的 Agent 会话；任务结束后，对话仍停留在虚拟工作区。`
        : workspaceRecord.kind === "virtual"
          ? "当前没有固定项目目录。虚拟目录适合查询和临时文件；修改真实项目时会先确认动态目标。"
          : "同一目录及其重叠目录共用版本顺序，运行期间不会并发修改。",
      status: "done",
      timestamp: isoNow(),
    },
  });
  const runtimeScope = {
    conversationId: workerTask.conversationId,
    workspaceId: workerTask.workspaceId,
  };
  const availableAgents = await prepareRemoteAgents(
    session,
    actor,
    runtimeScope,
  );
  const selectedAgent = availableAgents.find(
    (agent) => agent.id === String(payload.agentId || "opencode"),
  );
  if (!selectedAgent || selectedAgent.status !== "ready") {
    throw new Error("所选 Agent 当前不可用，请重新扫描或安装");
  }
  if (!["opencode", "codex", "claude"].includes(selectedAgent.adapter)) {
    throw new Error("这个 Agent 没有可用的 EasyWork 运行适配器");
  }
  activeRun.supportsLiveInput = Boolean(
    selectedAgent.capabilities?.liveInput,
  );
  if (!selectedAgent.managed && !selectedAgent.configured) {
    throw new Error("请先打开 Agent 自带配置文件并完成模型配置");
  }
  const state = await getState(actor);
  await ensureTaskWorkspace(session, workerTask, workspace);
  const bindingKey = agentBindingKey({
    serverId: session.serverId || session.host || "unknown-host",
    workspaceId: workerTask.workspaceId,
    agentId: String(payload.agentId || "opencode"),
    conversationId: String(payload.conversationId || ""),
  });
  const bindingDocument = await readAgentBindings(actor);
  const memoryBinding = session.agentSessions.get(bindingKey);
  const storedBinding = bindingDocument.bindings[bindingKey];
  const effectiveBinding =
    (typeof memoryBinding === "object" && memoryBinding) ||
    storedBinding ||
    null;
  const boundSessionId = String(effectiveBinding?.agentSessionId || "");
  let titlePromise;
  if (payload.firstTurn) {
    const fallbackTitle = fallbackConversationTitle(payload.prompt);
    emit({
      type: "conversation.title",
      conversationId: payload.conversationId,
      runId: payload.runId,
      title: fallbackTitle,
    });
    titlePromise = generateConversationTitle(actor, payload.prompt).catch(
      () => fallbackTitle,
    );
  }
  const context = await buildContext({
    actor,
    mode: "work",
    prompt: String(payload.prompt || ""),
    skillIds: Array.isArray(payload.skills) ? payload.skills : [],
    projectId: payload.projectId ? String(payload.projectId) : undefined,
    memoryMode:
      payload.memoryMode === "project-only"
        ? "project-only"
        : "project-and-global",
    conversationId: String(payload.conversationId || ""),
    currentUserMessageId: workerTask.userMessageId,
    workspaceId: workerTask.workspaceId,
    taskId: workerTask.runId,
  });
  workerTask.webContextUsage = context.contextUsage;
  await captureMemory(
    actor,
    workerTask.prompt,
    workerTask.projectId,
    workerTask.memoryMode,
    workerTask.conversationId,
    workerTask.userMessageId,
  );
  const provisionalAgentDelta = agentConversationDelta(
    context.state,
    workerTask.conversationId,
    effectiveBinding,
    {
      currentUserMessageId: workerTask.userMessageId,
      maxMessages: 24,
    },
  );
  const provisionalMemoryDelta = agentMemoryDelta(context, effectiveBinding);
  const handoffModelContext = workHandoffContext(
    context,
    provisionalAgentDelta,
    provisionalMemoryDelta,
  );
  const webReasoningEventId = `${payload.runId}_web_reasoning`;
  let webReasoning = "";
  let reasoningStarted = false;
  let webHandoff = "";
  try {
    const handoffResult = await runWorkHandoffModel(
      actor,
      workerTask.prompt,
      handoffModelContext,
      context.state,
      (delta) => {
        const nextDelta = String(delta || "");
        if (!nextDelta) return;
        reasoningStarted = true;
        webReasoning += nextDelta;
        emit({
          type: "agent.event",
          conversationId: payload.conversationId,
          runId: payload.runId,
          event: {
            id: webReasoningEventId,
            kind: "reasoning",
            title: "网页模型思考",
            output: webReasoning,
            status: "running",
            timestamp: isoNow(),
          },
        });
      },
      webAbortController.signal,
    );
    webHandoff =
      String(handoffResult.content || "").trim() ||
      deterministicWorkHandoff(context);
    const completedReasoning = String(
      handoffResult.reasoning || webReasoning,
    ).trim();
    if (completedReasoning) {
      reasoningStarted = true;
      webReasoning = completedReasoning;
    }
    emit({
      type: "agent.event",
      conversationId: payload.conversationId,
      runId: payload.runId,
      event: {
        id: webReasoningEventId,
        kind: "reasoning",
        title: "网页模型思考",
        output: webReasoning || undefined,
        status: "done",
        timestamp: isoNow(),
      },
    });
  } catch {
    webHandoff = deterministicWorkHandoff(context);
    emit({
      type: "agent.event",
      conversationId: payload.conversationId,
      runId: payload.runId,
      event: {
        id: webReasoningEventId,
        kind: "reasoning",
        title: "网页模型思考",
        output: reasoningStarted ? webReasoning : undefined,
        status: "done",
        timestamp: isoNow(),
      },
    });
  }
  if (webAbortController.signal.aborted) {
    emit({
      type: "agent.event",
      conversationId: workerTask.conversationId,
      runId: workerTask.runId,
      event: {
        id: `${workerTask.runId}_aborted`,
        kind: "job_status",
        title: "任务已停止",
        detail: "网页模型交接已停止，尚未启动远端 Agent。",
        status: "cancelled",
        timestamp: isoNow(),
      },
    });
    emit({
      type: "task.aborted",
      conversationId: workerTask.conversationId,
      runId: workerTask.runId,
      result: "任务已停止；远端 Agent 尚未开始执行。",
    });
    session.activeRuns.delete(workerTask.runId);
    session.activeRun = session.activeRuns.values().next().value || null;
    await persistWorkerTaskConversation(actor, workerTask);
    await persistSshWorker(session.worker);
    return;
  }
  const runtimeConfiguration = await ensureManagedAgentRuntimeConfig(
    session,
    actor,
    selectedAgent,
    runtimeScope,
  );
  if (!runtimeConfiguration.configured) {
    throw new Error(`${selectedAgent.name} 原生模型配置未完成`);
  }
  const { provider: runtimeProvider, apiKey: runtimeProviderApiKey, category } =
    await effectiveProviderAccess(
      actor,
      state?.settings,
      runtimeConfiguration.profile?.providerId || state?.settings?.activeProviderId,
    );
  if (category === "agent") {
    void recordPlatformUsage("agent", {
      inputTokens: estimateContextTokens(workerTask.prompt),
    }).catch(() => undefined);
  }
  const managedModel = managedOpenCodeModel(
    { ...selectedAgent, model: runtimeConfiguration.model },
    { ...runtimeProvider, model: runtimeConfiguration.model },
    Boolean(runtimeProviderApiKey),
  );
  const runtimeAgent = selectedAgent.managed
    ? {
        ...selectedAgent,
        runtimeId: runtimeConfiguration.runtimeId,
        serviceKey: `${selectedAgent.id}:${runtimeConfiguration.runtimeId}`,
        configPath:
          selectedAgent.adapter === "opencode"
            ? runtimeConfiguration.paths.opencodeConfigPath
            : selectedAgent.adapter === "codex"
              ? runtimeConfiguration.paths.codexConfigPath
              : runtimeConfiguration.paths.claudeSettingsPath,
        configRoot: runtimeConfiguration.paths.configRoot,
        dataPath:
          selectedAgent.adapter === "opencode"
            ? runtimeConfiguration.paths.opencodeDataHome
            : selectedAgent.adapter === "codex"
              ? runtimeConfiguration.paths.codexHome
              : runtimeConfiguration.paths.claudeConfigDir,
      }
    : selectedAgent;
  let openCodeService = null;
  let nativeSession;
  if (selectedAgent.adapter === "opencode") {
    openCodeService = await ensureOpenCodeService(session, runtimeAgent);
    nativeSession = await ensureOpenCodeSession(session, openCodeService, {
      sessionId: boundSessionId,
      directory: workspace,
      title: workerTask.title || fallbackConversationTitle(workerTask.prompt),
    });
  } else {
    nativeSession = {
      sessionId:
        boundSessionId ||
        (selectedAgent.adapter === "claude" ? crypto.randomUUID() : ""),
      created: !boundSessionId,
    };
  }
  const reusableBinding = nativeSession.created ? null : effectiveBinding;
  activeRun.agentControl = {
    adapter: selectedAgent.adapter,
    service: openCodeService || undefined,
    sessionId: nativeSession.sessionId,
    directory: workspace,
    runtimeId: runtimeConfiguration.runtimeId,
  };
  workerTask.agentSessionId = nativeSession.sessionId;
  workerTask.agentControl = {
    adapter: selectedAgent.adapter,
    serviceId: openCodeService?.serviceId,
    serviceRoot: openCodeService?.root,
    servicePort: openCodeService?.port,
    sessionId: nativeSession.sessionId,
    directory: workspace,
    runtimeId: runtimeConfiguration.runtimeId,
  };
  scheduleSshWorkerPersist(session.worker, 0);
  const agentDelta = agentConversationDelta(
    context.state,
    workerTask.conversationId,
    reusableBinding,
    {
      currentUserMessageId: workerTask.userMessageId,
      maxMessages: 24,
    },
  );
  const deliveredMemoryRecords = agentMemoryDelta(context, reusableBinding);
  workerTask.deliveredMemoryRecords = deliveredMemoryRecords.map((record) => ({
    id: record.id,
    revision: record.revision,
  }));
  const agentSyncContext = await buildAgentSyncContext(
    context,
    agentDelta,
    deliveredMemoryRecords,
  );
  const workspaceScopePrompt = await renderPromptTemplate(
    "agents/workspace-scope.md",
    {
      SCOPE_MODE: dynamicWorkspace
        ? "虚拟对话的动态真实工作区"
        : workspaceRecord.kind === "virtual"
          ? "虚拟工作区"
          : "固定真实工作区",
      WORKSPACE_PATH: workspace,
      VERSION_STATUS:
        workspaceRecord.mode === "unmanaged"
          ? "未检测到 Git 检查点能力，文件修改会保留但不能由 EasyWork 自动重置"
          : "本目录位于共享版本域中，EasyWork 记录本轮运行前后检查点",
    },
  );
  const agentPrompt = await agentPromptWithNativePlanning(
    agentSyncContext,
    webHandoff,
    workspaceScopePrompt,
    selectedAgent.adapter,
  );

  const parserState = {
    sessionId: boundSessionId,
    finalText: "",
    latestText: "",
    textParts: new Map(),
    textOrder: [],
    reasoningText: "",
    reasoningParts: new Map(),
    reasoningOrder: [],
    lastError: "",
    eventIndex: 0,
    eventOrder: [],
    forwardedEvents: new Map(),
    activeThought: null,
    activeFinal: null,
    contextUsage: null,
    outsideWorkspacePaths: new Set(),
  };
  const forwardOpenCodeEvent = (event) => {
    if (!event) return;
    if (
      activeRun.abortRequested &&
      event.kind === "error" &&
      /\babort(?:ed)?\b/i.test(String(event.output || event.detail || ""))
    ) {
      return;
    }
    if (event.kind === "file_change" && event.path) {
      const reportedPath = String(event.path).trim();
      const absolutePath = reportedPath.startsWith("/") || reportedPath.startsWith("~")
        ? remotePathForSession(session, reportedPath)
        : path.posix.join(workspace, reportedPath);
      if (
        !workspacePathContains(workspace, absolutePath) &&
        !parserState.outsideWorkspacePaths.has(absolutePath)
      ) {
        parserState.outsideWorkspacePaths.add(absolutePath);
        emit({
          type: "agent.event",
          conversationId: payload.conversationId,
          runId: payload.runId,
          event: {
            id: `${payload.runId}_workspace_outside_${crypto
              .createHash("sha256")
              .update(absolutePath)
              .digest("hex")
              .slice(0, 10)}`,
            kind: "workspace_scope",
            title: "检测到版本范围外文件",
            detail: "该路径不属于本轮检查点，自动重置不会覆盖此修改",
            path: absolutePath,
            output: "后续如需继续修改此目录，请将它作为动态工作区重新发起任务。",
            status: "error",
            timestamp: isoNow(),
          },
        });
      }
    }
    const { sourceId, planSteps, ...eventPayload } = event;
    const eventId = sourceId
      ? `${payload.runId}_${safeSegment(event.kind)}_${safeSegment(sourceId)}`
      : `${payload.runId}_event_${parserState.eventIndex++}`;
    if (parserState.activeFinal && parserState.activeFinal.id !== eventId) {
      const retractedFinal = {
        ...parserState.activeFinal.event,
        kind: "agent_message",
        title: "Agent思考中",
        status: "done",
        retractFinal: true,
        timestamp: isoNow(),
      };
      emit({
        type: "agent.event",
        conversationId: payload.conversationId,
        runId: payload.runId,
        event: retractedFinal,
      });
      parserState.forwardedEvents.set(
        parserState.activeFinal.id,
        retractedFinal,
      );
      const orderedFinal = parserState.eventOrder.find(
        (item) => item.id === parserState.activeFinal.id,
      );
      if (orderedFinal) orderedFinal.kind = "agent_message";
      parserState.activeFinal = null;
    }
    if (parserState.activeThought && parserState.activeThought.id !== eventId) {
      emit({
        type: "agent.event",
        conversationId: payload.conversationId,
        runId: payload.runId,
        event: {
          ...parserState.activeThought.event,
          status: "done",
          timestamp: isoNow(),
        },
      });
      parserState.forwardedEvents.set(parserState.activeThought.id, {
        ...parserState.activeThought.event,
        status: "done",
      });
      parserState.activeThought = null;
    }
    if (Array.isArray(planSteps)) {
      emit({
        type: "workflow",
        conversationId: payload.conversationId,
        runId: payload.runId,
        steps: planSteps,
      });
    }
    emit({
      type: "agent.event",
      conversationId: payload.conversationId,
      runId: payload.runId,
      event: {
        id: eventId,
        ...eventPayload,
        timestamp: isoNow(),
      },
    });
    if (!parserState.forwardedEvents.has(eventId)) {
      parserState.eventOrder.push({ id: eventId, kind: event.kind });
    } else {
      const orderedEvent = parserState.eventOrder.find(
        (item) => item.id === eventId,
      );
      if (orderedEvent) orderedEvent.kind = event.kind;
    }
    parserState.forwardedEvents.set(eventId, eventPayload);
    if (["agent_message", "agent_reasoning"].includes(event.kind)) {
      parserState.activeThought = {
        id: eventId,
        event: { id: eventId, ...eventPayload },
      };
    }
    if (event.kind === "message") {
      parserState.activeFinal = {
        id: eventId,
        event: { id: eventId, ...eventPayload },
      };
    }
  };
  let pending = "";
  let ssePending = "";
  let stderrOutput = "";
  const checkpointBefore = await createWorkspaceCheckpoint(
    session,
    actor,
    workerTask,
    "before",
  ).catch((caught) => ({
    status: "unavailable",
    diagnostic:
      caught instanceof Error ? caught.message : "任务前工作区快照失败",
  }));
  workerTask.checkpointBeforeId = checkpointBefore.id || "";
  emit({
    type: "agent.event",
    conversationId: workerTask.conversationId,
    runId: workerTask.runId,
    event: {
      id: `${workerTask.runId}_workspace_scope`,
      kind: "workspace_scope",
      title: dynamicWorkspace
        ? "动态工作区已就绪"
        : workspaceRecord.kind === "virtual"
          ? "虚拟工作区已就绪"
          : "工作区已就绪",
      detail:
        checkpointBefore.status === "available"
          ? "运行前检查点已创建，本轮文件差异可进行安全性校验"
          : "未建立版本检查点，本轮文件修改不可自动重置",
      path: workspaceRecord.path,
      output:
        checkpointBefore.status === "available"
          ? dynamicWorkspace
            ? `正在复用或创建 ${workspaceRecord.name} 对应的 Agent 会话。`
            : "同一版本域中的重叠目录已进入互斥保护。"
          : checkpointBefore.diagnostic || "未检测到可快照的 Git 工作区。",
      status: "done",
      timestamp: isoNow(),
    },
  });
  const remoteRun = await createRemoteRuntimeRun(session, {
    runId: workerTask.runId,
    conversationId: payload.conversationId,
    agentId: selectedAgent.id,
    workspaceId: workerTask.workspaceId,
    workspaceName: workerTask.workspaceName,
    workspaceKind: workerTask.workspaceKind,
    versionDomainId: workerTask.versionDomainId,
    workspace,
    prompt: agentPrompt,
    command: ({ runDirectory }) => {
      const eventPath = `${runDirectory}/agent-events.sse`;
      const eventErrorPath = `${runDirectory}/agent-events.err`;
      const agentCommand = nativeAgentCommand({
        agent: runtimeAgent,
        runtimeConfiguration,
        nativeSession,
        workspace,
        runDirectory,
        openCodeService,
        managedModel,
        prompt: agentPrompt,
      });
      const openCodeEventLines =
        selectedAgent.adapter === "opencode"
          ? [
              "export OPENCODE_SERVER_USERNAME=opencode",
              `export OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(openCodeService.passwordPath)})"`,
              `EW_EVENT_DONE=${shellQuote(`${runDirectory}/agent-events.done`)}`,
              'rm -f "$EW_EVENT_DONE"',
              `: > ${shellQuote(eventPath)}`,
              "(",
              [
                "  curl --no-buffer --silent --show-error",
                `--config ${shellQuote(openCodeService.curlConfigPath)}`,
                "--max-time 0",
                "--header 'Accept: text/event-stream'",
                shellQuote(`${openCodeService.baseUrl}/global/event`),
                `2>> ${shellQuote(eventErrorPath)}`,
                "| while IFS= read -r EW_EVENT_LINE; do",
              ].join(" "),
              `    printf '%s\\n' "$EW_EVENT_LINE" >> ${shellQuote(eventPath)}`,
              "    if printf '%s' \"$EW_EVENT_LINE\" | grep -F 'session.status' >/dev/null 2>&1 &&",
              `       printf '%s' "$EW_EVENT_LINE" | grep -F ${shellQuote(nativeSession.sessionId)} >/dev/null 2>&1 &&`,
              "       printf '%s' \"$EW_EVENT_LINE\" | grep -F '\"idle\"' >/dev/null 2>&1; then",
              '      printf "done\\n" > "$EW_EVENT_DONE"',
              "      break",
              "    fi",
              "  done",
              ") &",
              "EW_EVENT_PID=$!",
              'cleanup_events() { kill "$EW_EVENT_PID" 2>/dev/null || true; wait "$EW_EVENT_PID" 2>/dev/null || true; }',
              "trap cleanup_events EXIT INT TERM",
            ]
          : [`: > ${shellQuote(eventPath)}`, "cleanup_events() { :; }"];
      return [
        "#!/bin/sh",
        "set -eu",
        `EW_DIR=${shellQuote(workspace)}`,
        'test -d "$EW_DIR" || mkdir -p "$EW_DIR"',
        ...openCodeEventLines,
        "set +e",
        agentCommand,
        "EW_AGENT_STATUS=$?",
        "set -e",
        "cleanup_events",
        selectedAgent.adapter === "opencode" ? "trap - EXIT INT TERM" : "",
        'exit "$EW_AGENT_STATUS"',
      ].filter(Boolean).join("\n");
    },
  });
  workerTask.remoteRun = {
    runId: remoteRun.runId,
    runtimeVersion: remoteRun.runtime.releaseId,
    status: remoteRun.status || "starting",
    runDirectory: remoteRun.runDirectory,
    agentSessionId: nativeSession.sessionId,
    serviceId: openCodeService?.serviceId,
    serviceRoot: openCodeService?.root,
    servicePort: openCodeService?.port,
    directory: workspace,
  };
  Object.assign(activeRun, {
    remoteRun,
    abortRequested: false,
    agentControl: {
      adapter: selectedAgent.adapter,
      service: openCodeService || undefined,
      sessionId: nativeSession.sessionId,
      directory: workspace,
      runtimeId: runtimeConfiguration.runtimeId,
    },
  });
  session.activeRun = activeRun;
  session.activeRuns.set(workerTask.runId, activeRun);
  scheduleSshWorkerPersist(session.worker, 0);
  const synchronizeNativeControlState = () => {
    if (parserState.sessionId) {
      activeRun.agentControl.sessionId = parserState.sessionId;
      workerTask.agentSessionId = parserState.sessionId;
      workerTask.agentControl.sessionId = parserState.sessionId;
    }
    if (parserState.activeTurnId) {
      activeRun.agentControl.turnId = parserState.activeTurnId;
      workerTask.agentControl.turnId = parserState.activeTurnId;
    }
  };
  const monitorHandlers = {
    onStdout: (text) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const parsedEvents = parseNativeAgentLine(
          selectedAgent.adapter,
          line,
          parserState,
        );
        synchronizeNativeControlState();
        for (const event of parsedEvents) {
          forwardOpenCodeEvent(event);
        }
      }
    },
    onStderr: (text) => {
      stderrOutput = `${stderrOutput}${text}`.slice(-12_000);
    },
    onAgentEvents: (text) => {
      ssePending += text;
      const lines = ssePending.split(/\r?\n/);
      ssePending = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const livePart = openCodeSseAgentEvent(line.slice(5).trim(), {
          sessionId: nativeSession.sessionId,
          directory: workspace,
        });
        if (!livePart) continue;
        forwardOpenCodeEvent(
          parseOpenCodeLine(JSON.stringify(livePart), parserState),
        );
      }
    },
    onStatus: (snapshot) => {
      workerTask.remoteRun.status = snapshot.status;
      workerTask.remoteRun.pid = snapshot.pid || undefined;
      workerTask.updatedAt = isoNow();
      scheduleSshWorkerPersist(session.worker);
    },
  };
  const monitorPromise = monitorRemoteRuntimeRun(
    session,
    remoteRun,
    monitorHandlers,
  );
  if (selectedAgent.adapter === "opencode") {
    await waitForOpenCodeRunAdmission(
      session,
      activeRun.agentControl,
      remoteRun,
    );
  }
  await flushAppendedInstructions(session, workerTask, activeRun).catch(
    (caught) => {
      emit({
        type: "agent.event",
        conversationId: payload.conversationId,
        runId: payload.runId,
        event: {
          id: `${payload.runId}_append_error`,
          kind: "error",
          title: "追加指令发送失败",
          detail:
            caught instanceof Error ? caught.message : "追加指令发送失败",
          status: "error",
          timestamp: isoNow(),
        },
      });
    },
  );
  const flushPendingNativeOutput = () => {
    if (!pending.trim()) return;
    for (const event of parseNativeAgentLine(
      selectedAgent.adapter,
      pending.trim(),
      parserState,
    )) {
      forwardOpenCodeEvent(event);
    }
    synchronizeNativeControlState();
    pending = "";
  };
  const result = await monitorPromise;
  flushPendingNativeOutput();
  const runWasAborted = Boolean(
    activeRun.abortRequested ||
      workerTask.abortRequested ||
      result.status === "aborted",
  );
  const checkpointAfter = await createWorkspaceCheckpoint(
    session,
    actor,
    workerTask,
    "after",
  ).catch((caught) => ({
    status: "unavailable",
    diagnostic:
      caught instanceof Error ? caught.message : "任务后工作区快照失败",
  }));
  workerTask.checkpointAfterId = checkpointAfter.id || "";
  emit({
    type: "agent.event",
    conversationId: workerTask.conversationId,
    runId: workerTask.runId,
    event: {
      id: `${workerTask.runId}_workspace_scope`,
      kind: "workspace_scope",
      title: dynamicWorkspace
        ? "动态工作区记录完成"
        : workspaceRecord.kind === "virtual"
          ? "虚拟工作区记录完成"
          : "工作区记录完成",
      detail:
        checkpointBefore.status === "available" &&
        checkpointAfter.status === "available"
          ? "运行前后检查点完整"
          : "版本检查点不完整，无法保证自动重置",
      path: workspaceRecord.path,
      output: dynamicWorkspace
        ? "对话仍保持虚拟工作区；再次选择此目录和 Agent 时会复用本次原生会话。"
        : checkpointAfter.diagnostic || undefined,
      status: "done",
      timestamp: isoNow(),
    },
  });
  let persistedBinding = null;
  const resolvedAgentSessionId =
    String(parserState.sessionId || nativeSession.sessionId || "");
  if (resolvedAgentSessionId) {
    const deliveryAcknowledged = result.status === "done" && !runWasAborted;
    const binding = {
      ...(reusableBinding || {}),
      bindingKey,
      conversationId: String(payload.conversationId || ""),
      serverId: session.serverId,
      workspaceId: workerTask.workspaceId,
      workspaceName: workerTask.workspaceName,
      workspace,
      agentId: selectedAgent.id,
      adapter: selectedAgent.adapter,
      model:
        runtimeConfiguration.model ||
        managedModel ||
        selectedAgent.model ||
        undefined,
      contextLimit:
        positiveInteger(runtimeConfiguration.profile?.contextLimit) ||
        positiveInteger(selectedAgent.contextLimit) ||
        undefined,
      agentSessionId: resolvedAgentSessionId,
      agentDataPath:
        runtimeAgent.dataPath || selectedAgent.dataPath || undefined,
      runtimeId: runtimeConfiguration.runtimeId || undefined,
      lastRunId: workerTask.runId,
      syncMode: agentDelta.bootstrap ? "bootstrap" : "turn",
      // The request reached the native session before monitoring began. Keep
      // completion acknowledgement separate from delivery progress so an abort
      // or browser/network interruption can resume without replaying this turn.
      syncCursor: createAgentSyncCursor({
        state: context.state,
        memoryDocument: context.memoryDocument,
        conversationId: workerTask.conversationId,
        lastMessageId: workerTask.assistantMessageId,
        taskId: workerTask.runId,
        checkpointId: workerTask.checkpointAfterId,
        deliveredContent: agentDelta.messages.map(
          (message) => `${message.role}\u0000${message.content}`,
        ),
        deliveredMemoryRecords,
        memoryEnabled: context.state?.settings?.memoryEnabled !== false,
        previous: reusableBinding?.syncCursor,
      }),
      deliveryState: {
        runId: workerTask.runId,
        status: deliveryAcknowledged ? "acknowledged" : "interrupted",
        acknowledgedAt: deliveryAcknowledged ? isoNow() : undefined,
      },
      contextUsage: parserState.contextUsage || undefined,
      updatedAt: isoNow(),
    };
    persistedBinding = binding;
    session.agentSessions.set(bindingKey, binding);
    await updateAgentBinding(actor, bindingKey, () => binding);
    const remoteBindingDirectory = `${session.home}/.easywork/bindings`;
    await remoteExec(
      session.client,
      `mkdir -p ${shellQuote(remoteBindingDirectory)}`,
      { allowFailure: true },
    );
    await remoteSftpWrite(
      session.client,
      `${remoteBindingDirectory}/${crypto
        .createHash("sha256")
        .update(bindingKey)
        .digest("hex")
        .slice(0, 24)}.json`,
      `${JSON.stringify(
        binding,
        null,
        2,
      )}\n`,
    ).catch(() => undefined);
  }
  session.activeRuns.delete(workerTask.runId);
  session.activeRun = session.activeRuns.values().next().value || null;
  if (runWasAborted) {
    if (workerTask.remoteRun) workerTask.remoteRun.status = "aborted";
    emit({
      type: "agent.event",
      conversationId: payload.conversationId,
      runId: payload.runId,
      event: {
        id: `${payload.runId}_aborted`,
        kind: "job_status",
        title: "任务已停止",
        detail: "远端进程组已停止。",
        status: "cancelled",
        timestamp: isoNow(),
      },
    });
    emit({
      type: "task.aborted",
      conversationId: payload.conversationId,
      runId: payload.runId,
      result: "任务已停止。",
    });
    await persistWorkerTaskConversation(actor, workerTask);
    await persistSshWorker(session.worker);
    return;
  }
  if (result.code !== 0) {
    const primaryError =
      parserState.lastError ||
        stderrOutput.trim() ||
        `${selectedAgent.name} 退出码 ${result.code}`;
    const needsLog =
      !parserState.lastError ||
      /unexpected server error|unknown error|未知错误/i.test(primaryError);
    const logDiagnostic = needsLog && selectedAgent.adapter === "opencode"
      ? await readOpenCodeFailureLog(session)
      : "";
    throw new Error(
      logDiagnostic && !primaryError.includes(logDiagnostic)
        ? `${primaryError}\n${logDiagnostic}`
        : primaryError,
    );
  }
  const trailingMessages = trailingFinalMessages(parserState.eventOrder);
  const rawFinalText =
    trailingMessages
      .map((item) => parserState.forwardedEvents.get(item.id)?.output)
      .filter(Boolean)
      .join("\n\n")
      .trim() ||
    parserState.finalText.trim() ||
    parserState.latestText.trim() ||
    "Agent 已完成任务，未返回额外文本。";
  const finalText =
    stripEasyWorkProtocolMarkers(rawFinalText, true) ||
    "Agent 已完成任务，未返回额外文本。";
  if (category === "agent") {
    void recordPlatformUsage("agent", {
      requests: 0,
      outputTokens: estimateContextTokens(finalText),
    }).catch(() => undefined);
  }
  const finalMessageEvents = trailingMessages.length
    ? trailingMessages
    : [{ id: `${payload.runId}_message`, kind: "agent_message" }];
  for (const [index, item] of finalMessageEvents.entries()) {
    emit({
      type: "agent.event",
      conversationId: payload.conversationId,
      runId: payload.runId,
      event: {
        id: item.id,
        kind: "message",
        title: "Agent 最终回复",
        output:
          index === finalMessageEvents.length - 1 ? finalText : undefined,
        status: "done",
        timestamp: isoNow(),
      },
    });
  }
  if (titlePromise) {
    emit({
      type: "conversation.title",
      conversationId: payload.conversationId,
      runId: payload.runId,
      title: await titlePromise,
    });
  }
  emit({
    type: "task.complete",
    conversationId: payload.conversationId,
    runId: payload.runId,
    result: finalText,
  });
  await persistWorkerTaskConversation(actor, workerTask);
  const distilledRecords = await distillPortableMemory(actor, {
    conversationId: workerTask.conversationId,
    projectId: workerTask.projectId,
    userRequest: workerTask.prompt,
    finalResult: finalText,
    location: `服务器 ${workerTask.serverId || "未知"}；工作区 ${workspace}`,
    source: "work-result-distillation",
    sourceTaskId: workerTask.runId,
    sourceCheckpointId: workerTask.checkpointAfterId,
    serverId: workerTask.serverId,
    workspaceId: workerTask.workspaceId,
    sourceAgentId: selectedAgent.id,
    sourceAgentSessionId: resolvedAgentSessionId,
    sourceMessageIds: [
      workerTask.userMessageId,
      workerTask.assistantMessageId,
    ].filter(Boolean),
  }).catch(() => []);
  if (persistedBinding && distilledRecords.length) {
    const synchronizedBinding = await updateAgentBinding(
      actor,
      bindingKey,
      (current) => ({
        ...(current || persistedBinding),
        syncCursor: {
          ...((current || persistedBinding).syncCursor || {}),
          memoryVersions: Object.fromEntries([
            ...Object.entries(
              (current || persistedBinding).syncCursor?.memoryVersions || {},
            ),
            ...distilledRecords.map((record) => [
              String(record.id),
              Number(record.revision || 0),
            ]),
          ]),
          memoryStatuses: Object.fromEntries([
            ...Object.entries(
              (current || persistedBinding).syncCursor?.memoryStatuses || {},
            ),
            ...distilledRecords.map((record) => [
              String(record.id),
              String(record.status || "active"),
            ]),
          ]),
        },
        updatedAt: isoNow(),
      }),
    );
    session.agentSessions.set(bindingKey, synchronizedBinding);
  }
  await persistSshWorker(session.worker);
}

async function closeSshSession(session) {
  if (session.client) {
    const client = session.client;
    clearProviderRelays(session);
    session.client = null;
    client.end();
  } else {
    clearProviderRelays(session);
  }
  if (session.activeRuns?.size) {
    for (const activeRun of session.activeRuns.values()) {
      activeRun.connectionLostAt = isoNow();
    }
    session.activeRun = session.activeRuns.values().next().value || null;
  } else if (session.activeRun?.remoteRun) {
    session.activeRun.connectionLostAt = isoNow();
  } else {
    session.activeRun = null;
  }
  session.status = "disconnected";
  session.demo = false;
  session.lastDisconnectedAt = isoNow();
  scheduleSshWorkerPersist(session.worker, 0);
}

async function connectSsh(socket, session, actor, payload) {
  if (
    session.status === "connected" &&
    (session.client || session.demo) &&
    !payload.forceReconnect
  ) {
    touchSshSession(session);
    sessionSend(session, {
      type: "connection.status",
      serverId: session.serverId,
      status: "connected",
      label: session.demo ? "演示登录节点在线" : "算力平台登录节点在线",
      host: session.host,
      port: session.port,
      username: session.username,
      latency: session.latency,
      demo: session.demo,
      reused: true,
    });
    return;
  }
  await closeSshSession(session);
  touchSshSession(session);
  session.serverId = safeSegment(payload.serverId || session.serverId || randomId("server-"));
  if (payload.demo) {
    session.demo = true;
    session.serverIdentity = sshServerIdentity({
      serverId: session.serverId,
      demo: true,
    });
    session.status = "connected";
    session.home = "/home/demo";
    session.host = "demo.easywork.local";
    session.username = "demo";
    session.latency = 18;
    session.lastConnectedAt = isoNow();
    session.lastDisconnectedAt = "";
    sessionSend(session, {
      type: "connection.status",
      serverId: session.serverId,
      status: "connected",
      label: "演示登录节点在线",
      host: "demo.easywork.local",
      username: "demo",
      latency: 18,
      demo: true,
    });
    sessionSend(session, {
      type: "agent.list",
      agents: [
        {
          id: "opencode",
          name: "OpenCode",
          folder: "~/.easywork/agents/opencode",
          path: "~/.easywork/agents/opencode/bin/opencode",
          version: "demo",
          status: "ready",
          adapter: "opencode",
          managed: true,
          configured: true,
          capabilities: agentRuntimeCapabilities("opencode", "ready", {
            liveControl: false,
          }),
        },
      ],
      serverId: session.serverId,
    });
    await persistSshWorker(session.worker);
    return;
  }

  const host = String(payload.host || "").trim();
  const username = String(payload.username || "").trim();
  const authMethod =
    payload.authMethod === "password" ? "password" : "key";
  const useSavedCredential = Boolean(payload.useSavedCredential);
  const storedSecrets = useSavedCredential ? await getSecrets(actor) : {};
  const savedCredential =
    storedSecrets.sshCredentials?.[session.serverId] || {};
  const privateKey = String(
    authMethod === "key"
      ? payload.privateKey ||
          savedCredential.privateKey ||
          ""
      : "",
  );
  const password = String(
    authMethod === "password"
      ? payload.password || savedCredential.password || ""
      : "",
  );
  const port = Number(payload.port || 22);
  if (!host || !username) throw new Error("主机和用户名不能为空");
  if (authMethod === "key" && !privateKey) throw new Error("请选择或粘贴 SSH 私钥");
  if (authMethod === "password" && !password) throw new Error("请输入 SSH 登录密码");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH 端口无效");

  const knownHostsPath = actorCredentialPath(actor, "known-hosts");
  const knownHosts = await readJson(knownHostsPath, {});
  let observedFingerprint = "";
  const startedAt = Date.now();
  const client = new SshClient();
  const sshPolicy =
    runtimePlatformSettings?.ssh || DEFAULT_PLATFORM_SETTINGS.ssh;
  attachProviderRelayHandler(session, client);
  session.demo = false;
  session.status = "connecting";
  session.client = client;
  let connectionPublished = false;
  let failureExpectedClose = false;
  const sshAuth = {
    authMethod,
    otpPrompted: false,
    otpProvided: Boolean(String(payload.otp || "").trim()),
    passphrasePrompted: false,
    passphraseProvided: Boolean(String(payload.passphrase || "")),
  };

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        failureExpectedClose = true;
        client.end();
        reject(error);
      };
      client
        .on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
          const replies = prompts.map((prompt) => {
            const label = String(prompt.prompt || "");
            if (/verification|code|otp|token|验证码/i.test(label)) {
              sshAuth.otpPrompted = true;
              return String(payload.otp || "");
            }
            if (/password|passphrase|口令|密码/i.test(label)) {
              sshAuth.passphrasePrompted = true;
              return authMethod === "password"
                ? password
                : String(payload.passphrase || "");
            }
            return String(payload.otp || "");
          });
          finish(replies);
        })
        .once("ready", async () => {
          if (settled) return;
          try {
            const homeResult = await remoteExec(client, 'printf "%s" "$HOME"');
            if (settled) return;
            session.home = homeResult.stdout.trim();
            session.host = host;
            session.username = username;
            if (payload.trustHost && observedFingerprint) {
              knownHosts[`${host}:${port}`] = observedFingerprint;
              await writeJson(knownHostsPath, knownHosts);
            }
            settled = true;
            resolve();
          } catch (error) {
            fail(error);
          }
        })
        .on("error", (error) => {
          if (settled) return;
          if (
            observedFingerprint &&
            !payload.trustHost &&
            knownHosts[`${host}:${port}`] !== observedFingerprint
          ) {
            const fingerprintError = new Error(
              `首次连接需要确认主机指纹：${observedFingerprint}`,
            );
            fingerprintError.fingerprint = observedFingerprint;
            fail(fingerprintError);
            return;
          }
          fail(error);
        })
        .on("close", () => {
          if (session.client === client) {
            clearProviderRelays(session);
            session.client = null;
            session.lastDisconnectedAt = isoNow();
            session.disconnectReason = "SSH 连接已关闭";
            if (connectionPublished && !failureExpectedClose) {
              session.status = "disconnected";
              sessionSend(session, {
                type: "connection.status",
                serverId: session.serverId,
                status: "disconnected",
                label: "SSH 连接已关闭",
              });
            }
            scheduleSshWorkerPersist(session.worker, 0);
          }
        })
        .connect({
          host,
          port,
          username,
          privateKey: authMethod === "key" ? privateKey : undefined,
          password: authMethod === "password" ? password : undefined,
          passphrase: payload.passphrase ? String(payload.passphrase) : undefined,
          tryKeyboard: true,
          readyTimeout: sshPolicy.connectTimeoutSeconds * 1000,
          keepaliveInterval: sshPolicy.keepaliveIntervalSeconds * 1000,
          keepaliveCountMax: sshPolicy.keepaliveCountMax,
          hostVerifier: (key) => {
            observedFingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
            const known = knownHosts[`${host}:${port}`];
            return Boolean(payload.trustHost || (known && known === observedFingerprint));
          },
        });
    });
  } catch (error) {
    if (error && typeof error === "object") error.sshAuth = sshAuth;
    throw error;
  }

  if (session.client !== client) {
    throw new Error("SSH 连接在登录完成前已关闭");
  }
  sessionSend(session, {
    type: "connection.status",
    serverId: session.serverId,
    status: "connected",
    label: "算力平台登录节点在线",
    host,
    username,
    latency: Date.now() - startedAt,
    fingerprint: observedFingerprint,
  });
  connectionPublished = true;
  session.status = "connected";
  session.port = port;
  session.serverIdentity = sshServerIdentity({
    host,
    port,
    serverId: session.serverId,
  });
  session.latency = Date.now() - startedAt;
  session.fingerprint = observedFingerprint;
  session.lastConnectedAt = isoNow();
  session.lastDisconnectedAt = "";
  session.disconnectReason = "";
  if (
    actor.authenticated &&
    (useSavedCredential || payload.rememberCredential)
  ) {
    try {
      if (
        payload.privateKey ||
        payload.password
      ) {
        await updateSecrets(actor, {
          sshCredential: {
            serverId: session.serverId,
            privateKey:
              authMethod === "key" && payload.privateKey
                ? String(payload.privateKey)
                : undefined,
            password:
              authMethod === "password" && payload.password
                ? String(payload.password)
                : undefined,
          },
        });
      }
      let profile;
      await updateState(actor, (state) => {
        state.settings ||= {};
        const profiles = Array.isArray(state.settings.servers)
          ? state.settings.servers
          : [];
        const currentProfile =
          profiles.find((item) => item.id === session.serverId) || {};
        profile = {
          id: session.serverId,
          name: String(payload.name || currentProfile.name || host)
            .trim()
            .slice(0, 80),
          host,
          port,
          username,
          authMethod,
          keyName: String(
            authMethod === "key"
              ? payload.keyName || currentProfile.keyName || "SSH 私钥"
              : "",
          ).slice(0, 160),
          configured: true,
          lastConnectedAt: isoNow(),
        };
        state.settings.servers = [
          profile,
          ...profiles.filter((item) => item.id !== session.serverId),
        ];
        state.settings.lastServerId = session.serverId;
        return state;
      });
      sessionSend(session, {
        type: "server.profile",
        profile,
      });
    } catch {
      sessionSend(session, {
        type: "error",
        error: "SSH 已连接，但账号连接配置未能保存",
      });
    }
  }
  await reconcileRecoveredWorkerTasks(session, actor).catch((caught) => {
    sessionSend(session, {
      type: "error",
      error:
        caught instanceof Error
          ? `远端任务恢复失败：${caught.message}`
          : "远端任务恢复失败",
    });
  });
  await publishRemoteAgentScan(session, actor);
  await persistSshWorker(session.worker);
}

async function addRemoteAgent(session, actor, payload) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const folder = remotePathForSession(session, payload.folder);
  const candidateNames = ["opencode", "codex", "claude"];
  const checks = candidateNames.flatMap((name) => [
    `${folder}/${name}`,
    `${folder}/bin/${name}`,
  ]);
  const command = [
    "set +e",
    ...checks.map(
      (candidate) =>
        `if [ -x ${shellQuote(candidate)} ]; then printf "%s" ${shellQuote(candidate)}; exit 0; fi`,
    ),
    "exit 1",
  ].join("\n");
  const located = await remoteExec(session.client, command, { allowFailure: true });
  if (located.code !== 0 || !located.stdout.trim()) {
    throw new Error("该文件夹内没有找到受支持的 Agent 可执行文件");
  }
  const binaryPath = located.stdout.trim();
  const binaryName = path.posix.basename(binaryPath).toLowerCase();
  const adapter = binaryName.includes("opencode")
    ? "opencode"
    : binaryName === "codex"
      ? "codex"
      : binaryName.includes("claude")
        ? "claude"
        : "plain";
  const id = `agent-${crypto
    .createHash("sha256")
    .update(`${session.serverId}:${binaryPath}`)
    .digest("hex")
    .slice(0, 14)}`;
  const agent = {
    id,
    name: String(
      payload.name ||
        (adapter === "opencode"
          ? "OpenCode"
          : adapter === "codex"
            ? "Codex"
            : adapter === "claude"
              ? "Claude Code"
              : path.posix.basename(folder)),
    )
      .trim()
      .slice(0, 80),
    folder,
    path: binaryPath,
    adapter,
    managed: false,
    deployment: "user",
    ...agentConfigFor(adapter, session.home),
  };
  const registryPath = remoteAgentRegistryPath(actor);
  const registry = await readJson(registryPath, {});
  const serverKey = remoteServerKey(session);
  const current = Array.isArray(registry[serverKey]) ? registry[serverKey] : [];
  registry[serverKey] = [agent, ...current.filter((item) => item.id !== id)];
  await writeJson(registryPath, registry);
  return scanRemoteAgents(session, actor);
}

async function agentForSession(session, actor, agentId) {
  const agents = await scanRemoteAgents(session, actor);
  const agent = agents.find((item) => item.id === String(agentId || ""));
  if (!agent) throw new Error("没有找到这个 Agent");
  return agent;
}

async function readAgentConfig(session, actor, payload) {
  const agentId = typeof payload === "object" ? payload.agentId : payload;
  const scope = {
    conversationId: String(payload?.conversationId || ""),
    workspaceId: String(payload?.workspaceId || ""),
  };
  const agent = await agentForSession(session, actor, agentId);
  if (!agent.managed) {
    throw new Error("用户部署的 Agent 使用自身原生配置，EasyWork 不读取或改写");
  }
  let configPath = agent.configPath;
  const runtime = await ensureManagedAgentRuntimeConfig(
    session,
    actor,
    agent,
    scope,
  );
  if (!runtime.configured) throw new Error("请先配置用户 API 和 Agent 模型");
  configPath = runtime.configPath;
  if (!configPath) throw new Error("尚未识别该 Agent 的原生配置文件");
  let content = "";
  try {
    content = (await remoteSftpRead(session.client, configPath)).toString("utf8");
  } catch (caught) {
    if (caught?.code !== 2) throw caught;
  }
  if (!content && agent.adapter === "opencode") {
    content = `${JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
      },
      null,
      2,
    )}\n`;
  }
  return {
    agent,
    path: configPath,
    content,
  };
}

async function writeAgentConfig(session, actor, payload) {
  const agent = await agentForSession(session, actor, payload.agentId);
  if (!agent.managed) {
    throw new Error("用户部署的 Agent 使用自身原生配置，EasyWork 不读取或改写");
  }
  const scope = {
    conversationId: String(payload.conversationId || ""),
    workspaceId: String(payload.workspaceId || ""),
  };
  let configPath = agent.configPath;
  const runtime = await ensureManagedAgentRuntimeConfig(
    session,
    actor,
    agent,
    scope,
  );
  if (!runtime.configured) throw new Error("请先配置用户 API 和 Agent 模型");
  configPath = runtime.configPath;
  if (!configPath) throw new Error("尚未识别该 Agent 的原生配置文件");
  const content = String(payload.content || "");
  if (!content.trim()) throw new Error("配置文件不能为空");
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) {
    throw new Error("配置文件不能超过 2 MB");
  }
  if (configPath.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch {
      throw new Error("配置文件不是有效 JSON；如需注释，请改用 Agent 的 JSONC 配置");
    }
  }
  await remoteExec(
    session.client,
      `mkdir -p ${shellQuote(path.posix.dirname(configPath))}`,
  );
  await remoteSftpWrite(session.client, configPath, content);
  return scanRemoteAgents(session, actor, scope);
}

async function listRemoteFiles(session, requestedPath) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const target = remotePathForSession(session, requestedPath);
  const list = await remoteSftpList(session.client, target);
  return {
    path: target,
    home: session.home,
    parent:
      target === "/"
        ? null
        : path.posix.dirname(target) || "/",
    entries: list
      .filter((entry) => ![".", ".."].includes(entry.filename))
      .map((entry) => ({
        name: entry.filename,
        path: path.posix.join(target, entry.filename),
        type: entry.attrs?.isDirectory?.() ? "directory" : "file",
        size: Number(entry.attrs?.size || 0),
        modifiedAt: entry.attrs?.mtime
          ? new Date(entry.attrs.mtime * 1000).toISOString()
          : undefined,
      }))
      .sort(
        (left, right) =>
          Number(left.type !== "directory") - Number(right.type !== "directory") ||
          left.name.localeCompare(right.name, "zh-CN"),
      ),
  };
}

async function readRemoteDownload(session, requestedPath) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const target = remotePathForSession(session, requestedPath);
  const buffer = await remoteSftpRead(session.client, target);
  if (buffer.length > 32 * 1024 * 1024) {
    throw new Error("网页端单次下载暂时限制为 32 MB");
  }
  return {
    path: target,
    name: path.posix.basename(target),
    size: buffer.length,
    contentBase64: buffer.toString("base64"),
  };
}

async function uploadRemoteFile(session, payload) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const directory = remotePathForSession(session, payload.path);
  const name = String(payload.name || "").replaceAll("\\", "/").split("/").pop();
  if (!name || [".", ".."].includes(name)) throw new Error("文件名无效");
  const buffer = Buffer.from(String(payload.contentBase64 || ""), "base64");
  if (buffer.length > 32 * 1024 * 1024) {
    throw new Error("网页端单次上传暂时限制为 32 MB");
  }
  const target = path.posix.join(directory, name);
  await remoteSftpWrite(session.client, target, buffer, 0o644);
  return listRemoteFiles(session, directory);
}

function describeSshError(caught) {
  const message = caught instanceof Error ? caught.message : "远端操作失败";
  if (caught?.fingerprint) return message;
  if (caught?.sshAuth?.otpPrompted) {
    return caught.sshAuth.otpProvided
      ? "动态验证码未通过，可能已经过期；请输入当前最新的 6 位验证码后重试"
      : "登录节点要求动态验证码，请在连接按钮左侧输入当前 6 位验证码后重试";
  }
  if (/all configured authentication methods failed|authentication failed|permission denied/i.test(message)) {
    return caught?.sshAuth?.authMethod === "key"
      ? "登录节点未接受当前私钥，请确认该公钥仍在服务器 authorized_keys 中"
      : "登录节点未接受当前密码，请核对用户名和密码";
  }
  if (/cannot parse privatekey|unsupported key format|bad passphrase|encrypted private.*passphrase/i.test(message)) {
    return "无法使用此 SSH 私钥，请检查文件格式和私钥密码";
  }
  if (/timed out|timeout/i.test(message)) {
    return "SSH 连接超时，请检查网络、VPN、登录节点和端口";
  }
  if (/enotfound|getaddrinfo/i.test(message)) {
    return "找不到登录节点，请检查主机地址和本机网络";
  }
  if (/econnrefused|connection refused/i.test(message)) {
    return "登录节点拒绝连接，请检查主机、端口或平台服务状态";
  }
  if (/econnreset|connection lost|before handshake|socket hang up/i.test(message)) {
    return "SSH 连接被远端关闭，请检查网络或平台登录要求";
  }
  return `SSH 连接失败：${message}`;
}

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname !== "/easywork-ws") {
      socket.destroy();
      return;
    }
    const origin = allowedOrigin(req.headers.origin);
    if (origin === "null") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (websocket) => {
      wss.emit("connection", websocket, req);
    });
  });

  wss.on("connection", async (socket, req) => {
    const pendingMessages = [];
    let workerMessageHandler = null;
    let socketClosed = false;
    socket.on("message", (raw) => {
      if (workerMessageHandler) void workerMessageHandler(raw);
      else pendingMessages.push(raw);
    });
    socket.once("close", () => {
      socketClosed = true;
    });
    const responseShim = {
      setHeader() {},
    };
    const actor = await resolveActor(req, responseShim, false);
    const worker = await getSshWorker(actor);
    for (const task of worker.tasks.values()) {
      if (!task.recoveredAfterRestart) continue;
      await persistWorkerTaskConversation(actor, task).catch(() => undefined);
      task.recoveredAfterRestart = false;
    }
    scheduleSshWorkerPersist(worker, 0);
    worker.sockets.add(socket);
    const actorSessions = () => [...worker.sessions.values()];
    const getSession = (serverId, create = false) => {
      const safeServerId = safeSegment(serverId || "default-server");
      let session = worker.sessions.get(safeServerId);
      if (!session && create) {
        session = createSshSession(worker, safeServerId);
        worker.sessions.set(safeServerId, session);
        scheduleSshWorkerPersist(worker, 0);
      }
      return session || null;
    };
    const storedState = await getState(actor);
    const conversationCounts = new Map();
    for (const conversation of storedState.conversations || []) {
      const serverId = conversation?.work?.serverId;
      if (!serverId || conversation?.work?.connectionEnabled === false) continue;
      conversationCounts.set(
        serverId,
        Number(conversationCounts.get(serverId) || 0) + 1,
      );
    }
    const connectionPayload = (session, resumed = false) => ({
      serverId: session.serverId,
      status: session.status,
      label:
        session.status === "connected"
          ? session.demo
            ? "演示登录节点在线"
            : "算力平台登录节点在线"
          : "远程连接未建立",
      host: session.host,
      port: session.port,
      username: session.username,
      latency: session.latency,
      fingerprint:
        session.status === "error" ? session.fingerprint || undefined : undefined,
      demo: session.demo,
      resumed,
      conversationCount: Number(conversationCounts.get(session.serverId) || 0),
      activeTaskCount: Number(session.activeRuns?.size || 0),
    });

    activeSockets.add(socket);
    const resumedSessions = actorSessions();
    wsSend(socket, {
      type: "connections.snapshot",
      connections: resumedSessions
        .map((session) => connectionPayload(session, true)),
    });
    replayWorkerTasks(socket, worker);
    for (const session of resumedSessions.filter(
      (item) => item.status === "connected",
    )) {
      if (session.demo) {
        wsSend(socket, {
          type: "agent.list",
          serverId: session.serverId,
          agents: [
            {
              id: "opencode",
              name: "OpenCode",
              folder: "~/.easywork/agents/opencode",
              path: "~/.easywork/agents/opencode/bin/opencode",
              version: "demo",
              status: "ready",
              adapter: "opencode",
              managed: true,
              configured: true,
              capabilities: agentRuntimeCapabilities("opencode", "ready", {
                liveControl: false,
              }),
            },
          ],
        });
      } else {
        publishRemoteAgentScan(session, actor, (payload) => wsSend(socket, payload))
          .catch(() => undefined);
      }
    }

    workerMessageHandler = async (raw) => {
      let payload;
      let targetSession = null;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        wsSend(socket, { type: "error", error: "WebSocket 消息不是有效 JSON" });
        return;
      }
      try {
        const requestedServerId = safeSegment(
          payload.serverId || payload.profileId || "default-server",
        );
        if (payload.type === "ssh.connect") {
          targetSession = getSession(requestedServerId, true);
          wsSend(socket, {
            type: "connection.status",
            serverId: targetSession.serverId,
            status: "connecting",
            label: payload.demo ? "正在创建演示会话…" : "正在进行 SSH 握手…",
          });
          await connectSsh(socket, targetSession, actor, {
            ...payload,
            serverId: targetSession.serverId,
          });
          return;
        }

        targetSession =
          getSession(requestedServerId) ||
          (payload.conversationId
            ? actorSessions().find(
                (session) =>
                  [...(session.activeRuns?.values() || [])].some(
                    (run) => run.conversationId === payload.conversationId,
                  ),
              )
            : null);
        if (!targetSession) throw new Error("没有找到对应的远程连接");
        touchSshSession(targetSession);

        if (payload.type === "ssh.disconnect") {
          await closeSshSession(targetSession);
          sessionSend(targetSession, {
            type: "connection.status",
            serverId: targetSession.serverId,
            status: "disconnected",
            label: "已主动断开",
          });
          return;
        }
        if (payload.type === "agent.add") {
          const agents = await addRemoteAgent(targetSession, actor, payload);
          wsSend(socket, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents,
          });
          return;
        }
        if (payload.type === "agent.install") {
          const agentId = String(payload.agentId || "opencode");
          const catalog = MANAGED_AGENT_CATALOG[agentId];
          if (!catalog) throw new Error("不支持安装这个 Agent");
          sessionSend(targetSession, {
            type: "agent.install.progress",
            serverId: targetSession.serverId,
            agentId,
            stage: "prepare",
            label: "正在准备安装",
          });
          const agents = await installManagedAgent(
            targetSession,
            actor,
            agentId,
            (stage, label) => {
              sessionSend(targetSession, {
                type: "agent.install.progress",
                serverId: targetSession.serverId,
                agentId,
                stage,
                label,
              });
            },
          );
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents,
          });
          return;
        }
        if (payload.type === "agent.uninstall") {
          if (targetSession.demo) {
            throw new Error("演示环境不能卸载 Agent");
          }
          const agentId = String(payload.agentId || "");
          const catalog = MANAGED_AGENT_CATALOG[agentId];
          if (!catalog) throw new Error("不支持卸载这个 Agent");
          wsSend(socket, {
            type: "agent.uninstall.status",
            serverId: targetSession.serverId,
            agentId,
            status: "running",
            label: `正在卸载 ${catalog.name}`,
          });
          const agents = await uninstallManagedAgent(
            targetSession,
            actor,
            agentId,
          );
          wsSend(socket, {
            type: "agent.uninstall.status",
            serverId: targetSession.serverId,
            agentId,
            status: "done",
            label: `${catalog.name} 已卸载`,
          });
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents,
          });
          return;
        }
        if (payload.type === "agent.update.check") {
          if (targetSession.demo) {
            wsSend(socket, {
              type: "agent.update.status",
              serverId: targetSession.serverId,
              status: "current",
              currentVersion: "demo",
              latestVersion: "demo",
              label: "演示环境无需更新",
            });
            return;
          }
          const agentId = String(payload.agentId || "opencode");
          const update = await checkManagedAgentUpdate(
            targetSession,
            actor,
            agentId,
          );
          const agentName = MANAGED_AGENT_CATALOG[agentId]?.name || agentId;
          wsSend(socket, {
            type: "agent.update.status",
            serverId: targetSession.serverId,
            agentId,
            status: update.updateAvailable ? "available" : "current",
            ...update,
            label: update.updateAvailable
              ? `发现 ${agentName} ${update.latestVersion}`
              : `${agentName} 已与主机版本一致`,
          });
          return;
        }
        if (payload.type === "agent.update.apply") {
          if (targetSession.demo) {
            wsSend(socket, {
              type: "agent.update.status",
              serverId: targetSession.serverId,
              status: "done",
              currentVersion: "demo",
              latestVersion: "demo",
              label: "演示环境无需更新",
            });
            return;
          }
          const agentId = String(payload.agentId || "opencode");
          const update = await applyManagedAgentUpdate(
            targetSession,
            actor,
            agentId,
            (status, label) => {
              wsSend(socket, {
                type: "agent.update.status",
                serverId: targetSession.serverId,
                agentId,
                status,
                label,
              });
            },
          );
          wsSend(socket, {
            type: "agent.update.status",
            serverId: targetSession.serverId,
            agentId,
            status: "done",
            currentVersion: update.currentVersion,
            latestVersion: update.latestVersion,
            label: `${MANAGED_AGENT_CATALOG[agentId]?.name || agentId} 已更新到 ${update.latestVersion}`,
          });
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents: update.agents,
          });
          return;
        }
        if (payload.type === "agent.model.configure") {
          const configuredAgentName =
            MANAGED_AGENT_CATALOG[String(payload.agentId || "opencode")]?.name ||
            "Agent";
          if (targetSession.demo) {
            wsSend(socket, {
              type: "agent.model.status",
              serverId: targetSession.serverId,
              status: "done",
              model: String(payload.model || "demo"),
              label: "演示环境已完成配置",
            });
            return;
          }
          wsSend(socket, {
            type: "agent.model.status",
            serverId: targetSession.serverId,
            status: "configuring",
            model: String(payload.model || ""),
            label: `正在准备 ${configuredAgentName} 配置`,
          });
          const configured = await configureManagedAgentModel(
            targetSession,
            actor,
            payload,
            (label) => {
              wsSend(socket, {
                type: "agent.model.status",
                serverId: targetSession.serverId,
                status: "configuring",
                model: String(payload.model || ""),
                label,
              });
            },
          );
          wsSend(socket, {
            type: "agent.model.status",
            serverId: targetSession.serverId,
            status: "done",
            model: configured.model,
            label: `${configuredAgentName} 已切换到 ${configured.model}`,
          });
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents: configured.agents,
          });
          return;
        }
        if (payload.type === "agent.runtime.configure") {
          try {
            const configured = await configureManagedAgentRuntime(
              targetSession,
              actor,
              payload,
              (label) => {
                wsSend(socket, {
                  type: "agent.runtime.status",
                  serverId: targetSession.serverId,
                  agentId: String(payload.agentId || ""),
                  status: "configuring",
                  label,
                });
              },
            );
            wsSend(socket, {
              type: "agent.runtime.status",
              serverId: targetSession.serverId,
              status: "done",
              ...configured,
            });
            sessionSend(targetSession, {
              type: "agent.list",
              serverId: targetSession.serverId,
              agents: configured.agents,
            });
          } catch (error) {
            wsSend(socket, {
              type: "agent.runtime.status",
              serverId: targetSession.serverId,
              agentId: String(payload.agentId || ""),
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }
        if (payload.type === "agent.config.read") {
          const config = await readAgentConfig(
            targetSession,
            actor,
            payload,
          );
          wsSend(socket, {
            type: "agent.config",
            serverId: targetSession.serverId,
            requestId: payload.requestId,
            ...config,
          });
          return;
        }
        if (payload.type === "agent.config.write") {
          const agents = await writeAgentConfig(
            targetSession,
            actor,
            payload,
          );
          wsSend(socket, {
            type: "agent.config.saved",
            serverId: targetSession.serverId,
            requestId: payload.requestId,
          });
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents,
          });
          return;
        }
        if (payload.type === "remote.fs.list") {
          wsSend(socket, {
            type: "remote.fs.list",
            serverId: targetSession.serverId,
            requestId: payload.requestId,
            ...(await listRemoteFiles(targetSession, payload.path)),
          });
          return;
        }
        if (payload.type === "remote.fs.download") {
          wsSend(socket, {
            type: "remote.fs.download",
            serverId: targetSession.serverId,
            requestId: payload.requestId,
            ...(await readRemoteDownload(targetSession, payload.path)),
          });
          return;
        }
        if (payload.type === "remote.fs.upload") {
          wsSend(socket, {
            type: "remote.fs.list",
            serverId: targetSession.serverId,
            requestId: payload.requestId,
            ...(await uploadRemoteFile(targetSession, payload)),
          });
          return;
        }
        if (payload.type === "remote.fs.mkdir") {
          const directory = remotePathForSession(targetSession, payload.path);
          const name = safeSegment(payload.name, "");
          if (!name) throw new Error("文件夹名称无效");
          await remoteSftpMkdir(
            targetSession.client,
            path.posix.join(directory, name),
          );
          wsSend(socket, {
            type: "remote.fs.list",
            serverId: targetSession.serverId,
            requestId: payload.requestId,
            ...(await listRemoteFiles(targetSession, directory)),
          });
          return;
        }
        if (payload.type === "work.append") {
          const runId = String(payload.runId || "");
          const conversationId = String(payload.conversationId || "");
          const activeRun =
            targetSession.activeRuns?.get(runId) || targetSession.activeRun;
          if (
            !activeRun ||
            activeRun.runId !== runId ||
            activeRun.conversationId !== conversationId
          ) {
            throw new Error("当前对话没有可追加指令的运行任务");
          }
          // The web handoff runs before the remote adapter is admitted. Accept
          // input during that short phase and keep it queued; once the selected
          // Agent is ready, the adapter either receives it live (OpenCode) or as
          // the next turn of the same native session (Codex / Claude Code).
          if (activeRun.agentControl && !activeRun.supportsLiveInput) {
            throw new Error("当前 Agent 不支持在运行中追加指令");
          }
          const content = String(payload.content || "").trim();
          if (!content) throw new Error("追加指令不能为空");
          if (content.length > 64_000) throw new Error("追加指令过长");
          const task = targetSession.worker.tasks.get(runId);
          if (!task || task.status !== "running") {
            throw new Error("当前任务已经结束，无法追加指令");
          }
          const instruction = {
            messageId: String(payload.messageId || randomId("message_")),
            content,
            createdAt: String(payload.createdAt || isoNow()),
            status: activeRun.agentControl ? "sending" : "queued",
            updatedAt: isoNow(),
          };
          await persistAppendedInstruction(actor, task, instruction);
          scheduleSshWorkerPersist(targetSession.worker, 0);
          sessionSend(targetSession, {
            type: "work.append.accepted",
            serverId: targetSession.serverId,
            conversationId,
            runId,
            requestId: payload.requestId,
            message: {
              id: instruction.messageId,
              role: "user",
              content,
              createdAt: instruction.createdAt,
              mode: "work",
              workspaceId: task.workspaceId,
              workspaceName: task.workspaceName,
              appendedToRunId: runId,
            },
          });
          if (activeRun.agentControl) {
            const previousDelivery =
              activeRun.appendDeliveryQueue || Promise.resolve();
            const delivery = previousDelivery
              .catch(() => undefined)
              .then(() =>
                deliverAppendedInstruction(
                  targetSession,
                  task,
                  activeRun,
                  instruction,
                ),
              );
            activeRun.appendDeliveryQueue = delivery;
            await delivery;
          }
          return;
        }
        if (payload.type === "work.run") {
          await runRemoteWork(socket, targetSession, actor, payload);
          return;
        }
        if (payload.type === "work.approval") {
          const activeRun =
            targetSession.activeRuns?.get(String(payload.runId || "")) ||
            targetSession.activeRun;
          if (
            !activeRun ||
            String(activeRun.runId || "") !== String(payload.runId || "") ||
            String(activeRun.conversationId || "") !==
              String(payload.conversationId || "")
          ) {
            throw new Error("这个权限请求已不属于当前运行任务");
          }
          if (activeRun.agentControl?.adapter !== "opencode") {
            throw new Error("当前 Agent 不支持从网页回复运行时权限请求");
          }
          const approvalType = String(payload.approvalType || "permission");
          if (approvalType === "question") {
            await replyOpenCodeQuestion(
              targetSession,
              activeRun.agentControl,
              payload.approvalId,
              payload.answers,
              !payload.approved,
            );
          } else {
            await replyOpenCodePermission(
              targetSession,
              activeRun.agentControl,
              payload.approvalId,
              Boolean(payload.approved),
            );
          }
          publishWorkerEvent(targetSession, {
            type: "agent.event",
            conversationId: activeRun.conversationId,
            runId: activeRun.runId,
            event: {
              id: String(payload.eventId || ""),
              kind: "approval_request",
              title:
                approvalType === "question"
                  ? payload.approved
                    ? "问题已回答"
                    : "问题已跳过"
                  : payload.approved
                    ? "操作已允许"
                    : "操作已拒绝",
              detail: payload.approved
                ? "用户允许本次操作"
                : "用户拒绝本次操作",
              approvalId: String(payload.approvalId || ""),
              approvalType:
                approvalType === "question" ? "question" : "permission",
              status: payload.approved ? "done" : "error",
              timestamp: isoNow(),
            },
          });
          return;
        }
        if (payload.type === "work.abort") {
          const activeRun =
            targetSession.activeRuns?.get(String(payload.runId || "")) ||
            targetSession.activeRun;
          if (
            !activeRun ||
            String(activeRun.runId || "") !== String(payload.runId || "")
          ) {
            throw new Error("这个任务当前未在远端运行");
          }
          const abortingTask = worker.tasks.get(String(payload.runId || ""));
          if (abortingTask) {
            abortingTask.abortRequested = true;
            abortingTask.updatedAt = isoNow();
            scheduleSshWorkerPersist(worker, 0);
          }
          publishWorkerEvent(targetSession, {
            type: "agent.event",
            conversationId: payload.conversationId,
            runId: payload.runId,
            event: {
              id: `${payload.runId}_cancelling`,
              kind: "job_status",
              title: "正在停止远端任务",
              detail: "正在向远端进程组发送停止信号",
              status: "running",
              timestamp: isoNow(),
            },
          });
          if (activeRun.abortController && !activeRun.remoteRun) {
            activeRun.abortController.abort();
            return;
          }
          if (!(await cancelRemoteRuntimeRun(targetSession, activeRun))) {
            throw new Error("SSH 已断开；重新连接后才能向远端任务发送停止信号");
          }
          return;
        }
      } catch (caught) {
        const message =
          payload.type === "ssh.connect"
            ? describeSshError(caught)
            : caught instanceof Error
              ? caught.message
              : "远端操作失败";
        if (payload.type === "ssh.connect") {
          const diagnostic =
            caught instanceof Error
              ? caught.message.replace(/\s+/g, " ").trim()
              : "unknown";
          console.warn(`[EasyWork SSH] connection failed: ${diagnostic}`);
          if (targetSession) {
            targetSession.status = "error";
            targetSession.fingerprint = caught?.fingerprint || "";
            targetSession.disconnectReason = message;
            targetSession.lastDisconnectedAt = isoNow();
            scheduleSshWorkerPersist(worker, 0);
          }
          sessionSend(targetSession || { worker }, {
            type: "connection.status",
            serverId:
              targetSession?.serverId ||
              safeSegment(payload.serverId || "default-server"),
            status: "error",
            label: message,
            fingerprint: caught?.fingerprint,
          });
        } else if (payload.type === "work.run") {
          if (targetSession) {
            targetSession.activeRuns?.delete(String(payload.runId || ""));
            targetSession.activeRun =
              targetSession.activeRuns?.values().next().value || null;
          }
          if (targetSession) publishWorkerEvent(targetSession, {
            type: "agent.event",
            conversationId: payload.conversationId,
            runId: payload.runId,
            event: {
              id: `${payload.runId}_error`,
              kind: "error",
              title: "远程任务执行失败",
              detail: message,
              status: "error",
              timestamp: isoNow(),
            },
          });
          if (targetSession) publishWorkerEvent(targetSession, {
            type: "task.error",
            conversationId: payload.conversationId,
            runId: payload.runId,
            result: message,
          });
          const failedTask = worker.tasks.get(String(payload.runId || ""));
          if (failedTask) {
            await persistWorkerTaskConversation(actor, failedTask).catch(
              () => undefined,
            );
            await persistSshWorker(worker).catch(() => undefined);
          }
        } else if (payload.type === "agent.install") {
          const agentId = String(payload.agentId || "opencode");
          wsSend(socket, {
            type: "agent.install.progress",
            serverId: targetSession?.serverId,
            agentId,
            stage: "error",
            label: message,
          });
        } else if (payload.type === "agent.uninstall") {
          const agentId = String(payload.agentId || "");
          const agentName = MANAGED_AGENT_CATALOG[agentId]?.name || agentId;
          wsSend(socket, {
            type: "agent.uninstall.status",
            serverId: targetSession?.serverId,
            agentId,
            status: "error",
            label: `${agentName} 卸载失败`,
            error: message,
          });
        } else if (String(payload.type || "").startsWith("agent.update.")) {
          const agentId = String(payload.agentId || "opencode");
          const agentName = MANAGED_AGENT_CATALOG[agentId]?.name || agentId;
          wsSend(socket, {
            type: "agent.update.status",
            serverId: targetSession?.serverId,
            agentId,
            status: "error",
            label: `${agentName} 更新失败`,
            error: message,
          });
        } else if (payload.type === "agent.model.configure") {
          const agentId = String(payload.agentId || "opencode");
          const agentName = MANAGED_AGENT_CATALOG[agentId]?.name || agentId;
          wsSend(socket, {
            type: "agent.model.status",
            serverId: targetSession?.serverId,
            agentId,
            status: "error",
            model: String(payload.model || ""),
            label: `${agentName} 模型配置失败`,
            error: message,
          });
        } else {
          wsSend(socket, {
            type: "error",
            serverId: targetSession?.serverId,
            requestId: payload.requestId,
            error: message,
          });
        }
      }
    };
    for (const raw of pendingMessages.splice(0)) {
      void workerMessageHandler(raw);
    }
    socket.on("close", () => {
      activeSockets.delete(socket);
      worker.sockets.delete(socket);
    });
    if (socketClosed) {
      activeSockets.delete(socket);
      worker.sockets.delete(socket);
    }
  });
  return wss;
}

async function cleanupIdleSshWorkers(now = Date.now()) {
  const idleTtlMinutes =
    runtimePlatformSettings?.ssh?.idleTtlMinutes ||
    DEFAULT_PLATFORM_SETTINGS.ssh.idleTtlMinutes;
  const cutoff = now - idleTtlMinutes * 60 * 1000;
  for (const [workerKey, worker] of sshWorkerPool) {
    let changed = false;
    for (const [serverId, session] of worker.sessions) {
      const lastActivity = Date.parse(session.lastUserActivityAt || "") || 0;
      const hasRunningTask = [...worker.tasks.values()].some(
        (task) => task.serverId === serverId && task.status === "running",
      );
      if (
        hasRunningTask ||
        session.activeRuns?.size ||
        session.activeRun ||
        lastActivity >= cutoff
      ) {
        continue;
      }
      await closeSshSession(session).catch(() => undefined);
      worker.sessions.delete(serverId);
      changed = true;
    }
    for (const [runId, task] of worker.tasks) {
      if (task.status === "running") continue;
      const finishedAt = Date.parse(task.finishedAt || task.updatedAt || "") || 0;
      if (finishedAt && finishedAt < cutoff) {
        worker.tasks.delete(runId);
        await rm(actorTaskPath(worker.actor, runId), { force: true }).catch(
          () => undefined,
        );
        changed = true;
      }
    }
    if (changed) {
      if (worker.persistTimer) {
        clearTimeout(worker.persistTimer);
        worker.persistTimer = null;
      }
      await persistSshWorker(worker).catch(() => undefined);
    }
    if (!worker.sockets.size && !worker.sessions.size && !worker.tasks.size) {
      sshWorkerPool.delete(workerKey);
    }
  }
}

export async function createEasyWorkServer() {
  await mkdir(DATA_ROOT, { recursive: true });
  await mkdir(ADMIN_ROOT, { recursive: true });
  await mkdir(SKILL_ROOT, { recursive: true });
  sessionSecret = await ensureFile(path.join(DATA_ROOT, ".session-secret"));
  encryptionKey = await ensureFile(path.join(DATA_ROOT, ".master-key"));
  await ensureInitialAdministrator();
  await readPlatformSettings();
  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });
  const wss = attachWebSocketServer(server);
  const cleanupTimer = setInterval(() => {
    const intervalMinutes =
      runtimePlatformSettings?.ssh?.cleanupIntervalMinutes ||
      DEFAULT_PLATFORM_SETTINGS.ssh.cleanupIntervalMinutes;
    if (
      Date.now() - lastAutomaticSshCleanupAt < intervalMinutes * 60 * 1000
    ) {
      return;
    }
    lastAutomaticSshCleanupAt = Date.now();
    void cleanupIdleSshWorkers();
  }, 60 * 1000);
  cleanupTimer.unref?.();
  server.once("close", () => {
    clearInterval(cleanupTimer);
  });
  return { server, wss };
}

export const gatewayTestHelpers = {
  agentBindingKey,
  agentMemoryDelta,
  agentRuntimeCapabilities,
  agentPromptWithNativePlanning,
  agentPlanEventStatus,
  createThinkTagRouter,
  describeSshError,
  fallbackConversationTitle,
  extractModelText,
  getSshWorker,
  mergeOpenCodeAuthContent,
  mergeOpenCodeConfigContent,
  managedOpenCodeModel,
  mergeConversationCollections,
  normalizeConversationTitle,
  normalizeWorkspaceRecord,
  normalizeAgentPlanStatus,
  normalizeAgentPlanSteps,
  openCodeConfigurationStatus,
  openCodeConfiguredModelDetails,
  openCodeProviderContextLimit,
  openCodeSseAgentEvent,
  classifyOpenCodeText,
  cleanupIdleSshWorkers,
  conciseOpenCodeDiagnostic,
  createSshSession,
  createAgentSyncCursor,
  createWorkerTask,
  parseOpenCodeLine,
  parseCodexLine,
  parseClaudeCodeLine,
  parseNativeAgentLine,
  nativeAgentCommand,
  ensureManagedAgentRuntimeConfig,
  managedAgentCapabilitySchema,
  prepareRemoteAgents,
  persistWorkerTaskConversation,
  publishWorkerEvent,
  providerConfigForOpenCode,
  providerModelDescriptor,
  providerRelayTarget,
  readRemoteRuntimeRun,
  remoteOpenCodePortCommand,
  stripEasyWorkProtocolMarkers,
  trailingFinalMessages,
  workspaceIdFor,
  workspacePathContains,
  workspaceRecordsOverlap,
  workspaceRunConflict,
  workspaceVersionDomainIdFor,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server } = await createEasyWorkServer();
  server.listen(PORT, HOST, () => {
    console.log(`EasyWork gateway listening on http://${HOST}:${PORT}`);
  });
}
