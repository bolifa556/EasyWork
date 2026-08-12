import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { createOpaqueCursorCodec } from "../cursor.mjs";
import { ApiError, invariant, redactSensitive } from "../errors.mjs";
import { createArtifact } from "../entities/artifact.mjs";
import { ARTIFACT_KINDS } from "../entities/artifact.mjs";
import { validateTask } from "../entities/task.mjs";
import { ActorMutationQueue } from "../mutation-queue.mjs";
import { assertExpectedRevision } from "../revision.mjs";
import {
  ARTIFACT_LIFECYCLES,
  ARTIFACT_STORE_SCHEMA_VERSION,
  assertArtifactCommandId,
  assertArtifactName,
  assertArtifactRecord,
  assertLifecycle,
  assertMime,
  clone,
  commandFingerprint,
  publicArtifactDetail,
  publicArtifactSummary,
} from "./contract.mjs";
import { ArtifactStorage } from "./storage.mjs";

const sharedArtifactMutationQueue = new ActorMutationQueue();
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_TTL_MS = 60 * 60 * 1000;

function assertAllowedKeys(value, allowed, field) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "ARTIFACT_INPUT_INVALID", `${field} 必须是对象`, { status: 400 });
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, "ARTIFACT_INPUT_UNKNOWN_FIELD", `${field} 包含未定义字段`, { status: 400, details: { field, unknown } });
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), "ARTIFACT_CLOCK_INVALID", "Artifact clock 无效", { status: 500, expose: false });
  return date.toISOString();
}

function safeName(value) {
  return assertArtifactName(String(redactSensitive(String(value || "artifact"))));
}

function normalizeKind(value) {
  const kind = String(value || "file");
  invariant(ARTIFACT_KINDS.includes(kind), "ARTIFACT_KIND_INVALID", "Artifact kind 无效", { status: 400, details: { allowed: ARTIFACT_KINDS } });
  return kind;
}

function normalizeExpiresAt(value, now, defaultRetentionMs) {
  if (value === null) return null;
  if (value === undefined) return new Date(Date.parse(now) + defaultRetentionMs).toISOString();
  const timestamp = Date.parse(String(value));
  invariant(Number.isFinite(timestamp) && new Date(timestamp).toISOString() === String(value), "ARTIFACT_EXPIRY_INVALID", "Artifact 过期时间无效", { status: 400 });
  return String(value);
}

function decodeInlineContent(payload) {
  invariant(typeof payload.content === "string" || Buffer.isBuffer(payload.content), "ARTIFACT_CONTENT_INVALID", "主机 Artifact content 必须是字符串或 Buffer", { status: 400 });
  if (Buffer.isBuffer(payload.content)) {
    invariant(payload.encoding === undefined || payload.encoding === "binary", "ARTIFACT_ENCODING_INVALID", "Buffer Artifact encoding 无效", { status: 400 });
    return Buffer.from(payload.content);
  }
  const encoding = payload.encoding || "utf8";
  invariant(["utf8", "base64"].includes(encoding), "ARTIFACT_ENCODING_INVALID", "Artifact encoding 只支持 utf8 或 base64", { status: 400 });
  if (encoding === "utf8") return Buffer.from(payload.content, "utf8");
  const content = Buffer.from(payload.content, "base64");
  invariant(content.toString("base64").replace(/=+$/, "") === payload.content.replace(/=+$/, ""), "ARTIFACT_BASE64_INVALID", "Artifact base64 内容无效", { status: 400 });
  return content;
}

function normalizeRange(range, size) {
  if (range === undefined || range === null) return { start: 0, endExclusive: size };
  assertAllowedKeys(range, ["start", "endExclusive"], "range");
  const start = Number(range.start);
  const endExclusive = Number(range.endExclusive);
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(endExclusive) && start >= 0 && endExclusive >= start && endExclusive <= size, "ARTIFACT_RANGE_INVALID", "Artifact 下载范围无效", {
    status: 416,
    details: { size },
  });
  return { start, endExclusive };
}

function versionFor(record, versionId) {
  const version = record.versions.find((entry) => entry.id === versionId);
  invariant(version, "ARTIFACT_VERSION_NOT_FOUND", "Artifact 版本不存在", { status: 404 });
  const locator = record.locators.find((entry) => entry.versionId === versionId);
  invariant(locator, "ARTIFACT_LOCATOR_MISSING", "Artifact 内容定位符缺失", { status: 500, expose: false });
  return { version, locator };
}

function updatedRecord(record, changes, clock) {
  const next = {
    ...clone(record),
    ...clone(changes),
    revision: record.revision + 1,
    updatedAt: nowIso(clock),
  };
  assertArtifactRecord(next);
  return next;
}

