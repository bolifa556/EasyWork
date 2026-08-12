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
  "gpu|idle|2|0/256/0/256|gpu:RTX5090:8",
  "gpu|mix|1|64/64/0/128|gpu:RTX5090:8",
  "cpu|idle|4|0/512/0/512|(null)",
].join("\n");

const JOBS_FIXTURE = [
  "101|training|gpu|RUNNING|00:02:00|01:58:00|1|16|node01",
  "102|analysis|cpu|PENDING|00:00:00|02:00:00|1|8|Resources",
].join("\n");

class FixtureExecutor {
  calls = [];
  readCalls = [];
  jobOwner = "alice";

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
    if (descriptor.parser === "slurm.job-inspect.v1") {
      const jobId = descriptor.argv.at(-1);
      return {
        code: 0,
        stdout: JSON.stringify({
          jobs: [{
            job_id: jobId,
            user_name: this.jobOwner,
            name: "training",
            partition: "gpu",
            job_state: "RUNNING",
            standard_output: `/home/alice/logs/slurm-${jobId}.out`,
            standard_error: `/home/alice/logs/slurm-${jobId}.err`,
          }],
        }),
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
  assert.deepEqual(summary.currentUserJobs, { running: 1, pending: 1 });
  assert.match(summary.sampledAt, /^2026-01-01T/);

  await assert.rejects(service.resourceSummary({ partitions: ["admin"] }), (error) => error?.code === "SCHEDULER_SCOPE_VIOLATION");
});

test("user jobs and output use structured descriptors and reject another owner's job", async (t) => {
  const { executor, service } = await fixture(t);
  await service.inspectCapabilities();
  const jobs = await service.userJobs();
  assert.deepEqual(jobs.map((job) => [job.id, job.owner, job.state]), [
    ["101", "alice", "running"],
    ["102", "alice", "pending"],
  ]);
  const output = await service.jobOutput({ jobId: "101", stream: "stdout", offset: 8, maxBytes: 1024 });
  assert.equal(output.offset, 8);
  assert.equal(output.nextOffset, 8 + output.bytes.length);
  assert.equal(executor.readCalls[0].path, "/home/alice/logs/slurm-101.out");

  executor.jobOwner = "bob";
  await assert.rejects(service.jobOutput({ jobId: "101" }), (error) => error?.code === "SCHEDULER_JOB_FORBIDDEN");
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
