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
import { constants as fsConstants } from "node:fs";
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
  memorySequenceAt,
  normalizeMemoryDocument,
  selectMemoryRecords,
  selectMemorySyncRecords,
  upsertConversationSummary,
} from "./memory.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DATA_ROOT = path.resolve(process.env.EASYWORK_DATA_DIR || path.join(ROOT, "data"));
const SKILL_ROOT = path.resolve(process.env.EASYWORK_SKILL_DIR || path.join(ROOT, "skill"));
const PROMPT_ROOT = path.join(ROOT, "prompts");
const HOST = process.env.EASYWORK_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.EASYWORK_GATEWAY_PORT || 8789);
const BODY_LIMIT = 36 * 1024 * 1024;
const SESSION_MAX_AGE = 60 * 60 * 24 * 180;
const SSH_KEEPALIVE_INTERVAL_MS = 60 * 1000;
const SSH_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SSH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EASYWORK_OPENCODE_PROVIDER_ID = "easywork";
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
const memoryMutationQueues = actorMutationQueues;
const conversationTreeMutationQueues = actorMutationQueues;
const checkpointMutationQueues = actorMutationQueues;
let accountMutationQueue = Promise.resolve();
let sessionSecret;
let encryptionKey;
let remoteRuntimeBundlePromise;
let openCodeReleaseCache;
const openCodeArtifactPromises = new Map();

function isoNow() {
  return new Date().toISOString();
}

