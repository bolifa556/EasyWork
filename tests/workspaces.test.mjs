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
  ledgers = new Map();

  async ensureConversationDomain({ conversationId, workspaceId, rootPath }) {
    const created = !this.ledgers.has(conversationId);
    const domain = this.ledgers.get(conversationId) || {
      versionDomainId: `vl_${crypto.createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}`,
      workspaces: [],
    };
    if (!domain.workspaces.some((entry) => entry.id === workspaceId)) domain.workspaces.push({ id: workspaceId, rootPath });
    this.ledgers.set(conversationId, domain);
    return { state: domain, created, reused: !created, risk: null };
  }

  async openDomain(input) {
    return this.ensureConversationDomain(input);
  }

  async resolveDynamicWrite({ conversationId, workspaceId, workspaceRootPath, targetPath, targetKind }) {
    const rootPath = workspaceRootPath || (targetKind === "directory" ? targetPath : path.posix.dirname(targetPath));
    return this.ensureConversationDomain({ conversationId, workspaceId: workspaceId || `ws_dynamic_${conversationId}`, rootPath });
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
  assert.equal("versionDomainId" in first.workspace, false);
  assert.match(first.workspace.remoteRef, /^~\/\.easywork\/bindings\/workspaces\//);
  const writes = remoteControl.calls.length;
  const replay = await service.createVirtual(input);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(remoteControl.calls.length, writes);
  const registry = JSON.parse(await fs.readFile(path.join(dataRoot, "users", "alice", "workspaces", "registry.json"), "utf8"));
  assert.equal(registry.data.workspaces.length, 1);
  assert.equal(JSON.stringify(registry).includes("privateKey"), false);
});

