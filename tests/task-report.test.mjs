import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { createTask, transitionTask, updateTaskRuntime } from "../gateway/core/entities/task.mjs";
import { FileTaskStore } from "../gateway/core/orchestrator/persistence.mjs";
import { TaskReportService } from "../gateway/core/orchestrator/report.mjs";
import { taskTopic } from "../gateway/core/orchestrator/contract.mjs";
import { RealtimeEventJournal } from "../gateway/core/realtime.mjs";

const actor = createActorContext({ actorType: "user", actorId: "user-report", userId: "user-report", deviceId: "device-report", sessionId: "session-report", roles: [] });

async function fixture(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-task-report-"));
  const dataRoot = path.join(root, "data");
  await fs.mkdir(dataRoot);
  try { return await callback({ dataRoot }); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

function taskInput() {
  return {
    id: "task-report-1",
    actorId: actor.actorId,
    conversationId: "conversation-report",
    branchId: "branch-report",
    sourceMessageId: "message-report",
    conversationRunId: "run-report",
    goal: "inspect and change a file",
    route: {
      serverId: "server-report",
      serverIdentity: `ssh_${"a".repeat(43)}`,
      workspaceId: "workspace-report",
      agentId: "codex",
      providerId: "provider-agent",
      modelId: "model-agent",
    },
    contextSessionId: "context-report",
    agentBindingId: "binding-report",
    skillPins: [],
    resourceBindingSnapshotId: "resources-report",
    versionCheckpointId: null,
    budgets: { maxWallTimeMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 4_000, maxToolCalls: 20 },
    idempotencyKey: "create-report",
  };
}

test("TaskReport 从 canonical Agent events 归并最终文本、证据、文件、作业、产物与用量", async () => {
  await fixture(async ({ dataRoot }) => {
    const clock = (() => {
      let value = Date.parse("2026-08-10T00:00:00.000Z");
      return () => new Date(value += 1_000);
    })();
    const taskStore = new FileTaskStore({ dataRoot, actor, clock });
    let task = createTask(taskInput(), { clock });
    await taskStore.createTask(task);
    for (const status of ["preparing", "delivering_context", "running"]) {
      const next = transitionTask(task, status, { expectedRevision: task.revision, clock });
      await taskStore.saveTask(next, { expectedRevision: task.revision });
      task = next;
    }
    let next = updateTaskRuntime(task, { artifactIds: ["artifact-report"] }, { expectedRevision: task.revision, clock });
    await taskStore.saveTask(next, { expectedRevision: task.revision });
    task = next;
    for (const status of ["finalizing", "completed"]) {
      next = transitionTask(task, status, { expectedRevision: task.revision, clock });
      await taskStore.saveTask(next, { expectedRevision: task.revision });
      task = next;
    }
    const journal = new RealtimeEventJournal({ dataRoot, actor });
    const appendAgent = (kind, status, event, source = {}) => journal.append(taskTopic(task.id), {
      producer: "agent:codex",
      kind,
      status,
      ids: { taskId: task.id, conversationId: task.conversationId },
      payload: { source, event },
    });
    await appendAgent("tool_call", "started", { name: "shell", callId: "call-1" }, { itemId: "call-1" });
    await appendAgent("tool_result", "completed", { name: "shell", callId: "call-1", text: "ok" }, { itemId: "call-1" });
    await appendAgent("file_change", "completed", { action: "edit", path: "src/main.ts", diff: "+change" });
    await appendAgent("job_status", "updated", { operation: "slurm", jobId: "30789", message: "running" });
    await appendAgent("artifact", "completed", { artifactId: "artifact-report", name: "report.txt" });
    await appendAgent("usage", "updated", { inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    await appendAgent("message", "completed", { role: "assistant", text: "Task finished with evidence.", delta: false }, { itemId: "claude-assistant:0" });
    await appendAgent("message", "completed", { role: "assistant", text: "Task finished with evidence.", delta: false }, { itemId: "claude-content-block:0" });
    await appendAgent("final", "completed", { text: "Task finished with evidence." });

    const reports = new TaskReportService({
      dataRoot,
      actor,
      clock,
      taskStore,
      journal,
      artifactService: { async get() { return { id: "artifact-report", name: "report.txt", kind: "file", mime: "text/plain", size: 12 }; } },
    });
    const report = await reports.generate({ task });
    assert.equal(report.remoteFinal.text, "Task finished with evidence.");
    assert.equal(report.changedFiles[0].path, "src/main.ts");
    assert.equal(report.jobs[0].id, "30789");
    assert.equal(report.artifacts[0].name, "report.txt");
    assert.deepEqual({ ...report.usage, durationMs: 0 }, { inputTokens: 120, outputTokens: 30, totalTokens: 150, toolCalls: 1, durationMs: 0 });
    assert.ok(report.usage.durationMs > 0);
    assert.equal(report.claims[0].evidenceIds.length, report.evidence.length);

    assert.equal((await reports.get(task.id)).revision, 0);

    const reportPath = path.join(dataRoot, "users", actor.actorId, "tasks", task.id, "report.json");
    const obsolete = JSON.parse(await fs.readFile(reportPath, "utf8"));
    obsolete.data.report.webFinal = { text: "obsolete web-agent summary" };
    await fs.writeFile(reportPath, `${JSON.stringify(obsolete, null, 2)}\n`, "utf8");

    assert.equal(await reports.get(task.id, { required: false }), null);
    const regenerated = await reports.generate({ task });
    assert.equal(regenerated.remoteFinal.text, "Task finished with evidence.");
    assert.equal(Object.hasOwn(regenerated, "webFinal"), false);
  });
});