function randomId(prefix = "") {
  return `${prefix}${crypto.randomUUID()}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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
  return record?.id === userId && record?.email ? record : null;
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

function agentBindingKey({ serverId, workspace, agentId, conversationId }) {
  return [serverId, workspace, agentId, conversationId]
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

async function removeAgentBindingsForConversations(actor, conversationIds) {
  const ids = new Set(conversationIds.filter(Boolean).map(String));
  if (!ids.size) return [];
  const removed = await enqueueActorMutation(
    agentBindingMutationQueues,
    actor,
    async () => {
      const document = await readAgentBindings(actor);
      const matches = [];
      for (const [key, binding] of Object.entries(document.bindings)) {
        if (!ids.has(String(binding?.conversationId || ""))) continue;
        matches.push(binding);
        delete document.bindings[key];
      }
      document.updatedAt = isoNow();
      await writeJson(agentBindingsPath(actor), document);
      return matches;
    },
  );
  const worker = await getSshWorker(actor);
  const nativeSessions = [];
  for (const session of worker.sessions.values()) {
    for (const [key, binding] of session.agentSessions || []) {
      if (ids.has(String(binding?.conversationId || ""))) {
        session.agentSessions.delete(key);
      }
    }
  }
  for (const binding of removed) {
    const session = worker.sessions.get(safeSegment(binding.serverId || ""));
    if (
      binding.agentId !== "opencode" ||
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
  return { bindings: removed, nativeSessions };
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
  for (const conversation of conversations) {
    if (conversation?.work?.workspaceMode !== "managed") continue;
    const session = worker.sessions.get(safeSegment(conversation.work.serverId || ""));
    if (!session?.client || session.status !== "connected") continue;
    const conversationSegment = safeSegment(conversation.id, "conversation");
    const expectedRoot = `${session.home}/.easywork/worktrees/${conversationSegment}`;
    const workspace = String(conversation.work.workspace || "");
    if (workspace !== `${expectedRoot}/main`) continue;
    await remoteExec(
      session.client,
      [
        "set -eu",
        `EW_TARGET=${shellQuote(expectedRoot)}`,
        `EW_EXPECTED=${shellQuote(`${session.home}/.easywork/worktrees/${conversationSegment}`)}`,
        'test "$EW_TARGET" = "$EW_EXPECTED"',
        'case "$EW_TARGET" in "$HOME/.easywork/worktrees/"*) rm -rf -- "$EW_TARGET" ;; *) exit 91 ;; esac',
      ].join("\n"),
    ).catch(() => undefined);
  }
}

function createSshSession(worker, serverId, stored = {}) {
  const safeServerId = safeSegment(serverId || "default-server");
  return {
    poolKey: `${worker.key}:${safeServerId}`,
    actorKey: worker.key,
    worker,
    serverId: safeServerId,
    socketId: crypto.randomUUID(),
    client: null,
    demo: Boolean(stored.demo),
    status: "disconnected",
    home: "",
    host: String(stored.host || ""),
    port: Number(stored.port || 22),
    username: String(stored.username || ""),
    latency: undefined,
    fingerprint: "",
    activeStream: null,
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
        email: record.email,
        avatar: record.avatar || undefined,
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

async function getSecrets(actor) {
  const stored = await readJson(actorCredentialPath(actor, "secrets"), {});
  const sshCredentials = {};
  for (const [serverId, credential] of Object.entries(stored.sshCredentials || {})) {
    sshCredentials[serverId] = {
      privateKey: decryptString(credential?.privateKey),
      password: decryptString(credential?.password),
    };
  }
  return {
    providerApiKey: decryptString(stored.providerApiKey),
    embeddingApiKey: decryptString(stored.embeddingApiKey),
    sshCredentials,
  };
}

async function updateSecrets(actor, patch) {
  return enqueueActorMutation(secretMutationQueues, actor, async () => {
    const secretPath = actorCredentialPath(actor, "secrets");
    const stored = await readJson(secretPath, {});
    const next = { ...stored };
    if (typeof patch.providerApiKey === "string" && patch.providerApiKey) {
      next.providerApiKey = encryptString(patch.providerApiKey);
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
  return { settings, projects, conversations, skills, files };
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
  if (safeState?.settings?.provider) delete safeState.settings.provider.apiKey;
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
  const memoryDocument = await readMemoryDocument(actor);
  if (state?.settings?.provider) {
    state.settings.provider.configured = Boolean(secrets.providerApiKey);
  }
  if (state?.settings?.embedding) {
    state.settings.embedding.configured = Boolean(secrets.embeddingApiKey);
  }
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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
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

function chunksFromText(text, maxChars = 3000, overlap = 600) {
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
    if (end < cleaned.length) {
      const candidates = [
        cleaned.lastIndexOf("\n\n", end),
        cleaned.lastIndexOf("。", end),
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

async function listProviderModels(baseUrl, apiKey) {
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
  return [
    ...new Set(
      source
        .map((item) =>
          typeof item === "string" ? item : String(item?.id || item?.name || ""),
        )
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
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

async function indexLibraryFile(actor, item, buffer, state) {
  const text = await extractText(buffer, item.name, item.type);
  const textChunks = chunksFromText(text);
  const secrets = await getSecrets(actor);
  const embedding = state?.settings?.embedding || {};
  let vectors = [];
  if (embedding.configured && secrets.embeddingApiKey && textChunks.length) {
    for (let offset = 0; offset < textChunks.length; offset += 32) {
      const batch = textChunks.slice(offset, offset + 32);
      vectors.push(...(await callEmbedding(embedding, secrets.embeddingApiKey, batch)));
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
  const embedding = state?.settings?.embedding || {};
  const secrets = await getSecrets(actor);
  if (
    embedding.hybridEnabled &&
    embedding.configured &&
    secrets.embeddingApiKey &&
    rows.some((row) => row.chunk.vector)
  ) {
    try {
      const [queryVector] = await callEmbedding(embedding, secrets.embeddingApiKey, query);
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
    asOfSequence: Number(conversation?.branch?.memorySnapshotSequence || 0) || undefined,
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
    asOfSequence: Number(conversation?.branch?.memorySnapshotSequence || 0) || undefined,
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
        workspaceId: conversation?.work?.logicalWorkspaceId || "",
        memoryMode:
          state?.projects?.find((project) => project.id === conversation?.projectId)
            ?.memoryMode || "project-and-global",
        limit: 24,
        asOfSequence:
          Number(conversation?.branch?.memorySnapshotSequence || 0) || undefined,
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
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  let checkpointSource = null;
  if (provider.configured && provider.model && secrets.providerApiKey) {
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
        secrets.providerApiKey,
        prompt,
      );
      checkpointSource = parseModelJsonObject(extractModelText(response.payload));
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
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.configured || !secrets.providerApiKey) {
    const content =
      "尚未配置模型 API。请登录后在个人资料 → 模型 API 中完成设置。";
    onDelta("content", content);
    return { content, reasoning: "", demo: true };
  }
  const result = await callChatProviderStream(
    provider,
    secrets.providerApiKey,
    context,
    onDelta,
  );
  if (!result.content) {
    result.content = "模型返回了空内容。";
    onDelta("content", result.content);
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
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.configured || !provider.model || !secrets.providerApiKey) {
    return { content: "", reasoning: "", skipped: true };
  }
  const handoffPrompt = await renderPromptTemplate("web/work-context-router.md", {
    CURRENT_REQUEST: currentRequest,
    CONTEXT: context,
  });
  const result = await callChatProviderStream(
    provider,
    secrets.providerApiKey,
    handoffPrompt,
    (kind, delta) => {
      if (kind === "reasoning") onReasoning(delta);
    },
    { signal },
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
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.configured || !provider.model || !secrets.providerApiKey) {
    return [];
  }

  const prompt = await renderPromptTemplate("memory/memory-candidate-extract.md", {
    USER_REQUEST: request.slice(0, 8_000),
    LOCATION: String(location || "当前网页对话").slice(0, 1_000),
    FINAL_RESULT: result.slice(0, 16_000),
  });
  const response = await callChatProvider(
    provider,
    secrets.providerApiKey,
    prompt,
  );
  const parsed = parseModelJsonObject(extractModelText(response.payload));
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

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const actor = await resolveActor(req, res);
      await mkdir(actorDirectory(actor), { recursive: true });
      await mkdir(actorSkillDirectory(actor), { recursive: true });
      await updateMemoryDocument(actor, (document) => document);
      sendJson(res, 200, {
        actor,
        deviceToken: issueDeviceToken(actor),
        state: await stateForClient(actor),
        capabilities: {
          chatStream: true,
        },
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
        // These account-level settings have dedicated endpoints. Keeping the
        // server copy prevents a concurrent browser tab from erasing a key or
        // SSH profile that was just saved on another device.
        for (const key of ["provider", "embedding", "servers", "lastServerId"]) {
          if (Object.hasOwn(storedSettings, key)) {
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
      if (!["branch", "edit", "reset"].includes(action)) {
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
        const memorySnapshotSequence = memorySequenceAt(
          memoryDocument,
          sourceMessage.createdAt || createdAt,
          {
            sourceMessageIds: [sourceMessage.id],
            sourceTaskIds: [
              String(sourceMessage.runId || sourceMessage.trace?.runId || ""),
            ].filter(Boolean),
          },
        );
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
            createdAt,
          },
          work: source.work
            ? { ...source.work, agentSessionId: undefined }
            : undefined,
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
          branchConversation.work = {
            ...(branchConversation.work || {}),
            workspace: restored.workspace,
            workspaceMode: restored.mode,
            logicalWorkspaceId:
              checkpoint.logicalWorkspaceId ||
              branchConversation.work?.logicalWorkspaceId,
            sourceCheckpointId: checkpoint.id,
            agentSessionId: undefined,
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
          mode: branchConversation.mode,
          projectId: branchConversation.projectId,
          serverId: branchConversation.work?.serverId,
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
      let userIndex = messageIndex;
      if (action === "edit") {
        if (
          sourceMessage.role !== "user" ||
          lastUserMessage?.id !== sourceMessage.id
        ) {
          sendJson(res, 409, { error: "只能编辑当前对话最新一轮的用户提问" });
          return;
        }
      } else {
        if (
          sourceMessage.role !== "assistant" ||
          lastAssistantMessage?.id !== sourceMessage.id
        ) {
          sendJson(res, 409, { error: "只能重置当前对话的最新回复" });
          return;
        }
        userIndex = messageIndex - 1;
        while (userIndex >= 0 && messages[userIndex].role !== "user") {
          userIndex -= 1;
        }
        if (userIndex < 0) {
          sendJson(res, 409, { error: "没有找到该回复对应的用户提问" });
          return;
        }
      }
      const originalUserMessage = messages[userIndex];
      const seedPrompt = String(
        action === "edit"
          ? body.content || originalUserMessage.content
          : originalUserMessage.content,
      ).trim();
      if (!seedPrompt) {
        sendJson(res, 400, { error: "重新生成的提问不能为空" });
        return;
      }
      const affectedMessages = messages.slice(userIndex);
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
        const targetSession = worker.sessions.get(
          safeSegment(source.work?.serverId || ""),
        );
        const reverted = await selectivelyRevertWorkspaceRuns(
          targetSession,
          actor,
          {
            conversationId: sourceConversationId,
            serverId: source.work?.serverId,
            workspace: source.work?.workspace,
            logicalWorkspaceId: source.work?.logicalWorkspaceId,
            checkpoints: checkpointPairs,
          },
        );
        resetCapability = {
          workspace: "selectively-reset",
          workspaceMessage: reverted.files.length
            ? `已仅撤销本轮对 ${reverted.files.length} 个可快照文件的修改；其他对话保持不变，工作区外副作用不在可重置范围内。`
            : "本轮没有需要撤销的可快照文件修改；工作区外副作用不在可重置范围内。",
        };
      }
      const descendantIds = await pruneConversationTreeDescendants(
        actor,
        sourceConversationId,
        affectedMessageIds,
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
        target.messages = (target.messages || []).slice(0, userIndex);
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
          afterTimestamp: originalUserMessage.createdAt || "",
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
      const removedAgentState = await removeAgentBindingsForConversations(actor, [
        sourceConversationId,
        ...descendantIds,
      ]);
      await removeWorkerTasks(actor, affectedRunIds);
      await removeManagedBranchWorkspaces(actor, descendantConversations);
      for (const descendantId of descendantIds) {
        await tombstoneConversation(actor, descendantId);
      }
      sendJson(res, 200, {
        conversation: resetConversation,
        seedPrompt,
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
      const lastUserContextMessage = [...(contextConversation?.messages || [])]
        .reverse()
        .find((message) => message.role === "user");
      const [contextSystemText, contextSkillsText] = await Promise.all([
        readFile(
          path.join(
            PROMPT_ROOT,
            contextConversation?.mode === "work"
              ? "work-system.md"
              : "chat-system.md",
          ),
          "utf8",
        ).catch(() => ""),
        selectedSkillContext(
          actor,
          lastUserContextMessage?.selectedSkills || [],
        ).catch(() => ""),
      ]);
      const usage = conversationContextUsage(
        state,
        memoryDocument,
        conversationId,
        {
          systemText: contextSystemText,
          skillsText: contextSkillsText,
        },
      );
      const lastMeasuredWebUsage = [...(contextConversation?.messages || [])]
        .reverse()
        .find((message) => message.role === "assistant" && message.webContextUsage)
        ?.webContextUsage;
      const measuredKnowledgeTokens = Number(
        lastMeasuredWebUsage?.breakdown?.knowledge || 0,
      );
      if (measuredKnowledgeTokens > 0) {
        usage.breakdown.knowledge = measuredKnowledgeTokens;
        usage.used += measuredKnowledgeTokens;
        usage.ratio = usage.limit
          ? Math.min(1, usage.used / usage.limit)
          : 0;
      }
      const conversation = contextConversation;
      const bindings = await readAgentBindings(actor);
      const requestedServerId = String(
        url.searchParams.get("serverId") || conversation?.work?.serverId || "",
      );
      const requestedAgentId = String(
        url.searchParams.get("agentId") || conversation?.work?.agentId || "",
      );
      const binding = Object.values(bindings.bindings).find(
        (item) =>
          String(item?.conversationId || "") === conversationId &&
          (!requestedServerId || item?.serverId === requestedServerId) &&
          (!requestedAgentId || item?.agentId === requestedAgentId),
      );
      const nativeAgentContext = await inspectNativeAgentContext(actor, binding);
      const agentUsage = nativeAgentContext.usage || null;
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
          bound: Boolean(binding),
          available: nativeAgentContext.available,
          used: agentUsage
            ? Number(
                agentUsage.input ||
                  agentUsage.total ||
                  agentUsage.output ||
                  0,
              )
            : null,
          limit: null,
          ratio: null,
          modifiable: false,
          compressible: Boolean(nativeAgentContext.compression?.supported),
          status: nativeAgentContext.status,
          diagnostic: nativeAgentContext.diagnostic || "",
          binding: binding
            ? {
                serverId: binding.serverId,
                agentId: binding.agentId,
                agentSessionId: binding.agentSessionId,
                workspace: binding.workspace,
                updatedAt: binding.updatedAt,
              }
            : null,
        },
      });
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/context/settings") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
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
      sendJson(res, 200, { settings: document.contextSettings });
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
      const bindings = await readAgentBindings(actor);
      const binding = Object.values(bindings.bindings).find(
        (item) =>
          String(item?.conversationId || "") === conversationId &&
          (!serverId || String(item?.serverId || "") === serverId) &&
          (!agentId || String(item?.agentId || "") === agentId),
      );
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
      const email = normalizeEmail(body.email);
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 400, { error: "请输入有效邮箱" });
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
          if (records.some((item) => item.email === email)) {
            return { conflict: true };
          }
          const created = {
            id: crypto.randomUUID(),
            email,
            passwordHash: hashPassword(password),
            displayName: String(body.displayName || email.split("@")[0])
              .trim()
              .slice(0, 48),
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
          return { record: created };
        });
        if (result.conflict) {
          sendJson(res, 409, { error: "该邮箱已注册" });
          return;
        }
        record = result.record;
      } else {
        const records = await listUserRecords();
        record = records.find((item) => item.email === email);
        if (!record || !verifyPassword(password, record.passwordHash)) {
          sendJson(res, 401, { error: "邮箱或密码不正确" });
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
          email: record.email,
          avatar: record.avatar || undefined,
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
      const record = await readUserRecord(actor.id);
      if (!record) {
        sendJson(res, 404, { error: "账号不存在" });
        return;
      }
      record.displayName = String(body.displayName || record.displayName).trim().slice(0, 48);
      if (typeof body.avatar === "string" && body.avatar.length < 3_000_000) {
        record.avatar = body.avatar;
      }
      await writeUserRecord(record);
      sendJson(res, 200, {
        actor: {
          id: record.id,
          authenticated: true,
          displayName: record.displayName,
          email: record.email,
          avatar: record.avatar || undefined,
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

    if (
      req.method === "POST" &&
      ["/api/settings/provider/models", "/api/settings/embedding/models"].includes(
        url.pathname,
      )
    ) {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const secrets = await getSecrets(actor);
      const embeddingRequest = url.pathname.includes("/embedding/");
      const apiKey = String(
        body.apiKey ||
          (embeddingRequest ? secrets.embeddingApiKey : secrets.providerApiKey) ||
          "",
      );
      if (!apiKey) {
        sendJson(res, 400, { error: "请输入 API Key" });
        return;
      }
      const models = await listProviderModels(body.baseUrl, apiKey);
      const embeddingModels = models.filter((model) =>
        /(embedding|embed|bge|e5|gte|nomic|jina|m3)/i.test(model),
      );
      const chatModels = models.filter(
        (model) =>
          !/(embedding|embed|moderation|whisper|tts|dall-e|image|audio|transcrib|realtime)/i.test(
            model,
          ),
      );
      const available = embeddingRequest
        ? embeddingModels.length
          ? embeddingModels
          : models
        : chatModels.length
          ? chatModels
          : models;
      if (!available.length) {
        sendJson(res, 404, { error: "接口没有返回可用模型" });
        return;
      }
      sendJson(res, 200, { models: available });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/settings/provider/key") {
      const actor = await resolveActor(req, res);
      const secrets = await getSecrets(actor);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, { apiKey: String(secrets.providerApiKey || "") });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/provider") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      if (body.apiKey) await updateSecrets(actor, { providerApiKey: String(body.apiKey) });
      const currentState = await getState(actor);
      const currentProvider = currentState?.settings?.provider || {};
      const baseUrl = String(
        body.baseUrl || currentProvider.baseUrl || "https://api.openai.com/v1",
      );
      const modelWasProvided = Object.prototype.hasOwnProperty.call(body, "model");
      const provider = {
        name: String(body.name || currentProvider.name || "OpenAI Compatible"),
        baseUrl,
        model: modelWasProvided
          ? String(body.model || "")
          : baseUrl !== currentProvider.baseUrl
            ? ""
            : String(currentProvider.model || ""),
        protocol:
          body.protocol === "chat-completions" || body.protocol === "responses"
            ? body.protocol
            : currentProvider.protocol === "chat-completions" ||
                currentProvider.protocol === "responses"
              ? currentProvider.protocol
              : "auto",
        configured: Boolean(body.apiKey || (await getSecrets(actor)).providerApiKey),
      };
      await updateState(actor, (state) => {
        state.settings ||= {};
        state.settings.provider = provider;
        return state;
      });
      const shouldSyncManagedAgents = Boolean(body.apiKey) ||
        (Object.prototype.hasOwnProperty.call(body, "baseUrl") &&
          baseUrl !== currentProvider.baseUrl);
      if (shouldSyncManagedAgents) {
        void syncManagedOpenCodeForActor(actor).catch((caught) => {
          console.warn(
            `[EasyWork Agent] provider sync skipped: ${
              caught instanceof Error ? caught.message : "unknown error"
            }`,
          );
        });
      }
      sendJson(res, 200, { ok: true, provider });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings/provider/test") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const secrets = await getSecrets(actor);
      const apiKey = String(body.apiKey || secrets.providerApiKey || "");
      if (!apiKey) {
        sendJson(res, 400, { error: "缺少模型 API Key" });
        return;
      }
      const result = await callChatProvider(body, apiKey, "", { test: true });
      sendJson(res, 200, { ok: true, protocol: result.protocol });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/settings/embedding") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      if (body.apiKey) await updateSecrets(actor, { embeddingApiKey: String(body.apiKey) });
      const embedding = {
        baseUrl: String(body.baseUrl || "https://api.openai.com/v1"),
        model: String(body.model || "text-embedding-3-small"),
        dimensions: String(body.dimensions || ""),
        configured: Boolean(body.apiKey || (await getSecrets(actor)).embeddingApiKey),
        hybridEnabled: body.hybridEnabled !== false,
        rerankEnabled: Boolean(body.rerankEnabled),
      };
      await updateState(actor, (state) => {
        state.settings ||= {};
        state.settings.embedding = embedding;
        return state;
      });
      sendJson(res, 200, { ok: true, embedding });
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

    if (req.method === "POST" && url.pathname === "/api/settings/embedding/test") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const secrets = await getSecrets(actor);
      const apiKey = String(body.apiKey || secrets.embeddingApiKey || "");
      if (!apiKey) {
        sendJson(res, 400, { error: "缺少 Embedding API Key" });
        return;
      }
      const vectors = await callEmbedding(body, apiKey, "EasyWork connection test");
      sendJson(res, 200, { ok: true, dimensions: vectors[0]?.length || 0 });
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
      const state = await getState(actor);
      const result = await indexLibraryFile(
        actor,
        { id, name: String(body.name || name), type: String(body.type || "") },
        buffer,
        state,
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
    agentId: String(payload.agentId || "opencode"),
    projectId: payload.projectId ? String(payload.projectId) : undefined,
    memoryMode:
      payload.memoryMode === "project-only"
        ? "project-only"
        : "project-and-global",
    workspace: String(payload.workspace || "~"),
    prompt: String(payload.prompt || ""),
    firstTurn: Boolean(payload.firstTurn),
    userMessageId: String(payload.userMessageId || `${payload.runId}_user`),
    assistantMessageId: String(
      payload.assistantMessageId || `${payload.runId}_assistant`,
    ),
    branchId: String(payload.branchId || payload.conversationId || ""),
    logicalWorkspaceId: String(payload.logicalWorkspaceId || ""),
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
    if (existingIndex >= 0) task.events[existingIndex] = incoming;
    else task.events.push(incoming);
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
  recordWorkerEvent(session, payload);
  sessionSend(session, payload);
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
          workspace: task.workspace,
          workspaceMode: task.workspaceMode,
          logicalWorkspaceId: task.logicalWorkspaceId,
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
      workspace: task.workspace,
      workspaceMode: task.workspaceMode,
      logicalWorkspaceId: task.logicalWorkspaceId,
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
    await appendOpenCodeInstruction(
      session,
      activeRun.agentControl,
      instruction.content,
    );
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
      stream.on("data", (chunk) => {
        stdout += chunk.toString();
        options.onStdout?.(chunk.toString());
      });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        options.onStderr?.(chunk.toString());
      });
      stream.on("close", (code, signal) => {
        const result = { code: Number(code || 0), signal, stdout, stderr };
        if (code && !options.allowFailure) {
          const failure = new Error(stderr.trim() || `远端命令退出码 ${code}`);
          failure.result = result;
          reject(failure);
        } else {
          resolve(result);
        }
      });
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
  const serviceId = crypto
    .createHash("sha256")
    .update(String(agent.path || agent.id || "opencode"))
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
      'case "$EW_COMMAND" in *"$EW_AGENT"*" serve"*) kill "$EW_PID" 2>/dev/null || true ;; esac',
      'rm -f "$EW_PID_FILE"',
    ].join("\n"),
    { allowFailure: true },
  );
  session.openCodeServices?.delete(agent.id);
  session.openCodeServicePromises?.delete(agent.id);
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
  const cached = session.openCodeServices?.get(agent.id);
  const live = await probeOpenCodeService(session, cached || paths);
  if (live) {
    session.openCodeServices.set(agent.id, live);
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
  const launcher = [
    "#!/bin/sh",
    "set -eu",
    `EW_ROOT=${shellQuote(paths.root)}`,
    `EW_PID_FILE=${shellQuote(paths.pidPath)}`,
    `EW_PASSWORD_FILE=${shellQuote(paths.passwordPath)}`,
    `EW_AGENT=${shellQuote(agent.path)}`,
    `EW_PORT=${shellQuote(String(port))}`,
    'umask 077',
    'printf "%s\\n" "$$" > "$EW_PID_FILE.tmp"',
    'mv -f "$EW_PID_FILE.tmp" "$EW_PID_FILE"',
    'export OPENCODE_SERVER_USERNAME=opencode',
    'export OPENCODE_SERVER_PASSWORD="$(cat "$EW_PASSWORD_FILE")"',
    'exec "$EW_AGENT" serve --hostname 127.0.0.1 --port "$EW_PORT" --log-level WARN',
  ].join("\n");
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await probeOpenCodeService(session, descriptor);
    if (ready) {
      session.openCodeServices.set(agent.id, ready);
      return ready;
    }
    await waitFor(250);
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
  const current = session.openCodeServicePromises.get(agent.id);
  if (current) return current;
  const operation = startOpenCodeService(session, agent);
  session.openCodeServicePromises.set(agent.id, operation);
  try {
    return await operation;
  } finally {
    if (session.openCodeServicePromises.get(agent.id) === operation) {
      session.openCodeServicePromises.delete(agent.id);
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

async function inspectNativeAgentContext(actor, binding) {
  if (!binding) {
    return {
      bound: false,
      available: false,
      status: "not-bound",
      usage: null,
      compression: { supported: false },
    };
  }
  if (binding.agentId !== "opencode") {
    return {
      bound: true,
      available: false,
      status: "unsupported-agent",
      usage: null,
      compression: { supported: false },
    };
  }
  const worker = await getSshWorker(actor);
  const session = worker.sessions.get(safeSegment(binding.serverId || ""));
  if (!session?.client || session.status !== "connected") {
    return {
      bound: true,
      available: false,
      status: "connection-unavailable",
      usage: null,
      compression: { supported: false },
    };
  }
  try {
    const agents = await scanRemoteAgents(session, actor);
    const agent = agents.find(
      (item) => item.id === binding.agentId && item.status === "ready",
    );
    if (!agent) throw new Error("绑定的 Agent 当前不可用");
    const service = await ensureOpenCodeService(session, agent);
    await openCodeServiceRequest(session, service, {
      endpoint: `/session/${encodeURIComponent(binding.agentSessionId)}`,
      directory: binding.workspace,
    });
    const capabilities = await detectOpenCodeContextCapabilities(session, service);
    let usage = null;
    try {
      const response = await openCodeServiceRequest(session, service, {
        endpoint: `/session/${encodeURIComponent(binding.agentSessionId)}/message`,
        directory: binding.workspace,
      });
      usage = openCodeUsageFromMessages(response.json);
    } catch {
      usage = binding.contextUsage || null;
    }
    return {
      bound: true,
      available: Boolean(usage),
      status: usage ? "measured" : "usage-unavailable",
      usage,
      compression: capabilities.compression,
      control: { session, service },
    };
  } catch (caught) {
    return {
      bound: true,
      available: false,
      status: "unreadable",
      diagnostic:
        caught instanceof Error ? caught.message : "无法读取 Agent 上下文",
      usage: null,
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

function openCodeSseToolPart(value, { sessionId, directory } = {}) {
  let envelope;
  try {
    envelope = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  const event = envelope?.payload;
  if (!event || event.type !== "message.part.updated") return null;
  const properties = event.properties || {};
  if (String(properties.sessionID || "") !== String(sessionId || "")) {
    return null;
  }
  if (
    envelope.directory &&
    directory &&
    String(envelope.directory) !== String(directory)
  ) {
    return null;
  }
  const part = properties.part;
  if (!part || part.type !== "tool") return null;
  return {
    sessionID: properties.sessionID,
    part,
  };
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

async function cancelRemoteRuntimeRun(session, activeRun) {
  if (!session.client || !activeRun?.remoteRun?.runtime) return false;
  activeRun.abortRequested = true;
  await remoteExec(
    session.client,
    `${shellQuote(activeRun.remoteRun.runtime.entrypoint)} run-cancel ${shellQuote(activeRun.remoteRun.runId)}`,
    { allowFailure: true },
  );
  if (activeRun.agentControl?.adapter === "opencode") {
    await abortOpenCodeSession(session, activeRun.agentControl);
  }
  return true;
}

function reconstructOpenCodeTranscript(stdout, runId) {
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
    const parsed = parseOpenCodeLine(line, parserState);
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
  const reconstructed = reconstructOpenCodeTranscript(result.stdout, task.runId);
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
      workspace,
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
      workspace,
      agentId: task.agentId,
      agentSessionId: reconstructed.sessionId,
      lastRunId: task.runId,
      syncMode: "recovered",
      syncCursor:
        result.status === "done" && !recoveredWasAborted
          ? createAgentSyncCursor({
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
            })
          : previousBinding?.syncCursor || {
              memoryEnabled: state?.settings?.memoryEnabled !== false,
              memoryVersions: {},
              deliveredContentHashes: [],
              lastMessageId: "",
            },
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
      conversationId: task.conversationId,
      runId: task.runId,
      workspace: task.workspace,
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
  if (input === "~") return session.home;
  if (input.startsWith("~/")) return path.posix.join(session.home, input.slice(2));
  if (input.startsWith("/")) return path.posix.normalize(input);
  return path.posix.join(session.home, input);
}

async function ensureTaskWorkspace(session, task, workspace) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const managedPrefix = `${session.home}/.easywork/workspaces/`;
  const requestedManaged =
    task.workspaceMode === "managed" && workspace.startsWith(managedPrefix);
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

async function createWorkspaceCheckpoint(session, actor, task, phase) {
  const checkpointId = checkpointIdForTask(task, phase);
  const workspace = remotePathForSession(session, task.workspace || "~");
  const conversationSegment = safeSegment(task.conversationId, "conversation");
  const checkpointRoot = `${session.home}/.easywork/checkpoints/${conversationSegment}`;
  const bundlePath = `${checkpointRoot}/${checkpointId}.bundle`;
  const metadataPath = `${checkpointRoot}/${checkpointId}.json`;
  const temporaryIndex = `${session.home}/.easywork/tmp/${checkpointId}.index`;
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
      `EW_BUNDLE=${shellQuote(bundlePath)}`,
      `EW_BUNDLE_TMP=${shellQuote(temporaryBundle)}`,
      `EW_INDEX=${shellQuote(temporaryIndex)}`,
      `EW_REF=${shellQuote(refName)}`,
      'EW_EASYWORK="$HOME/.easywork"',
      'mkdir -p "$EW_ROOT" "$HOME/.easywork/tmp"',
      'if ! test -d "$EW_DIR"; then echo "MODE=missing"; exit 0; fi',
      'if ! command -v git >/dev/null 2>&1; then echo "MODE=unmanaged"; exit 0; fi',
      'EW_REPO="$(cd "$EW_DIR" && git rev-parse --show-toplevel 2>/dev/null)" || { echo "MODE=unmanaged"; exit 0; }',
      'EW_GIT_DIR="$(cd "$EW_REPO" && git rev-parse --git-dir)"',
      'case "$EW_GIT_DIR" in /*) ;; *) EW_GIT_DIR="$EW_REPO/$EW_GIT_DIR" ;; esac',
      'EW_INDEX_SOURCE="$EW_GIT_DIR/index"',
      'rm -f "$EW_INDEX" "$EW_BUNDLE_TMP"',
      'if test -f "$EW_INDEX_SOURCE"; then cp "$EW_INDEX_SOURCE" "$EW_INDEX"; else (cd "$EW_REPO" && GIT_INDEX_FILE="$EW_INDEX" git read-tree --empty); fi',
      'trap \'rm -f "$EW_INDEX" "$EW_BUNDLE_TMP"; (cd "$EW_REPO" && git update-ref -d "$EW_REF" >/dev/null 2>&1) || true\' EXIT HUP INT TERM',
      '(cd "$EW_REPO" && GIT_INDEX_FILE="$EW_INDEX" git add -A -- .)',
      'case "$EW_EASYWORK/" in "$EW_REPO"/*) EW_REL="${EW_EASYWORK#"$EW_REPO"/}"; (cd "$EW_REPO" && GIT_INDEX_FILE="$EW_INDEX" git rm -r -q --cached --ignore-unmatch -- "$EW_REL") ;; esac',
      'EW_TREE="$(cd "$EW_REPO" && GIT_INDEX_FILE="$EW_INDEX" git write-tree)"',
      'EW_COMMIT="$(cd "$EW_REPO" && printf "%s\\n" "EasyWork checkpoint" | env GIT_AUTHOR_NAME=EasyWork GIT_AUTHOR_EMAIL=runtime@easywork.local GIT_COMMITTER_NAME=EasyWork GIT_COMMITTER_EMAIL=runtime@easywork.local git commit-tree "$EW_TREE")"',
      '(cd "$EW_REPO" && git update-ref "$EW_REF" "$EW_COMMIT")',
      '(cd "$EW_REPO" && git bundle create "$EW_BUNDLE_TMP" "$EW_REF" >/dev/null)',
      'mv -f "$EW_BUNDLE_TMP" "$EW_BUNDLE"',
      'chmod 600 "$EW_BUNDLE"',
      'echo "MODE=git"',
      'echo "REPO_ROOT=$EW_REPO"',
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
    logicalWorkspaceId:
      task.logicalWorkspaceId ||
      crypto.createHash("sha256").update(`${task.serverId}:${workspace}`).digest("hex").slice(0, 24),
    workspace,
    workspaceMode:
      mode === "git"
        ? workspace.startsWith(`${session.home}/.easywork/worktrees/`) ||
          workspace.startsWith(`${session.home}/.easywork/workspaces/`)
          ? "managed"
          : "attached"
        : "unmanaged",
    status: mode === "git" ? "available" : "unavailable",
    repoRoot: fields.REPO_ROOT || undefined,
    snapshotCommit: fields.COMMIT || undefined,
    snapshotRef: fields.REF || undefined,
    remoteBundlePath: fields.BUNDLE || undefined,
    remoteMetadataPath: metadataPath,
    exclusions:
      mode === "git"
        ? ["ignored files", "dirty submodule contents", "workspace-external effects"]
        : ["non-Git workspace", "workspace-external effects"],
    diagnostic:
      mode === "git"
        ? ""
        : String(result.stderr || "未检测到可快照的 Git 工作区").trim().slice(0, 1_000),
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
      'echo "WORKSPACE=$EW_TARGET"',
      'echo "COMMIT=$(cd "$EW_TARGET" && git rev-parse HEAD)"',
    ].join("\n"),
  );
  const fields = parseRuntimeFields(result.stdout);
  if (!fields.WORKSPACE || fields.WORKSPACE !== target) {
    throw new Error("工作区快照恢复结果无法验证");
  }
  return {
    workspace: target,
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
    logicalWorkspaceId,
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
      logicalWorkspaceId &&
      [pair.before.logicalWorkspaceId, pair.after.logicalWorkspaceId].some(
        (value) => value && String(value) !== String(logicalWorkspaceId),
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
      logicalWorkspaceId,
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
  const commands = [
    "set -eu",
    `EW_PREVIEW=${shellQuote(preview.workspace)}`,
    `EW_ACTUAL=${shellQuote(currentCheckpoint.repoRoot || workspace)}`,
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
        `(cd "$EW_PREVIEW" && git diff --binary --no-ext-diff ${shellQuote(afterRef)} ${shellQuote(beforeRef)} -- . > ${shellQuote(patchPath)})`,
        `if test -s ${shellQuote(patchPath)}; then (cd "$EW_PREVIEW" && git apply --check ${shellQuote(patchPath)} && git apply ${shellQuote(patchPath)}); fi`,
      );
    });
  const combinedPatch = `${tempRoot}/combined.patch`;
  commands.push(
    `(cd "$EW_PREVIEW" && git diff --binary --no-ext-diff HEAD -- . > ${shellQuote(combinedPatch)})`,
    '(cd "$EW_PREVIEW" && git diff --name-only HEAD -- .)',
    `if test -s ${shellQuote(combinedPatch)}; then (cd "$EW_ACTUAL" && git apply --check ${shellQuote(combinedPatch)}); fi`,
    `if test -s ${shellQuote(combinedPatch)}; then (cd "$EW_ACTUAL" && git apply ${shellQuote(combinedPatch)}); fi`,
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
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.configured || !provider.model || !secrets.providerApiKey) {
    return fallbackConversationTitle(prompt);
  }
  const titlePrompt = await renderPromptTemplate("tasks/conversation-title.md", {
    USER_PROMPT: String(prompt || "").slice(0, 1_500),
    ASSISTANT_RESPONSE: String(response || "").slice(0, 1_500),
  });
  try {
    const { payload } = await callChatProvider(
      provider,
      secrets.providerApiKey,
      titlePrompt,
    );
    return normalizeConversationTitle(extractModelText(payload), prompt);
  } catch {
    return fallbackConversationTitle(prompt);
  }
}

async function agentPromptWithNativePlanning(context, webHandoff = "") {
  const agentBrief = webHandoff
    ? await renderPromptTemplate("web/agent-brief.md", {
        CONTENT: webHandoff,
      })
    : "";
  const [agentSystem, eventProtocol] = await Promise.all([
    renderPromptTemplate("agents/common.md"),
    renderPromptTemplate("agents/protocol.md"),
  ]);
  return renderPromptTemplate("agents/opencode.md", {
    AGENT_SYSTEM: agentSystem,
    SYNC_CONTEXT:
      typeof context === "string" ? context : String(context?.text || ""),
    AGENT_BRIEF: agentBrief,
    EVENT_PROTOCOL: eventProtocol,
  });
}

function formatAgentDelta(delta) {
  if (!delta?.messages?.length) return "";
  return delta.messages
    .map((message) => {
      const speaker = message.role === "user" ? "用户" : "EasyWork";
      const agent = message.agentId ? ` / Agent ${message.agentId}` : "";
      return `${speaker}${agent}：${message.content}`;
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
  return candidates.filter(
    (record) =>
      !binding?.agentSessionId ||
      Number(record.revision || 0) > Number(versions[record.id] || 0),
  );
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

function deterministicWorkHandoff(context, memoryDelta = context.memoryRecords) {
  const sections = [
    `## 本轮用户原文\n\n${context.sections.request}`,
    memoryDelta.length
      ? `## 与本轮相关的新记忆\n\n${formatMemoryContext(memoryDelta)}`
      : "",
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
  };
}

