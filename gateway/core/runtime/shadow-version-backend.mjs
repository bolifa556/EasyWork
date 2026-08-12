import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_TREE_FILES = 100_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_OPERATIONS = new Set(["init", "add", "commit", "rev-parse"]);
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function missing(error) {
  return ["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code);
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
}

function normalizeAbsolute(value, field) {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(path.posix.isAbsolute(source) && !source.includes("\0"), "REMOTE_VERSION_PATH_INVALID", `${field} 必须是安全的远端绝对路径`, { status: 400 });
  return path.posix.normalize(source).replace(/\/$/, "") || "/";
}

function relativePath(value, field = "path") {
  const source = String(value || "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(source);
  const segments = normalized.split("/");
  invariant(source && !path.posix.isAbsolute(source) && normalized !== "." && !normalized.startsWith("../") && segments.every((segment) => segment && segment !== "." && segment !== ".."), "REMOTE_VERSION_RELATIVE_PATH_INVALID", `${field} 无效`, { status: 400 });
  invariant(!segments.some((segment) => [".git", ".easywork"].includes(segment)), "REMOTE_VERSION_PROTECTED_PATH", `${field} 指向受保护目录`, { status: 409 });
  return normalized;
}

function safeEntryName(value) {
  const name = String(value || "");
  invariant(name && ![".", ".."].includes(name) && !name.includes("/") && !name.includes("\0"), "REMOTE_VERSION_ENTRY_INVALID", "远端目录包含非法名称", { status: 409 });
  return name;
}

function fileSnapshot(bytes) {
  const value = Buffer.from(bytes);
  return { exists: true, sha256: crypto.createHash("sha256").update(value).digest("hex"), size: value.length };
}

function absentSnapshot() {
  return { exists: false, sha256: null, size: 0 };
}

function sameSnapshot(left, right) {
  return Boolean(left && right && left.sha256 === right.sha256 && left.size === right.size);
}

function validateGitDescriptor(input, controlRoot) {
  const descriptor = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  invariant(Object.keys(descriptor).every((key) => ["gitDir", "workTree", "indexFile", "configFile", "args"].includes(key)), "REMOTE_GIT_DESCRIPTOR_INVALID", "隔离 Git descriptor 包含未知字段", { status: 400 });
  const paths = Object.fromEntries(["gitDir", "workTree", "indexFile", "configFile"].map((key) => [key, normalizeAbsolute(descriptor[key], key)]));
  for (const value of Object.values(paths)) invariant(value === controlRoot || value.startsWith(`${controlRoot}/`), "REMOTE_GIT_STORAGE_ESCAPE", "隔离 Git 路径越界", { status: 403 });
  invariant(Array.isArray(descriptor.args) && descriptor.args.length > 0 && descriptor.args.length <= 16, "REMOTE_GIT_ARGS_INVALID", "隔离 Git 参数无效", { status: 400 });
  const args = descriptor.args.map((entry) => {
    const value = String(entry);
    invariant(value.length > 0 && value.length <= 4_096 && !value.includes("\0"), "REMOTE_GIT_ARGS_INVALID", "隔离 Git 参数无效", { status: 400 });
    return value;
  });
  invariant(GIT_OPERATIONS.has(args[0]), "REMOTE_GIT_OPERATION_FORBIDDEN", "仅允许 EasyWork 版本服务所需的 Git 操作", { status: 403 });
  if (args[0] === "init") invariant(JSON.stringify(args) === JSON.stringify(["init", "--bare"]), "REMOTE_GIT_ARGS_INVALID", "Git init 参数无效", { status: 400 });
  if (args[0] === "add") invariant(JSON.stringify(args) === JSON.stringify(["add", "--all", "--", "."]), "REMOTE_GIT_ARGS_INVALID", "Git add 参数无效", { status: 400 });
  if (args[0] === "rev-parse") invariant(JSON.stringify(args) === JSON.stringify(["rev-parse", "HEAD"]), "REMOTE_GIT_ARGS_INVALID", "Git rev-parse 参数无效", { status: 400 });
  if (args[0] === "commit") invariant(args.length === 4 && args[1] === "--allow-empty" && args[2] === "-m", "REMOTE_GIT_ARGS_INVALID", "Git commit 参数无效", { status: 400 });
  return { ...paths, args };
}

export class SshShadowVersionBackend {
  constructor({ executor, actor, serverIdentity }) {
    invariant(executor?.home && executor?.withSftp && executor?.exec, "REMOTE_VERSION_EXECUTOR_INVALID", "远端版本 backend 缺少 executor", { status: 500, expose: false });
    invariant(actor?.actorId && serverIdentity, "REMOTE_VERSION_SCOPE_INVALID", "远端版本 backend 缺少 Actor 或服务器身份", { status: 500, expose: false });
    this.executor = executor;
    this.actorId = String(actor.actorId);
    this.serverIdentity = String(serverIdentity);
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.actorId) && /^ssh_[A-Za-z0-9_-]{43}$/.test(this.serverIdentity), "REMOTE_VERSION_SCOPE_INVALID", "远端版本 Actor 或服务器身份无效", { status: 500, expose: false });
    this.homePath = null;
    this.controlRoot = null;
  }

  async initialize() {
    const home = normalizeAbsolute(await this.executor.home(), "HOME");
    invariant(home !== "/", "REMOTE_VERSION_HOME_INVALID", "远端 HOME 无效", { status: 502 });
    this.homePath = home;
    this.controlRoot = `${home}/.easywork/versioning/${this.actorId}/${this.serverIdentity}`;
    await this.#withSftp((sftp) => this.#mkdirp(sftp, this.controlRoot, 0o700));
    return this;
  }

  async readJson(candidate) {
    const target = await this.#controlPath(candidate, "JSON path");
    let bytes;
    try { bytes = await this.executor.readFile(target); } catch (error) { if (missing(error)) return null; throw error; }
    invariant(bytes.length <= MAX_JSON_BYTES, "REMOTE_VERSION_JSON_TOO_LARGE", "隔离版本状态文件过大", { status: 413 });
    try { return JSON.parse(bytes.toString("utf8")); } catch (error) {
      invariant(false, "REMOTE_VERSION_JSON_INVALID", "隔离版本状态文件损坏", { status: 500, expose: false, cause: error });
    }
  }

  async writeJsonAtomic(candidate, value, options = {}) {
    const target = await this.#controlPath(candidate, "JSON path");
    invariant(Object.keys(options || {}).every((key) => key === "expectedRevision"), "REMOTE_VERSION_WRITE_OPTIONS_INVALID", "版本状态写入选项无效", { status: 400 });
    const current = await this.readJson(target);
    const expected = options.expectedRevision;
    if (expected === null) invariant(current === null, "REVISION_CONFLICT", "隔离版本状态已存在", { status: 409, details: { expectedRevision: null, actualRevision: current?.revision ?? null } });
    else if (expected !== undefined) invariant(current && current.revision === expected, "REVISION_CONFLICT", "隔离版本状态 revision 已变化", { status: 409, details: { expectedRevision: expected, actualRevision: current?.revision ?? null } });
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    invariant(bytes.length <= MAX_JSON_BYTES, "REMOTE_VERSION_JSON_TOO_LARGE", "隔离版本状态文件过大", { status: 413 });
    await this.executor.writeAtomic(target, bytes, { mode: 0o600 });
  }

  async mkdir(candidate) {
    const target = await this.#controlPath(candidate, "directory");
    await this.#withSftp((sftp) => this.#mkdirp(sftp, target, 0o700));
  }

  async writeTextAtomic(candidate, content) {
    const target = await this.#controlPath(candidate, "text path");
    const bytes = Buffer.from(String(content));
    invariant(bytes.length <= MAX_JSON_BYTES, "REMOTE_VERSION_TEXT_TOO_LARGE", "隔离版本文本文件过大", { status: 413 });
    await this.executor.writeAtomic(target, bytes, { mode: 0o600 });
  }

  async diffTree(input) {
    const value = await this.#treeInput(input);
    return this.#withSftp(async (sftp) => {
      const [source, shadow] = await Promise.all([
        this.#scan(sftp, value.sourceRoot, value.exclude),
        this.#scan(sftp, value.shadowRoot, [], { rejectSymlinks: true }),
      ]);
      const names = [...new Set([...source.files.keys(), ...shadow.files.keys()])].sort();
      return names.filter((name) => !sameSnapshot(source.files.get(name), shadow.files.get(name))).map((name) => ({
        path: name,
        before: shadow.files.get(name) || absentSnapshot(),
        after: source.files.get(name) || absentSnapshot(),
      }));
    });
  }

  async syncTree(input) {
    const value = await this.#treeInput(input);
    return this.#withSftp(async (sftp) => {
      const [source, shadow] = await Promise.all([
        this.#scan(sftp, value.sourceRoot, value.exclude),
        this.#scan(sftp, value.shadowRoot, [], { rejectSymlinks: true }),
      ]);
      const removedFiles = [...shadow.files.keys()].filter((name) => !source.files.has(name)).sort().reverse();
      for (const name of removedFiles) await this.#unlinkIfPresent(sftp, path.posix.join(value.shadowRoot, name));
      const removedDirectories = [...shadow.directories].filter((name) => name && !source.directories.has(name)).sort((left, right) => right.length - left.length);
      for (const name of removedDirectories) await this.#rmdirIfPresent(sftp, path.posix.join(value.shadowRoot, name));
      for (const name of [...source.directories].sort()) await this.#mkdirp(sftp, path.posix.join(value.shadowRoot, name), 0o700);
      let copiedFiles = 0;
      for (const [name, snapshot] of source.files) {
        if (sameSnapshot(snapshot, shadow.files.get(name))) continue;
        const sourcePath = path.posix.join(value.sourceRoot, name);
        const targetPath = path.posix.join(value.shadowRoot, name);
        const bytes = Buffer.from(await sftpCall(sftp, "readFile", sourcePath));
        invariant(bytes.length <= MAX_FILE_BYTES && fileSnapshot(bytes).sha256 === snapshot.sha256, "REMOTE_VERSION_SOURCE_CHANGED", "同步期间工作区文件发生变化", { status: 409, details: { path: name } });
        await this.#writeAtomicSftp(sftp, targetPath, bytes, 0o600);
        copiedFiles += 1;
      }
      return { copiedFiles, removedFiles: removedFiles.length, fileCount: source.files.size, totalBytes: source.totalBytes };
    });
  }

  async fingerprint(input) {
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["root", "path"].includes(key)), "REMOTE_VERSION_FINGERPRINT_INPUT_INVALID", "fingerprint 输入无效", { status: 400 });
    const root = await this.#workspaceRoot(input.root);
    const name = relativePath(input.path);
    const target = path.posix.join(root, name);
    return this.#withSftp(async (sftp) => {
      let attrs;
      try { attrs = await sftpCall(sftp, "lstat", target); } catch (error) { if (missing(error)) return absentSnapshot(); throw error; }
      invariant(!attrs.isSymbolicLink?.(), "REMOTE_VERSION_SYMLINK_FORBIDDEN", "版本路径不能是符号链接", { status: 409, details: { path: name } });
      if (attrs.isDirectory?.()) {
        const tree = await this.#scan(sftp, target, []);
        const digest = crypto.createHash("sha256");
        for (const [entry, snapshot] of tree.files) digest.update(`${entry}\0${snapshot.sha256}\0${snapshot.size}\0`);
        return { exists: true, sha256: digest.digest("hex"), size: tree.totalBytes };
      }
      const bytes = Buffer.from(await sftpCall(sftp, "readFile", target));
      invariant(bytes.length <= MAX_FILE_BYTES, "REMOTE_VERSION_FILE_TOO_LARGE", "版本文件超过大小上限", { status: 413, details: { path: name, maxBytes: MAX_FILE_BYTES } });
      return fileSnapshot(bytes);
    });
  }

  async restorePath(input) {
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["gitDir", "commitId", "relativePath", "destinationRoot"].includes(key)), "REMOTE_VERSION_RESTORE_INPUT_INVALID", "restorePath 输入无效", { status: 400 });
    const gitDir = await this.#controlPath(input.gitDir, "gitDir");
    const commitId = String(input.commitId || "");
    invariant(/^[a-f0-9]{7,64}$/.test(commitId), "REMOTE_VERSION_COMMIT_ID_INVALID", "commitId 无效", { status: 400 });
    const name = relativePath(input.relativePath, "relativePath");
    const root = await this.#workspaceRoot(input.destinationRoot);
    const destination = path.posix.join(root, name);
    const parent = path.posix.dirname(destination);
    await this.#withSftp((sftp) => this.#mkdirWithinWorkspace(sftp, root, path.posix.relative(root, parent)));
    const temporary = `${destination}.easywork-restore-${crypto.randomBytes(6).toString("hex")}`;
    const spec = `${commitId}:${name}`;
    const result = await this.executor.exec(`git --git-dir=${shellQuote(gitDir)} show ${shellQuote(spec)} > ${shellQuote(temporary)} && mv -f -- ${shellQuote(temporary)} ${shellQuote(destination)}`, { maxOutputBytes: 64 * 1024 });
    if (result.code !== 0) await this.#withSftp((sftp) => this.#unlinkIfPresent(sftp, temporary));
    invariant(result.code === 0, "REMOTE_VERSION_RESTORE_FAILED", "无法从隔离版本仓库恢复文件", { status: 409, details: { path: name, stderr: String(result.stderr || "").slice(0, 2_000) } });
  }

  async removePath(input) {
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["root", "path"].includes(key)), "REMOTE_VERSION_REMOVE_INPUT_INVALID", "removePath 输入无效", { status: 400 });
    const root = await this.#workspaceRoot(input.root);
    const name = relativePath(input.path);
    await this.#withSftp((sftp) => this.#removeTree(sftp, path.posix.join(root, name)));
  }

  async git(input) {
    invariant(this.controlRoot, "REMOTE_VERSION_NOT_INITIALIZED", "远端版本 backend 尚未初始化", { status: 500, expose: false });
    const descriptor = validateGitDescriptor(input, this.controlRoot);
    const environment = [
      `GIT_CONFIG_GLOBAL=${shellQuote(descriptor.configFile)}`,
      `GIT_INDEX_FILE=${shellQuote(descriptor.indexFile)}`,
    ];
    const command = descriptor.args[0] === "init"
      ? [...environment, "git", "init", "--bare", shellQuote(descriptor.gitDir)].join(" ")
      : [...environment, "git", `--git-dir=${shellQuote(descriptor.gitDir)}`, `--work-tree=${shellQuote(descriptor.workTree)}`, ...descriptor.args.map(shellQuote)].join(" ");
    const result = await this.executor.exec(command, { maxOutputBytes: MAX_GIT_OUTPUT_BYTES });
    return { stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), code: Number.isInteger(result.code) ? result.code : 1 };
  }

  async #treeInput(input) {
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["sourceRoot", "shadowRoot", "exclude"].includes(key)), "REMOTE_VERSION_TREE_INPUT_INVALID", "版本树输入无效", { status: 400 });
    const sourceRoot = await this.#workspaceRoot(input.sourceRoot);
    const shadowRoot = this.#controlPathSync(input.shadowRoot, "shadowRoot");
    const exclude = [...new Set((input.exclude || []).map((entry) => safeEntryName(entry)))];
    const segments = sourceRoot.split("/").filter(Boolean);
    invariant(sourceRoot !== "/" && !segments.some((segment) => [".git", ".easywork"].includes(segment)), "REMOTE_VERSION_WORKSPACE_FORBIDDEN", "版本工作区路径无效", { status: 409 });
    return { sourceRoot, shadowRoot, exclude };
  }

  async #workspaceRoot(candidate) {
    const source = normalizeAbsolute(candidate, "workspaceRoot");
    const result = await this.executor.exec(`readlink -f -- ${shellQuote(source)}`, { maxOutputBytes: 32 * 1024 });
    invariant(result.code === 0, "REMOTE_VERSION_WORKSPACE_NOT_FOUND", "版本工作区不存在", { status: 404 });
    const root = normalizeAbsolute(String(result.stdout).trim(), "workspaceRoot");
    const segments = root.split("/").filter(Boolean);
    invariant(root !== "/" && !segments.some((segment) => [".git", ".easywork"].includes(segment)), "REMOTE_VERSION_WORKSPACE_FORBIDDEN", "版本工作区路径无效", { status: 409 });
    return root;
  }

  async #controlPath(candidate, field) {
    invariant(this.controlRoot, "REMOTE_VERSION_NOT_INITIALIZED", "远端版本 backend 尚未初始化", { status: 500, expose: false });
    const source = String(candidate || "").replace(/\\/g, "/");
    const expanded = source === "~" ? this.homePath : source.startsWith("~/") ? `${this.homePath}/${source.slice(2)}` : source;
    const target = normalizeAbsolute(expanded, field);
    invariant(target === this.controlRoot || target.startsWith(`${this.controlRoot}/`), "REMOTE_VERSION_STORAGE_ESCAPE", `${field} 越出当前 Actor 与服务器的隔离版本目录`, { status: 403 });
    return target;
  }

  #controlPathSync(candidate, field) {
    invariant(this.controlRoot, "REMOTE_VERSION_NOT_INITIALIZED", "远端版本 backend 尚未初始化", { status: 500, expose: false });
    const source = String(candidate || "").replace(/\\/g, "/");
    const expanded = source === "~" ? this.homePath : source.startsWith("~/") ? `${this.homePath}/${source.slice(2)}` : source;
    const target = normalizeAbsolute(expanded, field);
    invariant(target === this.controlRoot || target.startsWith(`${this.controlRoot}/`), "REMOTE_VERSION_STORAGE_ESCAPE", `${field} 越出当前 Actor 与服务器的隔离版本目录`, { status: 403 });
    return target;
  }

  #withSftp(operation) {
    return this.executor.withSftp(operation);
  }

  async #scan(sftp, root, excluded, { rejectSymlinks = false } = {}) {
    const files = new Map();
    const directories = new Set([""]);
    let totalBytes = 0;
    const walk = async (directory, relativeRoot) => {
      let entries;
      try { entries = await sftpCall(sftp, "readdir", directory); } catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries) {
        const name = safeEntryName(entry.filename);
        if (excluded.includes(name)) continue;
        const relative = relativeRoot ? `${relativeRoot}/${name}` : name;
        const target = path.posix.join(directory, name);
        const attrs = entry.attrs || await sftpCall(sftp, "lstat", target);
        if (attrs.isSymbolicLink?.()) {
          invariant(!rejectSymlinks, "REMOTE_VERSION_SHADOW_SYMLINK", "隔离版本目录包含符号链接，已拒绝继续", { status: 409, details: { path: relative } });
          continue;
        }
        if (attrs.isDirectory?.()) {
          directories.add(relative);
          await walk(target, relative);
          continue;
        }
        invariant(files.size < MAX_TREE_FILES, "REMOTE_VERSION_TREE_TOO_LARGE", "版本工作区文件数超过上限", { status: 413, details: { maxFiles: MAX_TREE_FILES } });
        const declaredSize = Number(attrs.size || 0);
        invariant(Number.isSafeInteger(declaredSize) && declaredSize >= 0 && declaredSize <= MAX_FILE_BYTES, "REMOTE_VERSION_FILE_TOO_LARGE", "版本文件超过大小上限", { status: 413, details: { path: relative, maxBytes: MAX_FILE_BYTES } });
        const bytes = Buffer.from(await sftpCall(sftp, "readFile", target));
        invariant(bytes.length <= MAX_FILE_BYTES, "REMOTE_VERSION_FILE_TOO_LARGE", "版本文件超过大小上限", { status: 413, details: { path: relative, maxBytes: MAX_FILE_BYTES } });
        totalBytes += bytes.length;
        invariant(totalBytes <= MAX_TREE_BYTES, "REMOTE_VERSION_TREE_TOO_LARGE", "版本工作区总大小超过上限", { status: 413, details: { maxBytes: MAX_TREE_BYTES } });
        files.set(relative, fileSnapshot(bytes));
      }
    };
    await walk(root, "");
    return { files, directories, totalBytes };
  }

  async #mkdirp(sftp, directory, mode) {
    const target = normalizeAbsolute(directory, "directory");
    let current = "";
    for (const segment of target.split("/").filter(Boolean)) {
      current += `/${segment}`;
      let attrs;
      try { attrs = await sftpCall(sftp, "lstat", current); } catch (error) { if (!missing(error)) throw error; }
      if (attrs) {
        invariant(attrs.isDirectory?.() && !attrs.isSymbolicLink?.(), "REMOTE_VERSION_DIRECTORY_UNSAFE", "版本目录路径包含非目录或符号链接", { status: 409, details: { path: current } });
      } else {
        try { await sftpCall(sftp, "mkdir", current, { mode }); } catch (error) { if (!missing(error) && error?.code !== "EEXIST" && error?.code !== 4) throw error; }
      }
    }
  }

  async #mkdirWithinWorkspace(sftp, root, relativeDirectory) {
    if (!relativeDirectory || relativeDirectory === ".") return;
    let current = root;
    for (const segment of relativePath(relativeDirectory, "directory").split("/")) {
      current = path.posix.join(current, segment);
      let attrs;
      try { attrs = await sftpCall(sftp, "lstat", current); } catch (error) { if (!missing(error)) throw error; }
      if (attrs) invariant(attrs.isDirectory?.() && !attrs.isSymbolicLink?.(), "REMOTE_VERSION_DIRECTORY_UNSAFE", "工作区恢复路径包含非目录或符号链接", { status: 409, details: { path: current } });
      else await sftpCall(sftp, "mkdir", current, { mode: 0o700 });
    }
  }

  async #writeAtomicSftp(sftp, target, bytes, mode) {
    await this.#mkdirp(sftp, path.posix.dirname(target), 0o700);
    const temporary = `${target}.write-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await sftpCall(sftp, "writeFile", temporary, bytes, { mode });
      await sftpCall(sftp, "rename", temporary, target);
    } catch (error) {
      await this.#unlinkIfPresent(sftp, temporary);
      throw error;
    }
  }

  async #unlinkIfPresent(sftp, target) {
    try { await sftpCall(sftp, "unlink", target); } catch (error) { if (!missing(error)) throw error; }
  }

  async #rmdirIfPresent(sftp, target) {
    try { await sftpCall(sftp, "rmdir", target); } catch (error) { if (!missing(error)) throw error; }
  }

  async #removeTree(sftp, target) {
    let attrs;
    try { attrs = await sftpCall(sftp, "lstat", target); } catch (error) { if (missing(error)) return; throw error; }
    if (!attrs.isDirectory?.() || attrs.isSymbolicLink?.()) return this.#unlinkIfPresent(sftp, target);
    const entries = await sftpCall(sftp, "readdir", target);
    for (const entry of entries) await this.#removeTree(sftp, path.posix.join(target, safeEntryName(entry.filename)));
    await this.#rmdirIfPresent(sftp, target);
  }
}

export const shadowVersionLimits = Object.freeze({
  maxJsonBytes: MAX_JSON_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  maxTreeBytes: MAX_TREE_BYTES,
  maxTreeFiles: MAX_TREE_FILES,
});
