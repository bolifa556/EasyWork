import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import {
  ARTIFACT_STORE_SCHEMA_VERSION,
  assertArtifactRecord,
  commandFileName,
} from "./contract.mjs";

const inlineQueue = Object.freeze({ run: async (_actor, operation) => operation() });

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeBufferAtomic(filePath, content) {
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
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson(filePath, missingValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && arguments.length > 1) return missingValue;
    throw error;
  }
}

function pageName(index) {
  return `${String(index).padStart(8, "0")}.json`;
}

function recordShard(id) {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 2);
}

function validateIndexRoot(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value.generationId === null || typeof value.generationId === "string")
    && Number.isSafeInteger(value.count)
    && value.count >= 0,
  );
}

export class ArtifactStorage {
  constructor(options) {
    this.dataRoot = options.dataRoot;
    this.actor = options.actor;
    this.indexPageSize = options.indexPageSize ?? 100;
    invariant(Number.isSafeInteger(this.indexPageSize) && this.indexPageSize >= 10 && this.indexPageSize <= 1000, "ARTIFACT_INDEX_PAGE_SIZE_INVALID", "Artifact 索引页大小无效", { status: 500, expose: false });
    this.indexRepository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["artifacts", "index.json"],
      schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
      defaultData: () => ({ generationId: null, count: 0 }),
      validate: validateIndexRoot,
      queue: inlineQueue,
    });
  }

  path(...segments) {
    return resolveActorPath(this.dataRoot, this.actor, "artifacts", ...segments);
  }

  async readIndexRoot() {
    return this.indexRepository.read();
  }

  async readIndexGeneration(generationId) {
    if (generationId === null) return [];
    const manifest = await readJson(this.path("_index", generationId, "manifest.json"), null);
    invariant(manifest?.schemaVersion === ARTIFACT_STORE_SCHEMA_VERSION && manifest.generationId === generationId, "ARTIFACT_INDEX_CORRUPT", "Artifact 索引清单无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(manifest.pageCount) && manifest.pageCount >= 0, "ARTIFACT_INDEX_CORRUPT", "Artifact 索引页数无效", { status: 500, expose: false });
    const pages = await Promise.all(Array.from({ length: manifest.pageCount }, (_, index) => readJson(this.path("_index", generationId, "pages", pageName(index)))));
    const summaries = pages.flat();
    invariant(summaries.length === manifest.count, "ARTIFACT_INDEX_CORRUPT", "Artifact 索引数量不一致", { status: 500, expose: false });
    return summaries;
  }

  async stageIndexGeneration(generationId, summaries) {
    const pages = [];
    for (let index = 0; index < summaries.length; index += this.indexPageSize) pages.push(summaries.slice(index, index + this.indexPageSize));
    await Promise.all(pages.map((page, index) => writeJsonAtomic(this.path("_index", generationId, "pages", pageName(index)), page)));
    await writeJsonAtomic(this.path("_index", generationId, "manifest.json"), {
      schemaVersion: ARTIFACT_STORE_SCHEMA_VERSION,
      generationId,
      count: summaries.length,
      pageSize: this.indexPageSize,
      pageCount: pages.length,
    });
  }

  async commitIndexGeneration(generationId, count, expectedRevision, clock) {
    return this.indexRepository.replace({ generationId, count }, { expectedRevision, clock });
  }

  recordPath(id) {
    return this.path("records", recordShard(id), `${id}.json`);
  }

  thumbnailPath(id) {
    return this.path("thumbnails", recordShard(id), `${id}.json`);
  }

  async readRecord(id) {
    const record = await readJson(this.recordPath(id), null);
    if (record === null) return null;
    assertArtifactRecord(record);
    invariant(record.actorId === this.actor.actorId, "ARTIFACT_ACTOR_MISMATCH", "Artifact 不属于当前 Actor", { status: 403 });
    return structuredClone(record);
  }

  async writeRecord(record) {
    assertArtifactRecord(record);
    invariant(record.actorId === this.actor.actorId, "ARTIFACT_ACTOR_MISMATCH", "Artifact 不属于当前 Actor", { status: 403 });
    await writeJsonAtomic(this.recordPath(record.id), record);
  }

  async deleteRecord(id) {
    await fs.rm(this.recordPath(id), { force: true });
    await fs.rm(this.thumbnailPath(id), { force: true });
  }

  async readCommand(commandId) {
    return readJson(this.path("_commands", commandFileName(commandId)), null);
  }

  async writeCommand(commandId, record) {
    await writeJsonAtomic(this.path("_commands", commandFileName(commandId)), record);
  }

  blobRelativePath(sha256) {
    return `artifacts/blobs/${sha256.slice(0, 2)}/${sha256}`;
  }

  blobPath(sha256) {
    return resolveActorPath(this.dataRoot, this.actor, this.blobRelativePath(sha256));
  }

  blobPathFromRelative(relativePath) {
    invariant(typeof relativePath === "string" && relativePath.startsWith("artifacts/blobs/"), "ARTIFACT_BLOB_PATH_INVALID", "Artifact Blob 路径无效", { status: 500, expose: false });
    return resolveActorPath(this.dataRoot, this.actor, relativePath);
  }

  async ensureBlob(sha256, content) {
    const filePath = this.blobPath(sha256);
    try {
      const existing = await fs.readFile(filePath);
      invariant(existing.length === content.length && crypto.createHash("sha256").update(existing).digest("hex") === sha256, "ARTIFACT_BLOB_CORRUPT", "Artifact Blob 校验失败", { status: 500, expose: false });
      return { relativePath: this.blobRelativePath(sha256), created: false };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await writeBufferAtomic(filePath, content);
    return { relativePath: this.blobRelativePath(sha256), created: true };
  }

  async deleteBlobByRelativePath(relativePath) {
    const expectedPrefix = "artifacts/blobs/";
    invariant(typeof relativePath === "string" && relativePath.startsWith(expectedPrefix), "ARTIFACT_BLOB_PATH_INVALID", "Artifact Blob 路径无效", { status: 500, expose: false });
    await fs.rm(this.blobPathFromRelative(relativePath), { force: true });
  }
}
