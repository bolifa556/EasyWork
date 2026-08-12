import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../gateway/core/errors.mjs";
import { TaskOrchestrator } from "../gateway/core/orchestrator/index.mjs";

const copy = (value) => value === undefined ? undefined : structuredClone(value);

class MemoryTaskStore {
  tasks = new Map();
  commands = new Map();

  key(taskId, commandId) {
    return `${taskId}:${commandId}`;
  }

  async claimCommand(record) {
    const key = this.key(record.taskId, record.commandId);
    if (this.commands.has(key)) return { created: false, record: copy(this.commands.get(key)) };
    this.commands.set(key, copy(record));
    return { created: true, record: copy(record) };
  }

  async getCommand(taskId, commandId) {
    return copy(this.commands.get(this.key(taskId, commandId)) || null);
  }

  async updateCommand(taskId, commandId, changes) {
    const key = this.key(taskId, commandId);
    const current = this.commands.get(key);
    assert.ok(current, `missing command ${key}`);
    const next = { ...current, ...copy(changes) };
    this.commands.set(key, next);
    return copy(next);
  }

  async createTask(task) {
    assert.equal(this.tasks.has(task.id), false);
    this.tasks.set(task.id, copy(task));
  }

  async getTask(taskId) {
    return copy(this.tasks.get(taskId) || null);
  }

  async saveTask(task, options) {
    const current = this.tasks.get(task.id);
    assert.ok(current);
    assert.equal(current.revision, options.expectedRevision);
    this.tasks.set(task.id, copy(task));
    return copy(task);
  }

  async listTasks(options = {}) {
    const statuses = options.statuses ? new Set(options.statuses) : null;
    return [...this.tasks.values()]
      .filter((task) => !statuses || statuses.has(task.status))
      .slice(0, options.limit || 100)
      .map(copy);
  }

  async listCommands(taskId) {
    return [...this.commands.values()].filter((command) => command.taskId === taskId).map(copy);
  }
}

class DetachedRuntime {
  bindings = new Map();
  jobs = new Set();

  async launch(_key, worker) {
    const promise = Promise.resolve().then(worker);
    this.jobs.add(promise);
    promise.then(
      () => this.jobs.delete(promise),
      () => this.jobs.delete(promise),
    );
    promise.catch(() => {});
    return { accepted: true };
  }

  async loadBinding(bindingId) {
    return copy(this.bindings.get(bindingId) || null);
  }

  async saveBinding(bindingId, binding) {
    this.bindings.set(bindingId, copy(binding));
  }

  async waitForIdle() {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
}

class AsyncFrameQueue {
  values = [];
  waiters = [];
  closed = false;

