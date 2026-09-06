import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { createClaudeCodeAdapter, createCodexAdapter, createOpenCodeAdapter } from "../gateway/core/agents/index.mjs";
import { coalescedAgentFrames } from "../gateway/core/agent-runtime/index.mjs";
import { SchedulerSubmissionLedger, SchedulerSubmissionTracker, agentSchedulerActivity, agentSubmissionReceipts, slurmSubmissionReceipts } from "../gateway/core/scheduler/submissions.mjs";

const SERVER = `ssh_${crypto.createHash("sha256").update("submission-host").digest("base64url")}`;
const actor = (id = "alice") => createActorContext({ actorType: "user", actorId: id, deviceId: "device", sessionId: "session", roles: [] });

test("only shell execution of sbatch with its submission receipt is detected", () => {
  for (const command of ["sbatch -p cpu -J quick job.sh", "/usr/bin/sbatch -p cpu -J quick job.sh", "cd /work && sbatch --partition=cpu --job-name=quick job.sh", "bash -lc 'sbatch -pcpu -Jquick job.sh'", "env MODE=cpu sbatch -p cpu -J quick job.sh"]) {
    assert.deepEqual(slurmSubmissionReceipts(command, "Submitted batch job 52839\n"), [{ jobId: "52839", name: "quick", partition: "cpu" }]);
  }
  assert.deepEqual(slurmSubmissionReceipts("sbatch --parsable job.sh", "52840;cluster-1\n").map((job) => job.jobId), ["52840"]);
  assert.deepEqual(slurmSubmissionReceipts("sbatch one.sh; sbatch two.sh", "Submitted batch job 10\nSubmitted batch job 11\n").map((job) => job.jobId), ["10", "11"]);
  assert.deepEqual(slurmSubmissionReceipts("sbatch job.sh", "No account specified\n"), []);
  assert.deepEqual(slurmSubmissionReceipts("sbatch job.sh", "1234\n"), [], "非 parsable 回执不能用任意数字充当 JobID");
});

test("history queries, file reads, quoted sample commands and Agent prose never enter submissions", () => {
  for (const command of ["squeue -u alice", "sacct -u alice", "cat submit.log", "rg sbatch README.md", "echo 'sbatch job.sh'", "printf 'sbatch x; sbatch y'", "python submit.py", "# sbatch job.sh\necho ok", "cat <<'EOF'\nsbatch job.sh\nEOF", "sbatch --test-only job.sh"]) {
    assert.deepEqual(slurmSubmissionReceipts(command, "Submitted batch job 52839\n"), [], command);
  }
  const binding = { state: { items: { call: { input: { command: "sbatch job.sh" } } } } };
  for (const event of [
    { kind: "message", phase: "completed", payload: { name: "Bash", callId: "call", text: "Submitted batch job 52839" } },
    { kind: "tool_result", phase: "updated", payload: { name: "Bash", callId: "call", text: "Submitted batch job 52839" } },
    { kind: "tool_result", phase: "completed", payload: { name: "Read", callId: "call", text: "Submitted batch job 52839" } },
  ]) assert.deepEqual(agentSubmissionReceipts({ event, binding }), []);
});

test("here-document bodies are not commands, but real submissions after them are recorded", () => {
  for (const command of [
    "cat > job.sh <<'EOF'\n#!/bin/bash\necho done\nEOF\nsbatch -p cpu job.sh",
    "cat > job.sh <<EOF # prepare the script\necho done\nEOF\nsbatch -p cpu job.sh",
    "cat > job.sh <<-EOF\n\techo done\n\tEOF\nsbatch -p cpu job.sh",
    'bash -lc "cat > job.sh <<\'EOF\'\necho done\nEOF\nsbatch -p cpu job.sh"',
    "sbatch -p cpu <<'EOF'\n#!/bin/bash\necho done\nEOF",
  ]) {
    assert.deepEqual(slurmSubmissionReceipts(command, "Submitted batch job 52841\n").map((job) => [job.jobId, job.partition]), [["52841", "cpu"]], command);
  }
  for (const command of [
    "cat <<EOF\nsbatch -p cpu job.sh\nEOF\necho done",
    "cat <<EOF # show a sample\nsbatch -p cpu job.sh\nEOF",
    "cat <<ONE <<TWO\nsbatch job.sh\nONE\nsbatch another.sh\nTWO",
    "cat <<EOF\nsbatch job.sh\n", // Incomplete here-document, not execution evidence.
  ]) assert.deepEqual(slurmSubmissionReceipts(command, "Submitted batch job 52841\n"), [], command);
});

