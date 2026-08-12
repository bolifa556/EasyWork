import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { createTask, transitionTask } from "../gateway/core/entities/task.mjs";
import { commandFingerprint, createCommandRecord } from "../gateway/core/orchestrator/contract.mjs";
import { DetachedTaskRuntime, FileTaskStore } from "../gateway/core/orchestrator/persistence.mjs";
import { computeServerIdentity } from "../gateway/core/scope.mjs";

const actor = createActorContext({ actorType: "user", actorId: "user_a", deviceId: "device_a", sessionId: "session_a", roles: [] });
const taskInput = {
  id: "task_a", actorId: "user_a", conversationId: "conversation_a", branchId: "main", goal: "inspect",
  route: { serverId: "server_a", serverIdentity: computeServerIdentity({ host: "server.example", port: 22, hostKeyFingerprint: "SHA256:00112233445566778899" }).serverIdentity, workspaceId: "workspace_a", agentId: "opencode", providerId: "provider_agent", modelId: "model-agent-1" },
  contextSessionId: "context_a", agentBindingId: "binding_a", skillPins: [], resourceBindingSnapshotId: "resource_snapshot_a",
  versionCheckpointId: null, budgets: { maxWallTimeMs: 1000, maxInputTokens: 1000, maxOutputTokens: 1000, maxToolCalls: 10 }, idempotencyKey: "command_create",
};

test("FileTaskStore shards tasks and commands while enforcing revisions and idempotency", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-task-store-"));
  try {
    const store = new FileTaskStore({ dataRoot, actor });
    const task = createTask(taskInput);
    await store.createTask(task);
    assert.equal((await store.getTask(task.id)).status, "queued");
    const command = createCommandRecord({ taskId: task.id, commandId: "command_start", type: "start", fingerprint: commandFingerprint("start", { taskId: task.id }) });
    assert.equal((await store.claimCommand(command)).created, true);
    assert.equal((await store.claimCommand(command)).created, false);
    await store.updateCommand(task.id, command.commandId, { status: "running", updatedAt: new Date().toISOString() });
    await store.updateCommand(task.id, command.commandId, { status: "completed", result: { ok: true }, updatedAt: new Date().toISOString() });
    await assert.rejects(() => store.updateCommand(task.id, command.commandId, { status: "running" }), (error) => error?.code === "TASK_COMMAND_TRANSITION_INVALID");
    const webCommand = createCommandRecord({ taskId: task.id, commandId: "web_run:call_remote", type: "append", fingerprint: commandFingerprint("append", { taskId: task.id }) });
    assert.equal((await store.claimCommand(webCommand)).created, true);
    assert.deepEqual((await store.listCommands(task.id)).map((entry) => entry.commandId), ["command_start", "web_run:call_remote"]);
    const preparing = transitionTask(task, "preparing", { expectedRevision: 0 });
    await store.saveTask(preparing, { expectedRevision: 0 });
    await assert.rejects(() => store.saveTask(preparing, { expectedRevision: 0 }), (error) => error?.code === "TASK_REVISION_CONFLICT");
    assert.equal((await store.listTasks({ statuses: ["preparing"] }))[0].id, task.id);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("DetachedTaskRuntime keeps work alive without a browser and persists Agent binding", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-task-runtime-"));
  try {
    const runtime = new DetachedTaskRuntime({ dataRoot, actor });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let completed = false;
    assert.equal((await runtime.launch("run:task_a:1", async () => { await gate; completed = true; })).accepted, true);
    assert.equal((await runtime.launch("run:task_a:1", async () => {})).accepted, false);
    assert.equal(runtime.isRunning("run:task_a:1"), true);
    await runtime.saveBinding("binding_a", { agentBindingId: "binding_a", adapterId: "opencode", state: { adapterId: "opencode", sequence: 0 }, native: { sessionId: "native_a" } });
    assert.equal((await runtime.loadBinding("binding_a")).native.sessionId, "native_a");
    release();
    await runtime.waitForIdle();
    assert.equal(completed, true);
    assert.equal(runtime.isRunning("run:task_a:1"), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
