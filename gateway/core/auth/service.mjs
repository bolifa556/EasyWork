import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createActorContext } from "../actor.mjs";
import { invariant } from "../errors.mjs";
import { actorDataRoot, resolveActorPath } from "../paths.mjs";
import { assertExpectedRevision } from "../revision.mjs";

const scryptAsync = promisify(crypto.scrypt);
const AUTH_SCHEMA_VERSION = 1;
const TOKEN_VERSION = "v1";
const USERNAME_PATTERN = /^[\p{L}\p{N}._-]+$/u;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const AVATAR_MIME = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const rootMutationTails = new Map();

function clone(value) {
  return structuredClone(value);
}

function iso(clock) {
  const date = clock();
  invariant(date instanceof Date && Number.isFinite(date.getTime()), "AUTH_CLOCK_INVALID", "Auth clock 无效", { status: 500, expose: false });
  return date.toISOString();
}

function normalizeUsername(value) {
  invariant(typeof value === "string", "USERNAME_REQUIRED", "请输入用户名", { status: 400 });
  const username = value.normalize("NFKC").trim();
  invariant(username.length >= 2 && username.length <= 64 && USERNAME_PATTERN.test(username), "USERNAME_INVALID", "用户名需为 2 至 64 个文字、数字、点、下划线或连字符", {
    status: 400,
  });
  return { username, key: username.toLocaleLowerCase("und") };
}

function assertPassword(value) {
  invariant(typeof value === "string" && value.length >= 8 && value.length <= 1024, "PASSWORD_INVALID", "密码长度需为 8 至 1024 个字符", { status: 400 });
  return value;
}

function assertDeviceId(value) {
  invariant(typeof value === "string" && DEVICE_ID_PATTERN.test(value), "DEVICE_ID_INVALID", "设备 ID 无效", { status: 400 });
  return value;
}

function assertUserId(value) {
  const userId = String(value || "");
  invariant(/^usr_[A-Za-z0-9-]+$/.test(userId), "USER_ID_INVALID", "用户 ID 无效", { status: 400 });
  return userId;
}

function assertExactInput(input, keys, name) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "AUTH_INPUT_INVALID", `${name} 参数无效`, { status: 400 });
  const allowed = new Set(keys);
  const actual = Object.keys(input);
  invariant(actual.every((key) => allowed.has(key)) && keys.every((key) => Object.hasOwn(input, key)), "AUTH_INPUT_SCHEMA_INVALID", `${name} 参数不符合当前协议`, {
    status: 400,
    details: { allowed: keys },
  });
}

function assertWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  invariant(relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)), "AUTH_PATH_ESCAPE", "Auth 路径越界", {
    status: 500,
    expose: false,
  });
  return candidate;
}

async function runRootMutation(dataRoot, operation) {
  const key = path.resolve(dataRoot);
  const previous = rootMutationTails.get(key) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => turn);
  rootMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (rootMutationTails.get(key) === tail) rootMutationTails.delete(key);
  }
}

async function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return clone(fallback);
    if (error instanceof SyntaxError) invariant(false, "AUTH_STORE_CORRUPT", "Auth 数据格式损坏", { status: 500, expose: false });
    throw error;
  }
}

function defaultAccounts() {
  return { schemaVersion: AUTH_SCHEMA_VERSION, revision: 0, updatedAt: null, accounts: {} };
}

function validateAccounts(value) {
  invariant(value && typeof value === "object" && value.schemaVersion === AUTH_SCHEMA_VERSION && Number.isSafeInteger(value.revision) && value.revision >= 0, "AUTH_ACCOUNTS_CORRUPT", "账号索引损坏", {
    status: 500,
    expose: false,
  });
  invariant(value.accounts && typeof value.accounts === "object" && !Array.isArray(value.accounts), "AUTH_ACCOUNTS_CORRUPT", "账号索引损坏", { status: 500, expose: false });
  for (const [key, account] of Object.entries(value.accounts)) {
    const normalized = normalizeUsername(account?.username);
    invariant(key === normalized.key && typeof account.userId === "string" && /^usr_[A-Za-z0-9-]+$/.test(account.userId), "AUTH_ACCOUNTS_CORRUPT", "账号索引损坏", {
      status: 500,
      expose: false,
    });
  }
  return value;
}

function validateProfile(value, userId) {
  invariant(value && typeof value === "object" && value.schemaVersion === AUTH_SCHEMA_VERSION && value.userId === userId, "AUTH_PROFILE_CORRUPT", "用户资料损坏", {
    status: 500,
    expose: false,
  });
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0, "AUTH_PROFILE_CORRUPT", "用户资料损坏", { status: 500, expose: false });
  normalizeUsername(value.username);
  validateStoredAvatar(value.avatar);
  invariant(value.password?.algorithm === "scrypt" && typeof value.password.salt === "string" && typeof value.password.hash === "string", "AUTH_PROFILE_CORRUPT", "密码记录损坏", {
    status: 500,
    expose: false,
  });
  return value;
}

