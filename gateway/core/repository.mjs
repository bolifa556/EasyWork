import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ApiError, invariant } from "./errors.mjs";
import { defaultActorMutationQueue } from "./mutation-queue.mjs";
import { resolveActorPath } from "./paths.mjs";
import { assertExpectedRevision } from "./revision.mjs";

function clone(value) {
  return structuredClone(value);
}

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

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

async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFileWithRetry(temporaryPath, filePath);
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
    this.filePath = resolveActorPath(options.dataRoot, options.actor, options.relativePath);
  }

  async #readEnvelope() {
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
    invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), "REPOSITORY_CORRUPT", "数据文件结构无效", { status: 500, expose: false });
    invariant(parsed.schemaVersion === this.schemaVersion, "SCHEMA_VERSION_MISMATCH", "数据 schema 与当前版本不一致", {
      status: 500,
      expose: false,
      details: { expected: this.schemaVersion, actual: parsed.schemaVersion },
    });
    invariant(Number.isSafeInteger(parsed.revision) && parsed.revision >= 0, "REPOSITORY_CORRUPT", "数据 revision 无效", { status: 500, expose: false });
    this.#validateData(parsed.data);
    return parsed;
  }

  #validateData(data) {
    const result = this.validate(data);
    invariant(result !== false, "ENTITY_VALIDATION_FAILED", "实体未通过 Repository 校验", { status: 400 });
  }

  async read() {
    return clone(await this.#readEnvelope());
  }

  async replace(data, options = {}) {
    return this.queue.run(this.actor, async () => {
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
      await atomicWriteJson(this.filePath, next);
      return clone(next);
    });
  }

  async update(mutator, options = {}) {
    invariant(typeof mutator === "function", "REPOSITORY_MUTATOR_INVALID", "Repository mutator 必须是函数", { status: 500, expose: false });
    return this.queue.run(this.actor, async () => {
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
      await atomicWriteJson(this.filePath, next);
      return clone(next);
    });
  }
}
