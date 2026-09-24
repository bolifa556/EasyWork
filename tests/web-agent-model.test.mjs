import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIChatModel } from "../gateway/core/web-agent/index.mjs";

function stream(lines) {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(lines)); controller.close(); } });
}

const modelLayout = Object.freeze({ systemMessageSeparator: "\n\n" });

function responseStream(events) {
  return stream(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

test("GPT Responses 流式摘要、正文和终态快照不重复，工具回传保留原生 reasoning item", async () => {
  const deltas = [];
  const requests = [];
  const reasoningItem = { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "先核对资料。" }], encrypted_content: "encrypted-test-continuation" };
  const functionItem = { id: "fc_1", type: "function_call", call_id: "call_1", name: "skill_read", arguments: '{"name":"规范"}', status: "completed" };
  const model = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://example.test/v1", apiKey: "test-secret", model: "GPT/gpt-6-sol", fetchImpl: async (url, request) => {
    requests.push({ url, ...JSON.parse(request.body) });
    if (requests.length === 1) return { ok: true, body: responseStream([
      { type: "response.output_item.added", output_index: 0, item: { ...reasoningItem, summary: [] } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "先核对" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "资料。" },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: "先核对资料。" },
      { type: "response.output_item.added", output_index: 1, item: { ...functionItem, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"name":' },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '"规范"}' },
      { type: "response.output_item.done", output_index: 0, item: reasoningItem },
      { type: "response.output_item.done", output_index: 1, item: functionItem },
      { type: "response.completed", response: { output: [reasoningItem, functionItem], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
    ]) };
    return { ok: true, body: responseStream([
      { type: "response.output_text.delta", item_id: "msg_1", delta: "核对完毕" },
      { type: "response.completed", response: { output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "核对完毕" }] }] } },
    ]) };
  } });
  const messages = [{ role: "system", content: "系统" }, { role: "user", content: [{ type: "text", text: "核对图片" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }];
  const tools = [{ name: "skill_read", description: "读取规范", inputSchema: { type: "object", properties: { name: { type: "string" } } } }];
  const first = await model.complete({ messages, tools, toolChoice: "skill_read", onDelta: (delta) => deltas.push(delta), limits: { maxOutputTokens: 1000 } });
  assert.equal(first.reasoning, "先核对资料。");
  assert.deepEqual(first.toolCalls, [{ id: "call_1", name: "skill_read", input: { name: "规范" } }]);
  assert.equal(deltas.map((delta) => delta.content).join(""), first.reasoning);
  assert.equal(requests[0].url, "https://example.test/v1/responses");
  assert.deepEqual(requests[0].reasoning, { effort: "medium", summary: "auto" });
  assert.equal(requests[0].model, "GPT/gpt-6-sol");
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].tools[0].strict, false);
  assert.deepEqual(requests[0].tool_choice, { type: "function", name: "skill_read" });
  assert.equal(requests[0].input[0].content[1].type, "input_image");
  assert.equal(first.usage.input_tokens, 20);
  const second = await model.complete({ messages: [...messages, { role: "assistant", content: first.content, toolCalls: first.toolCalls, responseItems: first.responseItems }, { role: "tool", toolCallId: "call_1", content: "规范内容" }], tools, onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(requests[1].input.slice(1), [reasoningItem, functionItem, { type: "function_call_output", call_id: "call_1", output: "规范内容" }]);
  assert.equal(second.content, "核对完毕");
  assert.equal(deltas.filter((delta) => delta.kind === "content").map((delta) => delta.content).join(""), "核对完毕");
});

