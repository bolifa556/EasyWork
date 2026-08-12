import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SERVER_IDENTITY_PATTERN = /^ssh_[A-Za-z0-9_-]{43}$/;

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

export function canonicalRemotePath(value, field = "workspacePath") {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(path.posix.isAbsolute(source), "VERSION_PATH_NOT_ABSOLUTE", `${field} 必须是远端绝对路径`, { status: 400 });
  const normalized = path.posix.normalize(source).replace(/\/$/, "") || "/";
  invariant(normalized !== "/" && !normalized.includes("\0"), "VERSION_PATH_UNSAFE", `${field} 不能是根目录或包含非法字符`, { status: 400 });
  return normalized;
}

export function assertWorkspaceAbsolutePath(value, field = "workspacePath") {
  const normalized = canonicalRemotePath(value, field);
  const segments = normalized.split("/").filter(Boolean);
  invariant(!segments.some((segment) => segment === ".git" || segment === ".easywork"), "VERSION_PROTECTED_PATH", `${field} 不能位于 .git 或 .easywork 中`, { status: 409 });
  return normalized;
}

export function assertRelativeWorkspacePath(value, field = "path") {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(source && !path.posix.isAbsolute(source), "VERSION_RELATIVE_PATH_REQUIRED", `${field} 必须是相对路径`, { status: 400 });
  const normalized = path.posix.normalize(source);
  const segments = normalized.split("/");
  invariant(normalized !== "." && !normalized.startsWith("../") && segments.every((segment) => segment && segment !== "." && segment !== ".."), "VERSION_PATH_TRAVERSAL", `${field} 包含路径逃逸`, { status: 400 });
  invariant(!segments.some((segment) => segment === ".git" || segment === ".easywork"), "VERSION_PROTECTED_PATH", `${field} 属于受保护目录`, { status: 409 });
  return normalized;
}

export function relationshipBetweenRoots(leftValue, rightValue) {
  const left = canonicalRemotePath(leftValue, "leftRoot");
  const right = canonicalRemotePath(rightValue, "rightRoot");
  if (left === right) return "exact";
  if (right.startsWith(`${left}/`)) return "contains";
  if (left.startsWith(`${right}/`)) return "contained_by";
  return "disjoint";
}

export function versionDomainId({ actorId, serverIdentity, rootPath }) {
  const digest = crypto.createHash("sha256")
    .update(`${assertVersionId(actorId, "actorId")}\0${assertServerIdentity(serverIdentity)}\0${canonicalRemotePath(rootPath)}`)
    .digest("hex")
    .slice(0, 24);
  return `vd_${digest}`;
}

export function storageLayout({ baseRoot = "~/.easywork/versioning", actorId, serverIdentity, versionDomainId: domainId }) {
  const actor = assertVersionId(actorId, "actorId");
  const server = assertServerIdentity(serverIdentity);
  const domain = assertVersionId(domainId, "versionDomainId");
  const root = path.posix.join(baseRoot, actor, server, domain);
  return Object.freeze({
    root,
    repositoryGit: path.posix.join(root, "repository.git"),
    workTree: path.posix.join(root, "worktree"),
    indexFile: path.posix.join(root, "index"),
    configFile: path.posix.join(root, "gitconfig"),
    stateFile: path.posix.join(root, "state.json"),
    registryFile: path.posix.join(baseRoot, actor, server, "domains.json"),
  });
}

export function assertVersioningDependencies(dependencies) {
  const remoteFsMethods = [
    "readJson", "writeJsonAtomic", "mkdir", "writeTextAtomic", "diffTree", "syncTree", "fingerprint", "restorePath", "removePath",
  ];
  invariant(dependencies?.remoteFs && typeof dependencies.remoteFs === "object", "VERSION_DEPENDENCY_MISSING", "缺少 remoteFs", { status: 500, expose: false });
  for (const method of remoteFsMethods) {
    invariant(typeof dependencies.remoteFs[method] === "function", "VERSION_DEPENDENCY_INVALID", `remoteFs.${method} 无效`, { status: 500, expose: false });
  }
  invariant(typeof dependencies?.remoteExec?.git === "function", "VERSION_DEPENDENCY_INVALID", "remoteExec.git 无效", { status: 500, expose: false });
}

export function validateSnapshot(snapshot, field) {
  invariant(snapshot && typeof snapshot === "object" && typeof snapshot.exists === "boolean", "VERSION_SNAPSHOT_INVALID", `${field} 无效`, { status: 500, expose: false });
  if (snapshot.exists) {
    invariant(typeof snapshot.sha256 === "string" && /^[a-f0-9]{64}$/.test(snapshot.sha256), "VERSION_SNAPSHOT_INVALID", `${field}.sha256 无效`, { status: 500, expose: false });
  }
  return {
    exists: snapshot.exists,
    sha256: snapshot.exists ? snapshot.sha256 : null,
    size: snapshot.exists && Number.isSafeInteger(snapshot.size) && snapshot.size >= 0 ? snapshot.size : 0,
  };
}

export function normalizeChanges(changes) {
  invariant(Array.isArray(changes), "VERSION_DIFF_INVALID", "remoteFs.diffTree 必须返回 changes", { status: 500, expose: false });
  const seen = new Set();
  return changes.map((change, index) => {
    const relativePath = assertRelativeWorkspacePath(change?.path, `changes[${index}].path`);
    invariant(!seen.has(relativePath), "VERSION_DIFF_DUPLICATE_PATH", `changes 包含重复路径: ${relativePath}`, { status: 500, expose: false });
    seen.add(relativePath);
    return {
      path: relativePath,
      before: validateSnapshot(change.before, `changes[${index}].before`),
      after: validateSnapshot(change.after, `changes[${index}].after`),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}
