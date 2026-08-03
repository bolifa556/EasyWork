import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
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
const stateMutationQueues = new Map();
const secretMutationQueues = new Map();
let sessionSecret;
let encryptionKey;

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
  const operation = previous.catch(() => undefined).then(mutation);
  queues.set(actorKey, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(actorKey) === operation) queues.delete(actorKey);
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
  await rm(filePath, { force: true }).catch(() => undefined);
  await cp(tempPath, filePath);
  await rm(tempPath, { force: true });
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

function sshWorkerKey(actor) {
  return `${actor.authenticated ? "user" : "guest"}:${actor.id}`;
}

function sshWorkerRuntimePath(actor) {
  return path.join(actorDirectory(actor), "ssh-worker.json");
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
    version: 1,
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
    tasks: [...worker.tasks.values()].map((task) => ({
      ...task,
      events: Array.isArray(task.events) ? task.events.slice(-600) : [],
    })),
  };
}

function persistSshWorker(worker) {
  const snapshot = serializeSshWorker(worker);
  worker.persistQueue = worker.persistQueue
    .catch(() => undefined)
    .then(() => writeJson(sshWorkerRuntimePath(worker.actor), snapshot));
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
    for (const task of Array.isArray(stored.tasks) ? stored.tasks : []) {
      if (!task?.runId || !task?.conversationId) continue;
      worker.tasks.set(String(task.runId), {
        ...task,
        recoveredAfterRestart: task.status === "running",
        status: task.status === "running" ? "error" : task.status,
        error:
          task.status === "running"
            ? "主机服务已重启，远程任务状态无法继续跟踪"
            : task.error,
        result:
          task.status === "running"
            ? "主机服务已重启，远程任务状态无法继续跟踪"
            : task.result,
        events: Array.isArray(task.events) ? task.events : [],
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
  const users = await readJson(path.join(DATA_ROOT, "users.json"), []);
  const signedActorId = verifySession(requestSessionToken(req) || cookies.ew_session);
  if (signedActorId) {
    const record = users.find((item) => item.id === signedActorId);
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
  const stored = await readJson(path.join(actorDirectory(actor), "secrets.json"), {});
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
    sshPrivateKey: decryptString(stored.sshPrivateKey),
    sshCredentials,
  };
}

async function updateSecrets(actor, patch) {
  return enqueueActorMutation(secretMutationQueues, actor, async () => {
    const secretPath = path.join(actorDirectory(actor), "secrets.json");
    const stored = await readJson(secretPath, {});
    const next = { ...stored };
    if (typeof patch.providerApiKey === "string" && patch.providerApiKey) {
      next.providerApiKey = encryptString(patch.providerApiKey);
    }
    if (typeof patch.embeddingApiKey === "string" && patch.embeddingApiKey) {
      next.embeddingApiKey = encryptString(patch.embeddingApiKey);
    }
    if (typeof patch.sshPrivateKey === "string" && patch.sshPrivateKey) {
      next.sshPrivateKey = encryptString(patch.sshPrivateKey);
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
  return readJson(path.join(actorDirectory(actor), "state.json"), {});
}

async function saveState(actor, state) {
  const safeState = JSON.parse(JSON.stringify(state || {}));
  if (safeState?.settings?.provider) delete safeState.settings.provider.apiKey;
  if (safeState?.settings?.embedding) delete safeState.settings.embedding.apiKey;
  await writeJson(path.join(actorDirectory(actor), "state.json"), safeState);
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

  let savedProfile;
  await updateState(actor, async (state) => {
    state.settings ||= {};
    const profiles = Array.isArray(state.settings.servers)
      ? state.settings.servers
      : [];
    const current = profiles.find((profile) => profile.id === serverId);
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
    delete state.settings.ssh;
    return state;
  });
  return savedProfile;
}

async function stateForClient(actor) {
  const state = await getState(actor);
  let secrets = await getSecrets(actor);
  if (state?.settings?.provider) {
    state.settings.provider.configured = Boolean(secrets.providerApiKey);
  }
  if (state?.settings?.embedding) {
    state.settings.embedding.configured = Boolean(secrets.embeddingApiKey);
  }
  if (secrets.sshPrivateKey || state?.settings?.ssh || state?.settings?.servers) {
    state.settings ||= {};
    const legacySsh = state.settings.ssh;
    state.settings.servers = Array.isArray(state.settings.servers)
      ? state.settings.servers
      : [];
    if (
      legacySsh?.host &&
      !state.settings.servers.some(
        (profile) =>
          profile.host === legacySsh.host &&
          Number(profile.port || 22) === Number(legacySsh.port || 22) &&
          profile.username === legacySsh.username,
      )
    ) {
      const legacyId = `server-${crypto
        .createHash("sha256")
        .update(`${legacySsh.host}:${legacySsh.port || 22}:${legacySsh.username || ""}`)
        .digest("hex")
        .slice(0, 12)}`;
      state.settings.servers.unshift({
        id: legacyId,
        name: legacySsh.name || legacySsh.host,
        host: legacySsh.host,
        port: Number(legacySsh.port || 22),
        username: legacySsh.username || "",
        keyName: legacySsh.keyName || "",
        authMethod: "key",
        configured: Boolean(secrets.sshPrivateKey),
      });
      state.settings.lastServerId ||= legacyId;
    }
    if (legacySsh && secrets.sshPrivateKey) {
      const matchingProfiles = state.settings.servers.filter(
        (profile) =>
          (profile.authMethod || "key") === "key" &&
          profile.host === legacySsh.host &&
          Number(profile.port || 22) === Number(legacySsh.port || 22) &&
          profile.username === legacySsh.username &&
          !secrets.sshCredentials?.[safeSegment(profile.id)]?.privateKey,
      );
      for (const profile of matchingProfiles) {
        await updateSecrets(actor, {
          sshCredential: {
            serverId: profile.id,
            privateKey: secrets.sshPrivateKey,
          },
        });
      }
      if (matchingProfiles.length) secrets = await getSecrets(actor);
    }
    state.settings.servers = state.settings.servers.map((profile) => ({
      ...profile,
      configured: Boolean(
        secrets.sshCredentials?.[safeSegment(profile.id)]?.privateKey ||
          secrets.sshCredentials?.[safeSegment(profile.id)]?.password ||
          (legacySsh &&
            secrets.sshPrivateKey &&
            profile.host === legacySsh.host &&
            Number(profile.port || 22) === Number(legacySsh.port || 22) &&
            profile.username === legacySsh.username),
      ),
    }));
  }
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
  const indexPath = path.join(actorDirectory(actor), "library", "index.json");
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
  const index = await readJson(path.join(actorDirectory(actor), "library", "index.json"), {
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

function memoryContext(state, projectId, memoryMode) {
  if (!state?.settings?.memoryEnabled) return "";
  const memories = Array.isArray(state.memories) ? state.memories : [];
  return memories
    .filter((item) => item.enabled)
    .filter((item) => {
      if (memoryMode === "project-only") {
        return item.scope === "project" && item.projectId === projectId;
      }
      return item.scope === "global" || (item.scope === "project" && item.projectId === projectId);
    })
    .slice(0, 20)
    .map((item) => `- ${item.content}（来源：${item.source || "未知"}）`)
    .join("\n");
}

function historyContext(state, conversationId, projectId, memoryMode) {
  if (!state?.settings?.referenceHistory) return "";
  const conversations = Array.isArray(state.conversations) ? state.conversations : [];
  const allowed = conversations
    .filter((conversation) => {
      if (memoryMode === "project-only") return conversation.projectId === projectId;
      return true;
    })
    .sort(
      (left, right) =>
        Number(left.id === conversationId) - Number(right.id === conversationId),
    );
  return allowed
    .flatMap((conversation) => (conversation.messages || []).slice(-8))
    .filter((message) => message.content)
    .slice(-16)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`)
    .join("\n");
}

async function buildContext({
  actor,
  mode,
  prompt,
  skillIds,
  projectId,
  memoryMode,
  conversationId,
}) {
  const state = await getState(actor);
  const system = await readFile(
    path.join(PROMPT_ROOT, mode === "work" ? "work-system.md" : "chat-system.md"),
    "utf8",
  );
  const skills = await selectedSkillContext(actor, skillIds);
  const memories = memoryContext(state, projectId, memoryMode);
  const history = historyContext(state, conversationId, projectId, memoryMode);
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
  return {
    state,
    text,
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

async function callChatProviderStream(provider, apiKey, context, onDelta) {
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
      signal: AbortSignal.timeout(120_000),
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

async function runWorkHandoffModel(actor, context, state, onReasoning) {
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.configured || !provider.model || !secrets.providerApiKey) {
    return { content: "", reasoning: "", skipped: true };
  }
  const handoffPrompt = await renderPromptTemplate("tasks/work-handoff.md", {
    CONTEXT: context,
  });
  const result = await callChatProviderStream(
    provider,
    secrets.providerApiKey,
    handoffPrompt,
    (kind, delta) => {
      if (kind === "reasoning") onReasoning(delta);
    },
  );
  return { ...result, skipped: false };
}

async function captureMemory(actor, prompt, projectId, memoryMode) {
  if (!/(请记住|记住这|以后请|我的偏好|我习惯)/i.test(prompt)) return;
  const content = String(prompt)
    .replace(/^.*?(请记住|记住这|以后请)[：:，,\s]*/i, "")
    .trim()
    .slice(0, 280);
  if (!content) return;
  await updateState(actor, (state) => {
    if (!state?.settings?.autoCapture || !Array.isArray(state.memories)) return state;
    state.memories.unshift({
      id: randomId("memory_"),
      content,
      scope: memoryMode === "project-only" ? "project" : "global",
      ...(memoryMode === "project-only" ? { projectId } : {}),
      kind: "preference",
      source: "用户明确要求",
      confidence: 1,
      enabled: true,
      updatedAt: isoNow(),
    });
    return state;
  });
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
    // A new account can legitimately have no guest data to migrate.
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
      await updateState(actor, (storedState) => {
        const nextState = JSON.parse(JSON.stringify(body.state || {}));
        nextState.settings ||= {};
        const storedSettings = storedState?.settings || {};
        // These account-level settings have dedicated endpoints. Keeping the
        // server copy prevents an older browser tab from erasing a key or SSH
        // profile that was just saved on another device.
        for (const key of ["provider", "embedding", "servers", "lastServerId"]) {
          if (Object.hasOwn(storedSettings, key)) {
            nextState.settings[key] = storedSettings[key];
          }
        }
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
      const userPath = path.join(DATA_ROOT, "users.json");
      const users = await readJson(userPath, []);
      let record = users.find((item) => item.email === email);
      if (url.pathname.endsWith("/register")) {
        if (record) {
          sendJson(res, 409, { error: "该邮箱已注册" });
          return;
        }
        record = {
          id: crypto.randomUUID(),
          email,
          passwordHash: hashPassword(password),
          displayName: String(body.displayName || email.split("@")[0]).trim().slice(0, 48),
          avatar: "",
          createdAt: isoNow(),
        };
        users.push(record);
        await writeJson(userPath, users);
        await copyGuestDataToUser(guestActor, {
          ...record,
          authenticated: true,
        });
      } else if (!record || !verifyPassword(password, record.passwordHash)) {
        sendJson(res, 401, { error: "邮箱或密码不正确" });
        return;
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
      const userPath = path.join(DATA_ROOT, "users.json");
      const users = await readJson(userPath, []);
      const record = users.find((item) => item.id === actor.id);
      if (!record) {
        sendJson(res, 404, { error: "账号不存在" });
        return;
      }
      record.displayName = String(body.displayName || record.displayName).trim().slice(0, 48);
      if (typeof body.avatar === "string" && body.avatar.length < 3_000_000) {
        record.avatar = body.avatar;
      }
      await writeJson(userPath, users);
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
      const fileDir = path.join(actorDirectory(actor), "library", "files");
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
      const fileDir = path.join(actorDirectory(actor), "library", "files");
      const entries = await readdir(fileDir).catch(() => []);
      for (const entry of entries) {
        if (entry === id || entry.startsWith(`${id}-`)) {
          const target = path.resolve(fileDir, entry);
          if (target.startsWith(path.resolve(fileDir) + path.sep)) {
            await rm(target, { force: true });
          }
        }
      }
      const indexPath = path.join(actorDirectory(actor), "library", "index.json");
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
      const context = await buildContext({
        actor,
        mode: "chat",
        prompt: String(body.prompt || ""),
        skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
        projectId: body.projectId ? String(body.projectId) : undefined,
        memoryMode:
          body.memoryMode === "project-only" ? "project-only" : "default",
        conversationId: String(body.conversationId || ""),
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
      try {
        const result = await runChatModelStream(
          actor,
          context.text,
          context.state,
          (kind, delta) => sendEvent({ type: `${kind}_delta`, delta }),
        );
        const title = body.firstTurn
          ? await generateConversationTitle(
              actor,
              String(body.prompt || ""),
              result.content,
            )
          : undefined;
        await captureMemory(
          actor,
          String(body.prompt || ""),
          body.projectId ? String(body.projectId) : undefined,
          body.memoryMode === "project-only" ? "project-only" : "default",
        );
        if (title) sendEvent({ type: "title", title });
        sendEvent({
          type: "done",
          content: result.content,
          reasoning: result.reasoning,
          demo: result.demo,
        });
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
    memoryMode: payload.memoryMode === "project-only" ? "project-only" : "default",
    workspace: String(payload.workspace || "~"),
    prompt: String(payload.prompt || ""),
    firstTurn: Boolean(payload.firstTurn),
    userMessageId: String(payload.userMessageId || `${payload.runId}_user`),
    assistantMessageId: String(
      payload.assistantMessageId || `${payload.runId}_assistant`,
    ),
    title: "",
    status: "running",
    steps: [],
    events: [],
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
        reasoningStatus: "running",
        events: [],
      };
      conversation.messages.push(assistantMessage);
    }
    return state;
  });
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
              : "running",
        steps: task.steps,
        result: task.result || undefined,
        startedAt: task.startedAt,
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
        (task.status === "error" ? task.error : task.result) ||
        assistantMessage.content ||
        "";
      assistantMessage.reasoning = reasoning || assistantMessage.reasoning;
      assistantMessage.reasoningStatus =
        task.status === "running"
          ? "running"
          : task.status === "error"
            ? "error"
            : "done";
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

function remotePathForSession(session, value = "~") {
  const input = String(value || "~").trim();
  if (!session.home) throw new Error("尚未读取远端主目录");
  if (input === "~") return session.home;
  if (input.startsWith("~/")) return path.posix.join(session.home, input.slice(2));
  if (input.startsWith("/")) return path.posix.normalize(input);
  return path.posix.join(session.home, input);
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
  const redacted = diagnosticText
    .split(/\r?\n/)
    .filter((line) => /error|fail|exception|provider|api[_ -]?call/i.test(line))
    .slice(-10)
    .join("\n")
    .trim();
  return redacted.slice(-4_000);
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
  const handoffSection = webHandoff
    ? await renderPromptTemplate("agents/web-handoff.md", {
        CONTENT: webHandoff,
      })
    : "";
  return renderPromptTemplate("agents/opencode-bridge.md", {
    CONTEXT: context,
    WEB_HANDOFF: handoffSection,
  });
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

  const legacyProvider = current.provider?.custom;
  const legacyModels = Object.keys(legacyProvider?.models || {});
  const legacyLooksManaged =
    legacyProvider?.name === "Custom API" &&
    legacyProvider?.options?.baseURL === provider.baseUrl &&
    legacyModels.includes(provider.model);
  if (legacyLooksManaged) {
    next = setJsoncValue(next, ["provider", "custom"], undefined);
  }
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

function remoteAgentRegistryPath(actor) {
  return path.join(actorDirectory(actor), "remote-agents.json");
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
  const [jsonBuffer, jsoncBuffer, authBuffer] = await Promise.all([
    remoteSftpReadOptional(session.client, jsonPath),
    remoteSftpReadOptional(session.client, jsoncPath),
    remoteSftpReadOptional(session.client, authPath),
  ]);
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
  const command = [
    "set +e",
    'managed_opencode="$HOME/.easywork/agents/opencode/bin/opencode"',
    'user_opencode="$HOME/.opencode/bin/opencode"',
    'system_opencode="$(command -v opencode 2>/dev/null)"',
    'if [ -x "$managed_opencode" ]; then printf "opencode\\t%s\\t%s\\t%s\\topencode\\n" "$HOME/.easywork/agents/opencode" "$managed_opencode" "$("$managed_opencode" --version 2>/dev/null | head -n 1)";',
    'elif [ -x "$user_opencode" ]; then printf "opencode\\t%s\\t%s\\t%s\\topencode\\n" "$HOME/.opencode" "$user_opencode" "$("$user_opencode" --version 2>/dev/null | head -n 1)";',
    'elif [ -n "$system_opencode" ] && [ -x "$system_opencode" ]; then printf "opencode\\t%s\\t%s\\t%s\\topencode\\n" "$(dirname "$system_opencode")" "$system_opencode" "$("$system_opencode" --version 2>/dev/null | head -n 1)"; fi',
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
        ...config,
      };
    });

  const custom = await storedRemoteAgents(actor, session);
  for (const stored of custom) {
    if (
      discovered.some(
        (agent) =>
          agent.id === stored.id ||
          (agent.adapter === "opencode" && stored.adapter === "opencode"),
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

  if (!discovered.some((agent) => agent.id === "opencode")) {
    discovered.unshift({
      id: "opencode",
      name: "OpenCode",
      folder: "~/.easywork/agents/opencode",
      path: "~/.easywork/agents/opencode/bin/opencode",
      status: "missing",
      adapter: "opencode",
      managed: true,
      configured: false,
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
  const effectiveProvider = { ...provider, model: selectedModel };
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
  return {
    configured: true,
    changed: true,
    configPath: configuration.configPath,
    model: `${EASYWORK_OPENCODE_PROVIDER_ID}/${selectedModel}`,
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

async function remoteExecutableExists(session, remotePath) {
  return (
    (
      await remoteExec(
        session.client,
        `test -x ${shellQuote(remotePath)}`,
        { allowFailure: true },
      )
    ).code === 0
  );
}

async function migrateLegacyOpenCode(
  session,
  onProgress = () => undefined,
) {
  const legacyPath = `${session.home}/.easywork/bin/opencode`;
  const managedRoot = `${session.home}/.easywork/agents/opencode`;
  const managedPath = `${managedRoot}/bin/opencode`;
  if (!(await remoteExecutableExists(session, legacyPath))) return false;
  if (await remoteExecutableExists(session, managedPath)) return true;
  onProgress("migrate", "迁移旧版 OpenCode");
  await remoteExec(
    session.client,
    [
      "set -eu",
      `mkdir -p ${shellQuote(`${managedRoot}/bin`)}`,
      `cp ${shellQuote(legacyPath)} ${shellQuote(managedPath)}`,
      `chmod 755 ${shellQuote(managedPath)}`,
      `${shellQuote(managedPath)} --version`,
    ].join("\n"),
  );
  return true;
}

async function prepareRemoteAgents(
  session,
  actor,
  onProgress = () => undefined,
) {
  let agents = await scanRemoteAgents(session, actor);
  let managedOpenCode = agents.find(
    (agent) =>
      agent.adapter === "opencode" &&
      agent.status === "ready" &&
      agent.managed,
  );
  if (!managedOpenCode && (await migrateLegacyOpenCode(session, onProgress))) {
    agents = await scanRemoteAgents(session, actor);
    managedOpenCode = agents.find(
      (agent) =>
        agent.adapter === "opencode" &&
        agent.status === "ready" &&
        agent.managed,
    );
  }
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
      !session.activeStream,
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
  if (await migrateLegacyOpenCode(session, onProgress)) {
    await ensureOpenCodeNativeConfig(session, actor, onProgress);
    return scanRemoteAgents(session, actor);
  }
  existingOpenCode = existingAgents.find(
    (agent) => agent.adapter === "opencode" && agent.status === "ready",
  );
  if (existingOpenCode) return existingAgents;

  onProgress("prepare", "准备安装目录");
  await remoteExec(
    session.client,
    'mkdir -p "$HOME/.easywork/agents/opencode/bin" "$HOME/.easywork/bindings"',
  );
  onProgress("download", "下载 OpenCode");
  await remoteExec(
    session.client,
    [
      "set -eu",
      'EW_INSTALLER="$HOME/.easywork/install-opencode.sh"',
      'EW_AGENT_ROOT="$HOME/.easywork/agents/opencode"',
      'EW_INSTALL_HOME="$EW_AGENT_ROOT/.installer-home"',
      'trap \'rm -f "$EW_INSTALLER"; rm -rf "$EW_INSTALL_HOME"\' EXIT',
      'if [ ! -x "$EW_AGENT_ROOT/bin/opencode" ]; then',
      '  if [ -x "$HOME/.easywork/bin/opencode" ]; then',
      '    cp "$HOME/.easywork/bin/opencode" "$EW_AGENT_ROOT/bin/opencode"',
      '  elif [ -x "$HOME/.opencode/bin/opencode" ]; then',
      '    cp "$HOME/.opencode/bin/opencode" "$EW_AGENT_ROOT/bin/opencode"',
      '  else',
      '    curl --connect-timeout 15 --max-time 90 --retry 2 -fsSL https://opencode.ai/install -o "$EW_INSTALLER"',
      '    mkdir -p "$EW_INSTALL_HOME"',
      '    if command -v timeout >/dev/null 2>&1; then HOME="$EW_INSTALL_HOME" timeout 300 bash "$EW_INSTALLER" --no-modify-path; else HOME="$EW_INSTALL_HOME" bash "$EW_INSTALLER" --no-modify-path; fi',
      '    mv "$EW_INSTALL_HOME/.opencode/bin/opencode" "$EW_AGENT_ROOT/bin/opencode"',
      '  fi',
      "fi",
      'test -x "$EW_AGENT_ROOT/bin/opencode"',
      'chmod 755 "$EW_AGENT_ROOT/bin/opencode"',
      '"$EW_AGENT_ROOT/bin/opencode" --version',
    ].join("\n"),
  );
  await ensureOpenCodeNativeConfig(session, actor, onProgress);
  onProgress("verify", "验证 Agent");
  return scanRemoteAgents(session, actor);
}

function normalizeOpenCodeVersion(value) {
  const match = String(value || "").match(/\bv?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)\b/i);
  return match?.[1] || String(value || "").trim().split(/\s+/)[0] || "";
}

function parseOpenCodeUpdateVersions(output) {
  const source = String(output || "");
  const current = source.match(/^EW_CURRENT_VERSION=(.+)$/m)?.[1]?.trim() || "";
  const latest = source.match(/^EW_LATEST_VERSION=(.+)$/m)?.[1]?.trim() || "";
  return {
    currentVersion: normalizeOpenCodeVersion(current),
    latestVersion: normalizeOpenCodeVersion(latest),
  };
}

function openCodeUpdateProbeCommand() {
  return [
    "set -eu",
    'EW_AGENT_ROOT="$HOME/.easywork/agents/opencode"',
    'EW_CURRENT="$EW_AGENT_ROOT/bin/opencode"',
    'EW_UPDATE_ROOT="$EW_AGENT_ROOT/.update-candidate"',
    'EW_UPDATE_HOME="$EW_UPDATE_ROOT/home"',
    'EW_INSTALLER="$EW_UPDATE_ROOT/install.sh"',
    'test -x "$EW_CURRENT"',
    'rm -rf "$EW_UPDATE_ROOT"',
    'mkdir -p "$EW_UPDATE_HOME"',
    'curl --connect-timeout 15 --max-time 90 --retry 2 -fsSL https://opencode.ai/install -o "$EW_INSTALLER"',
    'if command -v timeout >/dev/null 2>&1; then HOME="$EW_UPDATE_HOME" timeout 300 bash "$EW_INSTALLER" --no-modify-path; else HOME="$EW_UPDATE_HOME" bash "$EW_INSTALLER" --no-modify-path; fi',
    'test -x "$EW_UPDATE_HOME/.opencode/bin/opencode"',
    'mv "$EW_UPDATE_HOME/.opencode/bin/opencode" "$EW_UPDATE_ROOT/opencode"',
    'chmod 755 "$EW_UPDATE_ROOT/opencode"',
    'printf "EW_CURRENT_VERSION=%s\\n" "$("$EW_CURRENT" --version 2>/dev/null | head -n 1)"',
    'printf "EW_LATEST_VERSION=%s\\n" "$("$EW_UPDATE_ROOT/opencode" --version 2>/dev/null | head -n 1)"',
    'rm -rf "$EW_UPDATE_HOME" "$EW_INSTALLER"',
  ].join("\n");
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
  if (session.activeStream) throw new Error("请等待当前远程任务结束后再检测更新");
  const agents = await scanRemoteAgents(session, actor);
  const openCode = agents.find(
    (agent) =>
      agent.adapter === "opencode" &&
      agent.status === "ready" &&
      agent.managed,
  );
  if (!openCode) throw new Error("只能自动更新由 EasyWork 部署的 OpenCode");
  onProgress("checking", "读取当前版本");
  onProgress("downloading", "下载并验证最新版本");
  const result = await remoteExec(session.client, openCodeUpdateProbeCommand());
  const versions = parseOpenCodeUpdateVersions(result.stdout);
  if (!versions.currentVersion || !versions.latestVersion) {
    throw new Error("未能识别 OpenCode 版本，候选文件已保留以便排查");
  }
  const update = {
    ...versions,
    updateAvailable: versions.currentVersion !== versions.latestVersion,
    checkedAt: isoNow(),
  };
  session.agentUpdates ||= new Map();
  session.agentUpdates.set("opencode", update);
  if (!update.updateAvailable) {
    await remoteExec(
      session.client,
      'rm -rf "$HOME/.easywork/agents/opencode/.update-candidate"',
      { allowFailure: true },
    );
  }
  return update;
}

async function applyOpenCodeUpdate(
  session,
  actor,
  onProgress = () => undefined,
) {
  if (!session.client) throw new Error("SSH 尚未连接");
  if (session.activeStream) throw new Error("请等待当前远程任务结束后再更新");
  let update = session.agentUpdates?.get("opencode");
  if (!update?.updateAvailable) {
    update = await checkOpenCodeUpdate(session, actor, onProgress);
  }
  if (!update.updateAvailable) {
    return { ...update, agents: await scanRemoteAgents(session, actor) };
  }
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
  if (session.activeRun || session.activeStream) {
    throw new Error("该服务器上仍有任务在运行");
  }
  touchSshSession(session);
  const workerTask = createWorkerTask(session, payload);
  session.activeRun = {
    conversationId: workerTask.conversationId,
    runId: workerTask.runId,
  };
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
  if (!selectedAgent.configured) {
    throw new Error("请先打开 Agent 自带配置文件并完成模型配置");
  }
  const secrets = await getSecrets(actor);
  const state = await getState(actor);
  const provider = state?.settings?.provider || {};
  const managedModel =
    selectedAgent.managed && provider.model && secrets.providerApiKey
      ? `${EASYWORK_OPENCODE_PROVIDER_ID}/${provider.model}`
      : "";
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
    memoryMode: payload.memoryMode === "project-only" ? "project-only" : "default",
    conversationId: String(payload.conversationId || ""),
  });
  const webReasoningEventId = `${payload.runId}_web_reasoning`;
  let webReasoning = "";
  let reasoningStarted = false;
  let webHandoff = "";
  try {
    const handoffResult = await runWorkHandoffModel(
      actor,
      context.text,
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
    );
    webHandoff = String(handoffResult.content || "").trim();
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
  const agentPrompt = await agentPromptWithNativePlanning(
    context.text,
    webHandoff,
  );
  const workspaceEncoded = Buffer.from(
    String(payload.workspace || "~"),
    "utf8",
  ).toString("base64");
  const promptEncoded = Buffer.from(agentPrompt, "utf8").toString("base64");
  const sessionId = session.agentSessions.get(String(payload.conversationId || ""));
  const bindingsPath = path.join(actorDirectory(actor), "work-sessions.json");
  const bindings = await readJson(bindingsPath, {});
  const bindingKey = [
    session.serverId || session.host || "unknown-host",
    String(payload.agentId || "opencode"),
    String(payload.conversationId || ""),
  ].join("::");
  const boundSessionId = sessionId || bindings[bindingKey];
  const command = [
    `EW_DIR="$(printf %s ${shellQuote(workspaceEncoded)} | base64 -d)"`,
    'case "$EW_DIR" in "~/"*) EW_DIR="$HOME/${EW_DIR#~/}" ;; esac',
    '[ "$EW_DIR" = "~" ] && EW_DIR="$HOME" || true',
    'test -d "$EW_DIR" || mkdir -p "$EW_DIR"',
    [
      `printf %s ${shellQuote(promptEncoded)} | base64 -d |`,
      shellQuote(selectedAgent.path),
      "run --format json --auto",
      `--dir "$EW_DIR"`,
      managedModel ? `--model ${shellQuote(managedModel)}` : "",
      boundSessionId ? `--session ${shellQuote(boundSessionId)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  ];
  const commandText = command.join(" && ");

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
  };
  let pending = "";
  let stderrOutput = "";
  const result = await remoteExec(session.client, commandText, {
    allowFailure: true,
    onStream: (stream) => {
      session.activeStream = stream;
      session.activeRun = {
        conversationId: payload.conversationId,
        runId: payload.runId,
      };
    },
    onStdout: (text) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        const event = parseOpenCodeLine(line, parserState);
        if (!event) continue;
        const { sourceId, planSteps, ...eventPayload } = event;
        const eventId =
          sourceId
            ? `${payload.runId}_${safeSegment(event.kind)}_${safeSegment(sourceId)}`
            : `${payload.runId}_event_${parserState.eventIndex++}`;
        if (
          parserState.activeFinal &&
          parserState.activeFinal.id !== eventId
        ) {
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
        if (
          parserState.activeThought &&
          parserState.activeThought.id !== eventId
        ) {
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
          parserState.eventOrder.push({
            id: eventId,
            kind: event.kind,
          });
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
            event: {
              id: eventId,
              ...eventPayload,
            },
          };
        }
        if (event.kind === "message") {
          parserState.activeFinal = {
            id: eventId,
            event: {
              id: eventId,
              ...eventPayload,
            },
          };
        }
      }
    },
    onStderr: (text) => {
      stderrOutput = `${stderrOutput}${text}`.slice(-12_000);
    },
  });
  session.activeStream = null;
  session.activeRun = null;
  if (parserState.sessionId) {
    session.agentSessions.set(String(payload.conversationId || ""), parserState.sessionId);
    bindings[bindingKey] = parserState.sessionId;
    await writeJson(bindingsPath, bindings);
    const remoteBindingDirectory = `${session.home}/.easywork/bindings`;
    await remoteExec(
      session.client,
      `mkdir -p ${shellQuote(remoteBindingDirectory)}`,
      { allowFailure: true },
    );
    await remoteSftpWrite(
      session.client,
      `${remoteBindingDirectory}/${safeSegment(payload.conversationId)}.json`,
      `${JSON.stringify(
        {
          conversationId: String(payload.conversationId || ""),
          serverId: session.serverId,
          agentId: selectedAgent.id,
          agentSessionId: parserState.sessionId,
          agentDataPath: selectedAgent.dataPath,
          workspace: String(payload.workspace || "~"),
          updatedAt: isoNow(),
        },
        null,
        2,
      )}\n`,
    ).catch(() => undefined);
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
  await persistSshWorker(session.worker);
}

async function closeSshSession(session) {
  if (session.activeStream) session.activeStream.close();
  if (session.client) {
    const client = session.client;
    session.client = null;
    client.end();
  }
  session.activeStream = null;
  session.activeRun = null;
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
  const useSavedCredential = Boolean(
    payload.useSavedCredential || payload.useSavedKey,
  );
  const storedSecrets = useSavedCredential ? await getSecrets(actor) : {};
  const savedCredential =
    storedSecrets.sshCredentials?.[session.serverId] || {};
  const privateKey = String(
    authMethod === "key"
      ? payload.privateKey ||
          savedCredential.privateKey ||
          storedSecrets.sshPrivateKey ||
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

  const knownHostsPath = path.join(actorDirectory(actor), "known-hosts.json");
  const knownHosts = await readJson(knownHostsPath, {});
  let observedFingerprint = "";
  const startedAt = Date.now();
  const client = new SshClient();
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
    (useSavedCredential ||
      payload.rememberCredential ||
      payload.rememberKey)
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
              ? payload.privateKeyName || currentProfile.keyName || "SSH 私钥"
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
        delete state.settings.ssh;
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
    if (!["/ws", "/easywork-ws"].includes(url.pathname)) {
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
      activeTaskCount: session.activeRun ? 1 : 0,
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
                  session.activeRun?.conversationId === payload.conversationId,
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
        if (payload.type === "work.run") {
          await runRemoteWork(socket, targetSession, actor, payload);
          return;
        }
        if (payload.type === "work.approval") {
          return;
        }
        if (payload.type === "work.abort") {
          if (targetSession.activeStream) targetSession.activeStream.close();
          publishWorkerEvent(targetSession, {
            type: "agent.event",
            conversationId: payload.conversationId,
            runId: payload.runId,
            event: {
              id: `${payload.runId}_aborted`,
              kind: "job_status",
              title: "任务已停止",
              detail: "用户主动停止了远程执行",
              status: "error",
              timestamp: isoNow(),
            },
          });
          publishWorkerEvent(targetSession, {
            type: "task.error",
            conversationId: payload.conversationId,
            runId: payload.runId,
            result: "任务已由用户停止",
          });
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
            targetSession.activeRun = null;
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
      if (session.activeRun || lastActivity >= cutoff) continue;
      await closeSshSession(session).catch(() => undefined);
      worker.sessions.delete(serverId);
      changed = true;
    }
    for (const [runId, task] of worker.tasks) {
      if (task.status === "running") continue;
      const finishedAt = Date.parse(task.finishedAt || task.updatedAt || "") || 0;
      if (finishedAt && finishedAt < cutoff) {
        worker.tasks.delete(runId);
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
  agentPromptWithNativePlanning,
  agentPlanEventStatus,
  createThinkTagRouter,
  describeSshError,
  ensureOpenCodeNativeConfig,
  normalizeOpenCodeVersion,
  openCodeUpdateApplyCommand,
  openCodeUpdateProbeCommand,
  parseOpenCodeUpdateVersions,
  fallbackConversationTitle,
  extractModelText,
  getSshWorker,
  mergeOpenCodeAuthContent,
  mergeOpenCodeConfigContent,
  normalizeConversationTitle,
  normalizeAgentPlanStatus,
  normalizeAgentPlanSteps,
  openCodeConfigurationStatus,
  classifyOpenCodeText,
  cleanupIdleSshWorkers,
  createSshSession,
  createWorkerTask,
  parseOpenCodeLine,
  prepareRemoteAgents,
  persistWorkerTaskConversation,
  publishWorkerEvent,
  providerConfigForOpenCode,
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