test("three native adapters correlate the executed shell command with its own completed result", () => {
  const cases = [
    [createCodexAdapter(), [{ method: "item/completed", params: { threadId: "t", turnId: "v", item: { id: "call", type: "commandExecution", command: "sbatch -p cpu job.sh", status: "completed", aggregatedOutput: "Submitted batch job 52839\n", exitCode: 0 } } }]],
    [createClaudeCodeAdapter(), [
      { type: "assistant", session_id: "s", message: { content: [{ type: "tool_use", id: "call", name: "Bash", input: { command: "sbatch -p cpu job.sh" } }] } },
      { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "Submitted batch job 52839\n" }] } },
    ]],
    [createOpenCodeAdapter(), [{ type: "message.part.updated", data: { part: { id: "part", type: "tool", tool: "bash", callID: "call", messageID: "m", sessionID: "s", state: { status: "completed", input: { command: "sbatch -p cpu job.sh" }, output: "Submitted batch job 52839\n" } } }, easywork: { eventEnvelope: "properties", eventSource: "v1-event-stream" } }]],
    [createOpenCodeAdapter(), [
      { type: "session.next.tool.called", data: { sessionID: "s", callID: "call", tool: "bash", input: { command: "sbatch -p cpu job.sh" } } },
      { type: "session.next.tool.success", data: { sessionID: "s", callID: "call", result: { output: "Submitted batch job 52839\n" } } },
    ]],
  ];
  for (const [adapter, frames] of cases) {
    let state = adapter.createState();
    const receipts = [];
    for (const frame of frames) {
      const next = adapter.reduce(state, frame);
      state = next.state;
      for (const event of next.events) receipts.push(...agentSubmissionReceipts({ event, binding: { state } }));
    }
    assert.deepEqual(receipts.map((item) => [item.jobId, item.partition]), [["52839", "cpu"]], adapter.id + " " + frames[0].type);
  }
});

test("Claude stream coalescing retains the executed submission input through its completed result", async () => {
  const input = { command: "cd /work/music && DURATION=60 sbatch scripts/run_generate.sh", description: "Submit Slurm job" };
  const stream = (event) => ({ type: "stream_event", session_id: "fresh-session", parent_tool_use_id: null, event });
  const frames = [
    stream({ type: "message_start", message: { id: "message-one" } }),
    stream({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "submit-call", name: "Bash", input: {} } }),
    stream({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(0, -2) } }),
    stream({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"}' } }),
    { type: "assistant", session_id: "fresh-session", uuid: "submit-block", message: { id: "message-one", content: [{ type: "tool_use", id: "submit-call", name: "Bash", input }] } },
    stream({ type: "content_block_stop", index: 2 }),
    stream({ type: "message_stop" }),
    { type: "user", session_id: "fresh-session", message: { content: [{ type: "tool_result", tool_use_id: "submit-call", content: "Submitted batch job 53236" }] } },
  ];
  async function* source() { for (const frame of frames) yield frame; }
  const received = coalescedAgentFrames(source(), "claude-code");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const adapter = createClaudeCodeAdapter();
  let state = adapter.createState();
  const receipts = [];
  for await (const frame of received) {
    const next = adapter.reduce(state, frame);
    state = next.state;
    for (const event of next.events) receipts.push(...agentSubmissionReceipts({ event, binding: { state } }));
  }
  assert.deepEqual(state.items["submit-call"].input, input);
  assert.deepEqual(receipts.map((entry) => [entry.jobId, entry.callId]), [["53236", "submit-call"]]);
});

