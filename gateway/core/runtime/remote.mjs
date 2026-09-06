import crypto from "node:crypto";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AgentDeploymentService, AgentRuntimeTransport, ManagedAgentConfiguration, SshAgentExecutor } from "../agent-runtime/index.mjs";
import { ApiError, invariant } from "../errors.mjs";
import { SshConversationVersionBackend } from "./conversation-version-backend.mjs";
import { SshSkillDeployment } from "./skill-deployment.mjs";
import { SshTerminalManager } from "./terminal.mjs";
import { SshSystemMonitor } from "./system-monitor.mjs";

const DEFAULT_REMOTE_FILE_LIMITS = Object.freeze({
  maxUploadBytes: 1024 * 1024 * 1024,
  maxDownloadBytes: 1024 * 1024 * 1024,
});
const GIT_STATUS_CAPTURE_BYTES = 2 * 1024 * 1024;
const GIT_CHANGE_LIMIT = 500;
const GIT_COMMIT_LIMIT = 50;
const SFTP_OPERATION_TIMEOUT_MS = 60_000;
const SFTP_LARGE_WRITE_TIMEOUT_MS = 10 * 60_000;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function sftpCall(sftp, method, ...args) {
  const largePayload = args.some((value) => Buffer.isBuffer(value) && value.length > 16 * 1024 * 1024);
  const timeoutMs = method === "fastPut" || largePayload ? SFTP_LARGE_WRITE_TIMEOUT_MS : SFTP_OPERATION_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new ApiError("SFTP_OPERATION_TIMEOUT", `SFTP ${method} 操作超时`, {
      status: 504,
      retryable: true,
      details: { method, timeoutMs },
    })), timeoutMs);
    try { sftp[method](...args, (error, value) => finish(error, value)); }
    catch (error) { finish(error); }
  });
}

function ensureRelative(value, field, { allowRoot = false } = {}) {
  const raw = String(value ?? "").replace(/\\/g, "/");
  invariant(!raw.includes("\0") && !path.posix.isAbsolute(raw) && !raw.split("/").includes(".."), "REMOTE_PATH_INVALID", `${field} 无效`, { status: 400 });
  const normalized = path.posix.normalize(raw || ".");
  invariant((allowRoot && normalized === ".") || (normalized && normalized !== "." && !normalized.startsWith("../")), "REMOTE_PATH_INVALID", `${field} 无效`, { status: 400 });
  return normalized === "." ? "" : normalized;
}

function transferLimit(value, fallback, field) {
  const result = Number(value ?? fallback);
  invariant(Number.isSafeInteger(result) && result >= 1024 * 1024 && result <= 16 * 1024 * 1024 * 1024, "REMOTE_FILE_LIMIT_INVALID", `${field} 无效`, { status: 500, expose: false });
  return result;
}

function normalizeRemoteFileLimits(value = {}) {
  return Object.freeze({
    maxUploadBytes: transferLimit(value.maxUploadBytes, DEFAULT_REMOTE_FILE_LIMITS.maxUploadBytes, "maxUploadBytes"),
    maxDownloadBytes: transferLimit(value.maxDownloadBytes, DEFAULT_REMOTE_FILE_LIMITS.maxDownloadBytes, "maxDownloadBytes"),
  });
}

function missingSftpEntry(error) {
  return [2, "ENOENT"].includes(error?.code);
}

function canFallbackFromPosixRename(error) {
  return [4, 8, "ENOSYS"].includes(error?.code) || /(?:does not support|unsupported|operation failure)/i.test(String(error?.message || ""));
}

function porcelainPath(record, fieldCount) {
  let offset = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    offset = record.indexOf(" ", offset);
    if (offset < 0) return "";
    offset += 1;
  }
  return record.slice(offset);
}

