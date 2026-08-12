import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { SshCredentialVault, SshServerRegistry, SshWorkerPool } from "../gateway/core/ssh/index.mjs";

const masterSecret = "test-only-master-secret-that-is-long-enough";
const actorFor = (deviceId) => createActorContext({ actorType: "user", actorId: "user_a", deviceId, sessionId: `session_${deviceId}`, roles: [] });

async function fixture(options = {}) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-ssh-"));
  let now = options.now ?? Date.now();
  const clock = () => now;
  const connections = [];
  const registryFactory = (actor) => {
    const vault = new SshCredentialVault({ dataRoot, actor, masterSecret });
    return new SshServerRegistry({ dataRoot, actor, vault, clock, networkPolicy: options.networkPolicy });
  };
  const transportFactory = {
    async connect(request) {
      connections.push(request);
      if (options.failConnect) throw Object.assign(new Error("authentication rejected"), { code: "SSH_AUTH_FAILED" });
      const runtime = { commands: [], keepAliveCount: 0, closed: false };
      return {
        fingerprint: "SHA256:00112233445566778899aabbccddeeff",
        async exec(command) { runtime.commands.push(command); return { stdout: "ok", stderr: "", code: 0 }; },
        async keepAlive() { runtime.keepAliveCount += 1; },
        async isAlive() { return !runtime.closed; },
        async close() { runtime.closed = true; },
        runtime,
      };
    },
  };
  const pool = new SshWorkerPool({ registryFactory, transportFactory, clock, keepAliveIntervalMs: 1_000, inactiveTtlMs: 10_000, maintenanceIntervalMs: 500, ...(options.pool || {}) });
  return { dataRoot, actor: actorFor("device_a"), registryFactory, pool, connections, advance(ms) { now += ms; } };
}

