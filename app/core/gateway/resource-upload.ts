import type { GatewayClient } from "./client";
import { commandId } from "./client";

export type ResourceOwner = {
  ownerType: "collection" | "project" | "conversation";
  ownerId: string;
  path?: string | null;
  createdSequence?: number;
};

export type ResourceUploadResult = {
  revision: number;
  pendingRevision?: number;
  replayed?: boolean;
  blob: { id: string; sha256: string; size: number; mime: string };
  version: {
    id: string;
    filename: string;
    parseStatus: string;
    embeddingStatus: string;
    parseError: string | null;
    embeddingError: string | null;
    updatedAt: string;
    revision: number;
  };
  binding: { id: string; resourceVersionId: string; ownerType: string; ownerId: string; path: string | null };
};

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadResource<T = ResourceUploadResult>(
  api: GatewayClient,
  file: File,
  owner: ResourceOwner,
  expectedRevision: number,
) {
  const sha256 = toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  const query = new URLSearchParams({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: file.name,
    size: String(file.size),
  });
  if (owner.path) query.set("path", owner.path);
  if (owner.createdSequence !== undefined) query.set("createdSequence", String(owner.createdSequence));
  return api.upload<T>(`/api/resources/upload?${query}`, file, {
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-content-sha256": sha256,
    },
    expectedRevision,
    idempotencyKey: commandId("resource-upload"),
  });
}
