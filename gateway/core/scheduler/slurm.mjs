import { invariant } from "../errors.mjs";
import {
  SCHEDULER_JOB_STATES,
  assertJobId,
  assertPartitionName,
  assertSshUsername,
  canonicalSchedulerFilePath,
  createAvailableFeature,
  createCapabilityProfile,
  createExecDescriptor,
  createFileRangeDescriptor,
  createUnavailableFeature,
} from "./contract.mjs";

const PIPE = "|";

function text(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
}

function lines(value) {
  return text(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function fields(line, count, parser) {
  const values = line.split(PIPE).map((value) => value.trim());
  invariant(values.length === count, "SCHEDULER_PARSE_FAILED", `${parser} 返回的字段数量无效`, { status: 502, details: { parser, line: line.slice(0, 1024) } });
  return values;
}

function nonNegativeInteger(value, field) {
  const result = Number(value);
  invariant(Number.isSafeInteger(result) && result >= 0, "SCHEDULER_PARSE_FAILED", `${field} 不是非负整数`, { status: 502 });
  return result;
}

function stateName(value) {
  const source = String(value || "").trim().toUpperCase();
  const map = {
    PD: "pending", PENDING: "pending", CF: "pending", CONFIGURING: "pending",
    R: "running", RUNNING: "running", CG: "running", COMPLETING: "running",
    CD: "completed", COMPLETED: "completed",
    F: "failed", FAILED: "failed", NF: "failed", NODE_FAIL: "failed", OOM: "failed", OUT_OF_MEMORY: "failed",
    CA: "cancelled", CANCELLED: "cancelled", PR: "cancelled", PREEMPTED: "cancelled",
    TO: "timeout", TIMEOUT: "timeout",
  };
  const normalized = map[source] || "unknown";
  invariant(SCHEDULER_JOB_STATES.includes(normalized), "SCHEDULER_PARSE_FAILED", "Slurm Job 状态无效", { status: 502 });
  return normalized;
}

function nodeState(value) {
  const source = String(value || "").toLowerCase().replace(/[+*~#$@%!-]+$/g, "");
  if (source.startsWith("idle")) return "idle";
  if (source.startsWith("alloc")) return "allocated";
  if (source.startsWith("mix")) return "mixed";
  return "unavailable";
}

function parseCpuBreakdown(value) {
  const numbers = String(value || "").split("/").map(Number);
  invariant(numbers.length === 4 && numbers.every((entry) => Number.isSafeInteger(entry) && entry >= 0), "SCHEDULER_PARSE_FAILED", "Slurm CPU 汇总无效", { status: 502 });
  return { allocated: numbers[0], idle: numbers[1], unavailable: numbers[2], total: numbers[3] };
}

function parseGpuPerNode(gres) {
  let total = 0;
  for (const entry of String(gres || "").split(",")) {
    const match = entry.trim().match(/^gpu(?::[^:(),]+)?:(\d+)(?:\([^)]*\))?$/i);
    if (match) total += Number(match[1]);
  }
  return total;
}

function zeroBreakdown() {
  return { idle: 0, allocated: 0, mixed: 0, unavailable: 0, total: 0 };
}

function addBreakdown(target, state, amount) {
  target[state] += amount;
  target.total += amount;
}

function normalizeJobObject(raw) {
  const jobId = assertJobId(raw.job_id ?? raw.jobId ?? raw.job_id_raw);
  const owner = String(raw.user_name ?? raw.user ?? raw.owner ?? "");
  const stdoutPath = raw.standard_output ?? raw.stdout ?? raw.std_out ?? raw.command?.stdout ?? null;
  const stderrPath = raw.standard_error ?? raw.stderr ?? raw.std_err ?? raw.command?.stderr ?? null;
  return {
    jobId,
    owner,
    name: String(raw.name ?? raw.job_name ?? ""),
    partition: raw.partition ? assertPartitionName(raw.partition) : null,
    state: stateName(raw.job_state?.[0] ?? raw.job_state ?? raw.state?.current?.[0] ?? raw.state ?? "unknown"),
    stdoutPath: stdoutPath ? canonicalSchedulerFilePath(String(stdoutPath)) : null,
    stderrPath: stderrPath ? canonicalSchedulerFilePath(String(stderrPath)) : null,
  };
}

export class SlurmSchedulerAdapter {
  type = "slurm";

  capabilityProbeDescriptors() {
    return ["sinfo", "squeue", "scontrol", "sacct", "sacctmgr", "sbatch", "scancel"].map((executable) => createExecDescriptor({
      executable,
      argv: ["--version"],
      parser: "slurm.version.v1",
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    }));
  }

  inspectCapabilities(input) {
    const commandResults = input?.commandResults || {};
    const commands = {};
    for (const executable of ["sinfo", "squeue", "scontrol", "sacct", "sacctmgr", "sbatch", "scancel"]) {
      const result = commandResults[executable];
      commands[executable] = Boolean(result && result.code === 0 && /slurm/i.test(text(result.stdout)));
    }
    const available = commands.sinfo && commands.squeue && commands.scontrol;
    const reason = "Slurm 命令不可用";
    return createCapabilityProfile({
      serverIdentity: input.serverIdentity,
      scheduler: available ? "slurm" : "none",
      commands,
      features: {
        accessiblePartitions: commands.sinfo && commands.sacctmgr ? createAvailableFeature() : createUnavailableFeature(reason),
        resourceSummary: commands.sinfo && commands.sacctmgr ? createAvailableFeature() : createUnavailableFeature(reason),
        userJobs: commands.squeue ? createAvailableFeature() : createUnavailableFeature(reason),
        jobHistory: createUnavailableFeature("Slurm 历史作业查询尚未暴露为 EasyWork adapter 操作"),
        jobOutput: commands.scontrol ? createAvailableFeature() : createUnavailableFeature(reason),
        submit: commands.sbatch && commands.sinfo && commands.sacctmgr ? createAvailableFeature() : createUnavailableFeature(reason),
        cancelJob: commands.scancel && commands.scontrol ? createAvailableFeature() : createUnavailableFeature(reason),
      },
      partitionsOrQueues: [],
      detectedAt: input.detectedAt,
      expiresAt: input.expiresAt,
    });
  }

  accessiblePartitions(input) {
    const username = assertSshUsername(input?.username);
    return {
      descriptors: [
        createExecDescriptor({
          executable: "sinfo",
          argv: ["--noheader", "--format=%P|%a|%l|%D|%t|%G"],
          parser: "slurm.partitions.v1",
        }),
        createExecDescriptor({
          executable: "sacctmgr",
          argv: ["--noheader", "--parsable2", "show", "association", `where`, `user=${username}`, "format=Partition,Account,QOS"],
          parser: "slurm.associations.v1",
        }),
      ],
      parse: (outputs) => this.parseAccessiblePartitions(outputs),
    };
  }

  parseAccessiblePartitions(outputs) {
    const associations = lines(outputs?.associations).map((line) => {
      const [partition, account, qos] = fields(line, 3, "slurm.associations.v1");
      return { partition: partition ? assertPartitionName(partition) : null, account, qos };
    });
    const unrestricted = associations.some((entry) => entry.partition === null);
    const allowed = new Set(associations.filter((entry) => entry.partition).map((entry) => entry.partition));
    const byName = new Map();
    for (const line of lines(outputs?.partitions)) {
      const [rawName, availability, timeLimit, rawNodes, rawState, gres] = fields(line, 6, "slurm.partitions.v1");
      const name = assertPartitionName(rawName);
      if (!unrestricted && !allowed.has(name)) continue;
      const current = byName.get(name) || {
        id: name,
        name,
        isDefault: rawName.endsWith("*"),
        availability,
        timeLimit,
        nodes: 0,
        states: new Set(),
        gres: new Set(),
        accounts: new Set(),
        qos: new Set(),
      };
      current.nodes += nonNegativeInteger(rawNodes, "partition.nodes");
      current.states.add(nodeState(rawState));
      if (gres && gres !== "(null)" && gres !== "N/A") current.gres.add(gres);
      for (const association of associations.filter((entry) => entry.partition === null || entry.partition === name)) {
        if (association.account) current.accounts.add(association.account);
        if (association.qos) current.qos.add(association.qos);
      }
      byName.set(name, current);
    }
    return [...byName.values()].map((entry) => ({
      ...entry,
      states: [...entry.states].sort(),
      gres: [...entry.gres].sort(),
      accounts: [...entry.accounts].sort(),
      qos: [...entry.qos].sort(),
    })).sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
  }

  resourceSummary(input) {
    const partitions = [...new Set((input?.partitions || []).map((value) => assertPartitionName(value)))].sort();
    invariant(partitions.length > 0 && partitions.length <= 128, "SCHEDULER_PARTITIONS_REQUIRED", "资源汇总需要可访问分区", { status: 400 });
    const descriptor = createExecDescriptor({
      executable: "sinfo",
      argv: ["--noheader", `--partition=${partitions.join(",")}`, "--format=%P|%t|%D|%C|%G"],
      parser: "slurm.resources.v1",
    });
    return { descriptor, parse: (output) => this.parseResourceSummary(output, partitions) };
  }

  parseResourceSummary(output, partitions) {
    const allowed = new Set(partitions.map((value) => assertPartitionName(value)));
    const nodes = zeroBreakdown();
    const cpuCores = { idle: 0, allocated: 0, mixed: 0, unavailable: 0, total: 0 };
    const accelerators = zeroBreakdown();
    for (const line of lines(output)) {
      const [rawPartition, rawState, rawNodes, rawCpu, gres] = fields(line, 5, "slurm.resources.v1");
      const partition = assertPartitionName(rawPartition);
      invariant(allowed.has(partition), "SCHEDULER_SCOPE_VIOLATION", "资源汇总包含未授权分区", { status: 502, details: { partition } });
      const count = nonNegativeInteger(rawNodes, "resource.nodes");
      const state = nodeState(rawState);
      addBreakdown(nodes, state, count);
      const cpus = parseCpuBreakdown(rawCpu);
      cpuCores.allocated += cpus.allocated;
      cpuCores.idle += cpus.idle;
      cpuCores.unavailable += cpus.unavailable;
      cpuCores.mixed += state === "mixed" ? Math.max(0, cpus.total - cpus.allocated - cpus.idle - cpus.unavailable) : 0;
      cpuCores.total += cpus.total;
      addBreakdown(accelerators, state, parseGpuPerNode(gres) * count);
    }
    return {
      scope: { partitionIds: [...allowed].sort(), label: [...allowed].sort().join(", ") },
      nodes,
      cpuCores,
      accelerators: { ...accelerators, unit: "device" },
    };
  }

  userJobs(input) {
    const username = assertSshUsername(input?.username);
    const descriptor = createExecDescriptor({
      executable: "squeue",
      argv: ["--noheader", `--user=${username}`, "--format=%i|%j|%P|%T|%M|%L|%D|%C|%R"],
      parser: "slurm.jobs.v1",
    });
    return { descriptor, parse: (output) => this.parseUserJobs(output, username) };
  }

  parseUserJobs(output, usernameValue) {
    const username = assertSshUsername(usernameValue);
    return lines(output).map((line) => {
      const [jobId, name, partition, state, elapsed, timeLeft, nodes, cpus, locationOrReason] = fields(line, 9, "slurm.jobs.v1");
      return {
        id: assertJobId(jobId),
        scheduler: "slurm",
        owner: username,
        name,
        partition: assertPartitionName(partition),
        state: stateName(state),
        elapsed,
        timeLeft,
        nodes: nonNegativeInteger(nodes, "job.nodes"),
        cpuCores: nonNegativeInteger(cpus, "job.cpuCores"),
        locationOrReason,
      };
    });
  }

  inspectJob(input) {
    const jobId = assertJobId(input?.jobId);
    const descriptor = createExecDescriptor({
      executable: "scontrol",
      argv: ["show", "job", "--json", jobId],
      parser: "slurm.job-inspect.v1",
    });
    return { descriptor, parse: (output) => this.parseJob(output, jobId) };
  }

  parseJob(output, expectedJobId) {
    let parsed;
    try {
      parsed = typeof output === "string" || Buffer.isBuffer(output) ? JSON.parse(text(output)) : structuredClone(output);
    } catch (error) {
      invariant(false, "SCHEDULER_PARSE_FAILED", "Slurm Job JSON 无效", { status: 502, details: { reason: error.message } });
    }
    const jobs = parsed?.jobs ?? parsed?.job ?? [];
    invariant(Array.isArray(jobs) && jobs.length === 1, "SCHEDULER_PARSE_FAILED", "Slurm Job 查询未返回唯一作业", { status: 502 });
    const job = normalizeJobObject(jobs[0]);
    invariant(job.jobId === assertJobId(expectedJobId), "SCHEDULER_JOB_ID_MISMATCH", "Slurm 返回了其他作业", { status: 502 });
    return job;
  }

  jobOutput(input) {
    const username = assertSshUsername(input?.username);
    const job = input?.job;
    invariant(job?.owner === username, "SCHEDULER_JOB_FORBIDDEN", "不能读取其他用户的作业输出", { status: 403 });
    const stream = input?.stream || "stdout";
    invariant(["stdout", "stderr"].includes(stream), "SCHEDULER_OUTPUT_STREAM_INVALID", "作业输出流无效", { status: 400 });
    const outputPath = stream === "stdout" ? job.stdoutPath : job.stderrPath;
    invariant(outputPath, "SCHEDULER_OUTPUT_UNAVAILABLE", "该作业没有可读取的输出路径", { status: 404 });
    return createFileRangeDescriptor({
      jobId: job.jobId,
      path: outputPath,
      offset: input?.offset ?? 0,
      maxBytes: input?.maxBytes,
    });
  }

  submit(input) {
    const partition = assertPartitionName(input?.partition);
    const scriptPath = canonicalSchedulerFilePath(input?.scriptPath, "scriptPath");
    const args = (input?.args || []).map((value, index) => {
      const result = String(value);
      invariant(result.length <= 4096 && !/[\0\r\n]/.test(result), "SCHEDULER_SUBMIT_ARG_INVALID", `args[${index}] 无效`, { status: 400 });
      return result;
    });
    const descriptor = createExecDescriptor({
      executable: "sbatch",
      argv: ["--parsable", `--partition=${partition}`, scriptPath, ...args],
      parser: "slurm.submit.v1",
      readOnly: false,
      timeoutMs: 30_000,
    });
    return {
      descriptor,
      parse: (output) => {
        const value = text(output).trim().split(";")[0];
        return { jobId: assertJobId(value), scheduler: "slurm" };
      },
    };
  }

  cancelJob(input) {
    const descriptor = createExecDescriptor({
      executable: "scancel",
      argv: [assertJobId(input?.jobId)],
      parser: "slurm.cancel.v1",
      readOnly: false,
    });
    return { descriptor, parse: () => ({ jobId: assertJobId(input?.jobId), cancelled: true }) };
  }
}
