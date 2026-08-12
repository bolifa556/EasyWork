import crypto from "node:crypto";

import { invariant } from "../errors.mjs";

export const TASK_COMMAND_TYPES = Object.freeze(["create", "start", "append", "interrupt", "resume"]);
export const TASK_COMMAND_STATUSES = Object.freeze(["accepted", "running", "completed", "failed"]);

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertCommandId(commandId) {
  const value = String(commandId || "");
  invariant(COMMAND_ID_PATTERN.test(value), "TASK_COMMAND_ID_INVALID", "commandId 格式无效", { status: 400 });
  return value;
}

export function commandFingerprint(type, input) {
  invariant(TASK_COMMAND_TYPES.includes(type), "TASK_COMMAND_TYPE_INVALID", `未知 Task command: ${type}`, { status: 400 });
  return crypto.createHash("sha256").update(canonicalJson({ type, input })).digest("hex");
}

export function taskTopic(taskId) {
  const digest = crypto.createHash("sha256").update(String(taskId)).digest("hex").slice(0, 32);
  return `task:${digest}`;
}

export function createCommandRecord({ taskId, commandId, type, fingerprint, clock }) {
  const now = (clock || (() => new Date()))().toISOString();
  return Object.freeze({
    schemaVersion: 1,
    taskId: String(taskId),
    commandId: assertCommandId(commandId),
    type: String(type),
    fingerprint: String(fingerprint),
    status: "accepted",
    result: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
  });
}

export function formatContextPrompt(delivery, goal) {
  const sections = [];
  for (const entry of delivery?.entries || []) {
    const value = String(entry?.content?.value || "");
    if (!value) continue;
    sections.push(`<context kind="${String(entry.kind || "context")}" source="${String(entry.source?.type || "unknown")}">\n${value}\n</context>`);
  }
  if (sections.length === 0) return String(goal || "");
  return `${sections.join("\n\n")}\n\n<task>\n${String(goal || "")}\n</task>`;
}

export function assertOrchestratorDependencies(dependencies) {
  const requiredMethods = {
    taskStore: ["claimCommand", "getCommand", "updateCommand", "createTask", "getTask", "saveTask"],
    runtime: ["launch", "loadBinding", "saveBinding"],
    transport: ["execute"],
    contextHub: ["assemble", "deliveryForBinding", "acknowledge"],
    journal: ["append"],
    workspaceService: ["prepare"],
    versionService: ["prepare", "recordFileChange", "finalize"],
    artifactService: ["capture"],
    skillService: ["prepare"],
    reportService: ["generate", "get"],
  };
  for (const [name, methods] of Object.entries(requiredMethods)) {
    const service = dependencies?.[name];
    invariant(service && typeof service === "object", "TASK_ORCHESTRATOR_DEPENDENCY_MISSING", `缺少 ${name}`, {
      status: 500,
      expose: false,
    });
    for (const method of methods) {
      invariant(typeof service[method] === "function", "TASK_ORCHESTRATOR_DEPENDENCY_INVALID", `${name}.${method} 无效`, {
        status: 500,
        expose: false,
      });
    }
  }
  const adapters = dependencies?.adapters;
  invariant(adapters && (adapters instanceof Map || typeof adapters === "object"), "TASK_ORCHESTRATOR_DEPENDENCY_MISSING", "缺少 Agent adapter registry", {
    status: 500,
    expose: false,
  });
}

export function isAsyncIterable(value) {
  return Boolean(value && typeof value[Symbol.asyncIterator] === "function");
}