function parseGitStatus(output) {
  const branch = { name: null, detached: false, unborn: false, oid: null, upstream: null, ahead: 0, behind: 0 };
  const changes = [];
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  let complete = false;
  let totalChanges = 0;
  let rename = null;

  const append = (change) => {
    totalChanges += 1;
    if (change.staged) counts.staged += 1;
    if (change.unstaged) counts.unstaged += 1;
    if (change.untracked) counts.untracked += 1;
    if (change.conflicted) counts.conflicted += 1;
    if (changes.length < GIT_CHANGE_LIMIT) changes.push(change);
    return change;
  };

  for (const record of String(output || "").split("\0")) {
    if (!record) continue;
    if (rename) {
      rename.previousPath = record;
      rename = null;
      continue;
    }
    if (record === "# easywork.end") {
      complete = true;
      continue;
    }
    if (record.startsWith("## ")) {
      const value = record.slice(3);
      const unborn = /^(?:No commits yet|Initial commit) on /.exec(value);
      if (unborn) {
        branch.unborn = true;
        branch.name = value.slice(unborn[0].length) || null;
        continue;
      }
      if (/^HEAD (?:\(no branch\)|\(detached)/.test(value)) {
        branch.detached = true;
        branch.name = null;
        continue;
      }
      const tracking = value.match(/^(.*?)\.\.\.([^\s]+)(?:\s+\[(.*?)\])?$/);
      branch.name = (tracking ? tracking[1] : value).trim() || null;
      branch.upstream = tracking?.[2] || null;
      const ahead = tracking?.[3]?.match(/ahead (\d+)/);
      const behind = tracking?.[3]?.match(/behind (\d+)/);
      branch.ahead = ahead ? Number(ahead[1]) : 0;
      branch.behind = behind ? Number(behind[1]) : 0;
      continue;
    }
    if (record.startsWith("# branch.")) {
      const separator = record.indexOf(" ", 2);
      const key = record.slice(2, separator);
      const value = separator < 0 ? "" : record.slice(separator + 1);
      if (key === "branch.oid") {
        branch.unborn = value === "(initial)";
        branch.oid = branch.unborn ? null : value;
      } else if (key === "branch.head") {
        branch.detached = value === "(detached)";
        branch.name = branch.detached ? null : value;
      } else if (key === "branch.upstream") branch.upstream = value || null;
      else if (key === "branch.ab") {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(value);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }

    if (record.startsWith("? ") || record.startsWith("?? ")) {
      append({ path: record.slice(record.startsWith("?? ") ? 3 : 2), previousPath: null, indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: false, untracked: true, conflicted: false });
      continue;
    }
    if (record.startsWith("! ") || record.startsWith("!! ")) continue;

    const kind = record[0];
    const versionTwo = ["1", "2", "u"].includes(kind) && record[1] === " ";
    const versionOne = !versionTwo && record.length >= 4 && record[2] === " ";
    if (!versionTwo && !versionOne) continue;
    const xy = (versionTwo ? record.slice(2, 4) : record.slice(0, 2)).replace(/ /g, ".");
    const conflicted = kind === "u" || /U/.test(xy) || ["DD", "AA"].includes(xy);
    const change = append({
      path: versionOne ? record.slice(3) : porcelainPath(record, kind === "1" ? 8 : kind === "2" ? 9 : 10),
      previousPath: null,
      indexStatus: xy[0] || ".",
      worktreeStatus: xy[1] || ".",
      staged: !conflicted && Boolean(xy[0] && xy[0] !== "."),
      unstaged: !conflicted && Boolean(xy[1] && xy[1] !== "."),
      untracked: false,
      conflicted,
    });
    if (kind === "2" || (versionOne && /[RC]/.test(xy))) rename = change;
  }

  return {
    branch,
    changes,
    counts,
    clean: complete && totalChanges === 0,
    changesTruncated: !complete || totalChanges > changes.length,
  };
}

function parseGitCommits(output) {
  return String(output || "").split("\x1e").map((record) => record.replace(/^[\r\n]+|[\r\n]+$/g, "")).filter(Boolean).map((record) => {
    const [id = "", shortId = "", author = "", authoredValue = "", decorationValue = "", subject = ""] = record.split("\x1f");
    const authoredSeconds = Number(authoredValue);
    const authoredAt = Number.isSafeInteger(authoredSeconds) && authoredSeconds >= 0 ? new Date(authoredSeconds * 1_000).toISOString() : authoredValue;
    const decorations = decorationValue.trim().replace(/^\((.*)\)$/, "$1");
    return { id, shortId, author, authoredAt, decorations, subject };
  }).filter((commit) => /^[0-9a-f]{40}$/i.test(commit.id));
}

async function replaceSftpFile(sftp, temporary, target) {
  if (typeof sftp.ext_openssh_rename === "function") {
    try {
      await sftpCall(sftp, "ext_openssh_rename", temporary, target);
      return;
    } catch (error) {
      if (!canFallbackFromPosixRename(error)) throw error;
    }
  }

  const backup = `${target}.easywork-backup-${crypto.randomBytes(8).toString("hex")}`;
  let hasBackup = false;
  try {
    try {
      await sftpCall(sftp, "rename", target, backup);
      hasBackup = true;
    } catch (error) {
      if (!missingSftpEntry(error)) throw error;
    }
    await sftpCall(sftp, "rename", temporary, target);
  } catch (error) {
    if (hasBackup) {
      try {
        await sftpCall(sftp, "rename", backup, target);
        hasBackup = false;
      } catch (restoreError) {
        throw new ApiError("REMOTE_FILE_REPLACE_RECOVERY_FAILED", "远端文件更新失败，原文件已保留为恢复副本", {
          status: 502,
          retryable: false,
          expose: true,
          cause: error,
          details: { replaceCode: error?.code || null, restoreCode: restoreError?.code || null },
        });
      }
    }
    throw error;
  }
  if (hasBackup) {
    try { await sftpCall(sftp, "unlink", backup); } catch { /* committed target remains authoritative */ }
  }
}

class WorkerBoundAgentExecutor {
  constructor({ worker, serverId, proxyFactory = null }) {
    this.worker = worker;
    this.serverId = serverId;
    this.proxyFactory = proxyFactory;
    this.cachedHome = null;
    this.cachedSftp = null;
    this.cachedSftpSession = null;
    this.pendingSftp = null;
    this.sftpOperations = Promise.resolve();
  }

  async #invoke(method, args) {
    return this.worker.withSession(this.serverId, async (session) => {
      const executor = new SshAgentExecutor({ session, proxyFactory: this.proxyFactory });
      if (this.cachedHome) executor.cachedHome = this.cachedHome;
      const result = await executor[method](...args);
      if (executor.cachedHome) this.cachedHome = executor.cachedHome;
      return result;
    });
  }

  home() { return this.#invoke("home", []); }
  exec(command, options = {}) { return this.#invoke("exec", [command, options]); }
  upload(localPath, remotePath) { return this.#invoke("upload", [localPath, remotePath]); }
  async writeAtomic(remotePath, content, { mode = 0o600, parentPrepared = false } = {}) {
    if (!parentPrepared) await this.exec(`mkdir -p ${shellQuote(path.posix.dirname(remotePath))}`);
    const temporary = `${remotePath}.write-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await this.withSftp((sftp) => sftpCall(sftp, "writeFile", temporary, Buffer.isBuffer(content) ? content : Buffer.from(String(content)), { mode }));
    } catch (error) {
      await this.withSftp(async (sftp) => { try { await sftpCall(sftp, "unlink", temporary); } catch { /* best effort */ } }).catch(() => undefined);
      throw error;
    }
    const replaced = await this.exec(`chmod ${Number(mode).toString(8)} -- ${shellQuote(temporary)} && mv -f -- ${shellQuote(temporary)} ${shellQuote(remotePath)}`);
    if (replaced.code !== 0) {
      await this.exec(`rm -f -- ${shellQuote(temporary)}`).catch(() => undefined);
      throw new ApiError("AGENT_REMOTE_ATOMIC_WRITE_FAILED", "无法原子更新远端 EasyWork 文件", {
        status: 502,
        details: { exitCode: replaced.code },
      });
    }
  }
  readFile(remotePath) {
    return this.withSftp(async (sftp) => Buffer.from(await sftpCall(sftp, "readFile", remotePath)));
  }
  spawn(specification) { return this.#invoke("spawn", [specification]); }
  spawnDetached(specification) { return this.#invoke("spawnDetached", [specification]); }
  requestHttp(request) { return this.#invoke("requestHttp", [request]); }
  openHttpEventStream(request) { return this.#invoke("openHttpEventStream", [request]); }
  probeTcp(request) { return this.#invoke("probeTcp", [request]); }
  openLoopbackProxy(request) { return this.#invoke("openLoopbackProxy", [request]); }

  withSftp(operation) {
    invariant(typeof operation === "function", "SFTP_OPERATION_REQUIRED", "SFTP 操作无效", { status: 500, expose: false });
    // ssh2 supports multiple requests on one SFTP channel, but closing that
    // shared channel after one failed request can strand the callbacks of the
    // other in-flight requests forever. EasyWork metadata operations are
    // small; serialize them on the reused channel so a failure can invalidate
    // it without leaving version/configuration/startup promises unresolved.
    const run = this.sftpOperations.then(() => this.#withSftpCurrent(operation));
    this.sftpOperations = run.then(() => undefined, () => undefined);
    return run;
  }

  #withSftpCurrent(operation) {
    return this.worker.withSession(this.serverId, async (session) => {
      if (this.cachedSftpSession !== session) {
        this.cachedSftp?.end?.();
        this.cachedSftp = null;
        this.cachedSftpSession = session;
        this.pendingSftp = null;
      }
      if (!this.cachedSftp) {
        this.pendingSftp ||= session.sftp().then((sftp) => {
          this.cachedSftp = sftp;
          return sftp;
        }).finally(() => { this.pendingSftp = null; });
        await this.pendingSftp;
      }
      const sftp = this.cachedSftp;
      try { return await operation(sftp); }
      catch (error) {
        if (this.cachedSftp === sftp) {
          this.cachedSftp = null;
          this.cachedSftpSession = null;
          sftp?.end?.();
        }
        throw error;
      }
    });
  }

  close() {
    this.cachedSftp?.end?.();
    this.cachedSftp = null;
    this.cachedSftpSession = null;
    this.pendingSftp = null;
    this.sftpOperations = Promise.resolve();
  }

  openReadStream(remotePath, options = {}) {
    const output = new PassThrough();
    this.worker.withSession(this.serverId, async (session) => {
      const sftp = await session.sftp();
      try {
        if (output.destroyed) return;
        await pipeline(sftp.createReadStream(remotePath, options), output);
      } finally {
        sftp.end?.();
      }
    }).catch((error) => output.destroy(error));
    return output;
  }
}

class SshRemoteControl {
  constructor(executor) {
    this.executor = executor;
    this.preparedDirectories = new Map();
  }

  async resolveEasyWork(relative) {
    const safe = ensureRelative(relative, "EasyWork 远端路径");
    return `${await this.executor.home()}/.easywork/${safe}`;
  }

  async canonicalize(candidate) {
    const result = await this.executor.exec(`readlink -f -- ${shellQuote(candidate)}`, { maxOutputBytes: 32 * 1024 });
    invariant(result.code === 0 && String(result.stdout).trim().startsWith("/"), "REMOTE_PATH_NOT_FOUND", "远端路径不存在或不可访问", { status: 404 });
    return path.posix.normalize(String(result.stdout).trim());
  }

  async listHomeDirectories(candidate = null) {
    const home = await this.executor.home();
    const requested = candidate ? String(candidate) : home;
    const canonical = await this.canonicalize(requested);
    invariant(canonical === home || canonical.startsWith(`${home}/`), "REMOTE_DIRECTORY_OUTSIDE_HOME", "只能选择用户主目录中的文件夹", { status: 403 });
    const entries = await this.executor.withSftp((sftp) => sftpCall(sftp, "readdir", canonical));
    const directories = entries
      .filter((entry) => ![".", ".."].includes(entry.filename) && entry.attrs?.isDirectory?.() && !entry.attrs?.isSymbolicLink?.())
      .map((entry) => ({ name: entry.filename, path: path.posix.join(canonical, entry.filename) }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return {
      home,
      path: canonical,
      parent: canonical === home ? null : path.posix.dirname(canonical),
      directories,
    };
  }

  async createHomeDirectory(input = {}) {
    const home = await this.executor.home();
    const parent = await this.canonicalize(input.parent || home);
    invariant(parent === home || parent.startsWith(`${home}/`), "REMOTE_DIRECTORY_OUTSIDE_HOME", "只能在用户主目录中创建文件夹", { status: 403 });
    const name = String(input.name || "").trim();
    invariant(name && name !== "." && name !== ".." && !/[\\/\0]/.test(name) && path.posix.basename(name) === name, "REMOTE_DIRECTORY_NAME_INVALID", "文件夹名称无效", { status: 400 });
    const destination = path.posix.join(parent, name);
    try {
      await this.executor.withSftp((sftp) => sftpCall(sftp, "lstat", destination));
      invariant(false, "REMOTE_DIRECTORY_EXISTS", "同名文件或文件夹已经存在", { status: 409 });
    } catch (error) {
      if (!missingSftpEntry(error)) throw error;
    }
    await this.executor.withSftp((sftp) => sftpCall(sftp, "mkdir", destination, { mode: 0o700 }));
    return this.listHomeDirectories(parent);
  }

  async ensureDirectory(directory) {
    const key = path.posix.normalize(String(directory || ""));
    const existing = this.preparedDirectories.get(key);
    if (existing) return existing;
    const pending = this.executor.exec(`mkdir -p -- ${shellQuote(key)} && chmod 0700 -- ${shellQuote(key)}`, { maxOutputBytes: 16 * 1024 })
      .then((result) => {
        invariant(result.code === 0, "REMOTE_DIRECTORY_CREATE_FAILED", "无法创建远端 EasyWork 目录", { status: 502 });
      });
    this.preparedDirectories.set(key, pending);
    try { return await pending; }
    catch (error) {
      if (this.preparedDirectories.get(key) === pending) this.preparedDirectories.delete(key);
      throw error;
    }
  }

  async writeJsonAtomic(file, value) {
    // Workspace/binding metadata is on the dispatch critical path.  Keep
    // these tiny control-plane writes independent from the shared SFTP lane,
    // which may legitimately be busy snapshotting a large Agent-edited file.
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    invariant(bytes.length <= 64 * 1024, "REMOTE_CONTROL_JSON_TOO_LARGE", "远端 EasyWork 控制信息过大", { status: 500, expose: false });
    const temporary = `${file}.write-${crypto.randomBytes(6).toString("hex")}`;
    const encoded = bytes.toString("base64");
    const result = await this.executor.exec(
      `umask 077; printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(temporary)} && chmod 0600 -- ${shellQuote(temporary)} && mv -f -- ${shellQuote(temporary)} ${shellQuote(file)}`,
      { maxOutputBytes: 16 * 1024 },
    );
    if (result.code !== 0) {
      await this.executor.exec(`rm -f -- ${shellQuote(temporary)}`, { maxOutputBytes: 16 * 1024 }).catch(() => undefined);
      throw new ApiError("REMOTE_CONTROL_ATOMIC_WRITE_FAILED", "无法原子更新远端 EasyWork 控制信息", {
        status: 502,
        details: { exitCode: result.code },
      });
    }
  }
}

class SshRemoteFiles {
  constructor({ executor, container, serverId, serverIdentity, limits = {} }) {
    this.executor = executor;
    this.container = container;
    this.serverId = serverId;
    this.serverIdentity = serverIdentity;
    this.limits = normalizeRemoteFileLimits(limits);
    this.workspaceRoots = new Map();
  }

  capabilities() {
    return Object.freeze({
      list: true,
      git: true,
      upload: true,
      download: true,
      range: true,
      mkdir: true,
      create: true,
      copy: true,
      rename: true,
      delete: true,
      maxUploadBytes: this.limits.maxUploadBytes,
      maxDownloadBytes: this.limits.maxDownloadBytes,
    });
  }

  async #workspace(workspaceId) {
    invariant(this.container?.actor?.actorId && typeof this.container.workspaceFor === "function", "REMOTE_FILE_SCOPE_UNAVAILABLE", "远端文件缺少工作区授权上下文", { status: 503 });
    const service = await this.container.workspaceFor(this.serverId, this.serverIdentity);
    const workspace = await service.getWorkspace(String(workspaceId || ""));
    invariant(workspace.actorId === this.container.actor.actorId && workspace.serverIdentity === this.serverIdentity, "REMOTE_FILE_WORKSPACE_FORBIDDEN", "工作区不属于当前 Actor 或服务器", { status: 403 });
    const cacheKey = `${workspace.id || workspaceId}:${workspace.canonicalPath}`;
    let root = this.workspaceRoots.get(cacheKey);
    if (!root) {
      root = await new SshRemoteControl(this.executor).canonicalize(workspace.canonicalPath);
      this.workspaceRoots.set(cacheKey, root);
    }
    return { workspace, root };
  }

  #inside(root, candidate) {
    invariant(candidate === root || candidate.startsWith(`${root}/`), "REMOTE_FILE_OUTSIDE_WORKSPACE", "文件路径超出当前工作区", { status: 403 });
    return candidate;
  }

  async #lstat(candidate) {
    return this.executor.withSftp((sftp) => sftpCall(sftp, "lstat", candidate));
  }

  async #existing(input, { allowRoot = false, allowSymlink = false } = {}) {
    const relativePath = ensureRelative(input?.path, "远端文件路径", { allowRoot });
    const { workspace, root } = await this.#workspace(input?.workspaceId);
    const lexical = relativePath ? path.posix.join(root, relativePath) : root;
    const attributes = await this.#lstat(lexical);
    const symlink = Boolean(attributes?.isSymbolicLink?.());
    invariant(!symlink || allowSymlink, "REMOTE_FILE_SYMLINK_FORBIDDEN", "符号链接不能作为文件操作目标", { status: 403 });
    const canonical = symlink ? lexical : this.#inside(root, await new SshRemoteControl(this.executor).canonicalize(lexical));
    return { workspace, root, relativePath, canonical, attributes };
  }

  async #missing(input) {
    const relativePath = ensureRelative(input?.path, "远端文件路径");
    const { workspace, root } = await this.#workspace(input?.workspaceId);
    const lexical = path.posix.join(root, relativePath);
    const parent = this.#inside(root, await new SshRemoteControl(this.executor).canonicalize(path.posix.dirname(lexical)));
    const canonical = this.#inside(root, path.posix.join(parent, path.posix.basename(lexical)));
    return { workspace, root, relativePath, canonical };
  }

  async #assertWritableTarget(input) {
    const target = await this.#missing(input);
    try {
      const attributes = await this.#lstat(target.canonical);
      invariant(!attributes?.isSymbolicLink?.(), "REMOTE_FILE_SYMLINK_FORBIDDEN", "符号链接不能作为文件操作目标", { status: 403 });
      invariant(!attributes?.isDirectory?.(), "REMOTE_FILE_TARGET_IS_DIRECTORY", "文件上传目标不能是目录", { status: 409 });
    } catch (error) {
      if (!missingSftpEntry(error)) throw error;
    }
    return target;
  }

  async list(input = {}) {
    const { relativePath, canonical: directory, attributes } = await this.#existing(input, { allowRoot: true });
    invariant(attributes?.isDirectory?.(), "REMOTE_FILE_NOT_DIRECTORY", "目标不是目录", { status: 409 });
    const entries = await this.executor.withSftp((sftp) => sftpCall(sftp, "readdir", directory));
    return {
      path: relativePath,
      workspaceId: String(input.workspaceId),
      items: entries
        .filter((entry) => ![".", ".."].includes(entry.filename))
        .map((entry) => ({
          name: String(entry.filename),
          path: path.posix.join(relativePath, entry.filename),
          kind: entry.attrs?.isDirectory?.() ? "directory" : entry.attrs?.isSymbolicLink?.() ? "symlink" : "file",
          size: Number(entry.attrs?.size || 0),
          modifiedAt: Number(entry.attrs?.mtime) ? new Date(Number(entry.attrs.mtime) * 1000).toISOString() : null,
          mode: Number(entry.attrs?.mode || 0),
        }))
        .sort((left, right) => (left.kind === "directory" ? -1 : 1) - (right.kind === "directory" ? -1 : 1) || left.name.localeCompare(right.name)),
      nextCursor: null,
    };
  }

  async gitStatus(input = {}) {
    const { workspace, root } = await this.#workspace(input?.workspaceId);
    const inWorkspace = `cd ${shellQuote(root)} &&`;
    const probe = await this.executor.exec(`${inWorkspace} LC_ALL=C git rev-parse --show-toplevel`, { maxOutputBytes: 64 * 1024 });
    const stderr = String(probe.stderr || "");
    if (probe.code === 127 || /(?:git:\s*(?:command )?not found|git:\s*not found)/i.test(stderr)) {
      return { workspaceId: workspace.id, available: false, repository: false };
    }
    if (probe.code !== 0 && /not a git repository/i.test(stderr)) {
      return { workspaceId: workspace.id, available: true, repository: false };
    }
    invariant(probe.code === 0, "REMOTE_GIT_STATUS_FAILED", "无法读取当前工作区的 Git 状态", {
      status: 502,
      details: { exitCode: probe.code },
    });

    const repositoryRoot = path.posix.normalize(String(probe.stdout || "").trim());
    invariant(path.posix.isAbsolute(repositoryRoot), "REMOTE_GIT_STATUS_INVALID", "远端 Git 返回了无效的仓库路径", { status: 502, expose: false });
    const statusCommand = `${inWorkspace} { LC_ALL=C git status --porcelain -z --branch --untracked-files=all -- .; printf '\\000# easywork.end\\000'; } | head -c ${GIT_STATUS_CAPTURE_BYTES}`;
    const historyCommand = `${inWorkspace} LC_ALL=C git log -n ${GIT_COMMIT_LIMIT} --format='%H%x1f%h%x1f%an%x1f%at%x1f%d%x1f%s%x1e' -- .`;
    const oidCommand = `${inWorkspace} LC_ALL=C git rev-parse --verify HEAD`;
    const [statusResult, historyResult, oidResult] = await Promise.all([
      this.executor.exec(statusCommand, { maxOutputBytes: GIT_STATUS_CAPTURE_BYTES + 1024 }),
      this.executor.exec(historyCommand, { maxOutputBytes: GIT_STATUS_CAPTURE_BYTES }),
      this.executor.exec(oidCommand, { maxOutputBytes: 64 * 1024 }),
    ]);
    invariant(statusResult.code === 0, "REMOTE_GIT_STATUS_FAILED", "无法读取当前工作区的 Git 状态", { status: 502, details: { exitCode: statusResult.code } });
    const parsed = parseGitStatus(statusResult.stdout);
    const oid = oidResult.code === 0 && /^[0-9a-f]{40}$/i.test(String(oidResult.stdout || "").trim()) ? String(oidResult.stdout).trim() : null;
    parsed.branch.oid = oid;
    parsed.branch.unborn = !oid;
    invariant(historyResult.code === 0 || parsed.branch.unborn, "REMOTE_GIT_HISTORY_FAILED", "无法读取当前工作区的 Git 提交历史", { status: 502, details: { exitCode: historyResult.code } });
    return {
      workspaceId: workspace.id,
      available: true,
      repository: true,
      workspaceAtRepositoryRoot: repositoryRoot === root,
      ...parsed,
      commits: parseGitCommits(historyResult.stdout),
    };
  }

  async uploadStream(input) {
    invariant(input?.source && typeof input.source.pipe === "function", "REMOTE_FILE_STREAM_REQUIRED", "上传文件缺少二进制流", { status: 400 });
    const expectedSize = Number(input.expectedSize);
    invariant(Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize <= this.limits.maxUploadBytes, "REMOTE_FILE_TOO_LARGE", "远端文件超过上传上限", { status: expectedSize > this.limits.maxUploadBytes ? 413 : 400, details: { maxBytes: this.limits.maxUploadBytes } });
    const expectedSha256 = input.expectedSha256 ? String(input.expectedSha256).toLowerCase() : null;
    invariant(!expectedSha256 || /^[a-f0-9]{64}$/.test(expectedSha256), "REMOTE_FILE_HASH_INVALID", "上传文件 SHA-256 无效", { status: 400 });
    const target = await this.#assertWritableTarget(input);
    const temporary = `${target.canonical}.easywork-upload-${crypto.randomBytes(8).toString("hex")}`;
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > this.limits.maxUploadBytes || size > expectedSize) {
          callback(Object.assign(new Error("上传内容超过声明大小或平台上限"), { code: "REMOTE_FILE_TOO_LARGE", status: 413 }));
          return;
        }
        hash.update(bytes);
        callback(null, bytes);
      },
    });
    try {
      await this.executor.withSftp(async (sftp) => {
        await pipeline(input.source, meter, sftp.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
        invariant(size === expectedSize, "REMOTE_FILE_SIZE_MISMATCH", "上传文件大小与声明不一致", { status: 400, details: { expectedSize, actualSize: size } });
        const sha256 = hash.digest("hex");
        invariant(!expectedSha256 || sha256 === expectedSha256, "REMOTE_FILE_HASH_MISMATCH", "上传文件 SHA-256 校验失败", { status: 400 });
        await replaceSftpFile(sftp, temporary, target.canonical);
        target.sha256 = sha256;
      });
    } catch (error) {
      await this.executor.withSftp(async (sftp) => {
        try { await sftpCall(sftp, "unlink", temporary); } catch { /* best effort */ }
      }).catch(() => undefined);
      throw error;
    }
    return { workspaceId: String(input.workspaceId), path: target.relativePath, size, sha256: target.sha256 };
  }

  async inspectDownload(input) {
    const target = await this.#existing(input, { allowSymlink: true });
    const canonicalPath = target.attributes?.isSymbolicLink?.()
      ? this.#inside(target.root, await new SshRemoteControl(this.executor).canonicalize(target.canonical))
      : target.canonical;
    const attributes = canonicalPath === target.canonical ? target.attributes : await this.#lstat(canonicalPath);
    invariant(attributes?.isFile?.() === true && !attributes?.isSymbolicLink?.(), "REMOTE_FILE_NOT_REGULAR", "下载目标必须是普通文件", { status: 409 });
    const size = Number(attributes?.size);
    invariant(Number.isSafeInteger(size) && size >= 0 && size <= this.limits.maxDownloadBytes, "REMOTE_FILE_TOO_LARGE", "远端文件超过下载上限", { status: size > this.limits.maxDownloadBytes ? 413 : 502, details: { maxBytes: this.limits.maxDownloadBytes } });
    const digest = await this.executor.exec(`sha256sum -- ${shellQuote(canonicalPath)} | cut -d' ' -f1`, { maxOutputBytes: 1024 });
    const sha256 = String(digest.stdout || "").trim().toLowerCase();
    invariant(digest.code === 0 && /^[a-f0-9]{64}$/.test(sha256), "REMOTE_FILE_HASH_UNAVAILABLE", "无法校验远端文件 SHA-256", { status: 502 });
    return { workspaceId: String(input.workspaceId), path: target.relativePath, canonicalPath, name: path.posix.basename(target.relativePath), size, sha256 };
  }

  openDownloadStream(descriptor, range) {
    const start = range?.start ?? 0;
    const endExclusive = range?.endExclusive ?? descriptor.size;
    invariant(Number.isSafeInteger(start) && Number.isSafeInteger(endExclusive) && start >= 0 && endExclusive >= start && endExclusive <= descriptor.size, "REMOTE_FILE_RANGE_INVALID", "Range 请求超出远端文件大小", { status: 416, details: { size: descriptor.size } });
    if (descriptor.size === 0) {
      const empty = new PassThrough();
      empty.end();
      return empty;
    }
    const expectedBytes = endExclusive - start;
    const verifyFullHash = start === 0 && endExclusive === descriptor.size;
    const hash = verifyFullHash ? crypto.createHash("sha256") : null;
    let transferred = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.from(chunk);
        transferred += bytes.length;
        hash?.update(bytes);
        callback(null, bytes);
      },
      flush(callback) {
        if (transferred !== expectedBytes) {
          callback(Object.assign(new Error("远端文件在下载期间发生变化"), { code: "REMOTE_FILE_SIZE_CHANGED", status: 409 }));
          return;
        }
        if (hash && hash.digest("hex") !== descriptor.sha256) {
          callback(Object.assign(new Error("远端文件在下载期间发生变化"), { code: "REMOTE_FILE_HASH_CHANGED", status: 409 }));
          return;
        }
        callback();
      },
    });
    const source = this.executor.openReadStream(descriptor.canonicalPath, { start, end: endExclusive - 1 });
    void pipeline(source, verifier).catch((error) => verifier.destroy(error));
    return verifier;
  }

  async mkdir(input) {
    const target = await this.#missing(input);
    await this.executor.withSftp((sftp) => sftpCall(sftp, "mkdir", target.canonical, { mode: 0o700 }));
    return { workspaceId: String(input.workspaceId), path: target.relativePath, kind: "directory" };
  }

  async createFile(input) {
    const target = await this.#missing(input);
    try {
      await this.#lstat(target.canonical);
      invariant(false, "REMOTE_FILE_DESTINATION_EXISTS", "同名文件或文件夹已经存在", { status: 409 });
    } catch (error) {
      if (!missingSftpEntry(error)) throw error;
    }
    await this.executor.withSftp((sftp) => sftpCall(sftp, "writeFile", target.canonical, Buffer.alloc(0), { flag: "wx", mode: 0o600 }));
    return { workspaceId: String(input.workspaceId), path: target.relativePath, kind: "file", size: 0 };
  }

  async copy(input) {
    const source = await this.#existing({ workspaceId: input?.workspaceId, path: input?.path }, { allowSymlink: true });
    const destination = await this.#missing({ workspaceId: input?.workspaceId, path: input?.destination });
    invariant(source.root === destination.root, "REMOTE_FILE_WORKSPACE_MISMATCH", "文件复制不能跨工作区", { status: 403 });
    invariant(!source.attributes?.isDirectory?.() || !destination.canonical.startsWith(`${source.canonical}/`), "REMOTE_FILE_COPY_RECURSIVE", "不能把文件夹复制到自身内部", { status: 409 });
    try {
      await this.#lstat(destination.canonical);
      invariant(false, "REMOTE_FILE_DESTINATION_EXISTS", "目标名称已经存在", { status: 409 });
    } catch (error) {
      if (!missingSftpEntry(error)) throw error;
    }
    const result = await this.executor.exec(`test ! -e ${shellQuote(destination.canonical)} && cp -a -- ${shellQuote(source.canonical)} ${shellQuote(destination.canonical)}`, { maxOutputBytes: 64 * 1024 });
    invariant(result.code === 0, "REMOTE_FILE_COPY_FAILED", "复制远端文件失败", { status: 502, details: { stderr: String(result.stderr || "").slice(0, 2_000) } });
    return { workspaceId: String(input.workspaceId), from: source.relativePath, path: destination.relativePath, copied: true };
  }

  async rename(input) {
    const source = await this.#existing({ workspaceId: input?.workspaceId, path: input?.path }, { allowSymlink: true });
    const destination = await this.#missing({ workspaceId: input?.workspaceId, path: input?.destination });
    invariant(source.root === destination.root, "REMOTE_FILE_WORKSPACE_MISMATCH", "文件重命名不能跨工作区", { status: 403 });
    try {
      await this.#lstat(destination.canonical);
      invariant(false, "REMOTE_FILE_DESTINATION_EXISTS", "目标名称已经存在", { status: 409 });
    } catch (error) {
      if (!missingSftpEntry(error)) throw error;
    }
    await this.executor.withSftp((sftp) => sftpCall(sftp, "rename", source.canonical, destination.canonical));
    return { workspaceId: String(input.workspaceId), from: source.relativePath, path: destination.relativePath };
  }

  async delete(input) {
    const target = await this.#existing({ workspaceId: input?.workspaceId, path: input?.path }, { allowSymlink: true });
    invariant(input?.confirmation === target.relativePath, "REMOTE_FILE_DELETE_CONFIRMATION_REQUIRED", "删除确认与目标路径不一致", { status: 409 });
    const recursive = input?.recursive === true;
    await this.executor.withSftp(async (sftp) => {
      const remove = async (candidate, attributes) => {
        if (!attributes?.isDirectory?.() || attributes?.isSymbolicLink?.()) {
          await sftpCall(sftp, "unlink", candidate);
          return;
        }
        const entries = await sftpCall(sftp, "readdir", candidate);
        invariant(recursive || entries.filter((entry) => ![".", ".."].includes(entry.filename)).length === 0, "REMOTE_FILE_DIRECTORY_NOT_EMPTY", "目录不为空，需要确认递归删除", { status: 409 });
        for (const entry of entries.filter((item) => ![".", ".."].includes(item.filename))) {
          await remove(path.posix.join(candidate, entry.filename), entry.attrs);
        }
        await sftpCall(sftp, "rmdir", candidate);
      };
      await remove(target.canonical, target.attributes);
    });
    return { workspaceId: String(input.workspaceId), path: target.relativePath, deleted: true };
  }
}

class SshSchedulerExecutor {
  constructor(executor) {
    this.executor = executor;
  }

  async run(descriptor) {
    // Capability discovery intentionally issues independent probes in
    // parallel.  The SSH transport already owns the per-connection channel
    // limit and queues excess channels, so serialising again here turned the
    // seven inexpensive Slurm probes into a worst-case 35 second waterfall.
    // Keep scheduler mutations serialised in SchedulerService's actor queue,
    // but allow independent reads/probes to use the transport's bounded
    // concurrency.
    return this.#run(descriptor);
  }

  async #run(descriptor) {
    const schedulerCommand = [descriptor.executable, ...(descriptor.argv || [])].map(shellQuote).join(" ");
    // Scheduler clients are commonly injected by /etc/profile or the user's
    // login profile. ssh2 exec channels are non-login shells, so invoking the
    // command directly can report `sinfo`/`squeue` as missing even though the
    // same user can run them in an interactive terminal.
    const commandBody = descriptor.cwd
      ? `cd -- ${shellQuote(descriptor.cwd)} && ${schedulerCommand}`
      : schedulerCommand;
    const command = `bash -lc ${shellQuote(commandBody)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), descriptor.timeoutMs);
    try {
      const result = await this.executor.exec(command, { maxOutputBytes: descriptor.maxOutputBytes, signal: controller.signal });
      return { code: Number.isInteger(result.code) ? result.code : 1, stdout: Buffer.from(result.stdout || ""), stderr: Buffer.from(result.stderr || "") };
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return { code: 124, stdout: Buffer.alloc(0), stderr: Buffer.from(`Scheduler command timed out after ${descriptor.timeoutMs}ms`) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async readRange(descriptor) {
    invariant(Number.isSafeInteger(descriptor.offset) && descriptor.offset >= 0 && Number.isSafeInteger(descriptor.maxBytes) && descriptor.maxBytes > 0, "SCHEDULER_LOG_RANGE_INVALID", "日志读取范围无效", { status: 400 });
    // One lookahead byte determines EOF without transferring the whole log.
    const stream = this.executor.openReadStream(descriptor.path, { start: descriptor.offset, end: descriptor.offset + descriptor.maxBytes });
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      invariant(length <= descriptor.maxBytes + 1, "SCHEDULER_LOG_RANGE_OVERFLOW", "远端日志返回超出请求范围", { status: 502 });
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks).subarray(0, descriptor.maxBytes);
    return { bytes, nextOffset: descriptor.offset + bytes.length, eof: length <= descriptor.maxBytes };
  }
}

class SshRemoteArtifactSource {
  constructor({ executor, container, serverId, serverIdentity }) {
    this.executor = executor;
    this.container = container;
    this.serverId = serverId;
    this.serverIdentity = serverIdentity;
  }

  async inspect(input) {
    const workspaceService = await this.container.workspaceFor(this.serverId, this.serverIdentity);
    const workspace = await workspaceService.getWorkspace(input.workspaceId);
    const control = new SshRemoteControl(this.executor);
    const [root, candidate] = await Promise.all([control.canonicalize(workspace.canonicalPath), control.canonicalize(input.candidatePath)]);
    const within = candidate === root || candidate.startsWith(`${root}/`);
    invariant(within, "ARTIFACT_REMOTE_PATH_FORBIDDEN", "Artifact 不在当前工作区", { status: 403 });
    const result = await this.executor.exec(`test -f ${shellQuote(candidate)} && stat -c '%s' ${shellQuote(candidate)} && sha256sum -- ${shellQuote(candidate)} | cut -d' ' -f1`, { maxOutputBytes: 32 * 1024 });
    invariant(result.code === 0, "ARTIFACT_REMOTE_NOT_FILE", "Artifact 必须是可读取的普通文件", { status: 409 });
    const [size, sha256] = String(result.stdout).trim().split(/\r?\n/);
    return {
      authorized: true,
      resolved: true,
      withinAllowedRoot: true,
      symlinkSafe: true,
      serverIdentity: this.serverIdentity,
      workspaceId: input.workspaceId,
      canonicalPath: candidate,
      name: path.posix.basename(candidate),
      size: Number(size),
      sha256,
      mime: "application/octet-stream",
    };
  }

  async openReadStream(input) {
    let target = input.canonicalPath;
    let snapshot = null;
    if (input.expectedSha256) {
      await this.verifyAvailable(input);
      const actorKey = crypto.createHash("sha256").update(String(input.actor?.actorId || this.container.actor.actorId)).digest("hex");
      const root = `${await this.executor.home()}/.easywork/downloads/${actorKey}`;
      snapshot = `${root}/${crypto.randomUUID()}`;
      try {
        const copied = await this.executor.exec(`umask 077; mkdir -p -- ${shellQuote(root)} && cp --reflink=auto -- ${shellQuote(target)} ${shellQuote(snapshot)} && chmod 0400 -- ${shellQuote(snapshot)} && stat -c '%s' -- ${shellQuote(snapshot)} && sha256sum -- ${shellQuote(snapshot)} | cut -d' ' -f1`, { maxOutputBytes: 2048 });
        const [size, digest] = String(copied.stdout || "").trim().split(/\r?\n/);
        invariant(copied.code === 0 && Number(size) === input.expectedSize && digest === input.expectedSha256, "ARTIFACT_REMOTE_CHANGED", "远端文件已发生变化，请重新生成下载链接", { status: 409 });
        target = snapshot;
      } catch (error) {
        await this.executor.exec(`rm -f -- ${shellQuote(snapshot)}`, { maxOutputBytes: 1024 }).catch(() => undefined);
        throw error;
      }
    }
    const output = new PassThrough();
    if (snapshot) output.once("close", () => {
      void this.executor.exec(`rm -f -- ${shellQuote(snapshot)}`, { maxOutputBytes: 1024 }).catch(() => undefined);
    });
    if (input.range.endExclusive <= input.range.start) {
      output.end();
      return output;
    }
    let source;
    try {
      source = this.executor.openReadStream(target, { start: input.range.start, end: input.range.endExclusive - 1 });
    } catch (error) {
      output.destroy();
      if (snapshot) await this.executor.exec(`rm -f -- ${shellQuote(snapshot)}`, { maxOutputBytes: 1024 }).catch(() => undefined);
      throw error;
    }
    const expectedBytes = input.range.endExclusive - input.range.start;
    const hash = input.expectedSha256 && input.range.start === 0 && input.range.endExclusive === input.expectedSize ? crypto.createHash("sha256") : null;
    let received = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) { received += chunk.length; hash?.update(chunk); callback(null, chunk); },
      flush(callback) {
        if (received !== expectedBytes || (hash && hash.digest("hex") !== input.expectedSha256)) {
          callback(Object.assign(new Error("下载内容校验失败，请重新生成下载链接"), { code: "ARTIFACT_REMOTE_CHANGED", status: 409 }));
        } else callback();
      },
    });
    void pipeline(source, verifier, output).catch((error) => output.destroy(error));
    return output;
  }

  async verifyAvailable(input) {
    const target = String(input.canonicalPath || "");
    invariant(target.startsWith("/") && !target.includes("\0"), "ARTIFACT_REMOTE_PATH_INVALID", "远端文件路径无效", { status: 400 });
    const command = [
      `if [ ! -e ${shellQuote(target)} ]; then exit 44; fi`,
      `if [ ! -f ${shellQuote(target)} ] || [ ! -r ${shellQuote(target)} ]; then exit 45; fi`,
      `stat -c '%s' -- ${shellQuote(target)}`,
      `sha256sum -- ${shellQuote(target)} | cut -d' ' -f1`,
    ].join("; ");
    const result = await this.executor.exec(command, { maxOutputBytes: 1024 });
    invariant(result.code !== 44, "ARTIFACT_REMOTE_DELETED", "文件已被删除", { status: 410 });
    invariant(result.code === 0, "ARTIFACT_REMOTE_UNREADABLE", "远端文件当前不可读取", { status: 409 });
    const [size, digest] = String(result.stdout || "").trim().split(/\r?\n/);
    const actualSize = Number(size);
    invariant(Number.isSafeInteger(actualSize) && actualSize >= 0, "ARTIFACT_REMOTE_INSPECTION_INVALID", "无法读取远端文件状态", { status: 502 });
    invariant(actualSize === Number(input.expectedSize), "ARTIFACT_REMOTE_CHANGED", "远端文件已发生变化，请重新生成下载链接", { status: 409 });
    invariant(/^[a-f0-9]{64}$/.test(String(input.expectedSha256 || "")) && digest === input.expectedSha256, "ARTIFACT_REMOTE_CHANGED", "远端文件内容已发生变化，请重新生成下载链接", { status: 409 });
    return { available: true, size: actualSize };
  }
}

export class RoutingAgentTransport {
  constructor(resolveTransport, resolveApiRoute = null) {
    this.resolveTransport = resolveTransport;
    this.resolveApiRoute = resolveApiRoute;
  }

  async execute(request) {
    const serverId = request?.task?.route?.serverId;
    invariant(serverId, "AGENT_ROUTE_SERVER_REQUIRED", "Agent 请求缺少 serverId", { status: 400 });
    const transport = await this.resolveTransport(serverId);
    const route = request?.task?.route;
    if (!this.resolveApiRoute || request.apiRoute || !route?.providerId || !route?.modelId) return transport.execute(request);
    const apiRoute = await this.resolveApiRoute({ request, serverId, providerId: route.providerId, modelId: route.modelId });
    invariant(apiRoute && typeof apiRoute === "object", "AGENT_API_ROUTE_RESOLUTION_FAILED", "无法解析 Agent 模型 API", { status: 500, expose: false });
    return transport.execute({ ...request, apiRoute });
  }

  async captureSkillSnapshot(request) {
    const transport = await this.resolveTransport(request.task.route.serverId);
    return transport.captureSkillSnapshot?.(request) || null;
  }

  async prepare(request) {
    const serverId = request?.task?.route?.serverId;
    invariant(serverId, "AGENT_ROUTE_SERVER_REQUIRED", "Agent 预备请求缺少 serverId", { status: 400 });
    const transport = await this.resolveTransport(serverId);
    invariant(typeof transport.prepare === "function", "AGENT_PREPARE_UNAVAILABLE", "远端 Agent transport 不支持并行预备", { status: 503 });
    const route = request?.task?.route;
    if (!this.resolveApiRoute || request.apiRoute || !route?.providerId || !route?.modelId) return transport.prepare(request);
    const apiRoute = await this.resolveApiRoute({ request, serverId, providerId: route.providerId, modelId: route.modelId });
    invariant(apiRoute && typeof apiRoute === "object", "AGENT_API_ROUTE_RESOLUTION_FAILED", "无法解析 Agent 模型 API", { status: 500, expose: false });
    return transport.prepare({ ...request, apiRoute });
  }
}

export async function createDefaultRemoteBackend({ serverId, serverIdentity, sshWorker, container, catalog, apiProxyFactory = null, remoteFileLimits = null }) {
  invariant(container?.actor?.actorId, "REMOTE_ACTOR_REQUIRED", "远端运行时缺少用户身份", { status: 500, expose: false });
  invariant(container?.runtime?.dataRoot && container?.broker?.append, "REMOTE_RUNTIME_SCOPE_REQUIRED", "远端运行时缺少隔离上下文", { status: 500, expose: false });
  invariant(/^ssh_[A-Za-z0-9_-]{43}$/.test(String(serverIdentity || "")), "REMOTE_SERVER_IDENTITY_REQUIRED", "远端运行时缺少服务器指纹", { status: 500, expose: false });
  const executor = new WorkerBoundAgentExecutor({ worker: sshWorker, serverId, proxyFactory: apiProxyFactory });
  const agentDeployment = new AgentDeploymentService({ catalog, executor });
  const agentConfiguration = new ManagedAgentConfiguration({
    executor,
    deploymentService: agentDeployment,
    actorId: container.actor.actorId,
    clock: container?.clock,
  });
  const skillDeployment = new SshSkillDeployment({
    executor,
    actor: container.actor,
    dataRoot: container.runtime.dataRoot,
    serverId,
    serverIdentity,
    clock: container.clock,
  });
  const conversationVersion = new SshConversationVersionBackend({ executor, actor: container.actor, serverIdentity });
  const terminal = new SshTerminalManager({ worker: sshWorker, serverId, serverIdentity, broker: container.broker, clock: container.clock });
  const agentTransport = new AgentRuntimeTransport({
    executor,
    deploymentService: agentDeployment,
    skillDeployment,
    configurationService: agentConfiguration,
    // The current OpenCode source exposes native fork/revert on /session.
    // Existing V2 bindings keep their persisted protocol; only new bindings
    // choose the native-history-capable route.
    openCodeDefaultProtocol: "v1",
  });
  return {
    executor,
    remoteControl: new SshRemoteControl(executor),
    remoteFiles: new SshRemoteFiles({
      executor,
      container,
      serverId,
      serverIdentity,
      limits: remoteFileLimits || container.runtime.remoteFileLimits || {},
    }),
    schedulerExecutor: new SshSchedulerExecutor(executor),
    systemMonitor: new SshSystemMonitor({ executor, clock: container.clock }),
    remoteArtifactSource: new SshRemoteArtifactSource({ executor, container, serverId, serverIdentity }),
    agentDeployment,
    agentConfiguration,
    agentTransport,
    skillDeployment,
    terminal,
    conversationVersion,
    remoteFs: conversationVersion,
    remoteExec: Object.freeze({}),
    capabilities: Object.freeze({
      terminal: Object.freeze({ state: "available", pty: true, resume: true }),
      versioning: Object.freeze({ state: "available", storage: "~/.easywork/versioning", eventLedger: true, isolated: true }),
      skills: Object.freeze({ state: "available", storage: "~/.easywork/skills" }),
    }),
    close: async () => {
      await Promise.allSettled([terminal?.closeAll(), agentTransport.close()]);
      executor.close();
    },
  };
}

export { normalizeRemoteFileLimits, SshRemoteArtifactSource, SshRemoteFiles, SshSchedulerExecutor, WorkerBoundAgentExecutor };
