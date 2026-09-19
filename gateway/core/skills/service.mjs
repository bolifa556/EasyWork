import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { requireAuthenticatedActor } from "../actor.mjs";
import { invariant } from "../errors.mjs";
import { createInstalledSkill, validateInstalledSkill } from "../entities/skill.mjs";
import { revisedHeader } from "../entities/common.mjs";
import { ActorMutationQueue } from "../mutation-queue.mjs";
import { assertActorOwnedPath, resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { assertExpectedRevision } from "../revision.mjs";
import { DEFAULT_SKILL_APPLICABILITY, normalizeSkillApplicability } from "./applicability.mjs";
import { normalizeNativeSkillFiles, restoreOriginalSkillFiles } from "./native-package.mjs";
import { recoverSkillPackageEdit, replaceSkillPackage, removeSkillDirectory, skillStoragePath } from "./package-storage.mjs";

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
  return { skills: [] };
}

function defaultApplicabilityStore(actorId) {
  return { actorId, items: [] };
}

function validateApplicabilityStore(store, actorId) {
  if (!store || typeof store !== "object" || Array.isArray(store) || store.actorId !== actorId || !Array.isArray(store.items)) return false;
  if (Object.keys(store).length !== 2) return false;
  const seen = new Set();
  try {
    return store.items.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).length === 3
      && typeof entry.skillId === "string" && !seen.has(entry.skillId) && seen.add(entry.skillId)
      && Boolean(normalizeSkillApplicability(entry.applicability))
      && Number.isFinite(Date.parse(entry.updatedAt)));
  } catch { return false; }
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

function hashPackage(skillId, manifest, files) {
  const hash = crypto.createHash("sha256");
  const feed = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(Buffer.from(`${buffer.length}:`));
    hash.update(buffer);
  };
  feed(skillId);
  feed(JSON.stringify(manifest));
  for (const file of files) {
    feed(file.path);
    feed(file.content);
  }
  return hash.digest("hex");
}

function packageRelativeRoot(skillId) {
  return `skills/packages/${skillId}/.installed`;
}

