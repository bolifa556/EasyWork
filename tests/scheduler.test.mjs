import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import {
  PbsSchedulerAdapter,
  SchedulerService,
  SlurmSchedulerAdapter,
} from "../gateway/core/scheduler/index.mjs";
import { SchedulerSubmissionLedger } from "../gateway/core/scheduler/submissions.mjs";

const SERVER_IDENTITY = `ssh_${crypto.createHash("sha256").update("scheduler-host-key").digest("base64url")}`;

const PARTITION_FIXTURE = [
  "gpu*|up|infinite|2|idle|gpu:RTX5090:8",
  "gpu*|up|infinite|1|mix|gpu:RTX5090:8",
  "cpu|up|2-00:00:00|4|idle|(null)",
  "admin|up|infinite|1|idle|gpu:A100:8",
].join("\n");

const ASSOCIATION_FIXTURE = [
  "gpu|competition|normal",
  "cpu|competition|normal",
].join("\n");

const RESOURCE_FIXTURE = [
  "node01|gpu|idle|0/128/0/128|gpu:RTX5090:8",
  "node02|gpu|idle|0/128/0/128|gpu:RTX5090:8",
  "node03|gpu|mix|64/64/0/128|gpu:RTX5090:8",
  "node03|cpu|mix|64/64/0/128|gpu:RTX5090:8",
  "node04|cpu|idle|0/128/0/128|(null)",
  "node05|cpu|idle|0/128/0/128|(null)",
  "node06|cpu|idle|0/128/0/128|(null)",
  "node07|cpu|idle|0/128/0/128|(null)",
].join("\n");

const JOBS_FIXTURE = [
  "101|training.py|gpu|RUNNING|00:02:00|01:58:00|1|16|node01|2026-01-01T00:08:00|2026-01-01T02:08:00",
  "102|analysis|cpu|PENDING|00:00:00|02:00:00|1|8|Resources|2026-01-01T01:00:00|2026-01-01T03:00:00",
].join("\n");

const HISTORY_FIXTURE = [
  "98|prepare|cpu|COMPLETED|00:04:12|1|4|2026-01-01T00:01:00|2026-01-01T00:05:12",
  "99|train-old|gpu|FAILED+|00:00:33|1|16|2026-01-01T00:07:00|2026-01-01T00:07:33",
  "100|still-running|gpu|RUNNING|00:00:42|1|16|2026-01-01T00:08:00|Unknown",
].join("\n");

class FixtureExecutor {
  calls = [];
  readCalls = [];
  jobOwner = "alice";
  jobState = "RUNNING";
  missingOutput = false;
  missingJob = false;