test("Claude streamed shell input is finalized on its own block before another block starts", () => {
  const adapter = createClaudeCodeAdapter();
  let state = adapter.createState();
  const input = { command: "sbatch -p cpu job.sh" };
  for (const event of [
    { type: "message_start", message: { id: "stream-only" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "submit-call", name: "Bash", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "another-call", name: "Bash", input: {} } },
  ]) state = adapter.reduce(state, { type: "stream_event", session_id: "s", event }).state;
  assert.deepEqual(state.items["submit-call"].input, input, "完整输入应以 tool_use_id 保留，不依赖可复用的 block index");
  const result = adapter.reduce(state, { type: "user", session_id: "s", message: { content: [{ type: "tool_result", tool_use_id: "submit-call", content: "Submitted batch job 53236" }] } });
  assert.deepEqual(result.events.flatMap((event) => agentSubmissionReceipts({ event, binding: { state: result.state } })).map((entry) => entry.jobId), ["53236"]);
});

test("submission ledger is durable, idempotent and isolated by web user, host identity and SSH username", async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-submissions-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const options = { dataRoot, actor: actor(), serverIdentity: SERVER, username: "remote-alice", clock: () => new Date("2026-09-02T12:17:23.459Z") };
  const ledger = new SchedulerSubmissionLedger(options);
  const receipts = [{ jobId: "52839", callId: "call", name: "cpu-check", partition: "cpu" }];
  const scope = { taskId: "task-one", conversationId: "conversation-one", agentId: "codex" };
  await Promise.all([ledger.record(receipts, scope), new SchedulerSubmissionLedger(options).record(receipts, scope)]);
  const range = { startDate: "2026-09-02", endDate: "2026-09-02" };
  const fresh = new SchedulerSubmissionLedger(options);
  const jobs = await fresh.list(range);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, "cpu-check");
  assert.equal(jobs[0].startedAt, null);
  assert.equal(jobs[0].endedAt, null);
  assert.equal(jobs[0].state, "unknown");
  assert.equal((await fresh.list({ startDate: "2026-09-03", endDate: "2026-09-03" })).length, 0);
  for (const override of [{ actor: actor("bob") }, { username: "remote-bob" }, { serverIdentity: `ssh_${crypto.createHash("sha256").update("other").digest("base64url")}` }]) {
    assert.deepEqual(await new SchedulerSubmissionLedger({ ...options, ...override }).list(range), []);
  }
  await fresh.updateJobs([{ ...jobs[0], owner: "remote-bob", state: "completed" }]);
  assert.equal((await fresh.list(range))[0].state, "unknown");
  await fresh.updateJobs([{ ...jobs[0], state: "completed", endedAt: "2026-09-02T12:20:00Z" }]);
  await fresh.updateJobs([{ ...jobs[0], state: "running" }]);
  assert.equal((await fresh.list(range))[0].state, "completed", "终态不会被较早的 squeue 快照倒退");
  const stored = await fs.readFile(path.join(dataRoot, "users", "alice", "scheduler", SERVER, "remote-alice", "submissions.json"), "utf8");
  assert.doesNotMatch(stored, /sbatch|stdout|tool_result/, "只持久化提交元数据，不复制工具正文");
});

test("submission history uses the browser date boundary rather than cutting off local early-morning jobs", async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-submission-timezone-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const ledger = new SchedulerSubmissionLedger({ dataRoot, actor: actor(), serverIdentity: SERVER, username: "remote-alice", clock: () => new Date("2026-09-02T17:00:00Z") });
  await ledger.record([{ jobId: "52840", callId: "midnight-call" }], { taskId: "midnight-task" });
  const range = { startDate: "2026-09-03", endDate: "2026-09-03", utcOffsetMinutes: 480 };
  assert.equal((await ledger.list(range)).length, 1, "北京时间凌晨 1 点属于 9 月 3 日");
  assert.equal((await ledger.list({ ...range, utcOffsetMinutes: 0 })).length, 0);
  assert.equal((await ledger.list({ ...range, startDate: "2026-09-02", endDate: "2026-09-02" })).length, 0);
});

