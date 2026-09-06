import crypto from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";

import { assertNoSensitiveFields, invariant } from "../errors.mjs";
import {
  assertExactObject,
  normalizeMime,
  normalizePreviewName,
  normalizePreviewSource,
  normalizeRange,
  previewKindFor,
  publicPreviewDescriptor,
} from "./contract.mjs";
import { MemoryPreviewSessionStore } from "./store.mjs";

const DEFAULTS = Object.freeze({
  ttlMs: 10 * 60_000,
  maxTtlMs: 60 * 60_000,
  maxMetadataBytes: 32 * 1024,
  maxSourceBytes: 1024 * 1024 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxJsonBytes: 4 * 1024 * 1024,
  maxCsvBytes: 2 * 1024 * 1024,
  maxCsvRows: 1000,
  maxRangeBytes: 16 * 1024 * 1024,
});

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), "PREVIEW_CLOCK_INVALID", "预览时钟无效", { status: 500, expose: false });
  return date.toISOString();
}

function actorKey(actor) {
  invariant(actor?.actorType === "user" || actor?.actorType === "guest", "ACTOR_CONTEXT_REQUIRED", "需要有效 ActorContext", { status: 401 });
  invariant(typeof actor.actorId === "string" && actor.actorId.length > 0, "ACTOR_CONTEXT_REQUIRED", "需要有效 ActorContext", { status: 401 });
  return `${actor.actorType}:${actor.actorId}`;
}

function normalizeLimit(value, fallback, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const result = value ?? fallback;
  invariant(Number.isSafeInteger(result) && result >= min && result <= max, "PREVIEW_LIMIT_INVALID", `${field} 无效`, { status: 500, expose: false });
  return result;
}

function normalizeTtl(value, defaults) {
  const ttl = value ?? defaults.ttlMs;
  invariant(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= defaults.maxTtlMs, "PREVIEW_TTL_INVALID", "预览有效期无效", {
    status: 400,
    details: { maxTtlMs: defaults.maxTtlMs },
  });
  return ttl;
}

function cloneJsonMetadata(value, maxBytes) {
  if (value === undefined || value === null) return {};
  invariant(value && typeof value === "object" && !Array.isArray(value), "PREVIEW_METADATA_INVALID", "预览 metadata 必须是对象", { status: 400 });
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invariant(false, "PREVIEW_METADATA_INVALID", "预览 metadata 必须可序列化", { status: 400 });
  }
  invariant(Buffer.byteLength(serialized) <= maxBytes, "PREVIEW_METADATA_TOO_LARGE", "预览 metadata 超出上限", {
    status: 413,
    details: { maxMetadataBytes: maxBytes },
  });
  const result = JSON.parse(serialized);
  invariant(Object.getPrototypeOf(result) === Object.prototype, "PREVIEW_METADATA_INVALID", "预览 metadata 无效", { status: 400 });
  assertNoSensitiveFields(result, "preview.metadata");
  const privateMetadataKeys = new Set(["path", "filepath", "canonicalpath", "remotepath", "sourceid", "serveridentity", "workspaceid", "locator", "token", "downloadtoken"]);
  const inspectKeys = (entry) => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, nested] of Object.entries(entry)) {
      const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      invariant(!privateMetadataKeys.has(normalizedKey), "PREVIEW_METADATA_PRIVATE_FIELD", "预览 metadata 不能包含私有定位信息", { status: 400 });
      inspectKeys(nested);
    }
  };
  inspectKeys(result);
  return result;
}

function normalizeInspection(value, options) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "PREVIEW_INSPECTION_INVALID", "预览来源检查失败", { status: 502 });
  invariant(value.authorized === true, "PREVIEW_SOURCE_FORBIDDEN", "无权预览该来源", { status: 403 });
  invariant(Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= options.maxSourceBytes, "PREVIEW_SOURCE_SIZE_INVALID", "预览来源大小无效或超出上限", {
    status: value.size > options.maxSourceBytes ? 413 : 502,
    details: { maxSourceBytes: options.maxSourceBytes },
  });
  return {
    size: value.size,
    mime: normalizeMime(value.mime),
    name: normalizePreviewName(value.name),
    supportsRange: value.supportsRange !== false,
    metadata: cloneJsonMetadata(value.metadata, options.maxMetadataBytes),
  };
}

