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
  const status = String(value || "pending").replace(/[\s_-]/g, "").toLowerCase();
  if (["inprogress", "active", "running"].includes(status)) return "running";
  if (["done", "complete", "completed", "success", "succeeded"].includes(status)) return "completed";
  if (["error", "failed", "failure"].includes(status)) return "failed";
  if (["cancelled", "canceled", "skipped", "deleted", "removed"].includes(status)) return "skipped";
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

function nativeSessionWasRemoved(error, adapterId) {
  const message = String(error?.message || "");
  if (!message) return false;
  if (adapterId === "codex") {
    // Codex app-server uses both forms.  thread/resume reports the rollout
    // wording when the paginated state row exists but its JSONL rollout does
    // not exist in this CODEX_HOME; other request processors use
    // "thread not found".  Both are positive proof that this store cannot
    // resume the bound native conversation.
    return /\b(?:thread\s+not\s+found|no\s+rollout\s+found\s+for\s+(?:thread|conversation)\s+id)\b/i.test(message);
  }
  if (adapterId === "opencode") return /\bsession\s+not\s+found\b/i.test(message);
  if (["claude-code", "qoder-cn"].includes(adapterId)) return /\b(?:session|conversation)\s+(?:was\s+)?not\s+found\b/i.test(message);
  return false;
}

function nativeSessionNeedsRebinding(error, adapterId) {
  return nativeSessionWasRemoved(error, adapterId)
    || (adapterId === "opencode" && error?.code === "AGENT_NATIVE_WORKSPACE_MOVE_UNAVAILABLE");
}

