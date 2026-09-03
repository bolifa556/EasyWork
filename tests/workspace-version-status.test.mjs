import assert from "node:assert/strict";
import test from "node:test";

import { ActorServiceContainer } from "../gateway/core/runtime/services.mjs";

test("workspace version status treats an unmaterialized lazy ledger as empty history", async () => {
  const container = Object.assign(Object.create(ActorServiceContainer.prototype), {
    actor: { actorId: "alice" },
    servers: {
      async get() { return { profile: { id: "server_a", serverIdentity: "ssh_identity_a" } }; },
    },
  });
  container.workspaceFor = async () => ({
    async getWorkspace() { return { id: "workspace_a", actorId: "alice", serverIdentity: "ssh_identity_a", canonicalPath: "/work/project", kind: "user" }; },
    async listBindings() { return [{ workspaceId: "workspace_a", versionDomainId: "vl_lazy", contextEpoch: 0, updatedAt: "2026-08-27T00:00:00.000Z" }]; },
  });
  container.versioningFor = async () => ({
    async getDomain() { throw Object.assign(new Error("对话版本账本不存在"), { code: "VERSION_DOMAIN_NOT_FOUND" }); },
  });

  const status = await container.workspaceVersionStatus("server_a", {
    workspaceId: "workspace_a",
    conversationId: "conversation_a",
    branchId: "branch_a",
  });
  assert.deepEqual(status, {
    workspace: { id: "workspace_a", canonicalPath: "/work/project", kind: "user" },
    versioned: false,
    headCheckpointId: null,
    checkpoints: [],
    pendingCount: 0,
    counts: { added: 0, modified: 0, deleted: 0 },
  });
});

test("workspace activation materializes the selected conversation HEAD", async () => {
  const calls = [];
  const container = Object.assign(Object.create(ActorServiceContainer.prototype), {
    actor: { actorId: "alice" },
    servers: {
      async get() { return { profile: { id: "server_a", serverIdentity: "ssh_identity_a" } }; },
    },
    taskStore: { async listTasks() { return []; } },
  });
  container.workspaceFor = async () => ({
    async getWorkspace() { return { id: "workspace_a", actorId: "alice", serverIdentity: "ssh_identity_a", canonicalPath: "/work/project", kind: "user" }; },
    async listBindings() { return [{ workspaceId: "workspace_a", versionDomainId: "vl_conversation_a", contextEpoch: 0, updatedAt: "2026-08-31T00:00:00.000Z" }]; },
  });
  container.versioningFor = async () => ({
    async getDomain() {
      return { conversationId: "conversation_a", branches: { branch_a: { headCheckpointId: "checkpoint_task_after" } } };
    },
    async activateCheckpoint(locator, input) {
      calls.push({ locator, input });
      return { applied: true, paths: 1, reusedMaterialization: false };
    },
  });

  const activated = await container.activateWorkspaceVersion("server_a", {
    workspaceId: "workspace_a",
    conversationId: "conversation_a",
    branchId: "branch_a",
    activationId: "activate_test",
  });
  assert.deepEqual(activated, {
    activated: true,
    reason: null,
    headCheckpointId: "checkpoint_task_after",
    paths: 1,
    reusedMaterialization: false,
  });
  assert.deepEqual(calls, [{
    locator: { actorId: "alice", serverIdentity: "ssh_identity_a", versionDomainId: "vl_conversation_a" },
    input: { checkpointId: "checkpoint_task_after", activationId: "activate_test" },
  }]);
});

test("workspace activation does not switch files underneath an active task", async () => {
  const container = Object.assign(Object.create(ActorServiceContainer.prototype), {
    actor: { actorId: "alice" },
    servers: {
      async get() { return { profile: { id: "server_a", serverIdentity: "ssh_identity_a" } }; },
    },
    taskStore: {
      async listTasks() {
        return [{ id: "task_running", conversationId: "conversation_b", route: { serverIdentity: "ssh_identity_a", workspaceId: "workspace_a" } }];
      },
    },
  });
  container.workspaceFor = async () => ({
    async getWorkspace() { return { id: "workspace_a", actorId: "alice", serverIdentity: "ssh_identity_a", canonicalPath: "/work/project", kind: "user" }; },
    async listBindings() { return [{ workspaceId: "workspace_a", versionDomainId: "vl_conversation_a", contextEpoch: 0, updatedAt: "2026-08-31T00:00:00.000Z" }]; },
  });
  container.versioningFor = async () => ({
    async getDomain() {
      return { conversationId: "conversation_a", branches: { branch_a: { headCheckpointId: "checkpoint_task_after" } } };
    },
  });

  await assert.rejects(() => container.activateWorkspaceVersion("server_a", {
    workspaceId: "workspace_a",
    conversationId: "conversation_a",
    branchId: "branch_a",
    activationId: "activate_test",
  }), (error) => error?.code === "WORKSPACE_TASK_ACTIVE");
});

test("explicit workspace rewind cannot change shared files underneath another conversation's Task", async () => {
  const calls = [];
  const container = Object.assign(Object.create(ActorServiceContainer.prototype), {
    actor: { actorId: "alice" },
    servers: {
      async get() { return { profile: { id: "server_a", serverIdentity: "ssh_identity_a" } }; },
    },
    taskStore: {
      async listTasks(input) {
        calls.push(input);
        if (input.conversationId) return [];
        return [{ id: "task_other_conversation", conversationId: "conversation_b", route: { serverIdentity: "ssh_identity_a", workspaceId: "workspace_a" } }];
      },
    },
  });
  container.workspaceFor = async () => ({
    async getWorkspace() { return { id: "workspace_a", actorId: "alice", serverIdentity: "ssh_identity_a", canonicalPath: "/work/project", kind: "user" }; },
    async listBindings() { return [{ workspaceId: "workspace_a", versionDomainId: "vl_conversation_a", contextEpoch: 0, updatedAt: "2026-08-31T00:00:00.000Z" }]; },
  });
  container.versioningFor = async () => ({
    async rewind() { throw new Error("rewind must not start while a shared workspace Task is active"); },
  });

  await assert.rejects(() => container.rewindWorkspaceVersion("server_a", {
    workspaceId: "workspace_a",
    conversationId: "conversation_a",
    branchId: "branch_a",
    targetCheckpointId: "checkpoint_a",
    rewindId: "rewind_test",
  }), (error) => error?.code === "WORKSPACE_TASK_ACTIVE");
  assert.equal(calls.length, 2);
});
