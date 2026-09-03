import path from "node:path";

import { ApiError, invariant } from "../errors.mjs";
import { remoteAgentPaths } from "../agent-runtime/contract.mjs";

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_HOOK_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SFTP_OPERATION_TIMEOUT_MS = 30_000;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

function missing(error) {
  return ["ENOENT", "NO_SUCH_FILE", 2].includes(error?.code);
}

function sftpCall(sftp, method, ...args) {
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
      details: { method, timeoutMs: SFTP_OPERATION_TIMEOUT_MS },
    })), SFTP_OPERATION_TIMEOUT_MS);
    try { sftp[method](...args, (error, value) => finish(error, value)); }
    catch (error) { finish(error); }
  });
}

function normalizeAbsolute(value, field) {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(path.posix.isAbsolute(source) && !/[\0\r\n\t]/.test(source), "REMOTE_VERSION_PATH_INVALID", `${field} 必须是安全的远端绝对路径`, { status: 400 });
  return path.posix.normalize(source).replace(/\/$/, "") || "/";
}

function absentSnapshot() {
  return { exists: false, type: null, sha256: null, size: 0, mode: null, objectId: null };
}

function normalizeSnapshot(value) {
  invariant(value && typeof value === "object" && typeof value.exists === "boolean", "REMOTE_VERSION_SNAPSHOT_INVALID", "版本快照无效", { status: 400 });
  if (!value.exists) return absentSnapshot();
  const type = String(value.type || "");
  const sha256 = String(value.sha256 || "");
  const objectId = String(value.objectId || sha256);
  const size = Number(value.size);
  const mode = Number(value.mode);
  invariant(["file", "directory"].includes(type) && HASH_PATTERN.test(sha256) && objectId === sha256, "REMOTE_VERSION_SNAPSHOT_INVALID", "版本快照对象无效", { status: 400 });
  invariant(Number.isSafeInteger(size) && size >= 0 && Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777, "REMOTE_VERSION_SNAPSHOT_INVALID", "版本快照元数据无效", { status: 400 });
  return { exists: true, type, sha256, size, mode, objectId };
}

