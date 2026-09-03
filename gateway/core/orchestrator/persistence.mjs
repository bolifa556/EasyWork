import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertNoSensitiveFields, invariant } from "../errors.mjs";
import { resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { TASK_COMMAND_STATUSES, TASK_COMMAND_TYPES, assertCommandId } from "./contract.mjs";
import { TASK_STATUSES, validateTask } from "../entities/task.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const COMMAND_TRANSITIONS = Object.freeze({
  accepted: ["running", "failed"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
});

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function assertId(value, field) {
  const id = String(value || "");
  invariant(ID_PATTERN.test(id), "TASK_STORE_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return id;
}

function commandFileStem(commandId) {
  return crypto.createHash("sha256").update(commandId).digest("hex");
}

function validateCommand(record, taskId, commandId) {
  invariant(record && typeof record === "object" && !Array.isArray(record), "TASK_COMMAND_INVALID", "Task command 无效", { status: 500, expose: false });
  invariant(Object.keys(record).every((key) => [
    "schemaVersion", "taskId", "commandId", "type", "fingerprint", "status", "result", "failure", "createdAt", "updatedAt",
  ].includes(key)), "TASK_COMMAND_INVALID", "Task command 包含未知字段", { status: 500, expose: false });
  invariant(record.schemaVersion === 1 && record.taskId === taskId && record.commandId === commandId, "TASK_COMMAND_INVALID", "Task command 标识无效", { status: 500, expose: false });
  invariant(TASK_COMMAND_TYPES.includes(record.type) && TASK_COMMAND_STATUSES.includes(record.status), "TASK_COMMAND_INVALID", "Task command 类型或状态无效", { status: 500, expose: false });
  invariant(/^[a-f0-9]{64}$/.test(record.fingerprint), "TASK_COMMAND_INVALID", "Task command fingerprint 无效", { status: 500, expose: false });
  assertNoSensitiveFields(record);
  return true;
}

function taskSummary(task) {
  return {
    id: task.id,
    conversationId: task.conversationId,
    branchId: task.branchId,
    sourceMessageId: task.sourceMessageId,
    conversationRunId: task.conversationRunId,
    goal: task.goal,
    status: task.status,
    route: clone(task.route),
    agentBindingId: task.agentBindingId,
    taskEventSequence: task.taskEventSequence,
    plan: clone(task.plan),
    failure: clone(task.failure),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    revision: task.revision,
  };
}

const TASK_SUMMARY_KEYS = Object.freeze([
  "id", "conversationId", "branchId", "sourceMessageId", "conversationRunId", "goal", "status", "route", "agentBindingId", "taskEventSequence",
  "plan", "failure", "createdAt", "updatedAt", "startedAt", "completedAt", "revision",
]);

function validateTaskSummary(summary, id) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  const keys = Object.keys(summary);
  if (keys.length !== TASK_SUMMARY_KEYS.length || keys.some((key) => !TASK_SUMMARY_KEYS.includes(key))) return false;
  return summary.id === id
    && ID_PATTERN.test(id)
    && ID_PATTERN.test(String(summary.conversationId || ""))
    && ID_PATTERN.test(String(summary.branchId || ""))
    && ID_PATTERN.test(String(summary.sourceMessageId || ""))
    && ID_PATTERN.test(String(summary.conversationRunId || ""))
    && typeof summary.goal === "string"
    && TASK_STATUSES.includes(summary.status)
    && summary.route && typeof summary.route === "object" && !Array.isArray(summary.route)
    && ID_PATTERN.test(String(summary.agentBindingId || ""))
    && Number.isSafeInteger(summary.taskEventSequence) && summary.taskEventSequence >= 0
    && Array.isArray(summary.plan)
    && (summary.failure === null || (typeof summary.failure === "object" && !Array.isArray(summary.failure)))
    && typeof summary.createdAt === "string"
    && typeof summary.updatedAt === "string"
    && (summary.startedAt === null || typeof summary.startedAt === "string")
    && (summary.completedAt === null || typeof summary.completedAt === "string")
    && Number.isSafeInteger(summary.revision) && summary.revision >= 0;
}

