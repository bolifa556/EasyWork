import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SERVER_IDENTITY_PATTERN = /^ssh_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const WORKSPACE_MODES = Object.freeze(["real", "virtual"]);
export const CHECKPOINT_STATUSES = Object.freeze(["retained", "rewound"]);

export function assertVersionId(value, field = "id") {
  const result = String(value || "");
  invariant(ID_PATTERN.test(result), "VERSION_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return result;
}

export function assertServerIdentity(value) {
  const result = String(value || "");
  invariant(SERVER_IDENTITY_PATTERN.test(result), "VERSION_SERVER_IDENTITY_INVALID", "serverIdentity 格式无效", { status: 400 });
  return result;
}

export function canonicalRemotePath(value, field = "path") {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(path.posix.isAbsolute(source), "VERSION_PATH_NOT_ABSOLUTE", `${field} 必须是远端绝对路径`, { status: 400 });
  invariant(!/[\0\r\n\t]/.test(source), "VERSION_PATH_UNSAFE", `${field} 包含非法字符`, { status: 400 });
  const normalized = path.posix.normalize(source).replace(/\/$/, "") || "/";
  invariant(normalized !== "/", "VERSION_PATH_UNSAFE", `${field} 不能是根目录`, { status: 400 });
  return normalized;
}

export function assertWorkspaceAbsolutePath(value, field = "workspacePath") {
  const normalized = canonicalRemotePath(value, field);
  const segments = normalized.split("/").filter(Boolean);
  invariant(!segments.includes(".git"), "VERSION_PROTECTED_PATH", `${field} 不能位于 .git 中`, { status: 409 });
  if (segments.includes(".easywork")) {
    invariant(normalized.includes("/.easywork/workspaces/"), "VERSION_PROTECTED_PATH", `${field} 不能位于 EasyWork 控制目录中`, { status: 409 });
  }
  return normalized;
}

export function assertVersionedAbsolutePath(value, field = "path") {
  const normalized = canonicalRemotePath(value, field);
  const segments = normalized.split("/").filter(Boolean);
  invariant(!segments.includes(".git"), "VERSION_PROTECTED_PATH", `${field} 不能位于 .git 中`, { status: 409 });
  if (segments.includes(".easywork")) {
    invariant(normalized.includes("/.easywork/workspaces/"), "VERSION_PROTECTED_PATH", `${field} 不能位于 EasyWork 控制目录中`, { status: 409 });
  }
  return normalized;
}

// A ledger belongs to one web conversation on one server. Workspace and Agent
// routing are metadata, not identity, so changing either keeps one history.
export function versionDomainId({ actorId, serverIdentity, conversationId }) {
  const digest = crypto.createHash("sha256")
    .update([
      assertVersionId(actorId, "actorId"),
      assertServerIdentity(serverIdentity),
      assertVersionId(conversationId, "conversationId"),
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `vl_${digest}`;
}

export function storageLayout({ baseRoot = "~/.easywork/versioning", actorId, serverIdentity, versionDomainId: domainId }) {
  const actor = assertVersionId(actorId, "actorId");
  const server = assertServerIdentity(serverIdentity);
  const domain = assertVersionId(domainId, "versionDomainId");
  const serverRoot = path.posix.join(baseRoot, actor, server);
  const root = path.posix.join(serverRoot, "conversations", domain);
  return Object.freeze({
    root,
    stateFile: path.posix.join(root, "ledger.json"),
    objectsRoot: path.posix.join(serverRoot, "objects"),
    registryFile: path.posix.join(serverRoot, "ledgers.json"),
    materializationsFile: path.posix.join(serverRoot, "path-heads.json"),
  });
}

export function assertVersioningDependencies(dependencies) {
  const methods = ["readJson", "writeJsonAtomic", "mkdir", "capturePaths", "captureAgentHookOperations", "listAgentHookOperations", "removeAgentHookOperations", "fingerprintPath", "restoreSnapshot"];
  invariant(dependencies?.remoteFs && typeof dependencies.remoteFs === "object", "VERSION_DEPENDENCY_MISSING", "缺少 remoteFs", { status: 500, expose: false });
  for (const method of methods) {
    invariant(typeof dependencies.remoteFs[method] === "function", "VERSION_DEPENDENCY_INVALID", `remoteFs.${method} 无效`, { status: 500, expose: false });
  }
}

export function validateSnapshot(snapshot, field = "snapshot") {
  invariant(snapshot && typeof snapshot === "object" && typeof snapshot.exists === "boolean", "VERSION_SNAPSHOT_INVALID", `${field} 无效`, { status: 500, expose: false });
  if (!snapshot.exists) return { exists: false, type: null, sha256: null, size: 0, mode: null, objectId: null };
  const type = String(snapshot.type || "file");
  invariant(["file", "directory"].includes(type), "VERSION_SNAPSHOT_INVALID", `${field}.type 无效`, { status: 500, expose: false });
  const sha256 = String(snapshot.sha256 || "");
  const objectId = String(snapshot.objectId || sha256);
  invariant(HASH_PATTERN.test(sha256) && objectId === sha256, "VERSION_SNAPSHOT_INVALID", `${field}.sha256 无效`, { status: 500, expose: false });
  const size = Number(snapshot.size);
  invariant(Number.isSafeInteger(size) && size >= 0, "VERSION_SNAPSHOT_INVALID", `${field}.size 无效`, { status: 500, expose: false });
  const mode = Number(snapshot.mode ?? (type === "directory" ? 0o700 : 0o600));
  invariant(Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777, "VERSION_SNAPSHOT_INVALID", `${field}.mode 无效`, { status: 500, expose: false });
  return { exists: true, type, sha256, size, mode, objectId };
}

export function normalizeChanges(changes) {
  invariant(Array.isArray(changes), "VERSION_DIFF_INVALID", "changes 必须是数组", { status: 500, expose: false });
  const seen = new Set();
  return changes.map((change, index) => {
    const absolutePath = assertVersionedAbsolutePath(change?.path, `changes[${index}].path`);
    invariant(!seen.has(absolutePath), "VERSION_DIFF_DUPLICATE_PATH", `changes 包含重复路径: ${absolutePath}`, { status: 500, expose: false });
    seen.add(absolutePath);
    return {
      path: absolutePath,
      workspaceId: change?.workspaceId == null ? null : assertVersionId(change.workspaceId, `changes[${index}].workspaceId`),
      before: validateSnapshot(change.before, `changes[${index}].before`),
      after: validateSnapshot(change.after, `changes[${index}].after`),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}
