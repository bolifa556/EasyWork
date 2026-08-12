import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { ARTIFACT_KINDS, validateArtifact } from "../entities/artifact.mjs";
import {
  assertEnum,
  assertId,
  assertInteger,
  assertIsoTimestamp,
  assertNullableId,
  assertNullableString,
  assertSha256,
  assertString,
} from "../entities/common.mjs";

export const ARTIFACT_STORE_SCHEMA_VERSION = 1;
export const ARTIFACT_LIFECYCLES = Object.freeze(["active", "pinned", "deleted", "expired"]);
export const ARTIFACT_CONTENT_LOCATIONS = Object.freeze(["host-small-file", "remote-reference"]);

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function assertArtifactCommandId(value, field = "commandId") {
  return assertString(String(value || ""), field, { max: 256, pattern: COMMAND_ID_PATTERN });
}

export function assertArtifactName(value, field = "name") {
  const name = assertString(String(value || ""), field, { max: 512 });
  invariant(!/[\\/\0\r\n]/.test(name) && name !== "." && name !== "..", "ARTIFACT_NAME_INVALID", "Artifact 名称无效", { status: 400 });
  return name;
}

export function assertMime(value, field = "mime") {
  const mime = assertString(String(value || ""), field, { max: 512 });
  invariant(/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;.*)?$/i.test(mime), "ARTIFACT_MIME_INVALID", "Artifact MIME 无效", { status: 400 });
  return mime;
}

export function assertLifecycle(value, field = "lifecycle") {
  return assertEnum(value, ARTIFACT_LIFECYCLES, field);
}

export function assertArtifactVersion(version, field = "ArtifactVersion") {
  invariant(version && typeof version === "object" && !Array.isArray(version), "ARTIFACT_VERSION_INVALID", `${field} 无效`, { status: 500, expose: false });
  const expected = ["id", "ordinal", "source", "contentLocation", "size", "sha256", "mime", "capturedAt"];
  invariant(Object.keys(version).length === expected.length && expected.every((key) => Object.hasOwn(version, key)), "ARTIFACT_VERSION_INVALID", `${field} 字段无效`, { status: 500, expose: false });
  assertId(version.id, `${field}.id`);
  assertInteger(version.ordinal, `${field}.ordinal`, { min: 1 });
  assertEnum(version.source, ["host", "remote"], `${field}.source`);
  assertEnum(version.contentLocation, ARTIFACT_CONTENT_LOCATIONS, `${field}.contentLocation`);
  assertInteger(version.size, `${field}.size`, { min: 0 });
  assertSha256(version.sha256, `${field}.sha256`);
  assertMime(version.mime, `${field}.mime`);
  assertIsoTimestamp(version.capturedAt, `${field}.capturedAt`);
  invariant(
    (version.source === "host" && version.contentLocation === "host-small-file")
      || (version.source === "remote" && version.contentLocation === "remote-reference"),
    "ARTIFACT_VERSION_SOURCE_INVALID",
    `${field} 的内容位置与来源不一致`,
    { status: 500, expose: false },
  );
  return true;
}

