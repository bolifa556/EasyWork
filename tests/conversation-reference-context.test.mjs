import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEasyWorkRuntime } from "../gateway/core/runtime/runtime.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import { WebAgentRuntime, createDefaultWebAgentTools } from "../gateway/core/web-agent/index.mjs";
import {
  collectConversationReferences,
  conversationReferenceReadState,
  filterReferenceObservations,
} from "../gateway/core/web-agent/conversation-references.mjs";

const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
const reference = { referenceId: "cref_allowed", title: "参数讨论", conversationId: "source", snapshotId: "frozen" };
const turn = (id, content) => [
  { id: `${id}-user`, role: "user", content: `${content}问题`, sourceConversationId: "source", sourceSnapshotId: "frozen", referenceTurnId: id, contextKind: "recent" },
  { id: `${id}-assistant`, role: "assistant", content: `${content}答案`, sourceConversationId: "source", sourceSnapshotId: "frozen", referenceTurnId: id, contextKind: "recent" },
];

test("引用目录沿可见消息链继承，同一冻结来源不重复列出，回退不继承未来引用", () => {
  const updated = { ...reference, referenceId: "cref_reselected" };
  const messages = [
    { id: "before", role: "user", references: [] },
    { id: "selected", role: "user", references: [reference] },
    { id: "followup", role: "user", references: [] },
    { id: "reselected", role: "user", references: [updated] },
  ];
  assert.deepEqual(collectConversationReferences(messages, "before"), []);
  assert.deepEqual(collectConversationReferences(messages, "followup"), [{ ...reference, sourceMessageId: "selected" }]);
  assert.deepEqual(collectConversationReferences(messages, "reselected"), [{ ...updated, sourceMessageId: "reselected" }]);
  assert.deepEqual(collectConversationReferences(messages, "missing"), []);
});

for (const mode of ["chat", "work"]) {
  test(`${mode} 引用正文跨轮复用，只返回未读回合，重复命中保留游标但不展示背景`, async () => {
    let output = { reference, memory: [{ content: "默认输出 Markdown" }], recentConversation: turn("known", "KNOWN"), matchedConversation: [], nextCursor: null };
    const tools = await createDefaultWebAgentTools({
      context: {}, skills: {}, conversationReferences: { search: async () => output },
    }, prompts, { conversationReferences: [reference] });
    const tool = tools.resolve("conversation_reference_search", mode);
    const observed = await tool.handoffItems({ output });
    assert.deepEqual(conversationReferenceReadState(reference, observed), { ...reference, readTurns: 1, readMemories: 1 });
    assert.equal(filterReferenceObservations(observed, []).length, 0);
    assert.equal(filterReferenceObservations(observed, [reference]).length, 2);
    const catalog = await prompts.conversationReferenceCatalog([conversationReferenceReadState(reference, observed)]);
    assert.match(catalog, /已读取 1 个回合、1 条记忆/);

    output = { ...output, matchedConversation: turn("new", "NEW").map((entry) => ({ ...entry, contextKind: "matched" })) };
    const events = [];
    let rounds = 0;
    const runtime = new WebAgentRuntime({
      tools, prompts, eventSink: async (event) => events.push(event),
      model: { async complete({ messages }) {
        rounds += 1;
        if (rounds === 1) {
          assert.ok(messages.some((message) => message.role === "system" && String(message.content).includes("KNOWN答案")));
          return { toolCalls: [{ id: "read-new", name: "conversation_reference_search", input: { referenceId: reference.referenceId, query: "NEW" } }] };
        }
        const result = messages.find((message) => message.toolCallId === "read-new");
        assert.match(result.content, /NEW问题/);
        assert.match(result.content, /NEW答案/);
        assert.doesNotMatch(result.content, /KNOWN|默认输出 Markdown/);
        return mode === "chat" ? { content: "已取得新资料。" } : { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds: [] } }] };
      } },
    });
    const first = await runtime.run({ mode, actor: {}, scope: {}, userMessage: "继续检索", initialObservationFragments: observed });
    assert.equal(events.filter((event) => event.kind === "run.context.read").length, 1);
    assert.equal(first.observedFragments.filter((fragment) => fragment.knowledge?.key.startsWith("conversation-reference:")).length, 2);

    rounds = 0;
    events.length = 0;
    output = { ...output, nextCursor: "next-unread-page" };
    const repeated = new WebAgentRuntime({
      tools, prompts, eventSink: async (event) => events.push(event),
      model: { async complete({ messages }) {
        rounds += 1;
        if (rounds === 1) return { toolCalls: [{ id: "repeat", name: "conversation_reference_search", input: { referenceId: reference.referenceId, query: "another-query" } }] };
        const result = messages.find((message) => message.toolCallId === "repeat");
        assert.match(result.content, /没有新增内容/);
        assert.match(result.content, /next-unread-page/);
        assert.doesNotMatch(result.content, /KNOWN|NEW答案/);
        return mode === "chat" ? { content: "直接复用。" } : { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds: [] } }] };
      } },
    });
    await repeated.run({ mode, actor: {}, scope: {}, userMessage: "继续核对", initialObservationFragments: first.observedFragments,
      ...(mode === "work" ? { observationFilter: async (fragments) => fragments.map((fragment) => ({ ...fragment, deliveryState: "delivered" })) } : {}),
    });
    assert.equal(events.filter((event) => event.kind === "run.context.read").length, 0);
  });
}