function agentConfigFor(adapter, home) {
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
  if (adapter === "qwen") {
    return {
      configPath: `${home}/.qwen/settings.json`,
      dataPath: `${home}/.qwen`,
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
  const openCode = adapter === "opencode" && available;
  return {
    liveInput: openCode && liveControl,
    nativeAbort: openCode && liveControl,
    resumeSession: openCode,
    nativePlanning: openCode,
    workspaceCheckpoint: true,
  };
}

function remoteAgentRegistryPath(actor) {
  return path.join(actorDirectory(actor), "runtime", "remote-agents.json");
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
  const defaults = agentConfigFor("opencode", session.home);
  const jsonPath = agent.configPath || defaults.configPath;
  const jsoncPath = agent.alternateConfigPath || defaults.alternateConfigPath;
  const authPath = `${session.home}/.local/share/opencode/auth.json`;
  const jsonBuffer = await remoteSftpReadOptional(session.client, jsonPath);
  const jsoncBuffer = await remoteSftpReadOptional(session.client, jsoncPath);
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
    configContent,
    authContent,
    ...openCodeConfigurationStatus(configContent, authContent, {
      managed: Boolean(agent.managed),
    }),
  };
}

async function scanRemoteAgents(session, actor) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const liveControlCheck = await remoteExec(
    session.client,
    "command -v curl >/dev/null 2>&1 && command -v setsid >/dev/null 2>&1",
    { allowFailure: true },
  );
  const liveControlAvailable = liveControlCheck.code === 0;
  const command = [
    "set +e",
    'managed_opencode="$HOME/.easywork/agents/opencode/bin/opencode"',
    'user_opencode="$HOME/.opencode/bin/opencode"',
    'system_opencode="$(command -v opencode 2>/dev/null)"',
    'if [ -x "$managed_opencode" ]; then printf "opencode\\t%s\\t%s\\t%s\\topencode\\n" "$HOME/.easywork/agents/opencode" "$managed_opencode" "$("$managed_opencode" --version 2>/dev/null | head -n 1)"; fi',
    'if [ -x "$user_opencode" ]; then printf "opencode-user\\t%s\\t%s\\t%s\\topencode\\n" "$HOME/.opencode" "$user_opencode" "$("$user_opencode" --version 2>/dev/null | head -n 1)"; fi',
    'if [ -n "$system_opencode" ] && [ -x "$system_opencode" ]; then printf "opencode-system\\t%s\\t%s\\t%s\\topencode\\n" "$(dirname "$system_opencode")" "$system_opencode" "$("$system_opencode" --version 2>/dev/null | head -n 1)"; fi',
    'for spec in "qwen:$HOME:$(command -v qwen 2>/dev/null):qwen" "claude:$HOME:$(command -v claude 2>/dev/null):claude"; do',
    '  id="${spec%%:*}"; rest="${spec#*:}"; folder="${rest%%:*}"; rest="${rest#*:}"; bin="${rest%%:*}"; adapter="${rest##*:}";',
    '  if [ -n "$bin" ] && [ -x "$bin" ]; then ver="$("$bin" --version 2>/dev/null | head -n 1)"; printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$id" "$folder" "$bin" "$ver" "$adapter"; fi',
    "done",
  ].join("\n");
  const result = await remoteExec(session.client, command, { allowFailure: true });
  const discovered = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, folder, binaryPath, version, adapter = "plain"] = line.split("\t");
      const isOpenCode = adapter === "opencode";
      const config = agentConfigFor(adapter, session.home);
      return {
        id,
        name: isOpenCode ? "OpenCode" : adapter === "qwen" ? "Qwen Code" : "Claude Code",
        folder,
        path: binaryPath,
        version: version || undefined,
        status: isOpenCode ? "ready" : "needs-adapter",
        adapter,
        managed: folder.includes("/.easywork/agents/opencode"),
        capabilities: agentRuntimeCapabilities(
          adapter,
          isOpenCode ? "ready" : "needs-adapter",
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
    if (binaryResult.code !== 0) continue;
    discovered.push({
      ...stored,
      version: binaryResult.stdout.trim() || stored.version,
      status: stored.adapter === "opencode" ? "ready" : "needs-adapter",
      capabilities: agentRuntimeCapabilities(
        stored.adapter,
        stored.adapter === "opencode" ? "ready" : "needs-adapter",
        { liveControl: liveControlAvailable },
      ),
    });
  }

  for (const agent of discovered) {
    if (agent.adapter === "opencode") {
      const configuration = await inspectOpenCodeNativeConfiguration(
        session,
        agent,
      );
      agent.configured = configuration.configured;
      agent.configPath = configuration.configPath;
      agent.model = configuration.model || undefined;
      if (configuration.error) agent.configurationError = configuration.error;
    } else {
      const configCheck = agent.configPath
        ? await remoteExec(
            session.client,
            `test -s ${shellQuote(agent.configPath)}`,
            { allowFailure: true },
          )
        : { code: 1 };
      agent.configured = configCheck.code === 0;
    }
    delete agent.alternateConfigPath;
  }

  if (!discovered.some((agent) => agent.adapter === "opencode")) {
    discovered.unshift({
      id: "opencode",
      name: "OpenCode",
      folder: "~/.easywork/agents/opencode",
      path: "~/.easywork/agents/opencode/bin/opencode",
      status: "missing",
      adapter: "opencode",
      managed: true,
      configured: false,
      capabilities: agentRuntimeCapabilities("opencode", "missing", {
        liveControl: liveControlAvailable,
      }),
      ...agentConfigFor("opencode", session.home),
    });
  }
  return discovered;
}