function filtersFrom(input) {
  const lifecycle = input.lifecycle === undefined
    ? ["active", "pinned"]
    : (Array.isArray(input.lifecycle) ? input.lifecycle : [input.lifecycle]);
  invariant(lifecycle.length >= 1 && lifecycle.length <= ARTIFACT_LIFECYCLES.length, "ARTIFACT_LIFECYCLE_FILTER_INVALID", "Artifact 生命周期筛选无效", { status: 400 });
  lifecycle.forEach((entry) => assertLifecycle(entry));
  return {
    taskId: input.taskId === undefined ? null : String(input.taskId),
    conversationId: input.conversationId === undefined ? null : String(input.conversationId),
    projectId: input.projectId === undefined ? null : String(input.projectId),
    workspaceId: input.workspaceId === undefined ? null : String(input.workspaceId),
    lifecycle: [...new Set(lifecycle)].sort(),
  };
}

function summaryMatches(summary, filters) {
  return (
    (filters.taskId === null || summary.taskId === filters.taskId)
    && (filters.conversationId === null || summary.conversationId === filters.conversationId)
    && (filters.projectId === null || summary.projectId === filters.projectId)
    && (filters.workspaceId === null || summary.workspaceId === filters.workspaceId)
    && filters.lifecycle.includes(summary.lifecycle)
  );
}