test("Responses 终态即关闭连接；仅终态提供的摘要仍可显示", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ id: "rs", type: "reasoning", summary: [{ type: "summary_text", text: "摘要" }] }] } })}\n\n`));
  }, cancel() { cancelled = true; } });
  const model = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://example.test/v1/responses", apiKey: "test-secret", model: "gpt-6-sol", fetchImpl: async () => ({ ok: true, body }) });
  const result = await model.complete({ messages: [] });
  assert.equal(result.reasoning, "摘要");
  assert.equal(cancelled, true);
});

test("Responses 中断和错误不能当作成功；无摘要不伪造思考", async () => {
  for (const [events, code] of [
    [[{ type: "response.output_text.delta", delta: "半截" }], "MODEL_STREAM_INCOMPLETE"],
    [[{ type: "response.failed", response: { error: { message: "上游失败" } } }], "MODEL_REQUEST_FAILED"],
    [[{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }], "MODEL_RESPONSE_INCOMPLETE"],
  ]) {
    const model = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://example.test", apiKey: "test-secret", model: "gpt-6-sol", fetchImpl: async () => ({ ok: true, body: responseStream(events) }) });
    await assert.rejects(model.complete({ messages: [] }), { code });
  }
  const model = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://example.test", apiKey: "test-secret", model: "gpt-6-sol", fetchImpl: async () => ({ ok: true, body: responseStream([{ type: "response.completed", response: { output: [], usage: { output_tokens_details: { reasoning_tokens: 100 } } } }]) }) });
  assert.equal((await model.complete({ messages: [] })).reasoning, "");
});

test("auto 仅在 Responses 端点不可用时回退 Chat，显式协议和认证错误不回退", async () => {
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push({ url, ...JSON.parse(request.body) });
    return url.endsWith("/responses") ? { ok: false, status: 404, json: async () => ({ error: { message: "Unknown endpoint" } }) } : { ok: true, body: stream('data: {"choices":[{"delta":{"reasoning_content":"兼容摘要","content":"回答"}}]}\n\ndata: [DONE]\n\n') };
  };
  const model = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://example.test", apiKey: "test-secret", model: "gpt-6-sol", fetchImpl });
  assert.equal((await model.complete({ messages: [] })).reasoning, "兼容摘要");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].reasoning_effort, "medium");
  for (const protocol of ["responses", "chat-completions"]) {
    let calls = 0;
    const explicit = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://example.test", apiKey: "test-secret", model: "gpt-6-sol", protocol, fetchImpl: async () => { calls++; return { ok: false, status: 401, json: async () => ({ error: { message: "Unauthorized" } }) }; } });
    await assert.rejects(explicit.complete({ messages: [] }), { code: "MODEL_REQUEST_FAILED" });
    assert.equal(calls, 1);
  }
});

test("保留自定义完整 API 路径和显式协议", () => {
  const custom = (baseUrl, protocol = "auto") => new OpenAIChatModel({ ...modelLayout, baseUrl, protocol, apiKey: "test-secret", model: "gpt-6-sol" });
  assert.equal(custom("https://example.test/api/chat/completions").url, "https://example.test/api/chat/completions");
  assert.equal(custom("https://example.test/api/responses").url, "https://example.test/api/responses");
  assert.equal(custom("https://example.test/v1/", "chat-completions").url, "https://example.test/v1/chat/completions");
  assert.equal(custom("https://example.test/v1", "responses").url, "https://example.test/v1/responses");
});

test("SSE 换行和中文字符跨网络分片时，模型结束前仍逐段交付", async () => {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const deltas = [];
  let received;
  const firstDelta = new Promise((resolve) => { received = resolve; });
  const model = new OpenAIChatModel({ ...modelLayout, baseUrl: "https://models.example.test", apiKey: "test-secret", model: "model", fetchImpl: async () => ({ ok: true, body }) });
  const completed = model.complete({ messages: [{ role: "user", content: "继续" }], onDelta: (delta) => { deltas.push(delta); received(); } });
  const send = (text) => {
    for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
  };
  send('data: {"choices":[{"delta":{"reasoning_content":"正在分析"}}]}\r\n\r\n');
  await Promise.race([firstDelta, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("首段被缓冲到结束")), 1000); timer.unref(); })]);
  assert.deepEqual(deltas, [{ kind: "reasoning", content: "正在分析" }]);
  send('data: {"choices":[{"delta":{"content":"完成"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  assert.equal((await completed).content, "完成");
});

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
