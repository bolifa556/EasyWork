import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { assertExactKeys, assertId, assertIsoTimestamp, assertServerIdentity } from "../entities/common.mjs";

export const WORKSPACE_SCHEMA_VERSION = 2;
export const WORKSPACE_KINDS = Object.freeze(["virtual", "user"]);
export const WORKSPACE_BINDING_STATUSES = Object.freeze(["active", "stale"]);
export const EASYWORK_WORKSPACE_ROOT = "~/.easywork/workspaces";
export const EASYWORK_WORKSPACE_BINDING_ROOT = "~/.easywork/bindings/workspaces";

const NATIVE_SESSION_PATTERN = /^[^\0\r\n]{1,1024}$/;

export function canonicalWorkspacePath(value, field = "workspacePath", options = {}) {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(path.posix.isAbsolute(source), "WORKSPACE_PATH_NOT_ABSOLUTE", `${field} 必须是远端绝对路径`, { status: 400 });
  const normalized = path.posix.normalize(source).replace(/\/$/, "") || "/";
  invariant(normalized !== "/" && !normalized.includes("\0"), "WORKSPACE_PATH_UNSAFE", `${field} 不能是根目录或包含非法字符`, { status: 400 });
  const segments = normalized.split("/").filter(Boolean);
  invariant(!segments.includes(".git"), "WORKSPACE_GIT_CONTROL_PATH_FORBIDDEN", `${field} 不能指向 .git 控制目录`, { status: 409 });
  if (!options.allowEasyWork) {
    invariant(!segments.includes(".easywork"), "WORKSPACE_EASYWORK_CONTROL_PATH_FORBIDDEN", `${field} 不能指向 EasyWork 控制目录`, { status: 409 });
  }
  return normalized;
}

export function assertWorkspaceKind(value) {
  const kind = String(value || "");
  invariant(WORKSPACE_KINDS.includes(kind), "WORKSPACE_KIND_INVALID", "工作区类型无效", { status: 400 });
  return kind;
}

export function assertCommandId(value) {
  return assertId(value, "commandId");
}

export function assertExpectedEntityRevision(value, options = {}) {
  if (options.create && value === 0) return 0;
  invariant(Number.isSafeInteger(value) && value >= 0, "EXPECTED_REVISION_REQUIRED", "操作必须提供 expectedRevision", { status: 428 });
  return value;
}

export function assertNativeSessionId(value) {
  if (value === null) return null;
  const sessionId = String(value || "");
  invariant(NATIVE_SESSION_PATTERN.test(sessionId), "WORKSPACE_NATIVE_SESSION_INVALID", "Agent 原生会话 ID 无效", { status: 400 });
  return sessionId;
}

export function createWorkspaceId({ actorId, serverIdentity, canonicalPath, kind }) {
  const digest = crypto.createHash("sha256")
    .update(`${assertId(actorId, "actorId")}\0${assertServerIdentity(serverIdentity)}\0${assertWorkspaceKind(kind)}\0${canonicalWorkspacePath(canonicalPath, "canonicalPath", { allowEasyWork: kind === "virtual" })}`)
    .digest("hex")
    .slice(0, 24);
  return `ws_${digest}`;
}