test("real workspaces register independently and do not touch the lazy version ledger", async (t) => {
  const { service, versioning } = await fixture(t);
  const base = await service.registerUserWorkspace({
    conversationId: "conv-a",
    serverIdentity: SERVER_IDENTITY,
    path: "/srv/project",
    expectedRevision: 0,
    commandId: "cmd-real-base",
  });
  assert.equal(base.workspace.kind, "user");
  assert.equal("versionDomainId" in base.workspace, false);

  const shared = await service.registerUserWorkspace({
    conversationId: "conv-a",
    serverIdentity: SERVER_IDENTITY,
    path: "/srv/project/nested",
    expectedRevision: 0,
    commandId: "cmd-real-nested",
  });
  assert.equal("versionDomainId" in shared.workspace, false);
  assert.equal(versioning.ledgers.size, 0);
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
  assert.equal(openCode.binding.versionDomainId, codex.binding.versionDomainId);
  assert.notEqual(codex.binding.versionDomainId, secondConversation.binding.versionDomainId);

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

test("删除父网页对话保留派生对话共享工作区，最后一个派生引用删除后回收", async (t) => {
  const { service } = await fixture(t);
  const virtual = await service.createVirtual({
    conversationId: "conv-a",
    branchId: "main",
    serverIdentity: SERVER_IDENTITY,
    expectedRevision: 0,
    commandId: "cmd-delete-derived-virtual",
  });
  const parent = await service.ensureAgentBinding({
    conversationId: "conv-a",
    branchId: "main",
    workspaceId: virtual.workspace.id,
    agentId: "codex",
    contextEpoch: 0,
    expectedRevision: 0,
    commandId: "cmd-delete-derived-parent-binding",
  });
  const derived = await service.forkConversation({
    sourceConversationId: "conv-a",
    conversationId: "conv-b",
    sourceBranchId: "main",
    branchId: "main",
    sourceBindingId: parent.binding.id,
    commandId: "cmd-delete-derived-fork",
  });
  assert.equal(derived.workspace.id, virtual.workspace.id);

  const parentCleanup = await service.forgetConversations({
    conversationIds: ["conv-a"],
    serverIdentity: SERVER_IDENTITY,
  });
  assert.deepEqual(parentCleanup.removedWorkspaces, []);
  assert.deepEqual(parentCleanup.retainedInheritedWorkspaces.map((entry) => entry.id), [virtual.workspace.id]);
  assert.ok(parentCleanup.protectedWorkspaceIds.includes(virtual.workspace.id));
  assert.equal((await service.listBindings({ conversationId: "conv-b", branchId: "main" })).length, 1);
  assert.equal((await service.getWorkspace(virtual.workspace.id)).id, virtual.workspace.id);

  const derivedCleanup = await service.forgetConversations({
    conversationIds: ["conv-b"],
    serverIdentity: SERVER_IDENTITY,
  });
  assert.deepEqual(derivedCleanup.retainedInheritedWorkspaces, []);
  assert.deepEqual(derivedCleanup.removedWorkspaces.map((entry) => entry.id), [virtual.workspace.id]);
  await assert.rejects(service.getWorkspace(virtual.workspace.id), (error) => error.code === "WORKSPACE_NOT_FOUND");
});

test("远端清理失败时不提前丢失派生工作区清理计划，重试成功后才提交本地遗忘", async (t) => {
  const { service } = await fixture(t);
  const virtual = await service.createVirtual({
    conversationId: "conv-a",
    branchId: "main",
    serverIdentity: SERVER_IDENTITY,
    expectedRevision: 0,
    commandId: "cmd-cleanup-retry-virtual",
  });
  const parent = await service.ensureAgentBinding({
    conversationId: "conv-a",
    branchId: "main",
    workspaceId: virtual.workspace.id,
    agentId: "opencode",
    contextEpoch: 0,
    expectedRevision: 0,
    commandId: "cmd-cleanup-retry-parent",
  });
  await service.forkConversation({
    sourceConversationId: "conv-a",
    conversationId: "conv-b",
    sourceBranchId: "main",
    branchId: "main",
    sourceBindingId: parent.binding.id,
    commandId: "cmd-cleanup-retry-child",
  });
  await service.forgetConversations({ conversationIds: ["conv-a"], serverIdentity: SERVER_IDENTITY });

  let failedPlan = null;
  await assert.rejects(
    service.forgetConversations({ conversationIds: ["conv-b"], serverIdentity: SERVER_IDENTITY }, {
      beforeCommit: async (cleanup) => {
        failedPlan = cleanup;
        throw Object.assign(new Error("simulated SSH loss"), { code: "SSH_CONNECTION_LOST" });
      },
    }),
    (error) => error?.code === "SSH_CONNECTION_LOST",
  );
  assert.deepEqual(failedPlan.removedWorkspaces.map((entry) => entry.id), [virtual.workspace.id]);
  assert.equal((await service.listBindings({ conversationId: "conv-b", branchId: "main" })).length, 1);
  assert.equal((await service.getWorkspace(virtual.workspace.id)).id, virtual.workspace.id);

  let retryPlan = null;
  const completed = await service.forgetConversations({ conversationIds: ["conv-b"], serverIdentity: SERVER_IDENTITY }, {
    beforeCommit: async (cleanup) => { retryPlan = cleanup; },
  });
  assert.deepEqual(retryPlan.removedWorkspaces.map((entry) => entry.id), [virtual.workspace.id]);
  assert.deepEqual(completed.removedWorkspaces.map((entry) => entry.id), [virtual.workspace.id]);
  await assert.rejects(service.getWorkspace(virtual.workspace.id), (error) => error.code === "WORKSPACE_NOT_FOUND");
});

test("forked branches share the workspace and version domain but keep independent native sessions", async (t) => {
  const { remoteControl, service } = await fixture(t);
  const virtual = await service.createVirtual({
    conversationId: "conv-a",
    serverIdentity: SERVER_IDENTITY,
    expectedRevision: 0,
    commandId: "cmd-fork-virtual",
  });
  const main = await service.ensureAgentBinding({
    conversationId: "conv-a",
    branchId: "main",
    workspaceId: virtual.workspace.id,
    agentId: "claude-code",
    contextEpoch: 2,
    expectedRevision: 0,
    commandId: "cmd-fork-main",
  });
  const activeMain = await service.updateNativeSession({
    bindingId: main.binding.id,
    nativeSessionId: "claude-session-main",
    lastDeliverySequence: 11,
    expectedRevision: main.binding.revision,
    commandId: "cmd-fork-main-session",
  });

  const forked = await service.forkBranch({
    conversationId: "conv-a",
    sourceBranchId: "main",
    branchId: "alternate",
    commandId: "cmd-fork-alternate",
  });
  const route = await service.getRoute({ conversationId: "conv-a", branchId: "alternate" });

  assert.equal(forked.routed, true);
  assert.equal(route.workspace.id, virtual.workspace.id);
  assert.equal(route.binding.versionDomainId, activeMain.binding.versionDomainId);
  assert.notEqual(route.binding.id, activeMain.binding.id);
  assert.equal(route.binding.nativeSessionId, null);
  assert.equal(route.binding.lastDeliverySequence, 0);
  assert.ok(remoteControl.calls.filter((entry) => entry.kind === "write").every((entry) => entry.path.includes("/.easywork/bindings/workspaces/")));
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
