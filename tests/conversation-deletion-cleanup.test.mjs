import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { DetachedTaskRuntime } from "../gateway/core/orchestrator/persistence.mjs";
import { ActorServiceContainer } from "../gateway/core/runtime/services.mjs";

const SERVER_IDENTITY = `ssh_${crypto.createHash("sha256").update("conversation-deletion-cleanup-host").digest("base64url")}`;

class EmptyRemoteExecutor {
  constructor() {
    this.commands = [];
    this.failNextCleanup = false;
  }

  async home() { return "/home/tester"; }

  async readFile() {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }

  async writeAtomic() {}

  async exec(command) {
    this.commands.push(command);
    if (this.failNextCleanup) {
      this.failNextCleanup = false;
      return { code: 71, stdout: "", stderr: "simulated connection loss" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

test("SSH 连接成功后不等待远端会话清理检查即可返回", async () => {
  let releaseCleanup;
  let cleanupStarted = false;
  let capabilityWarmup = false;
  let schedulerTracking = false;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  const connection = { status: "connected", connectedAt: "2026-09-17T00:00:00.000Z" };
  const service = {
    sshWorker: { async connect() { return connection; } },
    scheduleDeletedAgentConversationCleanup() { cleanupStarted = true; return cleanup; },
    serverCapabilities: { async get() { capabilityWarmup = true; } },
    async trackSchedulerSubmissions() { schedulerTracking = true; },
  };

  let resolved = false;
  const request = ActorServiceContainer.prototype.connectSsh.call(service, "server_fast_connect", {}).then((value) => {
    resolved = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cleanupStarted, true);
  assert.equal(resolved, true, "连接响应不应等待清理检查完成");
  assert.equal(await request, connection);
  assert.equal(capabilityWarmup, true);
  assert.equal(schedulerTracking, true);
  releaseCleanup();
});

test("离线删除登记三种 Agent 会话，连接失败保留登记，成功后一次性清空且不再轮询", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-conversation-deletion-cleanup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const clock = () => new Date("2026-09-02T00:00:00.000Z");
  const actor = createActorContext({
    actorType: "user",
    actorId: "user_delete_cleanup",
    deviceId: "device_delete_cleanup",
    sessionId: "session_delete_cleanup",
    roles: [],
  });
  const container = new ActorServiceContainer({ dataRoot, clock }, actor);
  const initialQueue = await container.conversationDeletionCleanup.read();
  await container.conversationDeletionCleanup.replace({ mode: "pending", local: {}, remote: {} }, {
    expectedRevision: initialQueue.revision,
    clock,
  });

  const conversationId = "conv_delete_cleanup";
  const serverId = "server_delete_cleanup";
  const agents = ["opencode", "codex", "claude-code"];
  const tasks = agents.map((agentId, index) => ({
    id: `task_delete_cleanup_${index}`,
    conversationId,
    agentBindingId: `abk_delete_cleanup_${agentId.replace("-", "_")}`,
    route: { serverId, serverIdentity: SERVER_IDENTITY, agentId },
  }));
  let connectionStatus = "disconnected";
  let unbound = 0;
  container.baseConversations = {
    async listAllMessagesIncludingDeleted() {
      return tasks.map((task, index) => ({ id: `msg_delete_cleanup_${index}`, taskId: task.id }));
    },
  };
  container.taskStore = {
    async scanTasks(input = {}) {
      return input.conversationId ? tasks.filter((task) => task.conversationId === input.conversationId) : tasks;
    },
    async getTask(taskId) { return tasks.find((task) => task.id === taskId) || null; },
  };
  container.taskRuntime = new DetachedTaskRuntime({ dataRoot, actor, clock });
  container.servers = {
    async findConversationBinding() { return { serverId }; },
    async list() {
      return [{ profile: { id: serverId, serverIdentity: SERVER_IDENTITY }, connection: { status: connectionStatus } }];
    },
    async get(requestedServerId) {
      assert.equal(requestedServerId, serverId);
      return { profile: { id: serverId, serverIdentity: SERVER_IDENTITY }, connection: { status: connectionStatus } };
    },
    async unbindConversationEverywhere() { unbound += 1; },
  };
  container.memoryCoordinator = { async forgetConversation() {} };
  container.conversationContext = { async forget() {} };
  container.webAgentObservations = { async forget() {} };
  container.webInteractionStore = { async forgetConversation() {} };
  container.contextHub = { async forgetConversation() {} };

  const local = await container.scheduleConversationDeletionCleanup(conversationId, {
    type: "conversation-delete",
    id: "delete-cleanup-command",
    version: "7",
  });
  assert.equal(local.scheduled, true);
  assert.equal(unbound, 1, "删除请求返回前应已同步解除服务器绑定");
  await container.taskRuntime.waitForIdle();
  assert.equal(unbound, 1);
  let queue = (await container.conversationDeletionCleanup.read()).data;
  assert.deepEqual(queue.local, {});
  assert.deepEqual(queue.remote, { [SERVER_IDENTITY]: { [conversationId]: "7" } });

  const executor = new EmptyRemoteExecutor();
  const releasedBindings = [];
  let backendResolutions = 0;
  let workspaceReconciliations = 0;
  let versionInvalidations = 0;
  container.remoteBackend = async () => {
    backendResolutions += 1;
    return {
      executor,
      agentTransport: { async releaseBinding(bindingId) { releasedBindings.push(bindingId); } },
    };
  };
  container.workspaceFor = async () => ({
    async forgetConversations(input, options = {}) {
      workspaceReconciliations += 1;
      assert.deepEqual(input, { conversationIds: [conversationId], serverIdentity: SERVER_IDENTITY });
      const cleanup = {
        removedWorkspaces: [],
        retainedInheritedWorkspaces: [],
        protectedWorkspaceIds: [],
      };
      await options.beforeCommit?.(cleanup);
      return cleanup;
    },
  });
  container.versioningFor = async () => ({ invalidateRemoteState() { versionInvalidations += 1; } });

  connectionStatus = "connected";
  executor.failNextCleanup = true;
  const failedAttempt = await container.scheduleDeletedAgentConversationCleanup(serverId);
  assert.equal(failedAttempt.scheduled, true);
  await assert.rejects(failedAttempt.promise);
  queue = (await container.conversationDeletionCleanup.read()).data;
  assert.deepEqual(queue.remote, { [SERVER_IDENTITY]: { [conversationId]: "7" } });

  const connectedAttempt = await container.scheduleDeletedAgentConversationCleanup(serverId);
  assert.equal(connectedAttempt.scheduled, true);
  await connectedAttempt.promise;
  queue = (await container.conversationDeletionCleanup.read()).data;
  assert.deepEqual(queue.remote, {});
  assert.deepEqual(new Set(releasedBindings), new Set(tasks.map((task) => task.agentBindingId)));
  assert.equal(versionInvalidations, 1);
  assert.equal(workspaceReconciliations, 2);

  const remoteRunsAfterSuccess = backendResolutions;
  const noPollingPass = await container.scheduleDeletedAgentConversationCleanup(serverId);
  assert.deepEqual(noPollingPass, { scheduled: false, reason: "no-pending-cleanup" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(backendResolutions, remoteRunsAfterSuccess);
});
