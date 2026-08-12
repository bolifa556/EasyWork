import path from "node:path";

import { ApiError, assertNoSensitiveFields, invariant } from "../errors.mjs";
import { assertId, assertServerIdentity } from "../entities/common.mjs";

export const SCHEDULER_SCHEMA_VERSION = 1;
export const SCHEDULER_TYPES = Object.freeze(["slurm", "pbs", "generic", "none"]);
export const SCHEDULER_FEATURES = Object.freeze([
  "accessiblePartitions",
  "resourceSummary",
  "userJobs",
  "jobHistory",
  "jobOutput",
  "submit",
  "cancelJob",
]);

export const SCHEDULER_JOB_STATES = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "unknown",
]);

const EXECUTABLES = new Set(["sinfo", "squeue", "scontrol", "sacct", "sacctmgr", "sbatch", "scancel"]);
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const PARTITION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const JOB_ID_PATTERN = /^[0-9]+(?:_[0-9]+)?(?:\.(?:batch|extern|[0-9]+))?$/;

export function assertSchedulerType(value) {
  const type = String(value || "");
  invariant(SCHEDULER_TYPES.includes(type), "SCHEDULER_TYPE_INVALID", "Scheduler 类型无效", { status: 400 });
  return type;
}

export function assertSshUsername(value) {
  const username = String(value || "");
  invariant(USER_PATTERN.test(username), "SCHEDULER_USERNAME_INVALID", "SSH 用户名无法用于 Scheduler 查询", { status: 400 });
  return username;
}

export function assertPartitionName(value, field = "partition") {
  const partition = String(value || "").replace(/\*$/, "");
  invariant(PARTITION_PATTERN.test(partition), "SCHEDULER_PARTITION_INVALID", `${field} 无效`, { status: 400 });
  return partition;
}

export function assertJobId(value) {
  const jobId = String(value || "");
  invariant(JOB_ID_PATTERN.test(jobId), "SCHEDULER_JOB_ID_INVALID", "Scheduler Job ID 无效", { status: 400 });
  return jobId;
}

export function assertCommandId(value) {
  return assertId(value, "commandId");
}

export function canonicalSchedulerFilePath(value, field = "outputPath") {
  const source = String(value || "").replace(/\\/g, "/");
  invariant(path.posix.isAbsolute(source), "SCHEDULER_OUTPUT_PATH_INVALID", `${field} 必须是远端绝对路径`, { status: 400 });
  const normalized = path.posix.normalize(source);
  invariant(normalized !== "/" && !normalized.includes("\0"), "SCHEDULER_OUTPUT_PATH_INVALID", `${field} 无效`, { status: 400 });
  return normalized;
}

export function createExecDescriptor(input) {
  const executable = String(input?.executable || "");
  invariant(EXECUTABLES.has(executable), "SCHEDULER_EXECUTABLE_FORBIDDEN", "Scheduler 命令不在允许列表中", { status: 500, expose: false });
  invariant(Array.isArray(input?.argv) && input.argv.length <= 128, "SCHEDULER_ARGV_INVALID", "Scheduler argv 无效", { status: 500, expose: false });
  const argv = input.argv.map((value, index) => {
    const argument = String(value);
    invariant(argument.length <= 4096 && !argument.includes("\0") && !argument.includes("\r") && !argument.includes("\n"), "SCHEDULER_ARGV_INVALID", `Scheduler argv[${index}] 无效`, { status: 500, expose: false });
    return argument;
  });
  const descriptor = {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    kind: "exec",
    executable,
    argv,
    stdin: null,
    shell: false,
    readOnly: input.readOnly !== false,
    parser: assertId(input?.parser, "parser"),
    timeoutMs: Number(input?.timeoutMs ?? 15_000),
    maxOutputBytes: Number(input?.maxOutputBytes ?? 2 * 1024 * 1024),
  };
  invariant(Number.isSafeInteger(descriptor.timeoutMs) && descriptor.timeoutMs > 0 && descriptor.timeoutMs <= 120_000, "SCHEDULER_TIMEOUT_INVALID", "Scheduler timeout 无效", { status: 500, expose: false });
  invariant(Number.isSafeInteger(descriptor.maxOutputBytes) && descriptor.maxOutputBytes > 0 && descriptor.maxOutputBytes <= 32 * 1024 * 1024, "SCHEDULER_OUTPUT_LIMIT_INVALID", "Scheduler 输出上限无效", { status: 500, expose: false });
  assertNoSensitiveFields(descriptor);
  return Object.freeze(descriptor);
}