function packageDescriptor(skillId, sha256, manifest, files) {
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    skillId,
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
  // Read-only compatibility boundary for installations created before the flat catalog.
  if (Array.isArray(store.registries) && Array.isArray(store.versions) && Array.isArray(store.taskPins)) {
    invariant([...store.registries, ...store.versions, ...store.taskPins].every((entry) => entry.actorId === actorId), "SKILL_ACTOR_MISMATCH", "技能不属于当前用户", { status: 403 });
    return true;
  }
  invariant(Object.keys(store).length === 1 && Array.isArray(store.skills), "SKILL_STORE_INVALID", "Skill 索引结构无效", { status: 500, expose: false });
  const ids = new Set();
  for (const skill of store.skills) {
    validateInstalledSkill(skill);
    invariant(skill.actorId === actorId, "SKILL_ACTOR_MISMATCH", "技能不属于当前用户", { status: 403 });
    invariant(!ids.has(skill.skillId), "SKILL_DUPLICATE", "同一技能只能安装一份", { status: 500, expose: false });
    ids.add(skill.skillId);
  }
  return true;
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
    // lock instead of exposing a half-created Skill package to the registry.
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
      // an installed package and is removed by the retry path above.
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

function remoteRoot(skillId) {
  return `~/.easywork/skills/${skillId}`;
}

export class SkillService {
  #repository;
  #applicabilityRepository;
  #deploymentRepository;

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
    this.#applicabilityRepository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: "skills/applicability.json",
      schemaVersion: 1,
      defaultData: () => defaultApplicabilityStore(this.actor.actorId),
      validate: (store) => validateApplicabilityStore(store, this.actor.actorId),
      queue: inlineRepositoryQueue,
    });
    this.#deploymentRepository = new AtomicJsonRepository({
      dataRoot: this.dataRoot, actor: this.actor, relativePath: "skills/market-deployments.json", schemaVersion: 1,
      defaultData: () => ({ items: [] }), queue: inlineRepositoryQueue,
      validate: (store) => store && Object.keys(store).length === 1 && Array.isArray(store.items)
        && new Set(store.items.map((entry) => entry.marketSkillId)).size === store.items.length
        && store.items.every((entry) => entry && Object.keys(entry).length === 2
          && ["marketSkillId", "deploymentId"].every((field) => typeof entry[field] === "string" && SAFE_SEGMENT_PATTERN.test(entry[field]))),
    });
  }

  async #applicabilityBySkill() {
    const snapshot = await this.#applicabilityRepository.read();
    return new Map(snapshot.data.items.map((entry) => [entry.skillId, normalizeSkillApplicability(entry.applicability)]));
  }

  #newId(kind) {
    return assertId(String(this.idFactory(kind)), `${kind}Id`);
  }

  #actorPath(relativePath) {
    return assertActorOwnedPath(this.dataRoot, this.actor, resolveActorPath(this.dataRoot, this.actor, relativePath));
  }

  async #readStore() {
    return this.mutationQueue.run(this.actor, async () => {
      await recoverSkillPackageEdit(this.#actorPath("skills"), (relativeRoot) => this.#expectedPackageHash(relativeRoot));
      const snapshot = await this.#repository.read();
      if (Array.isArray(snapshot.data.skills)) return snapshot;
      const skills = [];
      for (const registry of snapshot.data.registries) {
        const legacy = snapshot.data.versions.find((entry) => entry.id === registry.activeVersionId);
        if (!legacy) continue;
        const verified = await this.#loadVerifiedPackage(legacy, { legacy: true });
        const manifest = normalizeManifest({ ...legacy.manifest, name: registry.displayName, description: registry.description });
        const files = verified.files.map((entry) => ({ path: entry.relativePath, content: entry.content }));
        const sha256 = hashPackage(legacy.skillId, manifest, files);
        const relativeRoot = packageRelativeRoot(legacy.skillId);
        await writePackageDirectory(this.#actorPath(relativeRoot), packageDescriptor(legacy.skillId, sha256, manifest, files), files,
          { fileSystem: this.packageFileSystem, sleep: this.packageCommitSleep });
        skills.push({ ...createInstalledSkill({ id: registry.id, actorId: this.actor.actorId, skillId: legacy.skillId,
          sha256, packagePath: relativeRoot + "/package.json", manifest }, { clock: this.clock }),
          createdAt: registry.createdAt, updatedAt: registry.updatedAt, installedAt: legacy.installedAt });
      }
      const migrated = await this.#repository.replace({ skills }, { expectedRevision: snapshot.revision, clock: this.clock });
      await this.#collectPackages(migrated.data);
      return migrated;
    });
  }

  async #mutate(operation) {
    return this.mutationQueue.run(this.actor, operation);
  }

  async #expectedPackageHash(relativeRoot) {
    const snapshot = await this.#repository.read();
    const entries = snapshot.data.skills || snapshot.data.versions;
    return entries.find((entry) => entry.packagePath === "skills/" + relativeRoot + "/package.json")?.sha256 || null;
  }

  async #collectPackages(store, dryRun = false) {
    const root = this.#actorPath("skills");
    const packages = await skillStoragePath(root, "packages");
    const referenced = new Set(store.skills.map((entry) => path.posix.dirname(entry.packagePath).slice("skills/".length)));
    const directories = await fs.readdir(packages, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const obsolete = [];
    for (const entry of directories) {
      const relativeRoot = `packages/${entry.name}`;
      const directory = await skillStoragePath(root, relativeRoot);
      if (![...referenced].some((value) => value.startsWith(`${relativeRoot}/`))) obsolete.push(relativeRoot);
      else if (entry.isDirectory()) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const candidate = `${relativeRoot}/${entry.name}`;
          if (!referenced.has(candidate)) obsolete.push(candidate);
        }
      }
    }
    for (const candidate of obsolete) {
      await skillStoragePath(root, candidate);
      if (!dryRun) await removeSkillDirectory(root, candidate);
    }
    return obsolete;
  }

  async cleanupStorage({ dryRun = true } = {}) {
    return this.#mutate(async () => {
      // A preview must not migrate the index, recover transactions or delete packages.
      const snapshot = dryRun ? await this.#repository.read() : await this.#readStore();
      const legacy = !Array.isArray(snapshot.data.skills);
      const skills = legacy ? snapshot.data.registries.flatMap((registry) => {
        const skill = snapshot.data.versions.find((entry) => entry.id === registry.activeVersionId);
        return skill ? [skill] : [];
      }) : snapshot.data.skills;
      const skillIds = new Set(skills.map((entry) => entry.skillId));
      const applicability = await this.#applicabilityRepository.read();
      const removedApplicability = applicability.data.items.filter((entry) => !skillIds.has(entry.skillId)).map((entry) => entry.skillId);
      const repairs = [];
      for (const skill of skills) {
        const verified = await this.#loadVerifiedPackage(skill, { legacy });
        const files = verified.files.map((file) => ({ path: file.relativePath, content: file.content }));
        const restored = restoreOriginalSkillFiles({ skillId: skill.skillId, ...skill.manifest, files });
        if (restored.length < files.length) repairs.push({ skill, files: restored });
      }
      const removedPackages = await this.#collectPackages({ skills }, dryRun);
      if (!dryRun) {
        if (removedApplicability.length) await this.#applicabilityRepository.update((store) => {
          store.items = store.items.filter((entry) => skillIds.has(entry.skillId));
        }, { expectedRevision: applicability.revision, clock: this.clock });
        for (const { skill, files } of repairs) await this.#saveInstalledPackage(await this.#readStore(), skill, skill.manifest, normalizeFiles(files, this));
      }
      return { dryRun, removedPackages, retainedPackages: skills.map((entry) => entry.packagePath), removedApplicability,
        restoredSources: repairs.map(({ skill }) => ({ skillId: skill.skillId, path: skill.manifest.entrypoint })) };
    });
  }

  async #authorizeTask(taskId, action) {
    assertId(taskId, "taskId");
    const allowed = await this.authorizeTask({ actor: this.actor, taskId, action });
    invariant(allowed !== false, "SKILL_TASK_FORBIDDEN", "当前 Actor 无权操作该 Task", { status: 403, details: { taskId, action } });
  }

  async inspect() {
    return this.#readStore();
  }

  async listInstalled() {
    const [snapshot, applicability] = await Promise.all([this.#readStore(), this.#applicabilityBySkill()]);
    return { revision: snapshot.revision, items: snapshot.data.skills.map((skill) => ({
      id: skill.id, skillId: skill.skillId, name: skill.manifest.name, description: skill.manifest.description,
      updatedAt: skill.updatedAt, revision: snapshot.revision,
      applicability: applicability.get(skill.skillId) || clone(DEFAULT_SKILL_APPLICABILITY),
    })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
  }

  async listInstalledKnowledge() {
    // The installed package already carries the uploaded/market description.
    // Reuse it for discovery instead of creating a second per-user summary.
    return this.#mutate(async () => {
      const installed = await this.listInstalled();
      const snapshot = await this.#readStore();
      const skills = new Map(snapshot.data.skills.map((skill) => [skill.skillId, skill]));
      return { ...installed, items: installed.items.map((entry) => ({ ...entry,
        knowledge: { key: "skill:" + entry.skillId, version: skills.get(entry.skillId).sha256 },
      })) };
    });
  }

  async getInstalledDetail(skillIdInput) {
    return this.#mutate(() => this.#getInstalledDetail(skillIdInput));
  }

  async #getInstalledDetail(skillIdInput) {
    const skillId = assertSegment(String(skillIdInput || ""), "skillId");
    const [snapshot, applicability] = await Promise.all([this.#readStore(), this.#applicabilityBySkill()]);
    const registry = snapshot.data.skills.find((entry) => entry.skillId === skillId);
    invariant(registry, "SKILL_REGISTRY_NOT_FOUND", "技能不存在", { status: 404 });
    const verified = await this.#loadVerifiedPackage(registry);
    let remainingBytes = MAX_SKILL_SEARCH_TOTAL_BYTES;
    const files = verified.files.map((file) => {
      const binary = file.content.includes(0);
      const previewBytes = binary ? 0 : Math.min(file.content.length, MAX_SKILL_SEARCH_FILE_BYTES, remainingBytes);
      const content = binary ? null : file.content.subarray(0, previewBytes).toString("utf8");
      remainingBytes -= previewBytes;
      return {
        path: file.relativePath,
        size: file.size,
        sha256: file.sha256,
        binary,
        content,
        truncated: !binary && previewBytes < file.content.length,
      };
    });
    return {
      id: registry.id,
      skillId: registry.skillId,
      name: registry.manifest.name,
      description: registry.manifest.description,
      updatedAt: registry.updatedAt,
      revision: snapshot.revision,
      applicability: applicability.get(registry.skillId) || clone(DEFAULT_SKILL_APPLICABILITY),
      entrypoint: registry.manifest.entrypoint,
      primaryFile: registry.manifest.entrypoint,
      files,
    };
  }

  async createInstalled(input) {
    requireAuthenticatedActor(this.actor);
    const command = assertId(input?.commandId, "commandId");
    const skillId = `personal_${crypto.createHash("sha256").update(command).digest("hex").slice(0, 32)}`;
    const files = normalizeFiles(input?.files, this);
    const entrypoint = files.find((file) => file.path === "SKILL.md")?.path
      || files.find((file) => /(?:^|\/)SKILL\.md$/i.test(file.path))?.path
      || files.find((file) => /(?:^|\/)README(?:\.[^/]+)?$/i.test(file.path))?.path
      || files[0].path;
    return this.installPackage({
      skillId,
      manifest: {
        name: typeof input?.name === "string" ? input.name.trim() : input?.name,
        description: typeof input?.description === "string" ? input.description.trim() : input?.description ?? "",
        entrypoint,
        permissions: [],
      },
      files,
    }, { createOnly: true });
  }

  async updateInstalled(skillIdInput, input) {
    return this.#mutate(() => this.#updateInstalled(skillIdInput, input));
  }

  async #updateInstalled(skillIdInput, input) {
    requireAuthenticatedActor(this.actor);
    const skillId = assertSegment(String(skillIdInput || ""), "skillId");
    const snapshot = await this.#readStore();
    const registry = snapshot.data.skills.find((entry) => entry.skillId === skillId);
    invariant(registry, "SKILL_REGISTRY_NOT_FOUND", "技能不存在", { status: 404 });
    assertExpectedRevision(snapshot.revision, input?.expectedRevision);
    const skill = registry;
    const verified = await this.#loadVerifiedPackage(skill);
    const updates = input?.fileUpdates === undefined ? [] : normalizeFiles(input.fileUpdates, this);
    invariant(updates.every((file) => /\.md$/i.test(file.path) && !file.content.includes(0)), "SKILL_MARKDOWN_UPDATE_INVALID", "只能编辑文本 Markdown 文件", { status: 400 });
    const existingPaths = new Set(verified.files.map((file) => file.relativePath));
    invariant(updates.every((file) => existingPaths.has(file.path)), "SKILL_MARKDOWN_UPDATE_NOT_FOUND", "要编辑的 Markdown 文件不存在", { status: 404 });
    const updateMap = new Map(updates.map((file) => [file.path, file.content]));
    const manifest = normalizeManifest({
      ...skill.manifest,
      name: input?.name === undefined ? registry.manifest.name : typeof input.name === "string" ? input.name.trim() : input.name,
      description: input?.description === undefined ? registry.manifest.description : typeof input.description === "string" ? input.description.trim() : input.description,
    });
    const originalFiles = verified.files.map((file) => ({ path: file.relativePath, content: file.content }));
    const restoredFiles = restoreOriginalSkillFiles({ skillId, ...skill.manifest, files: originalFiles });
    const updatedFiles = originalFiles.map((file) => ({ ...file, content: updateMap.get(file.path) ?? file.content }));
    const files = normalizeFiles(restoredFiles.length < originalFiles.length && updateMap.has(manifest.entrypoint) && !updateMap.has("SKILL.md")
      ? updatedFiles.filter((file) => file.path !== "SKILL.md")
      : restoreOriginalSkillFiles({ skillId, ...skill.manifest, files: updatedFiles }), this);
    // Validate Agent compatibility; its generated SKILL.md belongs to the runtime view.
    normalizeNativeSkillFiles({ skillId, ...manifest, files });
    return this.#saveInstalledPackage(snapshot, skill, manifest, files);
  }

  async #saveInstalledPackage(snapshot, prior, manifest, files) {
    const skillId = prior.skillId;
    const sha256 = hashPackage(skillId, manifest, files);
    const skill = { ...prior, ...revisedHeader(prior, prior.revision, { clock: this.clock }), sha256, manifest };
    const result = await replaceSkillPackage({
      root: this.#actorPath("skills"), relativeRoot: path.posix.dirname(prior.packagePath).slice("skills/".length),
      descriptor: packageDescriptor(skillId, sha256, manifest, files), files,
      readExpectedHash: (relativeRoot) => this.#expectedPackageHash(relativeRoot),
      commit: () => this.#repository.update((store) => { store.skills = store.skills.map((entry) => entry.skillId === skillId ? skill : entry); },
        { expectedRevision: snapshot.revision, clock: this.clock }),
    });
    return { revision: result.revision, duplicate: false, skill: clone(skill) };
  }

  async searchContext(input = {}) {
    return this.#mutate(() => this.#searchContext(input));
  }

  async #searchContext(input = {}) {
    const query = String(input.query || "").trim();
    const terms = queryTerms(query);
    const limit = Math.min(20, Math.max(1, Number(input.limit) || 8));
    const selectedSkillIds = new Set((input.selectedSkillIds || []).map((id) => assertSegment(String(id), "selectedSkillIds[]")));
    const snapshot = await this.#readStore();
    const ranked = snapshot.data.skills.filter((entry) => !selectedSkillIds.size || selectedSkillIds.has(entry.skillId))
      .map((skill) => ({ skill, score: skillSearchScore([skill.skillId, skill.manifest.name, skill.manifest.description, skill.manifest.entrypoint].join("\n"), terms) }))
      .filter(({ skill, score }) => score > 0 || selectedSkillIds.has(skill.skillId))
      .sort((a, b) => b.score - a.score || b.skill.updatedAt.localeCompare(a.skill.updatedAt)).slice(0, limit);

    const results = [];
    let remainingBytes = MAX_SKILL_SEARCH_TOTAL_BYTES;
    for (const { skill, score } of ranked) {
      if (remainingBytes <= 0) break;
      const verified = await this.#loadVerifiedPackage(skill);
      const files = verified.files
        .filter((file) => SEARCHABLE_SKILL_FILE_PATTERN.test(file.relativePath) && !file.content.includes(0))
        .map((file) => {
          const text = file.content.subarray(0, Math.min(file.content.length, MAX_SKILL_SEARCH_FILE_BYTES)).toString("utf8");
          const preferred = file.relativePath === "SKILL.md" ? 100 : file.relativePath === skill.manifest.entrypoint ? 80 : 0;
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
        skillId: skill.skillId,
        sha256: skill.sha256,
        name: skill.manifest.name,
        description: skill.manifest.description,
        entrypoint: skill.manifest.entrypoint,
        permissions: clone(skill.manifest.permissions),
        score,
        files: selectedFiles,
      });
    }
    return results;
  }

  async resolveSkills(fragments = []) {
    return this.#mutate(async () => {
      const snapshot = await this.#readStore();
      const ids = new Set(fragments.map((fragment) => /^skill:(.+)$/.exec(String(fragment?.knowledge?.key || ""))?.[1]).filter(Boolean));
      const result = [];
      for (const skillId of ids) {
        const skill = snapshot.data.skills.find((entry) => entry.skillId === skillId);
        invariant(skill, "SKILL_NOT_INSTALLED", "所选技能已卸载，请重新选择", { status: 404 });
        await this.#loadVerifiedPackage(skill);
        result.push({ skillId, sha256: skill.sha256 });
      }
      return result;
    });
  }

  async uploadPackage(input) {
    return this.#installPackage(input, { requireRevision: true });
  }

  async installPackage(input, { ifAbsent = false, createOnly = false } = {}) {
    return this.#installPackage(input, { ifAbsent, createOnly });
  }

  async #installPackage(input, { ifAbsent = false, requireRevision = false, createOnly = false } = {}) {
    const initialApplicability = input?.applicability === undefined ? null : normalizeSkillApplicability(input.applicability);
    return this.#mutate(async () => {
      const skillId = assertSegment(String(input?.skillId || ""), "skillId");
      const manifest = normalizeManifest(input?.manifest);
      const files = normalizeFiles(input?.files, this);
      normalizeNativeSkillFiles({ skillId, ...manifest, files });
      invariant(files.some((file) => file.path === manifest.entrypoint), "SKILL_ENTRYPOINT_MISSING", "manifest.entrypoint 必须指向包内文件", { status: 400 });
      const snapshot = await this.#readStore();
      const prior = snapshot.data.skills.find((entry) => entry.skillId === skillId);
      if (ifAbsent && prior) return { revision: snapshot.revision, duplicate: true, skill: clone(prior) };
      if (requireRevision) assertExpectedRevision(snapshot.revision, input?.expectedRevision);
      const sha256 = hashPackage(skillId, manifest, files);
      if (prior?.sha256 === sha256) return { revision: snapshot.revision, duplicate: true, skill: clone(prior) };
      invariant(!prior || !createOnly, "SKILL_CREATE_CONFLICT", "同一上传请求不能用于不同内容", { status: 409 });
      if (prior) return this.#saveInstalledPackage(snapshot, prior, manifest, files);
      const relativeRoot = packageRelativeRoot(skillId);
      const written = await writePackageDirectory(this.#actorPath(relativeRoot), packageDescriptor(skillId, sha256, manifest, files), files,
        { fileSystem: this.packageFileSystem, sleep: this.packageCommitSleep });
      const skill = createInstalledSkill({ id: this.#newId("skill"), actorId: this.actor.actorId, skillId, sha256, packagePath: relativeRoot + "/package.json", manifest }, { clock: this.clock });
      let result;
      try { result = await this.#repository.update((store) => { store.skills.push(skill); }, { expectedRevision: snapshot.revision, clock: this.clock }); }
      catch (error) { if (written.created) await removeSkillDirectory(this.#actorPath("skills"), relativeRoot.slice("skills/".length)); throw error; }
      if (initialApplicability) await this.#updateApplicability(skillId, initialApplicability);
      return { revision: result.revision, duplicate: false, skill: clone(skill) };
    });
  }

  async installMarketDeployment(input, { marketSkillId, deploymentId }) {
    assertSegment(marketSkillId, "marketSkillId");
    assertSegment(deploymentId, "deploymentId");
    return this.#mutate(async () => {
      const receipt = await this.#deploymentRepository.read();
      if (receipt.data.items.some((entry) => entry.marketSkillId === marketSkillId && entry.deploymentId === deploymentId)) {
        return { duplicate: true, revision: (await this.#readStore()).revision };
      }
      const result = await this.installPackage(input, { ifAbsent: true });
      // Remember completed distributions even if the user later uninstalls.
      // Retrying a distribution must not overwrite edits or undo that choice.
      await this.#deploymentRepository.update((store) => {
        store.items = store.items.filter((entry) => entry.marketSkillId !== marketSkillId);
        store.items.push({ marketSkillId, deploymentId });
      }, { expectedRevision: receipt.revision, clock: this.clock });
      return result;
    });
  }

  async updateApplicability(skillIdInput, input) {
    return this.#mutate(() => this.#updateApplicability(skillIdInput, input));
  }

  async #updateApplicability(skillIdInput, input) {
    const skillId = assertSegment(String(skillIdInput || ""), "skillId");
    const applicability = normalizeSkillApplicability(input);
    const installed = await this.#readStore();
    invariant(installed.data.skills.some((entry) => entry.skillId === skillId), "SKILL_REGISTRY_NOT_FOUND", "技能不存在", { status: 404 });
    const current = await this.#applicabilityRepository.read();
    const updatedAt = this.clock().toISOString();
    const result = await this.#applicabilityRepository.update((store) => {
      const index = store.items.findIndex((entry) => entry.skillId === skillId);
      const entry = { skillId, applicability, updatedAt };
      if (index >= 0) store.items[index] = entry;
      else store.items.push(entry);
    }, { expectedRevision: current.revision, clock: this.clock });
    return { skillId, applicability: clone(applicability), revision: result.revision, updatedAt };
  }

  async uninstall(input) {
    return this.#mutate(async () => {
      const skillId = assertSegment(String(input?.skillId || ""), "skillId");
      const snapshot = await this.#readStore();
      assertExpectedRevision(snapshot.revision, input?.expectedRevision);
      invariant(snapshot.data.skills.some((entry) => entry.skillId === skillId), "SKILL_REGISTRY_NOT_FOUND", "技能不存在", { status: 404 });
      const result = await this.#repository.update((store) => { store.skills = store.skills.filter((entry) => entry.skillId !== skillId); }, { expectedRevision: snapshot.revision, clock: this.clock });
      await removeSkillDirectory(this.#actorPath("skills"), "packages/" + skillId);
      const applicability = await this.#applicabilityRepository.read();
      await this.#applicabilityRepository.update((store) => { store.items = store.items.filter((entry) => entry.skillId !== skillId); }, { expectedRevision: applicability.revision, clock: this.clock });
      return { revision: result.revision, skillId };
    });
  }

  async #loadVerifiedPackage(skill, { legacy = false } = {}) {
    const packagePath = this.#actorPath(skill.packagePath);
    const descriptor = JSON.parse(await fs.readFile(packagePath, "utf8"));
    invariant(
      descriptor?.schemaVersion === PACKAGE_SCHEMA_VERSION
      && descriptor.skillId === skill.skillId
      && descriptor.sha256 === skill.sha256
      && Array.isArray(descriptor.files),
      "SKILL_PACKAGE_CORRUPT",
      "Skill package.json 与登记内容不一致",
      { status: 500, expose: false },
    );
    invariant(
      Object.keys(descriptor).length === (legacy ? 6 : 5)
      && ["schemaVersion", "skillId", "sha256", "manifest", "files"].every((key) => Object.hasOwn(descriptor, key)),
      "SKILL_PACKAGE_CORRUPT",
      "Skill package.json 字段无效",
      { status: 500, expose: false },
    );
    const manifest = normalizeManifest(descriptor.manifest);
    invariant(JSON.stringify(manifest) === JSON.stringify(skill.manifest), "SKILL_PACKAGE_CORRUPT", "Skill manifest 与登记内容不一致", {
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
      const sourceRelativePath = `${path.posix.dirname(skill.packagePath)}/files/${relativePath}`;
      const sourcePath = this.#actorPath(sourceRelativePath);
      const content = await fs.readFile(sourcePath);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      invariant(sha256 === entry.sha256 && content.length === entry.size, "SKILL_PACKAGE_FILE_CORRUPT", "Skill 包文件校验失败", {
        status: 500,
        expose: false,
        details: { skillId: skill.skillId, path: relativePath },
      });
      invariant(sourcePath.startsWith(`${root}${path.sep}`), "SKILL_PACKAGE_FILE_ESCAPE", "Skill 包文件越界", { status: 500, expose: false });
      files.push({ relativePath, sourceRelativePath, sha256, size: content.length, content });
    }
    invariant(files.some((file) => file.relativePath === manifest.entrypoint), "SKILL_PACKAGE_CORRUPT", "Skill entrypoint 文件不存在", { status: 500, expose: false });
    let calculated;
    if (legacy) {
      const digest = crypto.createHash("sha256");
      const feed = (value) => { const bytes = Buffer.from(value); digest.update(Buffer.from(bytes.length + ":")); digest.update(bytes); };
      feed(skill.skillId); feed(skill.version); feed(JSON.stringify(manifest));
      for (const file of files) { feed(file.relativePath); feed(file.content); }
      calculated = digest.digest("hex");
    } else calculated = hashPackage(skill.skillId, manifest, files.map((file) => ({ path: file.relativePath, content: file.content })));
    invariant(calculated === skill.sha256, "SKILL_PACKAGE_HASH_MISMATCH", "Skill 内容哈希校验失败", { status: 500, expose: false });
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
    return this.#mutate(() => this.#createDeploymentPlan(input));
  }

  async #createDeploymentPlan(input) {
    const taskId = assertId(String(input?.taskId || ""), "taskId");
    await this.#authorizeTask(taskId, "read");
    const snapshot = await this.#readStore();
    const selections = input?.skills || input?.pins || [];
    invariant(Array.isArray(selections), "SKILL_SELECTION_INVALID", "Skill 选择无效", { status: 400 });
    const ids = [...new Set(selections.map((entry) => assertSegment(String(entry.skillId || ""), "skillId")))];
    const remoteHashes = input?.remoteHashes && typeof input.remoteHashes === "object" ? input.remoteHashes : {};
    const skills = [];
    for (const skillId of ids) {
      const skill = snapshot.data.skills.find((entry) => entry.skillId === skillId);
      invariant(skill, "SKILL_NOT_INSTALLED", "所选技能已卸载，请重新选择", { status: 404 });
      const verified = await this.#loadVerifiedPackage(skill);
      const sha256 = skill.sha256;
      const targetRoot = remoteRoot(skillId);
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
        sha256,
        manifest: clone(skill.manifest),
        targetRoot,
        entrypoint: `${targetRoot}/${skill.manifest.entrypoint}`,
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
      agentSkillRefs: skills.map(({ skillId, sha256, entrypoint }) => ({ skillId, sha256, entrypoint })),
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
