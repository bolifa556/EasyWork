import crypto from "node:crypto";
import path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AgentDeploymentService, AgentRuntimeTransport, ManagedAgentConfiguration, SshAgentExecutor } from "../agent-runtime/index.mjs";
import { invariant } from "../errors.mjs";
import { SshShadowVersionBackend } from "./shadow-version-backend.mjs";
import { SshSkillDeployment } from "./skill-deployment.mjs";
import { SshTerminalManager } from "./terminal.mjs";

const DEFAULT_REMOTE_FILE_LIMITS = Object.freeze({
  maxUploadBytes: 1024 * 1024 * 1024,
  maxDownloadBytes: 1024 * 1024 * 1024,
});
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
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

class WorkerBoundAgentExecutor {
  constructor({ worker, serverId, proxyFactory = null }) {
    this.worker = worker;
    this.serverId = serverId;
    this.proxyFactory = proxyFactory;
    this.cachedHome = null;
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
  writeAtomic(remotePath, content, options = {}) { return this.#invoke("writeAtomic", [remotePath, content, options]); }
  readFile(remotePath) { return this.#invoke("readFile", [remotePath]); }
  spawn(specification) { return this.#invoke("spawn", [specification]); }
  spawnDetached(specification) { return this.#invoke("spawnDetached", [specification]); }
  requestHttp(request) { return this.#invoke("requestHttp", [request]); }
  openHttpEventStream(request) { return this.#invoke("openHttpEventStream", [request]); }
  probeTcp(request) { return this.#invoke("probeTcp", [request]); }
  openLoopbackProxy(request) { return this.#invoke("openLoopbackProxy", [request]); }

  withSftp(operation) {
    return this.worker.withSession(this.serverId, async (session) => {
      const sftp = await session.sftp();
      try { return await operation(sftp); } finally { sftp.end?.(); }
    });
  }

  openReadStream(remotePath, options = {}) {
    const output = new PassThrough();
    this.worker.withSession(this.serverId, async (session) => {
      const sftp = await session.sftp();
      try {
        await new Promise((resolve, reject) => {
          const stream = sftp.createReadStream(remotePath, options);
          const fail = (error) => { output.destroy(error); reject(error); };
          stream.once("error", fail);
          stream.once("end", resolve);
          output.once("close", () => {
            if (!output.writableEnded) stream.destroy();
          });
          stream.pipe(output);
        });
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

  async ensureDirectory(directory) {
    const result = await this.executor.exec(`mkdir -p -- ${shellQuote(directory)} && chmod 0700 -- ${shellQuote(directory)}`, { maxOutputBytes: 16 * 1024 });
    invariant(result.code === 0, "REMOTE_DIRECTORY_CREATE_FAILED", "无法创建远端 EasyWork 目录", { status: 502 });
  }

  async writeJsonAtomic(file, value) {
    await this.executor.writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

class SshRemoteFiles {
  constructor({ executor, container, serverId, serverIdentity, limits = {} }) {
    this.executor = executor;
    this.container = container;
    this.serverId = serverId;
    this.serverIdentity = serverIdentity;
    this.limits = normalizeRemoteFileLimits(limits);
  }

  capabilities() {
    return Object.freeze({
      list: true,
      upload: true,
      download: true,
      range: true,
      mkdir: true,
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
    const root = await new SshRemoteControl(this.executor).canonicalize(workspace.canonicalPath);
    return { workspace, root };
  }

  #inside(root, candidate) {
    invariant(candidate === root || candidate.startsWith(`${root}/`), "REMOTE_FILE_OUTSIDE_WORKSPACE", "文件路径超出当前工作区", { status: 403 });
    return candidate;
  }

  async #lstat(candidate) {
    return this.executor.withSftp((sftp) => sftpCall(sftp, "lstat", candidate));
  }

  async #existing(input, { allowRoot = false } = {}) {
    const relativePath = ensureRelative(input?.path, "远端文件路径", { allowRoot });
    const { workspace, root } = await this.#workspace(input?.workspaceId);
    const lexical = relativePath ? path.posix.join(root, relativePath) : root;
    const attributes = await this.#lstat(lexical);
    invariant(!attributes?.isSymbolicLink?.(), "REMOTE_FILE_SYMLINK_FORBIDDEN", "符号链接不能作为文件操作目标", { status: 403 });
    const canonical = this.#inside(root, await new SshRemoteControl(this.executor).canonicalize(lexical));
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
        await sftpCall(sftp, "rename", temporary, target.canonical);
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
    const target = await this.#existing(input);
    invariant(!target.attributes?.isDirectory?.(), "REMOTE_FILE_NOT_REGULAR", "下载目标必须是普通文件", { status: 409 });
    const size = Number(target.attributes?.size);
    invariant(Number.isSafeInteger(size) && size >= 0 && size <= this.limits.maxDownloadBytes, "REMOTE_FILE_TOO_LARGE", "远端文件超过下载上限", { status: size > this.limits.maxDownloadBytes ? 413 : 502, details: { maxBytes: this.limits.maxDownloadBytes } });
    const digest = await this.executor.exec(`sha256sum -- ${shellQuote(target.canonical)} | cut -d' ' -f1`, { maxOutputBytes: 1024 });
    const sha256 = String(digest.stdout || "").trim().toLowerCase();
    invariant(digest.code === 0 && /^[a-f0-9]{64}$/.test(sha256), "REMOTE_FILE_HASH_UNAVAILABLE", "无法校验远端文件 SHA-256", { status: 502 });
    return { workspaceId: String(input.workspaceId), path: target.relativePath, canonicalPath: target.canonical, name: path.posix.basename(target.relativePath), size, sha256 };
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
    source.once("error", (error) => verifier.destroy(error));
    return source.pipe(verifier);
  }

  async mkdir(input) {
    const target = await this.#missing(input);
    await this.executor.withSftp((sftp) => sftpCall(sftp, "mkdir", target.canonical, { mode: 0o700 }));
    return { workspaceId: String(input.workspaceId), path: target.relativePath, kind: "directory" };
  }

  async rename(input) {
    const source = await this.#existing({ workspaceId: input?.workspaceId, path: input?.path });
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
    const target = await this.#existing({ workspaceId: input?.workspaceId, path: input?.path });
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
  constructor(executor) { this.executor = executor; }

  async run(descriptor) {
    const command = [descriptor.executable, ...(descriptor.argv || [])].map(shellQuote).join(" ");
    const result = await this.executor.exec(command, { maxOutputBytes: descriptor.maxOutputBytes, signal: descriptor.signal });
    return { code: Number.isInteger(result.code) ? result.code : 1, stdout: Buffer.from(result.stdout || ""), stderr: Buffer.from(result.stderr || "") };
  }

  async readRange(descriptor) {
    const bytes = await this.executor.readFile(descriptor.path);
    const selected = bytes.subarray(descriptor.offset, descriptor.offset + descriptor.maxBytes);
    return { bytes: selected, nextOffset: descriptor.offset + selected.length, eof: descriptor.offset + selected.length >= bytes.length };
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
    const output = new PassThrough();
    this.executor.worker.withSession(this.executor.serverId, async (session) => {
      const sftp = await session.sftp();
      const stream = sftp.createReadStream(input.canonicalPath, {
        start: input.range.start,
        end: input.range.endExclusive - 1,
      });
      stream.once("error", (error) => output.destroy(error));
      stream.once("close", () => sftp.end?.());
      stream.pipe(output);
    }).catch((error) => output.destroy(error));
    return output;
  }
}

class SshVersionControlFacade {
  constructor({ container, serverId, serverIdentity, remoteFs }) {
    this.container = container;
    this.serverId = serverId;
    this.serverIdentity = serverIdentity;
    this.remoteFs = remoteFs;
  }

  async status(input = {}) {
    const resolved = await this.#resolve(input);
    if (!resolved.state) return {
      workspace: {
        id: resolved.workspace.id,
        canonicalPath: resolved.workspace.canonicalPath,
        kind: resolved.workspace.kind,
        versionDomainId: null,
      },
      versioned: false,
      headCheckpointId: null,
      changes: [],
      counts: { added: 0, modified: 0, deleted: 0 },
      branches: [],
      checkpoints: [],
    };
    const changes = await this.remoteFs.diffTree({
      sourceRoot: resolved.state.workspace.rootPath,
      shadowRoot: resolved.state.storage.workTree,
      exclude: [".git", ".easywork"],
    });
    const requestedBranch = input.branchId ? resolved.state.branches[String(input.branchId)] : null;
    const branches = Object.values(resolved.state.branches).map((entry) => ({
      id: entry.id,
      conversationId: entry.conversationId,
      fromCheckpointId: entry.fromCheckpointId,
      headCheckpointId: entry.headCheckpointId,
      createdAt: entry.createdAt,
    }));
    const checkpoints = resolved.state.checkpoints.map((entry) => ({
      id: entry.id,
      sequence: entry.sequence,
      conversationId: entry.conversationId,
      logicalBranchId: entry.logicalBranchId,
      parentCheckpointId: entry.parentCheckpointId,
      status: entry.status,
      message: entry.message,
      createdAt: entry.createdAt,
      rewoundAt: entry.rewoundAt,
      changeCount: entry.changes.length,
    }));
    return {
      workspace: {
        id: resolved.workspace.id,
        canonicalPath: resolved.workspace.canonicalPath,
        kind: resolved.workspace.kind,
        versionDomainId: resolved.workspace.versionDomainId,
      },
      versioned: true,
      versionDomainId: resolved.state.versionDomainId,
      revision: resolved.state.revision,
      headCheckpointId: requestedBranch?.headCheckpointId || branches.map((entry) => entry.headCheckpointId).filter(Boolean).at(-1) || null,
      counts: {
        added: changes.filter((entry) => !entry.before.exists && entry.after.exists).length,
        modified: changes.filter((entry) => entry.before.exists && entry.after.exists).length,
        deleted: changes.filter((entry) => entry.before.exists && !entry.after.exists).length,
      },
      changes,
      branches,
      checkpoints,
    };
  }

  async diff(input = {}) {
    const result = await this.status(input);
    return { workspaceId: result.workspace.id, versionDomainId: result.versionDomainId || null, changes: result.changes };
  }

  async commit(input = {}) {
    invariant(input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((key) => ["workspaceId", "checkpointId", "branchId", "conversationId", "message", "commandId"].includes(key)), "VERSION_CONTROL_COMMIT_INVALID", "版本 Checkpoint 请求无效", { status: 400 });
    const resolved = await this.#resolve(input);
    invariant(resolved.state, "VERSION_CONTROL_WORKSPACE_UNVERSIONED", "当前工作区没有隔离版本域", { status: 409 });
    const versioning = await this.container.versioningFor(this.serverId, this.serverIdentity);
    return versioning.checkpoint({
      actorId: this.container.actor.actorId,
      serverIdentity: this.serverIdentity,
      versionDomainId: resolved.state.versionDomainId,
    }, {
      checkpointId: input.checkpointId,
      branchId: input.branchId,
      conversationId: input.conversationId,
      message: input.message || "",
    });
  }

  async rewind(input = {}) {
    invariant(input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every((key) => ["workspaceId", "branchId", "targetCheckpointId", "rewindId", "commandId"].includes(key)), "VERSION_CONTROL_REWIND_INVALID", "版本回退请求无效", { status: 400 });
    const resolved = await this.#resolve(input);
    invariant(resolved.state, "VERSION_CONTROL_WORKSPACE_UNVERSIONED", "当前工作区没有隔离版本域", { status: 409 });
    const versioning = await this.container.versioningFor(this.serverId, this.serverIdentity);
    return versioning.rewind({
      actorId: this.container.actor.actorId,
      serverIdentity: this.serverIdentity,
      versionDomainId: resolved.state.versionDomainId,
    }, {
      branchId: input.branchId,
      targetCheckpointId: input.targetCheckpointId,
      rewindId: input.rewindId,
    });
  }

  async #resolve(input) {
    const workspaceId = String(input?.workspaceId || "");
    invariant(workspaceId, "VERSION_CONTROL_WORKSPACE_REQUIRED", "版本操作需要 workspaceId", { status: 400 });
    const workspaces = await this.container.workspaceFor(this.serverId, this.serverIdentity);
    const workspace = await workspaces.getWorkspace(workspaceId);
    invariant(workspace.serverIdentity === this.serverIdentity && workspace.actorId === this.container.actor.actorId, "VERSION_CONTROL_WORKSPACE_FORBIDDEN", "工作区不属于当前 Actor 或服务器", { status: 403 });
    if (!workspace.versionDomainId) return { workspace, state: null };
    const versioning = await this.container.versioningFor(this.serverId, this.serverIdentity);
    const state = await versioning.getDomain({
      actorId: this.container.actor.actorId,
      serverIdentity: this.serverIdentity,
      versionDomainId: workspace.versionDomainId,
    });
    return { workspace, state };
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
}

export async function createDefaultRemoteBackend({ serverId, serverIdentity, sshWorker, container, catalog, apiProxyFactory = null, remoteFileLimits = null }) {
  const executor = new WorkerBoundAgentExecutor({ worker: sshWorker, serverId, proxyFactory: apiProxyFactory });
  const agentDeployment = new AgentDeploymentService({ catalog, executor });
  const agentConfiguration = new ManagedAgentConfiguration({ executor, deploymentService: agentDeployment, clock: container?.clock });
  const scoped = Boolean(
    container?.actor?.actorId
      && container?.runtime?.dataRoot
      && container?.broker?.append
      && /^ssh_[A-Za-z0-9_-]{43}$/.test(String(serverIdentity || "")),
  );
  const skillDeployment = scoped ? await new SshSkillDeployment({
    executor,
    actor: container.actor,
    dataRoot: container.runtime.dataRoot,
    serverId,
    serverIdentity,
    clock: container.clock,
  }).initialize() : null;
  const shadowVersion = scoped ? await new SshShadowVersionBackend({ executor, actor: container.actor, serverIdentity }).initialize() : null;
  const terminal = scoped ? new SshTerminalManager({ worker: sshWorker, serverId, serverIdentity, broker: container.broker, clock: container.clock }) : null;
  const agentTransport = new AgentRuntimeTransport({ executor, deploymentService: agentDeployment, skillDeployment, configurationService: agentConfiguration });
  const versionControl = scoped ? new SshVersionControlFacade({ container, serverId, serverIdentity, remoteFs: shadowVersion }) : null;
  return {
    executor,
    remoteControl: new SshRemoteControl(executor),
    remoteFiles: new SshRemoteFiles({
      executor,
      container,
      serverId,
      serverIdentity,
      limits: remoteFileLimits || container?.runtime?.remoteFileLimits || {},
    }),
    schedulerExecutor: new SshSchedulerExecutor(executor),
    remoteArtifactSource: new SshRemoteArtifactSource({ executor, container, serverId, serverIdentity }),
    agentDeployment,
    agentConfiguration,
    agentTransport,
    skillDeployment,
    terminal,
    versionControl,
    remoteFs: shadowVersion,
    remoteExec: shadowVersion ? { git: (input) => shadowVersion.git(input) } : null,
    capabilities: Object.freeze({
      terminal: Object.freeze(scoped ? { state: "available", pty: true, resume: true } : { state: "unavailable", reason: "ssh-not-connected" }),
      versioning: Object.freeze(scoped ? { state: "available", storage: "~/.easywork/versioning", userGitIsolated: true } : { state: "unavailable", reason: "ssh-not-connected" }),
      skills: Object.freeze(scoped ? { state: "available", storage: "~/.easywork/skills" } : { state: "unavailable", reason: "ssh-not-connected" }),
    }),
    close: async () => {
      await Promise.allSettled([terminal?.closeAll(), agentTransport.close()]);
    },
  };
}

export { normalizeRemoteFileLimits, SshRemoteFiles, SshVersionControlFacade, WorkerBoundAgentExecutor };