async function ensureOpenCodeNativeConfig(
  session,
  actor,
  onProgress = () => undefined,
  modelOverride = "",
) {
  const state = await getState(actor);
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.baseUrl || !secrets.providerApiKey) {
    return {
      configured: false,
      changed: false,
      reason: "missing-provider",
    };
  }
  onProgress("network", "检测远端模型 API 连接");
  const providerRoute = await ensureRemoteProviderRoute(session, provider);
  const configuration = await inspectOpenCodeNativeConfiguration(session, {
    ...agentConfigFor("opencode", session.home),
    managed: true,
  });
  const selectedModel = String(
    modelOverride || configuration.model || provider.model || "",
  ).trim();
  if (!selectedModel) {
    return {
      configured: false,
      changed: false,
      reason: "missing-model",
      configPath: configuration.configPath,
    };
  }
  const effectiveProvider = {
    ...provider,
    baseUrl: providerRoute.baseUrl,
    model: selectedModel,
  };
  const nextConfig = mergeOpenCodeConfigContent(
    configuration.configContent,
    effectiveProvider,
  );
  const nextAuth = mergeOpenCodeAuthContent(
    configuration.authContent,
    secrets.providerApiKey,
  );
  const configChanged = nextConfig !== configuration.configContent;
  const authChanged = nextAuth !== configuration.authContent;
  if (!configChanged && !authChanged) {
    return {
      configured: true,
      changed: false,
      configPath: configuration.configPath,
      model: `${EASYWORK_OPENCODE_PROVIDER_ID}/${selectedModel}`,
      route: providerRoute.mode,
    };
  }
  onProgress("configure", "同步 OpenCode 原生模型配置");
  await remoteExec(
    session.client,
    [
      `mkdir -p ${shellQuote(path.posix.dirname(configuration.configPath))}`,
      `mkdir -p ${shellQuote(path.posix.dirname(configuration.authPath))}`,
    ].join(" && "),
  );
  if (configChanged) {
    await remoteSftpWriteAtomic(
      session.client,
      configuration.configPath,
      nextConfig,
      0o600,
    );
  }
  if (authChanged) {
    await remoteSftpWriteAtomic(
      session.client,
      configuration.authPath,
      nextAuth,
      0o600,
    );
  }
  if (configChanged) {
    await stopOpenCodeService(session, {
      id: "opencode",
      path: `${session.home}/.easywork/agents/opencode/bin/opencode`,
    });
  }
  return {
    configured: true,
    changed: true,
    configPath: configuration.configPath,
    model: `${EASYWORK_OPENCODE_PROVIDER_ID}/${selectedModel}`,
    route: providerRoute.mode,
  };
}

