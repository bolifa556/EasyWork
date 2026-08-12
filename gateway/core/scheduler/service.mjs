import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { assertServerIdentity } from "../entities/common.mjs";
import {
  SCHEDULER_SCHEMA_VERSION,
  SCHEDULER_FEATURES,
  SCHEDULER_TYPES,
  assertCommandId,
  assertJobId,
  assertPartitionName,
  assertSshUsername,
  normalizeExecutionResult,
  schedulerCommandFailure,
  validateSchedulerAdapter,
} from "./contract.mjs";

const clone = (value) => structuredClone(value);
const inlineQueue = Object.freeze({ run: async (_actor, operation) => operation() });

function now(clock) {
  const value = (clock || (() => new Date()))();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.valueOf()), "SCHEDULER_CLOCK_INVALID", "Scheduler 时钟无效", { status: 500, expose: false });
  return date;
}

function validateStore(data, actorId, serverIdentity) {
  const profile = data?.profile;
  const validProfile = profile === null || Boolean(profile && typeof profile === "object" && !Array.isArray(profile)
    && Object.keys(profile).length === 8
    && ["schemaVersion", "serverIdentity", "scheduler", "commands", "features", "partitionsOrQueues", "detectedAt", "expiresAt"].every((key) => Object.hasOwn(profile, key))
    && profile.serverIdentity === serverIdentity
    && profile.schemaVersion === SCHEDULER_SCHEMA_VERSION
    && SCHEDULER_TYPES.includes(profile.scheduler)
    && profile.commands && typeof profile.commands === "object" && !Array.isArray(profile.commands)
    && Object.values(profile.commands).every((value) => typeof value === "boolean")
    && profile.features && typeof profile.features === "object" && !Array.isArray(profile.features)
    && Object.keys(profile.features).length === SCHEDULER_FEATURES.length
    && SCHEDULER_FEATURES.every((feature) => {
      const capability = profile.features[feature];
      return capability && typeof capability === "object" && !Array.isArray(capability)
        && Object.keys(capability).length === 2
        && typeof capability.available === "boolean"
        && (capability.reason === null || typeof capability.reason === "string");
    })
    && Array.isArray(profile.partitionsOrQueues)
    && Number.isFinite(Date.parse(profile.detectedAt))
    && Number.isFinite(Date.parse(profile.expiresAt))
    && profile.expiresAt > profile.detectedAt);
  const valid = Boolean(data && typeof data === "object" && !Array.isArray(data)
    && validProfile
    && Array.isArray(data.commands)
    && data.actorId === actorId
    && data.serverIdentity === serverIdentity);
  if (!valid) return false;
  if (Object.keys(data).length !== 4 || !["actorId", "serverIdentity", "profile", "commands"].every((key) => Object.hasOwn(data, key))) return false;
  const ids = new Set();
  return data.commands.every((command) => command && typeof command === "object" && !Array.isArray(command)
    && Object.keys(command).length === 5
    && ["commandId", "operation", "fingerprint", "result", "completedAt"].every((key) => Object.hasOwn(command, key))
    && typeof command.commandId === "string" && !ids.has(command.commandId) && ids.add(command.commandId)
    && typeof command.operation === "string" && command.operation.startsWith("scheduler.")
    && /^[a-f0-9]{64}$/.test(command.fingerprint)
    && command.result && typeof command.result === "object" && !Array.isArray(command.result)
    && Number.isFinite(Date.parse(command.completedAt)));
}

