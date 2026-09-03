import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { replaceFileWithRetry } from "../repository.mjs";
import { assertExpectedRevision } from "../revision.mjs";

const PLATFORM_ACTOR = Object.freeze({ actorType: "platform", actorId: "global" });

function clone(value) {
  return structuredClone(value);
}

function assertWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  invariant(relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)), "PLATFORM_PATH_ESCAPE", "平台数据路径越界", {
    status: 500,
    expose: false,
  });
  return candidate;
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

export async function atomicWritePlatformJson(filePath, value) {
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

export class PlatformJsonRepository {
  constructor({ dataRoot, relativePath, schemaVersion, defaultData, validate, queue = defaultActorMutationQueue, queueKey = "global" }) {
    invariant(path.isAbsolute(dataRoot), "PLATFORM_DATA_ROOT_INVALID", "dataRoot 必须是绝对路径", { status: 500, expose: false });
    invariant(Array.isArray(relativePath) && relativePath.length > 0, "PLATFORM_PATH_INVALID", "平台 Repository 路径无效", { status: 500, expose: false });
    this.platformRoot = path.resolve(dataRoot, "admins", "platform");
    this.filePath = assertWithin(this.platformRoot, path.resolve(this.platformRoot, ...relativePath));
    this.schemaVersion = schemaVersion;
    this.defaultData = defaultData;
    this.validate = validate || (() => true);
    this.queue = queue;
    this.queueActor = Object.freeze({ ...PLATFORM_ACTOR, actorId: `global:${queueKey}` });
  }

  async #readEnvelope() {
    let envelope;
    try {
      envelope = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        const data = clone(this.defaultData());
        this.#validate(data);
        return { schemaVersion: this.schemaVersion, revision: 0, updatedAt: null, data };
      }
      if (error instanceof SyntaxError) invariant(false, "PLATFORM_STORE_CORRUPT", "平台配置文件损坏", { status: 500, expose: false });
      throw error;
    }
    invariant(envelope?.schemaVersion === this.schemaVersion && Number.isSafeInteger(envelope.revision) && envelope.revision >= 0, "PLATFORM_STORE_CORRUPT", "平台配置 envelope 无效", {
      status: 500,
      expose: false,
    });
    this.#validate(envelope.data);
    return envelope;
  }

  #validate(data) {
    invariant(this.validate(data) !== false, "PLATFORM_STORE_INVALID", "平台配置未通过校验", { status: 500, expose: false });
  }

  async read() {
    return clone(await this.#readEnvelope());
  }

  async update(mutator, options = {}) {
    invariant(typeof mutator === "function", "PLATFORM_MUTATOR_INVALID", "平台配置 mutator 无效", { status: 500, expose: false });
    return this.queue.run(this.queueActor, async () => {
      const current = await this.#readEnvelope();
      if (options.expectedRevision !== undefined) assertExpectedRevision(current.revision, options.expectedRevision);
      const draft = clone(current.data);
      const result = await mutator(draft, { currentRevision: current.revision, nextRevision: current.revision + 1 });
      const nextData = result === undefined ? draft : result;
      this.#validate(nextData);
      const next = {
        schemaVersion: this.schemaVersion,
        revision: current.revision + 1,
        updatedAt: (options.clock || (() => new Date()))().toISOString(),
        data: clone(nextData),
      };
      await atomicWritePlatformJson(this.filePath, next);
      return clone(next);
    });
  }
}