export function createFileRangeDescriptor(input) {
  const offset = Number(input?.offset ?? 0);
  const maxBytes = Number(input?.maxBytes ?? 256 * 1024);
  invariant(Number.isSafeInteger(offset) && offset >= 0, "SCHEDULER_OUTPUT_CURSOR_INVALID", "Job output cursor 无效", { status: 400 });
  invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024 * 1024, "SCHEDULER_OUTPUT_LIMIT_INVALID", "Job output 页大小无效", { status: 400 });
  return Object.freeze({
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    kind: "remote-file-range",
    jobId: assertJobId(input?.jobId),
    path: canonicalSchedulerFilePath(input?.path),
    offset,
    maxBytes,
    readOnly: true,
    parser: "scheduler.job-output-bytes.v1",
  });
}

export function normalizeExecutionResult(result, descriptor) {
  invariant(result && typeof result === "object" && !Array.isArray(result), "SCHEDULER_EXECUTION_RESULT_INVALID", "Scheduler 执行结果无效", { status: 500, expose: false });
  const code = Number(result.code);
  invariant(Number.isSafeInteger(code), "SCHEDULER_EXECUTION_RESULT_INVALID", "Scheduler 退出码无效", { status: 500, expose: false });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout || ""));
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(String(result.stderr || ""));
  invariant(stdout.length <= descriptor.maxOutputBytes && stderr.length <= descriptor.maxOutputBytes, "SCHEDULER_OUTPUT_TOO_LARGE", "Scheduler 命令输出超过限制", { status: 502 });
  return { code, stdout, stderr };
}

export function schedulerCommandFailure(descriptor, result) {
  return new ApiError("SCHEDULER_COMMAND_FAILED", `${descriptor.executable} 执行失败`, {
    status: 502,
    details: { executable: descriptor.executable, code: result.code, stderr: result.stderr.toString("utf8").slice(0, 4096) },
  });
}

export function createUnavailableFeature(reason) {
  return Object.freeze({ available: false, reason: String(reason || "unavailable") });
}

export function createAvailableFeature() {
  return Object.freeze({ available: true, reason: null });
}

export function validateSchedulerAdapter(adapter) {
  invariant(adapter && typeof adapter === "object", "SCHEDULER_ADAPTER_INVALID", "Scheduler adapter 无效", { status: 500, expose: false });
  invariant(SCHEDULER_TYPES.includes(adapter.type) && typeof adapter.inspectCapabilities === "function", "SCHEDULER_ADAPTER_INVALID", "Scheduler adapter 契约不完整", { status: 500, expose: false });
  for (const method of ["accessiblePartitions", "resourceSummary", "userJobs", "inspectJob", "jobOutput", "submit", "cancelJob"]) {
    invariant(typeof adapter[method] === "function", "SCHEDULER_ADAPTER_INVALID", `Scheduler adapter 缺少 ${method}`, { status: 500, expose: false });
  }
  return adapter;
}

export function createCapabilityProfile(input) {
  const features = {};
  for (const feature of SCHEDULER_FEATURES) {
    const candidate = input?.features?.[feature];
    invariant(candidate && typeof candidate.available === "boolean", "SCHEDULER_CAPABILITY_INVALID", `Scheduler capability ${feature} 无效`, { status: 500, expose: false });
    features[feature] = candidate.available ? createAvailableFeature() : createUnavailableFeature(candidate.reason);
  }
  const detectedAt = new Date(input?.detectedAt).toISOString();
  const expiresAt = new Date(input?.expiresAt).toISOString();
  invariant(expiresAt > detectedAt, "SCHEDULER_CAPABILITY_EXPIRY_INVALID", "Scheduler capability 过期时间无效", { status: 500, expose: false });
  return Object.freeze({
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    serverIdentity: assertServerIdentity(input?.serverIdentity),
    scheduler: assertSchedulerType(input?.scheduler),
    commands: Object.freeze(Object.fromEntries(Object.entries(input?.commands || {}).map(([name, available]) => [String(name), Boolean(available)]))),
    features: Object.freeze(features),
    partitionsOrQueues: Object.freeze((input?.partitionsOrQueues || []).map((entry) => structuredClone(entry))),
    detectedAt,
    expiresAt,
  });
}

export function schedulerUnsupported(type, operation, reason) {
  throw new ApiError("SCHEDULER_OPERATION_UNSUPPORTED", `${type} 不支持 ${operation}`, {
    status: 409,
    details: { scheduler: type, operation, reason: String(reason || "unsupported") },
  });
}