export function assertArtifactRecord(record) {
  invariant(record && typeof record === "object" && !Array.isArray(record), "ARTIFACT_RECORD_INVALID", "Artifact 记录无效", { status: 500, expose: false });
  const keys = [
    "schemaVersion", "entityType", "revision", "id", "actorId", "taskId", "conversationId", "workspaceId", "projectId",
    "name", "kind", "mime", "size", "sha256", "source", "contentLocation", "lifecycle", "activeVersionId", "versions",
    "originArtifact", "locators", "promotion", "expiresAt", "pinnedAt", "deletedAt", "createdAt", "updatedAt",
  ];
  invariant(Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)), "ARTIFACT_RECORD_INVALID", "Artifact 记录字段无效", { status: 500, expose: false });
  invariant(record.schemaVersion === ARTIFACT_STORE_SCHEMA_VERSION && record.entityType === "ArtifactRecord", "ARTIFACT_RECORD_SCHEMA_INVALID", "Artifact 记录 schema 无效", { status: 500, expose: false });
  assertInteger(record.revision, "ArtifactRecord.revision", { min: 0 });
  assertId(record.id, "ArtifactRecord.id");
  assertId(record.actorId, "ArtifactRecord.actorId");
  assertId(record.taskId, "ArtifactRecord.taskId");
  assertId(record.conversationId, "ArtifactRecord.conversationId");
  assertId(record.workspaceId, "ArtifactRecord.workspaceId");
  assertNullableId(record.projectId, "ArtifactRecord.projectId");
  assertArtifactName(record.name, "ArtifactRecord.name");
  assertEnum(record.kind, ARTIFACT_KINDS, "ArtifactRecord.kind");
  assertMime(record.mime, "ArtifactRecord.mime");
  assertInteger(record.size, "ArtifactRecord.size", { min: 0 });
  assertSha256(record.sha256, "ArtifactRecord.sha256");
  assertEnum(record.source, ["host", "remote"], "ArtifactRecord.source");
  assertEnum(record.contentLocation, ARTIFACT_CONTENT_LOCATIONS, "ArtifactRecord.contentLocation");
  assertLifecycle(record.lifecycle, "ArtifactRecord.lifecycle");
  assertId(record.activeVersionId, "ArtifactRecord.activeVersionId");
  invariant(Array.isArray(record.versions) && record.versions.length >= 1 && record.versions.length <= 1000, "ARTIFACT_VERSIONS_INVALID", "Artifact 版本列表无效", { status: 500, expose: false });
  record.versions.forEach((version, index) => assertArtifactVersion(version, `ArtifactRecord.versions[${index}]`));
  invariant(record.versions.every((version, index) => version.ordinal === index + 1), "ARTIFACT_VERSION_SEQUENCE_INVALID", "Artifact 版本序号无效", { status: 500, expose: false });
  const activeVersion = record.versions.find((version) => version.id === record.activeVersionId);
  invariant(activeVersion, "ARTIFACT_ACTIVE_VERSION_MISSING", "Artifact 活动版本不存在", { status: 500, expose: false });
  invariant(activeVersion.size === record.size && activeVersion.sha256 === record.sha256 && activeVersion.mime === record.mime && activeVersion.source === record.source, "ARTIFACT_ACTIVE_VERSION_MISMATCH", "Artifact 活动版本与摘要不一致", { status: 500, expose: false });
  validateArtifact(record.originArtifact);
  invariant(
    record.originArtifact.id === record.id
      && record.originArtifact.actorId === record.actorId
      && record.originArtifact.taskId === record.taskId
      && record.originArtifact.kind === record.kind
      && record.originArtifact.source === record.versions[0].source
      && record.originArtifact.size === record.versions[0].size
      && record.originArtifact.sha256 === record.versions[0].sha256
      && record.originArtifact.mime === record.versions[0].mime,
    "ARTIFACT_ORIGIN_MISMATCH",
    "Artifact 原始实体与记录不一致",
    { status: 500, expose: false },
  );
  invariant(Array.isArray(record.locators) && record.locators.length === record.versions.length, "ARTIFACT_LOCATORS_INVALID", "Artifact 私有定位符无效", { status: 500, expose: false });
  for (const locator of record.locators) {
    invariant(locator && typeof locator === "object" && !Array.isArray(locator), "ARTIFACT_LOCATOR_INVALID", "Artifact 私有定位符无效", { status: 500, expose: false });
    const locatorKeys = ["versionId", "source", "actorRelativePath", "remotePath", "serverIdentity"];
    invariant(Object.keys(locator).length === locatorKeys.length && locatorKeys.every((key) => Object.hasOwn(locator, key)), "ARTIFACT_LOCATOR_INVALID", "Artifact 私有定位符字段无效", { status: 500, expose: false });
    const version = record.versions.find((entry) => entry.id === locator.versionId);
    invariant(version && locator.source === version.source, "ARTIFACT_LOCATOR_MISMATCH", "Artifact 私有定位符与版本不一致", { status: 500, expose: false });
    if (locator.source === "host") {
      invariant(typeof locator.actorRelativePath === "string" && locator.remotePath === null && locator.serverIdentity === null, "ARTIFACT_HOST_LOCATOR_INVALID", "主机 Artifact 定位符无效", { status: 500, expose: false });
    } else {
      invariant(typeof locator.remotePath === "string" && locator.actorRelativePath === null && typeof locator.serverIdentity === "string", "ARTIFACT_REMOTE_LOCATOR_INVALID", "远端 Artifact 定位符无效", { status: 500, expose: false });
    }
  }
  if (record.promotion !== null) {
    invariant(record.promotion && typeof record.promotion === "object", "ARTIFACT_PROMOTION_INVALID", "Artifact 转存记录无效", { status: 500, expose: false });
    const promotionKeys = ["projectId", "resourceVersionId", "bindingId", "promotedAt"];
    invariant(Object.keys(record.promotion).length === promotionKeys.length && promotionKeys.every((key) => Object.hasOwn(record.promotion, key)), "ARTIFACT_PROMOTION_INVALID", "Artifact 转存记录字段无效", { status: 500, expose: false });
    assertId(record.promotion.projectId, "ArtifactRecord.promotion.projectId");
    assertId(record.promotion.resourceVersionId, "ArtifactRecord.promotion.resourceVersionId");
    assertId(record.promotion.bindingId, "ArtifactRecord.promotion.bindingId");
    assertIsoTimestamp(record.promotion.promotedAt, "ArtifactRecord.promotion.promotedAt");
    invariant(record.projectId === record.promotion.projectId, "ARTIFACT_PROMOTION_PROJECT_MISMATCH", "Artifact 转存项目不一致", { status: 500, expose: false });
  }
  invariant(record.projectId === null || record.promotion !== null, "ARTIFACT_PROJECT_WITHOUT_PROMOTION", "Artifact 项目关联缺少转存记录", { status: 500, expose: false });
  assertNullableString(record.expiresAt, "ArtifactRecord.expiresAt", { max: 64 });
  assertNullableString(record.pinnedAt, "ArtifactRecord.pinnedAt", { max: 64 });
  assertNullableString(record.deletedAt, "ArtifactRecord.deletedAt", { max: 64 });
  if (record.expiresAt !== null) assertIsoTimestamp(record.expiresAt, "ArtifactRecord.expiresAt");
  if (record.pinnedAt !== null) assertIsoTimestamp(record.pinnedAt, "ArtifactRecord.pinnedAt");
  if (record.deletedAt !== null) assertIsoTimestamp(record.deletedAt, "ArtifactRecord.deletedAt");
  assertIsoTimestamp(record.createdAt, "ArtifactRecord.createdAt");
  assertIsoTimestamp(record.updatedAt, "ArtifactRecord.updatedAt");
  invariant(record.updatedAt >= record.createdAt, "ARTIFACT_TIMESTAMP_ORDER_INVALID", "Artifact 更新时间不能早于创建时间", { status: 500, expose: false });
  invariant(record.lifecycle === "pinned" ? record.pinnedAt !== null : record.pinnedAt === null, "ARTIFACT_PIN_STATE_INVALID", "Artifact 固定状态无效", { status: 500, expose: false });
  invariant(record.lifecycle === "deleted" ? record.deletedAt !== null : record.deletedAt === null, "ARTIFACT_DELETE_STATE_INVALID", "Artifact 删除状态无效", { status: 500, expose: false });
  return true;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function commandFingerprint(operation, input) {
  return crypto.createHash("sha256").update(canonicalJson({ operation, input })).digest("hex");
}

export function commandFileName(commandId) {
  return `${crypto.createHash("sha256").update(assertArtifactCommandId(commandId)).digest("hex")}.json`;
}

export function publicArtifactSummary(record) {
  assertArtifactRecord(record);
  return {
    id: record.id,
    revision: record.revision,
    taskId: record.taskId,
    conversationId: record.conversationId,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    name: record.name,
    kind: record.kind,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
    source: record.source,
    contentLocation: record.contentLocation,
    lifecycle: record.lifecycle,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function publicArtifactDetail(record) {
  return {
    ...publicArtifactSummary(record),
    versions: clone(record.versions),
    promotion: clone(record.promotion),
  };
}