async function trackingFixture(t, inspectJob, canPoll = async () => true) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-submission-track-"));
  const ledger = new SchedulerSubmissionLedger({ actor: actor(), dataRoot, serverIdentity: SERVER,
    username: "alice", clock: () => new Date("2026-09-03T12:00:00Z") });
  const timers = new Map();
  const tracker = new SchedulerSubmissionTracker({
    ledger, inspectJob, canPoll,
    setTimer: (callback, delay) => { const key = {}; timers.set(key, { callback, delay }); return key; },
    clearTimer: (key) => timers.delete(key),
  });
  t.after(async () => { await tracker.close(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  return { dataRoot, ledger, tracker, timers };
}

test("all three Agents share independent submission tracking without an open history panel", async (t) => {
  let phase = "running";
  const calls = [];
  const { dataRoot, ledger, tracker, timers } = await trackingFixture(t, async (id) => {
    calls.push(id);
    return { id, owner: "alice", state: phase, name: `cpu-${id}`, cpuCores: 1,
      startedAt: "2026-09-03T20:00:01", endedAt: phase === "completed" ? "2026-09-03T20:00:02" : null };
  });
  for (const [index, agentId] of ["codex", "claude-code", "opencode"].entries()) {
    await ledger.record([{ jobId: String(index + 301), callId: `call-${index}` }], { taskId: `task-${index}`, agentId });
  }
  await tracker.resume();
  assert.equal(calls.length, 0, "登记提交不会等待远端状态查询");
  assert.equal([...timers.values()][0].delay, 0, "新回执立即触发独立检查");
  await tracker.poll();
  assert.deepEqual(calls, ["301", "302", "303"]);
  assert.equal([...timers.values()][0].delay, 15_000);
  phase = "completed";
  await tracker.poll();
  assert.equal(timers.size, 0, "全部到达终态后不再轮询");
  const fresh = new SchedulerSubmissionLedger({ actor: actor(), dataRoot, serverIdentity: SERVER, username: "alice" });
  assert.deepEqual((await fresh.list({ startDate: "2026-09-03", endDate: "2026-09-03" })).map((job) => [job.id, job.state, job.endedAt]), [
    ["301", "completed", "2026-09-03T20:00:02"], ["302", "completed", "2026-09-03T20:00:02"], ["303", "completed", "2026-09-03T20:00:02"],
  ]);
  assert.deepEqual(await fresh.pending(), [], "已保存终态不因控制器后来清除记录而重新进入跟踪");
  await tracker.resume();
  assert.equal(timers.size, 0);
});

test("submission tracking pauses on disconnect and resumes from durable receipts on connect", async (t) => {
  let connected = false;
  let calls = 0;
  const { ledger, tracker, timers } = await trackingFixture(t, async (id) => {
    calls += 1;
    return { id, owner: "alice", state: "completed" };
  }, async () => connected);
  await ledger.record([{ jobId: "401", callId: "call" }]);
  await tracker.resume();
  await tracker.poll();
  assert.equal(calls, 0);
  assert.equal(timers.size, 0, "断线不能触发调度器查询或自动重连");
  assert.deepEqual(await ledger.pending(), [{ jobId: "401" }]);
  connected = true;
  await tracker.resume();
  await tracker.poll();
  assert.equal(calls, 1);
  assert.deepEqual(await ledger.pending(), []);
});

test("retired and foreign jobs stop polling, while transient controller failures remain recoverable", async (t) => {
  let recovered = false;
  const { ledger, tracker, timers } = await trackingFixture(t, async (id) => {
    if (id === "501") return null;
    if (id === "502") {
      if (!recovered) throw new Error("controller unavailable");
      return { id, owner: "alice", state: "completed" };
    }
    return { id, owner: "bob", state: "completed" };
  });
  await ledger.record(["501", "502", "503"].map((jobId) => ({ jobId, callId: "call" })));
  await tracker.resume();
  for (let index = 0; index < 3; index += 1) await tracker.poll();
  assert.equal(timers.size, 1);
  const history = await ledger.list({ startDate: "2026-09-03", endDate: "2026-09-03" });
  assert.equal(history.length, 3);
  assert.ok(history.every((job) => job.state === "unknown" && job.startedAt === null && job.endedAt === null));
  recovered = true;
  await tracker.poll();
  assert.equal(timers.size, 0);
  assert.equal((await ledger.list({ startDate: "2026-09-03", endDate: "2026-09-03" })).find((job) => job.id === "502").state, "completed");
});

test("a new submission replaces the pending timer and state changes notify all clients once", async (t) => {
  let phase = "running";
  const notifications = [];
  const { ledger, tracker, timers } = await trackingFixture(t, async (id) => ({ id, owner: "alice", state: phase }));
  tracker.onChanged = async (ids) => notifications.push(ids);
  await ledger.record([{ jobId: "801", callId: "a" }]);
  await tracker.resume();
  await tracker.poll();
  assert.equal([...timers.values()][0].delay, 15_000);
  await ledger.record([{ jobId: "802", callId: "b" }]);
  await tracker.resume(["802"]);
  assert.equal([...timers.values()][0].delay, 0);
  await tracker.poll();
  assert.deepEqual(notifications, [["801"], ["802"]]);
  phase = "completed";
  await tracker.poll();
  assert.deepEqual([...notifications.at(-1)].sort(), ["801", "802"]);
  assert.equal(timers.size, 0);
});

test("scheduler activity uses executed shell commands, and final empty frames retain accumulated receipts", () => {
  const make = (command) => ({ event: { kind: "tool_result", phase: "completed", payload: { name: "functions.exec_command", callId: "c", input: { cmd: command }, text: "" } } });
  assert.equal(agentSchedulerActivity(make("scancel 900")), true);
  assert.equal(agentSchedulerActivity(make("squeue -u alice")), true);
  assert.equal(agentSchedulerActivity(make("echo 'scancel 900'")), false);
  assert.equal(agentSchedulerActivity(make("cat <<EOF\nsbatch job.sh\nEOF")), false);
  const input = make("sbatch -p cpu job.sh");
  input.binding = { state: { items: { c: { output: "Submitted batch job 900\n" } } } };
  assert.equal(agentSubmissionReceipts(input)[0].jobId, "900");
});

test("a streamed receipt is detected before shell completion but never from a partial JobID", async (t) => {
  const make = (text, cumulative, phase = "updated") => ({
    event: { kind: "tool_result", phase, payload: { name: "commandExecution", callId: "stream-submit", text, delta: phase === "updated" } },
    binding: { state: { items: { "stream-submit": { input: { command: "sbatch -p cpu short.sh; sleep 120" }, output: cumulative } } } },
  });
  assert.deepEqual(agentSubmissionReceipts(make("Submitted batch job 12", "Submitted batch job 12")), []);
  const receipts = agentSubmissionReceipts(make("3\nwaiting", "Submitted batch job 123\nwaiting"));
  assert.deepEqual(receipts.map((r) => r.jobId), ["123"]);
  assert.deepEqual(agentSubmissionReceipts(make("\n", "Submitted batch job 123\nwaiting\n")), []);
  const { ledger } = await trackingFixture(t, async () => null);
  assert.deepEqual(await ledger.record(receipts, { taskId: "stream-task" }), ["123"]);
  const finalReceipts = agentSubmissionReceipts(make("Submitted batch job 123\nwaiting\n", "", "completed"));
  assert.deepEqual(await ledger.record(finalReceipts, { taskId: "stream-task" }), [], "终态帧不能重复登记或重复发布提交通知");
});

test("submission tracking bounds queries to 20 jobs and 4 concurrent requests per pass", async (t) => {
  let active = 0, peak = 0;
  const calls = [];
  const { ledger, tracker } = await trackingFixture(t, async (id) => {
    active += 1; peak = Math.max(peak, active); calls.push(id);
    await Promise.resolve(); active -= 1;
    return { id, owner: "alice", state: "completed" };
  });
  const ids = Array.from({ length: 45 }, (_, index) => String(600 + index));
  await ledger.record(ids.map((jobId) => ({ jobId, callId: "call" })));
  await tracker.resume();
  await tracker.poll();
  assert.equal(calls.length, 20);
  assert.equal(peak, 4);
  await tracker.poll();
  await tracker.poll();
  assert.deepEqual(calls, ids);
});

test("a new receipt arriving during a status read is not lost or polled concurrently", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const { ledger, tracker, timers } = await trackingFixture(t, async (id) => {
    calls.push(id);
    if (id === "701") await blocked;
    return { id, owner: "alice", state: "completed" };
  });
  await ledger.record([{ jobId: "701", callId: "one" }]);
  await tracker.resume(["701"]);
  const first = tracker.poll();
  await ledger.record([{ jobId: "702", callId: "two" }]);
  await tracker.resume(["702"]);
  const overlapping = tracker.poll();
  release();
  await Promise.all([first, overlapping]);
  assert.deepEqual(calls, ["701"]);
  assert.equal(timers.size, 1);
  await tracker.poll();
  assert.deepEqual(calls, ["701", "702"]);
});
