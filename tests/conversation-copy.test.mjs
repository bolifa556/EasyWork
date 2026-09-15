import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import ts from "typescript";
import { loadConversationCopy, conversationCopyMarkdown, groupConversationTimeline, splitRemoteFinalPresentation, markdownFence } from "../app/easywork/features/conversation/conversation-copy.mjs";
import { conversationReferenceClipboard, pastedConversationId, resolveConversationReference } from "../app/easywork/features/conversation/conversation-reference.ts";
import { mergeConversationEvents } from "../app/easywork/features/conversation/conversation-event-retention.mjs";
import { summarizeTimelineEvent, groupAgentActivity } from "../shared/timeline-projection.mjs";

const message = (id, role, content, extra = {}) => ({ id, role, content, conversationId: "c1", branchId: "b1", createdAt: "2026-09-06T00:00:00Z", taskId: null, ...extra });
const detail = { summary: { id: "c1", title: "读书计划", mode: "work", activeBranchId: "b1" } };
const event = (index, kind, body, producer = "agent:codex", ids = {}) => ({
  schemaVersion: 1, eventId: `e${index}`, sequence: index, occurredAt: new Date(1000 * index).toISOString(),
  topic: producer === "web-agent" ? "conversation:c1" : "task:t1", producer, kind, status: "completed",
  ids: { conversationId: "c1", sourceMessageId: "u1", runId: "r1", taskId: "t1", ...ids },
  payload: producer === "web-agent" ? body : { event: body },
});

