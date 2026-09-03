import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuthDeviceService } from "../gateway/core/auth/index.mjs";
import { EasyWorkRuntime } from "../gateway/core/runtime/runtime.mjs";

const SECRET = "test-session-secret-that-is-longer-than-32-bytes";

function service(dataRoot, overrides = {}) {
  return new AuthDeviceService({
    dataRoot,
    sessionSecret: SECRET,
    scrypt: { N: 1024, r: 8, p: 1, keyLength: 32, maxmem: 8 * 1024 * 1024 },
    ...overrides,
  });
}

async function fixture(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-auth-"));
  try {
    return await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("用户名+密码注册不接受 email 旧格式，首个用户自动写入逐行管理员名单", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    await assert.rejects(() => auth.register({
      username: "legacy",
      email: "legacy@example.com",
      password: "password-123",
      deviceId: "device_a",
    }), (error) => error?.code === "AUTH_INPUT_SCHEMA_INVALID");
    const registered = await auth.register({ username: "首位用户", password: "password-123", deviceId: "device_a" });
    assert.equal(registered.firstVisit, true);
    assert.equal(registered.profile.admin, true);
    assert.equal(registered.actor.roles.includes("admin"), true);
    assert.equal((await readFile(path.join(dataRoot, "admins", "adminList"), "utf8")).trim(), "首位用户");

    const accountsText = await readFile(path.join(dataRoot, "auth", "accounts.json"), "utf8");
    assert.equal(accountsText.includes("email"), false);
    assert.equal(accountsText.includes("password"), false);
    assert.equal(accountsText.includes("password-123"), false);
    const profilePath = path.join(dataRoot, "users", registered.profile.userId, "profile", "account.json");
    const profileText = await readFile(profilePath, "utf8");
    assert.equal(profileText.includes("password-123"), false);
    assert.match(profileText, /"algorithm": "scrypt"/);
  });
});

test("签名 token 可定位 Actor，但用户磁盘只保存 token hash", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    const registered = await auth.register({ username: "smr", password: "password-123", deviceId: "device_a" });
    const resolved = await auth.resolveSession(registered.token);
    assert.equal(resolved.actor.actorType, "user");
    assert.equal(resolved.actor.actorId, registered.profile.userId);
    assert.equal(resolved.actor.deviceId, "device_a");
    const sessionsPath = path.join(dataRoot, "users", registered.profile.userId, "profile", "sessions.json");
    const sessionsText = await readFile(sessionsPath, "utf8");
    assert.equal(sessionsText.includes(registered.token), false);
    assert.equal(JSON.parse(sessionsText).sessions[0].tokenHash.length, 64);
    const tampered = `${registered.token.slice(0, -1)}x`;
    await assert.rejects(() => auth.resolveSession(tampered), (error) => error?.code === "SESSION_TOKEN_INVALID");
  });
});

test("并发注册同名只成功一次，账号资料保持在获胜用户目录", async () => {
  await fixture(async (dataRoot) => {
    const firstService = service(dataRoot);
    const secondService = service(dataRoot);
    const attempts = await Promise.allSettled([
      firstService.register({ username: "SameUser", password: "password-123", deviceId: "device_a" }),
      secondService.register({ username: "sameuser", password: "password-456", deviceId: "device_b" }),
    ]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
    const rejected = attempts.find((entry) => entry.status === "rejected");
    assert.equal(rejected.reason.code, "USERNAME_TAKEN");
    const accounts = JSON.parse(await readFile(path.join(dataRoot, "auth", "accounts.json"), "utf8"));
    assert.equal(Object.keys(accounts.accounts).length, 1);
    const userId = Object.values(accounts.accounts)[0].userId;
    const profile = JSON.parse(await readFile(path.join(dataRoot, "users", userId, "profile", "account.json"), "utf8"));
    assert.equal(profile.userId, userId);
  });
});

test("同账号多设备各自保持登录，首次设备看帮助，标记后该设备回到首页", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    const registered = await auth.register({ username: "multi", password: "password-123", deviceId: "laptop" });
    assert.equal(registered.firstVisit, true);
    await auth.markHelpSeen(registered.token);
    assert.equal((await auth.resolveSession(registered.token)).firstVisit, false);

    const phone = await auth.login({ username: "multi", password: "password-123", deviceId: "phone" });
    assert.equal(phone.firstVisit, true);
    assert.equal((await auth.resolveSession(registered.token)).actor.deviceId, "laptop");
    assert.equal((await auth.resolveSession(phone.token)).actor.deviceId, "phone");
    await auth.markHelpSeen(phone.token);
    const phoneAgain = await auth.login({ username: "multi", password: "password-123", deviceId: "phone" });
    assert.equal(phoneAgain.firstVisit, false);
    await assert.rejects(() => auth.resolveSession(phone.token), (error) => error?.code === "SESSION_REVOKED");
    assert.equal((await auth.resolveSession(registered.token)).actor.deviceId, "laptop");
  });
});

