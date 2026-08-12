import { invariant } from "../errors.mjs";
import {
  assertEntityHeader,
  assertEnum,
  assertExactKeys,
  assertId,
  assertInteger,
  assertNullableId,
  assertNullableServerIdentity,
  assertNullableString,
  assertSha256,
  assertString,
  clone,
  createHeader,
  deepFreeze,
  revisedHeader,
} from "./common.mjs";

export const ARTIFACT_KINDS = Object.freeze(["file", "patch", "report", "image", "log", "archive"]);
export const ARTIFACT_SOURCES = Object.freeze(["remote", "host"]);

const ARTIFACT_KEYS = [
  "schemaVersion", "entityType", "revision", "id", "actorId", "taskId", "serverIdentity", "kind", "source",
  "remotePath", "blobId", "size", "sha256", "mime", "createdAt", "updatedAt",
];

export function validateArtifact(artifact) {
  assertExactKeys(artifact, ARTIFACT_KEYS, "Artifact");
  assertEntityHeader(artifact, "Artifact");
  assertId(artifact.id, "Artifact.id");
  assertId(artifact.actorId, "Artifact.actorId");
  assertId(artifact.taskId, "Artifact.taskId");
  assertNullableServerIdentity(artifact.serverIdentity, "Artifact.serverIdentity");
  assertEnum(artifact.kind, ARTIFACT_KINDS, "Artifact.kind");
  assertEnum(artifact.source, ARTIFACT_SOURCES, "Artifact.source");
  assertNullableString(artifact.remotePath, "Artifact.remotePath", { max: 32768 });
  assertNullableId(artifact.blobId, "Artifact.blobId");
  assertInteger(artifact.size, "Artifact.size", { min: 0 });
  assertSha256(artifact.sha256, "Artifact.sha256", { nullable: true });
  assertString(artifact.mime, "Artifact.mime", { max: 512 });
  if (artifact.source === "remote") {
    invariant(artifact.serverIdentity !== null && artifact.remotePath !== null && artifact.blobId === null, "ARTIFACT_REMOTE_SOURCE_INVALID", "远端 Artifact 必须包含 serverIdentity 和 remotePath，且不能绑定 host blob", { status: 400 });
  } else {
    invariant(artifact.serverIdentity === null && artifact.remotePath === null && artifact.blobId !== null, "ARTIFACT_HOST_SOURCE_INVALID", "主机 Artifact 必须绑定 blob，且不能包含远端路径", { status: 400 });
  }
  return true;
}

export function createArtifact(input, options = {}) {
  assertExactKeys(input, ["id", "actorId", "taskId", "serverIdentity", "kind", "source", "remotePath", "blobId", "size", "sha256", "mime"], "ArtifactInput");
  const artifact = {
    ...createHeader("Artifact", options),
    ...clone(input),
  };
  validateArtifact(artifact);
  return deepFreeze(artifact);
}

export function materializeRemoteArtifact(artifact, input, options = {}) {
  validateArtifact(artifact);
  invariant(artifact.source === "remote", "ARTIFACT_NOT_REMOTE", "只有远端 Artifact 可以物化为主机 Blob", { status: 409 });
  assertExactKeys(input, ["blobId", "size", "sha256", "mime"], "ArtifactMaterialization");
  const next = {
    ...clone(artifact),
    ...revisedHeader(artifact, options.expectedRevision, options),
    source: "host",
    serverIdentity: null,
    remotePath: null,
    blobId: input.blobId,
    size: input.size,
    sha256: input.sha256,
    mime: input.mime,
  };
  validateArtifact(next);
  return deepFreeze(next);
}