function validateIndex(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.tasks || typeof data.tasks !== "object" || Array.isArray(data.tasks)) return false;
  return Object.entries(data.tasks).every(([id, summary]) => validateTaskSummary(summary, id));
}

export class FileTaskStore {
  constructor({ dataRoot, actor, queue, clock }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
  }

  #taskRepository(taskId) {
    const id = assertId(taskId, "taskId");
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["tasks", id, "task.json"],
      schemaVersion: 1,
      defaultData: () => ({ task: null }),
      validate: (data) => Boolean(data && Object.keys(data).length === 1 && (data.task === null || (validateTask(data.task) && data.task.id === id && data.task.actorId === this.actor.actorId))),
      queue: this.queue,
    });
  }

  #commandRepository(taskId, commandId) {
    const task = assertId(taskId, "taskId");
    const command = assertCommandId(commandId);
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["tasks", task, "commands", `${commandFileStem(command)}.json`],
      schemaVersion: 1,
      defaultData: () => ({ command: null }),
      validate: (data) => Boolean(data && Object.keys(data).length === 1 && (data.command === null || validateCommand(data.command, task, command))),
      queue: this.queue,
    });
  }

  #indexRepository() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["tasks", "index.json"],
      schemaVersion: 1,
      defaultData: () => ({ tasks: {} }),
      validate: validateIndex,
      queue: this.queue,
    });
  }

  async #updateIndex(task) {
    const repository = this.#indexRepository();
    for (;;) {
      const current = await repository.read();
      try {
        await repository.update((data) => { data.tasks[task.id] = taskSummary(task); }, { expectedRevision: current.revision, clock: this.clock });
        return;
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async claimCommand(record) {
    const repository = this.#commandRepository(record.taskId, record.commandId);
    for (;;) {
      const current = await repository.read();
      if (current.data.command) return { created: false, record: clone(current.data.command) };
      try {
        const stored = await repository.replace({ command: clone(record) }, { expectedRevision: current.revision, clock: this.clock });
        return { created: true, record: clone(stored.data.command) };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async getCommand(taskId, commandId) {
    return clone((await this.#commandRepository(taskId, commandId).read()).data.command);
  }

  async listCommands(taskId) {
    const task = assertId(taskId, "taskId");
    const directory = resolveActorPath(this.dataRoot, this.actor, "tasks", task, "commands");
    let names;
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry)).sort()) {
      let envelope;
      try {
        envelope = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
      } catch (error) {
        invariant(false, "TASK_COMMAND_STORE_CORRUPT", "Task command 文件损坏", { status: 500, expose: false, cause: error });
      }
      const command = envelope?.data?.command;
      invariant(command && COMMAND_ID_PATTERN.test(command.commandId) && commandFileStem(command.commandId) === path.basename(name, ".json"), "TASK_COMMAND_STORE_CORRUPT", "Task command 文件标识无效", { status: 500, expose: false });
      validateCommand(command, task, command.commandId);
      records.push(clone(command));
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.commandId.localeCompare(right.commandId));
  }

  async updateCommand(taskId, commandId, changes) {
    const repository = this.#commandRepository(taskId, commandId);
    for (;;) {
      const current = await repository.read();
      const command = current.data.command;
      invariant(command, "TASK_COMMAND_NOT_FOUND", "Task command 不存在", { status: 404 });
      const nextStatus = changes.status === undefined ? command.status : String(changes.status);
      invariant(nextStatus === command.status || COMMAND_TRANSITIONS[command.status].includes(nextStatus), "TASK_COMMAND_TRANSITION_INVALID", `Task command 不能从 ${command.status} 转为 ${nextStatus}`, { status: 409 });
      const next = { ...clone(command), ...clone(changes), status: nextStatus };
      validateCommand(next, command.taskId, command.commandId);
      try {
        const stored = await repository.replace({ command: next }, { expectedRevision: current.revision, clock: this.clock });
        return clone(stored.data.command);
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async createTask(task) {
    validateTask(task);
    invariant(task.actorId === this.actor.actorId, "TASK_ACTOR_MISMATCH", "Task 不属于当前 Actor", { status: 403 });
    const repository = this.#taskRepository(task.id);
    const current = await repository.read();
    invariant(current.data.task === null, "TASK_EXISTS", "Task 已存在", { status: 409 });
    const stored = await repository.replace({ task: clone(task) }, { expectedRevision: current.revision, clock: this.clock });
    await this.#updateIndex(task);
    return clone(stored.data.task);
  }

  async getTask(taskId) {
    return clone((await this.#taskRepository(taskId).read()).data.task);
  }

  async saveTask(task, options = {}) {
    validateTask(task);
    invariant(task.actorId === this.actor.actorId, "TASK_ACTOR_MISMATCH", "Task 不属于当前 Actor", { status: 403 });
    const repository = this.#taskRepository(task.id);
    const current = await repository.read();
    invariant(current.data.task, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
    invariant(current.data.task.revision === options.expectedRevision && task.revision === options.expectedRevision + 1, "TASK_REVISION_CONFLICT", "Task revision 与存储状态不一致", {
      status: 409,
      details: { expectedRevision: options.expectedRevision, actualRevision: current.data.task.revision, nextRevision: task.revision },
    });
    const stored = await repository.replace({ task: clone(task) }, { expectedRevision: current.revision, clock: this.clock });
    await this.#updateIndex(task);
    return clone(stored.data.task);
  }

  async listTasks(options = {}) {
    const limit = Number(options.limit ?? 100);
    invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, "TASK_LIST_LIMIT_INVALID", "Task list limit 无效", { status: 400 });
    return (await this.scanTasks(options)).slice(0, limit);
  }

  async scanTasks(options = {}) {
    const state = await this.#indexRepository().read();
    const statuses = options.statuses ? new Set(options.statuses.map(String)) : null;
    const conversationId = options.conversationId ? String(options.conversationId) : null;
    const indexed = Object.values(state.data.tasks)
      .filter((task) => (!statuses || statuses.has(task.status)) && (!conversationId || task.conversationId === conversationId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    return indexed.map(clone);
  }
}

function validateBinding(data, bindingId) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.hasOwn(data, "binding")) return false;
  if (data.binding === null) return true;
  return data.binding.agentBindingId === bindingId && typeof data.binding.adapterId === "string" && data.binding.state && typeof data.binding.state === "object";
}

export class DetachedTaskRuntime {
  #jobs = new Map();

  constructor({ dataRoot, actor, queue, clock }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
  }

  #bindingRepository(bindingId) {
    const id = assertId(bindingId, "agentBindingId");
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["runtime", "agent-bindings", `${id}.json`],
      schemaVersion: 1,
      defaultData: () => ({ binding: null }),
      validate: (data) => validateBinding(data, id),
      queue: this.queue,
    });
  }

  async launch(keyValue, worker) {
    const key = assertId(keyValue, "runtime job key");
    invariant(typeof worker === "function", "TASK_RUNTIME_WORKER_INVALID", "Runtime worker 无效", { status: 500, expose: false });
    const existing = this.#jobs.get(key);
    if (existing) return { accepted: false, key, promise: existing };
    const promise = Promise.resolve().then(worker);
    this.#jobs.set(key, promise);
    promise.finally(() => {
      if (this.#jobs.get(key) === promise) this.#jobs.delete(key);
    }).catch(() => undefined);
    promise.catch(() => undefined);
    return { accepted: true, key, promise };
  }

  async loadBinding(bindingId) {
    return clone((await this.#bindingRepository(bindingId).read()).data.binding);
  }

  async saveBinding(bindingId, binding) {
    assertNoSensitiveFields(binding);
    const repository = this.#bindingRepository(bindingId);
    for (;;) {
      const current = await repository.read();
      try {
        const stored = await repository.replace({ binding: clone(binding) }, { expectedRevision: current.revision, clock: this.clock });
        return clone(stored.data.binding);
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async clearBindings(bindingIds) {
    const ids = [...new Set((Array.isArray(bindingIds) ? bindingIds : []).map(String).filter(Boolean))];
    for (const id of ids) {
      const repository = this.#bindingRepository(id);
      for (;;) {
        const current = await repository.read();
        if (current.data.binding === null) break;
        try {
          await repository.replace({ binding: null }, { expectedRevision: current.revision, clock: this.clock });
          break;
        } catch (error) {
          if (error?.code !== "REVISION_CONFLICT") throw error;
        }
      }
    }
    return { cleared: ids.length };
  }

  isRunning(key) {
    return this.#jobs.has(String(key));
  }

  activeKeys() {
    return [...this.#jobs.keys()];
  }

  async waitForKeys(keys) {
    const requested = new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean));
    for (;;) {
      const pending = [...requested].map((key) => this.#jobs.get(key)).filter(Boolean);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  async waitForIdle() {
    while (this.#jobs.size) await Promise.allSettled([...this.#jobs.values()]);
  }
}

const WEB_RUN_STATUSES = new Set(["running", "completed", "failed"]);

function webRunFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function validateWebRun(record, actorId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const keys = [
    "schemaVersion", "runId", "actorId", "fingerprint", "input", "status", "assistantMessageId", "taskIds",
    "result", "failure", "createdAt", "updatedAt",
  ];
  if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) return false;
  if (record.schemaVersion !== 1 || record.actorId !== actorId || !ID_PATTERN.test(record.runId) || !/^[a-f0-9]{64}$/.test(record.fingerprint)) return false;
  if (!record.input || typeof record.input !== "object" || Array.isArray(record.input) || !WEB_RUN_STATUSES.has(record.status)) return false;
  if (record.assistantMessageId !== null && !ID_PATTERN.test(record.assistantMessageId)) return false;
  if (!Array.isArray(record.taskIds) || record.taskIds.some((id) => !ID_PATTERN.test(id))) return false;
  if (record.result !== null && (typeof record.result !== "object" || Array.isArray(record.result))) return false;
  if (record.failure !== null && (typeof record.failure !== "object" || Array.isArray(record.failure))) return false;
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) return false;
  try { assertNoSensitiveFields(record); } catch { return false; }
  return true;
}

function validateWebRunStore(data, actorId) {
  return Boolean(data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 1
    && data.runs && typeof data.runs === "object" && !Array.isArray(data.runs)
    && Object.entries(data.runs).every(([id, record]) => id === record?.runId && validateWebRun(record, actorId)));
}

export class PersistentWebInteractionStore {
  constructor({ dataRoot, actor, queue, clock }) {
    this.actor = actor;
    this.clock = clock || (() => new Date());
    this.repository = new AtomicJsonRepository({
      dataRoot,
      actor,
      relativePath: ["runtime", "web-interactions", "state.json"],
      schemaVersion: 1,
      defaultData: () => ({ runs: {} }),
      validate: (data) => validateWebRunStore(data, actor.actorId),
      queue,
    });
  }

  async claim(runId, input) {
    const id = assertId(runId, "web run id");
    const cleanInput = clone(input);
    assertNoSensitiveFields(cleanInput);
    const fingerprint = webRunFingerprint(cleanInput);
    for (;;) {
      const current = await this.repository.read();
      const existing = current.data.runs[id];
      if (existing) {
        invariant(existing.fingerprint === fingerprint, "WEB_RUN_ID_REUSED", "网页 Agent runId 已用于不同输入", { status: 409 });
        return { created: false, record: clone(existing) };
      }
      const now = this.clock().toISOString();
      const record = {
        schemaVersion: 1,
        runId: id,
        actorId: this.actor.actorId,
        fingerprint,
        input: cleanInput,
        status: "running",
        assistantMessageId: null,
        taskIds: [],
        result: null,
        failure: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const stored = await this.repository.update((data) => { data.runs[id] = record; }, { expectedRevision: current.revision, clock: this.clock });
        return { created: true, record: clone(stored.data.runs[id]) };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async get(runId) {
    return clone((await this.repository.read()).data.runs[String(runId)] || null);
  }

  async listRunning() {
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.status === "running")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async listResumable() {
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => (
        !record.assistantMessageId
        && record.taskIds.length > 0
        && (
          (record.status === "completed" && ["waiting_approval", "waiting_input"].includes(record.result?.taskStatus))
          || record.status === "failed"
        )
      ))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async listFailed() {
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.status === "failed")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async listFailedForConversation(conversationId) {
    const id = assertId(conversationId, "conversationId");
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.status === "failed" && record.input?.conversationId === id)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async listCompleted() {
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.status === "completed" && record.assistantMessageId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async findByTask(taskId) {
    const id = assertId(taskId, "taskId");
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.taskIds.includes(id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId))
      .map(clone);
  }

  async findByMessage(conversationId, messageId) {
    const conversation = assertId(conversationId, "conversationId");
    const message = assertId(messageId, "messageId");
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.input?.conversationId === conversation && record.input?.messageId === message)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId))
      .map(clone);
  }

  async listByConversation(conversationId) {
    const id = assertId(conversationId, "conversationId");
    return Object.values((await this.repository.read()).data.runs)
      .filter((record) => record.input?.conversationId === id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId))
      .map(clone);
  }

  async forgetConversation(conversationId) {
    const id = String(conversationId || "");
    invariant(id, "WEB_RUN_CONVERSATION_REQUIRED", "清理网页 Agent 运行记录时缺少 conversationId", { status: 500, expose: false });
    for (;;) {
      const current = await this.repository.read();
      const runIds = Object.values(current.data.runs)
        .filter((record) => record.input?.conversationId === id)
        .map((record) => record.runId);
      if (!runIds.length) return { conversationId: id, removed: 0 };
      try {
        await this.repository.update((data) => {
          for (const runId of runIds) delete data.runs[runId];
        }, { expectedRevision: current.revision, clock: this.clock });
        return { conversationId: id, removed: runIds.length };
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async addTask(runId, taskId) {
    return this.#update(runId, (record) => {
      if (!record.taskIds.includes(taskId)) record.taskIds.push(String(taskId));
    });
  }

  async complete(runId, { assistantMessageId, result }) {
    return this.#update(runId, (record) => {
      record.status = "completed";
      record.assistantMessageId = assistantMessageId == null ? null : String(assistantMessageId);
      record.result = clone(result || {});
      record.failure = null;
    });
  }

  async reopen(runId) {
    return this.#update(runId, (record) => {
      invariant(!record.assistantMessageId, "WEB_RUN_ALREADY_PERSISTED", "网页 Agent 回复已经落盘，不能重新打开", { status: 409 });
      record.status = "running";
      record.failure = null;
    });
  }

  async fail(runId, failure) {
    return this.#update(runId, (record) => {
      record.status = "failed";
      record.failure = clone(failure);
      record.result = null;
    });
  }

  async #update(runId, mutate) {
    const id = assertId(runId, "web run id");
    for (;;) {
      const current = await this.repository.read();
      invariant(current.data.runs[id], "WEB_RUN_NOT_FOUND", "网页 Agent run 不存在", { status: 404 });
      try {
        const stored = await this.repository.update((data) => {
          mutate(data.runs[id]);
          data.runs[id].updatedAt = this.clock().toISOString();
        }, { expectedRevision: current.revision, clock: this.clock });
        return clone(stored.data.runs[id]);
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }
}
