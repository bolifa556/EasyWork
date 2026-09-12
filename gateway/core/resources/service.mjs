import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ApiError, invariant } from "../errors.mjs";
import {
  createResourceBinding,
  createResourceBlob,
  createResourceVersion,
  isResourceKnowledgeReady,
  updateResourceVersionProcessing,
  validateResourceBinding,
  validateResourceBlob,
  validateResourceVersion,
} from "../entities/resource.mjs";
import { assertExpectedRevision } from "../revision.mjs";
import { assertActorOwnedPath, resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { ActorMutationQueue } from "../mutation-queue.mjs";
import { containsExplicitQueryAnchor, requiredExplicitQueryAnchors } from "../text-relevance.mjs";
import { documentMetadata } from "./extractor.mjs";

const RESOURCE_STORE_SCHEMA_VERSION = 1;
const PROCESSING_FILE_SCHEMA_VERSION = 1;
const SUPPORTED_OWNER_TYPES = Object.freeze(["collection", "project", "conversation"]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIRECT_READ_CHARACTERS = 20_000;
const MODEL_IMAGE_BYTES = 8 * 1024 * 1024;
const MODEL_IMAGE_MIME = /^image\/(?:png|jpe?g|webp|gif)$/i;
const RESOURCE_SUMMARY_VERSION = "llm-v1";
const sharedResourceMutationQueue = new ActorMutationQueue();
const inlineRepositoryQueue = Object.freeze({
  run: async (_actor, operation) => operation(),
});

function clone(value) {
  return structuredClone(value);
}

function defaultStore() {
  return { blobs: [], versions: [], bindings: [] };
}

function assertId(value, field) {
  invariant(typeof value === "string" && SAFE_ID_PATTERN.test(value), "RESOURCE_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return value;
}

function assertOwnerType(value) {
  invariant(SUPPORTED_OWNER_TYPES.includes(value), "RESOURCE_OWNER_TYPE_INVALID", "资源只能绑定到文件集、项目或对话", {
    status: 400,
    details: { allowed: SUPPORTED_OWNER_TYPES },
  });
  return value;
}

function assertFilename(value) {
  invariant(typeof value === "string", "RESOURCE_FILENAME_REQUIRED", "文件名不能为空", { status: 400 });
  const filename = value.trim();
  invariant(filename.length > 0 && filename.length <= 4096, "RESOURCE_FILENAME_INVALID", "文件名长度无效", { status: 400 });
  invariant(
    filename === value && filename !== "." && filename !== ".." && !filename.includes("/") && !filename.includes("\\") && !filename.includes("\0"),
    "RESOURCE_FILENAME_INVALID",
    "文件名不能包含路径或首尾空白",
    { status: 400 },
  );
  return filename;
}

function assertBindingPath(value) {
  if (value === null || value === undefined) return null;
  invariant(typeof value === "string" && value.length > 0 && value.length <= 32768, "RESOURCE_BINDING_PATH_INVALID", "资源相对路径无效", { status: 400 });
  invariant(!value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value), "RESOURCE_BINDING_PATH_INVALID", "资源路径必须是相对路径", { status: 400 });
  invariant(value.split("/").every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\0")), "RESOURCE_BINDING_PATH_INVALID", "资源路径包含非法片段", { status: 400 });
  return value;
}

function assertStore(store, actorId) {
  invariant(store && typeof store === "object" && !Array.isArray(store), "RESOURCE_STORE_INVALID", "资源索引结构无效", { status: 500, expose: false });
  invariant(Array.isArray(store.blobs) && Array.isArray(store.versions) && Array.isArray(store.bindings), "RESOURCE_STORE_INVALID", "资源索引结构无效", {
    status: 500,
    expose: false,
  });
  invariant(Object.keys(store).every((key) => ["blobs", "versions", "bindings"].includes(key)), "RESOURCE_STORE_INVALID", "资源索引包含未知字段", {
    status: 500,
    expose: false,
  });

  const ids = new Set();
  for (const blob of store.blobs) {
    validateResourceBlob(blob);
    invariant(blob.actorId === actorId, "RESOURCE_ACTOR_MISMATCH", "资源 Blob 不属于当前 Actor", { status: 403 });
    invariant(!ids.has(blob.id), "RESOURCE_DUPLICATE_ID", "资源索引包含重复实体", { status: 500, expose: false });
    ids.add(blob.id);
  }
  const blobIds = new Set(store.blobs.map((entry) => entry.id));
  for (const version of store.versions) {
    validateResourceVersion(version);
    invariant(version.actorId === actorId, "RESOURCE_ACTOR_MISMATCH", "资源版本不属于当前 Actor", { status: 403 });
    invariant(blobIds.has(version.blobId), "RESOURCE_BLOB_MISSING", "资源版本引用了不存在的 Blob", { status: 500, expose: false });
    invariant(!ids.has(version.id), "RESOURCE_DUPLICATE_ID", "资源索引包含重复实体", { status: 500, expose: false });
    ids.add(version.id);
  }
  const versionIds = new Set(store.versions.map((entry) => entry.id));
  for (const binding of store.bindings) {
    validateResourceBinding(binding);
    assertOwnerType(binding.ownerType);
    invariant(binding.actorId === actorId, "RESOURCE_ACTOR_MISMATCH", "资源绑定不属于当前 Actor", { status: 403 });
    invariant(versionIds.has(binding.resourceVersionId), "RESOURCE_VERSION_MISSING", "资源绑定引用了不存在的版本", { status: 500, expose: false });
    invariant(!ids.has(binding.id), "RESOURCE_DUPLICATE_ID", "资源索引包含重复实体", { status: 500, expose: false });
    ids.add(binding.id);
  }
  return true;
}

function jsonValue(value, code, message) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw Object.assign(new Error(message), { cause: error, code });
  }
  invariant(encoded !== undefined, code, message, { status: 500, expose: false });
  return JSON.parse(encoded);
}

async function writeFileAtomically(filePath, content) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

function deterministicStreamImportId(kind, commandId) {
  return `${kind}_${crypto.createHash("sha256").update(`stream-import:${commandId}:${kind}`).digest("hex").slice(0, 32)}`;
}

function processingPath(kind, versionId) {
  return `resources/${kind}/${versionId}.json`;
}

function processingEnvelope(resourceVersionId, content, clock) {
  return {
    schemaVersion: PROCESSING_FILE_SCHEMA_VERSION,
    resourceVersionId,
    createdAt: clock().toISOString(),
    content: jsonValue(content, "RESOURCE_PROCESSING_OUTPUT_INVALID", "解析或向量输出必须是可序列化 JSON"),
  };
}

async function readJson(filePath, missingCode) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") invariant(false, missingCode, "资源处理结果不存在", { status: 409 });
    throw error;
  }
}

