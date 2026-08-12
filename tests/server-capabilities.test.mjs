import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEasyWorkRuntime } from "../gateway/core/runtime/runtime.mjs";
import { ServerCapabilityService } from "../gateway/core/runtime/server-capabilities.mjs";

function connectedServer(overrides = {}) {
  return {
    profile: { id: "server_a", serverIdentity: `ssh_${"a".repeat(43)}`, ...overrides.profile },
    connection: { status: "connected", generation: 3, ...overrides.connection },
  };
}

function completeBackend() {
  const action = async () => ({});
  return {
    remoteControl: { canonicalize: action },
    remoteFiles: {
      list: action,
      uploadStream: action,
      inspectDownload: action,
      openDownloadStream: action,
      mkdir: action,
      rename: action,
      delete: action,
      capabilities: () => ({ range: true, maxUploadBytes: 1024 ** 3, maxDownloadBytes: 1024 ** 3 }),
    },
    remoteArtifactSource: { inspect: action, openReadStream: action },
    terminal: { create: action, input: action, inspect: action, close: action, detach: action, resume: action },
    versionControl: { status: action, diff: action, commit: action },
    remoteFs: { diffTree: action },
    remoteExec: { git: action },
    agentDeployment: { status: action, install: action, uninstall: action },
    agentConfiguration: { inspect: action, update: action },
    agentTransport: { execute: action },
    skillDeployment: { inspect: action, ensure: action },
  };
}

function slurmProfile() {
  const available = { available: true, reason: null };
  const unavailable = { available: false, reason: "not exposed" };
  return {
    scheduler: "slurm",
    features: {
      accessiblePartitions: available,
      resourceSummary: available,
      userJobs: available,
      jobHistory: unavailable,
      submit: available,
      cancelJob: available,
      jobOutput: available,
    },
  };
}

test("server capability profile returns typed SSH-unavailable features without probing the remote", async () => {
  let remoteCalls = 0;
  const service = new ServerCapabilityService({
    servers: { async get() { return connectedServer({ connection: { status: "disconnected", generation: 0 }, profile: { serverIdentity: null } }); } },
    async resolveRemoteBackend() { remoteCalls += 1; throw new Error("must not run"); },
    async resolveScheduler() { throw new Error("must not run"); },
    clock: () => new Date("2026-08-10T01:00:00.000Z"),
  });
  const profile = await service.get("server_a");
  assert.equal(remoteCalls, 0);
  assert.equal(profile.schemaVersion, 1);
  assert.equal(profile.status, "partial");
  assert.equal(profile.features.remoteFiles.available, false);
  assert.equal(profile.features.remoteFiles.status, "unavailable");
  assert.equal(profile.features.remoteFiles.diagnostic.code, "SSH_NOT_CONNECTED");
  assert.equal(profile.features.scheduler.type, "none");
  assert.equal(profile.diagnostics.length, 9);
  assert.ok(profile.diagnostics.every((entry) => entry.retryable && entry.code === "SSH_NOT_CONNECTED"));
});

test("server capability profile aggregates actual interfaces, Scheduler flags, TTL cache, and refresh", async () => {
  let backendCalls = 0;
  let schedulerCalls = 0;
  let current = new Date("2026-08-10T02:00:00.000Z");
  const service = new ServerCapabilityService({
    servers: { async get() { return connectedServer(); } },
    async resolveRemoteBackend() { backendCalls += 1; return completeBackend(); },
    async resolveScheduler() { schedulerCalls += 1; return { async getCapabilities() { return slurmProfile(); } }; },
    clock: () => current,
    ttlMs: 10_000,
  });
  const profile = await service.get("server_a");
  assert.equal(profile.status, "ready");
  assert.deepEqual(profile.features.remoteFiles, {
    available: true,
    status: "available",
    reason: null,
    diagnostic: null,
    list: true,
    upload: true,
    download: true,
    range: true,
    mkdir: true,
    rename: true,
    delete: true,
    maxUploadBytes: 1024 ** 3,
    maxDownloadBytes: 1024 ** 3,
  });
  assert.equal(profile.features.preview.types.includes("pdf"), true);
  assert.equal(profile.features.workspaces.dynamicWrite, true);
  assert.deepEqual({ shadow: profile.features.versioning.shadow, userGit: profile.features.versioning.userGit, isolated: profile.features.versioning.isolated }, { shadow: true, userGit: false, isolated: true });
  assert.equal(profile.features.scheduler.type, "slurm");
  assert.equal(profile.features.scheduler.resourceSummary, true);
  assert.equal(profile.features.scheduler.jobHistory, false);
  assert.equal(profile.features.agents.configure, true);
  assert.equal(profile.features.skills.deploy, true);
  assert.equal(profile.diagnostics.length, 0);
  assert.equal(profile.expiresAt, "2026-08-10T02:00:10.000Z");

  current = new Date("2026-08-10T02:00:05.000Z");
  assert.deepEqual(await service.get("server_a"), profile);
  assert.deepEqual({ backendCalls, schedulerCalls }, { backendCalls: 1, schedulerCalls: 1 });
  await service.get("server_a", { refresh: true });
  assert.deepEqual({ backendCalls, schedulerCalls }, { backendCalls: 2, schedulerCalls: 2 });
});

test("one failed probe only disables its feature and never exposes the remote error message", async () => {
  const service = new ServerCapabilityService({
    servers: { async get() { return connectedServer(); } },
    async resolveRemoteBackend() { return completeBackend(); },
    async resolveScheduler() {
      return { async getCapabilities() { throw Object.assign(new Error("credential=secret /home/alice/private"), { code: "SCHEDULER_PROBE_BROKEN", status: 502 }); } };
    },
    clock: () => new Date("2026-08-10T03:00:00.000Z"),
  });
  const profile = await service.get("server_a");
  assert.equal(profile.status, "partial");
  assert.equal(profile.features.remoteFiles.available, true);
  assert.equal(profile.features.scheduler.status, "error");
  assert.equal(profile.features.scheduler.diagnostic.code, "SCHEDULER_PROBE_BROKEN");
  assert.equal(JSON.stringify(profile).includes("secret"), false);
  assert.equal(JSON.stringify(profile).includes("/home/alice"), false);
});

test("capability endpoint returns the canonical disconnected profile", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-server-capabilities-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = await createEasyWorkRuntime({ dataRoot: path.join(root, "data") });
  t.after(() => runtime.close());
  const registered = await runtime.auth.register({ username: "capability-user", password: "password-value", deviceId: "device-capability" });
  const session = await runtime.auth.resolveSession(registered.token);
  const services = await runtime.servicesForActor(session.actor);
  const server = await services.servers.create({
    id: "server_capability",
    name: "cluster",
    host: "127.0.0.1",
    port: 22,
    username: "alice",
    authMethod: "password",
    credential: { method: "password", password: "never-return-this" },
  });
  const response = await runtime.createApi().dispatch({
    method: "GET",
    url: `/api/servers/${server.id}/capabilities`,
    headers: { authorization: `Bearer ${registered.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.serverId, server.id);
  assert.equal(response.body.data.features.terminal.status, "unavailable");
  assert.equal(JSON.stringify(response.body).includes("never-return-this"), false);
});