test("SSH credentials are encrypted inside the Actor directory", async () => {
  const ctx = await fixture();
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", name: "A", host: "example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "plain-password-value" } });
    const file = path.join(ctx.dataRoot, "users", "user_a", "credentials", "ssh", "server_a.json");
    const stored = await readFile(file, "utf8");
    assert.equal(stored.includes("plain-password-value"), false);
    assert.equal((await registry.vault.get("server_a")).password, "plain-password-value");
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("Different devices share one per-user worker and reuse each server connection", async () => {
  const ctx = await fixture();
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    const fromDesktop = ctx.pool.workerFor(ctx.actor);
    const fromPhone = ctx.pool.workerFor(actorFor("device_b"));
    assert.equal(fromDesktop, fromPhone);
    await Promise.all([
      fromDesktop.connect("server_a", { acceptedFingerprint: "SHA256:00112233445566778899aabbccddeeff" }),
      fromPhone.connect("server_a", { acceptedFingerprint: "SHA256:00112233445566778899aabbccddeeff" }),
    ]);
    assert.equal(ctx.connections.length, 1);
    await fromPhone.execute("server_a", "pwd");
    assert.equal((await registry.get("server_a")).connection.status, "connected");
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("A conversation is permanently bound to its first server until explicitly removed", async () => {
  const ctx = await fixture();
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "a.example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    await registry.create({ id: "server_b", host: "b.example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    await registry.bindConversation("server_a", "conversation_a");
    assert.deepEqual(await registry.findConversationBinding("conversation_a"), { conversationId: "conversation_a", serverId: "server_a" });
    await registry.bindConversation("server_a", "conversation_a");
    await assert.rejects(
      () => registry.bindConversation("server_b", "conversation_a"),
      (error) => error?.code === "CONVERSATION_SERVER_ALREADY_BOUND" && error?.details?.serverId === "server_a",
    );
    assert.deepEqual((await registry.get("server_a")).conversationIds, ["conversation_a"]);
    assert.deepEqual((await registry.get("server_b")).conversationIds, []);
    await registry.unbindConversationEverywhere("conversation_a");
    assert.deepEqual(await registry.findConversationBinding("conversation_a"), { conversationId: "conversation_a", serverId: null });
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("withSession exposes only a live Actor-owned session and records active use", async () => {
  const ctx = await fixture();
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    const worker = ctx.pool.workerFor(ctx.actor);
    await assert.rejects(() => worker.withSession("server_a", async () => null), (error) => error?.code === "SSH_NOT_CONNECTED");
    await worker.connect("server_a", { acceptedFingerprint: "SHA256:00112233445566778899aabbccddeeff" });
    const before = (await registry.get("server_a")).connection.lastActiveAt;
    ctx.advance(250);
    const result = await worker.withSession("server_a", async (session, profile) => ({
      output: await session.exec("whoami"),
      username: profile.username,
    }));
    assert.equal(result.username, "alice");
    assert.equal(result.output.stdout, "ok");
    assert.notEqual((await registry.get("server_a")).connection.lastActiveAt, before);
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("Keepalive does not refresh user activity and idle connections expire", async () => {
  const ctx = await fixture();
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    const worker = ctx.pool.workerFor(ctx.actor);
    await worker.connect("server_a", { acceptedFingerprint: "SHA256:00112233445566778899aabbccddeeff" });
    const activity = (await registry.get("server_a")).connection.lastActiveAt;
    ctx.advance(2_000);
    assert.deepEqual(await ctx.pool.maintain(), [{ serverId: "server_a", action: "kept-alive" }]);
    assert.equal((await registry.get("server_a")).connection.lastActiveAt, activity);
    ctx.advance(9_000);
    assert.deepEqual(await ctx.pool.maintain(), [{ serverId: "server_a", action: "expired" }]);
    assert.equal((await registry.get("server_a")).connection.status, "disconnected");
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("Connection failures persist a safe state and do not report a live session", async () => {
  const ctx = await fixture({ failConnect: true });
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    await assert.rejects(() => ctx.pool.workerFor(ctx.actor).connect("server_a"), (error) => error?.code === "SSH_AUTH_FAILED");
    const connection = (await registry.get("server_a")).connection;
    assert.equal(connection.status, "failed");
    assert.equal(connection.desiredConnection, false);
    assert.deepEqual(connection.lastError, { code: "SSH_AUTH_FAILED", message: "authentication rejected" });
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("A first connection requires explicit host fingerprint confirmation", async () => {
  const ctx = await fixture();
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    await assert.rejects(
      () => ctx.pool.workerFor(ctx.actor).connect("server_a"),
      (error) => error?.code === "SSH_HOST_KEY_CONFIRMATION_REQUIRED" && error?.details?.fingerprint === "SHA256:00112233445566778899aabbccddeeff",
    );
    assert.equal((await registry.get("server_a")).connection.status, "disconnected");
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("Network policy is enforced before a server profile is stored", async () => {
  const ctx = await fixture({ networkPolicy: { assertAllowed: async () => { throw Object.assign(new Error("blocked"), { code: "SSH_NETWORK_FORBIDDEN" }); } } });
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await assert.rejects(
      () => registry.create({ id: "server_a", host: "203.0.113.10", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } }),
      (error) => error?.code === "SSH_NETWORK_FORBIDDEN",
    );
    assert.deepEqual(await registry.list(), []);
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});

test("Worker pool enforces the configured per-user connection limit", async () => {
  const ctx = await fixture({ pool: { maxConnectionsPerUser: 1, maxTotalConnections: 2 } });
  try {
    const registry = ctx.registryFactory(ctx.actor);
    await registry.create({ id: "server_a", host: "a.example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    await registry.create({ id: "server_b", host: "b.example.internal", port: 22, username: "alice", authMethod: "password", credential: { password: "value" } });
    const worker = ctx.pool.workerFor(ctx.actor);
    await worker.connect("server_a", { acceptedFingerprint: "SHA256:00112233445566778899aabbccddeeff" });
    await assert.rejects(
      () => worker.connect("server_b", { acceptedFingerprint: "SHA256:00112233445566778899aabbccddeeff" }),
      (error) => error?.code === "SSH_USER_CONNECTION_LIMIT" && error?.details?.limit === 1,
    );
  } finally {
    await ctx.pool.stop();
    await rm(ctx.dataRoot, { recursive: true, force: true });
  }
});
