import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { summarizeTimelineEvent, timelineReplayView, groupAgentActivity } from "../shared/timeline-projection.mjs";
import { mergeConversationEvents } from "../app/easywork/features/conversation/conversation-event-retention.mjs";
import { RealtimeEventJournal } from "../gateway/core/realtime.mjs";

const actor = { actorType: "user", actorId: "timeline-user", deviceId: "device", sessionId: "session", roles: [] };
const event = (id, kind, body = {}, producer = "agent:codex") => ({ schemaVersion: 1, eventId: id, kind, producer, topic: "task:one", sequence: Number(id.slice(1)) || 1, occurredAt: "2026-09-06T00:00:00Z", actorType: "user", actorId: actor.actorId, status: "completed", ids: { taskId: "one", conversationId: "conversation" }, payload: { event: body, source: { itemId: id } } });

test("native messages split continuous thinking groups regardless of language or phase", () => {
  const rows = [event("e1", "reasoning"), event("e2", "tool_call"), event("e3", "message", { text: "已经定位原因" }), event("e4", "reasoning"), event("e5", "message", { text: "The fix is ready", messagePhase: "commentary" }), event("e6", "tool_call")];
  const grouped = groupAgentActivity(rows.map((e) => ({ type: e.kind === "tool_call" ? "operations" : "event", id: e.eventId, ...(e.kind === "tool_call" ? { events: [e] } : { event: e }) })));
  assert.deepEqual(grouped.map((g) => [g.type, g.type === "thinking" ? g.segments.map((s) => s.id) : g.id]), [["thinking", ["e1", "e2"]], ["event", "e3"], ["thinking", ["e4"]], ["event", "e5"], ["thinking", ["e6"]]]);
});

test("history projects headings without losing native text, file paths or detail identities", () => {
  const huge = "完整内容。".repeat(10_000);
  for (const producer of ["agent:codex", "agent:claude-code", "agent:opencode"]) {
    const original = event("e1", "reasoning", { text: huge }, producer);
    const summary = summarizeTimelineEvent(original);
    assert.equal(summary.payload.event.text, "");
    assert.equal(summary.payload.event.timelineHasText, true);
    assert.deepEqual(summary.payload.timelineDetailIds, ["e1"]);
    assert.equal(original.payload.event.text, huge);
    const message = event("e2", "message", { text: "阶段性总结" }, producer);
    assert.equal(summarizeTimelineEvent(message), message);
  }
  const command = summarizeTimelineEvent(event("e3", "tool_call", { name: "exec_command", callId: "call", input: { cmd: huge }, result: huge }));
  assert.ok(command.payload.event.input.cmd.length <= 160);
  assert.equal(command.payload.event.result, "");
  const file = summarizeTimelineEvent(event("e4", "file_change", { changes: [{ diff: "--- a/name.py\n+++ b/name.py\n+" + huge }] }));
  assert.equal(file.payload.event.changes[0].path, "name.py");
  assert.equal(file.payload.event.changes[0].diff, "");
  const background = { ...event("e5", "run.context.read", {}, "web-agent"), payload: { output: { memory: [{ title: "关键信息", content: huge }] } } };
  assert.deepEqual(summarizeTimelineEvent(background).payload.output.memory, [{ title: "关键信息", timelineTitle: "关键信息", timelineHasDetail: true }]);
  const replay = { events: [background], lastSequence: 5, nextAfterSequence: 5, hasMore: false };
  assert.equal(timelineReplayView(replay).events[0], background);
  assert.ok(JSON.stringify(timelineReplayView(replay, "summary")).length < JSON.stringify(replay).length / 10);
});

test("full detail upgrades a summary and a later summary cannot overwrite it", () => {
  const full = event("e1", "reasoning", { text: "完整思考" });
  const summary = summarizeTimelineEvent(full);
  const hydrated = mergeConversationEvents([summary], [full]);
  assert.equal(hydrated[0], full);
  assert.equal(mergeConversationEvents(hydrated, [summary]), hydrated);
});

test("a file item hydrates every contributing patch, not just the last event", async () => {
  const source = await fs.readFile(new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url), "utf8");
  const names = ["payloadRecord", "nestedPayload", "pathFromDiff", "fileEntries", "sourceItemId", "isRunningEvent", "mergedFileEntries"];
  const functions = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    return source.slice(start, source.indexOf("\nfunction ", start + 1));
  }).join("\n");
  const compiled = ts.transpileModule(`${functions}\nconst timelineDetailIds=e=>e.payload?.timelineDetailIds||[]; export { mergedFileEntries };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { mergedFileEntries } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const full = [event("e1", "file_change", { path: "result.py", diff: "+first" }), event("e2", "file_change", { path: "result.py", diff: "+second" })];
  const summaries = full.map(summarizeTimelineEvent);
  assert.deepEqual(mergedFileEntries(summaries)[0].event.payload.timelineDetailIds, ["e1", "e2"]);
  assert.deepEqual(mergedFileEntries([full[0], summaries[1]])[0].event.payload.timelineDetailIds, ["e2"]);
  assert.equal(mergedFileEntries(full)[0].diff, "+first\n\n+second");
});

test("detail lookup reads only the requested actor/topic journal and returns complete content", async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timeline-details-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const journal = new RealtimeEventJournal({ dataRoot, actor });
  const full = await journal.append("task:one", { actor, producer: "agent:codex", kind: "reasoning", payload: { event: { text: "完整正文".repeat(20_000) } } });
  assert.deepEqual((await journal.details("task:one", [full.eventId])).events, [full]);
  assert.deepEqual((await journal.details("task:other", [full.eventId])).events, []);
  const other = new RealtimeEventJournal({ dataRoot, actor: { ...actor, actorId: "other-user" } });
  assert.deepEqual((await other.details("task:one", [full.eventId])).events, []);
  await assert.rejects(journal.details("task:one", []), { code: "REALTIME_EVENT_IDS_INVALID" });
});