test("refresh 滚动会话并撤销旧 token，过期 token 不可解析", async () => {
  await fixture(async (dataRoot) => {
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const auth = service(dataRoot, { clock: () => new Date(now), sessionTtlMs: 60_000 });
    const registered = await auth.register({ username: "rolling", password: "password-123", deviceId: "device_a" });
    now += 30_000;
    const refreshed = await auth.refreshSession(registered.token);
    assert.notEqual(refreshed.token, registered.token);
    await assert.rejects(() => auth.resolveSession(registered.token), (error) => error?.code === "SESSION_REVOKED");
    assert.equal((await auth.resolveSession(refreshed.token)).profile.username, "rolling");
    now += 61_000;
    await assert.rejects(() => auth.resolveSession(refreshed.token), (error) => error?.code === "SESSION_EXPIRED");
  });
});

test("管理员可手工编辑 adminList；用户名修改同步账号索引和管理员名单", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    await auth.register({ username: "rootadmin", password: "password-123", deviceId: "root_device" });
    const user = await auth.register({ username: "ordinary", password: "password-456", deviceId: "user_device" });
    assert.equal(user.profile.admin, false);
    await writeFile(path.join(dataRoot, "admins", "adminList"), "rootadmin\nordinary\n", "utf8");
    const elevated = await auth.resolveSession(user.token);
    assert.equal(elevated.profile.admin, true);
    const before = await auth.getProfile(user.token);
    const renamed = await auth.updateProfile({ token: user.token, username: "renamed", expectedRevision: before.revision });
    assert.equal(renamed.username, "renamed");
    assert.equal(renamed.admin, true);
    const adminList = await readFile(path.join(dataRoot, "admins", "adminList"), "utf8");
    assert.match(adminList, /^rootadmin\nrenamed\n$/);
    const accounts = JSON.parse(await readFile(path.join(dataRoot, "auth", "accounts.json"), "utf8"));
    assert.equal(accounts.accounts.ordinary, undefined);
    assert.equal(accounts.accounts.renamed.userId, user.profile.userId);
    await assert.rejects(() => auth.login({ username: "ordinary", password: "password-456", deviceId: "other" }), (error) => error?.code === "AUTHENTICATION_FAILED");
    const login = await auth.login({ username: "renamed", password: "password-456", deviceId: "other" });
    assert.equal(login.profile.admin, true);
  });
});