async function configureOpenCodeModel(
  session,
  actor,
  payload,
  onProgress = () => undefined,
) {
  const agent = await agentForSession(session, actor, payload.agentId);
  if (agent.adapter !== "opencode" || agent.status !== "ready") {
    throw new Error("当前 Agent 不是可配置的 OpenCode");
  }
  const model = String(payload.model || "").trim();
  if (!model) throw new Error("请选择一个模型");
  const state = await getState(actor);
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.baseUrl || !secrets.providerApiKey) {
    throw new Error("请先在个人资料中配置 API URL 和 API Key");
  }
  onProgress("正在核对模型");
  const availableModels = await listProviderModels(
    provider.baseUrl,
    secrets.providerApiKey,
  );
  if (!availableModels.includes(model)) {
    throw new Error("当前 API 已不再返回所选模型，请重新检测");
  }
  onProgress("正在写入 OpenCode 原生配置");
  const result = await ensureOpenCodeNativeConfig(
    session,
    actor,
    (_stage, label) => onProgress(label),
    model,
  );
  if (!result.configured) throw new Error("OpenCode 配置未完成");
  return {
    model,
    configPath: result.configPath,
    agents: await scanRemoteAgents(session, actor),
  };
}

async function prepareRemoteAgents(
  session,
  actor,
  onProgress = () => undefined,
) {
  let agents = await scanRemoteAgents(session, actor);
  const managedOpenCode = agents.find(
    (agent) =>
      agent.adapter === "opencode" &&
      agent.status === "ready" &&
      agent.managed,
  );
  if (managedOpenCode) {
    await ensureOpenCodeNativeConfig(session, actor, onProgress);
    agents = await scanRemoteAgents(session, actor);
  }
  return agents;
}

