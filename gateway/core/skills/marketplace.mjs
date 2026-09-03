import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { requireAuthenticatedActor, requireRole } from "../actor.mjs";
import { invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { atomicWriteJson } from "../repository.mjs";
import { assertExpectedRevision } from "../revision.mjs";
import { DEFAULT_SKILL_APPLICABILITY, normalizeSkillApplicability } from "./applicability.mjs";

const STORE_SCHEMA_VERSION = 1;
const PACKAGE_SCHEMA_VERSION = 1;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
const TEXT_PREVIEW_BYTES = 512 * 1024;
const TOTAL_PREVIEW_BYTES = 2 * 1024 * 1024;
const GLOBAL_QUEUE_ACTOR = Object.freeze({ actorType: "platform", actorId: "skill-center" });

function clone(value) {
  return structuredClone(value);
}

function defaultStore() {
  return { submissions: [], market: [] };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSegment(value, field) {
  invariant(typeof value === "string" && SAFE_SEGMENT_PATTERN.test(value), "SKILL_CENTER_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return value;
}

function assertRelativeFilePath(value, field = "file.path") {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 4096, "SKILL_FILE_PATH_INVALID", `${field} 无效`, { status: 400 });
  invariant(!value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value), "SKILL_FILE_PATH_INVALID", `${field} 必须是相对路径`, { status: 400 });
  const segments = value.split("/");
  invariant(segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\0")), "SKILL_FILE_PATH_INVALID", `${field} 包含非法路径片段`, { status: 400 });
  invariant(value !== "package.json", "SKILL_FILE_PATH_RESERVED", "package.json 是 EasyWork 保留路径", { status: 400 });
  return value;
}

function normalizedText(value, field, maxLength, { required = false } = {}) {
  invariant(typeof value === "string", "SKILL_CENTER_TEXT_INVALID", `${field} 必须是文本`, { status: 400 });
  const result = value.trim();
  invariant((!required || result.length > 0) && result.length <= maxLength, "SKILL_CENTER_TEXT_INVALID", `${field} 无效`, { status: 400 });
  return result;
}

function normalizeFiles(input, limits) {
  invariant(Array.isArray(input) && input.length > 0 && input.length <= limits.maxFiles, "SKILL_FILES_INVALID", "技能文件数量无效", {
    status: 400,
    details: { maxFiles: limits.maxFiles },
  });
  const seen = new Set();
  let totalBytes = 0;
  return input.map((entry, index) => {
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), "SKILL_FILE_INVALID", `files[${index}] 无效`, { status: 400 });
    invariant(Object.keys(entry).every((key) => ["path", "content"].includes(key)), "SKILL_FILE_SCHEMA_INVALID", `files[${index}] 字段无效`, { status: 400 });
    const filePath = assertRelativeFilePath(String(entry.path || ""), `files[${index}].path`);
    invariant(!seen.has(filePath), "SKILL_FILE_DUPLICATE", "技能不能包含重复文件路径", { status: 400, details: { path: filePath } });
    seen.add(filePath);
    const content = Buffer.from(String(entry.content ?? ""), "utf8");
    invariant(content.length <= limits.maxFileBytes, "SKILL_FILE_TOO_LARGE", "技能单文件超过大小限制", {
      status: 413,
      details: { path: filePath, maxFileBytes: limits.maxFileBytes },
    });
    totalBytes += content.length;
    invariant(totalBytes <= limits.maxPackageBytes, "SKILL_PACKAGE_TOO_LARGE", "技能包超过大小限制", {
      status: 413,
      details: { maxPackageBytes: limits.maxPackageBytes },
    });
    return { path: filePath, content };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function preferredEntrypoint(files) {
  return files.find((file) => file.path === "SKILL.md")?.path
    || files.find((file) => /(?:^|\/)SKILL\.md$/i.test(file.path))?.path
    || files.find((file) => /(?:^|\/)README(?:\.[^/]+)?$/i.test(file.path))?.path
    || files[0].path;
}

function packageDigest(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(Buffer.from(`${Buffer.byteLength(file.path)}:`));
    hash.update(file.path);
    hash.update(Buffer.from(`${file.content.length}:`));
    hash.update(file.content);
  }
  return hash.digest("hex");
}

function fileDescriptors(files) {
  return files.map((file) => ({
    path: file.path,
    size: file.content.length,
    sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
  }));
}

function validateFiles(files) {
  invariant(Array.isArray(files) && files.length > 0, "SKILL_CENTER_STORE_INVALID", "技能文件索引无效", { status: 500, expose: false });
  const paths = new Set();
  for (const file of files) {
    assertRelativeFilePath(file?.path, "stored file.path");
    invariant(Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256), "SKILL_CENTER_STORE_INVALID", "技能文件索引损坏", { status: 500, expose: false });
    invariant(!paths.has(file.path), "SKILL_CENTER_STORE_INVALID", "技能文件索引重复", { status: 500, expose: false });
    paths.add(file.path);
  }
}

function validateStore(store) {
  invariant(store && typeof store === "object" && !Array.isArray(store), "SKILL_CENTER_STORE_INVALID", "技能中心索引无效", { status: 500, expose: false });
  invariant(Object.keys(store).length === 2 && Array.isArray(store.submissions) && Array.isArray(store.market), "SKILL_CENTER_STORE_INVALID", "技能中心索引结构无效", { status: 500, expose: false });
  const ids = new Set();
  for (const submission of store.submissions) {
    assertSegment(submission.id, "submission.id");
    assertSegment(submission.skillId, "submission.skillId");
    assertSegment(submission.packageId, "submission.packageId");
    invariant(!ids.has(submission.id) && REVIEW_STATUSES.has(submission.status), "SKILL_CENTER_STORE_INVALID", "技能上传记录无效", { status: 500, expose: false });
    invariant(typeof submission.uploaderId === "string" && submission.uploaderId.length > 0, "SKILL_CENTER_STORE_INVALID", "技能上传者无效", { status: 500, expose: false });
    invariant(typeof submission.name === "string" && typeof submission.description === "string", "SKILL_CENTER_STORE_INVALID", "技能上传信息无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(submission.revision) && submission.revision > 0, "SKILL_CENTER_STORE_INVALID", "技能上传 revision 无效", { status: 500, expose: false });
    validateFiles(submission.files);
    ids.add(submission.id);
  }
  for (const item of store.market) {
    assertSegment(item.id, "market.id");
    assertSegment(item.skillId, "market.skillId");
    assertSegment(item.packageId, "market.packageId");
    invariant(!ids.has(item.id), "SKILL_CENTER_STORE_INVALID", "技能中心实体 ID 重复", { status: 500, expose: false });
    invariant(typeof item.name === "string" && typeof item.description === "string", "SKILL_CENTER_STORE_INVALID", "市场技能信息无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(item.revision) && item.revision > 0 && Number.isSafeInteger(item.release) && item.release > 0, "SKILL_CENTER_STORE_INVALID", "市场技能 revision 无效", { status: 500, expose: false });
    normalizeSkillApplicability(item.applicability || DEFAULT_SKILL_APPLICABILITY);
    validateFiles(item.files);
    ids.add(item.id);
  }
  return true;
}

function publicSubmission(entry) {
  return {
    id: entry.id,
    skillId: entry.skillId,
    name: entry.name,
    description: entry.description,
    status: entry.status,
    uploaderId: entry.uploaderId,
    submittedAt: entry.submittedAt,
    updatedAt: entry.updatedAt,
    reviewedAt: entry.reviewedAt,
    revision: entry.revision,
    fileCount: entry.files.length,
  };
}

function publicMarketItem(entry, installedSkillIds = new Set()) {
  return {
    id: entry.id,
    skillId: entry.skillId,
    name: entry.name,
    description: entry.description,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
    fileCount: entry.files.length,
    installed: installedSkillIds.has(entry.skillId),
    applicability: normalizeSkillApplicability(entry.applicability || DEFAULT_SKILL_APPLICABILITY),
  };
}

function publicSkillFile(file) {
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256,
    binary: file.binary,
    content: file.content,
    truncated: file.truncated,
  };
}

export class SkillMarketplaceService {
  constructor(options) {
    invariant(typeof options?.dataRoot === "string" && path.isAbsolute(options.dataRoot), "DATA_ROOT_INVALID", "技能中心需要绝对 dataRoot", { status: 500, expose: false });
    this.root = path.resolve(options.dataRoot, "skills");
    this.statePath = path.join(this.root, "index.json");
    this.packagesRoot = path.join(this.root, "packages");
    this.clock = options.clock || (() => new Date());
    this.prompts = options.prompts || null;
    this.queue = options.queue || defaultActorMutationQueue;
    this.idFactory = options.idFactory || ((kind) => `${kind}_${crypto.randomUUID()}`);
    this.maxFiles = Number(options.maxFiles ?? 1000);
    this.maxFileBytes = Number(options.maxFileBytes ?? 10 * 1024 * 1024);
    this.maxPackageBytes = Number(options.maxPackageBytes ?? 50 * 1024 * 1024);
    invariant([this.maxFiles, this.maxFileBytes, this.maxPackageBytes].every((value) => Number.isSafeInteger(value) && value > 0), "SKILL_LIMIT_INVALID", "技能大小限制无效", { status: 500, expose: false });
  }

  #now() {
    return this.clock().toISOString();
  }

  #newId(kind) {
    return assertSegment(String(this.idFactory(kind)), `${kind}Id`);
  }

  #packageRoot(packageId) {
    const candidate = path.resolve(this.packagesRoot, assertSegment(packageId, "packageId"));
    invariant(isWithin(this.packagesRoot, candidate), "SKILL_PACKAGE_PATH_ESCAPE", "技能包路径越界", { status: 500, expose: false });
    return candidate;
  }

  async #readEnvelope() {
    let envelope;
    try {
      envelope = JSON.parse(await fs.readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: STORE_SCHEMA_VERSION, revision: 0, updatedAt: null, data: defaultStore() };
      if (error instanceof SyntaxError) invariant(false, "SKILL_CENTER_STORE_CORRUPT", "技能中心索引损坏", { status: 500, expose: false });
      throw error;
    }
    invariant(envelope?.schemaVersion === STORE_SCHEMA_VERSION && Number.isSafeInteger(envelope.revision) && envelope.revision >= 0, "SKILL_CENTER_STORE_CORRUPT", "技能中心索引 envelope 无效", { status: 500, expose: false });
    validateStore(envelope.data);
    return envelope;
  }

  async #update(mutator) {
    return this.queue.run(GLOBAL_QUEUE_ACTOR, async () => {
      const current = await this.#readEnvelope();
      const draft = clone(current.data);
      const result = await mutator(draft, current);
      const data = result === undefined ? draft : result;
      validateStore(data);
      const next = {
        schemaVersion: STORE_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: this.#now(),
        data,
      };
      await atomicWriteJson(this.statePath, next);
      return clone(next);
    });
  }

  async #writePackage(packageId, files) {
    const root = this.#packageRoot(packageId);
    const committed = await fs.readFile(path.join(root, "package.json"), "utf8").then((value) => JSON.parse(value)).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    const sha256 = packageDigest(files);
    if (committed) {
      invariant(committed.sha256 === sha256, "SKILL_PACKAGE_PATH_CONFLICT", "技能包目录已被其他内容占用", { status: 409 });
      return { packageId, sha256, files: committed.files, entrypoint: committed.entrypoint };
    }
    await fs.mkdir(path.join(root, "files"), { recursive: true });
    try {
      for (const file of files) {
        const destination = path.resolve(root, "files", ...file.path.split("/"));
        invariant(isWithin(path.join(root, "files"), destination), "SKILL_FILE_PATH_ESCAPE", "技能文件路径越界", { status: 400 });
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.content, { mode: 0o600 });
      }
      const descriptor = {
        schemaVersion: PACKAGE_SCHEMA_VERSION,
        packageId,
        sha256,
        entrypoint: preferredEntrypoint(files),
        files: fileDescriptors(files),
      };
      await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return descriptor;
    } catch (error) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #loadPackage(entry, { includeContent = true } = {}) {
    const root = this.#packageRoot(entry.packageId);
    const descriptor = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    invariant(
      descriptor?.schemaVersion === PACKAGE_SCHEMA_VERSION
      && descriptor.packageId === entry.packageId
      && descriptor.sha256 === entry.packageSha256
      && descriptor.entrypoint === entry.entrypoint
      && Array.isArray(descriptor.files),
      "SKILL_PACKAGE_CORRUPT",
      "技能包索引与文件不一致",
      { status: 500, expose: false },
    );
    let remaining = TOTAL_PREVIEW_BYTES;
    const files = [];
    for (const expected of descriptor.files) {
      const relativePath = assertRelativeFilePath(expected.path, "package.files[].path");
      const source = path.resolve(root, "files", ...relativePath.split("/"));
      invariant(isWithin(path.join(root, "files"), source), "SKILL_PACKAGE_FILE_ESCAPE", "技能包文件越界", { status: 500, expose: false });
      const content = await fs.readFile(source);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      invariant(content.length === expected.size && sha256 === expected.sha256, "SKILL_PACKAGE_FILE_CORRUPT", "技能包文件校验失败", { status: 500, expose: false, details: { path: relativePath } });
      const binary = content.includes(0);
      const previewBytes = includeContent && !binary ? Math.min(content.length, TEXT_PREVIEW_BYTES, remaining) : 0;
      const preview = previewBytes > 0 ? content.subarray(0, previewBytes).toString("utf8") : null;
      remaining -= previewBytes;
      files.push({
        path: relativePath,
        size: content.length,
        sha256,
        binary,
        content: preview,
        truncated: !binary && previewBytes < content.length,
        raw: content,
      });
    }
    return { descriptor, files };
  }

  async listMarket({ installedSkillIds = [] } = {}) {
    const snapshot = await this.#readEnvelope();
    const installed = new Set(installedSkillIds.map(String));
    return {
      items: snapshot.data.market
        .map((entry) => publicMarketItem(entry, installed))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      revision: snapshot.revision,
    };
  }

  async ensureBuiltins() {
    invariant(this.prompts && typeof this.prompts.builtinSkills === "function", "BUILTIN_SKILL_PROMPTS_REQUIRED", "技能中心缺少内置 Skill Prompt Repository", { status: 500, expose: false });
    for (const definition of await this.prompts.builtinSkills()) {
      const files = normalizeFiles(definition.files, this);
      const digest = packageDigest(files);
      const packageId = `skill_package_builtin_${digest.slice(0, 16)}`;
      const snapshot = await this.#readEnvelope();
      const current = snapshot.data.market.find((entry) => entry.id === definition.id);
      if (current?.packageSha256 === digest) continue;
      const descriptor = await this.#writePackage(packageId, files);
      await this.#update((store) => {
        const index = store.market.findIndex((entry) => entry.id === definition.id);
        const previous = index >= 0 ? store.market[index] : null;
        if (previous?.packageSha256 === descriptor.sha256) return;
        const now = this.#now();
        const next = {
          id: definition.id,
          skillId: definition.skillId,
          packageId: descriptor.packageId,
          packageSha256: descriptor.sha256,
          entrypoint: descriptor.entrypoint,
          files: descriptor.files,
          name: definition.name,
          description: definition.description,
          applicability: normalizeSkillApplicability(previous?.applicability || DEFAULT_SKILL_APPLICABILITY),
          createdAt: previous?.createdAt || now,
          updatedAt: now,
          revision: previous ? previous.revision + 1 : 1,
          release: previous ? previous.release + 1 : 1,
        };
        if (index >= 0) store.market[index] = next;
        else store.market.push(next);
      });
    }
  }

  async getMarket(id, { installedSkillIds = [] } = {}) {
    const snapshot = await this.#readEnvelope();
    const item = snapshot.data.market.find((entry) => entry.id === assertSegment(String(id || ""), "marketId"));
    invariant(item, "MARKET_SKILL_NOT_FOUND", "市场技能不存在", { status: 404 });
    const loaded = await this.#loadPackage(item);
    return {
      ...publicMarketItem(item, new Set(installedSkillIds.map(String))),
      entrypoint: item.entrypoint,
      primaryFile: item.entrypoint,
      files: loaded.files.map(publicSkillFile),
    };
  }

  async submit(actor, input) {
    requireAuthenticatedActor(actor);
    const name = normalizedText(String(input?.name ?? ""), "技能名称", 256, { required: true });
    const description = normalizedText(String(input?.description ?? ""), "技能简介", 8192);
    const files = normalizeFiles(input?.files, this);
    const command = String(input?.commandId || "").trim();
    invariant(command.length > 0 && command.length <= 512, "IDEMPOTENCY_KEY_REQUIRED", "上传技能需要 Idempotency-Key", { status: 428 });
    const packageId = this.#newId("skill_package");
    const descriptor = await this.#writePackage(packageId, files);
    try {
      let submission;
      const existing = (await this.#readEnvelope()).data.submissions.find((entry) => entry.uploaderId === actor.actorId && entry.commandId === command);
      if (existing) {
        await fs.rm(this.#packageRoot(packageId), { recursive: true, force: true }).catch(() => undefined);
        return { item: publicSubmission(existing), revision: (await this.#readEnvelope()).revision };
      }
      const result = await this.#update((store) => {
        const duplicate = store.submissions.find((entry) => entry.uploaderId === actor.actorId && entry.commandId === command);
        if (duplicate) {
          submission = duplicate;
          return;
        }
        const now = this.#now();
        submission = {
          id: this.#newId("skill_upload"),
          skillId: this.#newId("skill"),
          packageId,
          packageSha256: descriptor.sha256,
          entrypoint: descriptor.entrypoint,
          files: descriptor.files,
          name,
          description,
          uploaderId: actor.actorId,
          status: "pending",
          submittedAt: now,
          updatedAt: now,
          reviewedAt: null,
          reviewedBy: null,
          commandId: command,
          revision: 1,
        };
        store.submissions.push(submission);
      });
      if (submission.packageId !== packageId) await fs.rm(this.#packageRoot(packageId), { recursive: true, force: true }).catch(() => undefined);
      return { item: publicSubmission(submission), revision: result.revision };
    } catch (error) {
      await fs.rm(this.#packageRoot(packageId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async listSubmissions(actor, input = {}) {
    requireAuthenticatedActor(actor);
    const requested = input.status ? String(input.status) : null;
    invariant(!requested || REVIEW_STATUSES.has(requested) || requested === "reviewed", "SKILL_REVIEW_STATUS_INVALID", "审核状态无效", { status: 400 });
    const admin = actor.roles?.includes("admin");
    const snapshot = await this.#readEnvelope();
    return {
      items: snapshot.data.submissions
        .filter((entry) => admin || entry.uploaderId === actor.actorId)
        .filter((entry) => !requested || (requested === "reviewed" ? entry.status !== "pending" : entry.status === requested))
        .map(publicSubmission)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      revision: snapshot.revision,
    };
  }

  async getSubmission(actor, id) {
    requireAuthenticatedActor(actor);
    const snapshot = await this.#readEnvelope();
    const item = snapshot.data.submissions.find((entry) => entry.id === assertSegment(String(id || ""), "submissionId"));
    invariant(item, "SKILL_SUBMISSION_NOT_FOUND", "上传的技能不存在", { status: 404 });
    invariant(item.uploaderId === actor.actorId || actor.roles?.includes("admin"), "SKILL_SUBMISSION_FORBIDDEN", "无权查看该技能", { status: 403 });
    const loaded = await this.#loadPackage(item);
    return {
      ...publicSubmission(item),
      entrypoint: item.entrypoint,
      primaryFile: item.entrypoint,
      files: loaded.files.map(publicSkillFile),
    };
  }

  async review(actor, id, input) {
    requireAuthenticatedActor(actor);
    requireRole(actor, "admin");
    const decision = String(input?.decision || "");
    invariant(["approve", "reject"].includes(decision), "SKILL_REVIEW_DECISION_INVALID", "审核结果必须是通过或拒绝", { status: 400 });
    let reviewed;
    let marketItem = null;
    const result = await this.#update((store) => {
      const index = store.submissions.findIndex((entry) => entry.id === assertSegment(String(id || ""), "submissionId"));
      invariant(index >= 0, "SKILL_SUBMISSION_NOT_FOUND", "上传的技能不存在", { status: 404 });
      const current = store.submissions[index];
      assertExpectedRevision(current.revision, input?.expectedRevision);
      invariant(current.status === "pending", "SKILL_SUBMISSION_ALREADY_REVIEWED", "该技能已经审核", { status: 409 });
      const now = this.#now();
      reviewed = {
        ...current,
        status: decision === "approve" ? "approved" : "rejected",
        reviewedAt: now,
        reviewedBy: actor.actorId,
        updatedAt: now,
        revision: current.revision + 1,
      };
      store.submissions[index] = reviewed;
      if (decision === "approve") {
        marketItem = {
          id: this.#newId("market_skill"),
          skillId: current.skillId,
          submissionId: current.id,
          packageId: current.packageId,
          packageSha256: current.packageSha256,
          entrypoint: current.entrypoint,
          files: clone(current.files),
          name: current.name,
          description: current.description,
          applicability: normalizeSkillApplicability(input?.applicability || DEFAULT_SKILL_APPLICABILITY),
          createdAt: now,
          updatedAt: now,
          revision: 1,
          release: 1,
        };
        store.market.push(marketItem);
      }
    });
    return {
      item: publicSubmission(reviewed),
      market: marketItem ? publicMarketItem(marketItem) : null,
      revision: result.revision,
    };
  }

  async updateMarket(actor, id, input) {
    requireAuthenticatedActor(actor);
    requireRole(actor, "admin");
    const marketId = assertSegment(String(id || ""), "marketId");
    const name = input?.name === undefined ? null : normalizedText(String(input.name ?? ""), "技能名称", 256, { required: true });
    const description = input?.description === undefined ? null : normalizedText(String(input.description ?? ""), "技能简介", 8192);
    const requestedApplicability = input?.applicability === undefined ? null : normalizeSkillApplicability(input.applicability);
    invariant(input?.files === undefined || input?.fileUpdates === undefined, "SKILL_FILE_UPDATE_CONFLICT", "不能同时替换技能包并更新单个文件", { status: 400 });
    let replacementFiles = input?.files === undefined ? null : normalizeFiles(input.files, this);
    if (input?.fileUpdates !== undefined) {
      const updates = normalizeFiles(input.fileUpdates, this);
      invariant(updates.every((entry) => /\.md$/i.test(entry.path) && !entry.content.includes(0)), "SKILL_MARKDOWN_UPDATE_INVALID", "只能编辑文本 Markdown 文件", { status: 400 });
      const snapshot = await this.#readEnvelope();
      const source = snapshot.data.market.find((entry) => entry.id === marketId);
      invariant(source, "MARKET_SKILL_NOT_FOUND", "市场技能不存在", { status: 404 });
      assertExpectedRevision(source.revision, input?.expectedRevision);
      const loaded = await this.#loadPackage(source, { includeContent: false });
      const existingPaths = new Set(loaded.files.map((entry) => entry.path));
      invariant(updates.every((entry) => existingPaths.has(entry.path)), "SKILL_MARKDOWN_UPDATE_NOT_FOUND", "要编辑的 Markdown 文件不存在", { status: 404 });
      const updateMap = new Map(updates.map((entry) => [entry.path, entry.content]));
      replacementFiles = loaded.files.map((entry) => ({ path: entry.path, content: updateMap.get(entry.path) ?? entry.raw }));
      const totalBytes = replacementFiles.reduce((total, entry) => {
        invariant(entry.content.length <= this.maxFileBytes, "SKILL_FILE_TOO_LARGE", "技能单文件超过大小限制", { status: 413, details: { path: entry.path, maxFileBytes: this.maxFileBytes } });
        return total + entry.content.length;
      }, 0);
      invariant(totalBytes <= this.maxPackageBytes, "SKILL_PACKAGE_TOO_LARGE", "技能包超过大小限制", { status: 413, details: { maxPackageBytes: this.maxPackageBytes } });
    }
    const packageId = replacementFiles ? this.#newId("skill_package") : null;
    const descriptor = replacementFiles ? await this.#writePackage(packageId, replacementFiles) : null;
    try {
      let updated;
      const result = await this.#update((store) => {
        const index = store.market.findIndex((entry) => entry.id === marketId);
        invariant(index >= 0, "MARKET_SKILL_NOT_FOUND", "市场技能不存在", { status: 404 });
        const current = store.market[index];
        assertExpectedRevision(current.revision, input?.expectedRevision);
        updated = {
          ...current,
          ...(descriptor ? {
            packageId: descriptor.packageId,
            packageSha256: descriptor.sha256,
            entrypoint: descriptor.entrypoint,
            files: descriptor.files,
          } : {}),
          name: name ?? current.name,
          description: description ?? current.description,
          applicability: requestedApplicability || normalizeSkillApplicability(current.applicability || DEFAULT_SKILL_APPLICABILITY),
          updatedAt: this.#now(),
          revision: current.revision + 1,
          release: current.release + 1,
        };
        store.market[index] = updated;
      });
      return { item: publicMarketItem(updated), revision: result.revision };
    } catch (error) {
      if (packageId) await fs.rm(this.#packageRoot(packageId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async deleteMarket(actor, id, input) {
    requireAuthenticatedActor(actor);
    requireRole(actor, "admin");
    let removed;
    const result = await this.#update((store) => {
      const index = store.market.findIndex((entry) => entry.id === assertSegment(String(id || ""), "marketId"));
      invariant(index >= 0, "MARKET_SKILL_NOT_FOUND", "市场技能不存在", { status: 404 });
      removed = store.market[index];
      assertExpectedRevision(removed.revision, input?.expectedRevision);
      store.market.splice(index, 1);
    });
    return { id: removed.id, skillId: removed.skillId, revision: result.revision };
  }

  async install(actor, skillService, id) {
    requireAuthenticatedActor(actor);
    invariant(typeof skillService?.installPackage === "function", "SKILL_INSTALL_SERVICE_INVALID", "用户技能服务不可用", { status: 500, expose: false });
    const snapshot = await this.#readEnvelope();
    const item = snapshot.data.market.find((entry) => entry.id === assertSegment(String(id || ""), "marketId"));
    invariant(item, "MARKET_SKILL_NOT_FOUND", "市场技能不存在", { status: 404 });
    const loaded = await this.#loadPackage(item, { includeContent: false });
    const version = `market-${item.release}-${item.packageSha256.slice(0, 12)}`;
    const installed = await skillService.installPackage({
      skillId: item.skillId,
      version,
      manifest: {
        name: item.name,
        description: item.description,
        entrypoint: item.entrypoint,
        permissions: [],
      },
      files: loaded.files.map((file) => ({ path: file.path, content: file.raw })),
      applicability: normalizeSkillApplicability(item.applicability || DEFAULT_SKILL_APPLICABILITY),
    });
    return {
      marketSkillId: item.id,
      skillId: item.skillId,
      installed: true,
      duplicate: installed.duplicate,
      revision: installed.revision,
    };
  }
}

export const skillMarketplaceConstants = Object.freeze({
  storeSchemaVersion: STORE_SCHEMA_VERSION,
  packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
});
