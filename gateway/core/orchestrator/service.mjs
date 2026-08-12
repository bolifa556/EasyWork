import crypto from "node:crypto";

import { invariant, redactSensitive } from "../errors.mjs";
import {
  canTransitionTask,
  createTask,
  TERMINAL_TASK_STATUSES,
  transitionTask,
  updateTaskRuntime,
  validateTask,
} from "../entities/task.mjs";
import {
  assertCommandId,
  assertOrchestratorDependencies,
  commandFingerprint,
  createCommandRecord,
  formatContextPrompt,
  isAsyncIterable,
  taskTopic,
} from "./contract.mjs";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function errorCode(error) {
  const value = String(error?.code || "ORCHESTRATOR_ERROR").replace(/[^A-Za-z0-9._:-]/g, "_");
  return RUN_ID_PATTERN.test(value) ? value : "ORCHESTRATOR_ERROR";
}

function failureFrom(error) {
  const message = redactSensitive(String(error?.message || "Task 执行失败")).slice(0, 16_384);
  return {
    code: errorCode(error),
    message,
    retryable: Boolean(error?.retryable),
  };
}

function normalizeRunId(value) {
  const id = String(value || "");
  invariant(RUN_ID_PATTERN.test(id), "TASK_TRANSPORT_RUN_ID_INVALID", "Transport 必须返回合法 runId", {
    status: 500,
    expose: false,
  });
  return id;
}

function normalizePlanStatus(value) {
  const status = String(value || "pending").toLowerCase();
  if (["in_progress", "active", "running"].includes(status)) return "running";
  if (["done", "complete", "completed", "success"].includes(status)) return "completed";
  if (["error", "failed"].includes(status)) return "failed";
  if (["cancelled", "canceled", "skipped"].includes(status)) return "skipped";
  return "pending";
}

function normalizedPlan(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    id: String(item?.id || index + 1),
    text: String(item?.text || "").slice(0, 8192),
    status: normalizePlanStatus(item?.status),
  })).filter((item) => item.text);
}

function adapterFromRegistry(registry, adapterId) {
  const adapter = registry instanceof Map ? registry.get(adapterId) : registry[adapterId];
  invariant(adapter && typeof adapter.reduce === "function" && typeof adapter.operation === "function" && typeof adapter.createState === "function", "TASK_AGENT_ADAPTER_NOT_FOUND", `未找到 Agent adapter: ${adapterId}`, {
    status: 409,
    details: { adapterId },
  });
  return adapter;
}

function nativeSessionId(binding) {
  return binding?.native?.sessionId || binding?.native?.threadId || binding?.state?.sessionId || null;
}

function operationInput(binding, input = {}) {
  const native = binding?.native || {};
  return {
    ...clone(input),
    ...(native.sessionId || binding?.state?.sessionId ? { sessionId: native.sessionId || binding.state.sessionId } : {}),
    ...(native.threadId || (binding?.adapterId === "codex" && binding?.state?.sessionId) ? { threadId: native.threadId || binding.state.sessionId } : {}),
    ...(native.turnId || binding?.state?.turnId ? { turnId: native.turnId || binding.state.turnId } : {}),
    ...(native.processId ? { processId: native.processId } : {}),
  };
}

export class TaskOrchestrator {
  #locks = new Map();
  #recoveryPromise = null;

  constructor(dependencies) {
    assertOrchestratorDependencies(dependencies);
    this.taskStore = dependencies.taskStore;
    this.runtime = dependencies.runtime;
    this.transport = dependencies.transport;
    this.contextHub = dependencies.contextHub;
    this.journal = dependencies.journal;
    this.workspaceService = dependencies.workspaceService;
    this.versionService = dependencies.versionService;
    this.artifactService = dependencies.artifactService;
    this.skillService = dependencies.skillService;
    this.reportService = dependencies.reportService;
    this.adapters = dependencies.adapters;
    this.taskFinalizer = typeof dependencies.taskFinalizer === "function" ? dependencies.taskFinalizer : null;
    this.clock = dependencies.clock || (() => new Date());
  }

  topicForTask(taskId) {
    return taskTopic(taskId);
  }

