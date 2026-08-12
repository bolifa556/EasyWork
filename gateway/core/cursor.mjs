import crypto from "node:crypto";

import { ApiError, invariant } from "./errors.mjs";

function deriveKey(secret, namespace) {
  invariant(typeof secret === "string" && secret.length >= 32, "CURSOR_SECRET_INVALID", "游标签名密钥至少需要 32 个字符", {
    status: 500,
    expose: false,
  });
  return crypto.createHash("sha256").update(`${namespace}\0${secret}`).digest();
}

function decodePart(value) {
  try {
    const decoded = Buffer.from(value, "base64url");
    invariant(decoded.toString("base64url") === value, "CURSOR_INVALID", "游标编码不是规范格式", { status: 400 });
    return decoded;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("CURSOR_INVALID", "游标格式无效", { status: 400, cause: error });
  }
}

export function createOpaqueCursorCodec(options) {
  const namespace = String(options?.namespace || "default");
  const key = deriveKey(options?.secret, namespace);
  const defaultTtlMs = options?.defaultTtlMs ?? 24 * 60 * 60 * 1000;

  return Object.freeze({
    encode(value, encodeOptions = {}) {
      const now = encodeOptions.now ?? Date.now();
      const ttlMs = encodeOptions.ttlMs ?? defaultTtlMs;
      invariant(Number.isSafeInteger(now) && Number.isSafeInteger(ttlMs) && ttlMs > 0, "CURSOR_TTL_INVALID", "游标有效期无效", {
        status: 500,
        expose: false,
      });
      const plaintext = Buffer.from(JSON.stringify({
        namespace,
        issuedAt: now,
        expiresAt: now + ttlMs,
        value,
      }));
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`easywork-cursor:${namespace}:v1`));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`;
    },

    decode(token, decodeOptions = {}) {
      try {
        const [version, ivPart, encryptedPart, tagPart, extra] = String(token || "").split(".");
        invariant(version === "v1" && ivPart && encryptedPart && tagPart && !extra, "CURSOR_INVALID", "游标格式无效", { status: 400 });
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, decodePart(ivPart));
        decipher.setAAD(Buffer.from(`easywork-cursor:${namespace}:v1`));
        decipher.setAuthTag(decodePart(tagPart));
        const plaintext = Buffer.concat([decipher.update(decodePart(encryptedPart)), decipher.final()]);
        const decoded = JSON.parse(plaintext.toString("utf8"));
        invariant(decoded.namespace === namespace, "CURSOR_INVALID", "游标不属于当前接口", { status: 400 });
        const now = decodeOptions.now ?? Date.now();
        invariant(Number.isSafeInteger(decoded.expiresAt) && decoded.expiresAt >= now, "CURSOR_EXPIRED", "游标已过期", { status: 410 });
        return decoded.value;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError("CURSOR_INVALID", "游标无效或已被篡改", { status: 400, cause: error });
      }
    },
  });
}
