import { invariant } from "../errors.mjs";
import {
  assertEntityHeader,
  assertEnum,
  assertExactKeys,
  assertId,
  assertInteger,
  assertNullableId,
  assertNullableString,
  assertPortableRelativePath,
  assertSha256,
  assertString,
  clone,
  createHeader,
  deepFreeze,
  revisedHeader,
} from "./common.mjs";

export const RESOURCE_PROCESSING_STATUSES = Object.freeze(["pending", "ready", "failed"]);
export const RESOURCE_BINDING_OWNER_TYPES = Object.freeze(["collection", "project", "conversation", "task"]);

const BLOB_KEYS = ["schemaVersion", "entityType", "revision", "id", "actorId", "sha256", "size", "mime", "storagePath", "createdAt", "updatedAt"];
const VERSION_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "resourceId", "blobId", "filename", "parseStatus",
  "embeddingStatus", "parserVersion", "embeddingProfileId", "parseError", "embeddingError", "createdAt", "updatedAt",
];
const BINDING_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "resourceVersionId", "ownerType", "ownerId", "path",
  "createdSequence", "invalidatedSequence", "createdAt", "updatedAt",
];

export function validateResourceBlob(blob) {
  assertExactKeys(blob, BLOB_KEYS, "ResourceBlob");
  assertEntityHeader(blob, "ResourceBlob");
  assertId(blob.id, "ResourceBlob.id");
  assertId(blob.actorId, "ResourceBlob.actorId");
  assertSha256(blob.sha256, "ResourceBlob.sha256");
  assertInteger(blob.size, "ResourceBlob.size", { min: 0 });
  assertString(blob.mime, "ResourceBlob.mime", { max: 512 });
  assertPortableRelativePath(blob.storagePath, "ResourceBlob.storagePath", { prefix: "resources/blobs" });
  return true;
}

export function createResourceBlob(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "sha256", "size", "mime", "storagePath"], "ResourceBlobInput");
  const blob = { ...createHeader("ResourceBlob", options), ...clone(input) };
  validateResourceBlob(blob);
  return deepFreeze(blob);
}

export function validateResourceVersion(version) {
  assertExactKeys(version, VERSION_KEYS, "ResourceVersion");
  assertEntityHeader(version, "ResourceVersion");
  assertId(version.id, "ResourceVersion.id");
  assertId(version.actorId, "ResourceVersion.actorId");
  assertId(version.resourceId, "ResourceVersion.resourceId");
  assertId(version.blobId, "ResourceVersion.blobId");
  assertString(version.filename, "ResourceVersion.filename", { max: 4096 });
  assertEnum(version.parseStatus, RESOURCE_PROCESSING_STATUSES, "ResourceVersion.parseStatus");
  assertEnum(version.embeddingStatus, RESOURCE_PROCESSING_STATUSES, "ResourceVersion.embeddingStatus");
  assertString(version.parserVersion, "ResourceVersion.parserVersion", { max: 256 });
  assertNullableId(version.embeddingProfileId, "ResourceVersion.embeddingProfileId");
  assertNullableString(version.parseError, "ResourceVersion.parseError", { max: 16384 });
  assertNullableString(version.embeddingError, "ResourceVersion.embeddingError", { max: 16384 });
  invariant(version.parseStatus === "failed" ? version.parseError !== null : version.parseError === null, "RESOURCE_PARSE_ERROR_STATE_INVALID", "parseError 只能用于 failed 状态", { status: 400 });
  invariant(version.embeddingStatus === "failed" ? version.embeddingError !== null : version.embeddingError === null, "RESOURCE_EMBEDDING_ERROR_STATE_INVALID", "embeddingError 只能用于 failed 状态", { status: 400 });
  invariant(version.embeddingStatus === "pending" || version.embeddingProfileId !== null, "RESOURCE_EMBEDDING_PROFILE_REQUIRED", "已处理的 Embedding 必须关联 profile", { status: 400 });
  invariant(version.embeddingStatus !== "ready" || version.parseStatus === "ready", "RESOURCE_EMBEDDING_REQUIRES_PARSE", "解析未完成时 Embedding 不能 ready", { status: 400 });
  return true;
}

export function createResourceVersion(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "resourceId", "blobId", "filename", "parserVersion"], "ResourceVersionInput");
  const version = {
    ...createHeader("ResourceVersion", options),
    ...clone(input),
    parseStatus: "pending",
    embeddingStatus: "pending",
    embeddingProfileId: null,
    parseError: null,
    embeddingError: null,
  };
  validateResourceVersion(version);
  return deepFreeze(version);
}

export function updateResourceVersionProcessing(version, changes, options = {}) {
  validateResourceVersion(version);
  assertExactKeys(changes, ["parseStatus", "embeddingStatus", "parserVersion", "embeddingProfileId", "parseError", "embeddingError"], "ResourceVersionProcessingChanges");
  const next = {
    ...clone(version),
    ...revisedHeader(version, options.expectedRevision, options),
    ...clone(changes),
  };
  validateResourceVersion(next);
  return deepFreeze(next);
}

export function isResourceKnowledgeReady(version) {
  validateResourceVersion(version);
  return version.parseStatus === "ready" && version.embeddingStatus === "ready" && version.embeddingProfileId !== null;
}

export function validateResourceBinding(binding) {
  assertExactKeys(binding, BINDING_KEYS, "ResourceBinding");
  assertEntityHeader(binding, "ResourceBinding");
  assertId(binding.id, "ResourceBinding.id");
  assertId(binding.actorId, "ResourceBinding.actorId");
  assertId(binding.resourceVersionId, "ResourceBinding.resourceVersionId");
  assertEnum(binding.ownerType, RESOURCE_BINDING_OWNER_TYPES, "ResourceBinding.ownerType");
  assertId(binding.ownerId, "ResourceBinding.ownerId");
  if (binding.path !== null) assertPortableRelativePath(binding.path, "ResourceBinding.path");
  assertInteger(binding.createdSequence, "ResourceBinding.createdSequence", { min: 0 });
  if (binding.invalidatedSequence !== null) {
    assertInteger(binding.invalidatedSequence, "ResourceBinding.invalidatedSequence", { min: 0 });
    invariant(binding.invalidatedSequence >= binding.createdSequence, "RESOURCE_BINDING_SEQUENCE_INVALID", "invalidatedSequence 不能早于 createdSequence", { status: 400 });
  }
  return true;
}

export function createResourceBinding(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "resourceVersionId", "ownerType", "ownerId", "path", "createdSequence"], "ResourceBindingInput");
  const binding = {
    ...createHeader("ResourceBinding", options),
    ...clone(input),
    invalidatedSequence: null,
  };
  validateResourceBinding(binding);
  return deepFreeze(binding);
}

export function invalidateResourceBinding(binding, invalidatedSequence, options = {}) {
  validateResourceBinding(binding);
  invariant(binding.invalidatedSequence === null, "RESOURCE_BINDING_ALREADY_INVALIDATED", "ResourceBinding 已失效", { status: 409 });
  const next = {
    ...clone(binding),
    ...revisedHeader(binding, options.expectedRevision, options),
    invalidatedSequence,
  };
  validateResourceBinding(next);
  return deepFreeze(next);
}
