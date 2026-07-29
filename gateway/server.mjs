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
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const DATA_ROOT = path.resolve(process.env.EASYWORK_DATA_DIR || path.join(ROOT, "data"));
const SKILL_ROOT = path.resolve(process.env.EASYWORK_SKILL_DIR || path.join(ROOT, "skill"));
const PROMPT_ROOT = path.join(ROOT, "prompts");
const HOST = process.env.EASYWORK_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.EASYWORK_GATEWAY_PORT || 8789);
const BODY_LIMIT = 36 * 1024 * 1024;
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const BUILTIN_SKILLS = {
  skill_cluster: path.join(SKILL_ROOT, "built-in", "cluster-ops"),
  skill_paper: path.join(SKILL_ROOT, "built-in", "paper-reading"),
  skill_debug: path.join(SKILL_ROOT, "built-in", "training-debug"),
};

const activeSockets = new Set();
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

async function resolveActor(req, res, createGuest = true) {
  const cookies = cookieMap(req.headers.cookie);
  const users = await readJson(path.join(DATA_ROOT, "users.json"), []);
  const userId = verifySession(cookies.ew_session);
  if (userId) {
    const record = users.find((item) => item.id === userId);
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
  let guestId = /^[a-f0-9-]{20,}$/i.test(cookies.ew_guest || "")
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
  return {
    providerApiKey: decryptString(stored.providerApiKey),
    embeddingApiKey: decryptString(stored.embeddingApiKey),
  };
}

async function updateSecrets(actor, patch) {
  const secretPath = path.join(actorDirectory(actor), "secrets.json");
  const stored = await readJson(secretPath, {});
  const next = { ...stored };
  if (typeof patch.providerApiKey === "string" && patch.providerApiKey) {
    next.providerApiKey = encryptString(patch.providerApiKey);
  }
  if (typeof patch.embeddingApiKey === "string" && patch.embeddingApiKey) {
    next.embeddingApiKey = encryptString(patch.embeddingApiKey);
  }
  await writeJson(secretPath, next);
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

async function stateForClient(actor) {
  const state = await getState(actor);
  const secrets = await getSecrets(actor);
  if (state?.settings?.provider) {
    state.settings.provider.configured = Boolean(secrets.providerApiKey);
  }
  if (state?.settings?.embedding) {
    state.settings.embedding.configured = Boolean(secrets.embeddingApiKey);
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

async function listProviderModels(baseUrl, apiKey) {
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
    if (content) pieces.push(`### 技能 ${skillId}\n${content}`);
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
  const knowledgeText = knowledge
    .map(
      (item, indexValue) =>
        `[文件片段 ${indexValue + 1} · ${item.file}]\n${item.chunk.text.slice(0, 1800)}`,
    )
    .join("\n\n");
  return {
    state,
    text: [
      system,
      memories ? `## 可用记忆\n${memories}` : "",
      history ? `## 允许引用的历史\n${history}` : "",
      skills ? `## 本轮已选技能\n${skills}` : "",
      knowledgeText ? `## 文件库检索结果\n${knowledgeText}` : "",
      `## 用户本轮请求\n${prompt}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
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
    .flatMap((item) => item.content || [])
    .map((item) => item.text || item.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function modelRequest(protocol, model, context, test = false) {
  if (protocol === "chat-completions") {
    return {
      endpoint: "chat/completions",
      body: {
        model,
        messages: test
          ? [{ role: "user", content: "Reply with OK." }]
          : [
              { role: "system", content: "请严格遵守以下 EasyWork 上下文。" },
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
        ? "Reply with OK."
        : [
            { role: "system", content: "请严格遵守以下 EasyWork 上下文。" },
            { role: "user", content: context },
          ],
      ...(test ? { max_output_tokens: 4 } : {}),
    },
  };
}

async function callChatProvider(provider, apiKey, context, { test = false } = {}) {
  const protocols =
    provider.protocol === "responses" || provider.protocol === "chat-completions"
      ? [provider.protocol]
      : ["responses", "chat-completions"];
  let lastError;
  for (const protocol of protocols) {
    const request = modelRequest(protocol, provider.model, context, test);
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

async function runChatModel(actor, context, state) {
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.configured || !secrets.providerApiKey) {
    return {
      content: "尚未配置模型 API。请登录后在个人资料 → 模型 API 中完成设置。",
      demo: true,
    };
  }
  const { payload } = await callChatProvider(
    provider,
    secrets.providerApiKey,
    context,
  );
  return { content: extractModelText(payload) || "模型返回了空内容。", demo: false };
}

async function captureMemory(actor, prompt, projectId, memoryMode) {
  if (!/(请记住|记住这|以后请|我的偏好|我习惯)/i.test(prompt)) return;
  const state = await getState(actor);
  if (!state?.settings?.autoCapture || !Array.isArray(state.memories)) return;
  const content = String(prompt)
    .replace(/^.*?(请记住|记住这|以后请)[：:，,\s]*/i, "")
    .trim()
    .slice(0, 280);
  if (!content) return;
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
  await saveState(actor, state);
}

async function copyGuestDataToUser(guestActor, userActor) {
  const guestData = actorDirectory(guestActor);
  const guestSkills = actorSkillDirectory(guestActor);
  const userData = actorDirectory(userActor);
  const userSkills = actorSkillDirectory(userActor);
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
      sendJson(res, 200, { actor, state: await stateForClient(actor) });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/state") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      await saveState(actor, body.state || {});
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
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      res.setHeader("Set-Cookie", cookie("ew_session", "", req, { maxAge: 0 }));
      sendJson(res, 200, { ok: true });
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

    if (req.method === "PUT" && url.pathname === "/api/settings/provider") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      if (body.apiKey) await updateSecrets(actor, { providerApiKey: String(body.apiKey) });
      const state = await getState(actor);
      state.settings ||= {};
      state.settings.provider = {
        name: String(body.name || "OpenAI Compatible"),
        baseUrl: String(body.baseUrl || "https://api.openai.com/v1"),
        model: String(body.model || ""),
        protocol:
          body.protocol === "chat-completions" || body.protocol === "responses"
            ? body.protocol
            : "auto",
        configured: Boolean(body.apiKey || (await getSecrets(actor)).providerApiKey),
      };
      await saveState(actor, state);
      sendJson(res, 200, { ok: true, provider: state.settings.provider });
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
      const state = await getState(actor);
      state.settings ||= {};
      state.settings.embedding = {
        baseUrl: String(body.baseUrl || "https://api.openai.com/v1"),
        model: String(body.model || "text-embedding-3-small"),
        dimensions: String(body.dimensions || ""),
        configured: Boolean(body.apiKey || (await getSecrets(actor)).embeddingApiKey),
        hybridEnabled: body.hybridEnabled !== false,
        rerankEnabled: Boolean(body.rerankEnabled),
      };
      await saveState(actor, state);
      sendJson(res, 200, { ok: true, embedding: state.settings.embedding });
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

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const actor = await resolveActor(req, res);
      const body = await parseJsonBody(req);
      const context = await buildContext({
        actor,
        mode: "chat",
        prompt: String(body.prompt || ""),
        skillIds: Array.isArray(body.skillIds) ? body.skillIds : [],
        projectId: body.projectId ? String(body.projectId) : undefined,
        memoryMode: body.memoryMode === "project-only" ? "project-only" : "default",
        conversationId: String(body.conversationId || ""),
      });
      const result = await runChatModel(actor, context.text, context.state);
      await captureMemory(
        actor,
        String(body.prompt || ""),
        body.projectId ? String(body.projectId) : undefined,
        body.memoryMode === "project-only" ? "project-only" : "default",
      );
      sendJson(res, 200, { ...result, sources: context.sources });
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

function workflowFor(prompt) {
  if (/内存|显存|资源|gpu|memory|磁盘|cpu/i.test(prompt)) {
    return ["查看服务器内存", "查看可用资源", "判断任务所需资源是否满足"];
  }
  if (/文件|代码|修改|实现|修复|编辑/i.test(prompt)) {
    return ["确认工作目录与约束", "检查相关文件", "执行修改", "验证结果"];
  }
  return ["理解请求并确认环境", "执行任务", "检查结果并整理回复"];
}

function providerConfigForOpenCode(provider) {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      easywork: {
        npm: "@ai-sdk/openai-compatible",
        name: "EasyWork API",
        options: {
          baseURL: provider.baseUrl,
          apiKey: "{env:EASYWORK_LLM_API_KEY}",
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

async function scanRemoteAgents(session) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const command = [
    "set +e",
    'for spec in "opencode:$HOME/.easywork/bin/opencode" "opencode-global:$(command -v opencode 2>/dev/null)" "qwen:$(command -v qwen 2>/dev/null)" "claude:$(command -v claude 2>/dev/null)"; do',
    '  id="${spec%%:*}"; bin="${spec#*:}";',
    '  if [ -n "$bin" ] && [ -x "$bin" ]; then ver="$($bin --version 2>/dev/null | head -n 1)"; printf "%s\\t%s\\t%s\\n" "$id" "$bin" "$ver"; fi',
    "done",
  ].join("\n");
  const result = await remoteExec(session.client, command, { allowFailure: true });
  const agents = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, binaryPath, version] = line.split("\t");
      const isOpenCode = id.startsWith("opencode");
      return {
        id,
        name: isOpenCode ? "OpenCode" : id === "qwen" ? "Qwen Code" : "Claude Code",
        path: binaryPath,
        version: version || undefined,
        status: isOpenCode ? "ready" : "needs-adapter",
        adapter: isOpenCode ? "opencode" : "plain",
        managed: id === "opencode",
      };
    });
  if (!agents.some((agent) => agent.id === "opencode")) {
    agents.unshift({
      id: "opencode",
      name: "OpenCode",
      path: "~/.easywork/bin/opencode",
      status: "missing",
      adapter: "opencode",
      managed: true,
    });
  }
  return agents;
}

async function installOpenCode(session, actor) {
  if (!session.client) throw new Error("SSH 尚未连接");
  const state = await getState(actor);
  const provider = state?.settings?.provider || {};
  const secrets = await getSecrets(actor);
  if (!provider.baseUrl || !provider.model || !secrets.providerApiKey) {
    throw new Error("请先在个人资料中配置模型 API，再安装远端 Agent");
  }
  await remoteExec(
    session.client,
    'mkdir -p "$HOME/.easywork/bin" "$HOME/.easywork/config" "$HOME/.easywork/tasks" "$HOME/.easywork/runtime"',
  );
  await remoteExec(
    session.client,
    [
      'curl -fsSL https://opencode.ai/install -o "$HOME/.easywork/install-opencode.sh"',
      'OPENCODE_INSTALL_DIR="$HOME/.easywork/bin" bash "$HOME/.easywork/install-opencode.sh"',
      'rm -f "$HOME/.easywork/install-opencode.sh"',
      '"$HOME/.easywork/bin/opencode" --version',
    ].join(" && "),
    { pty: true },
  );
  await remoteSftpWrite(
    session.client,
    `${session.home}/.easywork/config/opencode.json`,
    `${JSON.stringify(providerConfigForOpenCode(provider), null, 2)}\n`,
  );
  return scanRemoteAgents(session);
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
  if (type === "tool_use" || type === "tool") {
    const tool = String(part.tool || part.name || "tool");
    const command = part.state?.input?.command || part.input?.command || "";
    const output =
      part.state?.output ||
      part.output ||
      part.state?.error ||
      (command ? `$ ${command}` : "");
    const statusValue = part.state?.status || part.status;
    return {
      kind: tool.includes("bash") ? "terminal" : "tool",
      title: command ? String(command).slice(0, 120) : `调用 ${tool}`,
      detail: `OpenCode · ${tool}`,
      output: String(output || "").slice(0, 12_000),
      status:
        statusValue === "error"
          ? "error"
          : ["completed", "done", "success"].includes(statusValue)
            ? "done"
            : "running",
    };
  }
  if (type === "text") {
    const text = String(part.text || payload.text || "");
    if (!text) return null;
    state.finalText += text;
    return {
      kind: "result",
      title: "Agent 回复",
      output: state.finalText.slice(-16_000),
      status: "running",
    };
  }
  if (type === "reasoning") {
    return {
      kind: "reasoning",
      title: "正在分析下一步",
      detail: String(part.text || "").slice(0, 500),
      status: "running",
    };
  }
  if (type === "step_start") {
    return {
      kind: "plan",
      title: "开始新步骤",
      detail: part.title || "OpenCode 正在编排工具调用",
      status: "running",
    };
  }
  if (type === "error") {
    return {
      kind: "tool",
      title: "Agent 执行错误",
      output: String(payload.error?.message || payload.message || "未知错误"),
      status: "error",
    };
  }
  return null;
}

async function runRemoteWork(socket, session, actor, payload) {
  if (!session.client) throw new Error("SSH 尚未连接");
  if (session.activeStream) throw new Error("当前对话仍有任务在运行");
  if (payload.agentId && !String(payload.agentId).startsWith("opencode")) {
    throw new Error("当前版本已实现 OpenCode 适配；其他 Agent 需要先添加命令适配模板");
  }
  const secrets = await getSecrets(actor);
  const context = await buildContext({
    actor,
    mode: "work",
    prompt: String(payload.prompt || ""),
    skillIds: Array.isArray(payload.skills) ? payload.skills : [],
    projectId: payload.projectId ? String(payload.projectId) : undefined,
    memoryMode: payload.memoryMode === "project-only" ? "project-only" : "default",
    conversationId: String(payload.conversationId || ""),
  });
  const provider = context.state?.settings?.provider || {};
  if (!provider.configured || !secrets.providerApiKey) {
    throw new Error("请先在个人资料 → 模型 API 中配置接口");
  }
  await remoteExec(
    session.client,
    'mkdir -p "$HOME/.easywork/config" "$HOME/.easywork/runtime"',
  );
  await remoteSftpWrite(
    session.client,
    `${session.home}/.easywork/config/opencode.json`,
    `${JSON.stringify(providerConfigForOpenCode(provider), null, 2)}\n`,
  );
  const steps = workflowFor(String(payload.prompt || ""));
  wsSend(socket, {
    type: "workflow",
    conversationId: payload.conversationId,
    runId: payload.runId,
    steps,
  });
  const runtimeId = safeSegment(session.socketId);
  const runId = safeSegment(payload.runId);
  const remoteRuntime = `${session.home}/.easywork/runtime/${runtimeId}`;
  await remoteExec(session.client, `mkdir -p ${shellQuote(remoteRuntime)}`);
  const promptPath = `${remoteRuntime}/${runId}.prompt.md`;
  const envPath = `${remoteRuntime}/provider.env`;
  await remoteSftpWrite(session.client, promptPath, context.text);
  await remoteSftpWrite(
    session.client,
    envPath,
    `EASYWORK_LLM_API_KEY=${shellQuote(secrets.providerApiKey)}\n`,
  );
  const workspaceEncoded = Buffer.from(
    String(payload.workspace || "~/.easywork/tasks"),
    "utf8",
  ).toString("base64");
  const sessionId = session.agentSessions.get(String(payload.conversationId || ""));
  const bindingsPath = path.join(actorDirectory(actor), "work-sessions.json");
  const bindings = await readJson(bindingsPath, {});
  const bindingKey = [
    session.host || "unknown-host",
    session.username || "unknown-user",
    String(payload.agentId || "opencode"),
    String(payload.conversationId || ""),
  ].join("::");
  const boundSessionId = sessionId || bindings[bindingKey];
  const command = [
    `EW_DIR="$(printf %s ${shellQuote(workspaceEncoded)} | base64 -d)"`,
    'case "$EW_DIR" in "~/"*) EW_DIR="$HOME/${EW_DIR#~/}" ;; esac',
    'mkdir -p "$EW_DIR"',
    `set -a; . ${shellQuote(envPath)}; set +a`,
    [
      `OPENCODE_CONFIG=${shellQuote(`${session.home}/.easywork/config/opencode.json`)}`,
      shellQuote(`${session.home}/.easywork/bin/opencode`),
      "run --format json --auto",
      `--dir "$EW_DIR"`,
      `--model ${shellQuote(`easywork/${provider.model}`)}`,
      boundSessionId ? `--session ${shellQuote(boundSessionId)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  ];
  command[command.length - 1] =
    `cat ${shellQuote(promptPath)} | ${command[command.length - 1]}`;
  const commandText = command.join(" && ");

  const parserState = {
    sessionId: boundSessionId,
    finalText: "",
    eventIndex: 0,
    stepIndex: 0,
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
        const eventId =
          event.kind === "result"
            ? `${payload.runId}_result`
            : `${payload.runId}_event_${parserState.eventIndex++}`;
        if (event.kind === "tool" || event.kind === "terminal") {
          parserState.stepIndex = Math.min(parserState.stepIndex + 1, steps.length - 1);
        }
        wsSend(socket, {
          type: "agent.event",
          conversationId: payload.conversationId,
          runId: payload.runId,
          stepIndex: Math.min(parserState.stepIndex, steps.length - 1),
          event: {
            id: eventId,
            ...event,
            timestamp: isoNow(),
          },
        });
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
  }
  await remoteExec(session.client, `rm -f ${shellQuote(promptPath)}`, { allowFailure: true });
  if (result.code !== 0) {
    throw new Error(stderrOutput.trim() || `OpenCode 退出码 ${result.code}`);
  }
  const finalText = parserState.finalText.trim() || "Agent 已完成任务，未返回额外文本。";
  wsSend(socket, {
    type: "agent.event",
    conversationId: payload.conversationId,
    runId: payload.runId,
    stepIndex: steps.length - 1,
    event: {
      id: `${payload.runId}_result`,
      kind: "result",
      title: "任务结果",
      output: finalText,
      status: "done",
      timestamp: isoNow(),
    },
  });
  wsSend(socket, {
    type: "task.complete",
    conversationId: payload.conversationId,
    runId: payload.runId,
    result: finalText,
  });
}

async function closeSshSession(session) {
  if (session.activeStream) session.activeStream.close();
  if (session.client) {
    const client = session.client;
    if (session.home) {
      await remoteExec(
        client,
        `rm -rf ${shellQuote(`${session.home}/.easywork/runtime/${safeSegment(session.socketId)}`)}`,
        { allowFailure: true },
      ).catch(() => undefined);
    }
    client.end();
  }
  session.client = null;
  session.activeStream = null;
}

async function connectSsh(socket, session, actor, payload) {
  await closeSshSession(session);
  if (payload.demo) {
    session.demo = true;
    wsSend(socket, {
      type: "connection.status",
      status: "connected",
      label: "演示登录节点在线",
      host: "demo.easywork.local",
      username: "demo",
      latency: 18,
      demo: true,
    });
    wsSend(socket, {
      type: "agent.list",
      agents: [
        {
          id: "opencode",
          name: "OpenCode",
          path: "~/.easywork/bin/opencode",
          version: "demo",
          status: "ready",
          adapter: "opencode",
          managed: true,
        },
      ],
    });
    return;
  }

  const host = String(payload.host || "").trim();
  const username = String(payload.username || "").trim();
  const privateKey = String(payload.privateKey || "");
  const port = Number(payload.port || 22);
  if (!host || !username || !privateKey) throw new Error("主机、用户名和私钥不能为空");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH 端口无效");

  const knownHostsPath = path.join(actorDirectory(actor), "known-hosts.json");
  const knownHosts = await readJson(knownHostsPath, {});
  let observedFingerprint = "";
  const startedAt = Date.now();
  const client = new SshClient();
  session.demo = false;
  session.client = client;

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };
    client
      .on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
        const replies = prompts.map((prompt) => {
          const label = String(prompt.prompt || "");
          if (/verification|code|otp|token|验证码/i.test(label)) return String(payload.otp || "");
          if (/password|passphrase|口令|密码/i.test(label)) {
            return String(payload.passphrase || "");
          }
          return String(payload.otp || "");
        });
        finish(replies);
      })
      .once("ready", async () => {
        if (settled) return;
        settled = true;
        try {
          const homeResult = await remoteExec(client, 'printf "%s" "$HOME"');
          session.home = homeResult.stdout.trim();
          session.host = host;
          session.username = username;
          if (payload.trustHost && observedFingerprint) {
            knownHosts[`${host}:${port}`] = observedFingerprint;
            await writeJson(knownHostsPath, knownHosts);
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      })
      .once("error", (error) => {
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
          wsSend(socket, {
            type: "connection.status",
            status: "disconnected",
            label: "SSH 连接已关闭",
          });
        }
      })
      .connect({
        host,
        port,
        username,
        privateKey,
        passphrase: payload.passphrase ? String(payload.passphrase) : undefined,
        tryKeyboard: true,
        readyTimeout: 25_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => {
          observedFingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          const known = knownHosts[`${host}:${port}`];
          return Boolean(payload.trustHost || (known && known === observedFingerprint));
        },
      });
  });

  wsSend(socket, {
    type: "connection.status",
    status: "connected",
    label: "算力平台登录节点在线",
    host,
    username,
    latency: Date.now() - startedAt,
    fingerprint: observedFingerprint,
  });
  wsSend(socket, { type: "agent.list", agents: await scanRemoteAgents(session) });
}

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname !== "/ws") {
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
    const responseShim = {
      setHeader() {},
    };
    const actor = await resolveActor(req, responseShim, false);
    const session = {
      socketId: crypto.randomUUID(),
      client: null,
      demo: false,
      home: "",
      host: "",
      username: "",
      activeStream: null,
      activeRun: null,
      agentSessions: new Map(),
    };
    activeSockets.add(socket);
    socket.on("message", async (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        wsSend(socket, { type: "error", error: "WebSocket 消息不是有效 JSON" });
        return;
      }
      try {
        if (payload.type === "ssh.connect") {
          wsSend(socket, {
            type: "connection.status",
            status: "connecting",
            label: payload.demo ? "正在创建演示会话…" : "正在进行 SSH 握手…",
          });
          await connectSsh(socket, session, actor, payload);
          return;
        }
        if (payload.type === "ssh.disconnect") {
          await closeSshSession(session);
          wsSend(socket, {
            type: "connection.status",
            status: "disconnected",
            label: "已主动断开",
          });
          return;
        }
        if (payload.type === "agent.scan") {
          wsSend(socket, { type: "agent.list", agents: await scanRemoteAgents(session) });
          return;
        }
        if (payload.type === "agent.install") {
          wsSend(socket, {
            type: "agent.list",
            agents: [
              {
                id: "opencode",
                name: "OpenCode",
                path: "~/.easywork/bin/opencode",
                status: "installing",
                adapter: "opencode",
                managed: true,
              },
            ],
          });
          wsSend(socket, { type: "agent.list", agents: await installOpenCode(session, actor) });
          return;
        }
        if (payload.type === "work.run") {
          await runRemoteWork(socket, session, actor, payload);
          return;
        }
        if (payload.type === "work.abort") {
          if (session.activeStream) session.activeStream.close();
          wsSend(socket, {
            type: "task.error",
            conversationId: payload.conversationId,
            runId: payload.runId,
            result: "任务已由用户停止",
          });
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "远端操作失败";
        if (payload.type === "ssh.connect") {
          wsSend(socket, {
            type: "connection.status",
            status: "error",
            label: message,
            fingerprint: caught?.fingerprint,
          });
        } else if (payload.type === "work.run") {
          session.activeStream = null;
          session.activeRun = null;
          wsSend(socket, {
            type: "task.error",
            conversationId: payload.conversationId,
            runId: payload.runId,
            result: message,
          });
        } else if (payload.type === "agent.install") {
          wsSend(socket, {
            type: "agent.list",
            agents: [
              {
                id: "opencode",
                name: "OpenCode",
                path: "~/.easywork/bin/opencode",
                status: "missing",
                adapter: "opencode",
                managed: true,
              },
            ],
          });
          wsSend(socket, { type: "error", error: message });
        } else {
          wsSend(socket, { type: "error", error: message });
        }
      }
    });
    socket.on("close", async () => {
      activeSockets.delete(socket);
      await closeSshSession(session).catch(() => undefined);
    });
  });
  return wss;
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
  return { server, wss };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server } = await createEasyWorkServer();
  server.listen(PORT, HOST, () => {
    console.log(`EasyWork gateway listening on http://${HOST}:${PORT}`);
  });
}