function asReadable(value) {
  const candidate = value?.stream ?? value;
  invariant(candidate && !Buffer.isBuffer(candidate) && typeof candidate !== "string", "PREVIEW_STREAM_REQUIRED", "预览来源必须返回流", { status: 502 });
  if (candidate instanceof Readable) return candidate;
  if (typeof candidate?.getReader === "function") return Readable.fromWeb(candidate);
  if (typeof candidate?.[Symbol.asyncIterator] === "function") return Readable.from(candidate);
  invariant(false, "PREVIEW_STREAM_REQUIRED", "预览来源必须返回流", { status: 502 });
}

async function readBounded(stream, maxBytes) {
  const chunks = [];
  let length = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const remaining = maxBytes - length;
      if (remaining <= 0) break;
      chunks.push(chunk.subarray(0, remaining));
      length += Math.min(chunk.length, remaining);
      if (chunk.length > remaining || length >= maxBytes) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, length);
}

function decodeUtf8(buffer, { allowIncompleteTail = false } = {}) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxDrop = allowIncompleteTail ? Math.min(3, buffer.length) : 0;
  for (let drop = 0; drop <= maxDrop; drop += 1) {
    try {
      return decoder.decode(drop === 0 ? buffer : buffer.subarray(0, buffer.length - drop));
    } catch {
      // Only an incomplete trailing code point may be removed. Invalid bytes in the
      // body still fail all four attempts.
    }
  }
  invariant(false, "PREVIEW_UTF8_INVALID", "文本预览不是有效 UTF-8", { status: 422 });
}

function limitedCsv(text, maxRows) {
  let quoted = false;
  let rows = 0;
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      rows += 1;
      if (rows >= maxRows) {
        end = index + 1;
        break;
      }
    }
  }
  if (end === text.length && text.length > 0 && rows < maxRows) rows += 1;
  return { text: text.slice(0, end), rows: Math.min(rows, maxRows), rowsTruncated: end < text.length };
}

class ExactLengthTransform extends Transform {
  #expected;
  #seen = 0;

  constructor(expected) {
    super();
    this.#expected = expected;
  }

  _transform(chunk, _encoding, callback) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#seen += value.length;
    if (this.#seen > this.#expected) {
      callback(Object.assign(new Error("preview source exceeded declared range"), { code: "PREVIEW_STREAM_LENGTH_MISMATCH" }));
      return;
    }
    callback(null, value);
  }

  _flush(callback) {
    if (this.#seen !== this.#expected) {
      callback(Object.assign(new Error("preview source did not satisfy declared range"), { code: "PREVIEW_STREAM_LENGTH_MISMATCH" }));
      return;
    }
    callback();
  }
}

export class PreviewService {
  #actor;
  #actorKey;
  #store;
  #clock;
  #idFactory;
  #hostSource;
  #remoteSource;
  #limits;

