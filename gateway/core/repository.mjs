import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ApiError, invariant } from "./errors.mjs";
import { defaultActorMutationQueue } from "./mutation-queue.mjs";
import { resolveActorPath } from "./paths.mjs";
import { assertExpectedRevision } from "./revision.mjs";
import { freezeReadSnapshot, repositoryReadCache } from "./read-cache.mjs";

function clone(value) {
  return structuredClone(value);
}

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const fileMutationTails = new Map();

function fileKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function clearRepositoryReadCache(directory) {
  repositoryReadCache.clearPrefix(`${fileKey(directory)}${path.sep}`);
}

async function fileSignature(filePath) {
  try {
    const stat = await fs.stat(filePath, { bigint: true });
    return { key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, bytes: Number(stat.size) };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function runFileMutation(filePath, operation) {
  const key = fileKey(filePath);
  const previous = fileMutationTails.get(key) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => turn);
  fileMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (fileMutationTails.get(key) === tail) fileMutationTails.delete(key);
  }
}

export async function replaceFileWithRetry(sourcePath, targetPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = Number(options.maxAttempts || 12);
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await fileSystem.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt === maxAttempts - 1) throw error;
      await sleep(Math.min(250, 10 * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function overwriteFileInPlace(sourcePath, targetPath) {
  const contents = await fs.readFile(sourcePath);
  let handle;
  try {
    try { handle = await fs.open(targetPath, "r+"); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      handle = await fs.open(targetPath, "wx", 0o600);
    }
    await handle.write(contents, 0, contents.length, 0);
    await handle.truncate(contents.length);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await fs.rm(sourcePath, { force: true });
}

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

export async function atomicWriteJson(filePath, value, { compact = false } = {}) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await replaceFileWithRetry(temporaryPath, filePath);
    } catch (error) {
      // Windows can keep an existing JSON file open long enough that every
      // atomic replacement attempt fails with EPERM even though mutations for
      // this path are already serialized. Preserve the fully-fsynced temporary
      // payload and fall back to an in-place replacement only for that platform
      // and those transient lock errors.
      if (process.platform !== "win32" || !TRANSIENT_RENAME_ERRORS.has(error?.code)) throw error;
      await overwriteFileInPlace(temporaryPath, filePath);
    }
    await fsyncDirectory(directory);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class AtomicJsonRepository {
  constructor(options) {
    invariant(options?.actor, "ACTOR_CONTEXT_REQUIRED", "Repository 需要 ActorContext", { status: 500, expose: false });
    invariant(Number.isSafeInteger(options.schemaVersion) && options.schemaVersion > 0, "SCHEMA_VERSION_INVALID", "schemaVersion 必须是正整数", { status: 500, expose: false });
    invariant(typeof options.defaultData === "function", "REPOSITORY_DEFAULT_REQUIRED", "Repository 需要 defaultData 工厂", { status: 500, expose: false });
    this.actor = options.actor;
    this.schemaVersion = options.schemaVersion;
    this.defaultData = options.defaultData;
    this.validate = options.validate || (() => true);
    this.queue = options.queue || defaultActorMutationQueue;
    this.relativePath = (Array.isArray(options.relativePath) ? options.relativePath : [options.relativePath])
      .map((segment) => String(segment));
    this.filePath = resolveActorPath(options.dataRoot, options.actor, options.relativePath);
    this.cacheReads = options.cacheReads === true;
    this.compact = options.compact === true;
    this.onRead = options.onRead;
  }

  async #readEnvelope() {
    let signature;
    if (this.cacheReads) {
      signature = await fileSignature(this.filePath);
      const cached = repositoryReadCache.get(fileKey(this.filePath));
      if (signature && cached?.signature === signature.key) {
        this.#validateEnvelope(cached.envelope);
        this.onRead?.({ cacheHit: true, bytes: signature.bytes });
        return cached.envelope;
      }
      repositoryReadCache.delete(fileKey(this.filePath));
    }
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        const data = clone(this.defaultData());
        this.#validateData(data);
        return { schemaVersion: this.schemaVersion, revision: 0, updatedAt: null, data };
      }
      if (error instanceof SyntaxError) {
        throw new ApiError("REPOSITORY_CORRUPT", "数据文件不是有效 JSON", { status: 500, expose: false, cause: error });
      }
      throw error;
    }
    this.#validateEnvelope(parsed);
    this.onRead?.({ cacheHit: false, bytes: signature?.bytes });
    if (this.cacheReads && signature) this.#cache(parsed, signature);
    return parsed;
  }

  #validateEnvelope(parsed) {
    invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), "REPOSITORY_CORRUPT", "数据文件结构无效", { status: 500, expose: false });
    invariant(parsed.schemaVersion === this.schemaVersion, "SCHEMA_VERSION_MISMATCH", "数据 schema 与当前版本不一致", {
      status: 500,
      expose: false,
      details: { expected: this.schemaVersion, actual: parsed.schemaVersion },
    });
    invariant(Number.isSafeInteger(parsed.revision) && parsed.revision >= 0, "REPOSITORY_CORRUPT", "数据 revision 无效", { status: 500, expose: false });
    this.#validateData(parsed.data);
  }

  #cache(envelope, signature) {
    const overhead = Array.isArray(envelope.data?.events) ? envelope.data.events.length * 320 : 0;
    repositoryReadCache.set(fileKey(this.filePath), {
      signature: signature.key,
      envelope: freezeReadSnapshot(envelope),
    }, signature.bytes * 2 + overhead);
  }

  async #commit(next) {
    // A failed Windows in-place replacement must be revalidated on the next read.
    repositoryReadCache.delete(fileKey(this.filePath));
    await atomicWriteJson(this.filePath, next, { compact: this.compact });
    if (this.cacheReads) {
      const signature = await fileSignature(this.filePath);
      if (signature) this.#cache(next, signature);
    }
  }

  #validateData(data) {
    const result = this.validate(data);
    invariant(result !== false, "ENTITY_VALIDATION_FAILED", "实体未通过 Repository 校验", {
      status: 400,
      details: { repository: this.relativePath.join("/") },
    });
  }

  async read() {
    // Atomic rename is normally invisible to readers. The Windows lock
    // fallback replaces the destination in place, so an unsynchronised read
    // could briefly observe the file between write/truncate operations and
    // report valid persisted data as corrupt JSON. Share the same per-file
    // mutation lane for reads to keep that fallback transactional in-process.
    return this.readProjected((envelope) => envelope);
  }

  async readProjected(project) {
    return runFileMutation(this.filePath, async () => clone(project(await this.#readEnvelope())));
  }

  // Internal readers pin an immutable version while paging; later commits
  // publish a different snapshot and cannot change an in-progress replay.
  async readSnapshot() {
    return runFileMutation(this.filePath, async () => freezeReadSnapshot(await this.#readEnvelope()));
  }

  async updateCurrent(transform, { project = (envelope) => envelope, clock = () => new Date() } = {}) {
    invariant(typeof transform === "function", "REPOSITORY_MUTATOR_INVALID", "Repository transform 必须是函数", { status: 500, expose: false });
    return this.queue.run(this.actor, () => runFileMutation(this.filePath, async () => {
      const current = freezeReadSnapshot(await this.#readEnvelope());
      // System appends derive their result inside the transaction. User edits
      // continue to require expectedRevision through update/replace below.
      const data = transform(current.data);
      this.#validateData(data);
      const next = { schemaVersion: this.schemaVersion, revision: current.revision + 1, updatedAt: clock().toISOString(), data };
      await this.#commit(next);
      return clone(project(next));
    }));
  }

  async replace(data, options = {}) {
    return this.queue.run(this.actor, () => runFileMutation(this.filePath, async () => {
      const current = await this.#readEnvelope();
      assertExpectedRevision(current.revision, options.expectedRevision);
      const nextData = clone(data);
      this.#validateData(nextData);
      const next = {
        schemaVersion: this.schemaVersion,
        revision: current.revision + 1,
        updatedAt: (options.clock || (() => new Date()))().toISOString(),
        data: nextData,
      };
      await this.#commit(next);
      return clone(next);
    }));
  }

  async update(mutator, options = {}) {
    invariant(typeof mutator === "function", "REPOSITORY_MUTATOR_INVALID", "Repository mutator 必须是函数", { status: 500, expose: false });
    return this.queue.run(this.actor, () => runFileMutation(this.filePath, async () => {
      const current = await this.#readEnvelope();
      assertExpectedRevision(current.revision, options.expectedRevision);
      const draft = clone(current.data);
      const result = await mutator(draft);
      const nextData = result === undefined ? draft : result;
      this.#validateData(nextData);
      const next = {
        schemaVersion: this.schemaVersion,
        revision: current.revision + 1,
        updatedAt: (options.clock || (() => new Date()))().toISOString(),
        data: clone(nextData),
      };
      await this.#commit(next);
      return clone(next);
    }));
  }
}