test("管理员用户列表分页读取登录状态；删除用户会撤销账号、会话与全部 Actor 数据", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    const admin = await auth.register({ username: "owner-admin", password: "password-123", deviceId: "owner-device" });
    const member = await auth.register({ username: "member-user", password: "password-456", deviceId: "member-laptop" });
    const phone = await auth.login({ username: "member-user", password: "password-456", deviceId: "member-phone" });
    const page = await auth.pageUsersForAdmin(admin.actor, { query: "member", page: 1, limit: 30 });
    assert.equal(page.total, 1);
    assert.equal(page.items[0].userId, member.actor.actorId);
    assert.equal(page.items[0].deviceCount, 2);
    assert.equal(page.items[0].activeSessionCount, 2);
    await assert.rejects(() => auth.deleteUserForAdmin(admin.actor, admin.actor.actorId), (error) => error?.code === "ADMIN_DELETE_SELF_FORBIDDEN");
    const deleted = await auth.deleteUserForAdmin(admin.actor, member.actor.actorId);
    assert.equal(deleted.deleted, true);
    await assert.rejects(() => auth.resolveSession(member.token), (error) => ["SESSION_NOT_FOUND", "AUTH_PROFILE_CORRUPT"].includes(error?.code));
    await assert.rejects(() => auth.resolveSession(phone.token), (error) => ["SESSION_NOT_FOUND", "AUTH_PROFILE_CORRUPT"].includes(error?.code));
    await assert.rejects(() => access(path.join(dataRoot, "users", member.actor.actorId)));
    assert.equal((await auth.pageUsersForAdmin(admin.actor)).total, 1);
  });
});

test("单一 Profile PATCH 原子更新用户名与受控头像，公开描述符不暴露存储路径", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    const registered = await auth.register({ username: "avatar-user", password: "password-123", deviceId: "device_a" });
    const before = await auth.getProfile(registered.token);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const updated = await auth.updateProfile({
      token: registered.token,
      username: "avatar-renamed",
      avatar: { mime: "image/png", contentBase64: png.toString("base64") },
      expectedRevision: before.revision,
    });
    assert.equal(updated.username, "avatar-renamed");
    assert.deepEqual(Object.keys(updated.avatar).sort(), ["mime", "sha256", "size", "updatedAt", "url"]);
    assert.equal(updated.avatar.url, "/api/profile/avatar");
    const opened = await auth.openAvatar(registered.token);
    assert.deepEqual(opened.bytes, png);
    const accountText = await readFile(path.join(dataRoot, "users", registered.profile.userId, "profile", "account.json"), "utf8");
    assert.equal(accountText.includes(png.toString("base64")), false);
    assert.equal(JSON.parse(accountText).avatar.storageName.startsWith("avatar-"), true);

    await assert.rejects(() => auth.updateProfile({
      token: registered.token,
      avatar: { mime: "image/jpeg", contentBase64: png.toString("base64") },
      expectedRevision: updated.revision,
    }), (error) => error?.code === "AVATAR_CONTENT_MISMATCH");
    await assert.rejects(() => auth.updateProfile({
      token: registered.token,
      avatar: { mime: "image/png", contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") },
      expectedRevision: updated.revision,
    }), (error) => error?.code === "AVATAR_TOO_LARGE" && error?.status === 413);
    const removed = await auth.updateProfile({ token: registered.token, avatar: null, expectedRevision: updated.revision });
    assert.equal(removed.avatar, null);
    await assert.rejects(() => auth.openAvatar(registered.token), (error) => error?.code === "AVATAR_NOT_FOUND");
  });
});

test("访客拥有独立 guests profile，不能通过访客 token 修改用户名", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    const guest = await auth.createGuestSession({ deviceId: "guest_device" });
    assert.equal(guest.actor.actorType, "guest");
    assert.equal((await auth.resolveSession(guest.token)).profile.guestId, guest.profile.guestId);
    const guestProfile = JSON.parse(await readFile(path.join(dataRoot, "guests", guest.profile.guestId, "profile", "guest.json"), "utf8"));
    assert.equal(guestProfile.guestId, guest.profile.guestId);
    await assert.rejects(() => auth.updateProfile({ token: guest.token, username: "not_allowed", expectedRevision: 0 }), (error) => error?.code === "AUTHENTICATION_REQUIRED");
  });
});

