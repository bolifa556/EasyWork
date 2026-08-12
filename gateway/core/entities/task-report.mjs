import { invariant } from "../errors.mjs";
import {
  assertArray,
  assertEntityHeader,
  assertExactKeys,
  assertId,
  assertInteger,
  assertIsoTimestamp,
  assertNullableString,
  assertString,
  clone,
  createHeader,
  deepFreeze,
} from "./common.mjs";

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "entityType", "revision", "id", "actorId", "taskId", "conversationId", "branchId",
  "remoteFinal", "claims", "evidence", "changedFiles", "artifacts", "jobs", "usage",
  "generatedAt", "createdAt", "updatedAt",
]);

function optionalRecord(value, field, keys) {
  if (value === null) return null;
  assertExactKeys(value, keys, field);
  return value;
}

function validateRemoteFinal(value) {
  if (value === null) return null;
  optionalRecord(value, "TaskReport.remoteFinal", ["text", "eventSequence", "producer"]);
  assertString(value.text, "TaskReport.remoteFinal.text", { trim: false, min: 0, max: 2_000_000 });
  assertInteger(value.eventSequence, "TaskReport.remoteFinal.eventSequence", { min: 1 });
  assertString(value.producer, "TaskReport.remoteFinal.producer", { max: 256 });
  return value;
}

function validateClaim(value, field) {
  assertExactKeys(value, ["id", "text", "evidenceIds"], field);
  assertId(value.id, `${field}.id`);
  assertString(value.text, `${field}.text`, { trim: false, max: 65_536 });
  assertArray(value.evidenceIds, `${field}.evidenceIds`, (entry, itemField) => assertId(entry, itemField), { max: 10_000 });
  return value;
}

function validateEvidence(value, field) {
  assertExactKeys(value, ["id", "kind", "label", "eventSequence", "source", "details"], field);
  assertId(value.id, `${field}.id`);
  assertId(value.kind, `${field}.kind`);
  assertString(value.label, `${field}.label`, { trim: false, min: 0, max: 65_536 });
  assertInteger(value.eventSequence, `${field}.eventSequence`, { min: 1 });
  invariant(value.source && typeof value.source === "object" && !Array.isArray(value.source), "TASK_REPORT_EVIDENCE_SOURCE_INVALID", `${field}.source 无效`, { status: 400 });
  invariant(value.details && typeof value.details === "object" && !Array.isArray(value.details), "TASK_REPORT_EVIDENCE_DETAILS_INVALID", `${field}.details 无效`, { status: 400 });
  return value;
}

function validateChangedFile(value, field) {
  assertExactKeys(value, ["path", "action", "phase", "eventSequence", "details"], field);
  assertString(value.path, `${field}.path`, { trim: false, min: 0, max: 32_768 });
  assertString(value.action, `${field}.action`, { max: 256 });
  assertString(value.phase, `${field}.phase`, { max: 128 });
  assertInteger(value.eventSequence, `${field}.eventSequence`, { min: 1 });
  invariant(value.details && typeof value.details === "object" && !Array.isArray(value.details), "TASK_REPORT_FILE_DETAILS_INVALID", `${field}.details 无效`, { status: 400 });
  return value;
}

function validateArtifact(value, field) {
  assertExactKeys(value, ["artifactId", "name", "kind", "mime", "size"], field);
  assertId(value.artifactId, `${field}.artifactId`);
  assertNullableString(value.name, `${field}.name`, { trim: false, max: 512 });
  assertNullableString(value.kind, `${field}.kind`, { max: 128 });
  assertNullableString(value.mime, `${field}.mime`, { max: 512 });
  if (value.size !== null) assertInteger(value.size, `${field}.size`, { min: 0 });
  return value;
}

function validateJob(value, field) {
  assertExactKeys(value, ["id", "operation", "status", "message", "eventSequence", "details"], field);
  assertId(value.id, `${field}.id`);
  assertString(value.operation, `${field}.operation`, { max: 256 });
  assertString(value.status, `${field}.status`, { max: 128 });
  assertNullableString(value.message, `${field}.message`, { trim: false, max: 65_536 });
  assertInteger(value.eventSequence, `${field}.eventSequence`, { min: 1 });
  invariant(value.details && typeof value.details === "object" && !Array.isArray(value.details), "TASK_REPORT_JOB_DETAILS_INVALID", `${field}.details 无效`, { status: 400 });
  return value;
}

function validateUsage(value) {
  assertExactKeys(value, ["inputTokens", "outputTokens", "totalTokens", "toolCalls", "durationMs"], "TaskReport.usage");
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "toolCalls", "durationMs"]) {
    assertInteger(value[key], `TaskReport.usage.${key}`, { min: 0 });
  }
  return value;
}

export function validateTaskReport(report) {
  assertExactKeys(report, REPORT_KEYS, "TaskReport");
  assertEntityHeader(report, "TaskReport");
  assertId(report.id, "TaskReport.id");
  assertId(report.actorId, "TaskReport.actorId");
  assertId(report.taskId, "TaskReport.taskId");
  assertId(report.conversationId, "TaskReport.conversationId");
  assertId(report.branchId, "TaskReport.branchId");
  validateRemoteFinal(report.remoteFinal);
  assertArray(report.claims, "TaskReport.claims", validateClaim, { max: 10_000 });
  assertArray(report.evidence, "TaskReport.evidence", validateEvidence, { max: 50_000 });
  assertArray(report.changedFiles, "TaskReport.changedFiles", validateChangedFile, { max: 50_000 });
  assertArray(report.artifacts, "TaskReport.artifacts", validateArtifact, { max: 10_000 });
  assertArray(report.jobs, "TaskReport.jobs", validateJob, { max: 50_000 });
  validateUsage(report.usage);
  assertIsoTimestamp(report.generatedAt, "TaskReport.generatedAt");
  return true;
}

export function createTaskReport(input, options = {}) {
  assertExactKeys(input, [
    "id", "actorId", "taskId", "conversationId", "branchId", "remoteFinal", "claims", "evidence",
    "changedFiles", "artifacts", "jobs", "usage", "generatedAt",
  ], "TaskReportInput");
  const report = {
    ...createHeader("TaskReport", options),
    ...clone(input),
  };
  validateTaskReport(report);
  return deepFreeze(report);
}