function fingerprint(operation, input) {
  return crypto.createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

export class SchedulerService {
  constructor(options) {
    invariant(options?.actor?.actorType === "user" && options.actor.userId, "AUTHENTICATION_REQUIRED", "Scheduler 需要登录用户", { status: 401 });
    invariant(typeof options?.dataRoot === "string" && path.isAbsolute(options.dataRoot), "DATA_ROOT_INVALID", "dataRoot 必须是绝对路径", { status: 500, expose: false });
    invariant(typeof options?.executor?.run === "function" && typeof options?.executor?.readRange === "function", "SCHEDULER_EXECUTOR_INVALID", "Scheduler executor 契约无效", { status: 500, expose: false });
    invariant(typeof options?.authorizeServer === "function", "SCHEDULER_SERVER_AUTHORIZER_REQUIRED", "缺少服务器鉴权器", { status: 500, expose: false });
    this.actor = options.actor;
    this.dataRoot = options.dataRoot;
    this.serverIdentity = assertServerIdentity(options.serverIdentity);
    this.username = assertSshUsername(options.username);
    this.adapter = validateSchedulerAdapter(options.adapter);
    this.executor = options.executor;
    this.authorizeServer = options.authorizeServer;
    this.queue = options.queue || defaultActorMutationQueue;
    this.clock = options.clock;
    this.capabilityTtlMs = options.capabilityTtlMs ?? 10 * 60 * 1000;
    invariant(Number.isSafeInteger(this.capabilityTtlMs) && this.capabilityTtlMs > 0, "SCHEDULER_CAPABILITY_TTL_INVALID", "Scheduler capability TTL 无效", { status: 500, expose: false });
    this.repository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["scheduler", this.serverIdentity, "state.json"],
      schemaVersion: SCHEDULER_SCHEMA_VERSION,
      defaultData: () => ({ actorId: this.actor.actorId, serverIdentity: this.serverIdentity, profile: null, commands: [] }),
      validate: (data) => validateStore(data, this.actor.actorId, this.serverIdentity),
      queue: inlineQueue,
    });
  }

  async inspectCapabilities() {
    await this.#authorize("read");
    const detectedAt = now(this.clock);
    const expiresAt = new Date(detectedAt.valueOf() + this.capabilityTtlMs);
    let profile;
    if (typeof this.adapter.capabilityProbeDescriptors === "function") {
      const commandResults = {};
      for (const descriptor of this.adapter.capabilityProbeDescriptors()) {
        const result = await this.#execute(descriptor, { allowFailure: true });
        commandResults[descriptor.executable] = result;
      }
      profile = this.adapter.inspectCapabilities({ serverIdentity: this.serverIdentity, commandResults, detectedAt, expiresAt });
    } else {
      profile = this.adapter.inspectCapabilities({ serverIdentity: this.serverIdentity, commandResults: {}, detectedAt, expiresAt });
    }
    await this.#updateProfile(() => clone(profile));
    return clone(profile);
  }

  async getCapabilities() {
    await this.#authorize("read");
    const current = await this.repository.read();
    if (!current.data.profile) return this.inspectCapabilities();
    if (Date.parse(current.data.profile.expiresAt) <= now(this.clock).valueOf()) return this.inspectCapabilities();
    return clone(current.data.profile);
  }

  async accessiblePartitions() {
    await this.#requireFeature("accessiblePartitions");
    const plan = this.adapter.accessiblePartitions({ username: this.username });
    const [partitions, associations] = await Promise.all(plan.descriptors.map((descriptor) => this.#execute(descriptor)));
    const result = plan.parse({ partitions: partitions.stdout, associations: associations.stdout });
    await this.#updateProfile((profile) => profile ? { ...profile, partitionsOrQueues: clone(result) } : profile);
    return clone(result);
  }

  async resourceSummary(input = {}) {
    await this.#requireFeature("resourceSummary");
    const accessible = await this.accessiblePartitions();
    const allowed = new Set(accessible.map((entry) => entry.id));
    const requested = input.partitions?.length ? [...new Set(input.partitions.map((entry) => assertPartitionName(entry)))] : [...allowed];
    invariant(requested.length > 0 && requested.every((partition) => allowed.has(partition)), "SCHEDULER_SCOPE_VIOLATION", "请求包含当前 SSH 用户不可访问的分区", { status: 403 });
    const plan = this.adapter.resourceSummary({ partitions: requested });
    const [output, jobs] = await Promise.all([
      this.#execute(plan.descriptor),
      this.userJobs(),
    ]);
    return {
      ...clone(plan.parse(output.stdout)),
      currentUserJobs: {
        running: jobs.filter((job) => job.state === "running").length,
        pending: jobs.filter((job) => job.state === "pending").length,
      },
      sampledAt: now(this.clock).toISOString(),
    };
  }

  async userJobs() {
    await this.#requireFeature("userJobs");
    const plan = this.adapter.userJobs({ username: this.username });
    const output = await this.#execute(plan.descriptor);
    return clone(plan.parse(output.stdout));
  }

  async jobOutput(input) {
    await this.#requireFeature("jobOutput");
    const jobId = assertJobId(input?.jobId);
    const inspectPlan = this.adapter.inspectJob({ jobId });
    const inspected = await this.#execute(inspectPlan.descriptor);
    const job = inspectPlan.parse(inspected.stdout);
    invariant(job.owner === this.username, "SCHEDULER_JOB_FORBIDDEN", "不能读取其他用户的作业输出", { status: 403 });
    const descriptor = this.adapter.jobOutput({
      username: this.username,
      job,
      stream: input?.stream,
      offset: input?.offset,
      maxBytes: input?.maxBytes,
    });
    const result = await this.executor.readRange(descriptor);
    invariant(result && Buffer.isBuffer(result.bytes) && Number.isSafeInteger(result.nextOffset), "SCHEDULER_OUTPUT_RESULT_INVALID", "Job output 读取结果无效", { status: 500, expose: false });
    invariant(result.bytes.length <= descriptor.maxBytes && result.nextOffset === descriptor.offset + result.bytes.length, "SCHEDULER_OUTPUT_RESULT_INVALID", "Job output cursor 无效", { status: 500, expose: false });
    return {
      jobId,
      stream: input?.stream || "stdout",
      bytes: Buffer.from(result.bytes),
      offset: descriptor.offset,
      nextOffset: result.nextOffset,
      eof: Boolean(result.eof),
    };
  }

  async submit(input) {
    await this.#requireFeature("submit", "write");
    const commandId = assertCommandId(input?.commandId);
    const partition = assertPartitionName(input?.partition);
    const allowed = new Set((await this.accessiblePartitions()).map((entry) => entry.id));
    invariant(allowed.has(partition), "SCHEDULER_SCOPE_VIOLATION", "不能向当前 SSH 用户不可访问的分区提交作业", { status: 403 });
    const commandInput = { partition, scriptPath: String(input?.scriptPath || ""), args: clone(input?.args || []) };
    return this.#mutation("scheduler.submit", commandId, commandInput, async () => {
      const plan = this.adapter.submit(commandInput);
      const output = await this.#execute(plan.descriptor);
      return plan.parse(output.stdout);
    });
  }

  async cancelJob(input) {
    await this.#requireFeature("cancelJob", "write");
    const commandId = assertCommandId(input?.commandId);
    const jobId = assertJobId(input?.jobId);
    return this.#mutation("scheduler.cancel-job", commandId, { jobId }, async () => {
      const inspectPlan = this.adapter.inspectJob({ jobId });
      const inspected = await this.#execute(inspectPlan.descriptor);
      const job = inspectPlan.parse(inspected.stdout);
      invariant(job.owner === this.username, "SCHEDULER_JOB_FORBIDDEN", "不能取消其他用户的作业", { status: 403 });
      const plan = this.adapter.cancelJob({ jobId });
      const output = await this.#execute(plan.descriptor);
      return plan.parse(output.stdout);
    });
  }

  async #authorize(action) {
    const result = await this.authorizeServer(this.serverIdentity, action, this.actor);
    invariant(result !== false, "SERVER_FORBIDDEN", "无权访问该服务器", { status: 403 });
  }

  async #requireFeature(feature, action = "read") {
    await this.#authorize(action);
    const profile = await this.getCapabilities();
    invariant(profile.scheduler === this.adapter.type && profile.features[feature]?.available, "SCHEDULER_CAPABILITY_UNAVAILABLE", `Scheduler 不支持 ${feature}`, {
      status: 409,
      details: { scheduler: profile.scheduler, feature, reason: profile.features[feature]?.reason || "unavailable" },
    });
    return profile;
  }

  async #execute(descriptor, options = {}) {
    const raw = await this.executor.run(descriptor);
    const result = normalizeExecutionResult(raw, descriptor);
    if (!options.allowFailure && result.code !== 0) throw schedulerCommandFailure(descriptor, result);
    return result;
  }

  async #mutation(operation, commandId, input, execute) {
    return this.queue.run(this.actor, async () => {
      const current = await this.repository.read();
      const hash = fingerprint(operation, input);
      const previous = current.data.commands.find((entry) => entry.commandId === commandId);
      if (previous) {
        invariant(previous.operation === operation && previous.fingerprint === hash, "COMMAND_ID_REUSED", "commandId 已用于其他 Scheduler 操作", { status: 409 });
        return { ...clone(previous.result), idempotentReplay: true };
      }
      const result = await execute();
      await this.repository.update((data) => {
        data.commands.push({ commandId, operation, fingerprint: hash, result: clone(result), completedAt: now(this.clock).toISOString() });
      }, { expectedRevision: current.revision, clock: () => now(this.clock) });
      return { ...clone(result), idempotentReplay: false };
    });
  }

  async #updateProfile(mutator) {
    return this.queue.run(this.actor, async () => {
      const current = await this.repository.read();
      const nextProfile = mutator(clone(current.data.profile));
      if (nextProfile === current.data.profile) return current;
      return this.repository.update((data) => { data.profile = clone(nextProfile); }, {
        expectedRevision: current.revision,
        clock: () => now(this.clock),
      });
    });
  }
}