function validateStoredAvatar(value) {
  if (value === null) return null;
  invariant(value && typeof value === "object" && !Array.isArray(value), "AUTH_PROFILE_CORRUPT", "头像记录损坏", { status: 500, expose: false });
  invariant(Object.keys(value).every((key) => ["mime", "size", "sha256", "storageName", "updatedAt"].includes(key)), "AUTH_PROFILE_CORRUPT", "头像记录损坏", { status: 500, expose: false });
  invariant(Object.hasOwn(AVATAR_MIME, value.mime) && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_AVATAR_BYTES, "AUTH_PROFILE_CORRUPT", "头像记录损坏", { status: 500, expose: false });
  invariant(/^[a-f0-9]{64}$/.test(value.sha256) && /^avatar-[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(value.storageName) && typeof value.updatedAt === "string", "AUTH_PROFILE_CORRUPT", "头像记录损坏", { status: 500, expose: false });
  return value;
}

function publicAvatar(value) {
  if (!value) return null;
  return Object.freeze({ mime: value.mime, size: value.size, sha256: value.sha256, url: "/api/profile/avatar", updatedAt: value.updatedAt });
}

function decodeAvatar(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "AVATAR_INPUT_INVALID", "头像参数无效", { status: 400 });
  invariant(Object.keys(value).every((key) => ["mime", "contentBase64"].includes(key)) && typeof value.mime === "string" && typeof value.contentBase64 === "string", "AVATAR_INPUT_INVALID", "头像参数无效", { status: 400 });
  const mime = value.mime.toLowerCase();
  invariant(Object.hasOwn(AVATAR_MIME, mime), "AVATAR_MIME_UNSUPPORTED", "头像仅支持 PNG、JPEG 或 WebP", { status: 415 });
  const encoded = value.contentBase64;
  invariant(encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), "AVATAR_ENCODING_INVALID", "头像 Base64 无效", { status: 400 });
  invariant(encoded.length <= Math.ceil(MAX_AVATAR_BYTES / 3) * 4, "AVATAR_TOO_LARGE", "头像不能超过 2 MB", { status: 413 });
  const bytes = Buffer.from(encoded, "base64");
  invariant(bytes.length > 0 && bytes.length <= MAX_AVATAR_BYTES, "AVATAR_TOO_LARGE", "头像不能超过 2 MB", { status: 413 });
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  invariant((mime === "image/png" && png) || (mime === "image/jpeg" && jpeg) || (mime === "image/webp" && webp), "AVATAR_CONTENT_MISMATCH", "头像内容与 MIME 不一致", { status: 415 });
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { bytes, mime, sha256, storageName: `avatar-${sha256}.${AVATAR_MIME[mime]}` };
}

function defaultDevices() {
  return { schemaVersion: AUTH_SCHEMA_VERSION, revision: 0, updatedAt: null, devices: [] };
}

function defaultSessions() {
  return { schemaVersion: AUTH_SCHEMA_VERSION, revision: 0, updatedAt: null, sessions: [] };
}

