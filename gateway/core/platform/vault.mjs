import crypto from "node:crypto";

import { invariant } from "../errors.mjs";

function deriveKey(masterSecret, scope) {
  invariant(typeof masterSecret === "string" && masterSecret.length >= 32, "PROVIDER_MASTER_KEY_INVALID", "Provider 主密钥至少需要 32 个字符", {
    status: 500,
    expose: false,
  });
  return crypto.createHmac("sha256", masterSecret).update(`easywork:providers\0${scope}`).digest();
}

export function normalizeApiKey(value) {
  const apiKey = String(value || "").trim();
  invariant(apiKey.length >= 4 && apiKey.length <= 8192 && !/[\r\n\0]/.test(apiKey), "PROVIDER_API_KEY_INVALID", "API Key 格式无效", { status: 400 });
  return apiKey;
}

export function maskApiKey(value) {
  if (!value) return null;
  const text = String(value);
  return `${"•".repeat(8)}${text.slice(-4)}`;
}

export class ProviderSecretVault {
  constructor({ masterSecret, scope }) {
    invariant(typeof scope === "string" && scope.length > 0, "PROVIDER_VAULT_SCOPE_INVALID", "Provider vault scope 无效", {
      status: 500,
      expose: false,
    });
    this.scope = scope;
    this.key = deriveKey(masterSecret, scope);
  }

  seal(value, providerId) {
    const apiKey = normalizeApiKey(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`easywork:provider:${this.scope}:${providerId}:v1`));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return Object.freeze({
      version: 1,
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    });
  }

  open(sealed, providerId) {
    invariant(sealed?.version === 1 && sealed.iv && sealed.ciphertext && sealed.tag, "PROVIDER_SECRET_INVALID", "Provider 密钥记录无效", {
      status: 500,
      expose: false,
    });
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64url"));
      decipher.setAAD(Buffer.from(`easywork:provider:${this.scope}:${providerId}:v1`));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
      return normalizeApiKey(Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"));
    } catch (error) {
      throw Object.assign(new Error("Provider 密钥无法解密"), {
        code: "PROVIDER_SECRET_DECRYPT_FAILED",
        status: 500,
        cause: error,
      });
    }
  }

  describe(sealed, providerId) {
    if (!sealed) return Object.freeze({ hasKey: false, maskedKey: null });
    const apiKey = this.open(sealed, providerId);
    return Object.freeze({ hasKey: true, maskedKey: maskApiKey(apiKey) });
  }
}