async function publishRemoteAgentScan(
  session,
  actor,
  send = (payload) => sessionSend(session, payload),
) {
  send({
    type: "agent.scan.status",
    serverId: session.serverId,
    status: "scanning",
  });
  try {
    const agents = await prepareRemoteAgents(session, actor);
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

async function syncManagedOpenCodeForActor(actor) {
  const worker = await getSshWorker(actor);
  const sessions = [...worker.sessions.values()].filter(
    (session) =>
      session.status === "connected" &&
      session.client &&
      !session.demo &&
      !session.activeStream &&
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

async function readRemoteOpenCodeTarget(session) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const result = await remoteExec(
    session.client,
    [
      'EW_OS="$(uname -s | tr "[:upper:]" "[:lower:]")"',
      'EW_ARCH="$(uname -m)"',
      'case "$EW_ARCH" in x86_64) EW_ARCH=x64 ;; aarch64|arm64) EW_ARCH=arm64 ;; esac',
      'EW_MUSL=0; if test -f /etc/alpine-release || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then EW_MUSL=1; fi',
      'EW_BASELINE=0; if test "$EW_ARCH" = x64 && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then EW_BASELINE=1; fi',
      'printf "os=%s\\narch=%s\\nmusl=%s\\nbaseline=%s\\n" "$EW_OS" "$EW_ARCH" "$EW_MUSL" "$EW_BASELINE"',
    ].join("\n"),
  );
  const fields = Object.fromEntries(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.split("="))
      .filter((parts) => parts.length === 2),
  );
  if (fields.os !== "linux" || !["x64", "arm64"].includes(fields.arch)) {
    throw new Error(`OpenCode 暂不支持该服务器平台：${fields.os || "未知"}/${fields.arch || "未知"}`);
  }
  let target = `linux-${fields.arch}`;
  if (fields.baseline === "1") target += "-baseline";
  if (fields.musl === "1") target += "-musl";
  return target;
}

async function fetchOpenCodeRelease() {
  if (openCodeReleaseCache?.expiresAt > Date.now()) return openCodeReleaseCache.value;
  let response;
  try {
    response = await fetch(
      "https://api.github.com/repos/anomalyco/opencode/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "EasyWork-Agent-Installer",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch (caught) {
    throw new Error(`EasyWork 主机无法查询 OpenCode 版本：${caught instanceof Error ? caught.message : "网络错误"}`);
  }
  if (!response.ok) {
    throw new Error(`EasyWork 主机查询 OpenCode 版本失败（HTTP ${response.status}）`);
  }
  const payload = await response.json();
  const version = String(payload?.tag_name || "").replace(/^v/i, "");
  const assets = Array.isArray(payload?.assets)
    ? payload.assets.map((asset) => ({
        name: String(asset?.name || ""),
        url: String(asset?.browser_download_url || ""),
        size: Number(asset?.size || 0),
        digest: String(asset?.digest || ""),
      }))
    : [];
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(version) || !assets.length) {
    throw new Error("OpenCode 最新版本信息格式无效");
  }
  const value = { version, assets };
  openCodeReleaseCache = { expiresAt: Date.now() + 5 * 60 * 1000, value };
  return value;
}

async function hashLocalFile(filePath) {
  const content = await readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function prepareOpenCodeArtifact(session, onProgress = () => undefined) {
  const [target, release] = await Promise.all([
    readRemoteOpenCodeTarget(session),
    fetchOpenCodeRelease(),
  ]);
  const assetName = `opencode-${target}.tar.gz`;
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset?.url) throw new Error(`OpenCode ${release.version} 没有 ${assetName} 构建`);
  const digest = asset.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  if (!digest) throw new Error("OpenCode 发布包缺少可验证的 SHA-256 摘要");
  const cacheDirectory = path.join(
    DATA_ROOT,
    "_cache",
    "opencode",
    safeSegment(release.version),
  );
  const localPath = path.join(cacheDirectory, assetName);
  const promiseKey = `${release.version}:${assetName}:${digest}`;
  let preparation = openCodeArtifactPromises.get(promiseKey);
  if (!preparation) {
    preparation = (async () => {
      await mkdir(cacheDirectory, { recursive: true });
      try {
        if ((await hashLocalFile(localPath)) === digest) return localPath;
      } catch {
        // Missing or incomplete cache entries are downloaded again below.
      }
      onProgress("download", "EasyWork 主机正在下载 OpenCode");
      let response;
      try {
        response = await fetch(asset.url, {
          headers: { "User-Agent": "EasyWork-Agent-Installer" },
          redirect: "follow",
          signal: AbortSignal.timeout(5 * 60 * 1000),
        });
      } catch (caught) {
        throw new Error(`EasyWork 主机下载 OpenCode 失败：${caught instanceof Error ? caught.message : "网络错误"}`);
      }
      if (!response.ok) {
        throw new Error(`EasyWork 主机下载 OpenCode 失败（HTTP ${response.status}）`);
      }
      const content = Buffer.from(await response.arrayBuffer());
      const actualDigest = crypto.createHash("sha256").update(content).digest("hex");
      if (actualDigest !== digest) {
        throw new Error("OpenCode 发布包校验失败，未向服务器上传");
      }
      await writeFile(localPath, content, { mode: 0o600 });
      return localPath;
    })().finally(() => openCodeArtifactPromises.delete(promiseKey));
    openCodeArtifactPromises.set(promiseKey, preparation);
  }
  return {
    target,
    version: release.version,
    asset,
    digest,
    localPath: await preparation,
  };
}

async function uploadOpenCodeArtifact(
  session,
  artifact,
  onProgress = () => undefined,
  { candidateOnly = false } = {},
) {
  if (!session.client || !session.home) throw new Error("SSH 尚未连接");
  const agentRoot = `${session.home}/.easywork/agents/opencode`;
  const uploadRoot = `${agentRoot}/.incoming-${crypto.randomBytes(6).toString("hex")}`;
  const remoteArchive = `${uploadRoot}/${artifact.asset.name}`;
  await remoteExec(
    session.client,
    `mkdir -p ${shellQuote(uploadRoot)} ${shellQuote(`${agentRoot}/bin`)}`,
  );
  try {
    onProgress("upload", "正在上传 OpenCode 到服务器");
    await remoteSftpFastPut(
      session.client,
      artifact.localPath,
      remoteArchive,
      (percent) => onProgress("upload", `正在上传 OpenCode · ${percent}%`),
    );
    onProgress("verify", "正在校验 OpenCode");
    const destination = candidateOnly
      ? `${agentRoot}/.update-candidate/opencode`
      : `${agentRoot}/bin/opencode`;
    await remoteExec(
      session.client,
      [
        "set -eu",
        `EW_ROOT=${shellQuote(uploadRoot)}`,
        `EW_ARCHIVE=${shellQuote(remoteArchive)}`,
        `EW_EXPECTED=${shellQuote(artifact.digest)}`,
        `EW_DESTINATION=${shellQuote(destination)}`,
        'if command -v sha256sum >/dev/null 2>&1; then EW_ACTUAL="$(sha256sum "$EW_ARCHIVE" | awk \'{print $1}\')"; elif command -v openssl >/dev/null 2>&1; then EW_ACTUAL="$(openssl dgst -sha256 "$EW_ARCHIVE" | awk \'{print $NF}\')"; else echo "服务器缺少 SHA-256 校验工具" >&2; exit 1; fi',
        'test "$EW_ACTUAL" = "$EW_EXPECTED"',
        'mkdir -p "$EW_ROOT/unpacked" "$(dirname "$EW_DESTINATION")"',
        'tar -xzf "$EW_ARCHIVE" -C "$EW_ROOT/unpacked"',
        'test -x "$EW_ROOT/unpacked/opencode" || chmod 755 "$EW_ROOT/unpacked/opencode"',
        '"$EW_ROOT/unpacked/opencode" --version >/dev/null',
        'mv -f "$EW_ROOT/unpacked/opencode" "$EW_DESTINATION.new"',
        'chmod 755 "$EW_DESTINATION.new"',
        'mv -f "$EW_DESTINATION.new" "$EW_DESTINATION"',
        '"$EW_DESTINATION" --version',
      ].join("\n"),
    );
  } finally {
    await remoteExec(session.client, `rm -rf ${shellQuote(uploadRoot)}`, {
      allowFailure: true,
    }).catch(() => undefined);
  }
}

async function installOpenCode(session, actor, onProgress = () => undefined) {
  if (!session.client) throw new Error("SSH 尚未连接");
  let existingAgents = await scanRemoteAgents(session, actor);
  let existingOpenCode = existingAgents.find(
    (agent) =>
      agent.adapter === "opencode" &&
      agent.status === "ready" &&
      agent.managed,
  );
  if (existingOpenCode) {
    await ensureOpenCodeNativeConfig(session, actor, onProgress);
    return scanRemoteAgents(session, actor);
  }
  existingOpenCode = existingAgents.find(
    (agent) => agent.adapter === "opencode" && agent.status === "ready",
  );
  if (existingOpenCode) return existingAgents;

  onProgress("prepare", "正在识别服务器环境");
  const artifact = await prepareOpenCodeArtifact(session, onProgress);
  await uploadOpenCodeArtifact(session, artifact, onProgress);
  await ensureOpenCodeNativeConfig(session, actor, onProgress);
  onProgress("verify", "验证 Agent");
  return scanRemoteAgents(session, actor);
}

function normalizeOpenCodeVersion(value) {
  const match = String(value || "").match(/\bv?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)\b/i);
  return match?.[1] || String(value || "").trim().split(/\s+/)[0] || "";
}

function openCodeUpdateApplyCommand() {
  return [
    "set -eu",
    'EW_AGENT_ROOT="$HOME/.easywork/agents/opencode"',
    'EW_CURRENT="$EW_AGENT_ROOT/bin/opencode"',
    'EW_CANDIDATE="$EW_AGENT_ROOT/.update-candidate/opencode"',
    'EW_BACKUP="$EW_AGENT_ROOT/bin/opencode.easywork-backup"',
    'test -x "$EW_CURRENT"',
    'test -x "$EW_CANDIDATE"',
    'cp -p "$EW_CURRENT" "$EW_BACKUP"',
    'if cp "$EW_CANDIDATE" "$EW_CURRENT" && chmod 755 "$EW_CURRENT" && "$EW_CURRENT" --version; then',
    '  rm -f "$EW_BACKUP"',
    '  rm -rf "$EW_AGENT_ROOT/.update-candidate"',
    "else",
    '  cp -p "$EW_BACKUP" "$EW_CURRENT"',
    '  rm -f "$EW_BACKUP"',
    '  exit 1',
    "fi",
  ].join("\n");
}

async function checkOpenCodeUpdate(
  session,
  actor,
  onProgress = () => undefined,
) {
  if (!session.client) throw new Error("SSH 尚未连接");
  if (session.activeStream || session.activeRuns?.size) {
    throw new Error("请等待当前远程任务结束后再检测更新");
  }
  const agents = await scanRemoteAgents(session, actor);
  const openCode = agents.find(
    (agent) =>
      agent.adapter === "opencode" &&
      agent.status === "ready" &&
      agent.managed,
  );
  if (!openCode) throw new Error("只能自动更新由 EasyWork 部署的 OpenCode");
  onProgress("checking", "读取当前版本");
  const release = await fetchOpenCodeRelease();
  const currentVersion = normalizeOpenCodeVersion(openCode.version);
  const latestVersion = normalizeOpenCodeVersion(release.version);
  if (!currentVersion || !latestVersion) throw new Error("未能识别 OpenCode 版本");
  const update = {
    currentVersion,
    latestVersion,
    updateAvailable: currentVersion !== latestVersion,
    checkedAt: isoNow(),
  };
  session.agentUpdates ||= new Map();
  session.agentUpdates.set("opencode", update);
  return update;
}

async function applyOpenCodeUpdate(
  session,
  actor,
  onProgress = () => undefined,
) {
  if (!session.client) throw new Error("SSH 尚未连接");
  if (session.activeStream || session.activeRuns?.size) {
    throw new Error("请等待当前远程任务结束后再更新");
  }
  let update = session.agentUpdates?.get("opencode");
  if (!update?.updateAvailable) {
    update = await checkOpenCodeUpdate(session, actor, onProgress);
  }
  if (!update.updateAvailable) {
    return { ...update, agents: await scanRemoteAgents(session, actor) };
  }
  onProgress("downloading", `正在准备 OpenCode ${update.latestVersion}`);
  const artifact = await prepareOpenCodeArtifact(session, onProgress);
  if (normalizeOpenCodeVersion(artifact.version) !== update.latestVersion) {
    throw new Error("OpenCode 最新版本在检测后发生变化，请重新检测更新");
  }
  await uploadOpenCodeArtifact(session, artifact, onProgress, {
    candidateOnly: true,
  });
  onProgress("updating", `正在更新到 ${update.latestVersion}`);
  await remoteExec(session.client, openCodeUpdateApplyCommand());
  onProgress("configuring", "核对 OpenCode 原生配置");
  await ensureOpenCodeNativeConfig(session, actor, onProgress);
  const agents = await scanRemoteAgents(session, actor);
  const installed = agents.find(
    (agent) => agent.adapter === "opencode" && agent.managed,
  );
  const installedVersion = normalizeOpenCodeVersion(installed?.version);
  if (installedVersion !== update.latestVersion) {
    throw new Error(
      `更新后版本校验失败：期望 ${update.latestVersion}，实际 ${installedVersion || "未知"}`,
    );
  }
  const completed = {
    currentVersion: update.currentVersion,
    latestVersion: installedVersion,
    updateAvailable: false,
    checkedAt: isoNow(),
  };
  session.agentUpdates?.set("opencode", completed);
  return { ...completed, agents };
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

function stripEasyWorkProtocolMarkers(value, preferFinal = false) {
  const source = String(value || "");
  const finalIndex = source.lastIndexOf(EASYWORK_FINAL_MARKER);
  if (preferFinal && finalIndex >= 0) {
    return source.slice(finalIndex + EASYWORK_FINAL_MARKER.length).trimStart();
  }
  return source
    .replaceAll(EASYWORK_FINAL_MARKER, "")
    .replaceAll(EASYWORK_PROGRESS_MARKER, "")
    .trimStart();
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
  const partialMarkerIndex = leading.lastIndexOf("[[EASY");
  if (partialMarkerIndex >= 0) {
    const possibleMarker = leading.slice(partialMarkerIndex);
    if (
      [EASYWORK_FINAL_MARKER, EASYWORK_PROGRESS_MARKER].some((marker) =>
        marker.startsWith(possibleMarker),
      )
    ) {
      leading = leading.slice(0, partialMarkerIndex);
    }
  }
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
  const tokenSource = part.tokens || payload.tokens || part.usage || payload.usage;
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
    const kind = /write|edit|patch|apply|replace|create_file/.test(normalizedTool)
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
    if (classified.pending) return null;
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
  if (/permission|approval|question/.test(type)) {
    return {
      sourceId,
      kind: "approval_request",
      title: String(part.title || part.question || "需要用户确认"),
      detail: String(part.description || part.message || "").slice(0, 800),
      status: "pending",
    };
  }
  if (/file_change|file_update/.test(type)) {
    const filePath = String(part.path || part.filePath || "");
    return {
      sourceId,
      kind: "file_change",
      title: `${part.status === "completed" ? "已修改" : "正在修改"} ${path.basename(filePath || "文件")}`,
      detail: String(part.summary || "").slice(0, 500),
      path: filePath || undefined,
      diff: openCodeFileDiff("file_change", part, part, filePath),
      status: part.status === "completed" ? "done" : "running",
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
  if (type === "error") {
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

async function runRemoteWork(socket, session, actor, payload) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const requestedWorkspace = String(payload.workspace || "~");
  const conflictingRun = [...(session.activeRuns?.values() || [])].find(
    (run) =>
      run.conversationId === String(payload.conversationId || "") ||
      run.workspace === requestedWorkspace,
  );
  if (conflictingRun || session.activeStream) {
    throw new Error(
      conflictingRun?.workspace === requestedWorkspace
        ? "这个工作区仍有任务在运行"
        : "这个对话仍有任务在运行",
    );
  }
  touchSshSession(session);
  const workerTask = createWorkerTask(session, payload);
  const webAbortController = new AbortController();
  const activeRun = {
    conversationId: workerTask.conversationId,
    runId: workerTask.runId,
    workspace: requestedWorkspace,
    agentId: workerTask.agentId,
    supportsLiveInput: workerTask.agentId === "opencode",
    abortController: webAbortController,
  };
  session.activeRun = activeRun;
  session.activeRuns.set(workerTask.runId, activeRun);
  await ensureWorkerTaskConversation(actor, workerTask);
  const emit = (event) => publishWorkerEvent(session, event);
  const availableAgents = await prepareRemoteAgents(session, actor);
  const selectedAgent = availableAgents.find(
    (agent) => agent.id === String(payload.agentId || "opencode"),
  );
  if (!selectedAgent || selectedAgent.status !== "ready") {
    throw new Error("所选 Agent 当前不可用，请重新扫描或安装");
  }
  if (selectedAgent.adapter !== "opencode") {
    throw new Error("这个 Agent 尚未安装 EasyWork 运行适配器");
  }
  activeRun.supportsLiveInput = Boolean(
    selectedAgent.capabilities?.liveInput,
  );
  if (!selectedAgent.configured) {
    throw new Error("请先打开 Agent 自带配置文件并完成模型配置");
  }
  const secrets = await getSecrets(actor);
  const state = await getState(actor);
  const provider = state?.settings?.provider || {};
  const managedModel = managedOpenCodeModel(
    selectedAgent,
    provider,
    Boolean(secrets.providerApiKey),
  );
  const workspace = remotePathForSession(
    session,
    String(payload.workspace || "~"),
  );
  await ensureTaskWorkspace(session, workerTask, workspace);
  workerTask.logicalWorkspaceId =
    workerTask.logicalWorkspaceId ||
    crypto
      .createHash("sha256")
      .update(`${session.serverId}:${workspace}`)
      .digest("hex")
      .slice(0, 24);
  const bindingKey = agentBindingKey({
    serverId: session.serverId || session.host || "unknown-host",
    workspace,
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
    workspaceId: workerTask.logicalWorkspaceId,
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
      deterministicWorkHandoff(context, provisionalMemoryDelta);
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
    webHandoff = deterministicWorkHandoff(context, provisionalMemoryDelta);
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
  if (selectedAgent.managed && selectedAgent.adapter === "opencode") {
    const nativeConfiguration = await ensureOpenCodeNativeConfig(
      session,
      actor,
    );
    if (!nativeConfiguration.configured) {
      throw new Error("OpenCode 原生模型配置未完成");
    }
  }
  const openCodeService = await ensureOpenCodeService(session, selectedAgent);
  const nativeSession = await ensureOpenCodeSession(session, openCodeService, {
    sessionId: boundSessionId,
    directory: workspace,
    title: workerTask.title || fallbackConversationTitle(workerTask.prompt),
  });
  const reusableBinding = nativeSession.created ? null : effectiveBinding;
  activeRun.agentControl = {
    adapter: "opencode",
    service: openCodeService,
    sessionId: nativeSession.sessionId,
    directory: workspace,
  };
  workerTask.agentSessionId = nativeSession.sessionId;
  workerTask.agentControl = {
    adapter: "opencode",
    serviceId: openCodeService.serviceId,
    serviceRoot: openCodeService.root,
    servicePort: openCodeService.port,
    sessionId: nativeSession.sessionId,
    directory: workspace,
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
  const agentPrompt = await agentPromptWithNativePlanning(
    agentSyncContext,
    webHandoff,
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
  const remoteRun = await createRemoteRuntimeRun(session, {
    runId: workerTask.runId,
    conversationId: payload.conversationId,
    agentId: selectedAgent.id,
    workspace,
    prompt: agentPrompt,
    command: ({ runDirectory }) => {
      const eventPath = `${runDirectory}/agent-events.sse`;
      const eventErrorPath = `${runDirectory}/agent-events.err`;
      const agentCommand = [
        shellQuote(selectedAgent.path),
        `run --attach ${shellQuote(openCodeService.baseUrl)} --format json --auto --thinking`,
        `--dir "$EW_DIR"`,
        managedModel ? `--model ${shellQuote(managedModel)}` : "",
        `--session ${shellQuote(nativeSession.sessionId)}`,
        `< ${shellQuote(`${runDirectory}/prompt.txt`)}`,
      ]
        .filter(Boolean)
        .join(" ");
      return [
        "#!/bin/sh",
        "set -eu",
        `EW_DIR=${shellQuote(workspace)}`,
        'test -d "$EW_DIR" || mkdir -p "$EW_DIR"',
        "export OPENCODE_SERVER_USERNAME=opencode",
        `export OPENCODE_SERVER_PASSWORD="$(cat ${shellQuote(openCodeService.passwordPath)})"`,
        `: > ${shellQuote(eventPath)}`,
        [
          "curl --no-buffer --silent --show-error",
          `--config ${shellQuote(openCodeService.curlConfigPath)}`,
          "--header 'Accept: text/event-stream'",
          shellQuote(`${openCodeService.baseUrl}/global/event`),
          `2>> ${shellQuote(eventErrorPath)}`,
          `| grep --line-buffered '\"type\":\"tool\"' > ${shellQuote(eventPath)}`,
          "&",
        ].join(" "),
        "EW_EVENT_PID=$!",
        `cleanup_events() { kill "$EW_EVENT_PID" 2>/dev/null || true; wait "$EW_EVENT_PID" 2>/dev/null || true; }`,
        "trap cleanup_events EXIT INT TERM",
        "set +e",
        agentCommand,
        "EW_AGENT_STATUS=$?",
        "set -e",
        "cleanup_events",
        "trap - EXIT INT TERM",
        'exit "$EW_AGENT_STATUS"',
      ].join("\n");
    },
  });
  workerTask.remoteRun = {
    runId: remoteRun.runId,
    runtimeVersion: remoteRun.runtime.releaseId,
    status: remoteRun.status || "starting",
    runDirectory: remoteRun.runDirectory,
    agentSessionId: nativeSession.sessionId,
    serviceId: openCodeService.serviceId,
    serviceRoot: openCodeService.root,
    servicePort: openCodeService.port,
    directory: workspace,
  };
  Object.assign(activeRun, {
    remoteRun,
    abortRequested: false,
    agentControl: {
      adapter: "opencode",
      service: openCodeService,
      sessionId: nativeSession.sessionId,
      directory: workspace,
    },
  });
  session.activeRun = activeRun;
  session.activeRuns.set(workerTask.runId, activeRun);
  scheduleSshWorkerPersist(session.worker, 0);
  const monitorPromise = monitorRemoteRuntimeRun(session, remoteRun, {
    onStdout: (text) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const event = parseOpenCodeLine(line, parserState);
        forwardOpenCodeEvent(event);
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
        const livePart = openCodeSseToolPart(line.slice(5).trim(), {
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
  });
  await waitForOpenCodeRunAdmission(
    session,
    activeRun.agentControl,
    remoteRun,
  );
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
  const result = await monitorPromise;
  const runWasAborted = Boolean(
    activeRun.abortRequested ||
      workerTask.abortRequested ||
      result.status === "aborted",
  );
  session.activeStream = null;
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
  let persistedBinding = null;
  if (parserState.sessionId) {
    const deliveryAcknowledged = result.status === "done" && !runWasAborted;
    const binding = {
      ...(reusableBinding || {}),
      bindingKey,
      conversationId: String(payload.conversationId || ""),
      serverId: session.serverId,
      workspace,
      agentId: selectedAgent.id,
      model: managedModel || selectedAgent.model || undefined,
      agentSessionId: parserState.sessionId,
      agentDataPath: selectedAgent.dataPath,
      lastRunId: workerTask.runId,
      syncMode: agentDelta.bootstrap ? "bootstrap" : "turn",
      syncCursor: deliveryAcknowledged
        ? createAgentSyncCursor({
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
          })
        : reusableBinding?.syncCursor || {
            memoryEnabled: context.state?.settings?.memoryEnabled !== false,
            memoryVersions: {},
            deliveredContentHashes: [],
            lastMessageId: "",
          },
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
        `OpenCode 退出码 ${result.code}`;
    const needsLog =
      !parserState.lastError ||
      /unexpected server error|unknown error|未知错误/i.test(primaryError);
    const logDiagnostic = needsLog
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
    workspaceId: workerTask.logicalWorkspaceId,
    sourceAgentId: selectedAgent.id,
    sourceAgentSessionId: parserState.sessionId,
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
        },
        updatedAt: isoNow(),
      }),
    );
    session.agentSessions.set(bindingKey, synchronizedBinding);
  }
  await persistSshWorker(session.worker);
}

async function closeSshSession(session) {
  if (session.activeStream) session.activeStream.close();
  if (session.client) {
    const client = session.client;
    clearProviderRelays(session);
    session.client = null;
    client.end();
  } else {
    clearProviderRelays(session);
  }
  session.activeStream = null;
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
    session.status = "connected";
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
          readyTimeout: 25_000,
          keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: 3,
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
  const candidateNames = ["opencode", "qwen", "qwen-code", "claude", "qoder"];
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
    : binaryName.includes("qwen")
      ? "qwen"
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
          : adapter === "qwen"
            ? "Qwen Code"
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

async function readAgentConfig(session, actor, agentId) {
  const agent = await agentForSession(session, actor, agentId);
  if (!agent.configPath) throw new Error("尚未识别该 Agent 的原生配置文件");
  let content = "";
  try {
    content = (await remoteSftpRead(session.client, agent.configPath)).toString("utf8");
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
    path: agent.configPath,
    content,
  };
}

async function writeAgentConfig(session, actor, payload) {
  const agent = await agentForSession(session, actor, payload.agentId);
  if (!agent.configPath) throw new Error("尚未识别该 Agent 的原生配置文件");
  const content = String(payload.content || "");
  if (!content.trim()) throw new Error("配置文件不能为空");
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) {
    throw new Error("配置文件不能超过 2 MB");
  }
  if (agent.configPath.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch {
      throw new Error("配置文件不是有效 JSON；如需注释，请改用 Agent 的 JSONC 配置");
    }
  }
  await remoteExec(
    session.client,
    `mkdir -p ${shellQuote(path.posix.dirname(agent.configPath))}`,
  );
  await remoteSftpWrite(session.client, agent.configPath, content);
  return scanRemoteAgents(session, actor);
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
        if (payload.type === "agent.scan") {
          if (targetSession.demo) {
            wsSend(socket, {
              type: "agent.list",
              serverId: targetSession.serverId,
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
            await publishRemoteAgentScan(targetSession, actor);
          }
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
          const scannedAgents = targetSession.demo
            ? []
            : await scanRemoteAgents(targetSession, actor);
          if (
            scannedAgents.some(
              (agent) =>
                agent.adapter === "opencode" && agent.status === "ready",
            )
          ) {
            const agents = await installOpenCode(targetSession, actor);
            sessionSend(targetSession, {
              type: "agent.list",
              serverId: targetSession.serverId,
              agents,
            });
            return;
          }
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents: [
              {
                id: "opencode",
                name: "OpenCode",
                folder: "~/.easywork/agents/opencode",
                path: "~/.easywork/agents/opencode/bin/opencode",
                status: "installing",
                adapter: "opencode",
                managed: true,
                configured: false,
                capabilities: agentRuntimeCapabilities("opencode", "installing"),
              },
            ],
          });
          const agents = await installOpenCode(
            targetSession,
            actor,
            (stage, label) => {
              sessionSend(targetSession, {
                type: "agent.install.progress",
                serverId: targetSession.serverId,
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
          const update = await checkOpenCodeUpdate(
            targetSession,
            actor,
            (status, label) => {
              wsSend(socket, {
                type: "agent.update.status",
                serverId: targetSession.serverId,
                status,
                label,
              });
            },
          );
          wsSend(socket, {
            type: "agent.update.status",
            serverId: targetSession.serverId,
            status: update.updateAvailable ? "available" : "current",
            ...update,
            label: update.updateAvailable
              ? `发现 OpenCode ${update.latestVersion}`
              : "OpenCode 已是最新版",
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
          const update = await applyOpenCodeUpdate(
            targetSession,
            actor,
            (status, label) => {
              wsSend(socket, {
                type: "agent.update.status",
                serverId: targetSession.serverId,
                status,
                label,
              });
            },
          );
          wsSend(socket, {
            type: "agent.update.status",
            serverId: targetSession.serverId,
            status: "done",
            currentVersion: update.currentVersion,
            latestVersion: update.latestVersion,
            label: `OpenCode 已更新到 ${update.latestVersion}`,
          });
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents: update.agents,
          });
          return;
        }
        if (payload.type === "agent.model.configure") {
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
            label: "正在准备 OpenCode 配置",
          });
          const configured = await configureOpenCodeModel(
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
            label: `OpenCode 已切换到 ${configured.model}`,
          });
          sessionSend(targetSession, {
            type: "agent.list",
            serverId: targetSession.serverId,
            agents: configured.agents,
          });
          return;
        }
        if (payload.type === "agent.config.read") {
          const config = await readAgentConfig(
            targetSession,
            actor,
            payload.agentId,
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
          if (!activeRun.supportsLiveInput) {
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
            if (targetSession.activeStream) targetSession.activeStream.close();
            else throw new Error("SSH 已断开；重新连接后才能向远端任务发送停止信号");
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
            targetSession.activeStream = null;
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
          wsSend(socket, {
            type: "agent.list",
            serverId: targetSession?.serverId,
            agents: [
              {
                id: "opencode",
                name: "OpenCode",
                folder: "~/.easywork/agents/opencode",
                path: "~/.easywork/agents/opencode/bin/opencode",
                status: "missing",
                adapter: "opencode",
                managed: true,
                configured: false,
                capabilities: agentRuntimeCapabilities("opencode", "missing"),
              },
            ],
          });
          wsSend(socket, { type: "error", error: message });
        } else if (String(payload.type || "").startsWith("agent.update.")) {
          wsSend(socket, {
            type: "agent.update.status",
            serverId: targetSession?.serverId,
            status: "error",
            label: "OpenCode 更新失败",
            error: message,
          });
        } else if (payload.type === "agent.model.configure") {
          wsSend(socket, {
            type: "agent.model.status",
            serverId: targetSession?.serverId,
            status: "error",
            model: String(payload.model || ""),
            label: "OpenCode 模型配置失败",
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
  const cutoff = now - SSH_IDLE_TTL_MS;
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
  await mkdir(SKILL_ROOT, { recursive: true });
  sessionSecret = await ensureFile(path.join(DATA_ROOT, ".session-secret"));
  encryptionKey = await ensureFile(path.join(DATA_ROOT, ".master-key"));
  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });
  const wss = attachWebSocketServer(server);
  const cleanupTimer = setInterval(() => {
    void cleanupIdleSshWorkers();
  }, SSH_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
  server.once("close", () => {
    clearInterval(cleanupTimer);
  });
  return { server, wss };
}

export const gatewayTestHelpers = {
  agentRuntimeCapabilities,
  agentPromptWithNativePlanning,
  agentPlanEventStatus,
  createThinkTagRouter,
  describeSshError,
  ensureOpenCodeNativeConfig,
  normalizeOpenCodeVersion,
  openCodeUpdateApplyCommand,
  fallbackConversationTitle,
  extractModelText,
  getSshWorker,
  mergeOpenCodeAuthContent,
  mergeOpenCodeConfigContent,
  managedOpenCodeModel,
  mergeConversationCollections,
  normalizeConversationTitle,
  normalizeAgentPlanStatus,
  normalizeAgentPlanSteps,
  openCodeConfigurationStatus,
  openCodeSseToolPart,
  classifyOpenCodeText,
  cleanupIdleSshWorkers,
  conciseOpenCodeDiagnostic,
  createSshSession,
  createWorkerTask,
  parseOpenCodeLine,
  prepareRemoteAgents,
  persistWorkerTaskConversation,
  publishWorkerEvent,
  providerConfigForOpenCode,
  providerRelayTarget,
  readRemoteRuntimeRun,
  remoteOpenCodePortCommand,
  stripEasyWorkProtocolMarkers,
  trailingFinalMessages,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server } = await createEasyWorkServer();
  server.listen(PORT, HOST, () => {
    console.log(`EasyWork gateway listening on http://${HOST}:${PORT}`);
  });
}