  async getTask(taskId) {
    const task = await this.taskStore.getTask(String(taskId));
    invariant(task, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
    validateTask(task);
    return clone(task);
  }

  async getCommand(taskId, commandId) {
    const record = await this.taskStore.getCommand(String(taskId), assertCommandId(commandId));
    return record ? clone(record) : null;
  }

  async recoverPending() {
    if (this.#recoveryPromise) return this.#recoveryPromise;
    const recovery = this.#recoverPendingOnce();
    this.#recoveryPromise = recovery;
    try {
      return await recovery;
    } finally {
      if (this.#recoveryPromise === recovery) this.#recoveryPromise = null;
    }
  }

  async #recoverPendingOnce() {
    const scanTasks = typeof this.taskStore.scanTasks === "function"
      ? (options) => this.taskStore.scanTasks(options)
      : (options) => this.taskStore.listTasks({ ...options, limit: 1000 });
    const nonterminal = await scanTasks({
      statuses: [
        "queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_append",
        "interrupting", "interrupted", "recovering", "finalizing",
      ],
    });
    const outcomes = [];
    for (const summary of [...nonterminal].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))) {
      let outcome;
      try {
        outcome = await this.#recoverOne(summary.id);
      } catch (error) {
        const task = await this.taskStore.getTask(summary.id);
        const failed = task && !TERMINAL_TASK_STATUSES.includes(task.status)
          ? await this.#failTask(summary.id, error, task.activeCommandId)
          : task;
        outcome = { taskId: summary.id, action: "failed", status: failed?.status || "failed", failure: failureFrom(error) };
      }
      await this.#closeStaleCommands(summary.id);
      outcomes.push(outcome);
    }
    const terminal = await scanTasks({ statuses: ["completed", "failed", "cancelled"] });
    for (const summary of terminal) {
      await this.#closeStaleCommands(summary.id);
      const task = await this.taskStore.getTask(summary.id);
      const existing = await this.reportService.get(task.id, { required: false });
      if (!existing) await this.reportService.generate({ task });
    }
    return outcomes;
  }

