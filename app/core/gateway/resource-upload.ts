import type { GatewayClient } from "./client";
import { commandId } from "./client";

export type ResourceOwner = {
  ownerType: "collection" | "project" | "conversation";
  ownerId: string;
  path?: string | null;
  createdSequence?: number;
  messageId?: string;
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

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256Fallback(buffer: ArrayBuffer) {
  const input = new Uint8Array(buffer);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = BigInt(input.length) * 8n;
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffff_ffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn), false);

  const hash = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUNDS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((value) => value.toString(16).padStart(8, "0")).join("");
}

async function sha256(file: File) {
  const content = await file.arrayBuffer();
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) return toHex(await subtle.digest("SHA-256", content));
  } catch {
    // In non-secure embedded browsers Web Crypto may be present without a usable
    // SubtleCrypto implementation. The deterministic local implementation below
    // preserves the upload integrity contract in that environment.
  }
  return sha256Fallback(content);
}

export async function uploadResource<T = ResourceUploadResult>(
  api: GatewayClient,
  file: File,
  owner: ResourceOwner,
  expectedRevision: number,
  idempotencyKey?: string,
  summaryModel?: { providerId: string; modelId: string },
) {
  const contentSha256 = await sha256(file);
  const query = new URLSearchParams({
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    filename: file.name,
    size: String(file.size),
  });
  if (owner.path) query.set("path", owner.path);
  if (owner.createdSequence !== undefined) query.set("createdSequence", String(owner.createdSequence));
  if (owner.messageId) query.set("messageId", owner.messageId);
  if (summaryModel?.providerId && summaryModel?.modelId) {
    query.set("providerId", summaryModel.providerId);
    query.set("modelId", summaryModel.modelId);
  }
  return api.upload<T>(`/api/resources/upload?${query}`, file, {
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-content-sha256": contentSha256,
    },
    expectedRevision,
    idempotencyKey: idempotencyKey || commandId("resource-upload"),
  });
}
