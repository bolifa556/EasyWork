import crypto from "node:crypto";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { assertServerIdentity } from "../entities/common.mjs";
import { SchedulerSubmissionLedger } from "./submissions.mjs";
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
const DEFAULT_JOB_HISTORY_LOOKBACK_DAYS = 30;
const TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled", "timeout"]);

function remoteOutputNotCreated(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message || "");
  return code === "ENOENT" || code === "2" || /no such file/i.test(message);
}

function isoDate(value, field) {
  const source = String(value || "");
  const parsed = Date.parse(`${source}T00:00:00Z`);
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(source) && Number.isFinite(parsed), "SCHEDULER_HISTORY_RANGE_INVALID", `${field} 无效`, { status: 400 });
  return { source, parsed };
}

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
    && Object.keys(command).every((key) => ["commandId", "operation", "fingerprint", "result", "completedAt", "status", "startedAt"].includes(key))
    && ["commandId", "operation", "fingerprint", "result", "completedAt"].every((key) => Object.hasOwn(command, key))
    && typeof command.commandId === "string" && !ids.has(command.commandId) && ids.add(command.commandId)
    && typeof command.operation === "string" && command.operation.startsWith("scheduler.")
    && /^[a-f0-9]{64}$/.test(command.fingerprint)
    && command.result && typeof command.result === "object" && !Array.isArray(command.result)
    && (["pending", "unknown"].includes(command.status)
      ? command.completedAt === null && Number.isFinite(Date.parse(command.startedAt))
      : (!command.status || command.status === "completed") && Number.isFinite(Date.parse(command.completedAt))));
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
    this.submissions = options.submissionLedger || new SchedulerSubmissionLedger(options);
    this.onSubmitted = options.onSubmitted || null;
    this.onCancelled = options.onCancelled || null;
    this.submissionStatusCache = new Map();
    this.jobsRevision = 0;
    this.capabilityTtlMs = options.capabilityTtlMs ?? 10 * 60 * 1000;
    this.dashboardCache = null;
    this.dashboardPending = null;
    this.resourceCache = null;
    this.resourcePending = null;
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
      const probes = await Promise.all(this.adapter.capabilityProbeDescriptors().map(async (descriptor) => ({
        executable: descriptor.executable,
        result: await this.#execute(descriptor, { allowFailure: true }),
      })));
      for (const probe of probes) commandResults[probe.executable] = probe.result;
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
    const output = await this.#execute(plan.descriptor);
    return {
      ...clone(plan.parse(output.stdout)),
      sampledAt: now(this.clock).toISOString(),
    };
  }

  async userJobs() {
    await this.#requireFeature("userJobs");
    const plan = this.adapter.userJobs({ username: this.username });
    const output = await this.#execute(plan.descriptor);
    const jobs = clone(plan.parse(output.stdout));
    await this.submissions.updateJobs(jobs);
    return jobs;
  }

  async inspectSubmittedJob(jobId) {
    await this.#authorize("read");
    const profile = await this.getCapabilities();
    if (!profile.commands.scontrol) return null;
    const plan = this.adapter.inspectJob({ jobId: assertJobId(jobId) });
    const output = await this.#execute(plan.descriptor, { allowFailure: true });
    if (output.code !== 0 && /(?:invalid job id|invalid job identifier|job.*not found)/i.test(`${output.stderr}\n${output.stdout}`)) return null;
    if (output.code !== 0) throw schedulerCommandFailure(plan.descriptor, output);
    const detail = plan.parse(output.stdout);
    if (detail.owner !== this.username) return null;
    const fields = { ...detail };
    const id = fields.jobId;
    delete fields.jobId;
    delete fields.stdoutPath;
    delete fields.stderrPath;
    return { ...fields, id, scheduler: this.adapter.type };
  }

  async jobHistory(input = {}) {
    const profile = await this.#requireFeature("jobHistory");
    const jobsRevision = this.jobsRevision;
    const sampledAt = now(this.clock);
    const utcOffsetMinutes = Number(input.utcOffsetMinutes ?? 0);
    invariant(Number.isInteger(utcOffsetMinutes) && Math.abs(utcOffsetMinutes) <= 14 * 60, "SCHEDULER_HISTORY_RANGE_INVALID", "历史作业时区无效", { status: 400 });
    const defaultStart = new Date(sampledAt.valueOf() - DEFAULT_JOB_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const start = isoDate(input.startDate || defaultStart.toISOString().slice(0, 10), "历史作业开始日期");
    const end = isoDate(input.endDate || sampledAt.toISOString().slice(0, 10), "历史作业结束日期");
    invariant(start.parsed <= end.parsed, "SCHEDULER_HISTORY_RANGE_INVALID", "历史作业开始日期不能晚于结束日期", { status: 400 });
    const plan = this.adapter.jobHistory({
      username: this.username,
      // Use an absolute ISO date. Older Slurm releases do not consistently
      // accept relative expressions such as `now-30days`.
      startTime: start.source,
      endTime: `${end.source}T23:59:59`,
    });
    const submissions = await this.submissions.list({ startDate: start.source, endDate: end.source, utcOffsetMinutes });
    let schedulerHistory = [];
    try {
      const output = await this.#execute(plan.descriptor);
      schedulerHistory = clone(plan.parse(output.stdout));
    } catch (error) {
      if (!submissions.length) throw error;
    }
    if (!submissions.length) return schedulerHistory;
    let active = [];
    if (profile.features.userJobs?.available) {
      try {
        const currentPlan = this.adapter.userJobs({ username: this.username });
        const currentOutput = await this.#execute(currentPlan.descriptor);
        active = currentPlan.parse(currentOutput.stdout);
      } catch {
        // Stored submission receipts remain useful during a queue outage.
      }
    }
    const activeIds = new Set(active.map((job) => job.id));
    const nativeIds = new Set(schedulerHistory.map((job) => job.id));
    const inspected = [];
    // Some sites have an incomplete accounting database. Ask the controller
    // directly while it still retains the completed job, independently of any
    // Agent query. Bound both query count and refresh frequency.
    if (profile.commands.scontrol) {
      const missing = [...new Map(submissions.filter((job) => !nativeIds.has(job.id) && !activeIds.has(job.id) && !TERMINAL_JOB_STATES.has(job.state)).map((job) => [job.id, job])).values()];
      const pending = [];
      for (const receipt of missing) {
        const cached = this.submissionStatusCache.get(receipt.id);
        if (cached && sampledAt.valueOf() - cached.at < 60_000) {
          if (cached.job) inspected.push(cached.job);
          continue;
        }
        pending.push(receipt);
      }
      // Least-recently inspected first, so a large set does not repeatedly
      // spend the whole query budget on the same retired jobs.
      pending.sort((left, right) => (this.submissionStatusCache.get(left.id)?.at || 0) - (this.submissionStatusCache.get(right.id)?.at || 0));
      const inspect = async (receipt) => {
        let job = null;
        try {
          const inspection = this.adapter.inspectJob({ jobId: receipt.id });
          const result = await this.#execute(inspection.descriptor);
          const detail = inspection.parse(result.stdout);
          if (detail.owner === this.username) {
            job = { ...receipt, ...detail, id: detail.jobId, submittedAt: receipt.submittedAt };
            delete job.jobId;
            delete job.stdoutPath;
            delete job.stderrPath;
            inspected.push(job);
          }
        } catch { /* The controller may already have retired this job. */ }
        if (jobsRevision === this.jobsRevision) this.submissionStatusCache.set(receipt.id, { at: sampledAt.valueOf(), job });
      };
      for (let offset = 0; offset < Math.min(pending.length, 20); offset += 4) {
        await Promise.all(pending.slice(offset, Math.min(offset + 4, 20)).map(inspect));
      }
      if (this.submissionStatusCache.size > 1000) {
        const oldest = [...this.submissionStatusCache].sort((left, right) => left[1].at - right[1].at);
        for (const [jobId] of oldest.slice(0, this.submissionStatusCache.size - 1000)) this.submissionStatusCache.delete(jobId);
      }
    }
    for (const job of inspected) if (["pending", "running"].includes(job.state)) activeIds.add(job.id);
    await this.submissions.updateJobs([...active, ...inspected, ...schedulerHistory]);
    const snapshots = new Map(inspected.map((job) => [job.id, job]));
    const merged = new Map();
    for (const receipt of submissions) {
      if (activeIds.has(receipt.id)) continue;
      const candidate = clone(snapshots.get(receipt.id) || receipt);
      if (!TERMINAL_JOB_STATES.has(candidate.state)) {
        candidate.state = "unknown";
        candidate.endedAt = null;
        candidate.expectedEndAt = null;
        candidate.locationOrReason = "EasyWork 已记录提交；调度器尚未返回终态";
      }
      merged.set(candidate.id, candidate);
    }
    for (const job of schedulerHistory) merged.set(job.id, job);
    return [...merged.values()].sort((left, right) => {
      const leftAt = Date.parse(left.endedAt || left.startedAt || left.submittedAt || "") || 0;
      const rightAt = Date.parse(right.endedAt || right.startedAt || right.submittedAt || "") || 0;
      return rightAt - leftAt || String(right.id).localeCompare(String(left.id));
    });
  }

  async resources({ refresh = false } = {}) {
    await this.#authorize("read");
    if (!refresh && this.resourceCache) return clone(this.resourceCache);
    if (this.resourcePending) return clone(await this.resourcePending);
    this.resourcePending = this.#readResources().then((snapshot) => {
      this.resourceCache = snapshot;
      return snapshot;
    }).finally(() => { this.resourcePending = null; });
    return clone(await this.resourcePending);
  }

  async #readResources() {
    const profile = await this.getCapabilities();
    invariant(profile.scheduler === this.adapter.type, "SCHEDULER_CAPABILITY_UNAVAILABLE", "当前服务器没有可用的调度器", { status: 409 });
    const partitions = profile.features.accessiblePartitions.available ? await this.accessiblePartitions() : [];
    let summary = null;
    if (profile.features.resourceSummary.available && partitions.length) {
      const requested = partitions.map((entry) => entry.id);
      const plan = this.adapter.resourceSummary({ partitions: requested });
      const output = await this.#execute(plan.descriptor);
      summary = { ...clone(plan.parse(output.stdout)), sampledAt: now(this.clock).toISOString() };
    }
    return {
      scheduler: profile.scheduler,
      capability: clone(profile),
      partitions: clone(partitions),
      summary,
      sampledAt: summary?.sampledAt || now(this.clock).toISOString(),
    };
  }

  invalidateJobs(jobIds = []) {
    this.jobsRevision += 1;
    this.dashboardCache = null;
    this.dashboardPending = null;
    if (jobIds.length) for (const id of jobIds) this.submissionStatusCache.delete(id);
    else this.submissionStatusCache.clear();
  }

  async dashboard({ refresh = false } = {}) {
    await this.#authorize("read");
    if (!refresh && this.dashboardCache) return clone(this.dashboardCache);
    if (this.dashboardPending) return clone(await this.dashboardPending);
    const jobsRevision = this.jobsRevision;
    const pending = this.#readDashboard({ refresh }).then((snapshot) => {
      if (jobsRevision === this.jobsRevision) this.dashboardCache = snapshot;
      return snapshot;
    }).finally(() => { if (this.dashboardPending === pending) this.dashboardPending = null; });
    this.dashboardPending = pending;
    return clone(await pending);
  }

  async #readDashboard({ refresh = false } = {}) {
    const resources = await this.resources({ refresh });
    const profile = resources.capability;
    const [jobs, history] = await Promise.all([
      profile.features.userJobs.available ? this.userJobs() : [],
      profile.features.jobHistory.available ? this.jobHistory() : [],
    ]);
    return {
      ...resources,
      jobs: clone(jobs),
      history: clone(history),
    };
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
    let result;
    try {
      result = await this.executor.readRange(descriptor);
    } catch (error) {
      // Slurm/PBS commonly publish the configured output path before the batch
      // process has created the file.  That is a normal empty state while a job
      // is pending or just starting, not a scheduler/API failure.  Once the job
      // is terminal, keep surfacing a missing file because it may indicate a
      // real script or filesystem problem.
      if (!remoteOutputNotCreated(error) || !["pending", "running"].includes(job.state)) throw error;
      result = { bytes: Buffer.alloc(0), nextOffset: descriptor.offset, eof: true };
    }
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
    const commandInput = {
      partition,
      scriptPath: String(input?.scriptPath || ""),
      args: clone(input?.args || []),
      ...(input?.cwd ? { cwd: String(input.cwd) } : {}),
    };
    const result = await this.#mutation("scheduler.submit", commandId, commandInput, async () => {
      const plan = this.adapter.submit(commandInput);
      const output = await this.#execute(plan.descriptor);
      return plan.parse(output.stdout);
    });
    await this.submissions.record([{ jobId: result.jobId, partition, name: path.posix.basename(commandInput.scriptPath) }], { commandId });
    this.invalidateJobs([result.jobId]);
    if (this.onSubmitted) void Promise.resolve().then(() => this.onSubmitted([result.jobId])).catch(() => undefined);
    return result;
  }

  async cancelJob(input) {
    await this.#requireFeature("cancelJob", "write");
    const commandId = assertCommandId(input?.commandId);
    const jobId = assertJobId(input?.jobId);
    const result = await this.#mutation("scheduler.cancel-job", commandId, { jobId }, async () => {
      const inspectPlan = this.adapter.inspectJob({ jobId });
      const inspected = await this.#execute(inspectPlan.descriptor);
      const job = inspectPlan.parse(inspected.stdout);
      invariant(job.owner === this.username, "SCHEDULER_JOB_FORBIDDEN", "不能取消其他用户的作业", { status: 403 });
      const plan = this.adapter.cancelJob({ jobId });
      const output = await this.#execute(plan.descriptor);
      return plan.parse(output.stdout);
    });
    this.invalidateJobs([jobId]);
    if (this.onCancelled) void Promise.resolve().then(() => this.onCancelled([jobId])).catch(() => undefined);
    return result;
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
        invariant(!previous.status || previous.status === "completed", "SCHEDULER_RESULT_UNKNOWN", "这次操作已发出但结果尚未确认，请在作业列表核对；系统不会重复提交", { status: 409, retryable: false, details: { commandId, operation } });
        return { ...clone(previous.result), idempotentReplay: true };
      }
      const admitted = await this.repository.update((data) => {
        data.commands.push({ commandId, operation, fingerprint: hash, status: "pending", startedAt: now(this.clock).toISOString(), result: {}, completedAt: null });
      }, { expectedRevision: current.revision, clock: () => now(this.clock) });
      const result = await execute();
      await this.repository.update((data) => {
        const command = data.commands.find((entry) => entry.commandId === commandId);
        Object.assign(command, { status: "completed", result: clone(result), completedAt: now(this.clock).toISOString() });
      }, { expectedRevision: admitted.revision, clock: () => now(this.clock) });
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
