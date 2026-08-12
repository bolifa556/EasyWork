import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";
import {
  activateSkillVersion,
  createSkillRegistry,
  createSkillVersion,
  createTaskSkillPin,
  registerSkillVersion,
  validateSkillRegistry,
  validateSkillVersion,
  validateTaskSkillPin,
} from "../entities/skill.mjs";
import { revisedHeader } from "../entities/common.mjs";
import { ActorMutationQueue } from "../mutation-queue.mjs";
import { assertActorOwnedPath, resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { assertExpectedRevision } from "../revision.mjs";

const SKILL_STORE_SCHEMA_VERSION = 1;
const PACKAGE_SCHEMA_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEARCHABLE_SKILL_FILE_PATTERN = /(?:^|\/)(?:SKILL\.md|README(?:\.[^/]+)?)$|\.(?:md|mdx|txt|json|ya?ml|toml|ini|cfg|conf|xml|html?|css|mjs|cjs|js|jsx|ts|tsx|sh|ps1|py|rb|go|rs|java|c|h|cc|cpp|hpp)$/i;
const MAX_SKILL_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_SKILL_SEARCH_TOTAL_BYTES = 192 * 1024;
const sharedSkillMutationQueue = new ActorMutationQueue();
const inlineRepositoryQueue = Object.freeze({ run: async (_actor, operation) => operation() });

function clone(value) {
  return structuredClone(value);
}

function defaultStore() {
  return { registries: [], versions: [], taskPins: [] };
}

function assertId(value, field) {
  invariant(typeof value === "string" && SAFE_ID_PATTERN.test(value), "SKILL_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return value;
}

function assertSegment(value, field) {
  invariant(typeof value === "string" && SAFE_SEGMENT_PATTERN.test(value), "SKILL_PATH_SEGMENT_INVALID", `${field} 不能用于目录名`, { status: 400 });
  return value;
}

function assertRelativeFilePath(value, field = "file.path") {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 4096, "SKILL_FILE_PATH_INVALID", `${field} 无效`, { status: 400 });
  invariant(!value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value), "SKILL_FILE_PATH_INVALID", `${field} 必须是 / 分隔的相对路径`, {
    status: 400,
  });
  const segments = value.split("/");
  invariant(segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\0")), "SKILL_FILE_PATH_INVALID", `${field} 包含非法路径片段`, {
    status: 400,
  });
  invariant(value !== "package.json", "SKILL_FILE_PATH_RESERVED", "package.json 是 EasyWork 保留路径", { status: 400 });
  return value;
}

function normalizeManifest(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "SKILL_MANIFEST_INVALID", "Skill manifest 必须是对象", { status: 400 });
  const keys = Object.keys(input);
  invariant(keys.length === 4 && keys.every((key) => ["name", "description", "entrypoint", "permissions"].includes(key)), "SKILL_MANIFEST_SCHEMA_INVALID", "Skill manifest 字段不符合 schema", {
    status: 400,
  });
  invariant(typeof input.name === "string" && input.name === input.name.trim() && input.name.length > 0 && input.name.length <= 256, "SKILL_MANIFEST_NAME_INVALID", "Skill 名称无效", {
    status: 400,
  });
  invariant(typeof input.description === "string" && input.description === input.description.trim() && input.description.length <= 8192, "SKILL_MANIFEST_DESCRIPTION_INVALID", "Skill 描述无效", {
    status: 400,
  });
  const entrypoint = assertRelativeFilePath(input.entrypoint, "manifest.entrypoint");
  invariant(Array.isArray(input.permissions) && input.permissions.length <= 256, "SKILL_MANIFEST_PERMISSIONS_INVALID", "Skill permissions 无效", { status: 400 });
  const permissions = input.permissions.map((permission) => assertId(permission, "manifest.permissions[]"));
  invariant(new Set(permissions).size === permissions.length, "SKILL_MANIFEST_PERMISSIONS_DUPLICATE", "Skill permissions 不能重复", { status: 400 });
  return {
    name: input.name,
    description: input.description,
    entrypoint,
    permissions: [...permissions].sort(),
  };
}