  constructor(options = {}) {
    this.#actor = options.actor;
    this.#actorKey = actorKey(options.actor);
    this.#store = options.store || new MemoryPreviewSessionStore();
    this.#clock = options.clock || (() => new Date());
    this.#idFactory = options.idFactory || (() => `preview_${crypto.randomBytes(24).toString("base64url")}`);
    this.#hostSource = options.hostSource || null;
    this.#remoteSource = options.remoteSource || null;
    this.#limits = Object.freeze({
      ttlMs: normalizeLimit(options.ttlMs, DEFAULTS.ttlMs, "ttlMs"),
      maxTtlMs: normalizeLimit(options.maxTtlMs, DEFAULTS.maxTtlMs, "maxTtlMs"),
      maxMetadataBytes: normalizeLimit(options.maxMetadataBytes, DEFAULTS.maxMetadataBytes, "maxMetadataBytes"),
      maxSourceBytes: normalizeLimit(options.maxSourceBytes, DEFAULTS.maxSourceBytes, "maxSourceBytes"),
      maxTextBytes: normalizeLimit(options.maxTextBytes, DEFAULTS.maxTextBytes, "maxTextBytes"),
      maxJsonBytes: normalizeLimit(options.maxJsonBytes, DEFAULTS.maxJsonBytes, "maxJsonBytes"),
      maxCsvBytes: normalizeLimit(options.maxCsvBytes, DEFAULTS.maxCsvBytes, "maxCsvBytes"),
      maxCsvRows: normalizeLimit(options.maxCsvRows, DEFAULTS.maxCsvRows, "maxCsvRows", { max: 100_000 }),
      maxRangeBytes: normalizeLimit(options.maxRangeBytes, DEFAULTS.maxRangeBytes, "maxRangeBytes"),
    });
    invariant(this.#limits.ttlMs <= this.#limits.maxTtlMs, "PREVIEW_LIMIT_INVALID", "ttlMs 不能超过 maxTtlMs", { status: 500, expose: false });
  }

  async create(input = {}) {
    assertExactObject(input, ["source", "ttlMs"], "preview.create");
    const source = normalizePreviewSource(input.source);
    const ttlMs = normalizeTtl(input.ttlMs, this.#limits);
    const inspected = await this.#inspect(source);
    const kind = previewKindFor(inspected);
    const contentLimit = kind === "json"
      ? this.#limits.maxJsonBytes
      : kind === "csv"
        ? this.#limits.maxCsvBytes
        : kind === "text" || kind === "markdown"
          ? this.#limits.maxTextBytes
          : this.#limits.maxRangeBytes;
    const createdAt = nowIso(this.#clock);
    const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
    const id = this.#idFactory();
    invariant(typeof id === "string" && /^preview_[A-Za-z0-9_-]{16,}$/.test(id), "PREVIEW_ID_INVALID", "预览 ID 生成失败", { status: 500, expose: false });
    invariant(!this.#store.get(id), "PREVIEW_ID_COLLISION", "预览 ID 冲突", { status: 500, expose: false });
    const session = {
      id,
      actorKey: this.#actorKey,
      revision: 0,
      source,
      privateInspection: inspected.privateInspection,
      kind,
      name: inspected.name,
      mime: inspected.mime,
      size: inspected.size,
      supportsRange: inspected.supportsRange,
      metadata: inspected.metadata,
      contentLimit,
      maxCsvRows: this.#limits.maxCsvRows,
      createdAt,
      expiresAt,
      streams: new Set(),
      released: false,
    };
    this.#store.set(session);
    return publicPreviewDescriptor(session);
  }

  get(input = {}) {
    assertExactObject(input, ["previewId"], "preview.get");
    const { previewId } = input;
    return publicPreviewDescriptor(this.#requireSession(previewId));
  }

  head(input = {}) {
    assertExactObject(input, ["previewId"], "preview.head");
    const { previewId } = input;
    const session = this.#requireSession(previewId);
    return {
      descriptor: publicPreviewDescriptor(session),
      contentType: session.mime,
      contentLength: session.size,
      acceptsRange: session.supportsRange,
    };
  }

  async openContent(input = {}) {
    assertExactObject(input, ["previewId", "range"], "preview.openContent");
    const { previewId, range } = input;
    const session = this.#requireSession(previewId);
    if (["text", "markdown", "json", "csv"].includes(session.kind)) {
      invariant(range === undefined || range === null, "PREVIEW_TEXT_RANGE_FORBIDDEN", "结构化文本预览不接受客户端 Range", { status: 416 });
      return this.#openText(session);
    }
    invariant(range !== undefined && range !== null || session.size <= this.#limits.maxRangeBytes, "PREVIEW_RANGE_REQUIRED", "大二进制预览必须使用 Range", {
      status: 416,
      details: { maxRangeBytes: this.#limits.maxRangeBytes },
    });
    const normalizedRange = normalizeRange(range, session.size, this.#limits.maxRangeBytes);
    invariant(!normalizedRange || session.supportsRange, "PREVIEW_RANGE_UNSUPPORTED", "预览来源不支持 Range", { status: 416 });
    const effectiveRange = normalizedRange || { start: 0, endExclusive: session.size };
    const raw = await this.#openSource(session, effectiveRange);
    const guard = new ExactLengthTransform(effectiveRange.endExclusive - effectiveRange.start);
    raw.once("error", (error) => guard.destroy(error));
    guard.once("close", () => raw.destroy());
    raw.pipe(guard);
    this.#trackStream(session, raw);
    this.#trackStream(session, guard);
    return {
      descriptor: publicPreviewDescriptor(session),
      contentType: session.mime,
      contentLength: effectiveRange.endExclusive - effectiveRange.start,
      contentRange: normalizedRange ? { ...effectiveRange, total: session.size } : null,
      truncated: false,
      stream: guard,
    };
  }

  async renew(input = {}) {
    assertExactObject(input, ["previewId", "expectedRevision", "ttlMs"], "preview.renew");
    const { previewId, expectedRevision, ttlMs } = input;
    const session = this.#requireSession(previewId);
    invariant(Number.isSafeInteger(expectedRevision) && expectedRevision === session.revision, "REVISION_CONFLICT", "Preview revision 已变化", {
      status: 409,
      details: { expectedRevision, currentRevision: session.revision },
    });
    const ttl = normalizeTtl(ttlMs, this.#limits);
    session.revision += 1;
    session.expiresAt = new Date(Date.parse(nowIso(this.#clock)) + ttl).toISOString();
    return publicPreviewDescriptor(session);
  }

  async close(input = {}) {
    assertExactObject(input, ["previewId", "expectedRevision"], "preview.close");
    const { previewId, expectedRevision } = input;
    const session = this.#requireSession(previewId);
    invariant(expectedRevision === undefined || (Number.isSafeInteger(expectedRevision) && expectedRevision === session.revision), "REVISION_CONFLICT", "Preview revision 已变化", {
      status: 409,
      details: { expectedRevision, currentRevision: session.revision },
    });
    const closedRevision = session.revision + 1;
    await this.#release(session, "closed");
    return { previewId: session.id, revision: closedRevision, closed: true };
  }

  async expireDue() {
    const now = Date.parse(nowIso(this.#clock));
    const expiredPreviewIds = [];
    for (const session of [...this.#store.values()]) {
      if (session.actorKey !== this.#actorKey || Date.parse(session.expiresAt) > now) continue;
      expiredPreviewIds.push(session.id);
      await this.#release(session, "expired");
    }
    return { expiredPreviewIds };
  }

  async closeAll({ reason = "service-closed" } = {}) {
    const closedPreviewIds = [];
    for (const session of [...this.#store.values()]) {
      if (session.actorKey !== this.#actorKey) continue;
      closedPreviewIds.push(session.id);
      await this.#release(session, reason);
    }
    return { closedPreviewIds };
  }

  async #inspect(source) {
    if (source.kind === "host") {
      invariant(typeof this.#hostSource?.inspect === "function" && typeof this.#hostSource?.openReadStream === "function", "PREVIEW_HOST_SOURCE_UNAVAILABLE", "主机预览来源不可用", { status: 503 });
      const raw = await this.#hostSource.inspect({ actor: this.#actor, sourceId: source.sourceId, metadataLimit: this.#limits.maxMetadataBytes });
      const normalized = normalizeInspection(raw, this.#limits);
      return { ...normalized, privateInspection: { sourceId: source.sourceId, handle: raw.handle } };
    }
    invariant(typeof this.#remoteSource?.inspect === "function" && typeof this.#remoteSource?.openReadStream === "function", "PREVIEW_REMOTE_SOURCE_UNAVAILABLE", "远端预览来源不可用", { status: 503 });
    const raw = await this.#remoteSource.inspect({ actor: this.#actor, ...source, metadataLimit: this.#limits.maxMetadataBytes });
    invariant(raw?.resolved === true && raw?.withinAllowedRoot === true && raw?.symlinkSafe === true, "PREVIEW_REMOTE_PATH_FORBIDDEN", "远端预览路径未通过工作区校验", { status: 403 });
    invariant(typeof raw.canonicalPath === "string" && path.posix.isAbsolute(raw.canonicalPath) && !raw.canonicalPath.includes("\0"), "PREVIEW_REMOTE_INSPECTION_INVALID", "远端检查器未返回规范路径", { status: 502 });
    invariant(raw.serverIdentity === source.serverIdentity && raw.workspaceId === source.workspaceId, "PREVIEW_REMOTE_SCOPE_MISMATCH", "远端检查结果与请求作用域不一致", { status: 403 });
    const normalized = normalizeInspection(raw, this.#limits);
    return {
      ...normalized,
      privateInspection: {
        canonicalPath: raw.canonicalPath,
        serverIdentity: raw.serverIdentity,
        workspaceId: raw.workspaceId,
        handle: raw.handle,
      },
    };
  }

  #requireSession(previewId) {
    invariant(typeof previewId === "string" && /^preview_[A-Za-z0-9_-]{16,}$/.test(previewId), "PREVIEW_NOT_FOUND", "Preview 不存在", { status: 404 });
    const session = this.#store.get(previewId);
    invariant(session && session.actorKey === this.#actorKey, "PREVIEW_NOT_FOUND", "Preview 不存在", { status: 404 });
    if (Date.parse(session.expiresAt) <= Date.parse(nowIso(this.#clock))) {
      void this.#release(session, "expired").catch(() => undefined);
      invariant(false, "PREVIEW_EXPIRED", "Preview 已过期", { status: 410 });
    }
    return session;
  }

  async #openSource(session, range) {
    const provider = session.source.kind === "host" ? this.#hostSource : this.#remoteSource;
    const result = session.source.kind === "host"
      ? await provider.openReadStream({ actor: this.#actor, sourceId: session.source.sourceId, handle: session.privateInspection.handle, range })
      : await provider.openReadStream({ actor: this.#actor, ...session.privateInspection, range });
    const stream = asReadable(result);
    if (session.released || Date.parse(session.expiresAt) <= Date.parse(nowIso(this.#clock))) {
      stream.destroy();
      invariant(false, "PREVIEW_EXPIRED", "Preview 已关闭或过期", { status: 410 });
    }
    this.#trackStream(session, stream);
    return stream;
  }

  async #openText(session) {
    if (session.kind === "json") {
      invariant(session.size <= this.#limits.maxJsonBytes, "PREVIEW_CONTENT_TOO_LARGE", "JSON 预览超出内容上限", {
        status: 413,
        details: { maxBytes: this.#limits.maxJsonBytes },
      });
    }
    const limit = session.kind === "csv" ? this.#limits.maxCsvBytes : session.kind === "json" ? this.#limits.maxJsonBytes : this.#limits.maxTextBytes;
    const requested = Math.min(session.size, limit + 4);
    const raw = await this.#openSource(session, { start: 0, endExclusive: requested });
    const buffer = await readBounded(raw, requested);
    invariant(buffer.length === requested, "PREVIEW_STREAM_LENGTH_MISMATCH", "预览来源返回的内容长度不匹配", { status: 502 });
    const sourceTruncated = session.size > limit;
    let text = decodeUtf8(buffer.subarray(0, Math.min(buffer.length, limit)), { allowIncompleteTail: sourceTruncated });
    let rows;
    let rowsTruncated = false;
    if (session.kind === "csv") {
      const limited = limitedCsv(text, this.#limits.maxCsvRows);
      text = limited.text;
      rows = limited.rows;
      rowsTruncated = limited.rowsTruncated;
    }
    if (session.kind === "json") {
      try {
        JSON.parse(text);
      } catch {
        invariant(false, "PREVIEW_JSON_INVALID", "JSON 预览内容无效", { status: 422 });
      }
    }
    const content = Buffer.from(text, "utf8");
    const stream = Readable.from([content]);
    this.#trackStream(session, stream);
    return {
      descriptor: publicPreviewDescriptor(session),
      contentType: session.mime,
      contentLength: content.length,
      contentRange: null,
      truncated: sourceTruncated || rowsTruncated,
      ...(rows === undefined ? {} : { rows }),
      stream,
    };
  }

  #trackStream(session, stream) {
    session.streams.add(stream);
    const done = () => session.streams.delete(stream);
    stream.once("close", done);
    stream.once("end", done);
    stream.once("error", done);
  }

  async #release(session, reason) {
    if (session.released) return;
    session.released = true;
    this.#store.delete(session.id);
    for (const stream of session.streams) stream.destroy();
    session.streams.clear();
    const provider = session.source.kind === "host" ? this.#hostSource : this.#remoteSource;
    if (typeof provider?.release === "function") {
      const privateInput = session.source.kind === "host"
        ? { sourceId: session.source.sourceId, handle: session.privateInspection.handle }
        : session.privateInspection;
      await provider.release({ actor: this.#actor, ...privateInput, reason });
    }
  }
}

export const previewServiceDefaults = DEFAULTS;
