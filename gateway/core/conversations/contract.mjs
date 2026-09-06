import crypto from "node:crypto";

import { invariant } from "../errors.mjs";

export const CONVERSATION_SCHEMA_VERSION = 1;
export const CONVERSATION_MODES = Object.freeze(["chat", "work"]);
export const MESSAGE_ROLES = Object.freeze(["user", "assistant", "system", "tool"]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function assertInputKeys(value, allowedKeys, field = "input") {
  invariant(value && typeof value === "object" && !Array.isArray(value), "CONVERSATION_INPUT_REQUIRED", `${field} 必须是对象`, { status: 400 });
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  invariant(unknown.length === 0, "CONVERSATION_INPUT_UNKNOWN_FIELD", `${field} 包含未定义字段`, {
    status: 400,
    details: { field, unknown },
  });
  return value;
}

export function assertConversationId(value, field = "conversationId") {
  const result = String(value || "");
  invariant(ID_PATTERN.test(result), "CONVERSATION_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return result;
}

export function assertBranchId(value, field = "branchId") {
  const result = String(value || "");
  invariant(ID_PATTERN.test(result), "BRANCH_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return result;
}

export function assertMessageId(value, field = "messageId") {
  const result = String(value || "");
  invariant(ID_PATTERN.test(result), "MESSAGE_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return result;
}

export function assertCommandId(value) {
  const result = String(value || "");
  invariant(result.length >= 1 && result.length <= 512, "COMMAND_ID_INVALID", "commandId 长度无效", { status: 400 });
  invariant(!/[\u0000-\u001f\u007f]/.test(result), "COMMAND_ID_INVALID", "commandId 包含控制字符", { status: 400 });
  return result;
}

export function assertConversationMode(value) {
  invariant(CONVERSATION_MODES.includes(value), "CONVERSATION_MODE_INVALID", "对话模式必须是 chat 或 work", { status: 400 });
  return value;
}

export function assertMessageRole(value) {
  invariant(MESSAGE_ROLES.includes(value), "MESSAGE_ROLE_INVALID", "消息角色无效", { status: 400 });
  return value;
}

export function assertMessageContent(value) {
  invariant(typeof value === "string" && value.trim().length > 0, "MESSAGE_CONTENT_REQUIRED", "消息内容不能为空", { status: 400 });
  invariant(Buffer.byteLength(value, "utf8") <= 4 * 1024 * 1024, "MESSAGE_CONTENT_TOO_LARGE", "消息内容不能超过 4 MiB", { status: 413 });
  return value;
}

export function assertConversationReferenceRequests(value) {
  if (value === undefined || value === null) return [];
  invariant(Array.isArray(value), "CONVERSATION_REFERENCES_INVALID", "对话引用必须是数组", { status: 400 });
  const seen = new Set();
  return value.map((entry, index) => {
    invariant(entry && typeof entry === "object" && !Array.isArray(entry), "CONVERSATION_REFERENCE_INVALID", `references[${index}] 无效`, { status: 400 });
    assertInputKeys(entry, ["type", "conversationId"], `references[${index}]`);
    invariant(entry.type === "conversation", "CONVERSATION_REFERENCE_TYPE_INVALID", "只支持引用 EasyWork 对话", { status: 400 });
    const conversationId = assertConversationId(entry.conversationId, `references[${index}].conversationId`);
    invariant(!seen.has(conversationId), "CONVERSATION_REFERENCE_DUPLICATE", "同一对话不能重复引用", { status: 400 });
    seen.add(conversationId);
    return Object.freeze({ type: "conversation", conversationId });
  });
}

export function assertTitle(value) {
  invariant(typeof value === "string", "CONVERSATION_TITLE_INVALID", "对话名称必须是字符串", { status: 400 });
  const result = value.trim();
  invariant(result.length >= 1 && result.length <= 240, "CONVERSATION_TITLE_INVALID", "对话名称长度无效", { status: 400 });
  return result;
}

export function assertOptionalProjectId(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value);
  invariant(ID_PATTERN.test(result), "PROJECT_ID_INVALID", "projectId 格式无效", { status: 400 });
  return result;
}

export function assertOptionalTaskId(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = String(value);
  invariant(ID_PATTERN.test(result), "TASK_ID_INVALID", "taskId 格式无效", { status: 400 });
  return result;
}

export function assertExpectedConversationRevision(value) {
  invariant(value !== undefined && value !== null, "EXPECTED_REVISION_REQUIRED", "写操作必须提供 expectedRevision", { status: 428 });
  const result = Number(value);
  invariant(Number.isSafeInteger(result) && result >= 0, "REVISION_INVALID", "expectedRevision 必须是非负安全整数", { status: 400 });
  return result;
}

export function assertLimit(value, fallback = 30) {
  if (value === undefined || value === null) return fallback;
  const result = Number(value);
  invariant(Number.isSafeInteger(result) && result >= 1 && result <= 100, "PAGE_LIMIT_INVALID", "limit 必须位于 1 到 100 之间", { status: 400 });
  return result;
}

export function createIdentifier(prefix, idFactory = () => crypto.randomUUID()) {
  const suffix = String(idFactory()).replace(/[^A-Za-z0-9._:-]/g, "");
  invariant(suffix.length > 0, "IDENTIFIER_FACTORY_INVALID", "idFactory 返回了无效标识", { status: 500, expose: false });
  return `${prefix}_${suffix}`;
}

export function defaultConversationTitle(content) {
  const firstLine = String(content).split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  const characters = Array.from(firstLine || "新对话");
  return characters.length <= 48 ? characters.join("") : `${characters.slice(0, 48).join("")}…`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function commandInputDigest(operation, input) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize({ operation, input }))).digest("hex");
}

export function commandFileName(commandId) {
  return `${crypto.createHash("sha256").update(commandId).digest("hex")}.json`;
}

export function clone(value) {
  return structuredClone(value);
}
