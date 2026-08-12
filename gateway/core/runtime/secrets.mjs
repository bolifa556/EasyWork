import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";

const SECRET_FILE_VERSION = 1;

function validateSecret(value, field) {
  const result = String(value || "");
  invariant(result.length >= 32, "RUNTIME_SECRET_INVALID", `${field} 至少需要 32 个字符`, { status: 500, expose: false });
  return result;
}

function validateDocument(value) {
  invariant(
    value?.schemaVersion === SECRET_FILE_VERSION
      && typeof value.sessionSecret === "string"
      && typeof value.masterSecret === "string"
      && typeof value.cursorSecret === "string"
      && typeof value.artifactSecret === "string",
    "RUNTIME_SECRET_STORE_INVALID",
    "Gateway 运行密钥文件损坏",
    { status: 500, expose: false },
  );
  return Object.freeze({
    sessionSecret: validateSecret(value.sessionSecret, "sessionSecret"),
    masterSecret: validateSecret(value.masterSecret, "masterSecret"),
    cursorSecret: validateSecret(value.cursorSecret, "cursorSecret"),
    artifactSecret: validateSecret(value.artifactSecret, "artifactSecret"),
  });
}

async function atomicCreate(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    if (error?.code !== "EEXIST") throw error;
  }
}

export async function loadOrCreateRuntimeSecrets(dataRoot, supplied = {}) {
  invariant(path.isAbsolute(dataRoot || ""), "RUNTIME_DATA_ROOT_INVALID", "dataRoot 必须是绝对路径", { status: 500, expose: false });
  if (supplied.sessionSecret || supplied.masterSecret || supplied.cursorSecret || supplied.artifactSecret) {
    return validateDocument({ schemaVersion: SECRET_FILE_VERSION, ...supplied });
  }
  const filePath = path.join(dataRoot, "admins", "runtime-secrets.json");
  try {
    return validateDocument(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const generated = {
    schemaVersion: SECRET_FILE_VERSION,
    sessionSecret: crypto.randomBytes(48).toString("base64url"),
    masterSecret: crypto.randomBytes(48).toString("base64url"),
    cursorSecret: crypto.randomBytes(48).toString("base64url"),
    artifactSecret: crypto.randomBytes(48).toString("base64url"),
  };
  await atomicCreate(filePath, generated);
  try {
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  return validateDocument(JSON.parse(await fs.readFile(filePath, "utf8")));
}