function normalizeFiles(files, limits) {
  invariant(Array.isArray(files) && files.length > 0 && files.length <= limits.maxFiles, "SKILL_FILES_INVALID", "Skill 文件数量无效", {
    status: 400,
    details: { maxFiles: limits.maxFiles },
  });
  let totalBytes = 0;
  const seen = new Set();
  const normalized = files.map((file, index) => {
    invariant(file && typeof file === "object" && !Array.isArray(file), "SKILL_FILE_INVALID", `files[${index}] 无效`, { status: 400 });
    invariant(Object.keys(file).every((key) => ["path", "content"].includes(key)) && Object.hasOwn(file, "path") && Object.hasOwn(file, "content"), "SKILL_FILE_SCHEMA_INVALID", `files[${index}] 字段无效`, {
      status: 400,
    });
    const filePath = assertRelativeFilePath(file.path, `files[${index}].path`);
    invariant(!seen.has(filePath), "SKILL_FILE_DUPLICATE", "Skill 不能包含重复文件路径", { status: 400, details: { path: filePath } });
    seen.add(filePath);
    const content = Buffer.isBuffer(file.content) ? Buffer.from(file.content) : Buffer.from(String(file.content));
    invariant(content.length <= limits.maxFileBytes, "SKILL_FILE_TOO_LARGE", "Skill 单文件超过大小限制", {
      status: 413,
      details: { path: filePath, maxFileBytes: limits.maxFileBytes },
    });
    totalBytes += content.length;
    invariant(totalBytes <= limits.maxPackageBytes, "SKILL_PACKAGE_TOO_LARGE", "Skill 包超过大小限制", {
      status: 413,
      details: { maxPackageBytes: limits.maxPackageBytes },
    });
    return { path: filePath, content };
  });
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function hashPackage(skillId, version, manifest, files) {
  const hash = crypto.createHash("sha256");
  const feed = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(Buffer.from(`${buffer.length}:`));
    hash.update(buffer);
  };
  feed(skillId);
  feed(version);
  feed(JSON.stringify(manifest));
  for (const file of files) {
    feed(file.path);
    feed(file.content);
  }
  return hash.digest("hex");
}

function packageRelativeRoot(skillId, version) {
  return `skills/packages/${skillId}/${version}`;
}

function packageDescriptor(skillId, version, sha256, manifest, files) {
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    skillId,
    version,
    sha256,
    manifest: clone(manifest),
    files: files.map((file) => ({
      path: file.path,
      size: file.content.length,
      sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
    })),
  };
}

function queryTerms(query) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return [];
  return [...new Set([
    normalized,
    ...normalized.split(/\s+/u),
    ...(normalized.match(/[A-Za-z0-9_.-]+/g) || []),
  ].filter((term) => term.length > 1))];
}

function skillSearchScore(text, terms) {
  const normalized = String(text || "").toLocaleLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? Math.max(1, Math.min(8, term.length)) : 0), 0);
}

function assertStore(store, actorId) {
  invariant(store && typeof store === "object" && !Array.isArray(store), "SKILL_STORE_INVALID", "Skill 索引无效", { status: 500, expose: false });
  invariant(Object.keys(store).length === 3 && ["registries", "versions", "taskPins"].every((key) => Array.isArray(store[key])), "SKILL_STORE_INVALID", "Skill 索引结构无效", {
    status: 500,
    expose: false,
  });
  const allIds = new Set();
  for (const version of store.versions) {
    validateSkillVersion(version);
    invariant(version.actorId === actorId, "SKILL_ACTOR_MISMATCH", "SkillVersion 不属于当前 Actor", { status: 403 });
    invariant(!allIds.has(version.id), "SKILL_ENTITY_ID_DUPLICATE", "Skill 实体 ID 重复", { status: 500, expose: false });
    allIds.add(version.id);
  }
  const versionIds = new Set(store.versions.map((entry) => entry.id));
  const versionKeys = store.versions.map((entry) => `${entry.skillId}:${entry.version}`);
  invariant(new Set(versionKeys).size === versionKeys.length, "SKILL_VERSION_DUPLICATE", "相同 Skill 版本不能重复", { status: 500, expose: false });
  for (const registry of store.registries) {
    validateSkillRegistry(registry);
    invariant(registry.actorId === actorId, "SKILL_ACTOR_MISMATCH", "SkillRegistry 不属于当前 Actor", { status: 403 });
    invariant(registry.versions.every((entry) => {
      if (!versionIds.has(entry.skillVersionId)) return false;
      const version = store.versions.find((candidate) => candidate.id === entry.skillVersionId);
      return version.skillId === registry.skillId && version.version === entry.version && version.sha256 === entry.sha256;
    }), "SKILL_REGISTRY_VERSION_MISSING", "Skill Registry 引用了不存在或不匹配的版本", { status: 500, expose: false });
    invariant(!allIds.has(registry.id), "SKILL_ENTITY_ID_DUPLICATE", "Skill 实体 ID 重复", { status: 500, expose: false });
    allIds.add(registry.id);
  }
  for (const pin of store.taskPins) {
    validateTaskSkillPin(pin);
    invariant(pin.actorId === actorId, "SKILL_ACTOR_MISMATCH", "TaskSkillPin 不属于当前 Actor", { status: 403 });
    const version = store.versions.find((entry) => entry.id === pin.skillVersionId);
    invariant(version && version.skillId === pin.skillId && version.version === pin.version && version.sha256 === pin.sha256, "SKILL_PIN_VERSION_MISMATCH", "TaskSkillPin 与版本不一致", {
      status: 500,
      expose: false,
    });
    invariant(!allIds.has(pin.id), "SKILL_ENTITY_ID_DUPLICATE", "Skill 实体 ID 重复", { status: 500, expose: false });
    allIds.add(pin.id);
  }
  const registrySkillIds = store.registries.map((entry) => entry.skillId);
  invariant(new Set(registrySkillIds).size === registrySkillIds.length, "SKILL_REGISTRY_DUPLICATE", "同一 Skill 只能有一个 Registry", { status: 500, expose: false });
  const pinKeys = store.taskPins.map((entry) => `${entry.taskId}:${entry.skillId}`);
  invariant(new Set(pinKeys).size === pinKeys.length, "SKILL_TASK_PIN_DUPLICATE", "同一 Task 不能重复固定 Skill", { status: 500, expose: false });
  return true;
}