export function createVirtualWorkspaceId({ actorId, serverIdentity, conversationId, branchId }) {
  const seed = `virtual:${assertId(actorId, "actorId")}:${assertServerIdentity(serverIdentity)}:${assertId(conversationId, "conversationId")}:${assertId(branchId || "main", "branchId")}`;
  return `ws_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

export function createWorkspaceBindingKey(input) {
  const values = [
    assertId(input?.actorId, "actorId"),
    assertServerIdentity(input?.serverIdentity),
    assertId(input?.conversationId, "conversationId"),
    assertId(input?.branchId, "branchId"),
    assertId(input?.workspaceId, "workspaceId"),
    assertId(input?.agentId, "agentId"),
    String(input?.contextEpoch),
  ];
  invariant(Number.isSafeInteger(input?.contextEpoch) && input.contextEpoch >= 0, "WORKSPACE_CONTEXT_EPOCH_INVALID", "contextEpoch 无效", { status: 400 });
  return `wsk_${crypto.createHash("sha256").update(JSON.stringify(values)).digest("base64url")}`;
}

export function createSwitchDescriptorId(value) {
  return `switch_${crypto.createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

export function assertEasyWorkRemoteReference(value, field = "remoteRef") {
  const reference = String(value || "").replace(/\\/g, "/");
  invariant(reference.startsWith("~/.easywork/") && !reference.includes("\0") && !reference.split("/").includes(".."), "WORKSPACE_REMOTE_REFERENCE_INVALID", `${field} 必须位于 ~/.easywork`, { status: 500, expose: false });
  return reference;
}

export function assertRemoteControlPath(value, field = "remoteControlPath") {
  const canonical = canonicalWorkspacePath(value, field, { allowEasyWork: true });
  invariant(canonical.includes("/.easywork/"), "WORKSPACE_REMOTE_CONTROL_OUTSIDE_EASYWORK", `${field} 必须位于远端 .easywork`, { status: 500, expose: false });
  return canonical;
}

export function assertWorkspaceDependencies(dependencies) {
  invariant(dependencies?.actor?.actorType === "user" && dependencies.actor.userId, "AUTHENTICATION_REQUIRED", "工作区需要登录用户", { status: 401 });
  invariant(typeof dependencies?.dataRoot === "string" && path.isAbsolute(dependencies.dataRoot), "DATA_ROOT_INVALID", "dataRoot 必须是绝对路径", { status: 500, expose: false });
  for (const method of ["canonicalize", "resolveEasyWork", "ensureDirectory", "writeJsonAtomic"]) {
    invariant(typeof dependencies?.remoteControl?.[method] === "function", "WORKSPACE_REMOTE_CONTROL_INVALID", `remoteControl.${method} 无效`, { status: 500, expose: false });
  }
  for (const method of ["openDomain", "ensureConversationDomain"]) {
    invariant(typeof dependencies?.versioning?.[method] === "function", "WORKSPACE_VERSIONING_INVALID", `versioning.${method} 无效`, { status: 500, expose: false });
  }
  invariant(typeof dependencies?.authorizeConversation === "function", "WORKSPACE_CONVERSATION_AUTHORIZER_REQUIRED", "缺少对话鉴权器", { status: 500, expose: false });
}

export function assertWorkspaceStore(data, actorId) {
  invariant(data && typeof data === "object" && !Array.isArray(data), "WORKSPACE_STORE_INVALID", "工作区索引无效", { status: 500, expose: false });
  assertExactKeys(data, ["workspaces", "bindings", "routes", "commands"], "WorkspaceStore");
  invariant(Array.isArray(data.workspaces) && Array.isArray(data.bindings) && Array.isArray(data.routes) && Array.isArray(data.commands), "WORKSPACE_STORE_INVALID", "工作区索引结构无效", { status: 500, expose: false });
  const workspaceIds = new Set();
  const workspaceScopes = new Set();
  for (const workspace of data.workspaces) {
    assertExactKeys(workspace, [
      "schemaVersion", "id", "actorId", "serverIdentity", "kind", "canonicalPath", "remoteRef",
      "revision", "createdAt", "updatedAt",
    ], "Workspace");
    invariant(workspace?.schemaVersion === WORKSPACE_SCHEMA_VERSION && workspace.actorId === actorId, "WORKSPACE_STORE_SCOPE_MISMATCH", "工作区不属于当前 Actor", { status: 500, expose: false });
    assertId(workspace.id, "Workspace.id");
    invariant(!workspaceIds.has(workspace.id), "WORKSPACE_STORE_DUPLICATE", "工作区 ID 重复", { status: 500, expose: false });
    workspaceIds.add(workspace.id);
    assertWorkspaceKind(workspace.kind);
    assertServerIdentity(workspace.serverIdentity);
    canonicalWorkspacePath(workspace.canonicalPath, "Workspace.canonicalPath", { allowEasyWork: workspace.kind === "virtual" });
    const logicalScope = `${workspace.serverIdentity}\0${workspace.kind}\0${workspace.canonicalPath}`;
    invariant(!workspaceScopes.has(logicalScope), "WORKSPACE_STORE_DUPLICATE", "同一工作区范围不能重复", { status: 500, expose: false });
    workspaceScopes.add(logicalScope);
    if (workspace.kind === "virtual") invariant(workspace.canonicalPath.includes("/.easywork/workspaces/"), "WORKSPACE_VIRTUAL_PATH_INVALID", "虚拟工作区必须位于远端 .easywork/workspaces", { status: 500, expose: false });
    assertEasyWorkRemoteReference(workspace.remoteRef, "Workspace.remoteRef");
    invariant(Number.isSafeInteger(workspace.revision) && workspace.revision >= 0, "WORKSPACE_REVISION_INVALID", "Workspace revision 无效", { status: 500, expose: false });
    assertIsoTimestamp(workspace.createdAt, "Workspace.createdAt");
    assertIsoTimestamp(workspace.updatedAt, "Workspace.updatedAt");
  }
  const bindingIds = new Set();
  const bindingKeys = new Set();
  for (const binding of data.bindings) {
    assertExactKeys(binding, [
      "schemaVersion", "id", "bindingKey", "actorId", "conversationId", "branchId", "serverIdentity", "workspaceId",
      "versionDomainId", "agentId", "contextEpoch", "nativeSessionId", "lastDeliverySequence", "status", "remoteRef", "revision",
      "createdAt", "updatedAt",
    ], "WorkspaceBinding");
    invariant(binding?.schemaVersion === WORKSPACE_SCHEMA_VERSION && binding.actorId === actorId, "WORKSPACE_BINDING_SCOPE_MISMATCH", "工作区 Binding 不属于当前 Actor", { status: 500, expose: false });
    assertId(binding.id, "WorkspaceBinding.id");
    invariant(!bindingIds.has(binding.id) && !bindingKeys.has(binding.bindingKey), "WORKSPACE_BINDING_DUPLICATE", "工作区 Binding 重复", { status: 500, expose: false });
    bindingIds.add(binding.id);
    bindingKeys.add(binding.bindingKey);
    invariant(workspaceIds.has(binding.workspaceId), "WORKSPACE_BINDING_WORKSPACE_MISSING", "工作区 Binding 引用了不存在的 Workspace", { status: 500, expose: false });
    const workspace = data.workspaces.find((entry) => entry.id === binding.workspaceId);
    invariant(workspace.serverIdentity === binding.serverIdentity, "WORKSPACE_BINDING_SCOPE_MISMATCH", "工作区 Binding 与 Workspace 服务器范围不一致", { status: 500, expose: false });
    assertId(binding.versionDomainId, "WorkspaceBinding.versionDomainId");
    assertServerIdentity(binding.serverIdentity);
    assertId(binding.conversationId, "WorkspaceBinding.conversationId");
    assertId(binding.branchId, "WorkspaceBinding.branchId");
    assertId(binding.agentId, "WorkspaceBinding.agentId");
    invariant(Number.isSafeInteger(binding.contextEpoch) && binding.contextEpoch >= 0, "WORKSPACE_CONTEXT_EPOCH_INVALID", "WorkspaceBinding contextEpoch 无效", { status: 500, expose: false });
    invariant(binding.bindingKey === createWorkspaceBindingKey(binding), "WORKSPACE_BINDING_KEY_INVALID", "WorkspaceBinding key 与范围不一致", { status: 500, expose: false });
    assertNativeSessionId(binding.nativeSessionId);
    assertEasyWorkRemoteReference(binding.remoteRef, "WorkspaceBinding.remoteRef");
    invariant(WORKSPACE_BINDING_STATUSES.includes(binding.status), "WORKSPACE_BINDING_STATUS_INVALID", "WorkspaceBinding status 无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(binding.lastDeliverySequence) && binding.lastDeliverySequence >= 0, "WORKSPACE_BINDING_WATERMARK_INVALID", "WorkspaceBinding watermark 无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(binding.revision) && binding.revision >= 0, "WORKSPACE_BINDING_REVISION_INVALID", "WorkspaceBinding revision 无效", { status: 500, expose: false });
    assertIsoTimestamp(binding.createdAt, "WorkspaceBinding.createdAt");
    assertIsoTimestamp(binding.updatedAt, "WorkspaceBinding.updatedAt");
  }
  const routeKeys = new Set();
  for (const route of data.routes) {
    assertExactKeys(route, ["schemaVersion", "key", "actorId", "conversationId", "branchId", "bindingId", "revision", "createdAt", "updatedAt"], "WorkspaceRoute");
    invariant(route?.actorId === actorId && bindingIds.has(route.bindingId), "WORKSPACE_ROUTE_INVALID", "工作区 Route 无效", { status: 500, expose: false });
    invariant(!routeKeys.has(route.key), "WORKSPACE_ROUTE_DUPLICATE", "工作区 Route 重复", { status: 500, expose: false });
    routeKeys.add(route.key);
    const binding = data.bindings.find((entry) => entry.id === route.bindingId);
    invariant(route.key === `${route.conversationId}:${route.branchId}` && binding.conversationId === route.conversationId && binding.branchId === route.branchId, "WORKSPACE_ROUTE_INVALID", "工作区 Route 与 Binding 范围不一致", { status: 500, expose: false });
    invariant(Number.isSafeInteger(route.revision) && route.revision >= 0, "WORKSPACE_ROUTE_REVISION_INVALID", "WorkspaceRoute revision 无效", { status: 500, expose: false });
    assertIsoTimestamp(route.createdAt, "WorkspaceRoute.createdAt");
    assertIsoTimestamp(route.updatedAt, "WorkspaceRoute.updatedAt");
  }
  const commandIds = new Set();
  for (const command of data.commands) {
    assertExactKeys(command, ["commandId", "operation", "fingerprint", "result", "completedAt"], "WorkspaceCommand");
    assertCommandId(command.commandId);
    invariant(!commandIds.has(command.commandId), "WORKSPACE_COMMAND_DUPLICATE", "Workspace commandId 重复", { status: 500, expose: false });
    commandIds.add(command.commandId);
    invariant(typeof command.operation === "string" && command.operation.startsWith("workspace."), "WORKSPACE_COMMAND_INVALID", "Workspace command operation 无效", { status: 500, expose: false });
    invariant(/^[a-f0-9]{64}$/.test(command.fingerprint), "WORKSPACE_COMMAND_INVALID", "Workspace command fingerprint 无效", { status: 500, expose: false });
    invariant(command.result && typeof command.result === "object" && !Array.isArray(command.result), "WORKSPACE_COMMAND_INVALID", "Workspace command result 无效", { status: 500, expose: false });
    assertIsoTimestamp(command.completedAt, "WorkspaceCommand.completedAt");
  }
  return true;
}