test("logout 仅撤销当前 Web session，不触碰 SSH worker、Task 或另一设备", async () => {
  await fixture(async (dataRoot) => {
    const auth = service(dataRoot);
    const first = await auth.register({ username: "worker", password: "password-123", deviceId: "device_a" });
    const second = await auth.login({ username: "worker", password: "password-123", deviceId: "device_b" });
    const userRoot = path.join(dataRoot, "users", first.profile.userId);
    const sshSentinel = path.join(userRoot, "runtime", "ssh-worker.json");
    const taskSentinel = path.join(userRoot, "tasks", "task-running.json");
    await mkdir(path.dirname(sshSentinel), { recursive: true });
    await mkdir(path.dirname(taskSentinel), { recursive: true });
    await writeFile(sshSentinel, "alive", "utf8");
    await writeFile(taskSentinel, "running", "utf8");
    await auth.logout(first.token);
    await assert.rejects(() => auth.resolveSession(first.token), (error) => error?.code === "SESSION_REVOKED");
    assert.equal((await auth.resolveSession(second.token)).actor.deviceId, "device_b");
    assert.equal(await readFile(sshSentinel, "utf8"), "alive");
    assert.equal(await readFile(taskSentinel, "utf8"), "running");
  });
});

test("Gateway 访客 logout 在无运行任务与 SSH 时删除整个 guest Actor 目录", async () => {
  await fixture(async (root) => {
    const dataRoot = path.join(root, "data");
    const runtime = await EasyWorkRuntime.create({ dataRoot, guestMaintenanceMs: 60_000 });
    try {
      const api = runtime.createApi();
      const guest = await runtime.auth.createGuestSession({ deviceId: "guest-browser" });
      const guestRoot = path.join(dataRoot, "guests", guest.profile.guestId);
      await access(guestRoot);
      const response = await api.dispatch({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${guest.token}` }, body: {} });
      assert.equal(response.status, 200);
      assert.equal(response.body.data.guestCleanup, "deleted");
      await assert.rejects(() => access(guestRoot), (error) => error?.code === "ENOENT");
    } finally {
      await runtime.close();
    }
  });
});

test("维护清理只回收没有 Task/SSH 的过期 guest，不触碰 user 或已有 Task", async () => {
  await fixture(async (root) => {
    const dataRoot = path.join(root, "data");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const runtime = await EasyWorkRuntime.create({
      dataRoot,
      clock: () => new Date(now),
      guestTtlMs: 1_000,
      guestMaintenanceMs: 60_000,
      authOptions: { sessionTtlMs: 500, activityTouchIntervalMs: 0 },
    });
    try {
      const user = await runtime.auth.register({ username: "permanent-user", password: "password-123", deviceId: "user-browser" });
      const guest = await runtime.auth.createGuestSession({ deviceId: "guest-browser" });
      const cleanGuest = await runtime.auth.createGuestSession({ deviceId: "clean-guest-browser" });
      const guestRoot = path.join(dataRoot, "guests", guest.profile.guestId);
      const taskIndex = path.join(guestRoot, "tasks", "index.json");
      await mkdir(path.dirname(taskIndex), { recursive: true });
      await writeFile(taskIndex, JSON.stringify({ schemaVersion: 1, revision: 1, updatedAt: new Date(now).toISOString(), data: { tasks: { task_a: { status: "running" } } } }), "utf8");
      now += 2_000;
      const protectedResult = await runtime.cleanupInactiveGuests();
      assert.equal(protectedResult.find((entry) => entry.actorId === guest.profile.guestId)?.deleted, false);
      assert.equal(protectedResult.find((entry) => entry.actorId === cleanGuest.profile.guestId)?.deleted, true);
      await access(guestRoot);
      await assert.rejects(() => access(path.join(dataRoot, "guests", cleanGuest.profile.guestId)), (error) => error?.code === "ENOENT");
      await writeFile(taskIndex, JSON.stringify({ schemaVersion: 1, revision: 2, updatedAt: new Date(now).toISOString(), data: { tasks: { task_a: { status: "completed" } } } }), "utf8");
      const cleaned = await runtime.cleanupInactiveGuests();
      assert.equal(cleaned.find((entry) => entry.actorId === guest.profile.guestId)?.deleted, false);
      await access(guestRoot);
      await access(path.join(dataRoot, "users", user.profile.userId));
    } finally {
      await runtime.close();
    }
  });
});
