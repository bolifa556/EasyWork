import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIChatModel } from "../gateway/core/web-agent/index.mjs";

function stream(lines) {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(lines)); controller.close(); } });
}

const modelLayout = Object.freeze({ systemMessageSeparator: "\n\n" });

test("OpenAI chat model streams reasoning and final text while assembling tool arguments", async () => {
  const deltas = [];
  let activities = 0;
  const model = new OpenAIChatModel({
    ...modelLayout,
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "reasoning-model",
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(JSON.stringify(body).includes("test-secret"), false);
      assert.equal(body.tool_choice, "auto");
      assert.equal(body.max_tokens, 100);
      return {
        ok: true,
        body: stream([
          'data: {"choices":[{"delta":{"reasoning_content":"检查"}}]}',
          'data: {"choices":[{"delta":{"content":"完成"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"context_get_state","arguments":"{}"}}]}}]}',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
          "data: [DONE]",
          "",
        ].join("\n\n")),
      };
    },
  });
  const result = await model.complete({
    messages: [{ role: "user", content: "status" }],
    tools: [{ name: "context_get_state", description: "state", inputSchema: { type: "object" } }],
    limits: { maxOutputTokens: 100 },
    onDelta: async (delta) => deltas.push(delta),
    onActivity: async () => { activities += 1; },
  });
  assert.equal(result.reasoning, "检查");
  assert.equal(result.content, "完成");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "context_get_state", input: {} }]);
  assert.deepEqual(deltas.map((entry) => entry.kind), ["reasoning", "content"]);
  assert.equal(activities, 3, "tool-argument deltas also keep a progressing model request alive");
});

test("OpenAI chat model treats DONE as the terminal boundary even when the provider keeps HTTP open", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"choices":[{"delta":{"reasoning_content":"选择完成"}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n")));
      // Intentionally do not close: compatible providers can retain the
      // connection after the protocol-level terminal marker.
    },
    cancel() { cancelled = true; },
  });
  const model = new OpenAIChatModel({
    ...modelLayout,
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "persistent-sse-model",
    fetchImpl: async () => ({ ok: true, body }),
  });

  const result = await Promise.race([
    model.complete({
      messages: [{ role: "user", content: "select context" }],
      limits: { maxOutputTokens: 100 },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("DONE did not terminate the model stream")), 250)),
  ]);

  assert.equal(result.reasoning, "选择完成");
  assert.equal(cancelled, true);
});

test("OpenAI chat model keeps id-less continuation deltas in the original tool call", async () => {
  const model = new OpenAIChatModel({
    ...modelLayout,
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "compatible-model",
    fetchImpl: async () => ({
      ok: true,
      body: stream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_split","function":{"name":"skill_search","arguments":"{\\"name\\":\\"本科生"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"算力平台使用规范\\",\\"query\\":\\"服务器资源\\"}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n")),
    }),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "检查服务器资源" }],
    tools: [{ name: "skill_search", description: "skill", inputSchema: { type: "object" } }],
    limits: { maxOutputTokens: 100 },
  });

  assert.deepEqual(result.toolCalls, [{
    id: "call_split",
    name: "skill_search",
    input: { name: "本科生算力平台使用规范", query: "服务器资源" },
  }]);
});

test("OpenAI chat model preserves malformed tool arguments as a recoverable protocol call", async () => {
  const model = new OpenAIChatModel({
    ...modelLayout,
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "compatible-model",
    fetchImpl: async () => ({
      ok: true,
      body: stream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"bad_submit","function":{"name":"handoff_submit","arguments":"{\\"candidateIds\\":["}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n\n")),
    }),
  });

  const result = await model.complete({
    messages: [{ role: "user", content: "执行任务" }],
    tools: [{ name: "handoff_submit", description: "submit", inputSchema: { type: "object" } }],
    limits: { maxOutputTokens: 100 },
  });

  assert.deepEqual(result.toolCalls, [{
    id: "bad_submit",
    name: "handoff_submit",
    input: {},
    invalidArguments: true,
  }]);
});

test("OpenAI chat model returns prior native reasoning with its tool call on the next request", async () => {
  let requestMessages = null;
  const model = new OpenAIChatModel({
    ...modelLayout,
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "reasoning-model",
    fetchImpl: async (_url, request) => {
      requestMessages = JSON.parse(request.body).messages;
      return { ok: true, body: stream("data: [DONE]\n\n") };
    },
  });

  await model.complete({
    messages: [
      { role: "user", content: "查找项目代号" },
      {
        role: "assistant",
        content: "",
        reasoning: "需要读取项目记忆。",
        toolCalls: [{ id: "memory_1", name: "memory_search", input: { query: "项目代号" } }],
      },
      { role: "tool", toolCallId: "memory_1", name: "memory_search", content: "相关记忆：A-551" },
    ],
    tools: [{ name: "memory_search", description: "memory", inputSchema: { type: "object" } }],
    limits: { maxOutputTokens: 100 },
  });

  assert.deepEqual(requestMessages, [
    { role: "user", content: "查找项目代号" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "需要读取项目记忆。",
      tool_calls: [{ id: "memory_1", type: "function", function: { name: "memory_search", arguments: "{\"query\":\"项目代号\"}" } }],
    },
    { role: "tool", tool_call_id: "memory_1", content: "相关记忆：A-551" },
  ]);
});

test("OpenAI chat model consolidates every system instruction at the beginning", async () => {
  let requestMessages = null;
  const model = new OpenAIChatModel({
    ...modelLayout,
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "strict-compatible-model",
    fetchImpl: async (_url, request) => {
      requestMessages = JSON.parse(request.body).messages;
      return { ok: true, body: stream("data: [DONE]\n\n") };
    },
  });

  await model.complete({
    messages: [
      { role: "system", content: "base instructions" },
      { role: "user", content: "create a file" },
      { role: "system", content: "skill instructions" },
      { role: "assistant", content: "working" },
    ],
    limits: { maxOutputTokens: 100 },
  });

  assert.deepEqual(requestMessages, [
    { role: "system", content: "base instructions\n\nskill instructions" },
    { role: "user", content: "create a file" },
    { role: "assistant", content: "working" },
  ]);
});