function publicFailureMessage(error) {
  const message = typeof error?.message === "string" ? error.message.trim() : "处理失败";
  return message.slice(0, 16384) || "处理失败";
}

function generatedSummary(value) {
  const text = String(value || "")
    .replace(/^```[^\n]*\n?/u, "")
    .replace(/\n?```$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  invariant(text.length > 0, "RESOURCE_SUMMARY_EMPTY", "文件简介模型没有返回有效内容", { status: 502, retryable: true });
  return text.slice(0, 600);
}

function normalizeScope(scope) {
  invariant(scope && typeof scope === "object" && !Array.isArray(scope), "RESOURCE_SCOPE_REQUIRED", "检索需要资源 Scope", { status: 400 });
  const collectionIds = [...new Set((scope.collectionIds || scope.selectedCollectionIds || []).map((entry) => assertId(String(entry), "collectionId")))];
  const projectId = scope.projectId === null || scope.projectId === undefined ? null : assertId(String(scope.projectId), "projectId");
  const conversationId = scope.conversationId === null || scope.conversationId === undefined ? null : assertId(String(scope.conversationId), "conversationId");
  invariant(collectionIds.length > 0 || projectId || conversationId, "RESOURCE_SCOPE_EMPTY", "检索 Scope 至少包含一个文件集、项目或对话", { status: 400 });
  return { collectionIds, projectId, conversationId };
}

function bindingMatchesScope(binding, scope, asOfSequence) {
  if (binding.createdSequence > asOfSequence) return false;
  if (binding.invalidatedSequence !== null && binding.invalidatedSequence <= asOfSequence) return false;
  if (binding.ownerType === "collection") return scope.collectionIds.includes(binding.ownerId);
  if (binding.ownerType === "project") return scope.projectId === binding.ownerId;
  if (binding.ownerType === "conversation") return scope.conversationId === binding.ownerId;
  return false;
}

export class ResourceService {
  #repository;

  constructor(options) {
    invariant(options?.actor?.actorId, "ACTOR_CONTEXT_REQUIRED", "ResourceService 需要 ActorContext", { status: 500, expose: false });
    invariant(typeof options?.dataRoot === "string" && path.isAbsolute(options.dataRoot), "DATA_ROOT_INVALID", "ResourceService 需要绝对 dataRoot", {
      status: 500,
      expose: false,
    });
    invariant(typeof options?.authorizeOwner === "function", "RESOURCE_AUTHORIZER_REQUIRED", "ResourceService 需要 owner 授权器", { status: 500, expose: false });
    invariant(typeof options?.extractor?.extract === "function", "RESOURCE_EXTRACTOR_REQUIRED", "ResourceService 需要文件提取器", { status: 500, expose: false });
    invariant(typeof options?.embedder?.embed === "function" && typeof options?.embedder?.search === "function", "RESOURCE_EMBEDDER_REQUIRED", "ResourceService 需要 Embedding 适配器", {
      status: 500,
      expose: false,
    });
    this.actor = options.actor;
    this.dataRoot = options.dataRoot;
    this.authorizeOwner = options.authorizeOwner;
    this.extractor = options.extractor;
    this.embedder = options.embedder;
    this.summaryGenerator = typeof options.summaryGenerator === "function" ? options.summaryGenerator : null;
    this.parserVersion = assertId(String(options.parserVersion || "parser-v1"), "parserVersion");
    this.embeddingProfileId = assertId(String(options.embeddingProfileId || "embedding-default"), "embeddingProfileId");
    this.maxFileBytes = Number(options.maxFileBytes ?? 100 * 1024 * 1024);
    invariant(Number.isSafeInteger(this.maxFileBytes) && this.maxFileBytes > 0, "RESOURCE_SIZE_LIMIT_INVALID", "maxFileBytes 无效", { status: 500, expose: false });
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || ((kind) => `${kind}_${crypto.randomUUID()}`);
    this.mutationQueue = options.mutationQueue || sharedResourceMutationQueue;
    invariant(typeof this.mutationQueue?.run === "function", "RESOURCE_MUTATION_QUEUE_INVALID", "资源写队列无效", { status: 500, expose: false });
    this.#repository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: "resources/index.json",
      schemaVersion: RESOURCE_STORE_SCHEMA_VERSION,
      defaultData: defaultStore,
      validate: (store) => assertStore(store, this.actor.actorId),
      queue: inlineRepositoryQueue,
    });
  }

  async #serialize(operation) {
    return this.mutationQueue.run(this.actor, operation);
  }

  async #authorize(ownerType, ownerId, action) {
    assertOwnerType(ownerType);
    assertId(ownerId, "ownerId");
    const allowed = await this.authorizeOwner({ actor: this.actor, ownerType, ownerId, action });
    invariant(allowed !== false, "RESOURCE_OWNER_FORBIDDEN", "当前 Actor 无权访问该资源范围", {
      status: 403,
      details: { ownerType, ownerId, action },
    });
  }

  #newId(kind) {
    return assertId(String(this.idFactory(kind)), `${kind}Id`);
  }

  #actorFile(relativePath) {
    const filePath = resolveActorPath(this.dataRoot, this.actor, relativePath);
    return assertActorOwnedPath(this.dataRoot, this.actor, filePath);
  }

  async inspect() {
    return this.#repository.read();
  }

  async ingest(input) {
    return this.#serialize(async () => {
      const content = Buffer.isBuffer(input?.content) ? Buffer.from(input.content) : Buffer.from(input?.content || "");
      invariant(content.length <= this.maxFileBytes, "RESOURCE_FILE_TOO_LARGE", "文件超过允许大小", {
        status: 413,
        details: { maxFileBytes: this.maxFileBytes },
      });
      const filename = assertFilename(input?.filename);
      const mime = String(input?.mime || "application/octet-stream").trim();
      invariant(mime.length > 0 && mime.length <= 512, "RESOURCE_MIME_INVALID", "文件 MIME 无效", { status: 400 });
      const bindingInput = input?.binding || {};
      const ownerType = assertOwnerType(String(bindingInput.ownerType || ""));
      const ownerId = assertId(String(bindingInput.ownerId || ""), "ownerId");
      const bindingPath = assertBindingPath(bindingInput.path);
      await this.#authorize(ownerType, ownerId, "write");
      await this.extractor.preflight?.({ actor: this.actor, filename, mime });
      const createdSequence = Number(input?.createdSequence ?? 0);
      invariant(Number.isSafeInteger(createdSequence) && createdSequence >= 0, "RESOURCE_SEQUENCE_INVALID", "createdSequence 无效", { status: 400 });

      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      const blobStoragePath = `resources/blobs/${sha256.slice(0, 2)}/${sha256}`;
      const blobFilePath = this.#actorFile(blobStoragePath);
      await fs.mkdir(path.dirname(blobFilePath), { recursive: true });
      let blobFileExists = false;
      try {
        const existing = await fs.readFile(blobFilePath);
        blobFileExists = true;
        invariant(existing.length === content.length && crypto.createHash("sha256").update(existing).digest("hex") === sha256, "RESOURCE_BLOB_CORRUPT", "内容寻址 Blob 校验失败", {
          status: 500,
          expose: false,
        });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!blobFileExists) await writeFileAtomically(blobFilePath, content);

      let version;
      let binding;
      let persisted;
      try {
        persisted = await this.#repository.update((store) => {
          let blob = store.blobs.find((entry) => entry.sha256 === sha256);
          if (!blob) {
            blob = createResourceBlob({
              id: this.#newId("blob"),
              actorId: this.actor.actorId,
              sha256,
              size: content.length,
              mime,
              storagePath: blobStoragePath,
            }, { clock: this.clock });
            store.blobs.push(blob);
          }
          version = createResourceVersion({
            id: this.#newId("resource_version"),
            actorId: this.actor.actorId,
            resourceId: input?.resourceId ? assertId(String(input.resourceId), "resourceId") : this.#newId("resource"),
            blobId: blob.id,
            filename,
            parserVersion: this.parserVersion,
          }, { clock: this.clock });
          binding = createResourceBinding({
            id: this.#newId("resource_binding"),
            actorId: this.actor.actorId,
            resourceVersionId: version.id,
            ownerType,
            ownerId,
            path: bindingPath,
            createdSequence,
          }, { clock: this.clock });
          store.versions.push(version);
          store.bindings.push(binding);
        }, { expectedRevision: input?.expectedRevision, clock: this.clock });
      } catch (error) {
        if (!blobFileExists) {
          const current = await this.#repository.read().catch(() => null);
          if (!current?.data?.blobs?.some((entry) => entry.sha256 === sha256)) {
            await fs.rm(blobFilePath, { force: true }).catch(() => undefined);
          }
        }
        throw error;
      }

      const processed = await this.#processVersion(version.id, input?.summary || null);
      return {
        revision: processed.revision,
        blob: clone(processed.data.blobs.find((entry) => entry.id === version.blobId)),
        version: clone(processed.data.versions.find((entry) => entry.id === version.id)),
        binding: clone(binding),
        pendingRevision: persisted.revision,
      };
    });
  }

  /** Imports a request stream without buffering its payload in the JS heap. */
  async ingestStream(input) {
    return this.#serialize(async () => {
      invariant(typeof input?.openSource === "function", "RESOURCE_STREAM_SOURCE_REQUIRED", "流式资源缺少 source callback", { status: 400 });
      const commandId = assertId(String(input?.commandId || ""), "commandId");
      const filename = assertFilename(input?.filename);
      const mime = String(input?.mime || "application/octet-stream").trim();
      invariant(mime.length > 0 && mime.length <= 512, "RESOURCE_MIME_INVALID", "文件 MIME 无效", { status: 400 });
      const bindingInput = input?.binding || {};
      const ownerType = assertOwnerType(String(bindingInput.ownerType || ""));
      const ownerId = assertId(String(bindingInput.ownerId || ""), "ownerId");
      const bindingPath = assertBindingPath(bindingInput.path);
      await this.#authorize(ownerType, ownerId, "write");
      await this.extractor.preflight?.({ actor: this.actor, filename, mime });
      const createdSequence = Number(input?.createdSequence ?? 0);
      invariant(Number.isSafeInteger(createdSequence) && createdSequence >= 0, "RESOURCE_SEQUENCE_INVALID", "createdSequence 无效", { status: 400 });

      const expectedSize = Number(input.expectedSize);
      const expectedSha256 = String(input.expectedSha256 || "").toLowerCase();
      invariant(Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize <= this.maxFileBytes, "RESOURCE_FILE_TOO_LARGE", "文件超过允许大小", { status: 413, details: { maxFileBytes: this.maxFileBytes } });
      invariant(/^[a-f0-9]{64}$/.test(expectedSha256), "RESOURCE_STREAM_HASH_REQUIRED", "流式资源必须提供内容 hash", { status: 400 });

      const resourceId = deterministicStreamImportId("resource", commandId);
      const versionId = deterministicStreamImportId("resource_version", commandId);
      const bindingId = deterministicStreamImportId("resource_binding", commandId);
      let snapshot = await this.#repository.read();
      const existingBinding = snapshot.data.bindings.find((entry) => entry.id === bindingId);
      if (existingBinding) {
        const existingVersion = snapshot.data.versions.find((entry) => entry.id === versionId);
        const existingBlob = snapshot.data.blobs.find((entry) => entry.id === existingVersion?.blobId);
        invariant(existingBinding.resourceVersionId === versionId
          && existingBinding.ownerType === ownerType
          && existingBinding.ownerId === ownerId
          && existingBinding.path === bindingPath
          && existingBinding.createdSequence === createdSequence
          && existingVersion?.resourceId === resourceId
          && existingVersion.filename === filename
          && existingBlob?.sha256 === expectedSha256
          && existingBlob.size === expectedSize, "RESOURCE_COMMAND_REUSED", "commandId 已用于不同的流式资源导入", { status: 409 });
        if (!isResourceKnowledgeReady(existingVersion)) {
          snapshot = await this.#processVersion(versionId, input?.summary || null);
        }
        return {
          revision: snapshot.revision,
          blob: clone(snapshot.data.blobs.find((entry) => entry.id === existingBlob.id)),
          version: clone(snapshot.data.versions.find((entry) => entry.id === versionId)),
          binding: clone(existingBinding),
          replayed: true,
        };
      }
      if (input?.expectedRevision !== undefined) assertExpectedRevision(snapshot.revision, input.expectedRevision);

      const actorRoot = this.#actorFile("resources/imports");
      await fs.mkdir(actorRoot, { recursive: true });
      const temporaryPath = path.join(actorRoot, `.${versionId}.${crypto.randomUUID()}.tmp`);
      const opened = await input.openSource();
      const source = opened?.stream || opened;
      invariant(source && typeof source.pipe === "function", "RESOURCE_STREAM_INVALID", "流式资源 source 无效", { status: 502 });
      const digest = crypto.createHash("sha256");
      let size = 0;
      const maxFileBytes = this.maxFileBytes;
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > expectedSize || size > maxFileBytes) {
            callback(new ApiError("RESOURCE_STREAM_SIZE_MISMATCH", "流式资源大小与声明不一致", { status: 502 }));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(source, meter, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
        const sha256 = digest.digest("hex");
        invariant(size === expectedSize && sha256 === expectedSha256, "RESOURCE_STREAM_HASH_MISMATCH", "流式资源内容校验失败", { status: 502 });
        const blobStoragePath = `resources/blobs/${sha256.slice(0, 2)}/${sha256}`;
        const blobFilePath = this.#actorFile(blobStoragePath);
        await fs.mkdir(path.dirname(blobFilePath), { recursive: true });
        try {
          const existing = await hashFile(blobFilePath);
          invariant(existing.size === size && existing.sha256 === sha256, "RESOURCE_BLOB_CORRUPT", "内容寻址 Blob 校验失败", { status: 500, expose: false });
          await fs.rm(temporaryPath, { force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await fs.rename(temporaryPath, blobFilePath);
        }

        let blob;
        let version;
        let binding;
        snapshot = await this.#repository.read();
        const persisted = await this.#repository.update((store) => {
          blob = store.blobs.find((entry) => entry.sha256 === sha256);
          if (!blob) {
            blob = createResourceBlob({ id: this.#newId("blob"), actorId: this.actor.actorId, sha256, size, mime, storagePath: blobStoragePath }, { clock: this.clock });
            store.blobs.push(blob);
          }
          invariant(!store.versions.some((entry) => entry.id === versionId) && !store.bindings.some((entry) => entry.id === bindingId), "RESOURCE_STREAM_IMPORT_ID_COLLISION", "流式资源导入标识冲突", { status: 409 });
          version = createResourceVersion({ id: versionId, actorId: this.actor.actorId, resourceId, blobId: blob.id, filename, parserVersion: this.parserVersion }, { clock: this.clock });
          binding = createResourceBinding({ id: bindingId, actorId: this.actor.actorId, resourceVersionId: versionId, ownerType, ownerId, path: bindingPath, createdSequence }, { clock: this.clock });
          store.versions.push(version);
          store.bindings.push(binding);
        }, { expectedRevision: snapshot.revision, clock: this.clock });
        const processed = await this.#processVersion(versionId, input?.summary || null);
        return {
          revision: processed.revision,
          pendingRevision: persisted.revision,
          blob: clone(processed.data.blobs.find((entry) => entry.id === blob.id)),
          version: clone(processed.data.versions.find((entry) => entry.id === versionId)),
          binding: clone(binding),
          replayed: false,
        };
      } finally {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async #setVersionProcessing(versionId, changes) {
    return this.#repository.update((store) => {
      const index = store.versions.findIndex((entry) => entry.id === versionId);
      invariant(index >= 0, "RESOURCE_VERSION_NOT_FOUND", "资源版本不存在", { status: 404 });
      store.versions[index] = updateResourceVersionProcessing(store.versions[index], changes, {
        expectedRevision: store.versions[index].revision,
        clock: this.clock,
      });
    }, { expectedRevision: (await this.#repository.read()).revision, clock: this.clock });
  }

  async #processVersion(versionId, summaryRequest = null) {
    let snapshot = await this.#repository.read();
    let version = snapshot.data.versions.find((entry) => entry.id === versionId);
    invariant(version, "RESOURCE_VERSION_NOT_FOUND", "资源版本不存在", { status: 404 });
    const blob = snapshot.data.blobs.find((entry) => entry.id === version.blobId);
    invariant(blob, "RESOURCE_BLOB_MISSING", "资源 Blob 不存在", { status: 500, expose: false });
    const raw = await fs.readFile(this.#actorFile(blob.storagePath));

    let parsed;
    try {
      parsed = await this.extractor.extract({
        actor: this.actor,
        content: Buffer.from(raw),
        filename: version.filename,
        mime: blob.mime,
        version: clone(version),
      });
      if (summaryRequest?.required) {
        invariant(this.summaryGenerator, "RESOURCE_SUMMARY_GENERATOR_REQUIRED", "文件上传需要可用的简介模型", { status: 503, retryable: true });
        const summary = generatedSummary(await this.summaryGenerator({
          actor: this.actor,
          filename: version.filename,
          mime: blob.mime,
          sha256: blob.sha256,
          parsed: clone(parsed),
          providerId: String(summaryRequest.providerId || ""),
          modelId: String(summaryRequest.modelId || ""),
        }));
        parsed.metadata = {
          ...(parsed.metadata || documentMetadata(parsed.text, version.filename)),
          summary,
          keywords: [],
          summaryVersion: RESOURCE_SUMMARY_VERSION,
        };
      }
      const envelope = processingEnvelope(version.id, parsed, this.clock);
      await writeFileAtomically(this.#actorFile(processingPath("parsed", version.id)), `${JSON.stringify(envelope, null, 2)}\n`);
      snapshot = await this.#setVersionProcessing(version.id, {
        parseStatus: "ready",
        embeddingStatus: "pending",
        parserVersion: this.parserVersion,
        embeddingProfileId: null,
        parseError: null,
        embeddingError: null,
      });
      version = snapshot.data.versions.find((entry) => entry.id === versionId);
    } catch (error) {
      const failed = await this.#setVersionProcessing(version.id, {
        parseStatus: "failed",
        embeddingStatus: "pending",
        parserVersion: this.parserVersion,
        embeddingProfileId: null,
        parseError: publicFailureMessage(error),
        embeddingError: null,
      });
      if (error?.code === "RESOURCE_OCR_NOT_CONFIGURED" || summaryRequest?.required) throw error;
      return failed;
    }

    try {
      const embedded = await this.embedder.embed({ actor: this.actor, parsed: clone(parsed), version: clone(version) });
      invariant(embedded && typeof embedded === "object" && !Array.isArray(embedded), "RESOURCE_EMBEDDING_OUTPUT_INVALID", "Embedding 输出无效", {
        status: 500,
        expose: false,
      });
      const profileId = assertId(String(embedded.profileId || this.embeddingProfileId), "embeddingProfileId");
      const envelope = processingEnvelope(version.id, embedded.reference, this.clock);
      await writeFileAtomically(this.#actorFile(processingPath("vectors", version.id)), `${JSON.stringify(envelope, null, 2)}\n`);
      return this.#setVersionProcessing(version.id, {
        parseStatus: "ready",
        embeddingStatus: "ready",
        parserVersion: this.parserVersion,
        embeddingProfileId: profileId,
        parseError: null,
        embeddingError: null,
      });
    } catch (error) {
      return this.#setVersionProcessing(version.id, {
        parseStatus: "ready",
        embeddingStatus: "failed",
        parserVersion: this.parserVersion,
        embeddingProfileId: this.embeddingProfileId,
        parseError: null,
        embeddingError: publicFailureMessage(error),
      });
    }
  }

  async retryIndexing(input) {
    return this.#serialize(async () => {
      const versionId = assertId(String(input?.versionId || ""), "versionId");
      const current = await this.#repository.read();
      assertExpectedRevision(current.revision, input?.expectedRevision);
      const version = current.data.versions.find((entry) => entry.id === versionId);
      invariant(version, "RESOURCE_VERSION_NOT_FOUND", "资源版本不存在", { status: 404 });
      invariant(!isResourceKnowledgeReady(version), "RESOURCE_ALREADY_READY", "资源已经完成索引", { status: 409 });
      const bindings = current.data.bindings.filter((entry) => entry.resourceVersionId === versionId);
      invariant(bindings.length > 0, "RESOURCE_BINDING_NOT_FOUND", "资源版本没有有效绑定", { status: 409 });
      for (const binding of bindings) await this.#authorize(binding.ownerType, binding.ownerId, "write");
      await fs.rm(this.#actorFile(processingPath("parsed", versionId)), { force: true });
      await fs.rm(this.#actorFile(processingPath("vectors", versionId)), { force: true });
      await this.#repository.update((store) => {
        const index = store.versions.findIndex((entry) => entry.id === versionId);
        store.versions[index] = updateResourceVersionProcessing(store.versions[index], {
          parseStatus: "pending",
          embeddingStatus: "pending",
          parserVersion: this.parserVersion,
          embeddingProfileId: null,
          parseError: null,
          embeddingError: null,
        }, { expectedRevision: store.versions[index].revision, clock: this.clock });
      }, { expectedRevision: current.revision, clock: this.clock });
      const processed = await this.#processVersion(versionId);
      return { revision: processed.revision, version: clone(processed.data.versions.find((entry) => entry.id === versionId)) };
    });
  }

  async bindVersion(input) {
    return this.#serialize(async () => {
      const versionId = assertId(String(input?.versionId || ""), "versionId");
      const ownerType = assertOwnerType(String(input?.ownerType || ""));
      const ownerId = assertId(String(input?.ownerId || ""), "ownerId");
      const bindingPath = assertBindingPath(input?.path);
      await this.#authorize(ownerType, ownerId, "write");
      const createdSequence = Number(input?.createdSequence ?? 0);
      invariant(Number.isSafeInteger(createdSequence) && createdSequence >= 0, "RESOURCE_SEQUENCE_INVALID", "createdSequence 无效", { status: 400 });
      let binding;
      const result = await this.#repository.update((store) => {
        invariant(store.versions.some((entry) => entry.id === versionId), "RESOURCE_VERSION_NOT_FOUND", "资源版本不存在", { status: 404 });
        invariant(!store.bindings.some((entry) => entry.resourceVersionId === versionId && entry.ownerType === ownerType && entry.ownerId === ownerId && entry.path === bindingPath), "RESOURCE_BINDING_EXISTS", "相同资源绑定已存在", { status: 409 });
        binding = createResourceBinding({
          id: this.#newId("resource_binding"),
          actorId: this.actor.actorId,
          resourceVersionId: versionId,
          ownerType,
          ownerId,
          path: bindingPath,
          createdSequence,
        }, { clock: this.clock });
        store.bindings.push(binding);
      }, { expectedRevision: input?.expectedRevision, clock: this.clock });
      return { revision: result.revision, binding: clone(binding) };
    });
  }

  async removeBinding(input) {
    return this.#serialize(async () => {
      const bindingId = assertId(String(input?.bindingId || ""), "bindingId");
      const current = await this.#repository.read();
      assertExpectedRevision(current.revision, input?.expectedRevision);
      const binding = current.data.bindings.find((entry) => entry.id === bindingId);
      invariant(binding, "RESOURCE_BINDING_NOT_FOUND", "资源绑定不存在", { status: 404 });
      await this.#authorize(binding.ownerType, binding.ownerId, "delete");
      const removedFiles = [];
      let removedVersionId = null;
      let removedBlobId = null;
      const result = await this.#repository.update((store) => {
        store.bindings = store.bindings.filter((entry) => entry.id !== bindingId);
        const hasVersionBinding = store.bindings.some((entry) => entry.resourceVersionId === binding.resourceVersionId);
        if (hasVersionBinding) return;
        const version = store.versions.find((entry) => entry.id === binding.resourceVersionId);
        if (!version) return;
        removedVersionId = version.id;
        removedFiles.push(processingPath("parsed", version.id), processingPath("vectors", version.id));
        store.versions = store.versions.filter((entry) => entry.id !== version.id);
        const hasBlobVersion = store.versions.some((entry) => entry.blobId === version.blobId);
        if (hasBlobVersion) return;
        const blob = store.blobs.find((entry) => entry.id === version.blobId);
        if (!blob) return;
        removedBlobId = blob.id;
        removedFiles.push(blob.storagePath);
        store.blobs = store.blobs.filter((entry) => entry.id !== blob.id);
      }, { expectedRevision: current.revision, clock: this.clock });
      for (const relativePath of removedFiles) await fs.rm(this.#actorFile(relativePath), { force: true });
      return {
        revision: result.revision,
        removedBindingId: bindingId,
        garbageCollected: { versionId: removedVersionId, blobId: removedBlobId },
      };
    });
  }

  async removeOwnerBindings(input) {
    return this.#serialize(async () => {
      const ownerType = assertOwnerType(String(input?.ownerType || ""));
      const ownerId = assertId(String(input?.ownerId || ""), "ownerId");
      await this.#authorize(ownerType, ownerId, "delete");
      const current = await this.#repository.read();
      const targets = current.data.bindings.filter((entry) => entry.ownerType === ownerType && entry.ownerId === ownerId);
      if (!targets.length) {
        return { revision: current.revision, removedBindingIds: [], removedVersionIds: [], removedBlobIds: [], garbageCollectionFailures: 0 };
      }
      const targetIds = new Set(targets.map((entry) => entry.id));
      const removedFiles = [];
      const removedVersionIds = [];
      const removedBlobIds = [];
      const result = await this.#repository.update((store) => {
        store.bindings = store.bindings.filter((entry) => !targetIds.has(entry.id));
        const retainedVersionIds = new Set(store.bindings.map((entry) => entry.resourceVersionId));
        const orphanVersions = store.versions.filter((entry) => !retainedVersionIds.has(entry.id));
        for (const version of orphanVersions) {
          removedVersionIds.push(version.id);
          removedFiles.push(processingPath("parsed", version.id), processingPath("vectors", version.id));
        }
        store.versions = store.versions.filter((entry) => retainedVersionIds.has(entry.id));
        const retainedBlobIds = new Set(store.versions.map((entry) => entry.blobId));
        const orphanBlobs = store.blobs.filter((entry) => !retainedBlobIds.has(entry.id));
        for (const blob of orphanBlobs) {
          removedBlobIds.push(blob.id);
          removedFiles.push(blob.storagePath);
        }
        store.blobs = store.blobs.filter((entry) => retainedBlobIds.has(entry.id));
      }, { expectedRevision: current.revision, clock: this.clock });
      const cleanup = await Promise.allSettled(removedFiles.map((relativePath) => fs.rm(this.#actorFile(relativePath), { force: true })));
      return {
        revision: result.revision,
        removedBindingIds: [...targetIds],
        removedVersionIds,
        removedBlobIds,
        garbageCollectionFailures: cleanup.filter((entry) => entry.status === "rejected").length,
      };
    });
  }

  async catalog(input = {}) {
    const scope = normalizeScope(input.scope);
    for (const collectionId of scope.collectionIds) await this.#authorize("collection", collectionId, "read");
    if (scope.projectId) await this.#authorize("project", scope.projectId, "read");
    if (scope.conversationId) await this.#authorize("conversation", scope.conversationId, "read");
    const all = input.all === true;
    const limit = all ? Number.MAX_SAFE_INTEGER : Number(input.limit ?? 80);
    invariant(all || (Number.isSafeInteger(limit) && limit >= 1 && limit <= 200), "RESOURCE_CATALOG_LIMIT_INVALID", "文件概览数量无效", { status: 400 });
    const snapshot = await this.#repository.read();
    const groupedBindings = new Map();
    for (const binding of snapshot.data.bindings.filter((entry) => bindingMatchesScope(entry, scope, Number.MAX_SAFE_INTEGER))) {
      const values = groupedBindings.get(binding.resourceVersionId) || [];
      values.push(binding);
      groupedBindings.set(binding.resourceVersionId, values);
    }
    const visibleVersions = snapshot.data.versions
      .filter((version) => groupedBindings.has(version.id) && version.parseStatus === "ready")
      .slice(0, limit);
    const items = await Promise.all(visibleVersions.map(async (version) => {
      const parsedPath = this.#actorFile(processingPath("parsed", version.id));
      const parsedEnvelope = await readJson(parsedPath, "RESOURCE_PARSED_OUTPUT_MISSING");
      invariant(parsedEnvelope.resourceVersionId === version.id, "RESOURCE_PROCESSING_OUTPUT_MISMATCH", "资源处理结果与版本不匹配", { status: 500, expose: false });
      if (input.summary?.required && parsedEnvelope.content?.metadata?.summaryVersion !== RESOURCE_SUMMARY_VERSION) {
        invariant(false, "RESOURCE_SUMMARY_REQUIRED", "文件缺少当前格式的模型简介，请重新上传", { status: 409 });
      }
      const metadata = parsedEnvelope.content?.metadata || documentMetadata(parsedEnvelope.content?.text, version.filename);
      return {
        // These immutable identities are consumed only by the Work-context
        // receipt filter. The model-facing catalog renderer removes them.
        resourceId: version.resourceId,
        resourceVersionId: version.id,
        filename: version.filename,
        title: String(metadata.title || "").slice(0, 160),
        summary: String(metadata.summary || "").slice(0, 360),
        keywords: (Array.isArray(metadata.keywords) ? metadata.keywords : []).map(String).slice(0, 10),
        bindings: clone(groupedBindings.get(version.id)).map((binding) => ({ ownerType: binding.ownerType, ownerId: binding.ownerId, path: binding.path })),
      };
    }));
    return { revision: snapshot.revision, items };
  }

  async materializationDescriptors(input = {}) {
    const conversationId = assertId(String(input.conversationId || ""), "conversationId");
    const versionIds = [...new Set((Array.isArray(input.versionIds) ? input.versionIds : []).map((entry) => assertId(String(entry), "resourceVersionId")))];
    invariant(versionIds.length <= 256, "RESOURCE_FILE_SELECTION_INVALID", "本轮选择的文件数量无效", { status: 400 });
    if (!versionIds.length) return [];
    await this.#authorize("conversation", conversationId, "read");
    const snapshot = await this.#repository.read();
    return versionIds.map((versionId) => {
      const version = snapshot.data.versions.find((entry) => entry.id === versionId);
      invariant(version, "RESOURCE_VERSION_NOT_FOUND", "选择的文件版本不存在", { status: 404, details: { resourceVersionId: versionId } });
      const allowed = snapshot.data.bindings.some((entry) => entry.resourceVersionId === versionId
        && entry.ownerType === "conversation" && entry.ownerId === conversationId && entry.invalidatedSequence === null);
      invariant(allowed, "RESOURCE_FILE_SELECTION_FORBIDDEN", "选择的文件不属于当前对话", { status: 403, details: { resourceVersionId: versionId } });
      const blob = snapshot.data.blobs.find((entry) => entry.id === version.blobId);
      invariant(blob, "RESOURCE_BLOB_MISSING", "选择的文件内容不存在", { status: 500, expose: false });
      return Object.freeze({
        resourceVersionId: version.id,
        filename: version.filename,
        sha256: blob.sha256,
        size: blob.size,
        mime: blob.mime,
        localPath: this.#actorFile(blob.storagePath),
      });
    });
  }

  async read(input = {}) {
    const filename = String(input.filename || "").normalize("NFKC").trim();
    invariant(filename.length >= 1 && filename.length <= 512, "RESOURCE_READ_FILENAME_INVALID", "直接读取需要文件概览中的精确文件名", { status: 400 });
    const start = Number(input.start ?? 0);
    invariant(Number.isSafeInteger(start) && start >= 0 && start <= 100_000_000, "RESOURCE_READ_OFFSET_INVALID", "文件读取位置无效", { status: 400 });
    const scope = normalizeScope(input.scope);
    for (const collectionId of scope.collectionIds) await this.#authorize("collection", collectionId, "read");
    if (scope.projectId) await this.#authorize("project", scope.projectId, "read");
    if (scope.conversationId) await this.#authorize("conversation", scope.conversationId, "read");
    const snapshot = await this.#repository.read();
    const groupedBindings = new Map();
    for (const binding of snapshot.data.bindings.filter((entry) => bindingMatchesScope(entry, scope, Number.MAX_SAFE_INTEGER))) {
      const values = groupedBindings.get(binding.resourceVersionId) || [];
      values.push(binding);
      groupedBindings.set(binding.resourceVersionId, values);
    }
    const results = [];
    const modelImages = [];
    for (const version of snapshot.data.versions) {
      if (results.length >= 5 || version.parseStatus !== "ready" || !groupedBindings.has(version.id)) continue;
      if (version.filename.normalize("NFKC") !== filename) continue;
      const parsedEnvelope = await readJson(this.#actorFile(processingPath("parsed", version.id)), "RESOURCE_PARSED_OUTPUT_MISSING");
      invariant(parsedEnvelope.resourceVersionId === version.id, "RESOURCE_PROCESSING_OUTPUT_MISMATCH", "资源处理结果与版本不匹配", { status: 500, expose: false });
      const text = String(parsedEnvelope.content?.text || "");
      const segment = text.slice(start, start + DIRECT_READ_CHARACTERS);
      const nextOffset = start + segment.length < text.length ? start + segment.length : null;
      results.push({
        resourceVersionId: version.id,
        resourceId: version.resourceId,
        chunkId: `read_${start}`,
        filename: version.filename,
        text: segment,
        nextOffset,
        bindingIds: groupedBindings.get(version.id).map((binding) => binding.id),
      });
      const blob = snapshot.data.blobs.find((entry) => entry.id === version.blobId);
      if (start === 0 && blob && blob.size <= MODEL_IMAGE_BYTES && MODEL_IMAGE_MIME.test(blob.mime)) {
        const bytes = await fs.readFile(this.#actorFile(blob.storagePath));
        modelImages.push({ filename: version.filename, mime: blob.mime, dataUrl: `data:${blob.mime};base64,${bytes.toString("base64")}` });
      }
    }
    invariant(results.length > 0, "RESOURCE_FILE_NOT_FOUND", "当前文件范围内找不到该文件，或文件正文尚未解析完成", { status: 404 });
    return { revision: snapshot.revision, results, modelImages };
  }

  async search(input) {
    await this.embedder.assertConfigured?.();
    const query = String(input?.query || "").trim();
    invariant(query.length > 0 && query.length <= 32768, "RESOURCE_QUERY_INVALID", "检索文本无效", { status: 400 });
    const scope = normalizeScope(input?.scope);
    for (const collectionId of scope.collectionIds) await this.#authorize("collection", collectionId, "read");
    if (scope.projectId) await this.#authorize("project", scope.projectId, "read");
    if (scope.conversationId) await this.#authorize("conversation", scope.conversationId, "read");
    const asOfSequence = input?.asOfSequence === undefined ? Number.MAX_SAFE_INTEGER : Number(input.asOfSequence);
    invariant(Number.isSafeInteger(asOfSequence) && asOfSequence >= 0, "RESOURCE_SEQUENCE_INVALID", "asOfSequence 无效", { status: 400 });
    const limit = Number(input?.limit ?? 8);
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "RESOURCE_SEARCH_LIMIT_INVALID", "检索数量无效", { status: 400 });

    const snapshot = await this.#repository.read();
    const bindings = snapshot.data.bindings.filter((entry) => bindingMatchesScope(entry, scope, asOfSequence));
    const groupedBindings = new Map();
    for (const binding of bindings) {
      const list = groupedBindings.get(binding.resourceVersionId) || [];
      list.push(binding);
      groupedBindings.set(binding.resourceVersionId, list);
    }
    const candidates = [];
    for (const version of snapshot.data.versions) {
      if (!groupedBindings.has(version.id) || !isResourceKnowledgeReady(version)) continue;
      const parsedEnvelope = await readJson(this.#actorFile(processingPath("parsed", version.id)), "RESOURCE_PARSED_OUTPUT_MISSING");
      const vectorEnvelope = await readJson(this.#actorFile(processingPath("vectors", version.id)), "RESOURCE_VECTOR_OUTPUT_MISSING");
      invariant(parsedEnvelope.resourceVersionId === version.id && vectorEnvelope.resourceVersionId === version.id, "RESOURCE_PROCESSING_OUTPUT_MISMATCH", "资源处理结果与版本不匹配", {
        status: 500,
        expose: false,
      });
      candidates.push({
        resourceVersionId: version.id,
        resourceId: version.resourceId,
        filename: version.filename,
        parsed: clone(parsedEnvelope.content),
        vectorReference: clone(vectorEnvelope.content),
        bindings: clone(groupedBindings.get(version.id)),
      });
    }
    if (candidates.length === 0) return { revision: snapshot.revision, results: [] };
    const requiredAnchors = requiredExplicitQueryAnchors(query);
    const eligibleCandidates = requiredAnchors.length
      ? candidates.filter((candidate) => containsExplicitQueryAnchor(
        `${candidate.filename}\n${String(candidate.parsed?.text || "")}`,
        requiredAnchors,
      ))
      : candidates;
    if (eligibleCandidates.length === 0) return { revision: snapshot.revision, results: [] };
    const rawResults = await this.embedder.search({ actor: this.actor, query, candidates: clone(eligibleCandidates), limit });
    invariant(Array.isArray(rawResults), "RESOURCE_SEARCH_OUTPUT_INVALID", "Embedding 检索输出无效", { status: 500, expose: false });
    const candidateMap = new Map(eligibleCandidates.map((entry) => [entry.resourceVersionId, entry]));
    const results = rawResults.slice(0, limit).map((entry) => {
      invariant(entry && typeof entry === "object" && candidateMap.has(entry.resourceVersionId), "RESOURCE_SEARCH_OUTPUT_INVALID", "检索结果引用了 Scope 外资源", {
        status: 500,
        expose: false,
      });
      const candidate = candidateMap.get(entry.resourceVersionId);
      const score = Number(entry.score);
      invariant(Number.isFinite(score), "RESOURCE_SEARCH_OUTPUT_INVALID", "检索分数无效", { status: 500, expose: false });
      return {
        resourceVersionId: candidate.resourceVersionId,
        resourceId: candidate.resourceId,
        filename: candidate.filename,
        score,
        chunkId: entry.chunkId === undefined || entry.chunkId === null ? null : String(entry.chunkId),
        text: entry.text === undefined || entry.text === null ? null : String(entry.text),
        bindingIds: candidate.bindings.map((binding) => binding.id),
      };
    });
    return { revision: snapshot.revision, results };
  }
}

export const resourceServiceConstants = Object.freeze({
  resourceStoreSchemaVersion: RESOURCE_STORE_SCHEMA_VERSION,
  supportedOwnerTypes: SUPPORTED_OWNER_TYPES,
});
