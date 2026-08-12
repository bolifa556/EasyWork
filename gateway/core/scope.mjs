import crypto from "node:crypto";
import net from "node:net";
import { domainToASCII } from "node:url";

import { invariant } from "./errors.mjs";

function optionalId(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value);
  invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result), "SCOPE_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return result;
}

export function normalizeSshHost(host) {
  let value = String(host || "").trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (net.isIP(value)) return value;
  value = domainToASCII(value).replace(/\.$/, "");
  invariant(value && value.length <= 253 && value.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)), "SSH_HOST_INVALID", "SSH 主机名无效", { status: 400 });
  return value;
}

export function computeServerIdentity(server) {
  const host = normalizeSshHost(server?.host);
  const port = Number(server?.port ?? 22);
  const hostKeyFingerprint = String(server?.hostKeyFingerprint || "").trim();
  invariant(Number.isInteger(port) && port >= 1 && port <= 65535, "SSH_PORT_INVALID", "SSH 端口无效", { status: 400 });
  invariant(/^(?:SHA256:)?[A-Za-z0-9+/=_-]{16,}$/.test(hostKeyFingerprint), "SSH_HOST_KEY_REQUIRED", "必须使用已确认的 SSH 主机指纹计算 serverIdentity", { status: 400 });
  const canonical = `${host}:${port}|${hostKeyFingerprint}`;
  const digest = crypto.createHash("sha256").update(canonical).digest("base64url");
  return Object.freeze({
    serverIdentity: `ssh_${digest}`,
    host,
    port,
    hostKeyFingerprint,
  });
}

export function createEffectiveContextScope(input) {
  const actor = input?.actor;
  invariant(actor?.actorType === "user" || actor?.actorType === "guest", "ACTOR_CONTEXT_REQUIRED", "Scope 需要有效 ActorContext", { status: 401 });
  invariant(typeof actor.actorId === "string" && actor.actorId.length > 0, "ACTOR_CONTEXT_REQUIRED", "Scope 需要有效 actorId", { status: 401 });
  const server = input?.server ? computeServerIdentity(input.server) : null;
  const memoryMode = input?.memoryMode || "project-only";
  invariant(["project-only", "global"].includes(memoryMode), "MEMORY_MODE_INVALID", "memoryMode 无效", { status: 400 });
  const conversationId = optionalId(input?.conversationId, "conversationId");
  invariant(conversationId, "CONVERSATION_ID_REQUIRED", "Scope 需要 conversationId", { status: 400 });
  const contextEpoch = Number(input?.contextEpoch ?? 0);
  invariant(Number.isSafeInteger(contextEpoch) && contextEpoch >= 0, "CONTEXT_EPOCH_INVALID", "contextEpoch 无效", { status: 400 });

  const snapshotSequence = Number(input?.memorySnapshotSequence ?? 0);
  invariant(Number.isSafeInteger(snapshotSequence) && snapshotSequence >= 0, "MEMORY_SNAPSHOT_INVALID", "memorySnapshotSequence 无效", { status: 400 });
  const baselineSequence = input?.memoryBaselineSequence == null ? null : Number(input.memoryBaselineSequence);
  invariant(baselineSequence === null || (Number.isSafeInteger(baselineSequence) && baselineSequence >= 0 && baselineSequence <= snapshotSequence), "MEMORY_BASELINE_INVALID", "memoryBaselineSequence 无效", { status: 400 });

  return Object.freeze({
    actorType: actor.actorType,
    actorId: actor.actorId,
    userId: actor.userId || null,
    projectId: optionalId(input?.projectId, "projectId"),
    conversationId,
    workspaceId: optionalId(input?.workspaceId, "workspaceId"),
    taskId: optionalId(input?.taskId, "taskId"),
    serverId: optionalId(input?.serverId, "serverId"),
    serverIdentity: server?.serverIdentity || null,
    versionDomainId: optionalId(input?.versionDomainId, "versionDomainId"),
    memoryMode,
    branchId: optionalId(input?.branchId || "main", "branchId"),
    memorySnapshotSequence: snapshotSequence,
    memoryBaselineSequence: baselineSequence,
    memorySnapshotVersionIds: Object.freeze([...(input?.memorySnapshotVersionIds || [])].map(String)),
    resourceBindingSnapshotId: optionalId(input?.resourceBindingSnapshotId, "resourceBindingSnapshotId"),
    selectedCollectionIds: Object.freeze([...(input?.selectedCollectionIds || [])].map(String)),
    selectedSkillVersions: Object.freeze((input?.selectedSkillVersions || []).map((entry) => Object.freeze({
      skillId: String(entry.skillId),
      version: String(entry.version),
    }))),
    capabilities: Object.freeze([...new Set((input?.capabilities || []).map(String))].sort()),
    contextEpoch,
  });
}

export function createAgentBindingKey(scope, agentId) {
  const value = [
    scope?.actorType,
    scope?.actorId,
    scope?.serverIdentity,
    scope?.workspaceId,
    agentId,
    scope?.conversationId,
    scope?.branchId,
    scope?.contextEpoch,
  ];
  invariant(value.every((entry) => entry !== null && entry !== undefined && entry !== ""), "AGENT_BINDING_SCOPE_INCOMPLETE", "Agent binding 缺少服务器、工作区或对话 Scope", { status: 400 });
  return `abk_${crypto.createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}