// Execute the production pure projection with its real shared helpers. JSX
// declarations remain uncalled; no browser, app session or mocked renderer is
// needed to test the export's semantic filtering and native event coalescing.
async function loadProjection() {
  const source = await fs.readFile(new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("Timeline.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = parsed.statements.filter((node) => !ts.isImportDeclaration(node) && !(ts.isExportDeclaration(node) && node.moduleSpecifier))
    .map((node) => node.getFullText(parsed)).join("\n");
  const imports = [
    ["parseRemoteArtifactLinks", "../shared/remote-artifact-links.mjs"],
    ["artifactAnswerMarkdown, artifactDisplayName, conversationArtifactCards, referencedArtifactCards", "../app/easywork/features/conversation/artifact-presentation.mjs"],
    ["groupAgentActivity, groupBackgroundResults, timelineDetailIds", "../shared/timeline-projection.mjs"],
    ["isWorkProtocolReasoning", "../shared/timeline-protocol.mjs"],
    ["markdownFence, markdownLabel, splitRemoteFinalPresentation", "../app/easywork/features/conversation/conversation-copy.mjs"],
  ].map(([names, file]) => `import { ${names} } from ${JSON.stringify(new URL(file, import.meta.url).href)};`).join("\n");
  const compiled = ts.transpileModule(imports + declarations + "\nexport { activitySegments, buildWebTrace };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}
const { conversationTimelineMarkdown: projection, activitySegments, buildWebTrace } = await loadProjection();

test("history already contains every Agent activity heading before any detail is hydrated", () => {
  const outline = entries => groupAgentActivity(activitySegments(entries)).map(group => [group.type, group.id]);
  for (const key of ["text", "content", "message", "summary", "output", "diff"]) {
    const full = [event(1, "reasoning", { [key]: "长思考".repeat(1000) }), event(2, "message", { text: "已经完成检查。" }), event(3, "reasoning", { [key]: "下一步".repeat(1000) }), event(4, "message", { text: "结果已经整理。" })];
    const summaries = full.map(summarizeTimelineEvent);
    assert.deepEqual(outline(summaries), outline(full), key);
    assert.deepEqual(outline([full[0], ...summaries.slice(1)]), outline(full), `${key}: partial hydration`);
    assert.equal(outline(summaries).filter(([kind]) => kind === "thinking").length, 2);
  }
});

test("web history and full detail agree on visible protocol and prose headings", () => {
  const full = [event(1, "run.started", { mode: "work" }, "web-agent"),
    event(2, "run.reasoning.delta", { iteration: 1, content: JSON.stringify({ name: "resource_search", arguments: { query: "文件".repeat(1500) } }) }, "web-agent"),
    event(3, "run.context.read", { name: "resource_read", output: { memory: [{ title: "环境", content: "长内容".repeat(1500) }] } }, "web-agent"),
    event(4, "run.reasoning.delta", { iteration: 2, content: "普通思考。".repeat(1000) }, "web-agent")];
  const outline = events => buildWebTrace(events).entries.map(entry => [entry.type, entry.id]);
  assert.deepEqual(outline(full.map(summarizeTimelineEvent)), outline(full));
  assert.equal(outline(full).filter(([type]) => type === "reasoning").length, 1);
});

test("re-projecting web thoughts never grows the original deferred-ID lists", () => {
  const full = [event(1, "run.started", { mode: "work" }, "web-agent"),
    event(2, "run.reasoning.delta", { iteration: 1, content: "第一段思考".repeat(1000) }, "web-agent"),
    event(3, "run.reasoning.delta", { iteration: 1, content: "第二段思考".repeat(1000) }, "web-agent"),
    event(4, "run.handoff.ready", { userMessage: "执行任务", contextBrief: "背景" }, "web-agent"),
    event(5, "run.handoff.dispatched", { operation: "create" }, "web-agent")];
  const summaries = full.map(summarizeTimelineEvent);
  for (const event of summaries) if (event.payload.timelineDetailIds) Object.freeze(event.payload.timelineDetailIds);
  for (let index = 0; index < 5; index++) {
    const trace = buildWebTrace(summaries);
    assert.deepEqual(trace.entries[0].detailIds, ["e2", "e3"]);
    assert.deepEqual(trace.handoff.detailIds, ["e4", "e5"]);
  }
});

for (const producer of ["agent:codex", "agent:claude-code", "agent:opencode"]) test(`${producer} 累积流更新、终态和按需详情保持同一个思考栏目`, () => {
  let retained = [];
  let identity;
  for (let index = 1; index <= 120; index++) {
    const incoming = event(index, "reasoning", { text: "正在检查。".repeat(index), delta: true }, producer);
    incoming.payload.source = { itemId: "native-item" };
    incoming.payload.realtimeStreamKey = "native-stream:1";
    retained = mergeConversationEvents(retained, [incoming]);
    assert.equal(retained.length, 1, "旧传输快照仍然正常合并，不靠堆积事件保持组件");
    assert.equal(retained[0].eventId, incoming.eventId, "保留真实日志 ID 供详情读取");
    const [group] = groupAgentActivity(activitySegments(retained));
    identity ??= group.id;
    assert.equal(group.id, identity, "更新文字不得重新创建可展开栏目");
    assert.equal(group.segments[0].event.payload.event.text, "正在检查。".repeat(index));
  }
  const completed = event(121, "reasoning", { text: "检查完成。" }, producer);
  completed.payload.source = { itemId: "native-item" };
  assert.equal(groupAgentActivity(activitySegments([completed]))[0].id, identity);
  assert.equal(groupAgentActivity(activitySegments([summarizeTimelineEvent(completed)]))[0].id, identity);
  const next = event(122, "reasoning", { text: "下一阶段。" }, producer);
  next.payload.source = { itemId: "next-item" };
  assert.notEqual(activitySegments([next])[0].id, identity);
});

test("网页思考流合并快照后保留栏目身份，工具之后的新思考独立显示", () => {
  const started = event(1, "run.started", { mode: "work" }, "web-agent");
  let retained = [started], identity;
  for (let index = 2; index <= 121; index++) {
    const incoming = event(index, "run.reasoning.delta", { iteration: 0, content: "检索背景。".repeat(index), realtimeStreamKey: "web-stream:2" }, "web-agent");
    retained = mergeConversationEvents(retained, [incoming]);
    const [entry] = buildWebTrace(retained).entries;
    identity ??= entry.id;
    assert.equal(entry.id, identity);
    assert.equal(entry.text, incoming.payload.content);
    assert.equal(buildWebTrace(retained.map(summarizeTimelineEvent)).entries[0].id, identity);
  }
  const read = event(122, "run.context.read", { name: "context_search", callId: "search", output: { memory: [{ id: "memory-1", content: "已确认的背景" }] } }, "web-agent");
  const next = event(123, "run.reasoning.delta", { iteration: 1, content: "整理结果。", realtimeStreamKey: "web-stream:123" }, "web-agent");
  const thoughts = buildWebTrace([...retained, read, next]).entries.filter(entry => entry.type === "reasoning");
  assert.equal(thoughts.length, 2);
  assert.notEqual(thoughts[0].id, thoughts[1].id);
});

test("正文复制读取完整消息分页，保留 Markdown，不读取思考或其他分支", async () => {
  const all = Array.from({ length: 204 }, (_, index) => message(`m${index}`, index % 2 ? "assistant" : "user", `第 ${index} 条\n\n**原始 Markdown**`));
  const requests = [];
  const api = { get: async (route) => {
    requests.push(route);
    if (route === "/api/conversations/c1") return { data: detail };
    const url = new URL(route, "http://local");
    assert.equal(url.pathname, "/api/conversations/c1/messages");
    assert.equal(url.searchParams.get("branchId"), "b1");
    const offset = Number(url.searchParams.get("cursor") || 0);
    return { data: { items: all.slice(offset, offset + 100), nextCursor: offset + 100 < all.length ? String(offset + 100) : null } };
  } };
  const data = await loadConversationCopy(api, "c1");
  const copied = conversationCopyMarkdown(data);
  assert.equal(requests.length, 4);
  assert.ok(copied.includes("第 0 条") && copied.includes("第 203 条"));
  assert.equal((copied.match(/\*\*原始 Markdown\*\*/g) || []).length, 204);
  assert.equal((copied.match(/^## 你$/gm) || []).length, 102);
  assert.equal((copied.match(/^## EasyWork$/gm) || []).length, 102);
});

test("分支复制复用其引用的原生历史，分页读全且排除分支后的请求", async () => {
  const inherited = [message("fork-u1", "user", "旧提问", { originMessageId: "u1" }), message("fork-a1", "assistant", "旧回答", { taskId: "t1" })];
  const first = event(1, "run.started", { mode: "work" }, "web-agent");
  const thinking = event(2, "reasoning", { text: "继承的思考" });
  const other = event(3, "reasoning", { text: "分支之后不可见" }, "agent:codex", { sourceMessageId: "future" });
  const routes = [];
  const api = { get: async (route) => {
    routes.push(route);
    if (route === "/api/conversations/c1") return { data: detail };
    if (route.includes("/messages?")) return { data: { items: inherited, nextCursor: null } };
    if (route.startsWith("/api/conversations/c1/events")) return { data: { events: [], lastSequence: 0, hasMore: false } };
    if (route === "/api/tasks/t1") return { data: { id: "t1", sourceMessageId: "u1", status: "completed" } };
    const after = Number(new URL(route, "http://local").searchParams.get("after"));
    return { data: after === 0 ? { events: [first, thinking], nextAfterSequence: 2, lastSequence: 3, hasMore: true }
      : { events: [other, event(4, "message", { text: "请求开始之后的新事件" })], nextAfterSequence: 4, lastSequence: 4, hasMore: false } };
  } };
  const data = await loadConversationCopy(api, "c1", true);
  const copied = conversationCopyMarkdown(data, { includeActivity: true, activityMarkdown: projection });
  assert.match(copied, /继承的思考/);
  assert.doesNotMatch(copied, /分支之后不可见|请求开始之后的新事件/);
  assert.equal(routes.filter((route) => route.startsWith("/api/tasks/t1/events")).length, 2);
});

test("共用 Task 的连续提问各自复制其活动，旧重试和控制事件不会混入", () => {
  const messages = [message("u1", "user", "一"), message("a1", "assistant", "答一", { taskId: "t1" }), message("u2", "user", "二"), message("a2", "assistant", "答二", { taskId: "t1" })];
  const events = [event(1, "run.started", {}, "web-agent", { runId: "old" }), event(2, "reasoning", { text: "旧重试" }, "agent:codex", { runId: "old" }),
    event(3, "run.started", {}, "web-agent"), event(4, "reasoning", { text: "第一轮" }),
    event(5, "run.started", {}, "web-agent", { sourceMessageId: "u2", runId: "r2" }), event(6, "reasoning", { text: "第二轮" }, "agent:codex", { sourceMessageId: "u2", runId: "r2" })];
  const groups = groupConversationTimeline(messages, events);
  assert.deepEqual(groups.timelineByAssistantMessage.get("a1").map((item) => item.eventId), ["e3", "e4"]);
  assert.deepEqual(groups.timelineByAssistantMessage.get("a2").map((item) => item.eventId), ["e5", "e6"]);
});

for (const producer of ["agent:codex", "agent:claude-code", "agent:opencode"]) test(`${producer} 全部复制保留展开内容并去除最终回答、命令生命周期重复`, () => {
  const records = [
    event(1, "run.started", { mode: "work" }, "web-agent"),
    event(2, "run.context.state", { state: { server: { name: "107", scheduler: "slurm" }, workspace: { name: "工作区" }, agent: { name: producer } } }, "web-agent"),
    event(3, "run.reasoning.delta", { content: "网页思考完整正文", iteration: 0 }, "web-agent"),
    event(4, "run.context.read", { name: "memory_search", output: { memory: [{ title: "背景标题", content: "可展开的完整背景", internalId: "绝不导出内部字段" }] } }, "web-agent"),
    event(5, "run.handoff.ready", { userMessage: "请继续", contextBrief: "隐藏的传输数据", references: [{ kind: "Skill", name: "下载技能", detail: "技能完整内容" }] }, "web-agent"),
    event(6, "run.handoff.dispatched", { references: [{ kind: "Skill", name: "下载技能", detail: "技能完整内容" }] }, "web-agent"),
    event(7, "reasoning", { text: "远端思考\n" + "长文本。".repeat(3000) + "末尾仍在" }, producer),
    event(8, "tool_call", { name: "shell", callId: "call-1", input: { command: "printf done" } }, producer),
    event(9, "tool_result", { name: "shell", callId: "call-1", result: "done\n```\n仍属于命令输出" }, producer),
    event(10, "message", { text: "已经完成检查", messagePhase: "commentary" }, producer),
    event(11, "file_change", { path: "answer.md", diff: "--- a/answer.md\n+++ b/answer.md\n+修复" }, producer),
    event(12, "message", { text: "The change is ready", messagePhase: "commentary" }, producer),
    event(13, "message", { text: "最终总结", messagePhase: "final_answer" }, producer),
    event(14, "final", { text: "最终总结" }, producer),
    event(15, "context_delivery", { text: "隐藏的传输数据" }, producer),
    event(16, "usage", { text: "隐藏的统计数据" }, producer),
    event(17, "run.persisted", {}, "web-agent"),
  ];
  const data = { detail, messages: [message("s", "system", "隐藏系统提示"), message("u1", "user", "请继续"), message("a1", "assistant", "最终总结", { taskId: "t1" })], events: records, tasks: { t1: { id: "t1", status: "completed" } } };
  const body = conversationCopyMarkdown(data);
  assert.match(body, /请继续[\s\S]*最终总结/);
  assert.doesNotMatch(body, /网页思考|远端思考|printf|背景标题|隐藏/);
  const all = conversationCopyMarkdown(data, { includeActivity: true, activityMarkdown: projection });
  for (const text of ["网页思考完整正文", "可展开的完整背景", "技能完整内容", "远端思考", "末尾仍在", "printf done", "仍属于命令输出", "已经完成检查", "The change is ready", "+修复"]) assert.ok(all.includes(text), text);
  assert.equal((all.match(/最终总结/g) || []).length, 1);
  assert.equal((all.match(/执行了 1 个操作/g) || []).length, 2);
  assert.doesNotMatch(all, /隐藏|绝不导出内部字段|timelineDetailIds|runId/);
});

test("正文去掉划入 Agent 栏的前导总结，保留原 Markdown；完整复制可处理未结束轮次", () => {
  assert.deepEqual(splitRemoteFinalPresentation("阶段完成。\n\n# 正式回答\n\n- 项目一"), { activity: "阶段完成。", body: "# 正式回答\n\n- 项目一" });
  assert.equal(markdownFence("before\n````\nafter"), "`````\nbefore\n````\nafter\n`````");
  const data = { detail, messages: [message("u1", "user", "还在运行")], tasks: {}, events: [event(1, "run.started", {}, "web-agent"), event(2, "run.reasoning.delta", { content: "进行中的可见思考" }, "web-agent")] };
  assert.match(conversationCopyMarkdown(data, { includeActivity: true, activityMarkdown: projection }), /进行中的可见思考/);
});

test("复制详情读取失败时整体失败，不悄悄省略部分内容", async () => {
  const api = { get: async (route) => {
    if (route === "/api/conversations/c1") return { data: detail };
    if (route.includes("/messages?")) return { data: { items: [message("u1", "user", "问题")], nextCursor: null } };
    throw new Error("无法读取活动详情");
  } };
  await assert.rejects(loadConversationCopy(api, "c1", true), /无法读取活动详情/);
});

test("复制对话的链接可粘贴为精确引用，普通文字、导出 Markdown 和外站链接保持原样", () => {
  const origin = "http://127.0.0.1:8001";
  const payload = conversationReferenceClipboard({ id: "conv_123", title: '@标题 <script> & "测试"' }, origin);
  assert.equal(payload.text, `${origin}/c/conv_123`);
  assert.equal(pastedConversationId(payload.text, origin), "conv_123");
  assert.match(payload.html, /@标题 &lt;script&gt; &amp; &quot;测试&quot;/);
  assert.equal(pastedConversationId(` ${payload.text}/?panel=chat\n`, origin), "conv_123");
  for (const value of ["@标题", `看这个 ${payload.text}`, `${payload.text}\n另一个`, `[标题](${payload.text})`, "https://example.com/c/conv_123", `${origin}/c/%2Fbad`, `${origin}/c/../servers`, `http://user@127.0.0.1:8001/c/conv_123`]) {
    assert.equal(pastedConversationId(value, origin), null, value);
  }
});

test("粘贴引用重新取得真实标题，拒绝自己、已删除或其他账号的对话", async () => {
  let reads = 0;
  const api = { get: async (path) => {
    reads++;
    if (path !== "/api/conversations/conv_source") throw new Error("对话不存在");
    return { data: { summary: { id: "conv_source", title: "重命名后的标题", mode: "work", projectId: "other-project", updatedAt: "now" } } };
  } };
  const reference = await resolveConversationReference(api, "conv_source", "conv_current");
  assert.deepEqual(reference, { conversationId: "conv_source", title: "重命名后的标题", mode: "work", projectId: "other-project", updatedAt: "now" });
  await assert.rejects(resolveConversationReference(api, "conv_current", "conv_current"), /不能引用当前对话/);
  assert.equal(reads, 1);
  await assert.rejects(resolveConversationReference(api, "deleted"), /对话不存在/);
  await assert.rejects(resolveConversationReference(api, "other-actor"), /对话不存在/);
});