  push(value) {
    assert.equal(this.closed, false);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: copy(value), done: false });
    else this.values.push(copy(value));
  }

  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next() {
    if (this.values.length) return { value: this.values.shift(), done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async return() {
    this.close();
    return { value: undefined, done: true };
  }
}

function createFakeAdapter(options = {}) {
  const available = options.appendAvailable !== false;
  return {
    id: "fake-agent",
    producer: { adapter: "fake-agent", protocol: "fixture" },
    capabilities: {
      start: { availability: "available", mode: "native" },
      append: { availability: available ? "available" : "unavailable", mode: available ? "native" : "unavailable" },
      interrupt: { availability: "available", mode: "native" },
      resume: { availability: "available", mode: "native" },
      compact: { availability: "available", mode: "native" },
      contextUsage: { availability: "available", mode: "derived" },
    },
    createState() {
      return { adapterId: "fake-agent", sequence: 0, sessionId: null, turnId: null, finalText: "" };
    },
    operation(operation, input) {
      if (operation === "append" && !available) {
        throw new ApiError("AGENT_CAPABILITY_UNAVAILABLE", "append unavailable", { status: 409 });
      }
      return { adapter: "fake-agent", operation, input: copy(input) };
    },
    reduce(previous, raw) {
      const state = copy(previous);
      state.sequence += 1;
      if (raw.sessionId) state.sessionId = raw.sessionId;
      if (raw.turnId) state.turnId = raw.turnId;
      if (raw.kind === "message") state.finalText += raw.payload?.text || "";
      return {
        state,
        events: [{
          schemaVersion: 1,
          sequence: state.sequence,
          producer: { adapter: "fake-agent", protocol: "fixture" },
          kind: raw.kind,
          phase: raw.phase || "updated",
          source: { type: raw.type || "fixture", sessionId: state.sessionId },
          payload: copy(raw.payload || {}),
        }],
      };
    },
  };
}

class FakeTransport {
  calls = [];
  queues = [];
  failOperation = null;
  runSequence = 0;

  async execute(request) {
    this.calls.push(copy({
      operation: request.operation,
      adapterId: request.adapterId,
      taskId: request.task.id,
      bindingId: request.binding.agentBindingId,
      native: request.binding.native,
      descriptor: request.descriptor,
    }));
    if (this.failOperation === request.operation) {
      const error = new Error(`${request.operation} transport failed`);
      error.code = "TRANSPORT_FAILED";
      throw error;
    }
    if (["start", "resume"].includes(request.operation)) {
      const queue = new AsyncFrameQueue();
      this.queues.push(queue);
      this.runSequence += 1;
      return {
        runId: `run-${this.runSequence}`,
        bindingPatch: {
          native: {
            sessionId: request.binding.native.sessionId || "native-session-1",
            processId: `process-${this.runSequence}`,
          },
        },
        frames: queue,
      };
    }
    return {
      runId: request.binding.activeRunId,
      bindingPatch: { native: copy(request.binding.native) },
    };
  }
}

function dependencies(options = {}) {
  const taskStore = new MemoryTaskStore();
  const runtime = new DetachedRuntime();
  const transport = new FakeTransport();
  const events = [];
  const acknowledgements = [];
  const fileChanges = [];
  const artifacts = [];
  const deps = {
    taskStore,
    runtime,
    transport,
    adapters: { "fake-agent": createFakeAdapter(options) },
    contextHub: {
      async assemble(sessionId) {
        return {
          delivery: {
            id: "delivery-1",
            sessionId,
            entries: [{ kind: "memory", source: { type: "memory" }, content: { value: "Remember this" } }],
          },
          usage: { usedTokens: 3 },
        };
      },
      async deliveryForBinding(_bindingId, delivery) { return copy(delivery); },
      async acknowledge(value) { acknowledgements.push(copy(value)); return copy(value); },
    },
    journal: {
      async append(topic, event) {
        const stored = { topic, sequence: events.length + 1, ...copy(event) };
        events.push(stored);
        return copy(stored);
      },
    },
    workspaceService: {
      async prepare({ mode }) { return { id: "workspace-1", path: "/work", mode }; },
    },
    versionService: {
      async prepare() { return { checkpointId: "checkpoint-1" }; },
      async recordFileChange(value) { fileChanges.push(copy(value)); },
      async finalize() {},
    },
    artifactService: {
      async capture(value) { artifacts.push(copy(value)); return { artifact: { id: `artifact-${artifacts.length}` }, duplicate: false }; },
    },
    skillService: {
      async prepare({ pins }) { return { pins: copy(pins) }; },
    },
    reportService: {
      async generate(value) { return { taskId: value.task.id }; },
      async get() { return null; },
    },
    ...(options.taskFinalizer ? { taskFinalizer: options.taskFinalizer } : {}),
  };
  return { deps, taskStore, runtime, transport, events, acknowledgements, fileChanges, artifacts };
}

function taskInput(id = "task-1") {
  return {
    id,
    actorId: "user-1",
    conversationId: "conversation-1",
    branchId: "branch-1",
    goal: "Inspect the workspace",
    route: {
      serverId: "server-1",
      serverIdentity: `ssh_${"a".repeat(43)}`,
      workspaceId: "workspace-1",
      agentId: "fake-agent",
      providerId: "provider_agent",
      modelId: "model-agent-1",
    },
    contextSessionId: "context-1",
    agentBindingId: `binding-${id}`,
    skillPins: [],
    resourceBindingSnapshotId: "resources-1",
    versionCheckpointId: null,
    budgets: {
      maxWallTimeMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 4_000,
      maxToolCalls: 20,
    },
  };
}

async function waitUntil(check, message = "condition") {
  for (let index = 0; index < 500; index += 1) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${message}`);
}

async function createAndStart(orchestrator, id = "task-1") {
  await orchestrator.create(taskInput(id), { commandId: `create-${id}` });
  const receipt = await orchestrator.start(id, { commandId: `start-${id}` });
  assert.equal(receipt.command.status, "accepted");
  await waitUntil(async () => (await orchestrator.getTask(id)).status === "running", `${id} running`);
}

test("start 脱离浏览器请求后继续消费原始帧并按序完成 Task", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator);
  assert.equal(fixture.transport.queues.length, 1);

  const queue = fixture.transport.queues[0];
  queue.push({ kind: "message", payload: { text: "working" }, sessionId: "native-session-1" });
  queue.push({ kind: "plan", payload: { items: [{ id: "step-1", text: "Inspect", status: "in_progress" }] } });
  queue.push({ kind: "file_change", phase: "completed", payload: { path: "/work/a.js", diff: "+ok" } });
  queue.push({ kind: "artifact", phase: "completed", payload: { name: "report.txt" } });
  queue.push({ kind: "final", phase: "completed", payload: { text: "done" } });
  queue.close();

  await fixture.runtime.waitForIdle();
  const task = await orchestrator.getTask("task-1");
  assert.equal(task.status, "completed");
  assert.deepEqual(task.plan, [{ id: "step-1", text: "Inspect", status: "running" }]);
  assert.deepEqual(task.artifactIds, ["artifact-1"]);
  assert.equal(fixture.fileChanges.length, 1);
  assert.equal(fixture.acknowledgements.length, 1);
  const agentEvents = fixture.events.filter((event) => event.producer === "agent:fake-agent");
  assert.deepEqual(agentEvents.map((event) => event.payload.agentSequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(agentEvents.map((event) => event.kind), ["message", "plan", "file_change", "artifact", "final"]);
});

test("running 期间 append 使用 capability 且 commandId 重试不会重复传输", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-append");

  const first = await orchestrator.append("task-append", { commandId: "append-1", prompt: "also inspect tests" });
  const duplicate = await orchestrator.append("task-append", { commandId: "append-1", prompt: "also inspect tests" });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await waitUntil(async () => (await orchestrator.getCommand("task-append", "append-1"))?.status === "completed", "append complete");
  assert.equal(fixture.transport.calls.filter((call) => call.operation === "append").length, 1);
  assert.equal((await orchestrator.getTask("task-append")).status, "running");
  await assert.rejects(
    orchestrator.append("task-append", { commandId: "append-1", prompt: "different command" }),
    (error) => error.code === "TASK_COMMAND_ID_REUSED",
  );

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "done" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("interrupt 后 resume 复用原 Agent binding 与 native session", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-resume");

  await orchestrator.interrupt("task-resume", { commandId: "interrupt-1" });
  await waitUntil(async () => (await orchestrator.getTask("task-resume")).status === "interrupted", "interrupted");
  const bindingBefore = await fixture.runtime.loadBinding("binding-task-resume");

  await orchestrator.resume("task-resume", { commandId: "resume-1", prompt: "continue from there" });
  await waitUntil(async () => (await orchestrator.getTask("task-resume")).status === "running", "resumed running");
  const resumeCall = fixture.transport.calls.find((call) => call.operation === "resume");
  assert.equal(resumeCall.bindingId, "binding-task-resume");
  assert.equal(resumeCall.native.sessionId, bindingBefore.native.sessionId);
  assert.equal(resumeCall.descriptor.input.sessionId, bindingBefore.native.sessionId);

  // The interrupted stream may close after the replacement run is active. It must not fail the resumed Task.
  fixture.transport.queues[0].close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await orchestrator.getTask("task-resume")).status, "running");

  fixture.transport.queues[1].push({ kind: "final", phase: "completed", payload: { text: "resumed" } });
  fixture.transport.queues[1].close();
  await fixture.runtime.waitForIdle();
  assert.equal((await orchestrator.getTask("task-resume")).status, "completed");
});

test("interrupt 后丢弃原运行流中迟到的 Agent 事件", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-interrupt-late-frame");

  fixture.transport.queues[0].push({ kind: "message", payload: { text: "before interrupt" }, sessionId: "native-session-1" });
  await waitUntil(() => fixture.events.some((event) => event.payload?.event?.text === "before interrupt"), "pre-interrupt event");
  await orchestrator.interrupt("task-interrupt-late-frame", { commandId: "interrupt-late-frame" });
  await waitUntil(async () => (await orchestrator.getTask("task-interrupt-late-frame")).status === "interrupted", "interrupted before late frame");

  fixture.transport.queues[0].push({ kind: "file_change", phase: "completed", payload: { path: "/work/late.txt", diff: "+late" } });
  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "late final" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();

  assert.equal(fixture.fileChanges.length, 0);
  assert.equal(fixture.events.some((event) => event.payload?.event?.text === "late final"), false);
  assert.equal((await orchestrator.getTask("task-interrupt-late-frame")).status, "interrupted");
});

test("append capability unavailable 会显式失败命令但不破坏正在运行的 Task", async () => {
  const fixture = dependencies({ appendAvailable: false });
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-no-append");

  await orchestrator.append("task-no-append", { commandId: "append-unavailable", prompt: "extra" });
  await waitUntil(async () => (await orchestrator.getCommand("task-no-append", "append-unavailable"))?.status === "failed", "append failure");
  assert.equal((await orchestrator.getTask("task-no-append")).status, "running");
  assert.equal((await orchestrator.getCommand("task-no-append", "append-unavailable")).failure.code, "AGENT_CAPABILITY_UNAVAILABLE");

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "done" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("transport 失败会进入 failed 终态并记录稳定 command failure", async () => {
  const fixture = dependencies();
  fixture.transport.failOperation = "start";
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await orchestrator.create(taskInput("task-failure"), { commandId: "create-failure" });
  await orchestrator.start("task-failure", { commandId: "start-failure" });
  await fixture.runtime.waitForIdle();

  const task = await orchestrator.getTask("task-failure");
  const command = await orchestrator.getCommand("task-failure", "start-failure");
  assert.equal(task.status, "failed");
  assert.equal(task.failure.code, "TRANSPORT_FAILED");
  assert.equal(command.status, "failed");
  assert.equal(command.failure.code, "TRANSPORT_FAILED");
  assert.equal(fixture.events.some((event) => event.kind === "error" && event.status === "failed"), true);
});

test("远端最终报告触发独立 finalizer，提取失败不改变已完成 Task", async () => {
  const finalized = [];
  const fixture = dependencies({
    taskFinalizer: async (input) => {
      finalized.push(copy(input));
      throw new Error("memory extractor unavailable");
    },
  });
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-finalizer");
  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "verified remote report" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
  assert.equal((await orchestrator.getTask("task-finalizer")).status, "completed");
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].event.payload.text, "verified remote report");
});

test("Gateway 重启后使用持久 binding 的 native session 恢复同一 Task", async () => {
  const first = dependencies();
  const original = new TaskOrchestrator(first.deps);
  await createAndStart(original, "task-recovery");
  await waitUntil(async () => (await original.getCommand("task-recovery", "start-task-recovery"))?.status === "completed", "start command completed");

  const second = dependencies();
  second.deps.taskStore = first.taskStore;
  second.deps.runtime = new DetachedRuntime();
  second.deps.runtime.bindings = new Map([...first.runtime.bindings.entries()].map(([key, value]) => [key, copy(value)]));
  const recovered = new TaskOrchestrator(second.deps);
  const outcomes = await recovered.recoverPending();
  assert.equal(outcomes[0].action, "reattached");
  assert.equal((await recovered.getTask("task-recovery")).status, "running");
  assert.equal(second.transport.calls[0].operation, "resume");
  assert.equal(second.transport.calls[0].descriptor.input.sessionId, "native-session-1");
  second.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "recovered" }, sessionId: "native-session-1" });
  second.transport.queues[0].close();
  await waitUntil(async () => (await recovered.getTask("task-recovery")).status === "completed", "recovered task completed");
  first.transport.queues[0].close();
});

test("并发触发恢复时复用同一次扫描与远端 resume", async () => {
  const first = dependencies();
  const original = new TaskOrchestrator(first.deps);
  await createAndStart(original, "task-concurrent-recovery");
  await waitUntil(async () => (await original.getCommand("task-concurrent-recovery", "start-task-concurrent-recovery"))?.status === "completed", "start command completed");

  const second = dependencies();
  second.deps.taskStore = first.taskStore;
  second.deps.runtime = new DetachedRuntime();
  second.deps.runtime.bindings = new Map([...first.runtime.bindings.entries()].map(([key, value]) => [key, copy(value)]));
  const recovered = new TaskOrchestrator(second.deps);

  const [left, right] = await Promise.all([recovered.recoverPending(), recovered.recoverPending()]);
  assert.deepEqual(right, left);
  assert.equal(second.transport.calls.filter((entry) => entry.operation === "resume").length, 1);
  assert.equal((await recovered.getTask("task-concurrent-recovery")).status, "running");

  second.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "recovered once" }, sessionId: "native-session-1" });
  second.transport.queues[0].close();
  await waitUntil(async () => (await recovered.getTask("task-concurrent-recovery")).status === "completed", "concurrent recovered task completed");
  first.transport.queues[0].close();
});

test("Gateway 重启后无法证明 native session 时稳定失败而不遗留 running", async () => {
  const first = dependencies();
  const original = new TaskOrchestrator(first.deps);
  await createAndStart(original, "task-unprovable");
  await waitUntil(async () => (await original.getCommand("task-unprovable", "start-task-unprovable"))?.status === "completed", "start command completed");

  const second = dependencies();
  second.deps.taskStore = first.taskStore;
  second.deps.runtime = new DetachedRuntime();
  const recovered = new TaskOrchestrator(second.deps);
  const outcomes = await recovered.recoverPending();
  assert.equal(outcomes[0].action, "failed");
  const task = await recovered.getTask("task-unprovable");
  assert.equal(task.status, "failed");
  assert.equal(task.failure.code, "TASK_RECOVERY_BINDING_MISSING");
  first.transport.queues[0].close();
});