  async run(descriptor) {
    assert.equal(descriptor.schemaVersion, 1);
    assert.equal(descriptor.kind, "exec");
    assert.equal(descriptor.shell, false);
    assert.equal(descriptor.stdin, null);
    assert.ok(descriptor.argv.every((argument) => !/[\0\r\n]/.test(argument)));
    this.calls.push(structuredClone(descriptor));
    if (descriptor.parser === "slurm.version.v1") return { code: 0, stdout: `${descriptor.executable} slurm 24.05.2\n`, stderr: "" };
    if (descriptor.parser === "slurm.partitions.v1") return { code: 0, stdout: PARTITION_FIXTURE, stderr: "" };
    if (descriptor.parser === "slurm.associations.v1") return { code: 0, stdout: ASSOCIATION_FIXTURE, stderr: "" };
    if (descriptor.parser === "slurm.resources.v1") return { code: 0, stdout: RESOURCE_FIXTURE, stderr: "" };
    if (descriptor.parser === "slurm.jobs.v1") return { code: 0, stdout: JOBS_FIXTURE, stderr: "" };
    if (descriptor.parser === "slurm.job-history.v1") return { code: 0, stdout: HISTORY_FIXTURE, stderr: "" };
    if (descriptor.parser === "slurm.job-inspect.oneliner.v1") {
      if (this.missingJob) return { code: 1, stdout: "", stderr: "Invalid job id specified" };
      const jobId = descriptor.argv.at(-1);
      return {
        code: 0,
        stdout: `JobId=${jobId} JobName=training UserId=${this.jobOwner}(1000) JobState=${this.jobState} Partition=gpu StdErr=/home/alice/logs/slurm-${jobId}.err StdOut=/home/alice/logs/slurm-${jobId}.out`,
        stderr: "",
      };
    }
    if (descriptor.parser === "slurm.submit.v1") return { code: 0, stdout: "301;cluster-a\n", stderr: "" };
    if (descriptor.parser === "slurm.cancel.v1") return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected descriptor ${descriptor.parser}`);
  }

  async readRange(descriptor) {
    assert.equal(descriptor.kind, "remote-file-range");
    assert.match(descriptor.path, /^\/home\/alice\/logs\/slurm-/);
    this.readCalls.push(structuredClone(descriptor));
    if (this.missingOutput) throw Object.assign(new Error("No such file"), { code: 2 });
    const bytes = Buffer.from("line one\nline two\n").subarray(0, descriptor.maxBytes);
    return { bytes, nextOffset: descriptor.offset + bytes.length, eof: true };
  }
}

async function fixture(t, options = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-scheduler-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const actor = createActorContext({ actorType: "user", actorId: "alice", deviceId: "device-1", sessionId: "session-1", roles: [] });
  const executor = options.executor || new FixtureExecutor();
  let tick = 0;
  const service = new SchedulerService({
    actor,
    dataRoot,
    serverIdentity: SERVER_IDENTITY,
    username: "alice",
    adapter: options.adapter || new SlurmSchedulerAdapter(),
    executor,
    authorizeServer: async () => options.authorized !== false,
    submissionLedger: options.submissionLedger,
    onSubmitted: options.onSubmitted,
    capabilityTtlMs: 60_000,
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  return { actor, dataRoot, executor, service };
}

test("Slurm capability profile is persisted from explicit command probes", async (t) => {
  const { dataRoot, executor, service } = await fixture(t);
  const profile = await service.inspectCapabilities();
  assert.equal(profile.scheduler, "slurm");
  assert.equal(profile.features.accessiblePartitions.available, true);
  assert.equal(profile.features.jobHistory.available, true);
  assert.equal(profile.features.jobOutput.available, true);
  assert.deepEqual(Object.keys(profile.commands).sort(), ["sacct", "sacctmgr", "sbatch", "scancel", "scontrol", "sinfo", "squeue"]);
  assert.equal(executor.calls.length, 7);
  const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "users", "alice", "scheduler", SERVER_IDENTITY, "state.json"), "utf8"));
  assert.equal(stored.data.profile.scheduler, "slurm");
  assert.equal(JSON.stringify(stored).includes("password"), false);
});

test("accessible partitions and resource summary stay inside the current SSH user's scope", async (t) => {
  const { service } = await fixture(t);
  await service.inspectCapabilities();
  const partitions = await service.accessiblePartitions();
  assert.deepEqual(partitions.map((entry) => entry.id), ["gpu", "cpu"]);
  assert.equal(partitions[0].isDefault, true);
  assert.equal(partitions.some((entry) => entry.id === "admin"), false);

  const summary = await service.resourceSummary({ partitions: ["gpu", "cpu"] });
  assert.deepEqual(summary.scope.partitionIds, ["cpu", "gpu"]);
  assert.deepEqual(summary.nodes, { idle: 6, allocated: 0, mixed: 1, unavailable: 0, total: 7 });
  assert.equal(summary.cpuCores.total, 896);
  assert.equal(summary.accelerators.total, 24);
  assert.equal(summary.accelerators.unit, "device");
  assert.match(summary.sampledAt, /^2026-01-01T/);

  await assert.rejects(service.resourceSummary({ partitions: ["admin"] }), (error) => error?.code === "SCHEDULER_SCOPE_VIOLATION");
});

test("scheduler dashboard shares one scoped snapshot until an explicit refresh", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  const first = await service.dashboard();
  assert.deepEqual(first.partitions.map((entry) => entry.id), ["gpu", "cpu"]);
  assert.deepEqual(first.jobs.map((entry) => entry.id), ["101", "102"]);
  assert.deepEqual(first.history.map((entry) => [entry.id, entry.state]), [["98", "completed"], ["99", "failed"]]);
  const callsAfterFirstRead = executor.calls.length;
  assert.deepEqual(await service.dashboard(), first);
  assert.equal(executor.calls.length, callsAfterFirstRead);
  await service.dashboard({ refresh: true });
  assert.equal(executor.calls.length, callsAfterFirstRead + 5);
});

test("job history is scheduler-derived and records completion timestamps", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  const history = await service.jobHistory();
  assert.deepEqual(history.map((job) => [job.id, job.state, job.endedAt]), [
    ["98", "completed", "2026-01-01T00:05:12"],
    ["99", "failed", "2026-01-01T00:07:33"],
  ]);
  const descriptor = executor.calls.find((entry) => entry.parser === "slurm.job-history.v1");
  assert.ok(descriptor.argv.includes("--starttime=2025-12-02"));
  assert.ok(descriptor.argv.includes("--endtime=2026-01-01T23:59:59"));
  assert.equal(descriptor.argv.some((argument) => argument.startsWith("--state=")), false);
  assert.equal(descriptor.argv.some((argument) => argument.includes("now-30days")), false);
});

test("job history accepts an explicit inclusive date range and rejects reversed dates", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  await service.jobHistory({ startDate: "2025-10-01", endDate: "2025-12-31" });
  const descriptor = executor.calls.findLast((entry) => entry.parser === "slurm.job-history.v1");
  assert.ok(descriptor.argv.includes("--starttime=2025-10-01"));
  assert.ok(descriptor.argv.includes("--endtime=2025-12-31T23:59:59"));
  await assert.rejects(service.jobHistory({ startDate: "2026-01-02", endDate: "2026-01-01" }), (error) => error?.code === "SCHEDULER_HISTORY_RANGE_INVALID" && error?.status === 400);
  for (const utcOffsetMinutes of ["bad", 841, -841, 0.5]) {
    await assert.rejects(service.jobHistory({ utcOffsetMinutes }), (error) => error?.code === "SCHEDULER_HISTORY_RANGE_INVALID" && error?.status === 400);
  }
});

test("job history keeps durable submission receipts, excludes active jobs and prefers native accounting", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  await service.submissions.record(["97", "98", "101"].map((jobId) => ({ jobId, callId: "submit", name: "receipt", partition: "cpu" })), { taskId: "task-one" });
  executor.missingJob = true;
  const history = await service.jobHistory();
  assert.equal(history.find((job) => job.id === "97")?.state, "unknown");
  assert.equal(history.find((job) => job.id === "97")?.startedAt, null, "提交时间不是开跑时间");
  assert.match(history.find((job) => job.id === "97")?.submittedAt, /^2026-01-01T/);
  assert.equal(history.find((job) => job.id === "98")?.name, "prepare");
  assert.equal(history.find((job) => job.id === "98")?.state, "completed");
  assert.equal(history.some((job) => job.id === "101"), false);
  const calls = executor.calls.filter((call) => call.parser === "slurm.job-inspect.oneliner.v1").length;
  await service.jobHistory();
  assert.equal(executor.calls.filter((call) => call.parser === "slurm.job-inspect.oneliner.v1").length, calls, "缺失回执的控制器检查有缓存");
});

test("accounting unavailable still preserves submissions, and direct controller terminal states survive restart", async (t) => {
  const { actor, dataRoot, executor, service } = await fixture(t);
  await service.inspectCapabilities();
  await service.submissions.record([{ jobId: "301", callId: "batch", name: "CPU test" }], { taskId: "task-one" });
  const execute = executor.run.bind(executor);
  executor.run = async (descriptor) => descriptor.parser === "slurm.job-history.v1"
    ? { code: 1, stdout: "", stderr: "Accounting connection unavailable" } : execute(descriptor);
  executor.jobState = "COMPLETED";
  const history = await service.jobHistory();
  assert.equal(history[0].state, "completed");
  assert.equal(history[0].historySource, "easywork-submission");
  const fresh = new SchedulerSubmissionLedger({ actor, dataRoot, serverIdentity: SERVER_IDENTITY, username: "alice" });
  assert.equal((await fresh.list({ startDate: "2026-01-01", endDate: "2026-01-01" }))[0].state, "completed");
  executor.missingJob = true;
  service.submissionStatusCache.clear();
  const inspectCount = executor.calls.length;
  assert.equal((await service.jobHistory())[0].state, "completed");
  assert.equal(executor.calls.slice(inspectCount).some((call) => call.parser === "slurm.job-inspect.oneliner.v1"), false);
});

test("submission status cannot import another SSH user's controller result", async (t) => {
  const { executor, service } = await fixture(t);
  await service.submissions.record([{ jobId: "301", callId: "batch" }], { taskId: "task-one" });
  executor.jobOwner = "bob";
  executor.jobState = "COMPLETED";
  assert.equal((await service.jobHistory()).find((job) => job.id === "301").state, "unknown");
});

test("independent submission inspection uses the native controller and checks owner", async (t) => {
  const { executor, service } = await fixture(t);
  executor.jobState = "COMPLETED";
  const job = await service.inspectSubmittedJob("301");
  assert.equal(job.id, "301");
  assert.equal(job.state, "completed");
  assert.equal(job.owner, "alice");
  assert.equal(job.stdoutPath, undefined);
  assert.equal(job.stderrPath, undefined);
  assert.equal(executor.calls.some((call) => call.parser === "slurm.job-history.v1"), false);
  executor.jobOwner = "bob";
  assert.equal(await service.inspectSubmittedJob("301"), null);
});

test("user jobs and output use structured descriptors and reject another owner's job", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  const jobs = await service.userJobs();
  assert.deepEqual(jobs.map((job) => [job.id, job.owner, job.state]), [
    ["101", "alice", "running"],
    ["102", "alice", "pending"],
  ]);
  assert.equal(jobs[0].startedAt, "2026-01-01T00:08:00");
  assert.equal(jobs[0].endedAt, null);
  assert.equal(jobs[0].expectedEndAt, "2026-01-01T02:08:00");
  const output = await service.jobOutput({ jobId: "101", stream: "stdout", offset: 8, maxBytes: 1024 });
  assert.equal(output.offset, 8);
  assert.equal(output.nextOffset, 8 + output.bytes.length);
  assert.equal(executor.readCalls[0].path, "/home/alice/logs/slurm-101.out");

  executor.jobOwner = "bob";
  await assert.rejects(service.jobOutput({ jobId: "101" }), (error) => error?.code === "SCHEDULER_JOB_FORBIDDEN");
});

test("pending or running jobs treat an output file that is not created yet as empty", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  executor.missingOutput = true;

  for (const state of ["PENDING", "RUNNING"]) {
    executor.jobState = state;
    const output = await service.jobOutput({ jobId: "101", stream: "stdout", offset: 0, maxBytes: 1024 });
    assert.equal(output.bytes.length, 0);
    assert.equal(output.nextOffset, 0);
    assert.equal(output.eof, true);
  }

  executor.jobState = "COMPLETED";
  await assert.rejects(service.jobOutput({ jobId: "101", stream: "stdout" }), (error) => error?.code === 2);
});

test("submit and cancel are partition-scoped, owner-checked and idempotent", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  const submitInput = {
    commandId: "cmd-submit-1",
    partition: "gpu",
    scriptPath: "/home/alice/jobs/train.sh",
    args: ["--epochs", "2"],
  };
  const submitted = await service.submit(submitInput);
  assert.equal(submitted.jobId, "301");
  const submitCalls = executor.calls.filter((entry) => entry.parser === "slurm.submit.v1").length;
  const replay = await service.submit(submitInput);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(executor.calls.filter((entry) => entry.parser === "slurm.submit.v1").length, submitCalls);
  const concurrentInput = { ...submitInput, commandId: "cmd-submit-concurrent" };
  const concurrentCallsBefore = executor.calls.filter((entry) => entry.parser === "slurm.submit.v1").length;
  const concurrent = await Promise.all([service.submit(concurrentInput), service.submit(concurrentInput)]);
  assert.equal(concurrent.filter((entry) => entry.idempotentReplay).length, 1);
  assert.equal(executor.calls.filter((entry) => entry.parser === "slurm.submit.v1").length, concurrentCallsBefore + 1);
  executor.missingJob = true;
  const history = await service.jobHistory({ startDate: "2026-01-01", endDate: "2026-01-01" });
  executor.missingJob = false;
  assert.equal(history.find((entry) => entry.id === "301")?.state, "unknown");
  await assert.rejects(
    service.submit({ ...submitInput, commandId: "cmd-submit-admin", partition: "admin" }),
    (error) => error?.code === "SCHEDULER_SCOPE_VIOLATION",
  );

  const cancelled = await service.cancelJob({ commandId: "cmd-cancel-1", jobId: "101" });
  assert.equal(cancelled.cancelled, true);
  executor.jobOwner = "bob";
  await assert.rejects(
    service.cancelJob({ commandId: "cmd-cancel-2", jobId: "102" }),
    (error) => error?.code === "SCHEDULER_JOB_FORBIDDEN",
  );
});

test("direct submissions schedule the shared tracker without waiting for it or retrying the job", { timeout: 5000 }, async (t) => {
  let release, started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const called = new Promise((resolve) => { started = resolve; });
  t.after(() => release());
  const { executor, service } = await fixture(t, {
    onSubmitted: async (jobIds) => {
      started(jobIds);
      await blocked;
      throw new Error("background controller temporarily unavailable");
    },
  });
  await service.inspectCapabilities();
  const submitted = await service.submit({ commandId: "cmd-background-track", partition: "cpu", scriptPath: "/home/alice/cpu.sh", args: [] });
  assert.equal(submitted.jobId, "301", "the accepted submission returns before status tracking finishes");
  assert.deepEqual(await called, ["301"]);
  assert.deepEqual(await service.submissions.pending(), [{ jobId: "301" }], "the receipt is durable before the background callback");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executor.calls.filter((entry) => entry.parser === "slurm.submit.v1").length, 1, "a tracking failure never resubmits the job");
});

test("Slurm parser rejects prose and command descriptors reject injection", () => {
  const adapter = new SlurmSchedulerAdapter();
  assert.throws(() => adapter.parseAccessiblePartitions({ partitions: "GPU resources look idle", associations: "gpu|competition|normal" }), (error) => error?.code === "SCHEDULER_PARSE_FAILED");
  assert.throws(() => adapter.userJobs({ username: "alice; id" }), (error) => error?.code === "SCHEDULER_USERNAME_INVALID");
  assert.throws(() => adapter.resourceSummary({ partitions: ["gpu;id"] }), (error) => error?.code === "SCHEDULER_PARTITION_INVALID");
  assert.throws(() => adapter.inspectJob({ jobId: "101;id" }), (error) => error?.code === "SCHEDULER_JOB_ID_INVALID");
});

test("PBS is explicitly unavailable instead of emulating Slurm or parsing Agent text", async (t) => {
  const adapter = new PbsSchedulerAdapter();
  const profile = adapter.inspectCapabilities({
    serverIdentity: SERVER_IDENTITY,
    detectedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2026-01-01T00:10:00.000Z"),
  });
  assert.equal(profile.scheduler, "pbs");
  assert.equal(profile.features.userJobs.available, false);
  assert.equal(profile.features.jobHistory.available, false);
  assert.throws(() => adapter.userJobs({ username: "alice" }), (error) => error?.code === "SCHEDULER_OPERATION_UNSUPPORTED");

  const { service } = await fixture(t, { adapter });
  const persisted = await service.inspectCapabilities();
  assert.equal(persisted.scheduler, "pbs");
  await assert.rejects(service.userJobs(), (error) => error?.code === "SCHEDULER_CAPABILITY_UNAVAILABLE");
});

test("server authorization and authenticated Actor remain mandatory", async (t) => {
  const { service } = await fixture(t, { authorized: false });
  await assert.rejects(service.inspectCapabilities(), (error) => error?.code === "SERVER_FORBIDDEN");
});
