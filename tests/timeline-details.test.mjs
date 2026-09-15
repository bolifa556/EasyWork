import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { summarizeTimelineEvent, summarizeTimelinePage, TIMELINE_INLINE_PAGE_BYTES, timelineReplayView, groupAgentActivity, groupBackgroundResults } from "../shared/timeline-projection.mjs";
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

test("conversation background summaries retain their title and only adjacent reads share one disclosure", () => {
  const background = {
    ...event("e6", "run.context.read", {}, "web-agent"),
    payload: {
      output: {
        conversation: [{
          id: "message-a",
          role: "assistant",
          content: "第一段内容",
          referenceTitle: "训练参数讨论",
          sourceConversationId: "conversation-a",
        }],
      },
    },
  };
  assert.deepEqual(summarizeTimelineEvent(background).payload.output.conversation, [{
    id: "message-a",
    role: "assistant",
    referenceTitle: "训练参数讨论",
    sourceConversationId: "conversation-a",
    timelineTitle: "第一段内容",
    timelineHasDetail: true,
  }]);

  const groups = groupBackgroundResults([
    { id: "a1", source: "conversation", value: { referenceTitle: "训练参数讨论", sourceConversationId: "conversation-a" } },
    { id: "a2", source: "conversation", value: { referenceTitle: "训练参数讨论", sourceConversationId: "conversation-a" } },
    { id: "memory", source: "memory", value: { title: "环境约定" } },
    { id: "a3", source: "conversation", value: { referenceTitle: "训练参数讨论", sourceConversationId: "conversation-a" } },
    { id: "b1", source: "conversation", value: { referenceTitle: "训练参数讨论", sourceConversationId: "conversation-b" } },
  ]);
  assert.deepEqual(groups.map((group) => [group.type, group.type === "conversation" ? group.title : group.result.source, group.type === "conversation" ? group.results.map((item) => item.id) : [group.result.id]]), [
    ["conversation", "训练参数讨论", ["a1", "a2"]],
    ["result", "memory", ["memory"]],
    ["conversation", "训练参数讨论", ["a3"]],
    ["conversation", "训练参数讨论", ["b1"]],
  ]);
});

test("full detail upgrades a summary and a later summary cannot overwrite it", () => {
  const full = event("e1", "reasoning", { text: "完整思考".repeat(1000) });
  const summary = summarizeTimelineEvent(full);
  const hydrated = mergeConversationEvents([summary], [full]);
  assert.equal(hydrated[0], full);
  assert.equal(mergeConversationEvents(hydrated, [summary]), hydrated);
});

test("short thoughts, memory and state travel with history while large siblings remain lazy", () => {
  const thought = event("e1", "reasoning", { text: "先核对环境，再读取文件。" });
  assert.equal(summarizeTimelineEvent(thought), thought);
  const webThought = { ...event("e2", "run.reasoning.delta", {}, "web-agent"), payload: { content: "已找到对应的技能。" } };
  assert.equal(summarizeTimelineEvent(webThought), webThought);
  const background = { ...webThought, kind: "run.context.read", payload: { input: { privateQuery: "query" }, output: { memory: [{ title: "环境", content: "使用 Python 3.12。" }, { title: "详细记录", content: "大段内容".repeat(2000) }], skills: [{ name: "测试", description: "运行测试", instructions: ["检查结果"] }] } } };
  const summarized = summarizeTimelineEvent(background);
  assert.equal(summarized.payload.output.memory[0].content, "使用 Python 3.12。");
  assert.equal(summarized.payload.output.memory[0].timelineDetailInline, true);
  assert.equal(summarized.payload.output.memory[1].content, undefined);
  assert.equal(summarized.payload.output.skills[0].timelineDetailInline, true);
  assert.deepEqual(summarized.payload.timelineDetailIds, [background.eventId]);
  assert.deepEqual(summarized.payload.input, {});
  const state = { ...webThought, kind: "run.context.state", payload: { state: { server: { name: "旧服务器", scheduler: "slurm", metadata: "large".repeat(1000) }, workspace: { path: "/previous/workspace" }, agent: { name: "Codex" } } } };
  const projected = summarizeTimelineEvent(state);
  assert.equal(projected.payload.timelineDetailIds, undefined);
  assert.deepEqual(projected.payload.state, { server: { name: "旧服务器", scheduler: "slurm" }, workspace: { path: "/previous/workspace" }, agent: { name: "Codex" } });
  assert.equal(state.payload.state.server.metadata.length, 5000);
});

test("inline limits count UTF-8 bytes and each cached replay page has its own 64 KiB budget", () => {
  assert.ok(summarizeTimelineEvent(event("e1", "reasoning", { text: "汉".repeat(800) })).payload.timelineDetailIds);
  const events = Array.from({ length: 90 }, (_, index) => event(`e${index + 1}`, "reasoning", { text: "汉".repeat(500) }));
  const cache = new WeakMap();
  const projected = summarizeTimelinePage(events, cache);
  const inline = projected.filter(item => !item.payload.timelineDetailIds);
  assert.ok(inline.length > 30 && inline.length < events.length);
  assert.ok(inline.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item.payload)), 0) <= TIMELINE_INLINE_PAGE_BYTES);
  assert.equal(projected.at(-1).payload.event.timelineHasText, true);
  assert.deepEqual(summarizeTimelinePage(events, cache), projected);
  assert.equal(summarizeTimelinePage(events.slice(-1), cache)[0], events.at(-1), "page-budget fallback must not poison the cached inline projection");
});

test("the gateway applies inline budgets to real paged replay and preserves full detail", async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "timeline-inline-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const journal = new RealtimeEventJournal({ dataRoot, actor });
  t.after(() => journal.close());
  const events = [];
  for (let index = 0; index < 48; index++) events.push(await journal.append("task:one", { actor, producer: "agent:codex", kind: "reasoning", payload: { event: { text: "字".repeat(600) } } }));
  const replay = await journal.replay("task:one", { view: "summary", limit: 100 });
  assert.ok(replay.events[0].payload.event.text.length > 0);
  assert.ok(replay.events.at(-1).payload.timelineDetailIds.length > 0);
  const tail = await journal.replay("task:one", { view: "summary", afterSequence: events.at(-2).sequence });
  assert.equal(tail.events[0].payload.event.text, events.at(-1).payload.event.text);
  assert.deepEqual((await journal.details("task:one", [events.at(-1).eventId])).events, [events.at(-1)]);
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
