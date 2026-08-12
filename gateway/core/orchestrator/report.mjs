import fs from "node:fs/promises";

import { invariant, redactSensitive } from "../errors.mjs";
import { createTaskReport, validateTaskReport } from "../entities/task-report.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import { taskTopic } from "./contract.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function eventPayload(envelope) {
  const payload = envelope?.payload?.event;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? clone(payload) : {};
}

function sourceOf(envelope) {
  const source = envelope?.payload?.source;
  return source && typeof source === "object" && !Array.isArray(source) ? clone(source) : {};
}

function textOf(value) {
  for (const candidate of [value?.text, value?.content, value?.message, value?.summary, value?.output]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? clone(redactSensitive(value)) : {};
}

function pathsFromFileEvent(payload) {
  const candidates = [];
  if (typeof payload.path === "string") candidates.push(payload.path);
  for (const entry of Array.isArray(payload.files) ? payload.files : []) {
    if (typeof entry === "string") candidates.push(entry);
    else if (entry && typeof entry === "object") candidates.push(entry.path || entry.file || entry.name || "");
  }
  for (const entry of Array.isArray(payload.changes) ? payload.changes : []) {
    if (entry && typeof entry === "object") candidates.push(entry.path || entry.file || entry.name || "");
  }
  return [...new Set(candidates.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function usageFromEvents(events, task) {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const toolCalls = new Set();
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.kind === "usage") {
      inputTokens = Math.max(inputTokens, Number(payload.inputTokens ?? payload.input_tokens ?? payload.input ?? 0) || 0);
      outputTokens = Math.max(outputTokens, Number(payload.outputTokens ?? payload.output_tokens ?? payload.output ?? 0) || 0);
      totalTokens = Math.max(totalTokens, Number(payload.totalTokens ?? payload.total_tokens ?? payload.total ?? 0) || 0);
    }
    if (event.kind === "tool_call") toolCalls.add(String(payload.callId || sourceOf(event).itemId || event.sequence));
  }
  totalTokens = Math.max(totalTokens, inputTokens + outputTokens);
  const started = task.startedAt ? Date.parse(task.startedAt) : Date.parse(task.createdAt);
  const completed = task.completedAt ? Date.parse(task.completedAt) : Date.parse(task.updatedAt);
  return {
    inputTokens: Math.max(0, Math.round(inputTokens)),
    outputTokens: Math.max(0, Math.round(outputTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    toolCalls: toolCalls.size,
    durationMs: Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0,
  };
}

async function replayAll(journal, topic) {
  const events = [];
  let afterSequence = 0;
  for (;;) {
    const page = await journal.replay(topic, { afterSequence, limit: 2_000 });
    events.push(...page.events);
    if (!page.hasMore) return events;
    afterSequence = page.nextAfterSequence;
  }
}

function validateStored(data, taskId) {
  return Boolean(data && Object.keys(data).length === 1 && (data.report === null || (
    validateTaskReport(data.report) && data.report.taskId === taskId
  )));
}

function isDiscardableDerivedReportError(error) {
  const code = String(error?.code || "");
  return code === "REPOSITORY_CORRUPT"
    || code === "SCHEMA_VERSION_MISMATCH"
    || code === "ENTITY_VALIDATION_FAILED"
    || code.startsWith("ENTITY_")
    || code.startsWith("TASK_REPORT_");
}

export class TaskReportService {
  constructor({ dataRoot, actor, queue, clock, taskStore, journal, artifactService = null }) {
    invariant(taskStore && typeof taskStore.getTask === "function", "TASK_REPORT_TASK_STORE_REQUIRED", "TaskReport 缺少 Task store", { status: 500, expose: false });
    invariant(journal && typeof journal.replay === "function", "TASK_REPORT_JOURNAL_REQUIRED", "TaskReport 缺少 canonical journal", { status: 500, expose: false });
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue || defaultActorMutationQueue;
    this.clock = clock || (() => new Date());
    this.taskStore = taskStore;
    this.journal = journal;
    this.artifactService = artifactService;
  }

  #repository(taskId) {
    const id = String(taskId || "");
    invariant(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id), "TASK_REPORT_TASK_ID_INVALID", "TaskReport taskId 无效", { status: 400 });
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["tasks", id, "report.json"],
      schemaVersion: 1,
      defaultData: () => ({ report: null }),
      validate: (data) => validateStored(data, id),
      queue: this.queue,
    });
  }

  #reportPath(taskId) {
    return resolveActorPath(this.dataRoot, this.actor, "tasks", String(taskId), "report.json");
  }

  async #readReportRepository(taskId) {
    const repository = this.#repository(taskId);
    try {
      return { repository, snapshot: await repository.read() };
    } catch (error) {
      if (!isDiscardableDerivedReportError(error)) throw error;
      // TaskReport is a projection of the canonical task journal. A report written
      // by an obsolete or interrupted build must never prevent the actor container
      // from starting; discard only this derived projection and rebuild it below.
      await this.queue.run(this.actor, () => fs.rm(this.#reportPath(taskId), { force: true }));
      return { repository, snapshot: await repository.read() };
    }
  }

  async get(taskId, { required = true } = {}) {
    const task = await this.taskStore.getTask(String(taskId));
    invariant(task, "TASK_NOT_FOUND", "Task 不存在", { status: 404 });
    const { snapshot } = await this.#readReportRepository(task.id);
    const report = snapshot.data.report;
    if (required) invariant(report, "TASK_REPORT_NOT_READY", "Task 报告尚未生成", { status: 409, retryable: true });
    return clone(report);
  }

  async generate({ task, finalEvent = null, finalizer = null }) {
    invariant(task?.actorId === this.actor.actorId, "TASK_REPORT_ACTOR_MISMATCH", "TaskReport 不属于当前 Actor", { status: 403 });
    invariant(["completed", "failed", "cancelled"].includes(task.status), "TASK_REPORT_TASK_NOT_TERMINAL", "只有终态 Task 才能生成报告", { status: 409 });
    const events = await replayAll(this.journal, taskTopic(task.id));
    const finalEnvelope = [...events].reverse().find((entry) => entry.kind === "final") || null;
    const finalPayload = finalEnvelope ? eventPayload(finalEnvelope) : safeObject(finalEvent?.payload);
    const remoteText = textOf(finalPayload);
    const evidence = [];
    const changedFiles = [];
    const jobs = [];
    for (const envelope of events) {
      if (!["plan", "tool_result", "file_change", "job_status", "artifact", "final", "error"].includes(envelope.kind)) continue;
      const payload = eventPayload(envelope);
      const source = sourceOf(envelope);
      const label = textOf(payload) || String(payload.name || payload.operation || payload.action || envelope.kind);
      const evidenceId = `evidence_${envelope.sequence}`;
      evidence.push({ id: evidenceId, kind: envelope.kind, label, eventSequence: envelope.sequence, source, details: safeObject(payload) });
      if (envelope.kind === "file_change") {
        for (const filePath of pathsFromFileEvent(payload)) {
          changedFiles.push({
            path: filePath,
            action: String(payload.action || "change"),
            phase: String(envelope.status || "updated"),
            eventSequence: envelope.sequence,
            details: safeObject(payload),
          });
        }
      }
      if (envelope.kind === "job_status") {
        jobs.push({
          id: String(payload.jobId || payload.id || source.itemId || `job_${envelope.sequence}`),
          operation: String(payload.operation || payload.type || "job"),
          status: String(envelope.status || payload.status || "updated"),
          message: textOf(payload) || null,
          eventSequence: envelope.sequence,
          details: safeObject(payload),
        });
      }
    }
    const artifacts = [];
    for (const artifactId of task.artifactIds) {
      let detail = null;
      try { detail = await this.artifactService?.get?.({ artifactId }); } catch { /* event remains evidence */ }
      artifacts.push({
        artifactId,
        name: detail?.name == null ? null : String(detail.name),
        kind: detail?.kind == null ? null : String(detail.kind),
        mime: detail?.mime == null ? null : String(detail.mime),
        size: Number.isSafeInteger(detail?.size) && detail.size >= 0 ? detail.size : null,
      });
    }
    const finalizerClaims = Array.isArray(finalizer?.claims) ? finalizer.claims : [];
    const claims = finalizerClaims.length
      ? finalizerClaims.map((claim, index) => ({
          id: String(claim?.id || `claim_${index + 1}`),
          text: String(claim?.text || ""),
          evidenceIds: [...new Set((claim?.evidenceIds || []).map(String).filter((id) => evidence.some((entry) => entry.id === id)))],
        })).filter((claim) => claim.text)
      : (remoteText ? [{ id: "claim_remote_final", text: remoteText, evidenceIds: evidence.map((entry) => entry.id) }] : []);
    const report = createTaskReport({
      id: `report_${task.id}`,
      actorId: task.actorId,
      taskId: task.id,
      conversationId: task.conversationId,
      branchId: task.branchId,
      remoteFinal: remoteText ? {
        text: remoteText,
        eventSequence: finalEnvelope?.sequence || Math.max(1, task.taskEventSequence),
        producer: String(finalEnvelope?.producer || finalEvent?.producer?.adapter || task.route.agentId),
      } : null,
      claims,
      evidence,
      changedFiles,
      artifacts,
      jobs,
      usage: usageFromEvents(events, task),
      generatedAt: task.completedAt || task.updatedAt,
    }, { clock: this.clock });
    const recovered = await this.#readReportRepository(task.id);
    const repository = recovered.repository;
    let current = recovered.snapshot;
    for (;;) {
      if (current.data.report) return clone(current.data.report);
      try {
        const stored = await repository.replace({ report }, { expectedRevision: current.revision, clock: this.clock });
        return clone(stored.data.report);
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
        current = (await this.#readReportRepository(task.id)).snapshot;
      }
    }
  }

}