test("引用长回合完整进入模型与已读记录，不把截断内容标成已读", async () => {
  const output = { reference, memory: [], recentConversation: turn("long", "长".repeat(30_000)), matchedConversation: [], nextCursor: null };
  const tools = await createDefaultWebAgentTools({ context: {}, skills: {}, conversationReferences: { search: async () => output } }, prompts, { conversationReferences: [reference] });
  let rounds = 0;
  const runtime = new WebAgentRuntime({ tools, prompts, model: { async complete({ messages }) {
    if (++rounds === 1) return { toolCalls: [{ id: "long", name: "conversation_reference_search", input: { referenceId: reference.referenceId, query: "长" } }] };
    const result = messages.find((message) => message.toolCallId === "long").content;
    assert.ok(result.includes(output.recentConversation[0].content));
    assert.ok(result.includes(output.recentConversation[1].content));
    return { content: "完成。" };
  } } });
  const result = await runtime.run({ mode: "chat", actor: {}, scope: {}, userMessage: "读取完整回合" });
  const tool = tools.resolve("conversation_reference_search", "chat");
  assert.equal(tool.prune({ output, observedFragments: result.observedFragments }).allObserved, true);
});

test("Chat 后续未重新 @ 仍能查未读引用，复用缓存并在来源删除后停止注入", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easywork-reference-context-"));
  const replies = new Map();
  const runtime = await createEasyWorkRuntime({ dataRoot: path.join(root, "data"), webModelFactory: () => ({
    async complete({ messages, tools = [] }) {
      const system = String(messages[0]?.content || "");
      if (system.includes("# 可复用记忆提取")) return { toolCalls: [] };
      if (system.includes("只输出标题本身")) return { content: "引用测试" };
      const request = messages.findLast((message) => message.role === "user").content;
      const catalog = messages.find((message) => message.role === "system" && String(message.content).includes("# 当前分支已明确引用的对话"));
      if (request === "DELETED_SOURCE") {
        assert.equal(catalog, undefined);
        assert.ok(tools.every((tool) => tool.name !== "conversation_reference_search"));
        assert.doesNotMatch(messages.map((message) => message.content).join("\n"), /RECENT_TEXT_11|EARLY_NEEDLE/);
        return { content: "来源已删除。" };
      }
      const result = messages.findLast((message) => message.name === "conversation_reference_search");
      if (result) { replies.set(request, result.content); return { content: "已查阅所需资料。" }; }
      assert.ok(catalog);
      if (request !== "FIRST_REF") {
        assert.match(catalog.content, /已读取 1[01] 个回合/);
        assert.ok(messages.some((message) => message.role === "system" && String(message.content).includes("RECENT_TEXT_11")));
      }
      const referenceId = /reference_id:\s*(cref_[a-f0-9]+)/.exec(catalog.content)[1];
      return { toolCalls: [{ id: "lookup", name: "conversation_reference_search", input: { referenceId, query: request === "FIRST_REF" ? "NO_OLD_MATCH" : "EARLY_NEEDLE" } }] };
    },
  }) });
  t.after(async () => {
    await runtime.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const registered = await runtime.auth.register({ username: "reference-context", password: "test-password-value", deviceId: "test-device" });
  const session = await runtime.auth.resolveSession(registered.token);
  const services = await runtime.servicesForActor(session.actor);
  let source;
  for (let index = 0; index < 12; index += 1) {
    const question = await services.baseConversations.sendMessage({
      ...(source ? { conversationId: source.conversation.id } : { mode: "chat" }),
      role: "user", content: index === 0 ? "EARLY_NEEDLE" : `RECENT_TEXT_${index}`,
      expectedRevision: source?.conversation.revision || 0, commandId: `source-question-${index}`,
    });
    source = await services.baseConversations.sendMessage({ conversationId: question.conversation.id, role: "assistant", content: `ANSWER_${index}`,
      expectedRevision: question.conversation.revision, commandId: `source-answer-${index}` });
  }
  const searches = [];
  const search = services.baseConversations.searchConversationReference.bind(services.baseConversations);
  services.baseConversations.searchConversationReference = async (input) => { searches.push(input); return search(input); };
  let target;
  let firstReferenceMessage;
  for (const request of ["FIRST_REF", "SECOND_REF", "THIRD_REF"]) {
    const current = target ? await services.baseConversations.getConversation(target.conversation.id) : null;
    target = await services.conversations.sendMessage({
      ...(target ? { conversationId: target.conversation.id, branchId: target.branchId } : { mode: "chat", references: [{ type: "conversation", conversationId: source.conversation.id }] }),
      content: request, expectedRevision: current?.summary.revision || 0, commandId: request,
      response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
    });
    firstReferenceMessage ||= target.messageId;
    await services.interactions.waitFor(target.response.runId);
    await services.waitForIdle();
  }
  assert.match(replies.get("FIRST_REF"), /RECENT_TEXT_11/);
  assert.doesNotMatch(replies.get("FIRST_REF"), /用户：EARLY_NEEDLE/);
  assert.match(replies.get("SECOND_REF"), /用户：EARLY_NEEDLE/);
  assert.doesNotMatch(replies.get("SECOND_REF"), /RECENT_TEXT_11/);
  assert.match(replies.get("THIRD_REF"), /没有新增内容/);
  assert.ok(searches.every((input) => input.messageId === firstReferenceMessage));
  await services.baseConversations.delete({ conversationId: source.conversation.id, expectedRevision: source.conversation.revision, commandId: "delete-source" });
  const current = await services.baseConversations.getConversation(target.conversation.id);
  const last = await services.conversations.sendMessage({ conversationId: target.conversation.id, branchId: target.branchId,
    content: "DELETED_SOURCE", expectedRevision: current.summary.revision, commandId: "after-source-delete",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(last.response.runId);
});
