import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const VIRTUAL_WORKSPACE = "__virtual__";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function exactObject(value, allowed, operation) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "WORK_DRAFT_INPUT_INVALID", `${operation}参数无效`, { status: 400 });
  invariant(Object.keys(value).every((key) => allowed.includes(key)), "WORK_DRAFT_INPUT_SCHEMA_INVALID", `${operation}参数不符合 EasyWork 协议`, {
    status: 400,
    details: { allowed },
  });
  return value;
}

function optionalIdentifier(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value);
  invariant(IDENTIFIER.test(normalized), "WORK_DRAFT_IDENTIFIER_INVALID", `${field}格式无效`, { status: 400 });
  return normalized;
}

function normalizedSelection(input) {
  exactObject(input, ["serverId", "agentId", "workspaceId", "workspacePath"], "Work 草稿");
  const serverId = optionalIdentifier(input.serverId, "serverId");
  const agentId = optionalIdentifier(input.agentId, "agentId");
  let workspaceId = input.workspaceId === VIRTUAL_WORKSPACE
    ? VIRTUAL_WORKSPACE
    : optionalIdentifier(input.workspaceId, "workspaceId");
  let workspacePath = input.workspacePath === null || input.workspacePath === undefined
    ? null
    : String(input.workspacePath).trim();
  invariant(workspacePath === null || (workspacePath.length > 0 && workspacePath.length <= 4096 && !workspacePath.includes("\0")), "WORK_DRAFT_PATH_INVALID", "workspacePath 格式无效", { status: 400 });
  invariant(serverId || (!agentId && !workspaceId && !workspacePath), "WORK_DRAFT_DEPENDENCY_INVALID", "选择 Agent 前必须先选择服务器", { status: 400 });
  invariant(agentId || (!workspaceId && !workspacePath), "WORK_DRAFT_DEPENDENCY_INVALID", "选择工作区前必须先选择 Agent", { status: 400 });
  if (!serverId) return { serverId: null, agentId: null, workspaceId: null, workspacePath: null };
  if (!agentId) return { serverId, agentId: null, workspaceId: null, workspacePath: null };
  if (!workspaceId) workspacePath = null;
  return { serverId, agentId, workspaceId, workspacePath };
}

function validSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!Object.keys(value).every((key) => ["serverId", "agentId", "workspaceId", "workspacePath"].includes(key))) return false;
  try {
    normalizedSelection(value);
    return true;
  } catch {
    return false;
  }
}

function validState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !validSelection(data.selection) || !Array.isArray(data.commands)) return false;
  return data.commands.every((entry) => entry
    && typeof entry.commandId === "string"
    && IDENTIFIER.test(entry.commandId)
    && /^[a-f0-9]{64}$/.test(entry.fingerprint)
    && Number.isSafeInteger(entry.revision)
    && entry.revision > 0
    && typeof entry.completedAt === "string"
    && validSelection(entry.selection));
}

function commandIdentifier(value) {
  const commandId = String(value || "");
  invariant(IDENTIFIER.test(commandId), "WORK_DRAFT_COMMAND_ID_INVALID", "Work 草稿 commandId 无效", { status: 400 });
  return commandId;
}

function fingerprint(operation, selection) {
  return crypto.createHash("sha256").update(JSON.stringify({ operation, selection })).digest("hex");
}

function publicSnapshot(snapshot) {
  return {
    selection: clone(snapshot.data.selection),
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt,
  };
}

export class WorkDraftService {
  constructor({ dataRoot, actor, queue, clock = () => new Date() }) {
    this.clock = clock;
    this.repository = new AtomicJsonRepository({
      dataRoot,
      actor,
      relativePath: ["preferences", "work-draft.json"],
      schemaVersion: 1,
      defaultData: () => ({
        selection: { serverId: null, agentId: null, workspaceId: null, workspacePath: null },
        commands: [],
      }),
      validate: validState,
      queue,
    });
  }

  async get() {
    return publicSnapshot(await this.repository.read());
  }

  async replace(input) {
    exactObject(input, ["selection", "expectedRevision", "commandId"], "保存 Work 草稿");
    const selection = normalizedSelection(input.selection);
    return this.#mutate("replace", selection, input);
  }

  async clear(input) {
    exactObject(input, ["expectedRevision", "commandId"], "清除 Work 草稿");
    const selection = { serverId: null, agentId: null, workspaceId: null, workspacePath: null };
    return this.#mutate("clear", selection, input);
  }

  async #mutate(operation, selection, input) {
    const commandId = commandIdentifier(input.commandId);
    const commandFingerprint = fingerprint(operation, selection);
    for (;;) {
      const current = await this.repository.read();
      const replay = current.data.commands.find((entry) => entry.commandId === commandId);
      if (replay) {
        invariant(replay.fingerprint === commandFingerprint, "IDEMPOTENCY_KEY_REUSED", "同一个 Idempotency-Key 不能用于不同的 Work 草稿写入", { status: 409 });
        return { selection: clone(replay.selection), revision: replay.revision, updatedAt: replay.completedAt, replayed: true };
      }
      invariant(current.revision === Number(input.expectedRevision), "REVISION_CONFLICT", "Work 草稿已在其他设备更新", {
        status: 409,
        details: { expectedRevision: Number(input.expectedRevision), actualRevision: current.revision },
      });
      const completedAt = this.clock().toISOString();
      const revision = current.revision + 1;
      try {
        const updated = await this.repository.update((data) => {
          data.selection = clone(selection);
          data.commands.push({ commandId, fingerprint: commandFingerprint, revision, completedAt, selection: clone(selection) });
          data.commands = data.commands.slice(-100);
        }, { expectedRevision: current.revision, clock: () => new Date(completedAt) });
        return { ...publicSnapshot(updated), replayed: false };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }
}

export { VIRTUAL_WORKSPACE as WORK_DRAFT_VIRTUAL_WORKSPACE };
