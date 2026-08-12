import assert from "node:assert/strict";
import test from "node:test";

import { WebAgentRuntime, createDefaultWebAgentTools } from "../gateway/core/web-agent/index.mjs";

function contextServices(overrides = {}) {
  return {
    context: {
      state: async () => ({ server: "ready" }),
      search: async () => ({ memory: [] }),
      ...overrides,
    },
  };
}

test("Work 网页 Agent 只检索上下文并提交 handoff，不接触远程 Task", async () => {
  const events = [];
  const visibleTools = [];
  const modelResults = [
    { reasoning: "先读取相关状态。", toolCalls: [{ id: "state", name: "context_get_state", input: {} }] },
    { content: "用户偏好使用项目内已有的部署参数。", usage: { inputTokens: 10, outputTokens: 5 } },
  ];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ tools }) {
        visibleTools.push(tools.map((tool) => tool.name));
        return modelResults.shift();
      },
    },
    tools: createDefaultWebAgentTools(contextServices()),
    prompts: { system: async () => "只组装上下文" },
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: { actorId: "user_1" },
    scope: { conversationId: "conversation_1" },
    userMessage: "部署服务",
    runId: "web_context_handoff",
  });

  assert.match(result.content, /context_get_state/);
  assert.match(result.content, /server/);
  assert.doesNotMatch(result.content, /用户偏好使用项目内已有的部署参数/);
  assert.equal(result.toolCallCount, 1);
  assert.ok(visibleTools.every((names) => names.every((name) => !name.startsWith("task_"))));
  assert.deepEqual(events.map((event) => event.kind), [
    "run.started",
    "run.reasoning.delta",
    "run.tool.started",
    "run.tool.completed",
    "run.handoff.ready",
    "run.context.completed",
  ]);
  assert.deepEqual(events.at(-2).payload, {
    userMessage: "部署服务",
    contextBrief: result.content,
  });
});

test("Work handoff discards model-authored execution claims and only forwards tool evidence", async () => {
  const events = [];
  const results = [
    { toolCalls: [{ id: "state", name: "context_get_state", input: {} }] },
    { content: "任务已经执行完成，验收通过。" },
  ];
  const runtime = new WebAgentRuntime({
    model: { complete: async () => results.shift() },
    tools: createDefaultWebAgentTools(contextServices({ state: async () => ({ server: { profile: { id: "server_1" }, connection: { status: "connected" } } }) })),
    prompts: { system: async () => "只组装上下文" },
    eventSink: async (event) => events.push(event),
  });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行远端任务", runId: "web_claim_filter" });
  assert.doesNotMatch(result.content, /执行完成|验收通过/);
  assert.match(result.content, /connected/);
  assert.equal(events.some((event) => event.kind === "run.output.delta"), false);
});

test("Work 网页 Agent 无需查询时可直接交付空补充，不会被强制创建任务", async () => {
  const calls = [];
  const events = [];
  const runtime = new WebAgentRuntime({
    model: {
      async complete(input) {
        calls.push(input);
        return { content: "", toolCalls: [] };
      },
    },
    tools: createDefaultWebAgentTools(contextServices()),
    prompts: { system: async () => "只组装上下文" },
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "pwd", runId: "web_empty_handoff" });
  assert.equal(result.content, "");
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map((event) => event.kind), ["run.started", "run.handoff.ready", "run.context.completed"]);
});

test("网页 Agent 按模型原始顺序流式输出，并在查询出现后把中间文本归入活动流", async () => {
  const events = [];
  const results = [
    { content: "先检查环境。", toolCalls: [{ id: "tool", name: "context_get_state", input: {} }] },
    { content: "环境正常。" },
  ];
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ onDelta }) => {
        const result = results.shift();
        await onDelta({ kind: "content", content: result.content });
        return result;
      },
    },
    tools: createDefaultWebAgentTools(contextServices({ state: async () => ({ ok: true }) })),
    prompts: { system: async () => "system" },
    eventSink: async (event) => events.push(event),
  });
  const result = await runtime.run({ mode: "chat", actor: { actorId: "u" }, scope: { conversationId: "c" }, userMessage: "检查", runId: "web_order" });
  assert.equal(result.content, "环境正常。");
  const output = events.filter((event) => event.kind.startsWith("run.output"));
  assert.deepEqual(output.map((event) => [event.kind, event.payload.content || event.payload.target]), [
    ["run.output.delta", "先检查环境。"],
    ["run.output.committed", "activity"],
    ["run.output.delta", "环境正常。"],
    ["run.output.committed", "final"],
  ]);
});

test("默认网页 Agent 工具在 Chat 与 Work 中都只有只读上下文能力", () => {
  const registry = createDefaultWebAgentTools(contextServices());
  const expected = ["memory_search", "resource_search", "conversation_search", "skill_search", "context_get_state"].sort();
  assert.deepEqual(registry.definitions("chat").map((tool) => tool.name).sort(), expected);
  assert.deepEqual(registry.definitions("work").map((tool) => tool.name).sort(), expected);
  for (const name of expected) {
    assert.equal(registry.resolve(name, "work").mutating, false);
  }
  for (const name of ["task_create", "task_observe", "task_append", "task_interrupt", "task_resume"]) {
    assert.equal(registry.resolve(name, "work"), null);
  }
});
