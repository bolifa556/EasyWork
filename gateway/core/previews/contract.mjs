import path from "node:path";

import { invariant } from "../errors.mjs";

export const PREVIEW_KINDS = Object.freeze([
  "text",
  "markdown",
  "json",
  "image",
  "pdf",
  "csv",
  "fallback",
]);

export const PREVIEW_SOURCE_KINDS = Object.freeze(["host", "remote"]);

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MIME_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;.*)?$/i;

export function assertExactObject(value, keys, field) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "PREVIEW_INPUT_INVALID", `${field} 必须是对象`, { status: 400 });
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  invariant(unknown.length === 0, "PREVIEW_INPUT_UNKNOWN_FIELD", `${field} 包含未定义字段`, {
    status: 400,
    details: { field, unknown },
  });
  return value;
}

export function assertOpaqueSourceId(value, field = "sourceId") {
  invariant(typeof value === "string" && OPAQUE_ID_PATTERN.test(value), "PREVIEW_SOURCE_ID_INVALID", `${field} 无效`, { status: 400 });
  return value;
}

export function assertRemoteRelativePath(value, field = "relativePath") {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 32768, "PREVIEW_REMOTE_PATH_INVALID", `${field} 无效`, { status: 400 });
  invariant(!value.includes("\\") && !value.includes("\0") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value), "PREVIEW_REMOTE_PATH_FORBIDDEN", "远端预览只接受工作区相对路径", { status: 400 });
  const segments = value.split("/");
  invariant(segments.every((segment) => segment && segment !== "." && segment !== ".."), "PREVIEW_REMOTE_PATH_FORBIDDEN", "远端预览路径不能逃逸工作区", { status: 400 });
  return value;
}

export function normalizePreviewSource(source) {
  invariant(source && typeof source === "object" && !Array.isArray(source), "PREVIEW_SOURCE_INVALID", "预览来源无效", { status: 400 });
  if (source.kind === "host") {
    assertExactObject(source, ["kind", "sourceId"], "source");
    return Object.freeze({ kind: "host", sourceId: assertOpaqueSourceId(source.sourceId) });
  }
  if (source.kind === "remote") {
    assertExactObject(source, ["kind", "serverIdentity", "workspaceId", "relativePath"], "source");
    return Object.freeze({
      kind: "remote",
      serverIdentity: assertOpaqueSourceId(source.serverIdentity, "serverIdentity"),
      workspaceId: assertOpaqueSourceId(source.workspaceId, "workspaceId"),
      relativePath: assertRemoteRelativePath(source.relativePath),
    });
  }
  invariant(false, "PREVIEW_SOURCE_INVALID", "预览来源必须是 host 或 remote", { status: 400 });
}

export function normalizeMime(value) {
  const mime = String(value || "application/octet-stream").trim().toLowerCase();
  invariant(mime.length <= 512 && MIME_PATTERN.test(mime), "PREVIEW_MIME_INVALID", "预览 MIME 无效", { status: 400 });
  return mime;
}

export function normalizePreviewName(value) {
  const name = String(value || "preview").trim();
  invariant(name.length > 0 && name.length <= 512 && !/[\0\r\n\\/]/.test(name) && name !== "." && name !== "..", "PREVIEW_NAME_INVALID", "预览名称无效", { status: 400 });
  return name;
}

export function previewKindFor({ mime, name = "" }) {
  const normalizedMime = normalizeMime(mime);
  const extension = path.posix.extname(String(name).toLowerCase());
  if (normalizedMime === "text/markdown" || normalizedMime === "text/x-markdown" || [".md", ".markdown"].includes(extension)) return "markdown";
  if (normalizedMime === "application/json" || normalizedMime.endsWith("+json") || extension === ".json") return "json";
  if (normalizedMime === "text/csv" || normalizedMime === "application/csv" || extension === ".csv") return "csv";
  if (normalizedMime.startsWith("image/")) return "image";
  if (normalizedMime === "application/pdf" || extension === ".pdf") return "pdf";
  if (normalizedMime.startsWith("text/") || [
    ".txt", ".log", ".yaml", ".yml", ".toml", ".ini", ".py", ".js", ".ts", ".tsx", ".jsx",
    ".css", ".html", ".sh", ".ps1", ".r", ".cpp", ".c", ".h", ".java", ".rs", ".go", ".sql",
  ].includes(extension)) return "text";
  return "fallback";
}

export function normalizeRange(range, size, maxRangeBytes) {
  if (range === undefined || range === null) return null;
  assertExactObject(range, ["start", "endExclusive"], "range");
  invariant(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.endExclusive), "PREVIEW_RANGE_INVALID", "Range 必须使用安全整数", { status: 416 });
  invariant(range.start >= 0 && range.endExclusive > range.start && range.endExclusive <= size, "PREVIEW_RANGE_INVALID", "Range 超出预览内容范围", { status: 416 });
  invariant(range.endExclusive - range.start <= maxRangeBytes, "PREVIEW_RANGE_TOO_LARGE", "单次 Range 超出上限", {
    status: 416,
    details: { maxRangeBytes },
  });
  return Object.freeze({ start: range.start, endExclusive: range.endExclusive });
}

export function publicPreviewDescriptor(session) {
  return Object.freeze({
    previewId: session.id,
    revision: session.revision,
    kind: session.kind,
    name: session.name,
    mime: session.mime,
    size: session.size,
    metadata: structuredClone(session.metadata),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    delivery: Object.freeze({
      endpoint: `/api/previews/${encodeURIComponent(session.id)}/content`,
      mode: ["image", "pdf", "fallback"].includes(session.kind) ? "stream" : "text-stream",
      acceptsRange: session.supportsRange,
      maxBytes: session.contentLimit,
      ...(session.kind === "csv" ? { maxRows: session.maxCsvRows } : {}),
    }),
  });
}
