import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

function deriveKey(masterSecret, actor) {
  invariant(typeof masterSecret === "string" && masterSecret.length >= 32, "CREDENTIAL_MASTER_KEY_INVALID", "SSH 凭据主密钥至少需要 32 个字符", {
    status: 500,
    expose: false,
  });
  return crypto.createHash("sha256").update(`easywork:ssh\0${actor.actorType}\0${actor.actorId}\0${masterSecret}`).digest();
}

function validateServerId(serverId) {
  const value = String(serverId || "");
  invariant(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value), "SERVER_ID_INVALID", "Server id 无效", { status: 400 });
  return value;
}

function validateCredential(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "SSH_CREDENTIAL_INVALID", "SSH 凭据无效", { status: 400 });
  const method = String(value.method || "");
  invariant(["password", "private-key"].includes(method), "SSH_AUTH_METHOD_INVALID", "SSH 登录方式无效", { status: 400 });
  if (method === "password") {
    invariant(typeof value.password === "string" && value.password.length > 0, "SSH_PASSWORD_REQUIRED", "密码登录需要密码", { status: 400 });
    return { method, password: value.password };
  }
  invariant(typeof value.privateKey === "string" && value.privateKey.includes("PRIVATE KEY"), "SSH_PRIVATE_KEY_REQUIRED", "密钥登录需要有效私钥", { status: 400 });
  return {
    method,
    privateKey: value.privateKey,
    passphrase: typeof value.passphrase === "string" ? value.passphrase : "",
    fileName: typeof value.fileName === "string" ? value.fileName.slice(0, 256) : "private-key",
  };
}

export class SshCredentialVault {
  constructor({ dataRoot, actor, masterSecret, queue }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.key = deriveKey(masterSecret, actor);
    this.queue = queue;
  }

  #repository(serverId) {
    const id = validateServerId(serverId);
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["credentials", "ssh", `${id}.json`],
      schemaVersion: 1,
      defaultData: () => ({ sealed: null }),
      validate: (data) => data?.sealed === null || (
        typeof data?.sealed?.iv === "string"
        && typeof data.sealed.ciphertext === "string"
        && typeof data.sealed.tag === "string"
      ),
      queue: this.queue,
    });
  }

  async put(serverId, value) {
    const id = validateServerId(serverId);
    const credential = validateCredential(value);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`easywork:ssh:${this.actor.actorType}:${this.actor.actorId}:${id}:v1`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
    const sealed = { iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    const repository = this.#repository(id);
    for (;;) {
      const current = await repository.read();
      try {
        await repository.replace({ sealed }, { expectedRevision: current.revision });
        return { serverId: id, method: credential.method, stored: true };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async get(serverId) {
    const id = validateServerId(serverId);
    const state = await this.#repository(id).read();
    invariant(state.data.sealed, "SSH_CREDENTIAL_NOT_FOUND", "该服务器尚未保存 SSH 凭据", { status: 404 });
    try {
      const { iv, ciphertext, tag } = state.data.sealed;
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(`easywork:ssh:${this.actor.actorType}:${this.actor.actorId}:${id}:v1`));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return validateCredential(JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8")));
    } catch (error) {
      throw Object.assign(new Error("SSH 凭据无法解密"), { code: "SSH_CREDENTIAL_DECRYPT_FAILED", status: 500, cause: error });
    }
  }

  async clear(serverId) {
    const repository = this.#repository(serverId);
    for (;;) {
      const current = await repository.read();
      try {
        await repository.replace({ sealed: null }, { expectedRevision: current.revision });
        return { serverId: validateServerId(serverId), stored: false };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }
}

export { validateServerId };