function removeVersionFromRegistry(registry, skillVersionId, options) {
  const versions = registry.versions.filter((entry) => entry.skillVersionId !== skillVersionId);
  const next = {
    ...clone(registry),
    ...revisedHeader(registry, options.expectedRevision, options),
    versions,
    activeVersionId: registry.activeVersionId === skillVersionId ? null : registry.activeVersionId,
  };
  validateSkillRegistry(next);
  return next;
}

async function readCommittedPackage(fileSystem, finalRoot) {
  try {
    return JSON.parse(await fileSystem.readFile(path.join(finalRoot, "package.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertReusablePackage(existing, descriptor) {
  invariant(
    existing?.schemaVersion === descriptor.schemaVersion
      && existing.skillId === descriptor.skillId
      && existing.version === descriptor.version
      && existing.sha256 === descriptor.sha256,
    "SKILL_PACKAGE_PATH_CONFLICT",
    "Skill 包目录已被不同内容占用",
    { status: 409 },
  );
}

async function writePackageDirectory(finalRoot, descriptor, files, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const parent = path.dirname(finalRoot);
  await fileSystem.mkdir(parent, { recursive: true });
  // `package.json` is the commit marker.  A committed package is immutable;
  // even a same-path race may only reuse identical content, never replace it.
  const committed = await readCommittedPackage(fileSystem, finalRoot);
  if (committed) {
    assertReusablePackage(committed, descriptor);
    return { created: false };
  }
  const staging = path.join(parent, `.${path.basename(finalRoot)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fileSystem.mkdir(path.join(staging, "files"), { recursive: true });
  try {
    for (const file of files) {
      const destination = path.resolve(staging, "files", ...file.path.split("/"));
      invariant(destination.startsWith(`${path.resolve(staging, "files")}${path.sep}`), "SKILL_FILE_PATH_ESCAPE", "Skill 文件路径越界", { status: 400 });
      await fileSystem.mkdir(path.dirname(destination), { recursive: true });
      await fileSystem.writeFile(destination, file.content, { mode: 0o600 });
    }
    await fileSystem.writeFile(path.join(staging, "package.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // Windows indexers and sync clients can briefly hold a freshly-written
    // directory open.  Keep the commit atomic, but tolerate that transient
    // lock instead of exposing a half-created Skill version to the registry.
    let renamed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fileSystem.rename(staging, finalRoot);
        renamed = true;
        break;
      } catch (error) {
        const transient = ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
        if (!transient) throw error;
        if (attempt === 7) break;
        await sleep(40 * (attempt + 1));
      }
    }
    if (!renamed) {
      // Directory renames can remain locked for a long time on Windows when
      // an indexer inspects freshly-created files.  Materialise into the final
      // directory with the descriptor copied last; the registry is still the
      // sole visibility boundary, so an interrupted copy is never exposed as
      // an installed version and is removed by the retry path above.
      let ownsFinalRoot = false;
      try {
        // Claim the final directory itself rather than recursively merging
        // into it.  If another process committed a package after our first
        // check, reuse the identical package or reject the conflict without
        // touching any of its files.
        try {
          await fileSystem.mkdir(finalRoot);
          ownsFinalRoot = true;
        } catch (error) {
          if (!["EEXIST", "EPERM", "EACCES"].includes(error?.code)) throw error;
          const concurrent = await readCommittedPackage(fileSystem, finalRoot);
          if (!concurrent) throw error;
          assertReusablePackage(concurrent, descriptor);
          await fileSystem.rm(staging, { recursive: true, force: true });
          return { created: false };
        }
        await fileSystem.cp(path.join(staging, "files"), path.join(finalRoot, "files"), { recursive: true, force: false, errorOnExist: true });
        await fileSystem.copyFile(path.join(staging, "package.json"), path.join(finalRoot, "package.json"), fsConstants.COPYFILE_EXCL);
        await fileSystem.rm(staging, { recursive: true, force: true });
        renamed = true;
      } catch (error) {
        if (ownsFinalRoot) await fileSystem.rm(finalRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    invariant(renamed, "SKILL_PACKAGE_COMMIT_FAILED", "Skill 包目录提交失败", { status: 500, expose: false });
    return { created: true };
  } catch (error) {
    await fileSystem.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function remoteRoot(skillId, version) {
  return `~/.easywork/skills/${skillId}/${version}`;
}

export class SkillService {
  #repository;

  constructor(options) {
    invariant(options?.actor?.actorId, "ACTOR_CONTEXT_REQUIRED", "SkillService 需要 ActorContext", { status: 500, expose: false });
    invariant(typeof options?.dataRoot === "string" && path.isAbsolute(options.dataRoot), "DATA_ROOT_INVALID", "SkillService 需要绝对 dataRoot", { status: 500, expose: false });
    invariant(typeof options?.authorizeTask === "function", "SKILL_TASK_AUTHORIZER_REQUIRED", "SkillService 需要 Task 授权器", { status: 500, expose: false });
    this.actor = options.actor;
    this.dataRoot = options.dataRoot;
    this.authorizeTask = options.authorizeTask;
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || ((kind) => `${kind}_${crypto.randomUUID()}`);
    this.maxFiles = Number(options.maxFiles ?? 1000);
    this.maxFileBytes = Number(options.maxFileBytes ?? 10 * 1024 * 1024);
    this.maxPackageBytes = Number(options.maxPackageBytes ?? 50 * 1024 * 1024);
    invariant([this.maxFiles, this.maxFileBytes, this.maxPackageBytes].every((value) => Number.isSafeInteger(value) && value > 0), "SKILL_LIMIT_INVALID", "Skill 大小限制无效", {
      status: 500,
      expose: false,
    });
    this.mutationQueue = options.mutationQueue || sharedSkillMutationQueue;
    invariant(typeof this.mutationQueue?.run === "function", "SKILL_MUTATION_QUEUE_INVALID", "Skill 写队列无效", { status: 500, expose: false });
    this.packageFileSystem = options.packageFileSystem || fs;
    this.packageCommitSleep = options.packageCommitSleep;
    this.#repository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: "skills/index.json",
      schemaVersion: SKILL_STORE_SCHEMA_VERSION,
      defaultData: defaultStore,
      validate: (store) => assertStore(store, this.actor.actorId),
      queue: inlineRepositoryQueue,
    });
  }

  #newId(kind) {
    return assertId(String(this.idFactory(kind)), `${kind}Id`);
  }

  #actorPath(relativePath) {
    return assertActorOwnedPath(this.dataRoot, this.actor, resolveActorPath(this.dataRoot, this.actor, relativePath));
  }

  async #mutate(operation) {
    return this.mutationQueue.run(this.actor, operation);
  }

  async #authorizeTask(taskId, action) {
    assertId(taskId, "taskId");
    const allowed = await this.authorizeTask({ actor: this.actor, taskId, action });
    invariant(allowed !== false, "SKILL_TASK_FORBIDDEN", "当前 Actor 无权操作该 Task", { status: 403, details: { taskId, action } });
  }

  async inspect() {
    return this.#repository.read();
  }

  async searchContext(input = {}) {
    const query = String(input.query || "").trim();
    const terms = queryTerms(query);
    const limit = Math.min(20, Math.max(1, Number(input.limit) || 8));
    const selectedVersions = Array.isArray(input.selectedSkillVersions)
      ? input.selectedSkillVersions.map((entry) => ({
        skillId: assertSegment(String(entry?.skillId || ""), "selectedSkillVersions[].skillId"),
        version: assertSegment(String(entry?.version || ""), "selectedSkillVersions[].version"),
      }))
      : [];
    const selectedKeys = new Set(selectedVersions.map((entry) => `${entry.skillId}:${entry.version}`));
    const snapshot = await this.#repository.read();
    const candidates = snapshot.data.registries.flatMap((registry) => {
      const versions = selectedKeys.size > 0
        ? snapshot.data.versions.filter((entry) => entry.skillId === registry.skillId && selectedKeys.has(`${entry.skillId}:${entry.version}`))
        : snapshot.data.versions.filter((entry) => entry.id === registry.activeVersionId);
      return versions.map((version) => ({ registry, version }));
    });
    const ranked = candidates
      .map((entry) => ({
        ...entry,
        score: skillSearchScore([
          entry.registry.skillId,
          entry.registry.displayName,
          entry.registry.description,
          entry.version.manifest.name,
          entry.version.manifest.description,
          entry.version.manifest.entrypoint,
        ].join("\n"), terms),
      }))
      .sort((left, right) => right.score - left.score || right.version.updatedAt.localeCompare(left.version.updatedAt))
      .slice(0, limit);

    const results = [];
    let remainingBytes = MAX_SKILL_SEARCH_TOTAL_BYTES;
    for (const { registry, version, score } of ranked) {
      if (remainingBytes <= 0) break;
      const verified = await this.#loadVerifiedPackage(version);
      const files = verified.files
        .filter((file) => SEARCHABLE_SKILL_FILE_PATTERN.test(file.relativePath) && !file.content.includes(0))
        .map((file) => {
          const text = file.content.subarray(0, Math.min(file.content.length, MAX_SKILL_SEARCH_FILE_BYTES)).toString("utf8");
          const preferred = file.relativePath === "SKILL.md" ? 100 : file.relativePath === version.manifest.entrypoint ? 80 : 0;
          return { ...file, text, score: preferred + skillSearchScore(`${file.relativePath}\n${text}`, terms) };
        })
        .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath));
      const selectedFiles = [];
      for (const file of files) {
        if (remainingBytes <= 0) break;
        const content = Buffer.from(file.text);
        const included = content.subarray(0, remainingBytes).toString("utf8");
        if (!included) break;
        selectedFiles.push({
          path: file.relativePath,
          size: file.size,
          content: included,
          truncated: Buffer.byteLength(included) < file.size,
        });
        remainingBytes -= Buffer.byteLength(included);
      }
      results.push({
        skillId: registry.skillId,
        version: version.version,
        sha256: version.sha256,
        name: registry.displayName,
        description: registry.description,
        entrypoint: version.manifest.entrypoint,
        permissions: clone(version.manifest.permissions),
        score,
        files: selectedFiles,
      });
    }
    return results;
  }

  async uploadVersion(input) {
    return this.#mutate(async () => {
      const skillId = assertSegment(String(input?.skillId || ""), "skillId");
      const versionLabel = assertSegment(String(input?.version || ""), "version");
      const manifest = normalizeManifest(input?.manifest);
      const files = normalizeFiles(input?.files, this);
      invariant(files.some((file) => file.path === manifest.entrypoint), "SKILL_ENTRYPOINT_MISSING", "manifest.entrypoint 必须指向包内文件", {
        status: 400,
        details: { entrypoint: manifest.entrypoint },
      });
      const sha256 = hashPackage(skillId, versionLabel, manifest, files);
      const current = await this.#repository.read();
      assertExpectedRevision(current.revision, input?.expectedRevision);
      const existing = current.data.versions.find((entry) => entry.skillId === skillId && entry.version === versionLabel);
      if (existing) {
        invariant(existing.sha256 === sha256, "SKILL_VERSION_IMMUTABLE", "相同 Skill 版本已经存在，内容不能覆盖", {
          status: 409,
          details: { skillId, version: versionLabel, existingSha256: existing.sha256 },
        });
        return {
          revision: current.revision,
          duplicate: true,
          version: clone(existing),
          registry: clone(current.data.registries.find((entry) => entry.skillId === skillId)),
        };
      }

      const relativeRoot = packageRelativeRoot(skillId, versionLabel);
      const finalRoot = this.#actorPath(relativeRoot);
      const descriptor = packageDescriptor(skillId, versionLabel, sha256, manifest, files);
      let packageCreated = false;
      try {
        const existingPackage = JSON.parse(await fs.readFile(path.join(finalRoot, "package.json"), "utf8"));
        invariant(existingPackage.sha256 === sha256, "SKILL_PACKAGE_PATH_CONFLICT", "Skill 包目录已被不同内容占用", { status: 409 });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const written = await writePackageDirectory(finalRoot, descriptor, files, {
          fileSystem: this.packageFileSystem,
          sleep: this.packageCommitSleep,
        });
        packageCreated = written.created;
      }

      let skillVersion;
      let registry;
      try {
        const result = await this.#repository.update((store) => {
          skillVersion = createSkillVersion({
            id: this.#newId("skill_version"),
            actorId: this.actor.actorId,
            skillId,
            version: versionLabel,
            sha256,
            packagePath: `${relativeRoot}/package.json`,
            manifest,
          }, { clock: this.clock });
          const registryIndex = store.registries.findIndex((entry) => entry.skillId === skillId);
          if (registryIndex < 0) {
            registry = createSkillRegistry({
              id: this.#newId("skill_registry"),
              actorId: this.actor.actorId,
              skillId,
              displayName: manifest.name,
              description: manifest.description,
            }, { clock: this.clock });
            registry = registerSkillVersion(registry, skillVersion, { expectedRevision: registry.revision, activate: input?.activate !== false, clock: this.clock });
            store.registries.push(registry);
          } else {
            registry = registerSkillVersion(store.registries[registryIndex], skillVersion, {
              expectedRevision: store.registries[registryIndex].revision,
              activate: input?.activate !== false,
              clock: this.clock,
            });
            store.registries[registryIndex] = registry;
          }
          store.versions.push(skillVersion);
        }, { expectedRevision: current.revision, clock: this.clock });
        return { revision: result.revision, duplicate: false, version: clone(skillVersion), registry: clone(registry) };
      } catch (error) {
        if (packageCreated) await fs.rm(finalRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async activateVersion(input) {
    return this.#mutate(async () => {
      const skillId = assertSegment(String(input?.skillId || ""), "skillId");
      const versionLabel = assertSegment(String(input?.version || ""), "version");
      let registry;
      const result = await this.#repository.update((store) => {
        const registryIndex = store.registries.findIndex((entry) => entry.skillId === skillId);
        invariant(registryIndex >= 0, "SKILL_REGISTRY_NOT_FOUND", "Skill 不存在", { status: 404 });
        const skillVersion = store.versions.find((entry) => entry.skillId === skillId && entry.version === versionLabel);
        invariant(skillVersion, "SKILL_VERSION_NOT_FOUND", "Skill 版本不存在", { status: 404 });
        registry = activateSkillVersion(store.registries[registryIndex], skillVersion.id, {
          expectedRevision: store.registries[registryIndex].revision,
          clock: this.clock,
        });
        store.registries[registryIndex] = registry;
      }, { expectedRevision: input?.expectedRevision, clock: this.clock });
      return { revision: result.revision, registry: clone(registry) };
    });
  }

  async pinTask(input) {
    return this.#mutate(async () => {
      const taskId = assertId(String(input?.taskId || ""), "taskId");
      await this.#authorizeTask(taskId, "write");
      invariant(Array.isArray(input?.skills) && input.skills.length <= 256, "SKILL_SELECTION_INVALID", "Task Skill 选择无效", { status: 400 });
      const current = await this.#repository.read();
      assertExpectedRevision(current.revision, input?.expectedRevision);
      const selections = input.skills.map((selection) => {
        invariant(selection && typeof selection === "object" && !Array.isArray(selection), "SKILL_SELECTION_INVALID", "Task Skill 选择无效", { status: 400 });
        invariant(Object.keys(selection).every((key) => ["skillId", "version", "mandatory"].includes(key)), "SKILL_SELECTION_INVALID", "Task Skill 选择包含未知字段", { status: 400 });
        const skillId = assertSegment(String(selection.skillId || ""), "skillId");
        const registry = current.data.registries.find((entry) => entry.skillId === skillId);
        invariant(registry, "SKILL_REGISTRY_NOT_FOUND", "Skill 不存在", { status: 404, details: { skillId } });
        const skillVersion = selection.version
          ? current.data.versions.find((entry) => entry.skillId === skillId && entry.version === assertSegment(String(selection.version), "version"))
          : current.data.versions.find((entry) => entry.id === registry.activeVersionId);
        invariant(skillVersion, "SKILL_ACTIVE_VERSION_REQUIRED", "Skill 没有可固定的活动版本", { status: 409, details: { skillId } });
        return { skillVersion, mandatory: selection.mandatory !== false };
      });
      invariant(new Set(selections.map((entry) => entry.skillVersion.skillId)).size === selections.length, "SKILL_SELECTION_DUPLICATE", "Task 不能重复选择同一 Skill", { status: 400 });

      const existingPins = current.data.taskPins.filter((entry) => entry.taskId === taskId);
      if (existingPins.length > 0) {
        const expected = selections.map((entry) => `${entry.skillVersion.id}:${entry.mandatory}`).sort();
        const actual = existingPins.map((entry) => `${entry.skillVersionId}:${entry.mandatory}`).sort();
        invariant(JSON.stringify(actual) === JSON.stringify(expected), "SKILL_TASK_PINS_IMMUTABLE", "Task 的 Skill 版本已经固定，不能替换", { status: 409 });
        return {
          revision: current.revision,
          duplicate: true,
          pins: clone(existingPins),
          taskSkillPins: existingPins.map(({ skillId, version, sha256 }) => ({ skillId, version, sha256 })),
        };
      }

      const pins = selections.map(({ skillVersion, mandatory }) => createTaskSkillPin({
        id: this.#newId("task_skill_pin"),
        actorId: this.actor.actorId,
        taskId,
        skillVersion,
        mandatory,
      }, { clock: this.clock }));
      const result = await this.#repository.update((store) => {
        store.taskPins.push(...pins);
      }, { expectedRevision: current.revision, clock: this.clock });
      return {
        revision: result.revision,
        duplicate: false,
        pins: clone(pins),
        taskSkillPins: pins.map(({ skillId, version, sha256 }) => ({ skillId, version, sha256 })),
      };
    });
  }

  async releaseTaskPins(input) {
    return this.#mutate(async () => {
      const taskId = assertId(String(input?.taskId || ""), "taskId");
      await this.#authorizeTask(taskId, "delete");
      const result = await this.#repository.update((store) => {
        store.taskPins = store.taskPins.filter((entry) => entry.taskId !== taskId);
      }, { expectedRevision: input?.expectedRevision, clock: this.clock });
      return { revision: result.revision, taskId };
    });
  }

  async deleteVersion(input) {
    return this.#mutate(async () => {
      const skillId = assertSegment(String(input?.skillId || ""), "skillId");
      const versionLabel = assertSegment(String(input?.version || ""), "version");
      const current = await this.#repository.read();
      assertExpectedRevision(current.revision, input?.expectedRevision);
      const skillVersion = current.data.versions.find((entry) => entry.skillId === skillId && entry.version === versionLabel);
      invariant(skillVersion, "SKILL_VERSION_NOT_FOUND", "Skill 版本不存在", { status: 404 });
      const pin = current.data.taskPins.find((entry) => entry.skillVersionId === skillVersion.id);
      invariant(!pin, "SKILL_VERSION_PINNED", "该 Skill 版本仍被 Task 固定，不能删除", {
        status: 409,
        details: pin ? { taskId: pin.taskId, skillId, version: versionLabel } : undefined,
      });
      const result = await this.#repository.update((store) => {
        const registryIndex = store.registries.findIndex((entry) => entry.skillId === skillId);
        invariant(registryIndex >= 0, "SKILL_REGISTRY_NOT_FOUND", "Skill 不存在", { status: 404 });
        const nextRegistry = removeVersionFromRegistry(store.registries[registryIndex], skillVersion.id, {
          expectedRevision: store.registries[registryIndex].revision,
          clock: this.clock,
        });
        store.versions = store.versions.filter((entry) => entry.id !== skillVersion.id);
        if (nextRegistry.versions.length === 0) store.registries.splice(registryIndex, 1);
        else store.registries[registryIndex] = nextRegistry;
      }, { expectedRevision: current.revision, clock: this.clock });
      await fs.rm(this.#actorPath(packageRelativeRoot(skillId, versionLabel)), { recursive: true, force: true });
      return { revision: result.revision, skillId, version: versionLabel };
    });
  }

  async #loadVerifiedPackage(skillVersion) {
    const packagePath = this.#actorPath(skillVersion.packagePath);
    const descriptor = JSON.parse(await fs.readFile(packagePath, "utf8"));
    invariant(
      descriptor?.schemaVersion === PACKAGE_SCHEMA_VERSION
      && descriptor.skillId === skillVersion.skillId
      && descriptor.version === skillVersion.version
      && descriptor.sha256 === skillVersion.sha256
      && Array.isArray(descriptor.files),
      "SKILL_PACKAGE_CORRUPT",
      "Skill package.json 与登记版本不一致",
      { status: 500, expose: false },
    );
    invariant(
      Object.keys(descriptor).length === 6
      && ["schemaVersion", "skillId", "version", "sha256", "manifest", "files"].every((key) => Object.hasOwn(descriptor, key)),
      "SKILL_PACKAGE_CORRUPT",
      "Skill package.json 字段无效",
      { status: 500, expose: false },
    );
    const manifest = normalizeManifest(descriptor.manifest);
    invariant(JSON.stringify(manifest) === JSON.stringify(skillVersion.manifest), "SKILL_PACKAGE_CORRUPT", "Skill manifest 与登记版本不一致", {
      status: 500,
      expose: false,
    });
    const root = path.dirname(packagePath);
    const files = [];
    const seen = new Set();
    for (const entry of descriptor.files) {
      invariant(entry && typeof entry === "object" && Object.keys(entry).length === 3 && ["path", "size", "sha256"].every((key) => Object.hasOwn(entry, key)), "SKILL_PACKAGE_CORRUPT", "Skill 文件描述无效", {
        status: 500,
        expose: false,
      });
      const relativePath = assertRelativeFilePath(entry.path, "package.files[].path");
      invariant(!seen.has(relativePath), "SKILL_PACKAGE_CORRUPT", "Skill package.json 包含重复路径", { status: 500, expose: false });
      seen.add(relativePath);
      const sourceRelativePath = `${packageRelativeRoot(skillVersion.skillId, skillVersion.version)}/files/${relativePath}`;
      const sourcePath = this.#actorPath(sourceRelativePath);
      const content = await fs.readFile(sourcePath);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      invariant(sha256 === entry.sha256 && content.length === entry.size, "SKILL_PACKAGE_FILE_CORRUPT", "Skill 包文件校验失败", {
        status: 500,
        expose: false,
        details: { skillId: skillVersion.skillId, version: skillVersion.version, path: relativePath },
      });
      invariant(sourcePath.startsWith(`${root}${path.sep}`), "SKILL_PACKAGE_FILE_ESCAPE", "Skill 包文件越界", { status: 500, expose: false });
      files.push({ relativePath, sourceRelativePath, sha256, size: content.length, content });
    }
    invariant(files.some((file) => file.relativePath === manifest.entrypoint), "SKILL_PACKAGE_CORRUPT", "Skill entrypoint 文件不存在", { status: 500, expose: false });
    const calculated = hashPackage(skillVersion.skillId, skillVersion.version, manifest, files.map((file) => ({ path: file.relativePath, content: file.content })));
    invariant(calculated === skillVersion.sha256, "SKILL_PACKAGE_HASH_MISMATCH", "Skill 版本内容哈希校验失败", { status: 500, expose: false });
    return {
      descriptor,
      files: files.map((file) => ({
        relativePath: file.relativePath,
        sourceRelativePath: file.sourceRelativePath,
        sha256: file.sha256,
        size: file.size,
        content: Buffer.from(file.content),
      })),
    };
  }

  async createDeploymentPlan(input) {
    const taskId = assertId(String(input?.taskId || ""), "taskId");
    await this.#authorizeTask(taskId, "read");
    const snapshot = await this.#repository.read();
    const storedPins = snapshot.data.taskPins.filter((entry) => entry.taskId === taskId);
    invariant(storedPins.length > 0 || (input?.pins || []).length === 0, "SKILL_TASK_PINS_REQUIRED", "Task Skill 尚未固定", { status: 409 });
    const requestedPins = input?.pins || storedPins.map(({ skillId, version, sha256 }) => ({ skillId, version, sha256 }));
    invariant(Array.isArray(requestedPins), "SKILL_PINS_INVALID", "Skill pins 无效", { status: 400 });
    const requestedKeys = requestedPins.map((pin) => `${pin.skillId}:${pin.version}:${pin.sha256}`).sort();
    const storedKeys = storedPins.map((pin) => `${pin.skillId}:${pin.version}:${pin.sha256}`).sort();
    invariant(JSON.stringify(requestedKeys) === JSON.stringify(storedKeys), "SKILL_PIN_SET_MISMATCH", "部署 Skill 必须与 Task 固定版本集合完全一致", { status: 409 });
    const remoteHashes = input?.remoteHashes && typeof input.remoteHashes === "object" ? input.remoteHashes : {};
    const skills = [];
    for (const pin of requestedPins) {
      const skillId = assertSegment(String(pin.skillId || ""), "skillId");
      const versionLabel = assertSegment(String(pin.version || ""), "version");
      const sha256 = String(pin.sha256 || "");
      invariant(/^[a-f0-9]{64}$/.test(sha256), "SKILL_PIN_HASH_INVALID", "Skill pin sha256 无效", { status: 400 });
      const storedPin = storedPins.find((entry) => entry.skillId === skillId);
      invariant(storedPin && storedPin.version === versionLabel && storedPin.sha256 === sha256, "SKILL_PIN_MISMATCH", "调用的 Skill 与 Task 固定版本不一致", {
        status: 409,
        details: { skillId, version: versionLabel },
      });
      const skillVersion = snapshot.data.versions.find((entry) => entry.id === storedPin.skillVersionId);
      invariant(skillVersion, "SKILL_VERSION_NOT_FOUND", "Task 固定的 Skill 版本不存在", { status: 500, expose: false });
      const verified = await this.#loadVerifiedPackage(skillVersion);
      const targetRoot = remoteRoot(skillId, versionLabel);
      const files = verified.files.map((file) => {
        const targetPath = `${targetRoot}/${file.relativePath}`;
        const upToDate = remoteHashes[targetPath] === file.sha256;
        return {
          relativePath: file.relativePath,
          source: { actorRelativePath: file.sourceRelativePath, sha256: file.sha256, size: file.size },
          target: { path: targetPath, expectedSha256: file.sha256 },
          status: upToDate ? "up-to-date" : "upload-required",
        };
      });
      skills.push({
        skillId,
        version: versionLabel,
        sha256,
        targetRoot,
        entrypoint: `${targetRoot}/${skillVersion.manifest.entrypoint}`,
        files,
        operations: files.filter((file) => file.status === "upload-required").map((file) => ({
          kind: "verify-or-upload",
          source: clone(file.source),
          target: clone(file.target),
        })),
      });
    }
    return {
      schemaVersion: 1,
      taskId,
      actorId: this.actor.actorId,
      remoteBase: "~/.easywork/skills",
      skills,
      agentSkillRefs: skills.map(({ skillId, version, sha256, entrypoint }) => ({ skillId, version, sha256, entrypoint })),
    };
  }

  async prepare({ task, pins, remoteHashes = {} }) {
    invariant(task?.actorId === this.actor.actorId, "SKILL_TASK_ACTOR_MISMATCH", "Task 不属于当前 Actor", { status: 403 });
    return this.createDeploymentPlan({ taskId: task.id, pins, remoteHashes });
  }
}

export const skillServiceConstants = Object.freeze({
  packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
  storeSchemaVersion: SKILL_STORE_SCHEMA_VERSION,
  remoteBase: "~/.easywork/skills",
});
