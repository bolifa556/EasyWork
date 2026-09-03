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

  async scanTasks(options = {}) {
    return this.listTasks(options);
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
  const adapterId = options.adapterId || "fake-agent";
  return {
    id: adapterId,
    producer: { adapter: adapterId, protocol: "fixture" },
    capabilities: {
      start: { availability: "available", mode: "native" },
      append: { availability: available ? "available" : "unavailable", mode: available ? "native" : "unavailable" },
      interrupt: { availability: "available", mode: "native" },
      resume: { availability: "available", mode: "native" },
      respondApproval: { availability: "available", mode: "native" },
      compact: { availability: "available", mode: "native" },
      contextUsage: { availability: "available", mode: "derived" },
    },
    createState() {
      return { adapterId, sequence: 0, sessionId: null, turnId: null, finalText: "", pendingApprovals: {} };
    },
    operation(operation, input) {
      if (operation === "append" && !available) {
        throw new ApiError("AGENT_CAPABILITY_UNAVAILABLE", "append unavailable", { status: 409 });
      }
      return { adapter: adapterId, operation, input: copy(input) };
    },
    reduce(previous, raw) {
      const state = copy(previous);
      state.sequence += 1;
      if (raw.sessionId) state.sessionId = raw.sessionId;
      if (raw.turnId) state.turnId = raw.turnId;
      if (raw.kind === "message") state.finalText += raw.payload?.text || "";
      if (raw.kind === "approval_request" && raw.payload?.requestId) {
        state.pendingApprovals[raw.payload.requestId] = { itemId: raw.payload.itemId || null };
      }
      if (raw.kind === "approval_response" && raw.payload?.requestId) delete state.pendingApprovals[raw.payload.requestId];
      return {
        state,
        events: [{
          schemaVersion: 1,
          sequence: state.sequence,
          producer: { adapter: adapterId, protocol: "fixture" },
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
  missingNativeOnce = false;
  runSequence = 0;

  async execute(request) {
    this.calls.push(copy({
      operation: request.operation,
      adapterId: request.adapterId,
      taskId: request.task.id,
      bindingId: request.binding.agentBindingId,
      native: request.binding.native,
      descriptor: request.descriptor,
      recoveredSkillPins: request.recoveredSkillPins,
      delivery: request.delivery,
    }));
    if (this.missingNativeOnce && request.operation === "start" && (request.binding.native?.threadId || request.binding.native?.sessionId)) {
      const missingMessage = typeof this.missingNativeOnce === "string" ? this.missingNativeOnce : null;
      this.missingNativeOnce = false;
      throw new Error(missingMessage || (request.adapterId === "codex" ? "thread not found" : "session not found"));
    }
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
            ...(Array.isArray(request.recoveredSkillPins) && request.recoveredSkillPins.length
              ? { skillPins: copy(request.recoveredSkillPins) }
              : {}),
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
  const rebindings = [];
  const stagedDeliveries = [];
  const fileChanges = [];
  const artifacts = [];
  const deps = {
    taskStore,
    runtime,
    transport,
    adapters: { [options.adapterId || "fake-agent"]: createFakeAdapter(options) },
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
      async deliveryForRebinding(bindingId, delivery) { rebindings.push({ bindingId, delivery: copy(delivery) }); return copy(delivery); },
      async stageDeliveredKnowledge(value) { stagedDeliveries.push(copy(value)); return copy(value); },
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
      async finalize() {},
    },
    versionService: {
      async prepare() { return { checkpointId: "checkpoint-1" }; },
      async recordFileChange(value) { fileChanges.push(copy(value)); },
      async finalize() {},
      async abandon() {},
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
      async recoverableFinal() { return null; },
    },
    prompts: {
      async remoteDelivery(delivery, goal) {
        const context = (delivery?.entries || []).map((entry) => entry?.content?.value).filter(Boolean).join("\n\n");
        return context ? `${context}\n\n${goal}` : goal;
      },
    },
    ...(options.taskFinalizer ? { taskFinalizer: options.taskFinalizer } : {}),
  };
  return { deps, taskStore, runtime, transport, events, acknowledgements, rebindings, stagedDeliveries, fileChanges, artifacts };
}

function taskInput(id = "task-1", agentId = "fake-agent") {
  return {
    id,
    actorId: "user-1",
    conversationId: "conversation-1",
    branchId: "branch-1",
    sourceMessageId: `message-${id}`,
    conversationRunId: `run-${id}`,
    goal: "Inspect the workspace",
    route: {
      serverId: "server-1",
      serverIdentity: `ssh_${"a".repeat(43)}`,
      workspaceId: "workspace-1",
      agentId,
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
  assert.equal(fixture.stagedDeliveries.length, 1);
  assert.equal(fixture.stagedDeliveries[0].taskId, "task-1");
  assert.equal(fixture.stagedDeliveries[0].delivery.id, "delivery-1");

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
  assert.deepEqual(agentEvents.map((event) => event.payload.agentSequence), [1, 3, 4, 5]);
  assert.deepEqual(agentEvents.map((event) => event.kind), ["message", "file_change", "artifact", "final"]);
  assert.equal(fixture.events.some((event) => event.producer === "task-orchestrator" && event.kind === "plan_state"), true);
});

test("作业记账只消费工具终态，记账失败不会中断或重发远端执行", async () => {
  const fixture = dependencies();
  const receipts = [];
  fixture.deps.submissionRecorder = async (record) => {
    receipts.push(copy(record));
    throw Object.assign(new Error("ledger temporarily unavailable"), { code: "TEST_LEDGER_UNAVAILABLE" });
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-submission-record");
  const queue = fixture.transport.queues[0];
  const payload = { name: "Bash", callId: "submit-1", input: { command: "sbatch example.sh" }, text: "Submitted batch job 123" };
  queue.push({ kind: "tool_call", phase: "started", payload, sessionId: "native-submission-session" });
  queue.push({ kind: "tool_result", phase: "updated", payload });
  queue.push({ kind: "tool_result", phase: "completed", payload });
  queue.push({ kind: "final", phase: "completed", payload: { text: "submitted" } });
  queue.close();
  await fixture.runtime.waitForIdle();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].task.id, "task-submission-record");
  assert.equal(receipts[0].event.phase, "completed");
  assert.equal(receipts[0].binding.state.sessionId, "native-submission-session");
  assert.equal((await orchestrator.getTask("task-submission-record")).status, "completed");
  assert.equal(fixture.transport.calls.filter((call) => call.operation === "start").length, 1);
});

test("running 期间 append 使用 capability 且 commandId 重试不会重复传输", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-append");

  const appendTurn = { sourceMessageId: "message-append-1", conversationRunId: "conversation-run-append-1" };
  const first = await orchestrator.append("task-append", { commandId: "append-1", prompt: "also inspect tests", ...appendTurn });
  const duplicate = await orchestrator.append("task-append", { commandId: "append-1", prompt: "also inspect tests", ...appendTurn });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await waitUntil(async () => (await orchestrator.getCommand("task-append", "append-1"))?.status === "completed", "append complete");
  assert.equal(fixture.transport.calls.filter((call) => call.operation === "append").length, 1);
  assert.equal((await orchestrator.getTask("task-append")).status, "running");
  await assert.rejects(
    orchestrator.append("task-append", { commandId: "append-1", prompt: "different command", ...appendTurn }),
    (error) => error.code === "TASK_COMMAND_ID_REUSED",
  );

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "done" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("waiting_approval 通过原生协议响应并恢复同一运行流", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-approval");

  fixture.transport.queues[0].push({
    kind: "approval_request",
    phase: "waiting",
    payload: { requestId: "approval-1", itemId: "tool-1", title: "Run pwd" },
    sessionId: "native-session-1",
  });
  await waitUntil(async () => (await orchestrator.getTask("task-approval")).status === "waiting_approval", "approval waiting");
  assert.deepEqual((await fixture.runtime.loadBinding("binding-task-approval")).state.pendingApprovals, {
    "approval-1": { itemId: "tool-1" },
  });

  const receipt = await orchestrator.respondApproval("task-approval", {
    commandId: "approval-command-1",
    requestId: "approval-1",
    decision: "approve",
  });
  assert.equal(receipt.command.status, "accepted");
  await waitUntil(async () => (await orchestrator.getCommand("task-approval", "approval-command-1"))?.status === "completed", "approval response complete");

  const call = fixture.transport.calls.find((entry) => entry.operation === "respondApproval");
  assert.equal(call.descriptor.input.requestId, "approval-1");
  assert.equal(call.descriptor.input.decision, "approve");
  assert.deepEqual(call.descriptor.input.pendingApproval, { itemId: "tool-1" });
  assert.equal((await orchestrator.getTask("task-approval")).status, "running");
  assert.deepEqual((await fixture.runtime.loadBinding("binding-task-approval")).state.pendingApprovals, {});
  const hostResponse = fixture.events.find((event) => event.producer === "task-orchestrator" && event.kind === "approval_response");
  assert.equal(hostResponse.status, "completed");
  assert.deepEqual(hostResponse.payload.event, { requestId: "approval-1", decision: "approve" });

  fixture.transport.queues[0].push({ kind: "approval_response", phase: "completed", payload: { requestId: "approval-1", decision: "approve" } });
  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "approved and done" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
  assert.equal((await orchestrator.getTask("task-approval")).status, "completed");
});

test("同一 Claude 回合的并行审批逐项结算且不会提前离开 waiting_approval", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-multiple-approvals");

  fixture.transport.queues[0].push({
    kind: "approval_request",
    phase: "waiting",
    payload: { requestId: "approval-a", itemId: "tool-a", title: "Read A" },
    sessionId: "native-session-1",
  });
  fixture.transport.queues[0].push({
    kind: "approval_request",
    phase: "waiting",
    payload: { requestId: "approval-b", itemId: "tool-b", title: "Read B" },
    sessionId: "native-session-1",
  });
  await waitUntil(async () => Object.keys((await fixture.runtime.loadBinding("binding-task-multiple-approvals"))?.state?.pendingApprovals || {}).length === 2, "both approvals pending");

  await orchestrator.respondApproval("task-multiple-approvals", {
    commandId: "approval-command-a",
    requestId: "approval-a",
    decision: "reject",
  });
  await waitUntil(async () => (await orchestrator.getCommand("task-multiple-approvals", "approval-command-a"))?.status === "completed", "first approval response complete");
  assert.equal((await orchestrator.getTask("task-multiple-approvals")).status, "waiting_approval");
  assert.deepEqual(Object.keys((await fixture.runtime.loadBinding("binding-task-multiple-approvals")).state.pendingApprovals), ["approval-b"]);

  await orchestrator.respondApproval("task-multiple-approvals", {
    commandId: "approval-command-b",
    requestId: "approval-b",
    decision: "reject",
  });
  await waitUntil(async () => (await orchestrator.getCommand("task-multiple-approvals", "approval-command-b"))?.status === "completed", "second approval response complete");
  assert.equal((await orchestrator.getTask("task-multiple-approvals")).status, "running");
  assert.deepEqual((await fixture.runtime.loadBinding("binding-task-multiple-approvals")).state.pendingApprovals, {});

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "done" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("append 传输未返回时 interrupt 优先，迟到的 append 不会把 Task 复活为 running", async () => {
  const fixture = dependencies();
  let appendEntered;
  let releaseAppend;
  const entered = new Promise((resolve) => { appendEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseAppend = resolve; });
  const execute = fixture.transport.execute.bind(fixture.transport);
  fixture.transport.execute = async (request) => {
    if (request.operation === "append") {
      appendEntered();
      await blocked;
    }
    return execute(request);
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-append-interrupt-race");

  await orchestrator.append("task-append-interrupt-race", { commandId: "append-racing", prompt: "late append", sourceMessageId: "message-append-racing", conversationRunId: "conversation-run-append-racing" });
  await entered;
  assert.equal((await orchestrator.getTask("task-append-interrupt-race")).status, "waiting_append");
  await orchestrator.interrupt("task-append-interrupt-race", { commandId: "interrupt-racing-append" });
  await waitUntil(async () => (await orchestrator.getTask("task-append-interrupt-race")).status === "interrupted", "append race interrupted");
  releaseAppend();
  await waitUntil(async () => (await orchestrator.getCommand("task-append-interrupt-race", "append-racing"))?.status === "completed", "racing append settled");

  const task = await orchestrator.getTask("task-append-interrupt-race");
  const appendCommand = await orchestrator.getCommand("task-append-interrupt-race", "append-racing");
  assert.equal(task.status, "interrupted");
  assert.equal(appendCommand.status, "completed");
  assert.equal(appendCommand.result.interrupted, true);
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("append 占位时忽略旧回合迟到的 final，并把后续事件归到追加消息", async () => {
  const fixture = dependencies();
  let appendEntered;
  let releaseAppend;
  const entered = new Promise((resolve) => { appendEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseAppend = resolve; });
  const execute = fixture.transport.execute.bind(fixture.transport);
  fixture.transport.execute = async (request) => {
    if (request.operation === "append") {
      appendEntered();
      await blocked;
    }
    return execute(request);
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-append-final-race");

  await orchestrator.append("task-append-final-race", {
    commandId: "append-final-race",
    prompt: "补充约束",
    sourceMessageId: "message-followup",
    conversationRunId: "conversation-run-followup",
  });
  await entered;
  let task = await orchestrator.getTask("task-append-final-race");
  assert.equal(task.status, "waiting_append");
  assert.equal(task.sourceMessageId, "message-followup");
  assert.equal(task.conversationRunId, "conversation-run-followup");

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "pre-steer final" } });
  await waitUntil(() => fixture.events.some((event) => event.payload?.event?.text === "pre-steer final"), "pre-steer final observed");
  assert.equal((await orchestrator.getTask("task-append-final-race")).status, "waiting_append");

  releaseAppend();
  await waitUntil(async () => (await orchestrator.getCommand("task-append-final-race", "append-final-race"))?.status === "completed", "append accepted by native transport");
  assert.equal((await orchestrator.getTask("task-append-final-race")).status, "running");

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "post-steer final" } });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
  task = await orchestrator.getTask("task-append-final-race");
  assert.equal(task.status, "completed");
  assert.equal(task.sourceMessageId, "message-followup");
});

test("append 原生转向时旧流的 abort error 与无 final 关闭不会击穿新回合", async () => {
  const fixture = dependencies();
  let appendEntered;
  let releaseAppend;
  const entered = new Promise((resolve) => { appendEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseAppend = resolve; });
  const execute = fixture.transport.execute.bind(fixture.transport);
  fixture.transport.execute = async (request) => {
    if (request.operation !== "append") return execute(request);
    appendEntered();
    await blocked;
    const accepted = await execute(request);
    const queue = new AsyncFrameQueue();
    fixture.transport.queues.push(queue);
    fixture.transport.runSequence += 1;
    return { ...accepted, runId: `run-${fixture.transport.runSequence}`, frames: queue };
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-append-abort-boundary");

  await orchestrator.append("task-append-abort-boundary", {
    commandId: "append-abort-boundary",
    prompt: "立即按新约束继续",
    sourceMessageId: "message-append-abort-boundary",
    conversationRunId: "conversation-run-append-abort-boundary",
  });
  await entered;
  assert.equal((await orchestrator.getTask("task-append-abort-boundary")).status, "waiting_append");

  const oldRun = fixture.transport.queues[0];
  oldRun.push({ kind: "error", phase: "failed", payload: { message: '{"name":"MessageAbortedError"}' } });
  await waitUntil(async () => (await fixture.runtime.loadBinding("binding-task-append-abort-boundary"))?.state?.sequence === 1, "old abort frame reduced");
  oldRun.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await orchestrator.getTask("task-append-abort-boundary")).status, "waiting_append");
  assert.equal(fixture.events.some((event) => event.payload?.event?.message?.includes("MessageAbortedError")), false);

  releaseAppend();
  await waitUntil(async () => (await orchestrator.getCommand("task-append-abort-boundary", "append-abort-boundary"))?.status === "completed", "append accepted after abort boundary");
  assert.equal((await orchestrator.getTask("task-append-abort-boundary")).status, "running");

  const appendedRun = fixture.transport.queues[1];
  appendedRun.push({ kind: "final", phase: "completed", payload: { text: "continued after correction" } });
  appendedRun.close();
  await fixture.runtime.waitForIdle();
  const task = await orchestrator.getTask("task-append-abort-boundary");
  assert.equal(task.status, "completed");
  assert.equal(task.sourceMessageId, "message-append-abort-boundary");
  assert.equal(task.conversationRunId, "conversation-run-append-abort-boundary");
});

test("interrupt 后 resume 复用原 Agent binding 与 native session", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-resume");

  await orchestrator.interrupt("task-resume", { commandId: "interrupt-1" });
  await waitUntil(async () => (await orchestrator.getTask("task-resume")).status === "interrupted", "interrupted");
  const bindingBefore = await fixture.runtime.loadBinding("binding-task-resume");

  await orchestrator.resume("task-resume", { commandId: "resume-1", prompt: "continue from there", sourceMessageId: "message-resume-1", conversationRunId: "conversation-run-resume-1" });
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

test("interrupt transport 失败也会收敛为 interrupted，不把页面永久留在 interrupting", async () => {
  const fixture = dependencies();
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-interrupt-failure");
  fixture.transport.failOperation = "interrupt";

  await orchestrator.interrupt("task-interrupt-failure", { commandId: "interrupt-failure" });
  const task = await waitUntil(async () => {
    const current = await orchestrator.getTask("task-interrupt-failure");
    return current.status === "interrupted" ? current : null;
  }, "failed interrupt convergence");
  const command = await orchestrator.getCommand("task-interrupt-failure", "interrupt-failure");
  assert.equal(task.status, "interrupted");
  assert.equal(command.status, "completed");
  assert.equal(command.result.warning.code, "TRANSPORT_FAILED");
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("interrupted 只在版本边界持久化完成后发布，下一条 Work Task 不会抢跑", async () => {
  const fixture = dependencies();
  let enteredFinalize;
  let releaseFinalize;
  const finalizeEntered = new Promise((resolve) => { enteredFinalize = resolve; });
  const finalizeBlocked = new Promise((resolve) => { releaseFinalize = resolve; });
  fixture.deps.versionService.finalize = async () => {
    enteredFinalize();
    await finalizeBlocked;
    return { beforeCheckpointId: "checkpoint-interrupt-durable" };
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await createAndStart(orchestrator, "task-interrupt-version-boundary");

  await orchestrator.interrupt("task-interrupt-version-boundary", { commandId: "interrupt-version-boundary" });
  await finalizeEntered;
  assert.equal((await orchestrator.getTask("task-interrupt-version-boundary")).status, "interrupting");

  releaseFinalize();
  const task = await waitUntil(async () => {
    const current = await orchestrator.getTask("task-interrupt-version-boundary");
    return current.status === "interrupted" ? current : null;
  }, "durably interrupted");
  assert.equal(task.versionCheckpointId, "checkpoint-interrupt-durable");
  assert.equal((await orchestrator.getCommand("task-interrupt-version-boundary", "interrupt-version-boundary")).status, "completed");
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
});

test("preparing 阶段可以中断，且解除准备阻塞后不会再启动远端传输", async () => {
  const fixture = dependencies();
  let enteredPrepare;
  let releasePrepare;
  const prepareEntered = new Promise((resolve) => { enteredPrepare = resolve; });
  const prepareBlocked = new Promise((resolve) => { releasePrepare = resolve; });
  fixture.deps.workspaceService.prepare = async ({ mode }) => {
    enteredPrepare();
    await prepareBlocked;
    return { id: "workspace-1", path: "/work", mode };
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await orchestrator.create(taskInput("task-startup-interrupt"), { commandId: "create-startup-interrupt" });
  await orchestrator.start("task-startup-interrupt", { commandId: "start-startup-interrupt" });
  await prepareEntered;

  await orchestrator.interrupt("task-startup-interrupt", { commandId: "interrupt-startup" });
  await waitUntil(async () => (await orchestrator.getTask("task-startup-interrupt")).status === "interrupting", "startup interrupting");
  releasePrepare();
  await waitUntil(async () => (await orchestrator.getTask("task-startup-interrupt")).status === "interrupted", "startup interrupted");
  await fixture.runtime.waitForIdle();

  assert.equal((await orchestrator.getTask("task-startup-interrupt")).status, "interrupted");
  assert.equal(fixture.transport.calls.some((call) => call.operation === "start"), false);
  assert.equal((await orchestrator.getCommand("task-startup-interrupt", "start-startup-interrupt")).status, "completed");
});

test("start 状态推进与 interrupt 并发时不会把已中断 Task 改成失败", async () => {
  const fixture = dependencies();
  let releaseVersion;
  let versionEntered;
  const entered = new Promise((resolve) => { versionEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseVersion = resolve; });
  fixture.deps.versionService.prepare = async () => {
    versionEntered();
    await blocked;
    return { checkpointId: "checkpoint-1" };
  };
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await orchestrator.create(taskInput("task-transition-race"), { commandId: "create-transition-race" });
  await orchestrator.start("task-transition-race", { commandId: "start-transition-race" });
  await entered;
  await orchestrator.interrupt("task-transition-race", { commandId: "interrupt-transition-race" });
  await waitUntil(async () => (await orchestrator.getTask("task-transition-race")).status === "interrupting", "transition race interrupting");
  releaseVersion();
  await waitUntil(async () => (await orchestrator.getTask("task-transition-race")).status === "interrupted", "transition race interrupted");
  await fixture.runtime.waitForIdle();

  assert.equal((await orchestrator.getTask("task-transition-race")).status, "interrupted");
  assert.equal((await orchestrator.getCommand("task-transition-race", "start-transition-race")).status, "completed");
  assert.equal(fixture.transport.calls.length, 0);
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

  await assert.rejects(
    orchestrator.append("task-no-append", { commandId: "append-unavailable", prompt: "extra", sourceMessageId: "message-append-unavailable", conversationRunId: "conversation-run-append-unavailable" }),
    (error) => error.code === "AGENT_CAPABILITY_UNAVAILABLE",
  );
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

test("Codex 原生 thread 明确丢失时只重建一次完整交付并恢复旧 Skill pin", async () => {
  const fixture = dependencies({ adapterId: "codex" });
  fixture.transport.missingNativeOnce = "no rollout found for thread id thread-removed";
  const input = taskInput("task-native-rebind", "codex");
  const priorPin = { skillId: "cluster-guide", version: "2.0.0", sha256: "b".repeat(64) };
  await fixture.runtime.saveBinding(input.agentBindingId, {
    schemaVersion: 1,
    agentBindingId: input.agentBindingId,
    adapterId: "codex",
    route: copy(input.route),
    state: fixture.deps.adapters.codex.createState(),
    native: {
      threadId: "thread-removed",
      agentSource: "managed",
      runtimeBindingId: "binding:source-conversation:workspace-1",
      skillPins: [priorPin],
    },
    activeRunId: null,
    activeCommandId: null,
  });
  const orchestrator = new TaskOrchestrator(fixture.deps);
  await orchestrator.create(input, { commandId: "create-native-rebind" });
  await orchestrator.start(input.id, { commandId: "start-native-rebind" });
  await waitUntil(async () => (await orchestrator.getTask(input.id)).status === "running", "replacement native running");

  assert.equal(fixture.transport.calls.length, 2);
  assert.equal(fixture.transport.calls[0].descriptor.input.threadId, "thread-removed");
  assert.equal(fixture.transport.calls[1].descriptor.input.threadId, undefined);
  assert.equal(fixture.transport.calls[1].native.runtimeBindingId, "binding:source-conversation:workspace-1");
  assert.deepEqual(fixture.transport.calls[1].recoveredSkillPins, [priorPin]);
  assert.equal(fixture.rebindings.length, 1);
  assert.deepEqual((await fixture.runtime.loadBinding(input.agentBindingId)).native.skillPins, [priorPin]);

  fixture.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "rebuilt" }, sessionId: "native-session-1" });
  fixture.transport.queues[0].close();
  await fixture.runtime.waitForIdle();
  assert.equal((await orchestrator.getTask(input.id)).status, "completed");
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

test("Gateway 重启后只中断持久 native session，等待用户原文显式恢复", async () => {
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
  assert.equal(outcomes[0].action, "interrupted");
  assert.equal((await recovered.getTask("task-recovery")).status, "interrupted");
  assert.equal(second.transport.calls[0].operation, "interrupt");
  assert.equal(second.transport.calls[0].descriptor.input.sessionId, "native-session-1");
  assert.equal(Object.hasOwn(second.transport.calls[0].descriptor.input, "prompt"), false);

  const userPrompt = "  用户的新提问\n请原样发送  ";
  await recovered.resume("task-recovery", { commandId: "resume-after-restart", prompt: userPrompt, sourceMessageId: "message-resume-after-restart", conversationRunId: "conversation-run-resume-after-restart" });
  await waitUntil(async () => (await recovered.getCommand("task-recovery", "resume-after-restart"))?.status === "completed", "explicit resume completed");
  assert.equal((await recovered.getTask("task-recovery")).status, "running");
  assert.equal(second.transport.calls[1].operation, "resume");
  assert.equal(second.transport.calls[1].descriptor.input.sessionId, "native-session-1");
  assert.equal(second.transport.calls[1].descriptor.input.prompt, userPrompt);
  second.transport.queues[0].push({ kind: "final", phase: "completed", payload: { text: "recovered" }, sessionId: "native-session-1" });
  second.transport.queues[0].close();
  await waitUntil(async () => (await recovered.getTask("task-recovery")).status === "completed", "recovered task completed");
  first.transport.queues[0].close();
});

test("并发触发 Gateway 恢复时只发送一次原生 interrupt", async () => {
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
  assert.equal(second.transport.calls.filter((entry) => entry.operation === "interrupt").length, 1);
  assert.equal(second.transport.calls.filter((entry) => entry.operation === "resume").length, 0);
  assert.equal((await recovered.getTask("task-concurrent-recovery")).status, "interrupted");
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
