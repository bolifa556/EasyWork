import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { WorkspaceService } from "../gateway/core/workspaces/index.mjs";

const SERVER_IDENTITY = `ssh_${crypto.createHash("sha256").update("workspace-host-key").digest("base64url")}`;

class FakeRemoteControl {
  directories = new Set();
  json = new Map();
  calls = [];

  async canonicalize(value) {
    const normalized = path.posix.normalize(String(value).replace(/\\/g, "/"));
    this.calls.push({ kind: "canonicalize", path: normalized });
    return normalized;
  }

  async resolveEasyWork(relativePath) {
    assert.equal(path.posix.isAbsolute(relativePath), false);
    assert.equal(relativePath.split("/").includes(".."), false);
    return `/home/alice/.easywork/${relativePath}`;
  }

  async ensureDirectory(directory) {
    assert.match(directory, /^\/home\/alice\/\.easywork(?:\/|$)/);
    this.directories.add(directory);
    this.calls.push({ kind: "mkdir", path: directory });
  }

  async writeJsonAtomic(filePath, value) {
    assert.match(filePath, /^\/home\/alice\/\.easywork\/bindings\/workspaces\//);
    assert.equal(JSON.stringify(value).includes(".codex"), false);
    assert.equal(JSON.stringify(value).includes(".claude"), false);
    assert.equal(JSON.stringify(value).includes(".config/opencode"), false);
    this.json.set(filePath, structuredClone(value));
    this.calls.push({ kind: "write", path: filePath });
  }
}

class FakeVersioning {
  domains = new Map();

  async assessWorkspace({ rootPath }) {
    if (rootPath === "/srv/project/nested") {
      return {
        rootPath,
        exact: null,
        canCreate: false,
        risk: {
          code: "WORKSPACE_DOMAIN_OVERLAP",
          relationships: [{ relationship: "contained_by", rootPath: "/srv/project", versionDomainId: "vd_parent" }],
        },
      };
    }
    const existing = this.domains.get(rootPath) || null;
    return { rootPath, exact: existing, risk: null, canCreate: !existing };
  }

  async openDomain({ rootPath }, options = {}) {
    if (rootPath === "/srv/project/nested") {
      if (options.overlapPolicy !== "reuse-containing") return { state: null, risk: { code: "WORKSPACE_DOMAIN_OVERLAP" } };
      return { state: { versionDomainId: "vd_parent" }, reused: true, risk: { code: "WORKSPACE_DOMAIN_OVERLAP" } };
    }
    const domain = this.domains.get(rootPath) || { versionDomainId: `vd_${crypto.createHash("sha256").update(rootPath).digest("hex").slice(0, 12)}` };
    this.domains.set(rootPath, domain);
    return { state: domain, reused: this.domains.has(rootPath), risk: null };
  }