export class SshConversationVersionBackend {
  constructor({ executor, actor, serverIdentity }) {
    invariant(executor?.home && executor?.withSftp && executor?.exec, "REMOTE_VERSION_EXECUTOR_INVALID", "远端版本 backend 缺少 executor", { status: 500, expose: false });
    invariant(actor?.actorId && serverIdentity, "REMOTE_VERSION_SCOPE_INVALID", "远端版本 backend 缺少 Actor 或服务器身份", { status: 500, expose: false });
    this.executor = executor;
    this.actorId = String(actor.actorId);
    this.serverIdentity = String(serverIdentity);
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.actorId) && /^ssh_[A-Za-z0-9_-]{43}$/.test(this.serverIdentity), "REMOTE_VERSION_SCOPE_INVALID", "远端版本 Actor 或服务器身份无效", { status: 500, expose: false });
    this.homePath = null;
    this.controlRoot = null;
    this.initialization = null;
    this.rootPreparation = null;
  }

  async initialize() {
    if (this.controlRoot) return this;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const home = normalizeAbsolute(await this.executor.home(), "HOME");
      invariant(home !== "/", "REMOTE_VERSION_HOME_INVALID", "远端 HOME 无效", { status: 502 });
      this.homePath = home;
      this.controlRoot = `${home}/.easywork/versioning/${this.actorId}/${this.serverIdentity}`;
      return this;
    })();
    try { return await this.initialization; }
    catch (error) {
      this.homePath = null;
      this.controlRoot = null;
      throw error;
    } finally {
      this.initialization = null;
    }
  }

  async #prepareControlRoot() {
    await this.initialize();
    if (this.rootPreparation) return this.rootPreparation;
    this.rootPreparation = this.#withSftp((sftp) => this.#mkdirp(sftp, this.controlRoot, 0o700));
    try { return await this.rootPreparation; }
    catch (error) {
      this.rootPreparation = null;
      throw error;
    }
  }

  async readJson(candidate) {
    await this.initialize();
    const target = await this.#controlPath(candidate, "JSON path");
    let bytes;
    try { bytes = await this.executor.readFile(target); } catch (error) { if (missing(error)) return null; throw error; }
    invariant(bytes.length <= MAX_JSON_BYTES, "REMOTE_VERSION_JSON_TOO_LARGE", "版本账本状态文件过大", { status: 413 });
    try { return JSON.parse(bytes.toString("utf8")); } catch (error) {
      invariant(false, "REMOTE_VERSION_JSON_INVALID", "版本账本状态文件损坏", { status: 500, expose: false, cause: error });
    }
  }

  async writeJsonAtomic(candidate, value, options = {}) {
    await this.#prepareControlRoot();
    const target = await this.#controlPath(candidate, "JSON path");
    invariant(Object.keys(options || {}).every((key) => key === "expectedRevision"), "REMOTE_VERSION_WRITE_OPTIONS_INVALID", "版本状态写入选项无效", { status: 400 });
    const expected = options.expectedRevision;
    invariant(expected === undefined || expected === null || (Number.isSafeInteger(expected) && expected >= 0), "REMOTE_VERSION_EXPECTED_REVISION_INVALID", "版本状态 expectedRevision 无效", { status: 400 });
    // VersioningService serializes each ledger/materialization key and only
    // writes a revision obtained from its validated current-state cache.  A
    // second SFTP read here duplicated every mutation without adding another
    // writer boundary; the atomic rename remains the durable commit point.
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    invariant(bytes.length <= MAX_JSON_BYTES, "REMOTE_VERSION_JSON_TOO_LARGE", "版本账本状态文件过大", { status: 413 });
    await this.executor.writeAtomic(target, bytes, { mode: 0o600 });
  }

  async mkdir(candidate) {
    await this.#prepareControlRoot();
    const target = await this.#controlPath(candidate, "directory");
    await this.#withSftp((sftp) => this.#mkdirp(sftp, target, 0o700));
  }

  async capturePaths(input) {
    await this.#prepareControlRoot();
    invariant(input && typeof input === "object"
      && Object.keys(input).length === 2
      && Object.keys(input).every((key) => ["paths", "objectsRoot"].includes(key))
      && Array.isArray(input.paths) && input.paths.length <= 4096,
    "REMOTE_VERSION_CAPTURE_INPUT_INVALID", "capturePaths 输入无效", { status: 400 });
    const targets = [...new Set(input.paths.map((candidate) => this.#versionedPathLexical(candidate)))];
    const objectsRoot = await this.#controlPath(input.objectsRoot, "objectsRoot");
    const snapshots = await this.#snapshots(targets, objectsRoot, true);
    return targets.map((target, index) => ({ path: target, snapshot: snapshots[index] }));
  }

  async captureAgentHookOperations(input) {
    await this.#prepareControlRoot();
    invariant(input && typeof input === "object"
      && Object.keys(input).length === 4
      && Object.keys(input).every((key) => ["agentId", "agentBindingId", "taskId", "objectsRoot"].includes(key)),
    "REMOTE_VERSION_HOOK_INPUT_INVALID", "执行前版本输入无效", { status: 400 });
    const operations = await this.#readAgentHookManifests(input);
    const objectsRoot = await this.#controlPath(input.objectsRoot, "objectsRoot");
    const entries = [];
    const payloads = [];
    for (const operation of operations) {
      for (const [index, raw] of operation.manifest.entries.entries()) {
        const target = this.#versionedPathLexical(raw.path);
        if (!raw.exists) {
          invariant(raw.type === null && raw.payload === null, "REMOTE_VERSION_HOOK_MANIFEST_INVALID", `执行前版本清单 entries[${index}] 无效`, { status: 409 });
          entries.push({ operationId: operation.operationId, path: target, snapshot: absentSnapshot() });
          continue;
        }
        invariant(["file", "directory"].includes(raw.type) && typeof raw.payload === "string" && raw.payload.length > 0, "REMOTE_VERSION_HOOK_MANIFEST_INVALID", `执行前版本清单 entries[${index}] 无效`, { status: 409 });
        const relativePayload = path.posix.normalize(raw.payload.replace(/\\/g, "/"));
        invariant(!path.posix.isAbsolute(relativePayload) && relativePayload !== ".." && !relativePayload.startsWith("../") && !relativePayload.includes("/../"), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本 payload 越界", { status: 403 });
        const payloadPath = normalizeAbsolute(`${operation.operationRoot}/${relativePayload}`, "payloadPath");
        invariant(payloadPath.startsWith(`${operation.operationRoot}/`) && path.posix.basename(payloadPath) === path.posix.basename(target), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本 payload 与目标不一致", { status: 403 });
        const position = entries.length;
        entries.push({ operationId: operation.operationId, path: target, snapshot: null });
        payloads.push({ position, path: payloadPath, type: raw.type });
      }
    }
    const snapshots = await this.#snapshots(payloads.map((entry) => entry.path), objectsRoot, true);
    for (const [index, payload] of payloads.entries()) {
      const snapshot = snapshots[index];
      invariant(snapshot.exists && snapshot.type === payload.type, "REMOTE_VERSION_HOOK_PAYLOAD_INVALID", "执行前版本 payload 类型不一致", { status: 409 });
      entries[payload.position].snapshot = snapshot;
    }
    return {
      operations: operations.map(({ operationId, createdAtNs }) => ({ operationId, createdAtNs })),
      entries,
    };
  }

  async listAgentHookOperations(input) {
    await this.initialize();
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["agentId", "agentBindingId", "taskId"].includes(key)), "REMOTE_VERSION_HOOK_LIST_INPUT_INVALID", "执行前版本清单查询输入无效", { status: 400 });
    return (await this.#readAgentHookManifests(input)).map(({ operationId, createdAtNs }) => ({ operationId, createdAtNs }));
  }

  async #readAgentHookManifests(input) {
    const taskId = String(input.taskId || "");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(taskId), "REMOTE_VERSION_HOOK_TASK_INVALID", "执行前版本 taskId 无效", { status: 400 });
    const runtime = remoteAgentPaths(this.homePath, input.agentId, input.agentBindingId);
    const hookRoot = normalizeAbsolute(`${runtime.runtimeState}/version-hooks`, "hookRoot");
    const taskRoot = normalizeAbsolute(`${hookRoot}/${taskId}`, "taskRoot");
    invariant(taskRoot.startsWith(`${hookRoot}/`), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本目录越界", { status: 403 });
    let directoryEntries;
    try {
      directoryEntries = await this.#withSftp(async (sftp) => {
        const attributes = await sftpCall(sftp, "lstat", taskRoot);
        invariant(attributes?.isDirectory?.() && !attributes?.isSymbolicLink?.(), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本目录不安全", { status: 409 });
        return sftpCall(sftp, "readdir", taskRoot);
      });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const candidates = directoryEntries.filter((entry) => /^op_[a-f0-9]{24}$/.test(String(entry?.filename || "")));
    invariant(candidates.length <= 4096, "REMOTE_VERSION_HOOK_MANIFEST_INVALID", "执行前版本操作数量过多", { status: 409 });
    const operations = await Promise.all(candidates.map(async (entry) => {
      const operationId = String(entry.filename);
      invariant(entry?.attrs?.isDirectory?.() && !entry?.attrs?.isSymbolicLink?.(), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本操作目录不安全", { status: 409 });
      const operationRoot = normalizeAbsolute(`${taskRoot}/${operationId}`, "operationRoot");
      invariant(operationRoot.startsWith(`${taskRoot}/`), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本目录越界", { status: 403 });
      const bytes = await this.executor.readFile(`${operationRoot}/manifest.json`);
      invariant(bytes.length <= MAX_HOOK_MANIFEST_BYTES, "REMOTE_VERSION_HOOK_MANIFEST_TOO_LARGE", "执行前版本清单过大", { status: 413 });
      let manifest;
      try { manifest = JSON.parse(bytes.toString("utf8")); } catch (error) {
        invariant(false, "REMOTE_VERSION_HOOK_MANIFEST_INVALID", "执行前版本清单损坏", { status: 409, cause: error });
      }
      invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest)
        && Object.keys(manifest).length === 5
        && Object.keys(manifest).every((key) => ["schemaVersion", "taskId", "operationId", "createdAtNs", "entries"].includes(key))
        && manifest.schemaVersion === 4 && manifest.taskId === taskId && manifest.operationId === operationId
        && /^\d{16,24}$/.test(String(manifest.createdAtNs || "")) && Array.isArray(manifest.entries)
        && manifest.entries.length <= 4096,
      "REMOTE_VERSION_HOOK_MANIFEST_INVALID", "执行前版本清单格式无效", { status: 409 });
      for (const [index, raw] of manifest.entries.entries()) {
        invariant(raw && typeof raw === "object" && !Array.isArray(raw)
          && Object.keys(raw).length === 4
          && Object.keys(raw).every((key) => ["path", "exists", "type", "payload"].includes(key))
          && typeof raw.exists === "boolean",
        "REMOTE_VERSION_HOOK_MANIFEST_INVALID", `执行前版本清单 entries[${index}] 无效`, { status: 409 });
      }
      return { operationId, createdAtNs: String(manifest.createdAtNs), operationRoot, manifest };
    }));
    operations.sort((left, right) => {
      const order = BigInt(left.createdAtNs) - BigInt(right.createdAtNs);
      return order < 0n ? -1 : order > 0n ? 1 : left.operationId.localeCompare(right.operationId);
    });
    return operations;
  }

  async removeAgentHookOperations(input) {
    await this.initialize();
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["agentId", "agentBindingId", "taskId", "operationIds"].includes(key))
      && Array.isArray(input.operationIds) && input.operationIds.length <= 4096,
    "REMOTE_VERSION_HOOK_REMOVE_INPUT_INVALID", "执行前版本清理输入无效", { status: 400 });
    const taskId = String(input.taskId || "");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(taskId), "REMOTE_VERSION_HOOK_TASK_INVALID", "执行前版本 taskId 无效", { status: 400 });
    const operationIds = [...new Set(input.operationIds.map((value) => String(value)))];
    if (!operationIds.length) return { removed: 0 };
    invariant(operationIds.every((value) => /^op_[a-f0-9]{24}$/.test(value)), "REMOTE_VERSION_HOOK_OPERATION_INVALID", "执行前版本 operationId 无效", { status: 400 });
    const runtime = remoteAgentPaths(this.homePath, input.agentId, input.agentBindingId);
    const hookRoot = normalizeAbsolute(`${runtime.runtimeState}/version-hooks`, "hookRoot");
    const taskRoot = normalizeAbsolute(`${hookRoot}/${taskId}`, "taskRoot");
    invariant(taskRoot.startsWith(`${hookRoot}/`), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本目录越界", { status: 403 });
    const targets = operationIds.map((operationId) => {
      const target = normalizeAbsolute(`${taskRoot}/${operationId}`, "operationRoot");
      invariant(target.startsWith(`${taskRoot}/`), "REMOTE_VERSION_HOOK_PATH_INVALID", "执行前版本目录越界", { status: 403 });
      return target;
    });
    const cleanup = await this.executor.exec(`rm -rf -- ${targets.map(shellQuote).join(" ")}; rmdir -- ${shellQuote(taskRoot)} 2>/dev/null || true`, { maxOutputBytes: 4 * 1024 });
    invariant(cleanup.code === 0, "REMOTE_VERSION_HOOK_CLEANUP_FAILED", "无法清理已经提交的执行前版本临时数据", { status: 502 });
    return { removed: operationIds.length };
  }

  async fingerprintPath(input) {
    await this.#prepareControlRoot();
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => key === "path"), "REMOTE_VERSION_FINGERPRINT_INPUT_INVALID", "fingerprintPath 输入无效", { status: 400 });
    const target = await this.#versionedPath(input.path);
    const temporaryRoot = `${this.controlRoot}/fingerprints`;
    await this.#withSftp((sftp) => this.#mkdirp(sftp, temporaryRoot, 0o700));
    return (await this.#snapshots([target], temporaryRoot, false))[0];
  }

  async restoreSnapshot(input) {
    await this.initialize();
    invariant(input && typeof input === "object" && Object.keys(input).every((key) => ["path", "snapshot", "objectsRoot"].includes(key)), "REMOTE_VERSION_RESTORE_INPUT_INVALID", "restoreSnapshot 输入无效", { status: 400 });
    const target = await this.#versionedPath(input.path);
    const snapshot = normalizeSnapshot(input.snapshot);
    const objectsRoot = await this.#controlPath(input.objectsRoot, "objectsRoot");
    const remove = `rm -rf -- ${shellQuote(target)}`;
    if (!snapshot.exists) {
      const result = await this.executor.exec(remove, { maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES });
      invariant(result.code === 0, "REMOTE_VERSION_RESTORE_FAILED", "无法删除回溯目标路径", { status: 409, details: { path: target, stderr: String(result.stderr || "").slice(0, 2_000) } });
      return { path: target, restored: false, removed: true };
    }
    const objectPath = await this.#objectPath(objectsRoot, snapshot.objectId);
    const parent = path.posix.dirname(target);
    const base = path.posix.basename(target);
    const script = snapshot.type === "file"
      ? String.raw`
set -euo pipefail
target=$1
parent=$2
object=$3
mode=$4
mkdir -p -- "$parent"
tmp="$parent/.easywork-restore-$$-$RANDOM"
trap 'rm -rf -- "$tmp"' EXIT
cp --reflink=auto -- "$object" "$tmp"
chmod "$mode" -- "$tmp"
rm -rf -- "$target"
mv -f -- "$tmp" "$target"
trap - EXIT
`
      : String.raw`
set -euo pipefail
target=$1
parent=$2
object=$3
base=$4
mkdir -p -- "$parent"
rm -rf -- "$target"
# Directory archives deliberately normalize mtimes to epoch 0 so their object
# ids depend on content and modes rather than incidental clock values.  Do not
# leak that normalization into the user's restored workspace: restored paths
# receive the restore time, matching the file-snapshot restore semantics.
tar --touch -xf "$object" -C "$parent"
test -d "$parent/$base"
`;
    const args = snapshot.type === "file"
      ? [target, parent, objectPath, snapshot.mode.toString(8)]
      : [target, parent, objectPath, base];
    const command = ["LC_ALL=C bash -c", shellQuote(script), "easywork-version-restore", ...args.map(shellQuote)].join(" ");
    const result = await this.executor.exec(command, { maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES });
    invariant(result.code === 0, "REMOTE_VERSION_RESTORE_FAILED", "无法恢复版本快照", { status: 409, details: { path: target, stderr: String(result.stderr || "").slice(0, 2_000) } });
    return { path: target, restored: true, removed: false, snapshot };
  }

  async #snapshots(targets, objectsRoot, store) {
    if (!targets.length) return [];
    const script = String.raw`
set -euo pipefail
objects=$1
store=$2
shift 2
capture_one() {
target=$1
if [ ! -e "$target" ] && [ ! -L "$target" ]; then
  printf 'A\n'
  return
fi
resolved=$(readlink -m -- "$target")
if [ -L "$target" ] || [ "$resolved" != "$target" ]; then
  printf 'Y\n'
  return
fi
mode=$(stat -c %a -- "$target")
tmp="$objects/.capture-$$-$RANDOM"
trap 'rm -rf -- "$tmp"' RETURN
if [ -f "$target" ]; then
  before=$(stat -c '%d:%i:%s:%Y:%Z' -- "$target")
  cp --reflink=auto -- "$target" "$tmp"
  after=$(stat -c '%d:%i:%s:%Y:%Z' -- "$target")
  if [ "$before" != "$after" ]; then printf 'R\n'; return; fi
  hash=$(sha256sum -- "$tmp" | cut -d ' ' -f 1)
  size=$(stat -c %s -- "$tmp")
  kind=F
elif [ -d "$target" ]; then
  if find "$target" -type l -print -quit | grep -q .; then printf 'Y\n'; return; fi
  parent=$(dirname -- "$target")
  base=$(basename -- "$target")
  (
    cd -- "$parent"
    find "./$base" -print0 | LC_ALL=C sort -z |
      tar --null --no-recursion --files-from=- --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu -cf "$tmp"
  )
  hash=$(sha256sum -- "$tmp" | cut -d ' ' -f 1)
  size=$(stat -c %s -- "$tmp")
  kind=D
else
  printf 'U\n'
  return
fi
if [ "$store" = 1 ]; then
  prefix=$(printf '%s' "$hash" | cut -c1-2)
  directory="$objects/$prefix"
  object="$directory/$hash"
  mkdir -p -- "$directory"
  if [ ! -f "$object" ]; then
    chmod 400 -- "$tmp"
    mv -n -- "$tmp" "$object" || true
  fi
  test -f "$object"
fi
printf '%s %s %s %s\n' "$kind" "$hash" "$size" "$mode"
}
for target in "$@"; do capture_one "$target"; done
`;
    const command = ["LC_ALL=C bash -c", shellQuote(script), "easywork-version-capture", shellQuote(objectsRoot), store ? "1" : "0", ...targets.map(shellQuote)].join(" ");
    const result = await this.executor.exec(command, { maxOutputBytes: Math.max(MAX_COMMAND_OUTPUT_BYTES, targets.length * 128) });
    invariant(result.code === 0, "REMOTE_VERSION_CAPTURE_FAILED", "无法批量捕获文件版本", { status: 409, details: { stderr: String(result.stderr || "").slice(0, 2_000) } });
    const outputs = String(result.stdout || "").trim().split(/\r?\n/);
    invariant(outputs.length === targets.length, "REMOTE_VERSION_CAPTURE_FAILED", "远端批量版本指纹数量无效", { status: 500, expose: false });
    return outputs.map((output, index) => {
      const target = targets[index];
      if (output === "A") return absentSnapshot();
      invariant(output !== "Y", "REMOTE_VERSION_SYMLINK_FORBIDDEN", "版本路径或目录树包含符号链接", { status: 409, details: { path: target } });
      invariant(output !== "R", "REMOTE_VERSION_SOURCE_CHANGED", "捕获版本时文件仍在变化，请稍后重试", { status: 409, details: { path: target } });
      invariant(output !== "U", "REMOTE_VERSION_FILE_TYPE_UNSUPPORTED", "版本记录只支持普通文件和目录", { status: 409, details: { path: target } });
      const match = output.match(/^([FD]) ([a-f0-9]{64}) (\d+) ([0-7]{3,4})$/);
      invariant(match, "REMOTE_VERSION_CAPTURE_FAILED", "远端版本指纹格式无效", { status: 500, expose: false });
      const size = Number(match[3]);
      const mode = Number.parseInt(match[4], 8);
      invariant(Number.isSafeInteger(size) && size >= 0, "REMOTE_VERSION_CAPTURE_FAILED", "远端版本大小无效", { status: 500, expose: false });
      return { exists: true, type: match[1] === "F" ? "file" : "directory", sha256: match[2], size, mode, objectId: match[2] };
    });
  }

  #versionedPathLexical(candidate) {
    const target = normalizeAbsolute(candidate, "path");
    const segments = target.split("/").filter(Boolean);
    invariant(target !== "/" && !segments.includes(".git"), "REMOTE_VERSION_PATH_FORBIDDEN", "版本路径属于受保护目录", { status: 409, details: { path: target } });
    invariant(target !== this.controlRoot && !target.startsWith(`${this.controlRoot}/`), "REMOTE_VERSION_PATH_FORBIDDEN", "版本路径不能指向 EasyWork 版本控制目录", { status: 409, details: { path: target } });
    if (segments.includes(".easywork")) {
      invariant(target.startsWith(`${this.homePath}/.easywork/workspaces/`), "REMOTE_VERSION_PATH_FORBIDDEN", "版本路径不能指向 EasyWork 控制目录", { status: 409, details: { path: target } });
    }
    return target;
  }

  async #versionedPath(candidate) {
    const lexical = this.#versionedPathLexical(candidate);
    const script = "candidate=$1\n[ ! -L \"$candidate\" ] || exit 42\nreadlink -m -- \"$candidate\"";
    const resolved = await this.executor.exec(`bash -c ${shellQuote(script)} easywork-version-path ${shellQuote(lexical)}`, { maxOutputBytes: 32 * 1024 });
    invariant(resolved.code !== 42, "REMOTE_VERSION_SYMLINK_FORBIDDEN", "版本路径不能是符号链接", { status: 409, details: { path: lexical } });
    invariant(resolved.code === 0, "REMOTE_VERSION_PATH_INVALID", "无法解析版本路径", { status: 409, details: { path: lexical } });
    const target = normalizeAbsolute(String(resolved.stdout || "").trim(), "path");
    return this.#versionedPathLexical(target);
  }

  async #objectPath(objectsRoot, objectId) {
    invariant(HASH_PATTERN.test(String(objectId || "")), "REMOTE_VERSION_OBJECT_INVALID", "版本对象 ID 无效", { status: 400 });
    const candidate = `${objectsRoot}/${objectId.slice(0, 2)}/${objectId}`;
    const target = await this.#controlPath(candidate, "objectPath");
    let attrs;
    await this.#withSftp(async (sftp) => { try { attrs = await sftpCall(sftp, "lstat", target); } catch (error) { if (!missing(error)) throw error; } });
    invariant(attrs && !attrs.isDirectory?.() && !attrs.isSymbolicLink?.(), "REMOTE_VERSION_OBJECT_MISSING", "版本对象不存在", { status: 409, details: { objectId } });
    return target;
  }

  async #controlPath(candidate, field) {
    invariant(this.controlRoot, "REMOTE_VERSION_NOT_INITIALIZED", "远端版本 backend 尚未初始化", { status: 500, expose: false });
    const source = String(candidate || "").replace(/\\/g, "/");
    const expanded = source === "~" ? this.homePath : source.startsWith("~/") ? `${this.homePath}/${source.slice(2)}` : source;
    const target = normalizeAbsolute(expanded, field);
    invariant(target === this.controlRoot || target.startsWith(`${this.controlRoot}/`), "REMOTE_VERSION_STORAGE_ESCAPE", `${field} 越出当前 Actor 与服务器的版本目录`, { status: 403 });
    return target;
  }

  #withSftp(operation) {
    return this.executor.withSftp(operation);
  }

  async #mkdirp(sftp, directory, mode) {
    const target = normalizeAbsolute(directory, "directory");
    let current = "";
    for (const segment of target.split("/").filter(Boolean)) {
      current += `/${segment}`;
      let attrs;
      try { attrs = await sftpCall(sftp, "lstat", current); } catch (error) { if (!missing(error)) throw error; }
      if (attrs) invariant(attrs.isDirectory?.() && !attrs.isSymbolicLink?.(), "REMOTE_VERSION_DIRECTORY_UNSAFE", "版本目录路径包含非目录或符号链接", { status: 409, details: { path: current } });
      else {
        try { await sftpCall(sftp, "mkdir", current, { mode }); } catch (error) { if (!missing(error) && error?.code !== "EEXIST" && error?.code !== 4) throw error; }
      }
    }
  }
}

export const conversationVersionLimits = Object.freeze({ maxJsonBytes: MAX_JSON_BYTES });