  async #recoverOne(taskId) {
    let task = await this.getTask(taskId);
    if (["queued", "interrupted"].includes(task.status)) {
      return { taskId, action: "stable", status: task.status };
    }
    if (["preparing", "delivering_context"].includes(task.status)) {
      const error = new Error("Gateway 重启时无法证明远端 Agent session 已建立，Task 已安全收口");
      error.code = "TASK_RECOVERY_SESSION_UNPROVABLE";
      task = await this.#failTask(taskId, error, task.activeCommandId);
      return { taskId, action: "failed", status: task.status, failure: task.failure };
    }
    if (["waiting_approval", "interrupting"].includes(task.status)) {
      if (task.status === "waiting_approval") {
        task = await this.#transition(taskId, "interrupting", { activeCommandId: null }, { source: "recovery", reason: "approval_state_lost" });
      }
      task = await this.#transition(taskId, "interrupted", { activeCommandId: null }, { source: "recovery", reason: "approval_state_lost" });
      return { taskId, action: "interrupted", status: task.status };
    }
    if (task.status === "finalizing") {
      try {
        await this.versionService.finalize({ task: clone(task) });
        if (typeof this.workspaceService.finalize === "function") await this.workspaceService.finalize({ task: clone(task) });
        task = await this.#transition(taskId, "completed", { activeCommandId: null }, { source: "recovery" });
        await this.reportService.generate({ task });
        return { taskId, action: "completed", status: task.status };
      } catch (error) {
        task = await this.#failTask(taskId, error, task.activeCommandId);
        return { taskId, action: "failed", status: task.status, failure: task.failure };
      }
    }
    invariant(["running", "waiting_append", "recovering"].includes(task.status), "TASK_RECOVERY_STATE_INVALID", `Task 状态不能恢复: ${task.status}`, { status: 409 });
    const commandId = `recovery_${crypto.createHash("sha256").update(`${task.id}:${task.taskEventSequence}`).digest("hex").slice(0, 32)}`;
    const fingerprint = commandFingerprint("resume", { taskId: task.id, prompt: "gateway-restart" });
    const record = createCommandRecord({ taskId: task.id, commandId, type: "resume", fingerprint, clock: this.clock });
    const claim = await this.taskStore.claimCommand(record);
    this.#assertClaim(claim, record);
    if (!claim.created && claim.record.status === "completed") return { taskId, action: "reattached", status: task.status };
    if (!claim.created && claim.record.status === "failed") {
      const error = new Error("此前的 Gateway 重启恢复已失败，Task 已安全收口");
      error.code = "TASK_RECOVERY_PREVIOUSLY_FAILED";
      task = await this.#failTask(taskId, error, task.activeCommandId);
      return { taskId, action: "failed", status: task.status, failure: task.failure };
    }
    await this.taskStore.updateCommand(task.id, commandId, { status: "running", updatedAt: this.clock().toISOString() });
    await this.#publishCommand(task.id, "resume", "running", { commandId, recovery: true });
    try {
      const result = await this.#reattachTask(task.id, commandId);
      await this.taskStore.updateCommand(task.id, commandId, {
        status: "completed",
        result,
        updatedAt: this.clock().toISOString(),
      });
      await this.#publishCommand(task.id, "resume", "completed", { commandId, recovery: true, result });
      return { taskId, action: "reattached", status: result.status, runId: result.runId };
    } catch (error) {
      const failure = failureFrom(error);
      const current = await this.taskStore.getCommand(task.id, commandId);
      if (current && ["accepted", "running"].includes(current.status)) {
        await this.taskStore.updateCommand(task.id, commandId, { status: "failed", failure, updatedAt: this.clock().toISOString() });
      }
      task = await this.#failTask(task.id, error, commandId);
      await this.#publishCommand(task.id, "resume", "failed", { commandId, recovery: true, failure });
      return { taskId, action: "failed", status: task.status, failure: task.failure };
    }
  }

  async #reattachTask(taskId, commandId) {
    let task = await this.getTask(taskId);
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    const binding = await this.runtime.loadBinding(task.agentBindingId);
    invariant(binding, "TASK_RECOVERY_BINDING_MISSING", "Gateway 重启后找不到 Agent binding", { status: 409 });
    invariant(nativeSessionId(binding), "TASK_RECOVERY_NATIVE_SESSION_MISSING", "Agent binding 没有可恢复的 native session", { status: 409 });
    invariant(adapter.capabilities?.resume?.availability === "available", "TASK_RECOVERY_CAPABILITY_UNAVAILABLE", `${adapter.id} 不支持恢复 native session`, { status: 409 });
    const workspace = await this.workspaceService.prepare({ task: clone(task), mode: "resume" });
    const prompt = "继续原会话中尚未完成的工作。先核对已经完成的状态，避免重复副作用，然后从中断处继续。";
    const descriptor = adapter.operation("resume", operationInput(binding, {
      prompt,
      ...(workspace?.path ? { cwd: workspace.path } : {}),
    }));
    if (task.status !== "recovering") {
      task = await this.#transition(taskId, "recovering", { activeCommandId: commandId }, { source: "recovery" });
    }
    const run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "resume", workspace });
    await this.#saveTransportBinding(task, adapter, binding, run, commandId);
    const runId = normalizeRunId(run.runId);
    task = await this.#transition(taskId, "running", { remoteRunId: runId, activeCommandId: commandId }, { source: "recovery" });
    await this.#launchFramePump({ taskId, adapter, run, delivery: null, acknowledged: true });
    return { taskId, runId, status: task.status, agentBindingId: binding.agentBindingId };
  }

  async #closeStaleCommands(taskId) {
    if (typeof this.taskStore.listCommands !== "function") return;
    const task = await this.taskStore.getTask(taskId);
    for (const command of await this.taskStore.listCommands(taskId)) {
      if (!["accepted", "running"].includes(command.status)) continue;
      const failure = {
        code: "TASK_COMMAND_GATEWAY_RESTARTED",
        message: `Gateway 重启前的 ${command.type} command 未能返回确定结果，Task 当前状态为 ${task?.status || "unknown"}`,
        retryable: false,
      };
      await this.taskStore.updateCommand(taskId, command.commandId, { status: "failed", failure, updatedAt: this.clock().toISOString() });
    }
  }

  async create(input, options = {}) {
    const commandId = assertCommandId(options.commandId || input?.idempotencyKey);
    const taskId = String(input?.id || "");
    const cleanInput = { ...clone(input), idempotencyKey: commandId };
    const fingerprint = commandFingerprint("create", cleanInput);
    const command = createCommandRecord({ taskId, commandId, type: "create", fingerprint, clock: this.clock });
    const claim = await this.taskStore.claimCommand(command);
    this.#assertClaim(claim, command);
    if (!claim.created) {
      const existingTask = await this.taskStore.getTask(taskId);
      return { task: existingTask ? clone(existingTask) : null, command: clone(claim.record), duplicate: true };
    }
    await this.taskStore.updateCommand(taskId, commandId, { status: "running", updatedAt: this.clock().toISOString() });
    try {
      const task = createTask(cleanInput, { clock: this.clock });
      await this.taskStore.createTask(task);
      await this.#publishTask(task, "status", "queued", { commandId, operation: "create" });
      const completed = await this.taskStore.updateCommand(taskId, commandId, {
        status: "completed",
        result: { taskId, revision: task.revision, status: task.status },
        updatedAt: this.clock().toISOString(),
      });
      return { task: clone(task), command: clone(completed), duplicate: false };
    } catch (error) {
      await this.taskStore.updateCommand(taskId, commandId, {
        status: "failed",
        failure: failureFrom(error),
        updatedAt: this.clock().toISOString(),
      });
      throw error;
    }
  }

  async start(taskId, options = {}) {
    return this.#submit("start", taskId, options, () => this.#startTask(String(taskId), options.commandId), {
      shouldFailTask: () => true,
    });
  }

  async append(taskId, options = {}) {
    invariant(typeof options.prompt === "string" && options.prompt.trim(), "TASK_APPEND_PROMPT_REQUIRED", "append 必须包含 prompt", { status: 400 });
    return this.#submit("append", taskId, options, () => this.#appendTask(String(taskId), options.commandId, options.prompt), {
      shouldFailTask: (task) => task.status === "waiting_append",
    });
  }

  async interrupt(taskId, options = {}) {
    return this.#submit("interrupt", taskId, options, () => this.#interruptTask(String(taskId), options.commandId), {
      shouldFailTask: (task) => task.status === "interrupting",
    });
  }

  async resume(taskId, options = {}) {
    invariant(typeof options.prompt === "string" && options.prompt.trim(), "TASK_RESUME_PROMPT_REQUIRED", "resume 必须包含 prompt", { status: 400 });
    return this.#submit("resume", taskId, options, () => this.#resumeTask(String(taskId), options.commandId, options.prompt), {
      shouldFailTask: (task) => task.status === "recovering",
    });
  }

  async #submit(type, taskIdValue, options, worker, policy) {
    const taskId = String(taskIdValue);
    const commandId = assertCommandId(options.commandId);
    const fingerprint = commandFingerprint(type, {
      taskId,
      ...(typeof options.prompt === "string" ? { prompt: options.prompt } : {}),
    });
    const record = createCommandRecord({ taskId, commandId, type, fingerprint, clock: this.clock });
    const claim = await this.taskStore.claimCommand(record);
    this.#assertClaim(claim, record);
    if (!claim.created) return { command: clone(claim.record), duplicate: true };
    await this.#publishCommand(taskId, type, "accepted", { commandId });
    try {
      await this.runtime.launch(`command:${taskId}:${commandId}`, async () => {
        await this.taskStore.updateCommand(taskId, commandId, { status: "running", updatedAt: this.clock().toISOString() });
        await this.#publishCommand(taskId, type, "running", { commandId });
        try {
          const result = await worker();
          await this.taskStore.updateCommand(taskId, commandId, {
            status: "completed",
            result: clone(result || {}),
            updatedAt: this.clock().toISOString(),
          });
          await this.#publishCommand(taskId, type, "completed", { commandId, result: clone(result || {}) });
        } catch (error) {
          const task = await this.taskStore.getTask(taskId);
          if (task && policy.shouldFailTask(task)) await this.#failTask(taskId, error, commandId);
          const failure = failureFrom(error);
          await this.taskStore.updateCommand(taskId, commandId, { status: "failed", failure, updatedAt: this.clock().toISOString() });
          await this.#publishCommand(taskId, type, "failed", { commandId, failure });
        }
      });
    } catch (error) {
      const failure = failureFrom(error);
      await this.taskStore.updateCommand(taskId, commandId, { status: "failed", failure, updatedAt: this.clock().toISOString() });
      await this.#publishCommand(taskId, type, "failed", { commandId, failure });
      throw error;
    }
    return { command: clone(record), duplicate: false };
  }

  #assertClaim(claim, expected) {
    invariant(claim && typeof claim.created === "boolean" && claim.record, "TASK_COMMAND_STORE_INVALID", "Task command store 返回值无效", {
      status: 500,
      expose: false,
    });
    invariant(claim.record.fingerprint === expected.fingerprint && claim.record.type === expected.type, "TASK_COMMAND_ID_REUSED", "commandId 已用于不同命令", {
      status: 409,
      details: { taskId: expected.taskId, commandId: expected.commandId },
    });
  }

  async #startTask(taskId, commandId) {
    let task = await this.getTask(taskId);
    invariant(task.status === "queued", "TASK_START_STATE_INVALID", `只有 queued Task 可以 start，当前为 ${task.status}`, { status: 409 });
    task = await this.#transition(taskId, "preparing", { activeCommandId: commandId }, { operation: "start", commandId });
    const workspace = await this.workspaceService.prepare({ task: clone(task), mode: "start" });
    const version = await this.versionService.prepare({ task: clone(task), workspace: clone(workspace), mode: "start" });
    const skills = await this.skillService.prepare({ task: clone(task), workspace: clone(workspace), pins: clone(task.skillPins) });
    task = await this.#transition(taskId, "delivering_context", {}, { operation: "start", commandId });
    const assembled = await this.contextHub.assemble(task.contextSessionId);
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    const delivery = await this.contextHub.deliveryForBinding(task.agentBindingId, assembled.delivery);
    const prompt = formatContextPrompt(delivery, task.goal);
    const descriptor = adapter.operation("start", operationInput(binding, {
      prompt,
      ...(workspace?.path ? { cwd: workspace.path } : {}),
    }));
    const run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "start", workspace, version, skills, delivery });
    binding = await this.#saveTransportBinding(task, adapter, binding, run, commandId);
    const runId = normalizeRunId(run.runId);
    task = await this.#transition(taskId, "running", { remoteRunId: runId, activeCommandId: commandId }, { operation: "start", commandId });
    let acknowledged = await this.#acknowledgeIfPossible(task, binding, delivery);
    await this.#launchFramePump({ taskId, adapter, run, delivery, acknowledged });
    return { taskId, runId, status: task.status, contextDeliveryId: delivery.id, acknowledged };
  }

  async #appendTask(taskId, commandId, prompt) {
    let task = await this.getTask(taskId);
    invariant(task.status === "running", "TASK_APPEND_STATE_INVALID", `只有 running Task 可以 append，当前为 ${task.status}`, { status: 409 });
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    const descriptor = adapter.operation("append", operationInput(binding, { prompt }));
    const previousCommandId = task.activeCommandId;
    task = await this.#transition(taskId, "waiting_append", { activeCommandId: commandId }, { operation: "append", commandId });
    const run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "append" });
    binding = await this.#saveTransportBinding(task, adapter, binding, run, previousCommandId);
    task = await this.#transition(taskId, "running", {
      remoteRunId: run.runId ? normalizeRunId(run.runId) : task.remoteRunId,
      activeCommandId: previousCommandId,
    }, { operation: "append", commandId });
    if (isAsyncIterable(run.frames)) await this.#launchFramePump({ taskId, adapter, run, delivery: null, acknowledged: true });
    return { taskId, runId: task.remoteRunId, status: task.status };
  }

  async #interruptTask(taskId, commandId) {
    let task = await this.getTask(taskId);
    invariant(["running", "waiting_approval", "waiting_append"].includes(task.status), "TASK_INTERRUPT_STATE_INVALID", `当前状态不能 interrupt: ${task.status}`, { status: 409 });
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    const descriptor = adapter.operation("interrupt", operationInput(binding));
    task = await this.#transition(taskId, "interrupting", { activeCommandId: commandId }, { operation: "interrupt", commandId });
    const run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "interrupt" });
    binding = await this.#saveTransportBinding(task, adapter, binding, run, null);
    task = await this.#transition(taskId, "interrupted", { activeCommandId: null }, { operation: "interrupt", commandId });
    return { taskId, runId: task.remoteRunId, status: task.status, agentBindingId: binding.agentBindingId };
  }

  async #resumeTask(taskId, commandId, prompt) {
    let task = await this.getTask(taskId);
    invariant(task.status === "interrupted", "TASK_RESUME_STATE_INVALID", `只有 interrupted Task 可以 resume，当前为 ${task.status}`, { status: 409 });
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    invariant(nativeSessionId(binding), "TASK_RESUME_BINDING_UNAVAILABLE", "原 Agent binding 没有可恢复的 native session", { status: 409 });
    const workspace = await this.workspaceService.prepare({ task: clone(task), mode: "resume" });
    const descriptor = adapter.operation("resume", operationInput(binding, {
      prompt,
      ...(workspace?.path ? { cwd: workspace.path } : {}),
    }));
    task = await this.#transition(taskId, "recovering", { activeCommandId: commandId }, { operation: "resume", commandId });
    const run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "resume", workspace });
    binding = await this.#saveTransportBinding(task, adapter, binding, run, commandId);
    const runId = normalizeRunId(run.runId);
    task = await this.#transition(taskId, "running", { remoteRunId: runId, activeCommandId: commandId }, { operation: "resume", commandId });
    await this.#launchFramePump({ taskId, adapter, run, delivery: null, acknowledged: true });
    return { taskId, runId, status: task.status, agentBindingId: binding.agentBindingId };
  }

  async #executeTransport(input) {
    const request = {
      ...input,
      adapterId: input.adapter.id,
      task: clone(input.task),
      binding: clone(input.binding),
      descriptor: clone(input.descriptor),
      workspace: clone(input.workspace),
      version: clone(input.version),
      skills: clone(input.skills),
      delivery: clone(input.delivery),
    };
    delete request.adapter;
    const result = await this.transport.execute(request);
    invariant(result && typeof result === "object", "TASK_TRANSPORT_RESULT_INVALID", "Transport 返回值无效", { status: 500, expose: false });
    if (["start", "resume"].includes(input.operation)) {
      normalizeRunId(result.runId);
      invariant(isAsyncIterable(result.frames), "TASK_TRANSPORT_STREAM_REQUIRED", `${input.operation} 必须返回 async frames`, { status: 500, expose: false });
    }
    return result;
  }

  async #loadBinding(task, adapter) {
    const existing = await this.runtime.loadBinding(task.agentBindingId);
    const binding = existing || {
      schemaVersion: 1,
      agentBindingId: task.agentBindingId,
      adapterId: adapter.id,
      state: adapter.createState(),
      native: {},
      activeRunId: null,
      activeCommandId: null,
    };
    invariant(binding.agentBindingId === task.agentBindingId && binding.adapterId === adapter.id, "TASK_AGENT_BINDING_MISMATCH", "Task 与 Agent binding 不一致", { status: 409 });
    invariant(binding.state?.adapterId === adapter.id, "TASK_AGENT_STATE_MISMATCH", "Agent binding state 不属于当前 adapter", { status: 409 });
    return clone(binding);
  }

  async #saveTransportBinding(task, adapter, binding, run, activeCommandId) {
    return this.#withLock(`binding:${task.agentBindingId}`, async () => {
      const current = await this.runtime.loadBinding(task.agentBindingId) || binding;
      const patch = clone(run.bindingPatch || {});
      const next = {
        ...current,
        ...patch,
        agentBindingId: task.agentBindingId,
        adapterId: adapter.id,
        state: patch.state || current.state,
        native: { ...(current.native || {}), ...(patch.native || {}) },
        activeRunId: run.runId || current.activeRunId,
        activeCommandId,
      };
      await this.runtime.saveBinding(task.agentBindingId, clone(next));
      return next;
    });
  }

  async #launchFramePump({ taskId, adapter, run, delivery, acknowledged }) {
    await this.runtime.launch(`run:${taskId}:${normalizeRunId(run.runId)}`, async () => {
      try {
        let sawFinal = false;
        let receiptAcknowledged = Boolean(acknowledged);
        for await (const frame of run.frames) {
          const beforeReduce = await this.getTask(taskId);
          if (["interrupting", "interrupted", ...TERMINAL_TASK_STATUSES].includes(beforeReduce.status)) break;
          const { events, binding } = await this.#reduceFrame(taskId, adapter, frame);
          if (!receiptAcknowledged && delivery) {
            const task = await this.getTask(taskId);
            receiptAcknowledged = await this.#acknowledgeIfPossible(task, binding, delivery);
          }
          invariant(!(delivery && !receiptAcknowledged && events.some((event) => event.kind === "final")), "CONTEXT_DELIVERY_UNACKNOWLEDGED", "Agent 在确认上下文投递前结束", {
            status: 500,
            expose: false,
          });
          const activeRun = await this.#isActiveRun(taskId, run.runId);
          for (const event of events) {
            await this.#handleAgentEvent(taskId, event, { activeRun });
            if (event.kind === "final") sawFinal = true;
          }
          const current = await this.getTask(taskId);
          if (["interrupting", "interrupted", ...TERMINAL_TASK_STATUSES].includes(current.status)) break;
        }
        const current = await this.getTask(taskId);
        const activeRun = await this.#isActiveRun(taskId, run.runId);
        if (!sawFinal && activeRun && !["interrupted", "interrupting", ...TERMINAL_TASK_STATUSES].includes(current.status)) {
          const error = new Error("Agent stream ended without final event");
          error.code = "AGENT_STREAM_ENDED_WITHOUT_FINAL";
          await this.#failTask(taskId, error, current.activeCommandId);
        }
      } catch (error) {
        const current = await this.taskStore.getTask(taskId);
        if (current && !["interrupted", "interrupting", ...TERMINAL_TASK_STATUSES].includes(current.status)) {
          await this.#failTask(taskId, error, current.activeCommandId);
        }
      }
    });
  }

  async #reduceFrame(taskId, adapter, rawFrame) {
    const task = await this.getTask(taskId);
    return this.#withLock(`binding:${task.agentBindingId}`, async () => {
      const binding = await this.#loadBinding(task, adapter);
      const reduced = adapter.reduce(binding.state, rawFrame);
      const nextBinding = {
        ...binding,
        state: reduced.state,
        native: {
          ...(binding.native || {}),
          ...(reduced.state.sessionId ? { sessionId: reduced.state.sessionId } : {}),
          ...(adapter.id === "codex" && reduced.state.sessionId ? { threadId: reduced.state.sessionId } : {}),
          ...(reduced.state.turnId ? { turnId: reduced.state.turnId } : {}),
        },
      };
      for (const event of reduced.events) await this.#publishAgentEvent(task, event);
      await this.runtime.saveBinding(task.agentBindingId, clone(nextBinding));
      return { events: reduced.events, binding: nextBinding };
    });
  }

  async #handleAgentEvent(taskId, event, options = {}) {
    if (event.kind === "plan") {
      const plan = normalizedPlan(event.payload.items);
      if (plan.length) await this.#updateRuntime(taskId, { plan });
    } else if (event.kind === "artifact") {
      const task = await this.getTask(taskId);
      const captured = await this.artifactService.capture({ task, event: clone(event) });
      const artifactId = captured?.artifact?.id;
      if (artifactId) await this.#addArtifact(taskId, String(artifactId));
    } else if (event.kind === "file_change") {
      const task = await this.getTask(taskId);
      await this.versionService.recordFileChange({ task, event: clone(event) });
    } else if (event.kind === "approval_request") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (task.status === "running") await this.#transition(taskId, "waiting_approval", {}, { source: "agent" });
    } else if (event.kind === "approval_response") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (task.status === "waiting_approval") await this.#transition(taskId, "running", {}, { source: "agent" });
    } else if (event.kind === "error") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (["interrupting", "interrupted"].includes(task.status)) return;
      const error = new Error(event.payload.message || "Agent failed");
      error.code = "AGENT_ERROR";
      await this.#failTask(taskId, error, task.activeCommandId);
    } else if (event.kind === "status" && event.phase === "cancelled") {
      if (!options.activeRun) return;
      await this.#cancelTask(taskId);
    } else if (event.kind === "final") {
      if (!options.activeRun) return;
      const completed = await this.#completeTask(taskId);
      let finalizer = null;
      if (completed?.status === "completed" && this.taskFinalizer) {
        try { finalizer = await this.taskFinalizer({ task: clone(completed), event: clone(event) }); } catch { /* memory extraction never changes Task outcome */ }
      }
      if (completed && TERMINAL_TASK_STATUSES.includes(completed.status)) {
        await this.reportService.generate({ task: clone(completed), finalEvent: clone(event), finalizer: clone(finalizer) });
      }
    }
  }

  async #completeTask(taskId) {
    let task = await this.getTask(taskId);
    if (TERMINAL_TASK_STATUSES.includes(task.status) || ["interrupting", "interrupted"].includes(task.status)) return task;
    invariant(["running", "waiting_append"].includes(task.status), "TASK_FINAL_STATE_INVALID", `当前状态不能完成 Task: ${task.status}`, { status: 409 });
    task = await this.#transition(taskId, "finalizing", { activeCommandId: null }, { source: "agent" });
    try {
      await this.versionService.finalize({ task: clone(task) });
      if (typeof this.workspaceService.finalize === "function") await this.workspaceService.finalize({ task: clone(task) });
      return await this.#transition(taskId, "completed", { activeCommandId: null }, { source: "agent" });
    } catch (error) {
      return this.#failTask(taskId, error, task.activeCommandId);
    }
  }

  async #failTask(taskId, error, commandId) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status) || !canTransitionTask(current.status, "failed")) return current;
      const next = transitionTask(current, "failed", {
        expectedRevision: current.revision,
        failure: failureFrom(error),
        activeCommandId: commandId ?? current.activeCommandId,
        clock: this.clock,
      });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "error", "failed", { commandId: commandId || null, failure: next.failure });
      await this.reportService.generate({ task: clone(next) }).catch(() => undefined);
      return next;
    });
  }

  async #cancelTask(taskId) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status) || !canTransitionTask(current.status, "cancelled")) return current;
      const next = transitionTask(current, "cancelled", { expectedRevision: current.revision, activeCommandId: null, clock: this.clock });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "status", "cancelled", { source: "agent" });
      await this.reportService.generate({ task: clone(next) }).catch(() => undefined);
      return next;
    });
  }

  async #transition(taskId, status, options = {}, payload = {}) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      invariant(current, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
      const next = transitionTask(current, status, { ...options, expectedRevision: current.revision, clock: this.clock });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "status", status, payload);
      return next;
    });
  }

  async #updateRuntime(taskId, changes) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status)) return current;
      const next = updateTaskRuntime(current, changes, { expectedRevision: current.revision, clock: this.clock });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      return next;
    });
  }

  async #addArtifact(taskId, artifactId) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status) || current.artifactIds.includes(artifactId)) return current;
      const next = updateTaskRuntime(current, { artifactIds: [...current.artifactIds, artifactId] }, { expectedRevision: current.revision, clock: this.clock });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      return next;
    });
  }

  async #acknowledgeIfPossible(task, binding, delivery) {
    const sessionId = nativeSessionId(binding);
    if (!sessionId) return false;
    await this.contextHub.acknowledge({ bindingKey: task.agentBindingId, nativeSessionId: sessionId, delivery });
    return true;
  }

  async #isActiveRun(taskId, runId) {
    const task = await this.taskStore.getTask(taskId);
    if (!task) return false;
    const binding = await this.runtime.loadBinding(task.agentBindingId);
    return Boolean(binding && binding.activeRunId === runId);
  }

  async #publishTask(task, kind, status, payload) {
    return this.journal.append(taskTopic(task.id), {
      producer: "task-orchestrator",
      kind,
      status,
      taskId: task.id,
      conversationId: task.conversationId,
      payload: {
        taskRevision: task.revision,
        taskEventSequence: task.taskEventSequence,
        ...clone(payload || {}),
      },
    });
  }

  async #publishCommand(taskId, operation, status, payload) {
    const task = await this.taskStore.getTask(taskId);
    return this.journal.append(taskTopic(taskId), {
      producer: "task-orchestrator",
      kind: "command",
      status,
      taskId,
      conversationId: task?.conversationId || null,
      payload: { operation, ...clone(payload || {}) },
    });
  }

  async #publishAgentEvent(task, event) {
    return this.journal.append(taskTopic(task.id), {
      producer: `agent:${event.producer.adapter}`,
      kind: event.kind,
      status: event.phase,
      taskId: task.id,
      conversationId: task.conversationId,
      payload: {
        agentSequence: event.sequence,
        source: clone(event.source),
        event: clone(event.payload),
      },
    });
  }

  async #withLock(key, callback) {
    const previous = this.#locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#locks.set(key, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (this.#locks.get(key) === current) this.#locks.delete(key);
    }
  }
}
