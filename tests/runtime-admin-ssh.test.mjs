import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";

const fingerprint = "SHA256:00112233445566778899aabbccddeeff";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-admin-ssh-"));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  const sessions = [];
  const gateway = await createGatewayServer({
    runtimeOptions: {
      dataRoot: path.join(root, "data"),
      helpFile,
      sshTransportFactory: {
        async connect() {
          const state = { closed: false };
          sessions.push(state);
          return {
            fingerprint,
            async exec() { return { code: 0, stdout: "", stderr: "" }; },
            async isAlive() { return !state.closed; },
            async close() { state.closed = true; },
          };
        },
      },
    },
  });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await gateway.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { gateway, baseUrl: `http://127.0.0.1:${address.port}`, sessions };
}

async function requestJson(baseUrl, pathname, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

async function register(baseUrl, username, deviceId) {
  const result = await requestJson(baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username, password: "test-password", deviceId },
  });
  assert.equal(result.response.status, 200);
  return result.payload.data;
}

test("Profile PATCH serves an Actor-authorized avatar and bootstrap exposes only its public descriptor", async (t) => {
  const { baseUrl } = await fixture(t);
  const account = await register(baseUrl, "avatar-admin", "avatar-device");
  const profile = await requestJson(baseUrl, "/api/profile", { token: account.token });
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
  const updated = await requestJson(baseUrl, "/api/profile", {
    token: account.token,
    method: "PATCH",
    headers: { "if-match": `"${profile.payload.data.revision}"` },
    body: { avatar: { mime: "image/png", contentBase64: bytes.toString("base64") } },
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(Object.keys(updated.payload.data.avatar).sort(), ["mime", "sha256", "size", "updatedAt", "url"]);
  assert.equal(JSON.stringify(updated.payload.data).includes("storageName"), false);

  const image = await fetch(`${baseUrl}/api/profile/avatar`, { headers: { authorization: `Bearer ${account.token}` } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  const bootstrap = await requestJson(baseUrl, "/api/bootstrap", { token: account.token });
  assert.deepEqual(bootstrap.payload.data.actor.avatar, updated.payload.data.avatar);
  assert.equal(bootstrap.payload.data.featureFlags.resources, false);
});

test("Admin lists safe cross-user SSH state and disconnect is idempotent without exposing credentials", async (t) => {
  const { baseUrl, sessions } = await fixture(t);
  const admin = await register(baseUrl, "ssh-admin", "admin-device");
  const member = await register(baseUrl, "ssh-member", "member-device");
  const created = await requestJson(baseUrl, "/api/servers", {
    token: member.token,
    method: "POST",
    body: {
      id: "server-admin-test",
      name: "Member compute",
      host: "203.0.113.10",
      port: 22,
      username: "remote-member",
      authMethod: "password",
      credential: { password: "never-return-this-secret" },
    },
  });
  assert.equal(created.response.status, 200);
  const connected = await requestJson(baseUrl, "/api/servers/server-admin-test/connect", {
    token: member.token,
    method: "POST",
    body: { acceptedFingerprint: fingerprint },
  });
  assert.equal(connected.response.status, 200);

  const forbidden = await requestJson(baseUrl, "/api/admin/ssh-connections", { token: member.token });
  assert.equal(forbidden.response.status, 403);
  const listed = await requestJson(baseUrl, "/api/admin/ssh-connections", { token: admin.token });
  assert.equal(listed.response.status, 200);
  const item = listed.payload.data.items.find((entry) => entry.serverId === "server-admin-test");
  assert.deepEqual(item, {
    actorId: member.actor.actorId,
    username: "ssh-member",
    serverId: "server-admin-test",
    serverName: "Member compute",
    host: "203.0.113.10",
    status: "connected",
    lastActiveAt: item.lastActiveAt,
    conversationCount: 0,
  });
  assert.equal(JSON.stringify(listed.payload).includes("never-return-this-secret"), false);

  const pathname = `/api/admin/ssh-connections/${encodeURIComponent(member.actor.actorId)}/server-admin-test/disconnect`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const disconnected = await requestJson(baseUrl, pathname, {
      token: admin.token,
      method: "POST",
      headers: { "idempotency-key": "admin-disconnect-0001" },
      body: {},
    });
    assert.equal(disconnected.response.status, 200);
    assert.equal(disconnected.payload.data.item.status, "disconnected");
  }
  assert.equal(sessions[0].closed, true);
});
