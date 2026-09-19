import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { mergeConversationEvents } from "../app/easywork/features/conversation/conversation-event-retention.mjs";
import { ActorServiceContainer } from "../gateway/core/runtime/services.mjs";
import { isSkillApplicableToServer } from "../gateway/core/skills/applicability.mjs";

const importTypeScript = async (source) => {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
};
const timeline = ts.createSourceFile("timeline.tsx", await readFile(new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["orderedEvents", "latestRunEvents", "classifyConversationOutput"]);
const definitions = timeline.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(timeline) === "TERMINAL_WEB_KINDS"));
const { classifyConversationOutput } = await importTypeScript(definitions.map((node) => node.getText(timeline)).join("\n"));
const event = (sequence, kind, payload = {}) => ({ eventId: `event-${sequence}`, sequence, occurredAt: "2026-09-06T00:00:00Z", topic: "conversation:one", producer: "web-agent", ids: { runId: "run-one" }, kind, payload });

test("conversation navigation is idempotent, rejects stale reads and still updates titles, projects and tasks", async () => {
  const source = ts.createSourceFile("runtime.tsx", await readFile(new URL("../app/easywork/runtime/AppRuntime.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "updateConversationNavigation") callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const { makeUpdater } = await importTypeScript(`export const makeUpdater = (setBootstrap) => {
    const window = { location: { pathname: '/c/one', search: '' } };
    const parseRoute = () => ({ kind: 'conversation', conversationId: 'one' });
    return (${callback});
  };`);
  let snapshot = { runningTasks: [], conversationNavigation: null };
  let changes = 0;
  const update = makeUpdater((apply) => { const next = apply(snapshot); if (next !== snapshot) changes++; snapshot = next; });
  const summary = { id: "one", revision: 1, title: "原标题", projectId: "p1" };
  update(summary);
  const first = snapshot;
  for (let index = 0; index < 30; index++) update({ ...summary });
  assert.equal(snapshot, first);
  assert.equal(changes, 1);
  const projectPage = { projectId: "p1", items: [] };
  snapshot = { ...snapshot, conversationNavigation: { ...snapshot.conversationNavigation, projectConversations: projectPage } };
  update({ ...summary, revision: 2, title: "新标题" });
  const renamed = snapshot;
  assert.equal(snapshot.conversationNavigation.conversation.title, "新标题");
  assert.equal(snapshot.conversationNavigation.projectConversations, projectPage);
  update(summary);
  assert.equal(snapshot, renamed);
  update({ ...summary, revision: 3, projectId: "p2" });
  assert.equal(snapshot.conversationNavigation.projectConversations, null);
  snapshot = { ...snapshot, runningTasks: [{ id: "task1", conversationId: "one" }] };
  update({ ...summary, revision: 3, projectId: "p2" });
  assert.equal(snapshot.conversationNavigation.conversation.runningTaskId, "task1");
  snapshot = { ...snapshot, runningTasks: [] };
  update({ ...summary, revision: 3, projectId: "p2" });
  assert.equal(snapshot.conversationNavigation.conversation.runningTaskId, null);
});

test("404 recovery reads current runtime without making global UI changes a data effect dependency", async () => {
  const source = ts.createSourceFile("view.tsx", await readFile(new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let recovery;
  let guardedEffects = 0;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "recoverMissingConversation") recovery = node.initializer;
    if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("recoverMissingConversation(")) {
      guardedEffects++;
      const dependencies = node.arguments[1].elements.map((element) => element.getText(source));
      assert.ok(!dependencies.includes("runtime"));
      assert.ok(!dependencies.includes("recoverMissingConversation"));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(recovery.expression.getText(source), "useEffectEvent");
  assert.equal(guardedEffects, 5);
});

test("opening a conversation distinguishes history from live messages and reconnect catch-up", async () => {
  const source = ts.createSourceFile("client.ts", await readFile(new URL("../app/core/realtime/client.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(ts.isClassDeclaration).getText(source);
  const { RealtimeClient } = await importTypeScript(`const WebSocket = { OPEN: 1 }; const randomRequestId = () => "test-request"; ${declaration}`);
  const client = new RealtimeClient(() => "ws://localhost", () => "token");
  client.state = "open";
  client.authenticated = true;
  client.socket = { readyState: 1, send() {} };
  const received = [];
  const listener = (item, context) => received.push({ sequence: item.sequence, ...context });
  const unsubscribe = client.subscribe("conversation:one", listener);
  const receive = (sequence, replay) => client.receive(JSON.stringify({ type: "event", replay, event: event(sequence, "run.persisted") }));
  receive(1, true);
  client.receive(JSON.stringify({ type: "subscribed", topics: ["conversation:one"] }));
  receive(2, false);
  client.receive(JSON.stringify({ type: "authenticated" }));
  receive(3, true);
  unsubscribe();
  client.subscribe("conversation:one", listener);
  receive(4, true);
  assert.deepEqual(received, [
    { sequence: 1, initialReplay: true },
    { sequence: 2, initialReplay: false },
    { sequence: 3, initialReplay: false },
    { sequence: 4, initialReplay: true },
  ]);
});

test("chat exposes each output delta before the final commit", () => {
  let events = [event(1, "run.started")];
  for (const [index, content] of ["你", "你好", "你好，世界"].entries()) {
    events = mergeConversationEvents(events, [event(index + 2, "run.output.delta", { segmentId: "answer", target: "final", content, realtimeStreamKey: "output:answer:2" })]);
    assert.equal(classifyConversationOutput(events).streamingFinal, content);
  }
  events.push(event(5, "run.output.committed", { segmentId: "answer", target: "final", content: "你好，世界" }));
  assert.equal(classifyConversationOutput(events).streamingFinal, "你好，世界");
});

test("expired socket replay recovers its subscription while preserving live delivery", async () => {
  const source = ts.createSourceFile("client.ts", await readFile(new URL("../app/core/realtime/client.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(ts.isClassDeclaration).getText(source);
  const { RealtimeClient } = await importTypeScript(`const WebSocket = { OPEN: 1 }; let id = 0; const randomRequestId = () => String(++id); ${declaration}`);
  const client = new RealtimeClient(() => "ws://localhost", () => "token");
  const sent = [], received = [];
  client.state = "open";
  client.authenticated = true;
  client.socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  client.lastSequence.set("conversation:one", 2);
  client.subscribe("conversation:one", (item, context) => received.push({ sequence: item.sequence, ...context }));
  client.receive(JSON.stringify({ type: "error", meta: { requestId: sent[0].requestId }, error: { code: "REALTIME_REPLAY_EXPIRED" } }));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].resume, { "conversation:one": 0 });
  client.receive(JSON.stringify({ type: "event", replay: true, event: event(50, "run.reasoning.delta", { content: "已有思考" }) }));
  client.receive(JSON.stringify({ type: "subscribed", requestId: sent[1].requestId, topics: ["conversation:one"] }));
  client.receive(JSON.stringify({ type: "event", event: event(51, "run.reasoning.delta", { content: "继续输出" }) }));
  assert.deepEqual(received, [{ sequence: 50, initialReplay: true }, { sequence: 51, initialReplay: false }]);
  assert.equal(client.pendingSubscriptions.size, 0);
  client.receive(JSON.stringify({ type: "error", meta: { requestId: sent[0].requestId }, error: { code: "REALTIME_REPLAY_EXPIRED" } }));
  assert.equal(sent.length, 2, "a stale error cannot create a re-subscription loop");
});

test("an iteration classified as activity leaves the live answer without losing its text", () => {
  const events = [event(1, "run.started"), event(2, "run.output.delta", { segmentId: "prelude", target: "final", content: "正在查找资料" })];
  assert.equal(classifyConversationOutput(events).streamingFinal, "正在查找资料");
  events.push(event(3, "run.output.committed", { segmentId: "prelude", target: "activity" }));
  assert.equal(classifyConversationOutput(events).streamingFinal, "");
  assert.equal(classifyConversationOutput(events).activity[0].payload.text, "正在查找资料");
});

for (const kind of ["run.reasoning.delta", "reasoning"]) {
  test(`${kind}: history summaries cannot turn live text into lazy content or duplicate it`, () => {
    const full = event(1, kind, { content: "实时内容", realtimeStreamKey: "reasoning:1" });
    const summary = event(2, kind, { content: "", realtimeStreamKey: "reasoning:1", timelineDetailIds: ["event-2"] });
    const next = event(3, kind, { content: "实时内容继续生成", realtimeStreamKey: "reasoning:1" });
    const retained = mergeConversationEvents([full], [summary]);
    assert.deepEqual(retained, [full]);
    assert.deepEqual(mergeConversationEvents(retained, [next]), [next]);
    assert.deepEqual(mergeConversationEvents([summary], [next]), [next]);
    const following = event(4, kind, { content: "新的思考段", realtimeStreamKey: "reasoning:4" });
    assert.deepEqual(mergeConversationEvents([next], [following]), [next, following]);
  });
}

test("chat ignores both server lists while work honors both and still filters the mode", async () => {
  const server = { id: "server-one", host: "one.example" };
  const items = [
    { skillId: "whitelist", applicability: { mode: "all", allowServers: ["server-other"] } },
    { skillId: "blacklist", applicability: { mode: "all", denyServers: [server.id] } },
    { skillId: "chat", applicability: { mode: "chat" } },
    { skillId: "work", applicability: { mode: "work" } },
    { skillId: "general", applicability: { mode: "all" } },
  ];
  const service = {
    skills: { listInstalledKnowledge: async () => ({ items }), searchContext: async ({ selectedSkillIds }) => selectedSkillIds },
    filterSkillCatalogForServer: async () => items.filter((skill) => isSkillApplicableToServer({ skill, server })),
  };
  const search = (mode) => ActorServiceContainer.prototype.searchContext.call(service, { mode, scope: { serverId: server.id }, sources: ["skills"], query: "技能" });
  assert.deepEqual((await search("chat")).skills, ["whitelist", "blacklist", "chat", "general"]);
  assert.deepEqual((await search("work")).skills, ["work", "general"]);
});

test("chat displays message bodies and complete expanded history in the same first snapshot", async () => {
  const source = ts.createSourceFile("view.tsx", await readFile(new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "fetchConversation") callback = node.initializer.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  const { makeLoader } = await importTypeScript(`export const makeLoader = (api, conversationId) => (${callback});`);
  let releaseHistory;
  const historyReady = new Promise((resolve) => { releaseHistory = resolve; });
  const detail = { summary: { id: "one", mode: "chat" } };
  const history = [event(1, "run.reasoning.delta", { content: "完整思考" }), event(2, "run.context.read", { output: "完整引用" })];
  const requested = [];
  const api = { get: async (url) => {
    requested.push(url);
    if (url.includes("/events?")) {
      assert.ok(!url.includes("view=summary"));
      await historyReady;
      const second = url.includes("after=1");
      return { data: { events: [history[second ? 1 : 0]], lastSequence: 2, hasMore: !second, nextAfterSequence: second ? 2 : 1 } };
    }
    if (url.includes("/messages?")) return { data: { items: [{ id: "message-one", content: "正文" }] }, meta: {} };
    return { data: detail };
  } };
  let first;
  const loading = makeLoader(api, "one")((snapshot) => { first = snapshot; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first, undefined);
  releaseHistory();
  const result = await loading;
  assert.deepEqual(first.events, history);
  assert.equal(first.messages[0].content, "正文");
  assert.deepEqual(result.events, history);
  assert.equal(requested.filter((url) => url.includes("/events?")).length, 2);
});