  async resolveDynamicWrite({ targetPath, targetKind }) {
    const rootPath = targetKind === "file" ? path.posix.dirname(targetPath) : targetPath;
    const domain = this.domains.get(rootPath) || { versionDomainId: `vd_dynamic_${crypto.createHash("sha256").update(rootPath).digest("hex").slice(0, 8)}` };
    this.domains.set(rootPath, domain);
    return { state: domain, created: true, risk: null };
  }
}

async function fixture(t) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-workspaces-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const actor = createActorContext({ actorType: "user", actorId: "alice", deviceId: "device-1", sessionId: "session-1", roles: [] });
  const remoteControl = new FakeRemoteControl();
  const versioning = new FakeVersioning();
  let tick = 0;
  const service = new WorkspaceService({
    dataRoot,
    actor,
    remoteControl,
    versioning,
    authorizeConversation: async (conversationId) => ["conv-a", "conv-b"].includes(conversationId),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  return { actor, dataRoot, remoteControl, service, versioning };
}

test("virtual workspace lives under remote .easywork and command replay is idempotent", async (t) => {
  const { dataRoot, remoteControl, service } = await fixture(t);
  const input = {
    conversationId: "conv-a",
    branchId: "main",
    serverIdentity: SERVER_IDENTITY,
    expectedRevision: 0,
    commandId: "cmd-virtual-1",
  };
  const first = await service.createVirtual(input);
  assert.equal(first.created, true);
  assert.equal(first.workspace.kind, "virtual");
  assert.match(first.workspace.canonicalPath, /^\/home\/alice\/\.easywork\/workspaces\/alice\/conv-a\//);
  assert.equal(first.workspace.versionDomainId, null);
  assert.match(first.workspace.remoteRef, /^~\/\.easywork\/bindings\/workspaces\//);
  const writes = remoteControl.calls.length;
  const replay = await service.createVirtual(input);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(remoteControl.calls.length, writes);
  const registry = JSON.parse(await fs.readFile(path.join(dataRoot, "users", "alice", "workspaces", "registry.json"), "utf8"));
  assert.equal(registry.data.workspaces.length, 1);
  assert.equal(JSON.stringify(registry).includes("privateKey"), false);
});

test("real workspace overlap requires an explicit shared version-domain decision", async (t) => {
  const { service } = await fixture(t);
  const base = await service.registerUserWorkspace({
    conversationId: "conv-a",
    serverIdentity: SERVER_IDENTITY,
    path: "/srv/project",
    expectedRevision: 0,
    commandId: "cmd-real-base",
  });
  assert.equal(base.workspace.kind, "user");
  assert.ok(base.workspace.versionDomainId);

  const assessment = await service.assessUserWorkspace({ conversationId: "conv-a", serverIdentity: SERVER_IDENTITY, path: "/srv/project/nested" });
  assert.equal(assessment.canCreate, false);
  assert.equal(assessment.overlapRisk.code, "WORKSPACE_DOMAIN_OVERLAP");
  await assert.rejects(
    service.registerUserWorkspace({
      conversationId: "conv-a",
      serverIdentity: SERVER_IDENTITY,
      path: "/srv/project/nested",
      expectedRevision: 0,
      commandId: "cmd-real-nested-reject",
    }),
    (error) => error?.code === "WORKSPACE_OVERLAP_CONFIRMATION_REQUIRED",
  );
  const shared = await service.registerUserWorkspace({
    conversationId: "conv-a",
    serverIdentity: SERVER_IDENTITY,
    path: "/srv/project/nested",
    overlapPolicy: "reuse-containing-domain",
    expectedRevision: 0,
    commandId: "cmd-real-nested-share",
  });
  assert.equal(shared.workspace.versionDomainId, "vd_parent");
});

test("agent and workspace combinations own independent native sessions while workspaces may be shared", async (t) => {
  const { service } = await fixture(t);
  const virtual = await service.createVirtual({
    conversationId: "conv-a", serverIdentity: SERVER_IDENTITY, expectedRevision: 0, commandId: "cmd-v-a",
  });
  const real = await service.registerUserWorkspace({
    conversationId: "conv-a", serverIdentity: SERVER_IDENTITY, path: "/srv/project", expectedRevision: 0, commandId: "cmd-r-a",
  });

  const openCode = await service.ensureAgentBinding({
    conversationId: "conv-a", branchId: "main", workspaceId: virtual.workspace.id, agentId: "opencode", contextEpoch: 0,
    expectedRevision: 0, commandId: "cmd-bind-open",
  });
  const initialRoute = await service.getRoute({ conversationId: "conv-a", branchId: "main" });
  assert.equal(initialRoute.binding.id, openCode.binding.id);
  assert.equal(initialRoute.workspace.id, virtual.workspace.id);
  assert.equal(initialRoute.route.revision, 1);
  const codex = await service.ensureAgentBinding({
    conversationId: "conv-a", branchId: "main", workspaceId: virtual.workspace.id, agentId: "codex", contextEpoch: 0,
    expectedRevision: 0, commandId: "cmd-bind-codex",
  });
  const secondConversation = await service.ensureAgentBinding({
    conversationId: "conv-b", branchId: "main", workspaceId: real.workspace.id, agentId: "codex", contextEpoch: 0,
    expectedRevision: 0, commandId: "cmd-bind-second",
  });
  assert.notEqual(openCode.binding.id, codex.binding.id);
  assert.notEqual(codex.binding.id, secondConversation.binding.id);

  const firstDescriptor = await service.describeSwitch({ conversationId: "conv-a", branchId: "main", workspaceId: virtual.workspace.id, agentId: "opencode", contextEpoch: 0 });
  assert.equal(firstDescriptor.requiresConfirmation, false);
  const selected = await service.switchBinding({
    ...firstDescriptor,
    descriptorId: firstDescriptor.id,
    workspaceId: virtual.workspace.id,
    agentId: "opencode",
    contextEpoch: 0,
    expectedRevision: firstDescriptor.routeRevision,
    commandId: "cmd-switch-open",
  });
  await service.updateNativeSession({
    bindingId: selected.binding.id,
    nativeSessionId: "native-opencode-thread-1",
    lastDeliverySequence: 7,
    expectedRevision: selected.binding.revision,
    commandId: "cmd-native-open",
  });

  const switchDescriptor = await service.describeSwitch({ conversationId: "conv-a", branchId: "main", workspaceId: virtual.workspace.id, agentId: "codex", contextEpoch: 0 });
  assert.equal(switchDescriptor.requiresConfirmation, true);
  assert.equal(switchDescriptor.effects.preservesWebConversationMemory, true);
  assert.equal(switchDescriptor.effects.contextDelivery, "delta-after-watermark");
  const switched = await service.switchBinding({
    ...switchDescriptor,
    descriptorId: switchDescriptor.id,
    workspaceId: virtual.workspace.id,
    agentId: "codex",
    contextEpoch: 0,
    expectedRevision: switchDescriptor.routeRevision,
    commandId: "cmd-switch-codex",
  });
  const replay = await service.switchBinding({
    ...switchDescriptor,
    descriptorId: switchDescriptor.id,
    workspaceId: virtual.workspace.id,
    agentId: "codex",
    contextEpoch: 0,
    expectedRevision: switchDescriptor.routeRevision,
    commandId: "cmd-switch-codex",
  });
  assert.equal(switched.binding.agentId, "codex");
  assert.equal(replay.idempotentReplay, true);

  const nextEpoch = await service.ensureAgentBinding({
    conversationId: "conv-a", branchId: "main", workspaceId: virtual.workspace.id, agentId: "opencode", contextEpoch: 1,
    expectedRevision: 0, commandId: "cmd-bind-open-epoch-1",
  });
  assert.equal(nextEpoch.binding.contextEpoch, 1);
  const bindings = await service.listBindings({ conversationId: "conv-a", branchId: "main" });
  assert.equal(bindings.find((entry) => entry.id === openCode.binding.id).status, "stale");
});

test("dynamic writes reuse the same agent session for repeated writes to one target directory", async (t) => {
  const { remoteControl, service } = await fixture(t);
  const descriptor = await service.describeDynamicWrite({
    conversationId: "conv-a",
    branchId: "main",
    agentId: "claude-code",
    serverIdentity: SERVER_IDENTITY,
    contextEpoch: 2,
    targetPath: "/srv/output/report.md",
    targetKind: "file",
  });
  assert.equal(descriptor.requiresConfirmation, true);
  assert.equal(descriptor.canonicalRootPath, "/srv/output");
  const confirmed = await service.confirmDynamicWrite({
    ...descriptor,
    descriptorId: descriptor.id,
    expectedRevision: 0,
    commandId: "cmd-dynamic-confirm",
  });
  assert.equal(confirmed.workspace.kind, "dynamic");
  assert.equal(confirmed.workspace.canonicalPath, "/srv/output");
  const updated = await service.updateNativeSession({
    bindingId: confirmed.binding.id,
    nativeSessionId: "claude-session-output",
    lastDeliverySequence: 11,
    expectedRevision: confirmed.binding.revision,
    commandId: "cmd-dynamic-session",
  });
  assert.equal(updated.binding.nativeSessionId, "claude-session-output");

  const second = await service.describeDynamicWrite({
    conversationId: "conv-a",
    branchId: "main",
    agentId: "claude-code",
    serverIdentity: SERVER_IDENTITY,
    contextEpoch: 2,
    targetPath: "/srv/output/figure.png",
    targetKind: "file",
  });
  assert.equal(second.requiresConfirmation, false);
  assert.equal(second.reusesNativeAgentSession, true);
  assert.equal(second.lastDeliverySequence, 11);
  assert.ok(remoteControl.calls.filter((entry) => entry.kind === "write").every((entry) => entry.path.includes("/.easywork/bindings/workspaces/")));
  assert.equal(remoteControl.calls.some((entry) => ["write", "mkdir"].includes(entry.kind) && entry.path?.startsWith("/srv/output")), false);
});

test("workspace service rejects guest actors, unauthorized conversations and stale revisions", async (t) => {
  const { dataRoot, remoteControl, versioning, service } = await fixture(t);
  const guest = createActorContext({ actorType: "guest", actorId: "guest-1", deviceId: "device-2", sessionId: "session-2", roles: [] });
  assert.throws(() => new WorkspaceService({
    dataRoot,
    actor: guest,
    remoteControl,
    versioning,
    authorizeConversation: async () => true,
  }), (error) => error?.code === "AUTHENTICATION_REQUIRED");
  await assert.rejects(
    service.createVirtual({ conversationId: "other-user-conv", serverIdentity: SERVER_IDENTITY, expectedRevision: 0, commandId: "cmd-forbidden" }),
    (error) => error?.code === "CONVERSATION_FORBIDDEN",
  );

  const virtual = await service.createVirtual({ conversationId: "conv-a", serverIdentity: SERVER_IDENTITY, expectedRevision: 0, commandId: "cmd-rev-v" });
  const binding = await service.ensureAgentBinding({
    conversationId: "conv-a", workspaceId: virtual.workspace.id, agentId: "codex", contextEpoch: 0,
    expectedRevision: 0, commandId: "cmd-rev-bind",
  });
  await assert.rejects(
    service.updateNativeSession({
      bindingId: binding.binding.id,
      nativeSessionId: "thread-1",
      lastDeliverySequence: 1,
      expectedRevision: 9,
      commandId: "cmd-stale-update",
    }),
    (error) => error?.code === "REVISION_CONFLICT",
  );
});