function assertCollectionEnvelope(value, key, code) {
  invariant(value && value.schemaVersion === AUTH_SCHEMA_VERSION && Number.isSafeInteger(value.revision) && value.revision >= 0 && Array.isArray(value[key]), code, "会话或设备数据损坏", {
    status: 500,
    expose: false,
  });
  return value;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminLines(text) {
  return String(text || "").split(/\r?\n/);
}

function isAdminLine(line, usernameKey) {
  const value = line.trim();
  if (!value || value.startsWith("#")) return false;
  try {
    return normalizeUsername(value).key === usernameKey;
  } catch {
    return false;
  }
}

export class AuthDeviceService {
  constructor(options) {
    invariant(typeof options?.dataRoot === "string" && path.isAbsolute(options.dataRoot), "DATA_ROOT_INVALID", "AuthDeviceService 需要绝对 dataRoot", { status: 500, expose: false });
    const secret = Buffer.isBuffer(options.sessionSecret) ? Buffer.from(options.sessionSecret) : Buffer.from(String(options.sessionSecret || ""));
    invariant(secret.length >= 32, "SESSION_SECRET_INVALID", "sessionSecret 至少需要 32 字节", { status: 500, expose: false });
    this.dataRoot = path.resolve(options.dataRoot);
    this.sessionSecret = secret;
    this.clock = options.clock || (() => new Date());
    this.sessionTtlMs = Number(options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000);
    invariant(Number.isSafeInteger(this.sessionTtlMs) && this.sessionTtlMs > 0, "SESSION_TTL_INVALID", "sessionTtlMs 无效", { status: 500, expose: false });
    this.activityTouchIntervalMs = Number(options.activityTouchIntervalMs ?? 5 * 60 * 1000);
    invariant(Number.isSafeInteger(this.activityTouchIntervalMs) && this.activityTouchIntervalMs >= 0, "ACTIVITY_TOUCH_INTERVAL_INVALID", "activityTouchIntervalMs 无效", { status: 500, expose: false });
    this.scrypt = Object.freeze({
      N: Number(options.scrypt?.N ?? 16384),
      r: Number(options.scrypt?.r ?? 8),
      p: Number(options.scrypt?.p ?? 1),
      keyLength: Number(options.scrypt?.keyLength ?? 32),
      maxmem: Number(options.scrypt?.maxmem ?? 64 * 1024 * 1024),
    });
    invariant([this.scrypt.N, this.scrypt.r, this.scrypt.p, this.scrypt.keyLength, this.scrypt.maxmem].every((value) => Number.isSafeInteger(value) && value > 0), "SCRYPT_PARAMETERS_INVALID", "scrypt 参数无效", {
      status: 500,
      expose: false,
    });
    this.accountsPath = assertWithin(this.dataRoot, path.join(this.dataRoot, "auth", "accounts.json"));
    this.adminListPath = assertWithin(this.dataRoot, path.join(this.dataRoot, "admins", "adminList"));
    this.profileJournalPath = assertWithin(this.dataRoot, path.join(this.dataRoot, "auth", "profile-pending.json"));
  }

  #profilePaths(actorType, actorId) {
    const actor = { actorType, actorId };
    const root = actorDataRoot(this.dataRoot, actor);
    return {
      root: path.join(root, "profile"),
      profile: resolveActorPath(this.dataRoot, actor, "profile", actorType === "user" ? "account.json" : "guest.json"),
      devices: resolveActorPath(this.dataRoot, actor, "profile", "devices.json"),
      sessions: resolveActorPath(this.dataRoot, actor, "profile", "sessions.json"),
    };
  }

  async #derivePassword(password, salt, params = this.scrypt) {
    const saltBytes = Buffer.from(String(salt), "base64url");
    invariant(saltBytes.length >= 16 && saltBytes.length <= 64, "AUTH_PASSWORD_SALT_INVALID", "密码 salt 无效", {
      status: 500,
      expose: false,
    });
    return Buffer.from(await scryptAsync(password, saltBytes, params.keyLength, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: params.maxmem,
    }));
  }

  async #passwordRecord(password) {
    const salt = crypto.randomBytes(16).toString("base64url");
    const hash = await this.#derivePassword(password, salt);
    return {
      algorithm: "scrypt",
      salt,
      hash: hash.toString("base64url"),
      params: clone(this.scrypt),
    };
  }

  async #verifyPassword(password, record) {
    const derived = await this.#derivePassword(password, record.salt, record.params);
    return safeEqual(derived, Buffer.from(record.hash, "base64url"));
  }

  #signSession(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", this.sessionSecret).update(`${TOKEN_VERSION}.${encoded}`).digest("base64url");
    return `${TOKEN_VERSION}.${encoded}.${signature}`;
  }

  #decodeSession(token, options = {}) {
    invariant(typeof token === "string", "SESSION_TOKEN_REQUIRED", "缺少登录会话", { status: 401 });
    const parts = token.split(".");
    invariant(parts.length === 3 && parts[0] === TOKEN_VERSION, "SESSION_TOKEN_INVALID", "登录会话无效", { status: 401 });
    const expected = crypto.createHmac("sha256", this.sessionSecret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
    invariant(safeEqual(expected, parts[2]), "SESSION_TOKEN_INVALID", "登录会话无效", { status: 401 });
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      invariant(false, "SESSION_TOKEN_INVALID", "登录会话无效", { status: 401 });
    }
    invariant(
      payload?.actorType === "user" || payload?.actorType === "guest",
      "SESSION_TOKEN_INVALID",
      "登录会话无效",
      { status: 401 },
    );
    invariant(typeof payload.actorId === "string" && DEVICE_ID_PATTERN.test(payload.actorId), "SESSION_TOKEN_INVALID", "登录会话无效", { status: 401 });
    invariant(typeof payload.sessionId === "string" && DEVICE_ID_PATTERN.test(payload.sessionId), "SESSION_TOKEN_INVALID", "登录会话无效", { status: 401 });
    assertDeviceId(payload.deviceId);
    invariant(Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp) && payload.exp > payload.iat, "SESSION_TOKEN_INVALID", "登录会话无效", { status: 401 });
    if (!options.allowExpired) invariant(this.clock().getTime() < payload.exp, "SESSION_EXPIRED", "登录会话已过期", { status: 401 });
    return payload;
  }

  async #readAdminText() {
    try {
      return await fs.readFile(this.adminListPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async #isAdminUsername(username) {
    const key = normalizeUsername(username).key;
    return adminLines(await this.#readAdminText()).some((line) => isAdminLine(line, key));
  }

  async #appendAdmin(username) {
    const current = await this.#readAdminText();
    const normalized = normalizeUsername(username);
    if (adminLines(current).some((line) => isAdminLine(line, normalized.key))) return;
    const prefix = current.length > 0 && !current.endsWith("\n") ? `${current}\n` : current;
    await atomicWrite(this.adminListPath, `${prefix}${normalized.username}\n`);
  }

  async #recoverProfileUpdate() {
    let journal;
    try {
      journal = JSON.parse(await fs.readFile(this.profileJournalPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    invariant(journal?.schemaVersion === AUTH_SCHEMA_VERSION && typeof journal.userId === "string" && ["keep", "replace", "remove"].includes(journal.avatarAction), "AUTH_PROFILE_JOURNAL_CORRUPT", "个人资料事务记录损坏", { status: 500, expose: false });
    const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
    delete accounts.accounts[journal.oldKey];
    accounts.accounts[journal.newKey] = { userId: journal.userId, username: journal.newUsername };
    if (accounts.revision < journal.accountsRevision) accounts.revision = journal.accountsRevision;
    accounts.updatedAt = journal.updatedAt;
    await writeJson(this.accountsPath, accounts);

    const profilePath = this.#profilePaths("user", journal.userId).profile;
    const profile = validateProfile(await readJson(profilePath, null), journal.userId);
    if (journal.avatarAction === "replace") {
      validateStoredAvatar(journal.avatar);
      const avatarPath = assertWithin(this.#profilePaths("user", journal.userId).root, path.join(this.#profilePaths("user", journal.userId).root, "avatars", journal.avatar.storageName));
      const bytes = await fs.readFile(avatarPath);
      invariant(bytes.length === journal.avatar.size && crypto.createHash("sha256").update(bytes).digest("hex") === journal.avatar.sha256, "AUTH_AVATAR_STORE_CORRUPT", "头像文件校验失败", { status: 500, expose: false });
    }
    profile.username = journal.newUsername;
    profile.avatar = journal.avatar;
    if (profile.revision < journal.profileRevision) profile.revision = journal.profileRevision;
    profile.updatedAt = journal.updatedAt;
    await writeJson(profilePath, profile);

    const adminText = await this.#readAdminText();
    const renamed = adminLines(adminText).map((line) => (isAdminLine(line, journal.oldKey) ? journal.newUsername : line));
    await atomicWrite(this.adminListPath, `${renamed.join("\n").replace(/\n+$/, "")}\n`);
    await fs.rm(this.profileJournalPath, { force: true });
  }

  async #writeActorCollections(actorType, actorId, devices, sessions) {
    const paths = this.#profilePaths(actorType, actorId);
    await writeJson(paths.devices, devices);
    await writeJson(paths.sessions, sessions);
  }

  #newSession(actorType, actorId, deviceId, now) {
    const sessionId = `ses_${crypto.randomUUID()}`;
    const iat = new Date(now).getTime();
    const exp = iat + this.sessionTtlMs;
    const token = this.#signSession({ actorType, actorId, sessionId, deviceId, iat, exp });
    return {
      token,
      record: {
        sessionId,
        deviceId,
        tokenHash: hashToken(token),
        issuedAt: new Date(iat).toISOString(),
        expiresAt: new Date(exp).toISOString(),
        lastSeenAt: new Date(iat).toISOString(),
        revokedAt: null,
        replacedBySessionId: null,
      },
    };
  }

  async #issueSession(actorType, actorId, deviceId, options = {}) {
    const paths = this.#profilePaths(actorType, actorId);
    const devices = assertCollectionEnvelope(await readJson(paths.devices, defaultDevices()), "devices", "AUTH_DEVICES_CORRUPT");
    const sessions = assertCollectionEnvelope(await readJson(paths.sessions, defaultSessions()), "sessions", "AUTH_SESSIONS_CORRUPT");
    const now = iso(this.clock);
    let device = devices.devices.find((entry) => entry.deviceId === deviceId);
    if (!device) {
      device = { deviceId, firstSeenAt: now, lastSeenAt: now, helpSeenAt: null };
      devices.devices.push(device);
    } else {
      device.lastSeenAt = now;
    }
    if (options.revokeDeviceSessions) {
      for (const session of sessions.sessions) {
        if (session.deviceId === deviceId && session.revokedAt === null) session.revokedAt = now;
      }
    }
    const created = this.#newSession(actorType, actorId, deviceId, now);
    if (options.replacedSessionId) {
      const replaced = sessions.sessions.find((entry) => entry.sessionId === options.replacedSessionId);
      if (replaced) {
        replaced.revokedAt = now;
        replaced.replacedBySessionId = created.record.sessionId;
      }
    }
    sessions.sessions.push(created.record);
    const nowMs = this.clock().getTime();
    sessions.sessions = sessions.sessions.filter((entry) => entry.revokedAt === null || Date.parse(entry.expiresAt) > nowMs - this.sessionTtlMs).slice(-200);
    devices.revision += 1;
    devices.updatedAt = now;
    sessions.revision += 1;
    sessions.updatedAt = now;
    await this.#writeActorCollections(actorType, actorId, devices, sessions);
    return { token: created.token, sessionId: created.record.sessionId, device, firstVisit: device.helpSeenAt === null };
  }

  async register(input) {
    assertExactInput(input, ["username", "password", "deviceId"], "注册");
    const normalized = normalizeUsername(input.username);
    const password = assertPassword(input.password);
    const deviceId = assertDeviceId(input.deviceId);
    const passwordRecord = await this.#passwordRecord(password);
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
      invariant(!accounts.accounts[normalized.key], "USERNAME_TAKEN", "用户名已存在", { status: 409 });
      const firstUser = Object.keys(accounts.accounts).length === 0;
      const userId = `usr_${crypto.randomUUID()}`;
      const paths = this.#profilePaths("user", userId);
      const now = iso(this.clock);
      const profile = {
        schemaVersion: AUTH_SCHEMA_VERSION,
        revision: 0,
        userId,
        username: normalized.username,
        avatar: null,
        password: passwordRecord,
        createdAt: now,
        updatedAt: now,
      };
      await writeJson(paths.profile, profile);
      accounts.accounts[normalized.key] = { userId, username: normalized.username };
      accounts.revision += 1;
      accounts.updatedAt = now;
      const adminBefore = firstUser ? await this.#readAdminText() : null;
      try {
        if (firstUser) await this.#appendAdmin(normalized.username);
        await writeJson(this.accountsPath, accounts);
      } catch (error) {
        if (firstUser) await atomicWrite(this.adminListPath, adminBefore).catch(() => undefined);
        await fs.rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const issued = await this.#issueSession("user", userId, deviceId, { revokeDeviceSessions: false });
      const admin = await this.#isAdminUsername(normalized.username);
      return this.#sessionResponse("user", userId, normalized.username, admin, issued, null);
    });
  }

  async login(input) {
    assertExactInput(input, ["username", "password", "deviceId"], "登录");
    const normalized = normalizeUsername(input.username);
    const password = assertPassword(input.password);
    const deviceId = assertDeviceId(input.deviceId);
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
      const account = accounts.accounts[normalized.key];
      let profile;
      if (account) profile = validateProfile(await readJson(this.#profilePaths("user", account.userId).profile, null), account.userId);
      const valid = profile
        ? await this.#verifyPassword(password, profile.password)
        : await this.#verifyPassword(password, {
          algorithm: "scrypt",
          salt: Buffer.alloc(16, 0xa5).toString("base64url"),
          hash: Buffer.alloc(this.scrypt.keyLength).toString("base64url"),
          params: this.scrypt,
        }).then(() => false);
      invariant(valid, "AUTHENTICATION_FAILED", "用户名或密码错误", { status: 401 });
      const issued = await this.#issueSession("user", account.userId, deviceId, { revokeDeviceSessions: true });
      const admin = await this.#isAdminUsername(profile.username);
      return this.#sessionResponse("user", account.userId, profile.username, admin, issued, profile.avatar);
    });
  }

  async createGuestSession(input) {
    assertExactInput(input, ["deviceId"], "访客会话");
    const deviceId = assertDeviceId(input.deviceId);
    return runRootMutation(this.dataRoot, async () => {
      const guestId = `gst_${crypto.randomUUID()}`;
      const paths = this.#profilePaths("guest", guestId);
      const now = iso(this.clock);
      await writeJson(paths.profile, {
        schemaVersion: AUTH_SCHEMA_VERSION,
        revision: 0,
        guestId,
        createdAt: now,
        updatedAt: now,
      });
      const issued = await this.#issueSession("guest", guestId, deviceId);
      return this.#sessionResponse("guest", guestId, null, false, issued);
    });
  }

  #sessionResponse(actorType, actorId, username, admin, issued, avatar = null) {
    const roles = admin ? ["admin"] : [];
    return {
      token: issued.token,
      expiresAt: new Date(this.#decodeSession(issued.token).exp).toISOString(),
      firstVisit: issued.firstVisit,
      profile: actorType === "user" ? { userId: actorId, username, avatar: publicAvatar(avatar), admin } : { guestId: actorId },
      actor: createActorContext({ actorType, actorId, deviceId: issued.device.deviceId, sessionId: issued.sessionId, roles }),
    };
  }

  async #resolveSessionUnlocked(token, options = {}) {
    const payload = this.#decodeSession(token, options);
    const paths = this.#profilePaths(payload.actorType, payload.actorId);
    const sessions = assertCollectionEnvelope(await readJson(paths.sessions, defaultSessions()), "sessions", "AUTH_SESSIONS_CORRUPT");
    const record = sessions.sessions.find((entry) => entry.sessionId === payload.sessionId);
    invariant(record && safeEqual(record.tokenHash, hashToken(token)), "SESSION_NOT_FOUND", "登录会话不存在", { status: 401 });
    invariant(record.revokedAt === null, "SESSION_REVOKED", "登录会话已退出", { status: 401 });
    if (!options.allowExpired) invariant(this.clock().getTime() < Date.parse(record.expiresAt), "SESSION_EXPIRED", "登录会话已过期", { status: 401 });
    let username = null;
    let avatar = null;
    let admin = false;
    if (payload.actorType === "user") {
      const profile = validateProfile(await readJson(paths.profile, null), payload.actorId);
      username = profile.username;
      avatar = profile.avatar;
      admin = await this.#isAdminUsername(username);
    }
    const devices = assertCollectionEnvelope(await readJson(paths.devices, defaultDevices()), "devices", "AUTH_DEVICES_CORRUPT");
    const device = devices.devices.find((entry) => entry.deviceId === payload.deviceId);
    invariant(device, "DEVICE_NOT_FOUND", "登录设备不存在", { status: 401 });
    return {
      payload,
      record,
      device,
      username,
      avatar,
      admin,
      actor: createActorContext({
        actorType: payload.actorType,
        actorId: payload.actorId,
        deviceId: payload.deviceId,
        sessionId: payload.sessionId,
        roles: admin ? ["admin"] : [],
      }),
      firstVisit: device.helpSeenAt === null,
      collections: { devices, sessions },
    };
  }

  async #touchResolved(resolved) {
    const now = this.clock();
    const lastSeen = Math.max(
      Date.parse(resolved.record.lastSeenAt || 0) || 0,
      Date.parse(resolved.device.lastSeenAt || 0) || 0,
    );
    if (now.getTime() - lastSeen < this.activityTouchIntervalMs) return;
    const timestamp = now.toISOString();
    resolved.record.lastSeenAt = timestamp;
    resolved.device.lastSeenAt = timestamp;
    resolved.collections.devices.revision += 1;
    resolved.collections.devices.updatedAt = timestamp;
    resolved.collections.sessions.revision += 1;
    resolved.collections.sessions.updatedAt = timestamp;
    await this.#writeActorCollections(
      resolved.payload.actorType,
      resolved.payload.actorId,
      resolved.collections.devices,
      resolved.collections.sessions,
    );
  }

  async resolveSession(token) {
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const resolved = await this.#resolveSessionUnlocked(token);
      await this.#touchResolved(resolved);
      return {
        actor: resolved.actor,
        firstVisit: resolved.firstVisit,
        profile: resolved.payload.actorType === "user"
          ? { userId: resolved.payload.actorId, username: resolved.username, avatar: publicAvatar(resolved.avatar), admin: resolved.admin }
          : { guestId: resolved.payload.actorId },
        expiresAt: resolved.record.expiresAt,
      };
    });
  }

  async refreshSession(token) {
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const resolved = await this.#resolveSessionUnlocked(token);
      const issued = await this.#issueSession(resolved.payload.actorType, resolved.payload.actorId, resolved.payload.deviceId, {
        replacedSessionId: resolved.payload.sessionId,
      });
      return this.#sessionResponse(resolved.payload.actorType, resolved.payload.actorId, resolved.username, resolved.admin, issued, resolved.avatar);
    });
  }

  async logout(token) {
    return runRootMutation(this.dataRoot, async () => {
      const resolved = await this.#resolveSessionUnlocked(token);
      const paths = this.#profilePaths(resolved.payload.actorType, resolved.payload.actorId);
      const sessions = assertCollectionEnvelope(await readJson(paths.sessions, defaultSessions()), "sessions", "AUTH_SESSIONS_CORRUPT");
      const record = sessions.sessions.find((entry) => entry.sessionId === resolved.payload.sessionId);
      record.revokedAt = iso(this.clock);
      sessions.revision += 1;
      sessions.updatedAt = record.revokedAt;
      await writeJson(paths.sessions, sessions);
      return { actorId: resolved.payload.actorId, sessionId: resolved.payload.sessionId, revoked: true };
    });
  }

  async listInactiveGuests(input = {}) {
    const inactiveBefore = input.inactiveBefore instanceof Date ? input.inactiveBefore : new Date(input.inactiveBefore);
    invariant(Number.isFinite(inactiveBefore.getTime()), "GUEST_CLEANUP_CUTOFF_INVALID", "访客清理时间无效", { status: 500, expose: false });
    const guestRoot = assertWithin(this.dataRoot, path.join(this.dataRoot, "guests"));
    let entries;
    try {
      entries = await fs.readdir(guestRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const now = this.clock().getTime();
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^gst_[A-Za-z0-9-]+$/.test(entry.name)) continue;
      try {
        const paths = this.#profilePaths("guest", entry.name);
        const [profile, devices, sessions] = await Promise.all([
          readJson(paths.profile, null),
          readJson(paths.devices, defaultDevices()),
          readJson(paths.sessions, defaultSessions()),
        ]);
        if (!profile || profile.guestId !== entry.name) continue;
        assertCollectionEnvelope(devices, "devices", "AUTH_DEVICES_CORRUPT");
        assertCollectionEnvelope(sessions, "sessions", "AUTH_SESSIONS_CORRUPT");
        if (sessions.sessions.some((session) => session.revokedAt === null && Date.parse(session.expiresAt) > now)) continue;
        const timestamps = [profile.updatedAt, profile.createdAt, devices.updatedAt, sessions.updatedAt,
          ...devices.devices.map((device) => device.lastSeenAt), ...sessions.sessions.map((session) => session.lastSeenAt)]
          .map((value) => Date.parse(value || 0)).filter(Number.isFinite);
        const lastActiveAt = timestamps.length ? Math.max(...timestamps) : 0;
        if (lastActiveAt <= inactiveBefore.getTime()) candidates.push({ actorId: entry.name, lastActiveAt: new Date(lastActiveAt).toISOString() });
      } catch {
        // Corrupt or partially-written guest data is deliberately retained for diagnosis.
      }
    }
    return candidates;
  }

  async markGuestCleanupPending(actorId) {
    const id = String(actorId || "");
    invariant(/^gst_[A-Za-z0-9-]+$/.test(id), "GUEST_ACTOR_ID_INVALID", "访客 Actor ID 无效", { status: 400 });
    return runRootMutation(this.dataRoot, async () => {
      const paths = this.#profilePaths("guest", id);
      const profile = await readJson(paths.profile, null);
      if (!profile) return { actorId: id, pending: false };
      invariant(profile.guestId === id, "GUEST_PROFILE_MISMATCH", "访客资料标识不一致", { status: 500, expose: false });
      await writeJson(resolveActorPath(this.dataRoot, { actorType: "guest", actorId: id }, "profile", "cleanup-pending.json"), {
        schemaVersion: AUTH_SCHEMA_VERSION,
        actorId: id,
        requestedAt: iso(this.clock),
      });
      return { actorId: id, pending: true };
    });
  }

  async listPendingGuestCleanup() {
    const guestRoot = assertWithin(this.dataRoot, path.join(this.dataRoot, "guests"));
    let entries;
    try { entries = await fs.readdir(guestRoot, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const pending = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^gst_[A-Za-z0-9-]+$/.test(entry.name)) continue;
      try {
        const marker = await readJson(resolveActorPath(this.dataRoot, { actorType: "guest", actorId: entry.name }, "profile", "cleanup-pending.json"), null);
        if (marker?.schemaVersion === AUTH_SCHEMA_VERSION && marker.actorId === entry.name) pending.push({ actorId: entry.name, requestedAt: marker.requestedAt });
      } catch { /* malformed markers remain on disk for diagnosis */ }
    }
    return pending;
  }

  async deleteGuestActor(actorId, input = {}) {
    const id = String(actorId || "");
    invariant(/^gst_[A-Za-z0-9-]+$/.test(id), "GUEST_ACTOR_ID_INVALID", "访客 Actor ID 无效", { status: 400 });
    return runRootMutation(this.dataRoot, async () => {
      const paths = this.#profilePaths("guest", id);
      let profile;
      try { profile = await readJson(paths.profile, null); } catch { return { actorId: id, deleted: false, reason: "corrupt" }; }
      if (!profile) return { actorId: id, deleted: false, reason: "missing" };
      invariant(profile.guestId === id, "GUEST_PROFILE_MISMATCH", "访客资料标识不一致", { status: 500, expose: false });
      const sessions = assertCollectionEnvelope(await readJson(paths.sessions, defaultSessions()), "sessions", "AUTH_SESSIONS_CORRUPT");
      const now = this.clock().getTime();
      invariant(!sessions.sessions.some((session) => session.revokedAt === null && Date.parse(session.expiresAt) > now), "GUEST_SESSION_ACTIVE", "访客仍有有效会话，不能清理", { status: 409 });
      if (input.inactiveBefore) {
        const listed = await this.listInactiveGuests({ inactiveBefore: input.inactiveBefore });
        invariant(listed.some((entry) => entry.actorId === id), "GUEST_RECENTLY_ACTIVE", "访客最近仍有活动，不能清理", { status: 409 });
      }
      await fs.rm(assertWithin(this.dataRoot, path.join(this.dataRoot, "guests", id)), { recursive: true, force: true });
      return { actorId: id, deleted: true, reason: null };
    });
  }

  async markHelpSeen(token) {
    return runRootMutation(this.dataRoot, async () => {
      const resolved = await this.#resolveSessionUnlocked(token);
      const paths = this.#profilePaths(resolved.payload.actorType, resolved.payload.actorId);
      const devices = assertCollectionEnvelope(await readJson(paths.devices, defaultDevices()), "devices", "AUTH_DEVICES_CORRUPT");
      const device = devices.devices.find((entry) => entry.deviceId === resolved.payload.deviceId);
      if (device.helpSeenAt === null) device.helpSeenAt = iso(this.clock);
      device.lastSeenAt = iso(this.clock);
      devices.revision += 1;
      devices.updatedAt = device.lastSeenAt;
      await writeJson(paths.devices, devices);
      return { deviceId: device.deviceId, firstVisit: false, helpSeenAt: device.helpSeenAt };
    });
  }

  async updateProfile(input) {
    invariant(input && typeof input === "object" && !Array.isArray(input), "AUTH_INPUT_INVALID", "个人资料参数无效", { status: 400 });
    const allowed = new Set(["token", "username", "avatar", "expectedRevision"]);
    invariant(Object.keys(input).every((key) => allowed.has(key)) && Object.hasOwn(input, "token") && Object.hasOwn(input, "expectedRevision") && (Object.hasOwn(input, "username") || Object.hasOwn(input, "avatar")), "AUTH_INPUT_SCHEMA_INVALID", "个人资料参数不符合当前协议", { status: 400 });
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const resolved = await this.#resolveSessionUnlocked(input.token);
      invariant(resolved.payload.actorType === "user", "AUTHENTICATION_REQUIRED", "访客不能修改用户名", { status: 401 });
      const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
      const profilePath = this.#profilePaths("user", resolved.payload.actorId).profile;
      const profile = validateProfile(await readJson(profilePath, null), resolved.payload.actorId);
      assertExpectedRevision(profile.revision, input.expectedRevision);
      const oldNormalized = normalizeUsername(resolved.username);
      const normalized = Object.hasOwn(input, "username") ? normalizeUsername(input.username) : oldNormalized;
      const conflict = accounts.accounts[normalized.key];
      invariant(!conflict || conflict.userId === resolved.payload.actorId, "USERNAME_TAKEN", "用户名已存在", { status: 409 });

      let avatar = profile.avatar;
      let avatarAction = "keep";
      let decoded = null;
      if (Object.hasOwn(input, "avatar")) {
        if (input.avatar === null) {
          avatar = null;
          avatarAction = profile.avatar ? "remove" : "keep";
        } else {
          decoded = decodeAvatar(input.avatar);
          if (profile.avatar?.sha256 !== decoded.sha256 || profile.avatar.mime !== decoded.mime) {
            avatarAction = "replace";
            avatar = {
              mime: decoded.mime,
              size: decoded.bytes.length,
              sha256: decoded.sha256,
              storageName: decoded.storageName,
              updatedAt: iso(this.clock),
            };
          }
        }
      }
      const usernameChanged = oldNormalized.key !== normalized.key || oldNormalized.username !== normalized.username;
      if (!usernameChanged && avatarAction === "keep") {
        return { userId: profile.userId, revision: profile.revision, username: profile.username, avatar: publicAvatar(profile.avatar), admin: resolved.admin };
      }

      const now = iso(this.clock);
      let createdAvatarPath = null;
      if (avatarAction === "replace") {
        const avatarsRoot = assertWithin(this.#profilePaths("user", resolved.payload.actorId).root, path.join(this.#profilePaths("user", resolved.payload.actorId).root, "avatars"));
        await fs.mkdir(avatarsRoot, { recursive: true });
        createdAvatarPath = assertWithin(avatarsRoot, path.join(avatarsRoot, avatar.storageName));
        try {
          const existing = await fs.readFile(createdAvatarPath);
          invariant(existing.length === avatar.size && crypto.createHash("sha256").update(existing).digest("hex") === avatar.sha256, "AUTH_AVATAR_STORE_CORRUPT", "头像文件校验失败", { status: 500, expose: false });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await atomicWrite(createdAvatarPath, decoded.bytes);
        }
      }
      const journal = {
        schemaVersion: AUTH_SCHEMA_VERSION,
        userId: resolved.payload.actorId,
        oldKey: oldNormalized.key,
        newKey: normalized.key,
        newUsername: normalized.username,
        accountsRevision: accounts.revision + (usernameChanged ? 1 : 0),
        profileRevision: profile.revision + 1,
        avatarAction,
        avatar,
        updatedAt: now,
      };
      await writeJson(this.profileJournalPath, journal);
      await this.#recoverProfileUpdate();
      if (profile.avatar?.storageName && profile.avatar.storageName !== avatar?.storageName) {
        const previous = assertWithin(this.#profilePaths("user", resolved.payload.actorId).root, path.join(this.#profilePaths("user", resolved.payload.actorId).root, "avatars", profile.avatar.storageName));
        await fs.rm(previous, { force: true }).catch(() => undefined);
      }
      return {
        userId: profile.userId,
        revision: journal.profileRevision,
        username: normalized.username,
        avatar: publicAvatar(avatar),
        admin: await this.#isAdminUsername(normalized.username),
      };
    });
  }

  async getProfile(token) {
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const resolved = await this.#resolveSessionUnlocked(token);
      if (resolved.payload.actorType === "guest") return { guestId: resolved.payload.actorId, revision: 0 };
      const profile = validateProfile(await readJson(this.#profilePaths("user", resolved.payload.actorId).profile, null), resolved.payload.actorId);
      return { userId: profile.userId, username: profile.username, avatar: publicAvatar(profile.avatar), revision: profile.revision, admin: resolved.admin };
    });
  }

  async openAvatar(token) {
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const resolved = await this.#resolveSessionUnlocked(token);
      invariant(resolved.payload.actorType === "user", "AVATAR_NOT_FOUND", "当前账号没有头像", { status: 404 });
      const paths = this.#profilePaths("user", resolved.payload.actorId);
      const profile = validateProfile(await readJson(paths.profile, null), resolved.payload.actorId);
      invariant(profile.avatar, "AVATAR_NOT_FOUND", "当前账号没有头像", { status: 404 });
      const avatarPath = assertWithin(paths.root, path.join(paths.root, "avatars", profile.avatar.storageName));
      const bytes = await fs.readFile(avatarPath);
      invariant(bytes.length === profile.avatar.size && crypto.createHash("sha256").update(bytes).digest("hex") === profile.avatar.sha256, "AUTH_AVATAR_STORE_CORRUPT", "头像文件校验失败", { status: 500, expose: false });
      return { descriptor: publicAvatar(profile.avatar), bytes };
    });
  }

  async listUsersForAdmin(actor) {
    invariant(actor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
      const items = [];
      for (const account of Object.values(accounts.accounts)) {
        const profile = validateProfile(await readJson(this.#profilePaths("user", account.userId).profile, null), account.userId);
        items.push({ userId: profile.userId, username: profile.username });
      }
      return items.sort((left, right) => left.username.localeCompare(right.username, "zh-CN"));
    });
  }

  async pageUsersForAdmin(actor, input = {}) {
    invariant(actor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    const query = String(input.query || "").normalize("NFKC").trim().toLocaleLowerCase("und");
    const page = Number(input.page ?? 1);
    const limit = Number(input.limit ?? 30);
    invariant(Number.isSafeInteger(page) && page > 0, "ADMIN_USER_PAGE_INVALID", "用户页码无效", { status: 400 });
    invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, "ADMIN_USER_LIMIT_INVALID", "用户分页大小无效", { status: 400 });
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
      const adminKeys = new Set(adminLines(await this.#readAdminText())
        .map((line) => {
          try { return normalizeUsername(line.trim()).key; } catch { return null; }
        })
        .filter(Boolean));
      const filtered = Object.entries(accounts.accounts)
        .filter(([key, account]) => !query || key.includes(query) || account.userId.toLocaleLowerCase("und").includes(query))
        .sort(([, left], [, right]) => left.username.localeCompare(right.username, "zh-CN"));
      const offset = (page - 1) * limit;
      const selected = filtered.slice(offset, offset + limit);
      const now = this.clock().getTime();
      const items = await Promise.all(selected.map(async ([key, account]) => {
        const paths = this.#profilePaths("user", account.userId);
        const [profile, devices, sessions] = await Promise.all([
          readJson(paths.profile, null),
          readJson(paths.devices, defaultDevices()),
          readJson(paths.sessions, defaultSessions()),
        ]);
        validateProfile(profile, account.userId);
        assertCollectionEnvelope(devices, "devices", "AUTH_DEVICES_CORRUPT");
        assertCollectionEnvelope(sessions, "sessions", "AUTH_SESSIONS_CORRUPT");
        const activeSessions = sessions.sessions.filter((session) => session.revokedAt === null && Date.parse(session.expiresAt) > now);
        const activity = [profile.updatedAt, profile.createdAt, ...devices.devices.map((device) => device.lastSeenAt), ...sessions.sessions.map((session) => session.lastSeenAt)]
          .map((value) => Date.parse(value || 0))
          .filter(Number.isFinite);
        return {
          userId: profile.userId,
          username: profile.username,
          admin: adminKeys.has(key),
          createdAt: profile.createdAt,
          lastActiveAt: activity.length ? new Date(Math.max(...activity)).toISOString() : null,
          deviceCount: devices.devices.length,
          activeSessionCount: activeSessions.length,
        };
      }));
      return {
        items,
        page,
        limit,
        total: filtered.length,
        hasMore: offset + items.length < filtered.length,
      };
    });
  }

  async getUserForAdmin(actor, userIdValue) {
    invariant(actor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    const userId = assertUserId(userIdValue);
    const page = await this.pageUsersForAdmin(actor, { query: userId, page: 1, limit: 2 });
    const user = page.items.find((item) => item.userId === userId);
    invariant(user, "ADMIN_USER_NOT_FOUND", "用户不存在", { status: 404 });
    return user;
  }

  async deleteUserForAdmin(actor, userIdValue) {
    invariant(actor?.roles?.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
    const userId = assertUserId(userIdValue);
    invariant(actor.actorId !== userId, "ADMIN_DELETE_SELF_FORBIDDEN", "不能删除当前登录的管理员", { status: 409 });
    return runRootMutation(this.dataRoot, async () => {
      await this.#recoverProfileUpdate();
      const accounts = validateAccounts(await readJson(this.accountsPath, defaultAccounts()));
      const accountEntry = Object.entries(accounts.accounts).find(([, account]) => account.userId === userId);
      invariant(accountEntry, "ADMIN_USER_NOT_FOUND", "用户不存在", { status: 404 });
      const [accountKey, account] = accountEntry;
      const previousAccounts = clone(accounts);
      const previousAdminText = await this.#readAdminText();
      const adminAccountKeys = new Set(adminLines(previousAdminText)
        .map((line) => {
          try { return normalizeUsername(line.trim()).key; } catch { return null; }
        })
        .filter((key) => key && accounts.accounts[key]));
      invariant(!adminAccountKeys.has(accountKey) || adminAccountKeys.size > 1, "ADMIN_DELETE_LAST_ADMIN_FORBIDDEN", "不能删除平台最后一个管理员", { status: 409 });

      const userRoot = actorDataRoot(this.dataRoot, { actorType: "user", actorId: userId });
      const usersRoot = path.dirname(userRoot);
      const deletingRoot = assertWithin(usersRoot, path.join(usersRoot, `.deleting-${userId}-${crypto.randomUUID()}`));
      await fs.rename(userRoot, deletingRoot);
      const now = iso(this.clock);
      delete accounts.accounts[accountKey];
      accounts.revision += 1;
      accounts.updatedAt = now;
      const nextAdminLines = adminLines(previousAdminText).filter((line) => !isAdminLine(line, accountKey));
      const nextAdminText = nextAdminLines.join("\n").replace(/\n+$/, "");
      try {
        await writeJson(this.accountsPath, accounts);
        await atomicWrite(this.adminListPath, nextAdminText ? `${nextAdminText}\n` : "");
        await fs.rm(deletingRoot, { recursive: true, force: true });
      } catch (error) {
        await writeJson(this.accountsPath, previousAccounts).catch(() => undefined);
        await atomicWrite(this.adminListPath, previousAdminText).catch(() => undefined);
        await fs.rename(deletingRoot, userRoot).catch(() => undefined);
        throw error;
      }
      return { userId, username: account.username, deleted: true, deletedAt: now };
    });
  }
}

export const authDeviceConstants = Object.freeze({
  schemaVersion: AUTH_SCHEMA_VERSION,
  tokenVersion: TOKEN_VERSION,
});