function sortedSummaries(summaries) {
  return [...summaries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
}

async function commandResult(storage, existing, fingerprint) {
  invariant(existing.fingerprint === fingerprint, "ARTIFACT_COMMAND_REUSED", "commandId 已用于不同的 Artifact 操作", { status: 409 });
  invariant(existing.status === "completed" && existing.result, "ARTIFACT_COMMAND_INCOMPLETE", "Artifact 命令未完成", { status: 409 });
  if (existing.result.artifact?.id) {
    const artifact = await storage.readRecord(existing.result.artifact.id);
    invariant(artifact, "ARTIFACT_COMMAND_RESULT_GONE", "该幂等操作对应的 Artifact 已被清理", { status: 410 });
  }
  return { ...clone(existing.result), duplicate: true };
}

function sanitizeStreamErrors(source) {
  const output = new PassThrough();
  source.on("error", (error) => output.destroy(new ApiError("ARTIFACT_STREAM_FAILED", "无法读取 Artifact", { status: 502, cause: error })));
  source.pipe(output);
  return output;
}

export class ArtifactService {
  constructor(options) {
    invariant(options?.actor?.actorId, "ACTOR_CONTEXT_REQUIRED", "ArtifactService 需要 ActorContext", { status: 500, expose: false });
    invariant(typeof options?.dataRoot === "string" && path.isAbsolute(options.dataRoot), "DATA_ROOT_INVALID", "ArtifactService 需要绝对 dataRoot", { status: 500, expose: false });
    invariant(typeof options?.authorizeTask === "function", "ARTIFACT_TASK_AUTHORIZER_REQUIRED", "ArtifactService 需要 Task 授权器", { status: 500, expose: false });
    invariant(typeof options?.authorizeProject === "function", "ARTIFACT_PROJECT_AUTHORIZER_REQUIRED", "ArtifactService 需要 Project 授权器", { status: 500, expose: false });
    const tokenSecret = String(options.downloadSecret || options.cursorSecret || "");
    invariant(tokenSecret.length >= 32, "ARTIFACT_TOKEN_SECRET_INVALID", "Artifact token secret 至少需要 32 个字符", { status: 500, expose: false });
    this.actor = options.actor;
    this.dataRoot = options.dataRoot;
    this.authorizeTask = options.authorizeTask;
    this.authorizeProject = options.authorizeProject;
    this.remoteSource = options.remoteSource || null;
    this.resourcePromoter = options.resourcePromoter || null;
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || ((kind) => `${kind}_${crypto.randomUUID()}`);
    this.maxInlineBytes = Number(options.maxInlineBytes ?? 1024 * 1024);
    this.defaultRetentionMs = Number(options.defaultRetentionMs ?? DEFAULT_RETENTION_MS);
    this.maxListLimit = Number(options.maxListLimit ?? 100);
    invariant(Number.isSafeInteger(this.maxInlineBytes) && this.maxInlineBytes > 0, "ARTIFACT_INLINE_LIMIT_INVALID", "Artifact 内联大小限制无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(this.defaultRetentionMs) && this.defaultRetentionMs > 0, "ARTIFACT_RETENTION_INVALID", "Artifact 保留时间无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(this.maxListLimit) && this.maxListLimit >= 1 && this.maxListLimit <= 1000, "ARTIFACT_LIST_LIMIT_INVALID", "Artifact 列表上限无效", { status: 500, expose: false });
    this.mutationQueue = options.mutationQueue || sharedArtifactMutationQueue;
    invariant(typeof this.mutationQueue?.run === "function", "ARTIFACT_MUTATION_QUEUE_INVALID", "Artifact 写队列无效", { status: 500, expose: false });
    this.storage = options.storage || new ArtifactStorage({
      actor: this.actor,
      dataRoot: this.dataRoot,
      indexPageSize: options.indexPageSize,
    });
    const namespace = `${this.actor.actorType}:${this.actor.actorId}`;
    this.cursorCodec = createOpaqueCursorCodec({ secret: tokenSecret, namespace: `artifact-list:${namespace}` });
    this.downloadCodec = createOpaqueCursorCodec({ secret: tokenSecret, namespace: `artifact-download:${namespace}`, defaultTtlMs: Math.min(options.downloadTtlMs ?? 5 * 60 * 1000, MAX_DOWNLOAD_TTL_MS) });
  }

  #newId(kind) {
    const id = String(this.idFactory(kind));
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id), "ARTIFACT_ID_INVALID", `${kind} ID 无效`, { status: 500, expose: false });
    return id;
  }

  async #authorizeTask(task, action) {
    validateTask(task);
    invariant(task.actorId === this.actor.actorId, "ARTIFACT_TASK_FORBIDDEN", "Task 不属于当前 Actor", { status: 403 });
    const allowed = await this.authorizeTask({ actor: this.actor, task: clone(task), taskId: task.id, action });
    invariant(allowed !== false, "ARTIFACT_TASK_FORBIDDEN", "当前 Actor 无权访问该 Task 的 Artifact", { status: 403 });
  }

  async #authorizeProject(projectId, action) {
    const allowed = await this.authorizeProject({ actor: this.actor, projectId, action });
    invariant(allowed !== false, "ARTIFACT_PROJECT_FORBIDDEN", "当前 Actor 无权操作该项目", { status: 403 });
  }

  async #readRecord(id) {
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(id || "")), "ARTIFACT_ID_INVALID", "Artifact ID 无效", { status: 400 });
    const record = await this.storage.readRecord(String(id));
    invariant(record, "ARTIFACT_NOT_FOUND", "Artifact 不存在", { status: 404 });
    return record;
  }

  async #commitIndex(root, summaries) {
    const generationId = `generation_${crypto.randomUUID()}`;
    const sorted = sortedSummaries(summaries);
    await this.storage.stageIndexGeneration(generationId, sorted);
    return this.storage.commitIndexGeneration(generationId, sorted.length, root.revision, this.clock);
  }

  async #runCommand(commandIdValue, operation, fingerprintInput, execute) {
    const commandId = assertArtifactCommandId(commandIdValue);
    const fingerprint = commandFingerprint(operation, fingerprintInput);
    return this.mutationQueue.run(this.actor, async () => {
      const existing = await this.storage.readCommand(commandId);
      if (existing) return commandResult(this.storage, existing, fingerprint);
      const root = await this.storage.readIndexRoot();
      const summaries = await this.storage.readIndexGeneration(root.data.generationId);
      const mutation = await execute({ root, summaries });
      const committed = mutation.summaries
        ? await this.#commitIndex(root, mutation.summaries)
        : root;
      const result = {
        ...clone(mutation.result),
        storeRevision: committed.revision,
      };
      await this.storage.writeCommand(commandId, {
        schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
        commandId,
        operation,
        fingerprint,
        status: "completed",
        result: clone(result),
        completedAt: nowIso(this.clock),
      });
      return { ...result, duplicate: false };
    });
  }

  async capture(input) {
    assertAllowedKeys(input, ["task", "event", "commandId"], "capture");
    const task = input.task;
    await this.#authorizeTask(task, "capture");
    invariant(input.event?.kind === "artifact" && input.event.payload && typeof input.event.payload === "object", "ARTIFACT_EVENT_INVALID", "capture 只接受规范 Artifact 事件", { status: 400 });
    const payload = input.event.payload;
    const sequence = Number(input.event.sequence);
    const commandId = input.commandId || (Number.isSafeInteger(sequence) && sequence >= 0 ? `capture:${task.id}:${sequence}` : null);
    invariant(commandId, "ARTIFACT_COMMAND_ID_REQUIRED", "Artifact 事件缺少可幂等的 commandId 或 sequence", { status: 400 });
    invariant(["host", "remote"].includes(payload.source), "ARTIFACT_SOURCE_INVALID", "Artifact 事件必须明确 source", { status: 400 });

    if (payload.source === "host") {
      assertAllowedKeys(payload, ["source", "content", "encoding", "name", "kind", "mime", "expiresAt"], "artifact.payload");
      const content = decodeInlineContent(payload);
      invariant(content.length <= this.maxInlineBytes, "ARTIFACT_INLINE_TOO_LARGE", "主机内联 Artifact 超过大小限制，应登记为远端引用", {
        status: 413,
        details: { maxInlineBytes: this.maxInlineBytes },
      });
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      return this.#runCommand(commandId, "capture", {
        taskId: task.id,
        sequence,
        source: "host",
        sha256,
        name: String(payload.name || "artifact"),
        kind: String(payload.kind || "file"),
        mime: String(payload.mime || "application/octet-stream"),
        expiresAt: payload.expiresAt === undefined ? "default" : payload.expiresAt,
      }, async ({ summaries }) => {
        const now = nowIso(this.clock);
        const name = safeName(payload.name || "artifact");
        const kind = normalizeKind(payload.kind);
        const mime = assertMime(payload.mime || "application/octet-stream");
        const artifactId = this.#newId("artifact");
        const versionId = this.#newId("artifact_version");
        const blob = await this.storage.ensureBlob(sha256, content);
        const blobId = `artifact_blob_${sha256.slice(0, 32)}`;
        const originArtifact = createArtifact({
          id: artifactId,
          actorId: this.actor.actorId,
          taskId: task.id,
          serverIdentity: null,
          kind,
          source: "host",
          remotePath: null,
          blobId,
          size: content.length,
          sha256,
          mime,
        }, { clock: () => new Date(now) });
        const record = {
          schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
          entityType: "ArtifactRecord",
          revision: 0,
          id: artifactId,
          actorId: this.actor.actorId,
          taskId: task.id,
          conversationId: task.conversationId,
          workspaceId: task.route.workspaceId,
          projectId: null,
          name,
          kind,
          mime,
          size: content.length,
          sha256,
          source: "host",
          contentLocation: "host-small-file",
          lifecycle: "active",
          activeVersionId: versionId,
          versions: [{ id: versionId, ordinal: 1, source: "host", contentLocation: "host-small-file", size: content.length, sha256, mime, capturedAt: now }],
          originArtifact,
          locators: [{ versionId, source: "host", actorRelativePath: blob.relativePath, remotePath: null, serverIdentity: null }],
          promotion: null,
          expiresAt: normalizeExpiresAt(payload.expiresAt, now, this.defaultRetentionMs),
          pinnedAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        assertArtifactRecord(record);
        await this.storage.writeRecord(record);
        return {
          summaries: [...summaries, publicArtifactSummary(record)],
          result: { artifact: clone(redactSensitive(publicArtifactDetail(record))) },
        };
      });
    }

    assertAllowedKeys(payload, ["source", "path", "name", "kind", "expiresAt"], "artifact.payload");
    invariant(typeof this.remoteSource?.inspect === "function", "ARTIFACT_REMOTE_SOURCE_UNAVAILABLE", "远端 Artifact 检查器不可用", { status: 503 });
    invariant(typeof payload.path === "string" && payload.path.length > 0 && payload.path.length <= 32768 && !payload.path.includes("\0"), "ARTIFACT_REMOTE_PATH_INVALID", "远端 Artifact path 无效", { status: 400 });
    const pathFingerprint = crypto.createHash("sha256").update(payload.path).digest("hex");
    return this.#runCommand(commandId, "capture", {
      taskId: task.id,
      sequence,
      source: "remote",
      pathFingerprint,
      name: String(payload.name || "artifact"),
      kind: String(payload.kind || "file"),
      expiresAt: payload.expiresAt === undefined ? "default" : payload.expiresAt,
    }, async ({ summaries }) => {
      let inspected;
      try {
        inspected = await this.remoteSource.inspect({
          actor: this.actor,
          task: clone(task),
          workspaceId: task.route.workspaceId,
          serverIdentity: task.route.serverIdentity,
          candidatePath: payload.path,
        });
      } catch (error) {
        throw new ApiError("ARTIFACT_REMOTE_INSPECTION_FAILED", "无法验证远端 Artifact", { status: 502, cause: error });
      }
      invariant(inspected?.authorized === true && inspected.resolved === true && inspected.withinAllowedRoot === true && inspected.symlinkSafe === true, "ARTIFACT_REMOTE_PATH_FORBIDDEN", "远端 Artifact 不在任务允许的工作区中", { status: 403 });
      invariant(inspected.serverIdentity === task.route.serverIdentity && inspected.workspaceId === task.route.workspaceId, "ARTIFACT_REMOTE_SCOPE_MISMATCH", "远端 Artifact 与任务工作区不一致", { status: 403 });
      invariant(typeof inspected.canonicalPath === "string" && inspected.canonicalPath.startsWith("/") && !inspected.canonicalPath.includes("\0"), "ARTIFACT_REMOTE_INSPECTION_INVALID", "远端 Artifact 检查结果无效", { status: 500, expose: false });
      const size = Number(inspected.size);
      invariant(Number.isSafeInteger(size) && size >= 0, "ARTIFACT_REMOTE_INSPECTION_INVALID", "远端 Artifact 大小无效", { status: 500, expose: false });
      const sha256 = String(inspected.sha256 || "");
      invariant(/^[a-f0-9]{64}$/.test(sha256), "ARTIFACT_REMOTE_HASH_REQUIRED", "远端 Artifact 必须完成内容 hash 后才能登记", { status: 502 });
      const mime = assertMime(inspected.mime || "application/octet-stream");
      const name = safeName(payload.name || inspected.name || "artifact");
      const kind = normalizeKind(payload.kind);
      const now = nowIso(this.clock);
      const artifactId = this.#newId("artifact");
      const versionId = this.#newId("artifact_version");
      const originArtifact = createArtifact({
        id: artifactId,
        actorId: this.actor.actorId,
        taskId: task.id,
        serverIdentity: task.route.serverIdentity,
        kind,
        source: "remote",
        remotePath: inspected.canonicalPath,
        blobId: null,
        size,
        sha256,
        mime,
      }, { clock: () => new Date(now) });
      const record = {
        schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
        entityType: "ArtifactRecord",
        revision: 0,
        id: artifactId,
        actorId: this.actor.actorId,
        taskId: task.id,
        conversationId: task.conversationId,
        workspaceId: task.route.workspaceId,
        projectId: null,
        name,
        kind,
        mime,
        size,
        sha256,
        source: "remote",
        contentLocation: "remote-reference",
        lifecycle: "active",
        activeVersionId: versionId,
        versions: [{ id: versionId, ordinal: 1, source: "remote", contentLocation: "remote-reference", size, sha256, mime, capturedAt: now }],
        originArtifact,
        locators: [{ versionId, source: "remote", actorRelativePath: null, remotePath: inspected.canonicalPath, serverIdentity: task.route.serverIdentity }],
        promotion: null,
        expiresAt: normalizeExpiresAt(payload.expiresAt, now, this.defaultRetentionMs),
        pinnedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      assertArtifactRecord(record);
      await this.storage.writeRecord(record);
      return {
        summaries: [...summaries, publicArtifactSummary(record)],
        result: { artifact: clone(redactSensitive(publicArtifactDetail(record))) },
      };
    });
  }

  async get(input) {
    assertAllowedKeys(input, ["artifactId"], "get");
    const record = await this.#readRecord(input.artifactId);
    return clone(redactSensitive(publicArtifactDetail(record)));
  }

  async list(input = {}) {
    assertAllowedKeys(input, ["cursor", "limit", "taskId", "conversationId", "projectId", "workspaceId", "lifecycle"], "list");
    const limit = Number(input.limit ?? 20);
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= this.maxListLimit, "ARTIFACT_LIST_LIMIT_INVALID", "Artifact 列表 limit 无效", { status: 400, details: { max: this.maxListLimit } });
    const filters = filtersFrom(input);
    const root = await this.storage.readIndexRoot();
    let offset = 0;
    if (input.cursor) {
      const decoded = this.cursorCodec.decode(input.cursor, { now: Date.parse(nowIso(this.clock)) });
      invariant(decoded.actorId === this.actor.actorId && decoded.generationId === root.data.generationId, "ARTIFACT_CURSOR_STALE", "Artifact 列表已变化，请重新加载", { status: 409 });
      invariant(JSON.stringify(decoded.filters) === JSON.stringify(filters), "ARTIFACT_CURSOR_FILTER_MISMATCH", "Artifact 游标与筛选条件不一致", { status: 400 });
      offset = Number(decoded.offset);
      invariant(Number.isSafeInteger(offset) && offset >= 0, "ARTIFACT_CURSOR_INVALID", "Artifact 游标 offset 无效", { status: 400 });
    }
    const summaries = await this.storage.readIndexGeneration(root.data.generationId);
    const filtered = summaries.filter((summary) => summaryMatches(summary, filters));
    const items = filtered.slice(offset, offset + limit).map((entry) => clone(redactSensitive(entry)));
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length
      ? this.cursorCodec.encode(
        { actorId: this.actor.actorId, generationId: root.data.generationId, offset: nextOffset, filters },
        { now: Date.parse(nowIso(this.clock)) },
      )
      : null;
    return { items, nextCursor, total: filtered.length, storeRevision: root.revision };
  }

  async #changeLifecycle(input, operation, targetLifecycle) {
    assertAllowedKeys(input, ["artifactId", "expectedRevision", "commandId"], operation);
    return this.#runCommand(input.commandId, operation, { artifactId: input.artifactId, expectedRevision: input.expectedRevision }, async ({ summaries }) => {
      const record = await this.#readRecord(input.artifactId);
      assertExpectedRevision(record.revision, input.expectedRevision);
      invariant(!["deleted", "expired"].includes(record.lifecycle), "ARTIFACT_TERMINAL_LIFECYCLE", "已删除或过期的 Artifact 不能修改生命周期", { status: 409 });
      if (targetLifecycle === "deleted") invariant(record.lifecycle !== "pinned", "ARTIFACT_PINNED", "固定的 Artifact 必须先取消固定才能删除", { status: 409 });
      const now = nowIso(this.clock);
      const next = updatedRecord(record, {
        lifecycle: targetLifecycle,
        pinnedAt: targetLifecycle === "pinned" ? now : null,
        deletedAt: targetLifecycle === "deleted" ? now : null,
        expiresAt: targetLifecycle === "pinned" ? null : record.expiresAt,
      }, this.clock);
      await this.storage.writeRecord(next);
      return {
        summaries: summaries.map((entry) => entry.id === next.id ? publicArtifactSummary(next) : entry),
        result: { artifact: clone(redactSensitive(publicArtifactDetail(next))) },
      };
    });
  }

  async pin(input) {
    return this.#changeLifecycle(input, "pin", "pinned");
  }

  async unpin(input) {
    assertAllowedKeys(input, ["artifactId", "expectedRevision", "commandId", "expiresAt"], "unpin");
    return this.#runCommand(input.commandId, "unpin", { artifactId: input.artifactId, expectedRevision: input.expectedRevision, expiresAt: input.expiresAt }, async ({ summaries }) => {
      const record = await this.#readRecord(input.artifactId);
      assertExpectedRevision(record.revision, input.expectedRevision);
      invariant(record.lifecycle === "pinned", "ARTIFACT_NOT_PINNED", "Artifact 当前未固定", { status: 409 });
      const now = nowIso(this.clock);
      const next = updatedRecord(record, {
        lifecycle: "active",
        pinnedAt: null,
        deletedAt: null,
        expiresAt: normalizeExpiresAt(input.expiresAt, now, this.defaultRetentionMs),
      }, this.clock);
      await this.storage.writeRecord(next);
      return {
        summaries: summaries.map((entry) => entry.id === next.id ? publicArtifactSummary(next) : entry),
        result: { artifact: clone(redactSensitive(publicArtifactDetail(next))) },
      };
    });
  }

  async delete(input) {
    return this.#changeLifecycle(input, "delete", "deleted");
  }

  async promoteToProject(input) {
    assertAllowedKeys(input, ["artifactId", "projectId", "expectedRevision", "commandId"], "promoteToProject");
    invariant(typeof this.resourcePromoter?.promote === "function", "ARTIFACT_RESOURCE_PROMOTER_UNAVAILABLE", "Artifact 转存服务不可用", { status: 503 });
    const projectId = String(input.projectId || "");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(projectId), "ARTIFACT_PROJECT_ID_INVALID", "projectId 无效", { status: 400 });
    await this.#authorizeProject(projectId, "write");
    return this.#runCommand(input.commandId, "promote", { artifactId: input.artifactId, projectId, expectedRevision: input.expectedRevision }, async ({ summaries }) => {
      const record = await this.#readRecord(input.artifactId);
      invariant(!["deleted", "expired"].includes(record.lifecycle), "ARTIFACT_NOT_AVAILABLE", "已删除或过期的 Artifact 不能转存", { status: 410 });
      invariant(record.promotion === null || record.promotion.projectId === projectId, "ARTIFACT_ALREADY_PROMOTED", "Artifact 已转存到其他项目", { status: 409 });
      if (record.promotion !== null) {
        return {
          summaries: summaries.map((entry) => entry.id === record.id ? publicArtifactSummary(record) : entry),
          result: { artifact: clone(redactSensitive(publicArtifactDetail(record))), promotion: clone(record.promotion) },
        };
      }
      assertExpectedRevision(record.revision, input.expectedRevision);
      const promoted = await this.resourcePromoter.promote({
        actor: this.actor,
        projectId,
        artifact: clone(redactSensitive(publicArtifactDetail(record))),
        commandId: input.commandId,
        openSource: (range) => this.#openRecord(record, range),
      });
      invariant(promoted && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(promoted.resourceVersionId || "")) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(promoted.bindingId || "")), "ARTIFACT_PROMOTION_RESULT_INVALID", "Artifact 转存结果无效", { status: 500, expose: false });
      const now = nowIso(this.clock);
      const promotion = { projectId, resourceVersionId: String(promoted.resourceVersionId), bindingId: String(promoted.bindingId), promotedAt: now };
      const next = updatedRecord(record, {
        projectId,
        promotion,
        lifecycle: "pinned",
        pinnedAt: now,
        deletedAt: null,
        expiresAt: null,
      }, this.clock);
      await this.storage.writeRecord(next);
      return {
        summaries: summaries.map((entry) => entry.id === next.id ? publicArtifactSummary(next) : entry),
        result: { artifact: clone(redactSensitive(publicArtifactDetail(next))), promotion: clone(promotion) },
      };
    });
  }

  async detachProject(input) {
    assertAllowedKeys(input, ["projectId", "commandId"], "detachProject");
    const projectId = String(input.projectId || "");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(projectId), "ARTIFACT_PROJECT_ID_INVALID", "projectId 无效", { status: 400 });
    return this.#runCommand(input.commandId, "detach-project", { projectId }, async ({ summaries }) => {
      const candidateIds = summaries.filter((entry) => entry.projectId === projectId).map((entry) => entry.id);
      const replacements = new Map();
      const detachedArtifactIds = [];
      for (const artifactId of candidateIds) {
        const record = await this.#readRecord(artifactId);
        if (record.projectId !== projectId) {
          replacements.set(record.id, publicArtifactSummary(record));
          continue;
        }
        const now = nowIso(this.clock);
        const next = updatedRecord(record, {
          projectId: null,
          promotion: null,
          lifecycle: "active",
          pinnedAt: null,
          expiresAt: new Date(Date.parse(now) + this.defaultRetentionMs).toISOString(),
        }, this.clock);
        await this.storage.writeRecord(next);
        replacements.set(next.id, publicArtifactSummary(next));
        detachedArtifactIds.push(next.id);
      }
      return {
        summaries: summaries.map((entry) => replacements.get(entry.id) || entry),
        result: { projectId, detachedArtifactIds },
      };
    });
  }

  async issueDownload(input) {
    assertAllowedKeys(input, ["artifactId", "ttlMs"], "issueDownload");
    const record = await this.#readRecord(input.artifactId);
    invariant(!["deleted", "expired"].includes(record.lifecycle), "ARTIFACT_NOT_AVAILABLE", "Artifact 已删除或过期", { status: 410 });
    const ttlMs = Number(input.ttlMs ?? 5 * 60 * 1000);
    invariant(Number.isSafeInteger(ttlMs) && ttlMs >= 1000 && ttlMs <= MAX_DOWNLOAD_TTL_MS, "ARTIFACT_DOWNLOAD_TTL_INVALID", "Artifact 下载 token 有效期无效", { status: 400 });
    const now = Date.parse(nowIso(this.clock));
    const downloadToken = this.downloadCodec.encode({
      actorId: this.actor.actorId,
      artifactId: record.id,
      artifactRevision: record.revision,
      versionId: record.activeVersionId,
    }, { now, ttlMs });
    return {
      downloadToken,
      expiresAt: new Date(now + ttlMs).toISOString(),
      artifact: clone(redactSensitive(publicArtifactSummary(record))),
    };
  }

  async #openRecord(record, range) {
    const { version, locator } = versionFor(record, record.activeVersionId);
    const normalizedRange = normalizeRange(range, version.size);
    let stream;
    if (version.source === "host") {
      if (normalizedRange.endExclusive === normalizedRange.start) stream = Readable.from([]);
      else {
        stream = fs.createReadStream(this.storage.blobPathFromRelative(locator.actorRelativePath), {
          start: normalizedRange.start,
          end: normalizedRange.endExclusive - 1,
        });
      }
    } else {
      invariant(typeof this.remoteSource?.openReadStream === "function", "ARTIFACT_REMOTE_STREAM_UNAVAILABLE", "远端 Artifact 下载服务不可用", { status: 503 });
      try {
        stream = await this.remoteSource.openReadStream({
          actor: this.actor,
          taskId: record.taskId,
          workspaceId: record.workspaceId,
          serverIdentity: locator.serverIdentity,
          canonicalPath: locator.remotePath,
          range: normalizedRange,
        });
      } catch (error) {
        throw new ApiError("ARTIFACT_REMOTE_STREAM_FAILED", "无法读取远端 Artifact", { status: 502, cause: error });
      }
    }
    invariant(stream && typeof stream.pipe === "function", "ARTIFACT_STREAM_INVALID", "Artifact 下载流无效", { status: 500, expose: false });
    return {
      stream: sanitizeStreamErrors(stream),
      range: normalizedRange,
      size: version.size,
      contentLength: normalizedRange.endExclusive - normalizedRange.start,
      mime: version.mime,
      sha256: version.sha256,
      filename: safeName(record.name),
    };
  }

  async openDownload(input) {
    assertAllowedKeys(input, ["downloadToken", "range"], "openDownload");
    const decoded = this.downloadCodec.decode(input.downloadToken, { now: Date.parse(nowIso(this.clock)) });
    invariant(decoded.actorId === this.actor.actorId, "ARTIFACT_DOWNLOAD_FORBIDDEN", "Artifact 下载 token 不属于当前 Actor", { status: 403 });
    const record = await this.#readRecord(decoded.artifactId);
    invariant(!["deleted", "expired"].includes(record.lifecycle), "ARTIFACT_NOT_AVAILABLE", "Artifact 已删除或过期", { status: 410 });
    invariant(record.revision === decoded.artifactRevision && record.activeVersionId === decoded.versionId, "ARTIFACT_DOWNLOAD_STALE", "Artifact 已变化，请重新获取下载 token", { status: 409 });
    return this.#openRecord(record, input.range);
  }

  async expireDue(input) {
    assertAllowedKeys(input, ["commandId", "at", "limit"], "expireDue");
    const at = input.at === undefined ? nowIso(this.clock) : String(input.at);
    invariant(Number.isFinite(Date.parse(at)) && new Date(Date.parse(at)).toISOString() === at, "ARTIFACT_EXPIRY_INVALID", "expireDue.at 无效", { status: 400 });
    const limit = Number(input.limit ?? 100);
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, "ARTIFACT_GC_LIMIT_INVALID", "expireDue.limit 无效", { status: 400 });
    return this.#runCommand(input.commandId, "expire", { at, limit }, async ({ summaries }) => {
      const candidates = summaries.filter((summary) => summary.lifecycle === "active" && summary.expiresAt !== null && summary.expiresAt <= at).slice(0, limit);
      const updated = new Map();
      for (const summary of candidates) {
        const record = await this.#readRecord(summary.id);
        if (record.lifecycle !== "active" || record.expiresAt === null || record.expiresAt > at) continue;
        const next = updatedRecord(record, { lifecycle: "expired", pinnedAt: null, deletedAt: null }, this.clock);
        await this.storage.writeRecord(next);
        updated.set(next.id, publicArtifactSummary(next));
      }
      return {
        summaries: summaries.map((summary) => updated.get(summary.id) || summary),
        result: { expiredArtifactIds: [...updated.keys()] },
      };
    });
  }

  async garbageCollect(input) {
    assertAllowedKeys(input, ["commandId", "before", "limit"], "garbageCollect");
    const before = input.before === undefined ? nowIso(this.clock) : String(input.before);
    invariant(Number.isFinite(Date.parse(before)) && new Date(Date.parse(before)).toISOString() === before, "ARTIFACT_GC_TIME_INVALID", "garbageCollect.before 无效", { status: 400 });
    const limit = Number(input.limit ?? 100);
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, "ARTIFACT_GC_LIMIT_INVALID", "garbageCollect.limit 无效", { status: 400 });
    return this.#runCommand(input.commandId, "garbage-collect", { before, limit }, async ({ summaries }) => {
      const candidates = summaries.filter((summary) => ["deleted", "expired"].includes(summary.lifecycle) && summary.updatedAt <= before).slice(0, limit);
      const candidateIds = new Set(candidates.map((summary) => summary.id));
      const candidateRecords = (await Promise.all(candidates.map((summary) => this.storage.readRecord(summary.id)))).filter(Boolean);
      const remainingSummaries = summaries.filter((summary) => !candidateIds.has(summary.id));
      const remainingRecords = (await Promise.all(remainingSummaries.map((summary) => this.storage.readRecord(summary.id)))).filter(Boolean);
      const retainedHostPaths = new Set(remainingRecords.flatMap((record) => record.locators.filter((locator) => locator.source === "host").map((locator) => locator.actorRelativePath)));
      const removableHostPaths = new Set(candidateRecords.flatMap((record) => record.locators.filter((locator) => locator.source === "host" && !retainedHostPaths.has(locator.actorRelativePath)).map((locator) => locator.actorRelativePath)));
      for (const record of candidateRecords) await this.storage.deleteRecord(record.id);
      for (const relativePath of removableHostPaths) await this.storage.deleteBlobByRelativePath(relativePath);
      return {
        summaries: remainingSummaries,
        result: { removedArtifactIds: candidateRecords.map((record) => record.id), removedHostBlobCount: removableHostPaths.size },
      };
    });
  }
}