function operationInput(binding, input = {}) {
  const native = binding?.native || {};
  return {
    ...clone(input),
    ...(native.sessionId || binding?.state?.sessionId ? { sessionId: native.sessionId || binding.state.sessionId } : {}),
    ...(native.threadId || (binding?.adapterId === "codex" && binding?.state?.sessionId) ? { threadId: native.threadId || binding.state.sessionId } : {}),
    ...(native.turnId || binding?.state?.turnId ? { turnId: native.turnId || binding.state.turnId } : {}),
    ...(native.processId ? { processId: native.processId } : {}),
    ...(native.pendingFork ? { pendingFork: clone(native.pendingFork) } : {}),
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
    this.prompts = dependencies.prompts;
    this.submissionRecorder = dependencies.submissionRecorder || null;
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

  async monitorActiveRuns({ quietForMs = 120_000 } = {}) {
    const threshold = Math.max(10_000, Number(quietForMs) || 120_000);
    const now = this.clock().getTime();
    const tasks = await this.taskStore.scanTasks({ statuses: ["running", "waiting_approval", "waiting_input", "waiting_append", "recovering"] });
    const outcomes = [];
    for (const summary of tasks) {
      if (now - Date.parse(summary.updatedAt) < threshold) continue;
      const task = await this.getTask(summary.id);
      const binding = await this.runtime.loadBinding(task.agentBindingId);
      const runId = String(binding?.activeRunId || task.remoteRunId || "").trim();
      if (runId && this.runtime.isRunning(`run:${task.id}:${runId}`)) {
        outcomes.push({ taskId: task.id, status: task.status, running: true });
        continue;
      }
      const error = new Error("远端 Agent 已停止运行，EasyWork 没有收到最终回复；请检查服务器或重新发送本轮请求");
      error.code = "REMOTE_AGENT_NOT_RUNNING";
      error.retryable = true;
      const failure = failureFrom(error);
      await this.#publishTask(task, "error", "failed", { source: "watchdog", failure });
      const commandId = `watchdog_interrupt_${crypto.createHash("sha256").update(`${task.id}:${task.revision}`).digest("hex").slice(0, 32)}`;
      try {
        await this.interrupt(task.id, { commandId });
        outcomes.push({ taskId: task.id, status: task.status, running: false, failure });
      } catch (reason) {
        const failed = await this.#failTask(task.id, error, task.activeCommandId);
        outcomes.push({ taskId: task.id, status: failed?.status || "failed", running: false, failure: failureFrom(reason || error) });
      }
    }
    return outcomes;
  }

  async #recoverPendingOnce() {
    const nonterminal = await this.taskStore.scanTasks({
      statuses: [
        "queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append",
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
    const terminal = await this.taskStore.scanTasks({ statuses: ["completed", "failed", "cancelled"] });
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
    if (task.status === "interrupting") {
      task = await this.#settleInterruptedTask(taskId, { source: "recovery", reason: "gateway_restarted_during_interrupt" });
      return { taskId, action: "interrupted", status: task.status };
    }
    if (task.status === "finalizing") {
      const recoveredFinal = await this.reportService.recoverableFinal(task.id);
      if (recoveredFinal) {
        const adapterId = String(recoveredFinal.producer || "").replace(/^agent:/, "") || task.route.agentId;
        const event = {
          schemaVersion: 1,
          sequence: Math.max(1, Number(recoveredFinal.agentSequence || 0) + (recoveredFinal.explicit ? 0 : 1)),
          producer: { adapter: adapterId, protocol: "recovered-canonical-journal" },
          kind: "final",
          phase: "completed",
          source: { type: "recovery/final", ...(recoveredFinal.source || {}) },
          payload: { text: recoveredFinal.text },
        };
        if (!recoveredFinal.explicit) await this.#publishAgentEvent(task, event);
        task = await this.#completeRecoveredFinal(task.id, event);
        return { taskId, action: "completed", status: task.status, recoveredFinal: true };
      }
      try {
        task = await this.#finalizeVersionBoundary(task);
        task = await this.#transition(taskId, "completed", { activeCommandId: null }, { source: "recovery" });
        await this.reportService.generate({ task });
        return { taskId, action: "completed", status: task.status };
      } catch (error) {
        task = await this.#failTask(taskId, error, task.activeCommandId);
        return { taskId, action: "failed", status: task.status, failure: task.failure };
      }
    }
    invariant(["running", "waiting_approval", "waiting_input", "waiting_append", "recovering"].includes(task.status), "TASK_RECOVERY_STATE_INVALID", `Task 状态不能恢复: ${task.status}`, { status: 409 });
    const recoveredFinal = await this.reportService.recoverableFinal(task.id);
    if (recoveredFinal) {
      const adapterId = String(recoveredFinal.producer || "").replace(/^agent:/, "") || task.route.agentId;
      const event = {
        schemaVersion: 1,
        sequence: Math.max(1, Number(recoveredFinal.agentSequence || 0) + (recoveredFinal.explicit ? 0 : 1)),
        producer: { adapter: adapterId, protocol: "recovered-canonical-journal" },
        kind: "final",
        phase: "completed",
        source: { type: "recovery/final", ...(recoveredFinal.source || {}) },
        payload: { text: recoveredFinal.text },
      };
      if (!recoveredFinal.explicit) await this.#publishAgentEvent(task, event);
      task = await this.#completeRecoveredFinal(task.id, event);
      return { taskId, action: "completed", status: task.status, recoveredFinal: true };
    }
    const binding = await this.runtime.loadBinding(task.agentBindingId);
    invariant(binding, "TASK_RECOVERY_BINDING_MISSING", "Gateway 重启后找不到 Agent binding", { status: 409 });
    invariant(nativeSessionId(binding), "TASK_RECOVERY_NATIVE_SESSION_MISSING", "Agent binding 没有可中断的 native session", { status: 409 });
    const commandId = `recovery_interrupt_${crypto.createHash("sha256").update(`${task.id}:${task.taskEventSequence}`).digest("hex").slice(0, 32)}`;
    const fingerprint = commandFingerprint("interrupt", { taskId: task.id });
    const record = createCommandRecord({ taskId: task.id, commandId, type: "interrupt", fingerprint, clock: this.clock });
    const claim = await this.taskStore.claimCommand(record);
    this.#assertClaim(claim, record);
    if (!claim.created && claim.record.status === "completed") {
      task = await this.getTask(taskId);
      return { taskId, action: "interrupted", status: task.status };
    }
    if (!claim.created && claim.record.status === "failed") {
      const error = new Error("Gateway 重启后的原生中断此前已失败，Task 已安全收口");
      error.code = "TASK_RECOVERY_INTERRUPT_PREVIOUSLY_FAILED";
      task = await this.#failTask(taskId, error, task.activeCommandId);
      return { taskId, action: "failed", status: task.status, failure: task.failure };
    }
    await this.taskStore.updateCommand(task.id, commandId, { status: "running", updatedAt: this.clock().toISOString() });
    await this.#publishCommand(task.id, "interrupt", "running", { commandId, recovery: true });
    try {
      const result = await this.#interruptTask(task.id, commandId);
      await this.taskStore.updateCommand(task.id, commandId, {
        status: "completed",
        result,
        updatedAt: this.clock().toISOString(),
      });
      await this.#publishCommand(task.id, "interrupt", "completed", { commandId, recovery: true, result });
      return { taskId, action: "interrupted", status: result.status, ...(result.warning ? { warning: result.warning } : {}) };
    } catch (error) {
      const failure = failureFrom(error);
      const current = await this.taskStore.getCommand(task.id, commandId);
      if (current && ["accepted", "running"].includes(current.status)) {
        await this.taskStore.updateCommand(task.id, commandId, { status: "failed", failure, updatedAt: this.clock().toISOString() });
      }
      task = await this.#failTask(task.id, error, commandId);
      await this.#publishCommand(task.id, "interrupt", "failed", { commandId, recovery: true, failure });
      return { taskId, action: "failed", status: task.status, failure: task.failure };
    }
  }

  async #completeRecoveredFinal(taskId, event) {
    let task = await this.getTask(taskId);
    if (["waiting_approval", "waiting_input", "recovering"].includes(task.status)) {
      task = await this.#transition(taskId, "running", { activeCommandId: null }, { source: "recovery", reason: "terminal_agent_output_recovered" });
    }
    if (task.status !== "finalizing") {
      invariant(["running", "waiting_append"].includes(task.status), "TASK_RECOVERY_FINAL_STATE_INVALID", `Task 状态不能恢复 final: ${task.status}`, { status: 409 });
      task = await this.#transition(taskId, "finalizing", { activeCommandId: null }, { source: "recovery" });
    }
    // The canonical journal already proves that the Agent turn completed.
    // Version finalization reports its own auxiliary failure without rewriting
    // that completed answer into a failed conversation response.
    task = await this.#finalizeVersionBoundary(task);
    task = await this.#transition(taskId, "completed", { activeCommandId: null }, { source: "recovery" });
    let finalizer = null;
    if (this.taskFinalizer) {
      try { finalizer = await this.taskFinalizer({ task: clone(task), event: clone(event) }); } catch { /* extraction is derived */ }
    }
    await this.reportService.generate({ task: clone(task), finalEvent: clone(event), finalizer: clone(finalizer) });
    return task;
  }

  async #closeStaleCommands(taskId) {
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
      shouldFailTask: (task) => !["interrupting", "interrupted"].includes(task.status),
    });
  }

  async append(taskId, options = {}) {
    invariant(typeof options.prompt === "string" && options.prompt.trim(), "TASK_APPEND_PROMPT_REQUIRED", "append 必须包含 prompt", { status: 400 });
    const sourceMessageId = String(options.sourceMessageId || "");
    const conversationRunId = String(options.conversationRunId || "");
    invariant(sourceMessageId && conversationRunId, "TASK_CONVERSATION_TURN_REQUIRED", "append/resume 必须绑定当前网页消息与 run", { status: 400 });
    return this.#submit("append", taskId, options, (prepared, admission) => this.#appendTask(String(taskId), options.commandId, prepared, admission), {
      prepare: async () => {
        const task = await this.getTask(String(taskId));
        invariant(task.status === "running", "TASK_APPEND_STATE_INVALID", `只有 running Task 可以 append，当前为 ${task.status}`, { status: 409 });
        const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
        const binding = await this.#loadBinding(task, adapter);
        const descriptor = adapter.operation("append", operationInput(binding, {
          prompt: options.prompt,
          commandId: options.commandId,
        }));
        return { adapter, binding, descriptor };
      },
      admit: () => this.#reserveAppend(String(taskId), options.commandId, { sourceMessageId, conversationRunId }),
      shouldFailTask: (task) => task.status === "waiting_append",
    });
  }

  async interrupt(taskId, options = {}) {
    return this.#submit("interrupt", taskId, options, () => this.#interruptTask(String(taskId), options.commandId), {
      shouldFailTask: () => false,
    });
  }

  async resume(taskId, options = {}) {
    invariant(typeof options.prompt === "string" && options.prompt.trim(), "TASK_RESUME_PROMPT_REQUIRED", "resume 必须包含 prompt", { status: 400 });
    await this.#bindConversationTurn(taskId, options);
    return this.#submit("resume", taskId, options, () => this.#resumeTask(String(taskId), options.commandId, options.prompt), {
      shouldFailTask: (task) => task.status === "recovering",
    });
  }

  async respondApproval(taskId, options = {}) {
    invariant(typeof options.requestId === "string" && options.requestId.trim(), "TASK_APPROVAL_REQUEST_ID_REQUIRED", "审批响应缺少 requestId", { status: 400 });
    invariant(["approve", "approve_session", "reject"].includes(options.decision), "TASK_APPROVAL_DECISION_INVALID", "审批响应 decision 无效", { status: 400 });
    return this.#submit("respondApproval", taskId, options, () => this.#respondApprovalTask(String(taskId), options.commandId, options.requestId.trim(), options.decision), {
      shouldFailTask: () => false,
    });
  }

  async respondInput(taskId, options = {}) {
    invariant(typeof options.requestId === "string" && options.requestId.trim(), "TASK_INPUT_REQUEST_ID_REQUIRED", "用户输入响应缺少 requestId", { status: 400 });
    invariant(options.answers && typeof options.answers === "object" && !Array.isArray(options.answers), "TASK_INPUT_ANSWERS_REQUIRED", "用户输入响应缺少 answers", { status: 400 });
    return this.#submit("respondInput", taskId, options, () => this.#respondInputTask(String(taskId), options.commandId, options.requestId.trim(), options.answers), {
      shouldFailTask: () => false,
    });
  }

  async #submit(type, taskIdValue, options, worker, policy) {
    const taskId = String(taskIdValue);
    const commandId = assertCommandId(options.commandId);
    const fingerprint = commandFingerprint(type, {
      taskId,
      ...(typeof options.prompt === "string" ? { prompt: options.prompt } : {}),
      ...(typeof options.sourceMessageId === "string" ? { sourceMessageId: options.sourceMessageId } : {}),
      ...(typeof options.conversationRunId === "string" ? { conversationRunId: options.conversationRunId } : {}),
      ...(typeof options.requestId === "string" ? { requestId: options.requestId } : {}),
      ...(typeof options.decision === "string" ? { decision: options.decision } : {}),
      ...(options.answers && typeof options.answers === "object" ? { answers: options.answers } : {}),
    });
    const record = createCommandRecord({ taskId, commandId, type, fingerprint, clock: this.clock });
    const claim = await this.taskStore.claimCommand(record);
    this.#assertClaim(claim, record);
    if (!claim.created) return { command: clone(claim.record), duplicate: true };
    await this.#publishCommand(taskId, type, "accepted", { commandId });
    let prepared = null;
    let admission = null;
    try {
      if (typeof policy.prepare === "function") prepared = await policy.prepare();
      if (typeof policy.admit === "function") admission = await policy.admit(prepared);
    } catch (error) {
      const failure = failureFrom(error);
      await this.taskStore.updateCommand(taskId, commandId, { status: "failed", failure, updatedAt: this.clock().toISOString() });
      await this.#publishCommand(taskId, type, "failed", { commandId, failure });
      throw error;
    }
    try {
      await this.runtime.launch(`command:${taskId}:${commandId}`, async () => {
        await this.taskStore.updateCommand(taskId, commandId, { status: "running", updatedAt: this.clock().toISOString() });
        await this.#publishCommand(taskId, type, "running", { commandId });
        try {
          const result = await worker(prepared, admission);
          await this.taskStore.updateCommand(taskId, commandId, {
            status: "completed",
            result: clone(result || {}),
            updatedAt: this.clock().toISOString(),
          });
          await this.#publishCommand(taskId, type, "completed", { commandId, result: clone(result || {}) });
        } catch (error) {
          const task = await this.taskStore.getTask(taskId);
          const failure = failureFrom(error);
          if (task?.status === "interrupting" && type !== "interrupt") {
            // A startup/append worker can fail only after an accepted
            // interrupt (for example when an Agent readiness probe reaches
            // its timeout).  Leaving the Task in interrupting here makes the
            // composer spin forever even though no native turn was admitted.
            // Close the version boundary and publish the real warning.
            await this.#settleInterruptedTask(taskId, {
              operation: type,
              phase: "worker_failed_after_interrupt",
              warning: failure,
            });
          } else if (task && policy.shouldFailTask(task)) {
            await this.#failTask(taskId, error, commandId);
          }
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

  async #bindConversationTurn(taskIdValue, options) {
    const taskId = String(taskIdValue);
    const sourceMessageId = String(options.sourceMessageId || "");
    const conversationRunId = String(options.conversationRunId || "");
    invariant(sourceMessageId && conversationRunId, "TASK_CONVERSATION_TURN_REQUIRED", "append/resume 必须绑定当前网页消息与 run", { status: 400 });
    const task = await this.getTask(taskId);
    if (task.sourceMessageId === sourceMessageId && task.conversationRunId === conversationRunId) return task;
    return this.#updateRuntime(taskId, { sourceMessageId, conversationRunId });
  }

  async #reserveAppend(taskId, commandId, turn) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      invariant(current, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
      invariant(current.status === "running", "TASK_APPEND_STATE_INVALID", `只有 running Task 可以 append，当前为 ${current.status}`, { status: 409 });
      const previousCommandId = current.activeCommandId;
      const next = transitionTask(current, "waiting_append", {
        expectedRevision: current.revision,
        activeCommandId: commandId,
        sourceMessageId: turn.sourceMessageId,
        conversationRunId: turn.conversationRunId,
        clock: this.clock,
      });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "status", "waiting_append", { operation: "append", commandId });
      return { task: next, previousCommandId };
    });
  }

  async #startTask(taskId, commandId) {
    let task = await this.getTask(taskId);
    if (["interrupting", "interrupted"].includes(task.status)) return { taskId, runId: null, status: task.status, interrupted: true };
    invariant(task.status === "queued", "TASK_START_STATE_INVALID", `只有 queued Task 可以 start，当前为 ${task.status}`, { status: 409 });
    task = await this.#startupTransition(taskId, "preparing", { activeCommandId: commandId }, { operation: "start", commandId, phase: "workspace" });
    if (["interrupting", "interrupted"].includes(task.status)) return { taskId, runId: null, status: task.status, interrupted: true };
    const workspace = await this.workspaceService.prepare({ task: clone(task), mode: "start" });
    if (await this.#startupInterrupted(taskId, { task, workspace })) return { taskId, runId: null, status: "interrupted", interrupted: true };
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    await this.#publishTask(task, "status", "preparing", { operation: "start", commandId, phase: "parallel" });
    // None of these operations sends the user prompt or mutates the live
    // workspace. Run them together so control metadata does not serialize
    // Agent cold start, Skill materialization, or context assembly.
    const versionPromise = this.versionService.prepare({ task: clone(task), workspace: clone(workspace), mode: "start" });
    const skillsPromise = this.skillService.prepare({ task: clone(task), workspace: clone(workspace), pins: clone(task.skillPins) });
    const assembledPromise = this.contextHub.assemble(task.contextSessionId);
    const transportPreparationPromise = typeof this.transport.prepare === "function"
      ? this.transport.prepare({
          adapterId: adapter.id,
          operation: "prepare",
          task: clone(task),
          binding: clone(binding),
          workspace: clone(workspace),
        })
      : Promise.resolve(null);
    const [version, skills, assembled] = await Promise.all([
      versionPromise,
      skillsPromise,
      assembledPromise,
      transportPreparationPromise,
    ]);
    if (await this.#startupInterrupted(taskId, { task, workspace, version })) return { taskId, runId: null, status: "interrupted", interrupted: true };
    task = await this.#startupTransition(taskId, "delivering_context", {}, { operation: "start", commandId, phase: "context" });
    if (["interrupting", "interrupted"].includes(task.status)) return { taskId, runId: null, status: task.status, interrupted: true };
    if (await this.#startupInterrupted(taskId, { task, workspace, version })) return { taskId, runId: null, status: "interrupted", interrupted: true };
    let delivery = await this.contextHub.deliveryForBinding(task.agentBindingId, assembled.delivery, nativeSessionId(binding));
    let prompt = await this.prompts.remoteDelivery(delivery, task.goal);
    if (await this.#startupInterrupted(taskId, { task, workspace, version })) return { taskId, runId: null, status: "interrupted", interrupted: true };
    await this.#publishTask(task, "status", "delivering_context", { operation: "start", commandId, phase: "agent_start" });
    let startInput = {
      prompt,
      ...(workspace?.path ? { cwd: workspace.path } : {}),
    };
    const descriptor = adapter.operation("start", operationInput(binding, startInput));
    let run;
    let replaceBinding = false;
    try {
      // The webpage stage contains every semantic candidate selected this
      // turn.  Narrow its crash-recovery receipt to the entries that this
      // concrete native session will actually receive after budget and
      // per-session de-duplication have both run.
      await this.contextHub.stageDeliveredKnowledge({
        bindingKey: task.agentBindingId,
        taskId: task.id,
        delivery,
      });
      run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "start", workspace, version, skills, delivery });
    } catch (error) {
      if (nativeSessionId(binding) && nativeSessionNeedsRebinding(error, adapter.id)) {
        // The webpage binding can outlive an Agent's native history (for
        // example after a remote cleanup or when OpenCode rejects a move
        // across incompatible projects). Retry once with a fresh native
        // conversation and a full ContextHub delivery. This is recovery from
        // a verified unusable session, not a generic transport retry.
        delivery = await this.contextHub.deliveryForRebinding(task.agentBindingId, assembled.delivery);
        prompt = await this.prompts.remoteDelivery(delivery, task.goal);
        startInput = { prompt, ...(workspace?.path ? { cwd: workspace.path } : {}) };
        await this.contextHub.stageDeliveredKnowledge({
          bindingKey: task.agentBindingId,
          taskId: task.id,
          delivery,
        });
        ({ binding, run } = await this.#executeFreshStart({
          task,
          adapter,
          binding,
          startInput,
          workspace,
          version,
          skills,
          delivery,
          recoveredSkillPins: clone(binding.native?.skillPins || []),
        }));
        replaceBinding = true;
      } else {
        throw error;
      }
    }
    if (await this.#startupInterrupted(taskId, { task, adapter, binding, run })) {
      return { taskId, runId: run.runId || null, status: "interrupted", interrupted: true };
    }
    binding = await this.#saveTransportBinding(task, adapter, binding, run, commandId, { replaceBinding });
    const runId = normalizeRunId(run.runId);
    task = await this.#transition(taskId, "running", { remoteRunId: runId, activeCommandId: commandId }, { operation: "start", commandId });
    let acknowledged = await this.#acknowledgeIfPossible(task, binding, delivery);
    await this.#launchFramePump({ taskId, adapter, run, delivery, acknowledged });
    return { taskId, runId, status: task.status, contextDeliveryId: delivery.id, acknowledged };
  }

  async #appendTask(taskId, commandId, prepared, admission) {
    let task = admission.task;
    const { adapter, descriptor } = prepared;
    let { binding } = prepared;
    const previousCommandId = admission.previousCommandId;
    const run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "append" });
    const afterTransport = await this.getTask(taskId);
    if (afterTransport.status !== "waiting_append") {
      // Interrupt is allowed while a native append request is in flight.  A
      // late HTTP/RPC acknowledgement must never revive an interrupting,
      // interrupted or already-terminal Task by forcing it back to running.
      invariant(["interrupting", "interrupted", ...TERMINAL_TASK_STATUSES].includes(afterTransport.status), "TASK_APPEND_COMPLETION_STATE_INVALID", `append 完成时 Task 状态无效：${afterTransport.status}`, {
        status: 409,
        details: { taskId, status: afterTransport.status },
      });
      return {
        taskId,
        runId: afterTransport.remoteRunId,
        status: afterTransport.status,
        interrupted: ["interrupting", "interrupted"].includes(afterTransport.status),
      };
    }
    binding = await this.#saveTransportBinding(task, adapter, binding, run, previousCommandId);
    task = await this.#transition(taskId, "running", {
      remoteRunId: run.runId ? normalizeRunId(run.runId) : task.remoteRunId,
      activeCommandId: previousCommandId,
    }, { operation: "append", commandId });
    if (isAsyncIterable(run.frames)) await this.#launchFramePump({ taskId, adapter, run, delivery: null, acknowledged: true });
    return { taskId, runId: task.remoteRunId, status: task.status };
  }

  async #respondApprovalTask(taskId, commandId, requestId, decision) {
    let task = await this.getTask(taskId);
    invariant(task.status === "waiting_approval", "TASK_APPROVAL_STATE_INVALID", `只有 waiting_approval Task 可以响应审批，当前为 ${task.status}`, { status: 409 });
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    const pendingApproval = binding.state?.pendingApprovals?.[requestId];
    invariant(pendingApproval, "TASK_APPROVAL_NOT_FOUND", "当前 Agent 没有这条待处理审批", { status: 409, details: { requestId } });
    const descriptor = adapter.operation("respondApproval", operationInput(binding, { requestId, decision, pendingApproval }));
    const previousCommandId = task.activeCommandId;
    task = await this.#transition(taskId, "running", { activeCommandId: commandId }, { operation: "respondApproval", commandId, requestId });
    let run;
    try {
      run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "respondApproval" });
    } catch (error) {
      const current = await this.getTask(taskId);
      if (current.status === "running") await this.#transition(taskId, "waiting_approval", { activeCommandId: previousCommandId }, { operation: "respondApproval", commandId, requestId, retry: true });
      throw error;
    }
    binding = await this.#saveTransportBinding(task, adapter, binding, run, previousCommandId);
    binding = await this.#clearPendingApproval(binding, requestId);
    let current = await this.getTask(taskId);
    if (!TERMINAL_TASK_STATUSES.includes(current.status)) {
      if (Object.keys(binding?.state?.pendingApprovals || {}).length && current.status === "running") {
        current = await this.#transition(taskId, "waiting_approval", { activeCommandId: previousCommandId }, {
          operation: "respondApproval",
          commandId,
          remainingApprovals: Object.keys(binding.state.pendingApprovals).length,
        });
      } else {
        current = await this.#updateRuntime(taskId, { activeCommandId: previousCommandId });
      }
    }
    await this.#publishInteractionResponse(current, "approval_response", { requestId, decision });
    return { taskId, runId: current.remoteRunId, status: current.status, requestId, decision };
  }

  async #respondInputTask(taskId, commandId, requestId, answers) {
    let task = await this.getTask(taskId);
    invariant(task.status === "waiting_input", "TASK_INPUT_STATE_INVALID", `只有 waiting_input Task 可以提交回答，当前为 ${task.status}`, { status: 409 });
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    const pendingInput = binding.state?.pendingInputs?.[requestId];
    invariant(pendingInput, "TASK_INPUT_NOT_FOUND", "当前 Agent 没有这条待回答问题", { status: 409, details: { requestId } });
    const descriptor = adapter.operation("respondInput", operationInput(binding, { requestId, answers, pendingInput }));
    const previousCommandId = task.activeCommandId;
    task = await this.#transition(taskId, "running", { activeCommandId: commandId }, { operation: "respondInput", commandId, requestId });
    let run;
    try {
      run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "respondInput" });
    } catch (error) {
      const current = await this.getTask(taskId);
      if (current.status === "running") await this.#transition(taskId, "waiting_input", { activeCommandId: previousCommandId }, { operation: "respondInput", commandId, requestId, retry: true });
      throw error;
    }
    binding = await this.#saveTransportBinding(task, adapter, binding, run, previousCommandId);
    binding = await this.#clearPendingInput(binding, requestId);
    let current = await this.getTask(taskId);
    if (!TERMINAL_TASK_STATUSES.includes(current.status)) {
      if (Object.keys(binding?.state?.pendingInputs || {}).length && current.status === "running") {
        current = await this.#transition(taskId, "waiting_input", { activeCommandId: previousCommandId }, {
          operation: "respondInput",
          commandId,
          remainingInputs: Object.keys(binding.state.pendingInputs).length,
        });
      } else {
        current = await this.#updateRuntime(taskId, { activeCommandId: previousCommandId });
      }
    }
    await this.#publishInteractionResponse(current, "input_response", { requestId, answers: clone(answers) });
    return { taskId, runId: current.remoteRunId, status: current.status, requestId };
  }

  async #clearPendingApproval(binding, requestId) {
    return this.#withLock(`binding:${binding.agentBindingId}`, async () => {
      const current = await this.runtime.loadBinding(binding.agentBindingId);
      if (!current?.state?.pendingApprovals?.[requestId]) return current || binding;
      const state = clone(current.state);
      delete state.pendingApprovals[requestId];
      const next = { ...current, state };
      await this.runtime.saveBinding(binding.agentBindingId, next);
      return next;
    });
  }

  async #clearPendingInput(binding, requestId) {
    return this.#withLock(`binding:${binding.agentBindingId}`, async () => {
      const current = await this.runtime.loadBinding(binding.agentBindingId);
      if (!current?.state?.pendingInputs?.[requestId]) return current || binding;
      const state = clone(current.state);
      delete state.pendingInputs[requestId];
      const next = { ...current, state };
      await this.runtime.saveBinding(binding.agentBindingId, next);
      return next;
    });
  }

  async #interruptTask(taskId, commandId) {
    let task = await this.getTask(taskId);
    if (["interrupted", ...TERMINAL_TASK_STATUSES].includes(task.status)) return { taskId, runId: task.remoteRunId, status: task.status, duplicate: true };
    invariant(["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "recovering"].includes(task.status), "TASK_INTERRUPT_STATE_INVALID", `当前状态不能 interrupt: ${task.status}`, { status: 409 });
    if (["queued", "preparing", "delivering_context"].includes(task.status)) {
      const startupStatus = task.status;
      task = await this.#transition(taskId, "interrupting", { activeCommandId: commandId }, { operation: "interrupt", commandId, phase: "startup" });
      // A start worker that already owns workspace/version preparation must
      // close that exact boundary before `interrupted` becomes observable.
      // Publishing `interrupted` here would let the next user turn activate
      // the same workspace while the previous transaction is still closing.
      if (startupStatus !== "queued") {
        return { taskId, runId: null, status: task.status, startup: true };
      }
      task = await this.#settleInterruptedTask(taskId, { operation: "interrupt", commandId, phase: "startup" });
      return { taskId, runId: null, status: task.status, startup: true };
    }
    const adapter = adapterFromRegistry(this.adapters, task.route.agentId);
    let binding = await this.#loadBinding(task, adapter);
    const descriptor = adapter.operation("interrupt", operationInput(binding, { commandId }));
    const previousStatus = task.status;
    const previousCommandId = task.activeCommandId;
    task = await this.#transition(taskId, "interrupting", { activeCommandId: commandId }, { operation: "interrupt", commandId });
    let run;
    try {
      run = await this.#executeTransport({ task, adapter, binding, descriptor, operation: "interrupt" });
    } catch (error) {
      const current = await this.getTask(taskId);
      if (current.status === "interrupting") {
        await this.#transition(taskId, previousStatus, { activeCommandId: previousCommandId }, { operation: "interrupt", commandId, failure: failureFrom(error) });
      }
      if (TERMINAL_TASK_STATUSES.includes(current.status)) return { taskId, runId: current.remoteRunId, status: current.status };
      throw error;
    }
    binding = await this.#saveTransportBinding(task, adapter, binding, run, null);
    task = await this.#settleInterruptedTask(taskId, { operation: "interrupt", commandId });
    return { taskId, runId: task.remoteRunId, status: task.status, agentBindingId: binding.agentBindingId };
  }

  async #startupInterrupted(taskId, launched = null) {
    const current = await this.getTask(taskId);
    if (!["interrupting", "interrupted"].includes(current.status)) return false;
    if (launched?.run) {
      try {
        let binding = await this.#saveTransportBinding(launched.task, launched.adapter, launched.binding, launched.run, null);
        const descriptor = launched.adapter.operation("interrupt", operationInput(binding, {
          commandId: current.activeCommandId || `startup-${current.id}`,
        }));
        const stopped = await this.#executeTransport({
          task: launched.task,
          adapter: launched.adapter,
          binding,
          descriptor,
          operation: "interrupt",
        });
        binding = await this.#saveTransportBinding(launched.task, launched.adapter, binding, stopped, null);
      } catch (error) {
        await this.#publishTask(current, "error", "failed", {
          operation: "startup-interrupt-cleanup",
          failure: failureFrom(error),
        }).catch(() => undefined);
        await this.#transition(taskId, "running", {}, { operation: "interrupt", failure: failureFrom(error) });
        return false;
      }
    }
    // An interrupt can arrive after a slow startup phase (workspace/version/
    // skill/context preparation) but before the native process is launched.
    // Let that already-running start command observe the interrupt and finalize
    // with the exact startup resources it owns.  The interrupt command must not
    // finalize concurrently with incomplete startup state.
    if (!launched?.run && (launched?.workspace || launched?.version)) {
      if (current.status === "interrupting") {
        await this.#settleInterruptedTask(taskId, { operation: "interrupt", phase: "startup" });
      }
      return true;
    }
    if (current.status === "interrupting") {
      await this.#settleInterruptedTask(taskId, { operation: "interrupt", phase: "startup" });
    } else {
      await this.#finalizeVersionBoundary(current);
    }
    return true;
  }

  async #startupTransition(taskId, status, options = {}, payload = {}) {
    return this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      invariant(current, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
      if (["interrupting", "interrupted"].includes(current.status)) return current;
      const next = transitionTask(current, status, { ...options, expectedRevision: current.revision, clock: this.clock });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "status", status, payload);
      return next;
    });
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
      recoveredSkillPins: clone(input.recoveredSkillPins),
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

  #freshBinding(adapter, binding) {
    return {
      ...clone(binding),
      state: adapter.createState(),
      native: {
        ...(binding.native?.agentSource ? { agentSource: binding.native.agentSource } : {}),
        // A missing Codex thread invalidates the native conversation, not the
        // shared store selected for a Web branch.  Keep that store ownership
        // while creating the replacement thread so process CODEX_HOME,
        // persisted rolloutPath and GC references cannot diverge.
        ...(adapter.id === "codex" && binding.native?.runtimeBindingId
          ? { runtimeBindingId: binding.native.runtimeBindingId }
          : {}),
      },
      activeRunId: null,
      activeCommandId: binding.activeCommandId || null,
    };
  }

  async #executeFreshStart({ task, adapter, binding, startInput, workspace, version, skills, delivery, recoveredSkillPins = [] }) {
    const freshBinding = this.#freshBinding(adapter, binding);
    const descriptor = adapter.operation("start", operationInput(freshBinding, startInput));
    const executed = await this.#executeTransport({
      task,
      adapter,
      binding: freshBinding,
      descriptor,
      operation: "start",
      workspace,
      version,
      skills,
      recoveredSkillPins,
      delivery,
    });
    return {
      binding: freshBinding,
      run: executed,
    };
  }

  async #loadBinding(task, adapter) {
    const existing = await this.runtime.loadBinding(task.agentBindingId);
    const binding = existing || {
      schemaVersion: 1,
      agentBindingId: task.agentBindingId,
      adapterId: adapter.id,
      route: clone(task.route),
      state: adapter.createState(),
      native: {},
      activeRunId: null,
      activeCommandId: null,
    };
    invariant(binding.agentBindingId === task.agentBindingId && binding.adapterId === adapter.id, "TASK_AGENT_BINDING_MISMATCH", "Task 与 Agent binding 不一致", { status: 409 });
    invariant(binding.state?.adapterId === adapter.id, "TASK_AGENT_STATE_MISMATCH", "Agent binding state 不属于当前 adapter", { status: 409 });
    return clone(binding);
  }

  async #saveTransportBinding(task, adapter, binding, run, activeCommandId, options = {}) {
    return this.#withLock(`binding:${task.agentBindingId}`, async () => {
      const current = options.replaceBinding
        ? binding
        : await this.runtime.loadBinding(task.agentBindingId) || binding;
      const patch = clone(run.bindingPatch || {});
      const next = {
        ...current,
        ...patch,
        agentBindingId: task.agentBindingId,
        adapterId: adapter.id,
        route: clone(task.route),
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
        const failedArtifacts = new Set();
        let receiptAcknowledged = Boolean(acknowledged);
        for await (const frame of run.frames) {
          const beforeReduce = await this.#afterInterrupt(taskId);
          if (["interrupted", ...TERMINAL_TASK_STATUSES].includes(beforeReduce.status)) break;
          // A native append/resume installs a fresh run id on the same Agent
          // session.  The replaced stream can still flush an abort/error frame
          // after that swap; never let it mutate the new run's binding or
          // lifecycle.
          if (!(await this.#isActiveRun(taskId, run.runId))) break;
          const { events, binding, stale } = await this.#reduceFrame(taskId, adapter, frame, { runId: run.runId });
          if (stale) break;
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
            const settled = await this.#afterInterrupt(taskId);
            if (["interrupted", ...TERMINAL_TASK_STATUSES].includes(settled.status)) break;
            await this.#handleAgentEvent(taskId, event, { activeRun, runId: run.runId, failedArtifacts });
            if (event.kind === "final") sawFinal = true;
          }
          const current = await this.#afterInterrupt(taskId);
          if (["interrupting", "interrupted", ...TERMINAL_TASK_STATUSES].includes(current.status)) break;
        }
        const current = await this.#afterInterrupt(taskId);
        const activeRun = await this.#isActiveRun(taskId, run.runId);
        if (!sawFinal && activeRun && !["waiting_append", "interrupted", "interrupting", ...TERMINAL_TASK_STATUSES].includes(current.status)) {
          // A native stream ending is not a successful answer. Intermediate
          // assistant text may be a preamble ("I'll start...") or a summary
          // before an input request; promoting it to `final` hides protocol
          // loss and falsely completes the Task.
          const error = new Error("Agent stream ended without final event");
          error.code = "AGENT_STREAM_ENDED_WITHOUT_FINAL";
          await this.#failTask(taskId, error, current.activeCommandId, {
            expectedRunId: run.runId,
            suppressWhileAppend: true,
          });
        }
      } catch (error) {
        const current = await this.taskStore.getTask(taskId);
        if (current && !["interrupted", "interrupting", ...TERMINAL_TASK_STATUSES].includes(current.status)) {
          await this.#failTask(taskId, error, current.activeCommandId, {
            expectedRunId: run.runId,
            suppressWhileAppend: true,
          });
        }
      }
    });
  }

  async #reduceFrame(taskId, adapter, rawFrame, options = {}) {
    const task = await this.getTask(taskId);
    return this.#withLock(`binding:${task.agentBindingId}`, async () => {
      const binding = await this.#loadBinding(task, adapter);
      if (options.runId && binding.activeRunId && binding.activeRunId !== options.runId) {
        return { events: [], binding, stale: true };
      }
      const reduced = adapter.reduce(binding.state, rawFrame);
      const liveTask = await this.getTask(taskId);
      const suppressedAtAppendBoundary = liveTask.status === "waiting_append"
        && reduced.events.some((event) => event.kind === "error"
          || (event.kind === "status" && event.phase === "cancelled"));
      const events = reduced.events.filter((event) => !(liveTask.status === "waiting_append"
        && (event.kind === "error" || (event.kind === "status" && event.phase === "cancelled"))));
      const pendingFork = binding.native?.pendingFork || null;
      const observedSessionId = ["claude-code", "qoder-cn"].includes(adapter.id) && rawFrame?.session_id
        ? String(rawFrame.session_id)
        : null;
      if (pendingFork && observedSessionId) {
        invariant(observedSessionId === String(pendingFork.targetSessionId), "AGENT_NATIVE_FORK_SESSION_MISMATCH", `${adapter.id === "qoder-cn" ? "Qoder CN" : "Claude Code"} 原生分支返回了错误的 session id`, {
          status: 502,
          details: { expected: pendingFork.targetSessionId, actual: observedSessionId },
        });
      }
      const nextBinding = {
        ...binding,
        state: suppressedAtAppendBoundary
          ? { ...reduced.state, status: binding.state?.status || reduced.state.status }
          : reduced.state,
        native: {
          ...(binding.native || {}),
          ...(reduced.state.sessionId ? { sessionId: reduced.state.sessionId } : {}),
           ...(adapter.id === "codex" && reduced.state.sessionId ? { threadId: reduced.state.sessionId } : {}),
           ...(["claude-code", "qoder-cn"].includes(adapter.id) && rawFrame?.type === "easywork_native_boundary"
             ? { turnId: reduced.state.turnId || null }
             : reduced.state.turnId ? { turnId: reduced.state.turnId } : {}),
           ...(pendingFork && observedSessionId ? { pendingFork: null } : {}),
        },
      };
      // Native plan/Todo notifications update Task state, but are not Agent
      // activity rows. A compact task-level signal below refreshes the two
      // dedicated plan surfaces without journaling repeated "执行计划" blocks.
      for (const event of events) {
        if (!["plan", "artifact", "final"].includes(event.kind) && event.payload?.visibility !== "internal") await this.#publishAgentEvent(liveTask, event);
        if (event.kind === "tool_result" && ["updated", "completed", "failed"].includes(event.phase) && this.submissionRecorder) {
          try { await this.submissionRecorder({ task: liveTask, event, binding: nextBinding }); }
          catch (error) {
            // A bookkeeping failure must not interrupt a job that the remote
            // scheduler has already accepted or make the Agent resubmit it.
            console.error(JSON.stringify({ scope: "scheduler-submission-record", taskId: liveTask.id, code: errorCode(error) }));
          }
        }
      }
      await this.runtime.saveBinding(task.agentBindingId, clone(nextBinding));
      return { events, binding: nextBinding, stale: false };
    });
  }

  async #afterInterrupt(taskId) {
    let task = await this.getTask(taskId);
    // Keep the native reader attached until the interrupt has a confirmed
    // outcome. A rejected stop must not discard the remaining answer stream.
    while (task.status === "interrupting") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      task = await this.getTask(taskId);
    }
    return task;
  }

  async #handleAgentEvent(taskId, event, options = {}) {
    if (event.kind === "plan") {
      const plan = normalizedPlan(event.payload.items);
      const updated = await this.#updateRuntime(taskId, { plan });
      if (updated) await this.#publishTask(updated, "plan_state", "updated", { plan });
    } else if (event.kind === "artifact") {
      const task = await this.getTask(taskId);
      let captured;
      try { captured = await this.artifactService.capture({ task, event: clone(event) }); }
      catch (error) {
        options.failedArtifacts?.add(event.payload.path);
        await this.#publishAgentEvent(task, { ...event, phase: "failed", payload: { ...event.payload, failure: failureFrom(error) } });
        return;
      }
      const artifactId = captured?.artifact?.id;
      if (artifactId) {
        await this.#addArtifact(taskId, String(artifactId));
        await this.#publishAgentEvent(task, {
          ...event,
          payload: {
            ...clone(event.payload),
            artifactId: String(artifactId),
            artifact: clone(captured.artifact),
          },
        });
      }
    } else if (["file_change", "tool_call"].includes(event.kind)) {
      const task = await this.getTask(taskId);
      const version = await this.versionService.recordFileChange({ task, event: clone(event) });
      if (version?.beforeCheckpointId && task.versionCheckpointId !== version.beforeCheckpointId) {
        await this.#updateRuntime(taskId, { versionCheckpointId: version.beforeCheckpointId });
      }
    } else if (event.kind === "approval_request") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (task.status === "running") await this.#transition(taskId, "waiting_approval", {}, { source: "agent" });
    } else if (event.kind === "approval_response") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      const binding = task.agentBindingId ? await this.runtime.loadBinding(task.agentBindingId) : null;
      if (task.status === "waiting_approval" && !Object.keys(binding?.state?.pendingApprovals || {}).length) {
        await this.#transition(taskId, "running", {}, { source: "agent" });
      }
    } else if (event.kind === "input_request") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (task.status === "running") await this.#transition(taskId, "waiting_input", {}, { source: "agent" });
    } else if (event.kind === "input_response") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      const binding = task.agentBindingId ? await this.runtime.loadBinding(task.agentBindingId) : null;
      if (task.status === "waiting_input" && !Object.keys(binding?.state?.pendingInputs || {}).length) {
        await this.#transition(taskId, "running", {}, { source: "agent" });
      }
    } else if (event.kind === "error") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (["interrupting", "interrupted"].includes(task.status)) return;
      const error = new Error(event.payload.message || "Agent failed");
      error.code = "AGENT_ERROR";
      await this.#failTask(taskId, error, task.activeCommandId, {
        expectedRunId: options.runId,
        suppressWhileAppend: true,
      });
    } else if (event.kind === "status" && event.phase === "cancelled") {
      if (!options.activeRun) return;
      await this.#cancelTask(taskId, {
        expectedRunId: options.runId,
        suppressWhileAppend: true,
      });
    } else if (event.kind === "final") {
      if (!options.activeRun) return;
      const task = await this.getTask(taskId);
      if (options.failedArtifacts?.size) {
        const binding = await this.runtime.loadBinding(task.agentBindingId);
        const original = binding?.state?.items?.["easywork:linked-final"]?.original;
        if (original) event = { ...event, payload: { ...event.payload, text: original } };
      }
      await this.#publishAgentEvent(task, event);
      const completed = await this.#completeTask(taskId, { expectedRunId: options.runId });
      let finalizer = null;
      if (completed?.status === "completed" && this.taskFinalizer) {
        try { finalizer = await this.taskFinalizer({ task: clone(completed), event: clone(event) }); } catch { /* memory extraction never changes Task outcome */ }
      }
      if (completed && TERMINAL_TASK_STATUSES.includes(completed.status)) {
        await this.reportService.generate({ task: clone(completed), finalEvent: clone(event), finalizer: clone(finalizer) });
      }
    }
  }

  async #completeTask(taskId, options = {}) {
    const admission = await this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status) || ["interrupting", "interrupted", "waiting_append"].includes(current.status)) {
        return { task: current, admitted: false };
      }
      if (options.expectedRunId) {
        const binding = await this.runtime.loadBinding(current.agentBindingId);
        if (!binding || binding.activeRunId !== options.expectedRunId) return { task: current, admitted: false };
      }
      invariant(current.status === "running", "TASK_FINAL_STATE_INVALID", `当前状态不能完成 Task: ${current.status}`, { status: 409 });
      const next = transitionTask(current, "finalizing", {
        expectedRevision: current.revision,
        activeCommandId: null,
        clock: this.clock,
      });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "status", "finalizing", { source: "agent" });
      return { task: next, admitted: true };
    });
    let task = admission.task;
    if (!admission.admitted || !task) return task;
    // Version capture is an auxiliary boundary around a successful native
    // Agent turn. Report a capture failure inside Agent activity, but never
    // discard the Agent's final answer or rewrite the completed turn as failed.
    task = await this.#finalizeVersionBoundary(task);
    return this.#transition(taskId, "completed", { activeCommandId: null }, { source: "agent" });
  }

  async #finalizeVersionBoundary(task) {
    try {
      if (task.agentBindingId && this.transport.captureSkillSnapshot) {
        await this.#withLock(`binding:${task.agentBindingId}`, async () => {
          const binding = await this.runtime.loadBinding(task.agentBindingId);
          if (!binding || binding.native?.skillCheckpoints?.[task.id]) return;
          const snapshot = await this.transport.captureSkillSnapshot({ task: clone(task), binding: clone(binding) });
          if (snapshot) await this.runtime.saveBinding(task.agentBindingId, { ...binding, native: { ...binding.native, skillCheckpoints: { ...binding.native?.skillCheckpoints, [task.id]: snapshot } } });
        });
      }
    } catch (error) {
      await this.#publishTask(task, "error", "failed", {
        failure: failureFrom(error), operation: "skill-snapshot",
      }).catch(() => undefined);
    }
    try {
      const version = await this.versionService.finalize({ task: clone(task) });
      await this.workspaceService.finalize({ task: clone(task) });
      const checkpointId = version?.beforeCheckpointId || null;
      if (task.versionCheckpointId !== checkpointId) {
        return await this.#updateRuntime(task.id, { versionCheckpointId: checkpointId });
      }
    } catch (error) {
      if (!task.versionCheckpointId) {
        await this.versionService.abandon(task.id).catch(() => undefined);
      }
      await this.#publishTask(task, "error", "failed", {
        failure: failureFrom(error),
        operation: "version-finalize",
      }).catch(() => undefined);
    }
    return this.getTask(task.id);
  }

  async #settleInterruptedTask(taskId, payload = {}) {
    let task = await this.getTask(taskId);
    if (task.status === "interrupted") return task;
    invariant(task.status === "interrupting", "TASK_INTERRUPT_FINALIZE_STATE_INVALID", `Task 不能从 ${task.status} 完成中断收口`, {
      status: 409,
      details: { taskId, status: task.status },
    });
    // `interrupted` is a reusable native-session boundary: the Work lifecycle
    // may create the next Task as soon as it observes this state.  Therefore
    // the file transaction must be durable before the state is published.
    await this.#finalizeVersionBoundary(task);
    task = await this.getTask(taskId);
    if (task.status === "interrupted") return task;
    invariant(task.status === "interrupting", "TASK_INTERRUPT_FINALIZE_STATE_INVALID", `Task 在版本收口期间变为 ${task.status}`, {
      status: 409,
      details: { taskId, status: task.status },
    });
    return this.#transition(taskId, "interrupted", { activeCommandId: null }, payload);
  }

  async #failTask(taskId, error, commandId, options = {}) {
    let transitioned = false;
    const failed = await this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status) || !canTransitionTask(current.status, "failed")) return current;
      if (options.suppressWhileAppend && current.status === "waiting_append") return current;
      if (options.expectedRunId) {
        const binding = await this.runtime.loadBinding(current.agentBindingId);
        if (!binding || binding.activeRunId !== options.expectedRunId) return current;
      }
      const next = transitionTask(current, "failed", {
        expectedRevision: current.revision,
        failure: failureFrom(error),
        activeCommandId: commandId ?? current.activeCommandId,
        clock: this.clock,
      });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "error", "failed", { commandId: commandId || null, failure: next.failure });
      transitioned = true;
      return next;
    });
    if (!transitioned || !failed) return failed;
    const finalized = await this.#finalizeVersionBoundary(failed);
    await this.reportService.generate({ task: clone(finalized) }).catch(() => undefined);
    return finalized;
  }

  async #cancelTask(taskId, options = {}) {
    let transitioned = false;
    const cancelled = await this.#withLock(`task:${taskId}`, async () => {
      const current = await this.taskStore.getTask(taskId);
      if (!current || TERMINAL_TASK_STATUSES.includes(current.status) || !canTransitionTask(current.status, "cancelled")) return current;
      if (options.suppressWhileAppend && current.status === "waiting_append") return current;
      if (options.expectedRunId) {
        const binding = await this.runtime.loadBinding(current.agentBindingId);
        if (!binding || binding.activeRunId !== options.expectedRunId) return current;
      }
      const next = transitionTask(current, "cancelled", { expectedRevision: current.revision, activeCommandId: null, clock: this.clock });
      await this.taskStore.saveTask(next, { expectedRevision: current.revision });
      await this.#publishTask(next, "status", "cancelled", { source: "agent" });
      transitioned = true;
      return next;
    });
    if (!transitioned || !cancelled) return cancelled;
    const finalized = await this.#finalizeVersionBoundary(cancelled);
    await this.reportService.generate({ task: clone(finalized) }).catch(() => undefined);
    return finalized;
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
      if (!current) return current;
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
      ids: {
        taskId: task.id,
        conversationId: task.conversationId,
        sourceMessageId: task.sourceMessageId,
        runId: task.conversationRunId,
      },
      payload: {
        taskRevision: task.revision,
        taskEventSequence: task.taskEventSequence,
        ...clone(payload || {}),
      },
    });
  }

  async #publishCommand(taskId, operation, status, payload) {
    const task = await this.taskStore.getTask(taskId);
    invariant(task, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
    return this.journal.append(taskTopic(taskId), {
      producer: "task-orchestrator",
      kind: "command",
      status,
      ids: {
        taskId,
        conversationId: task.conversationId,
        sourceMessageId: task.sourceMessageId,
        runId: task.conversationRunId,
      },
      payload: { operation, ...clone(payload || {}) },
    });
  }

  async #publishInteractionResponse(task, kind, payload) {
    return this.journal.append(taskTopic(task.id), {
      producer: "task-orchestrator",
      kind,
      status: "completed",
      ids: {
        taskId: task.id,
        conversationId: task.conversationId,
        sourceMessageId: task.sourceMessageId,
        runId: task.conversationRunId,
      },
      payload: {
        source: { type: "task-orchestrator", requestId: String(payload.requestId || "") },
        event: clone(payload),
      },
    });
  }

  async #publishAgentEvent(task, event) {
    return this.journal.append(taskTopic(task.id), {
      producer: `agent:${event.producer.adapter}`,
      kind: event.kind,
      status: event.phase,
      ids: {
        taskId: task.id,
        conversationId: task.conversationId,
        sourceMessageId: task.sourceMessageId,
        runId: task.conversationRunId,
      },
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
