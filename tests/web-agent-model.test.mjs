import assert from "node:assert/strict";
import test from "node:test";

import { OpenAIChatModel } from "../gateway/core/web-agent/index.mjs";

function stream(lines) {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(lines)); controller.close(); } });
}

test("OpenAI chat model streams reasoning and final text while assembling tool arguments", async () => {
  const deltas = [];
  const model = new OpenAIChatModel({
    baseUrl: "https://models.example.test",
    apiKey: "test-secret",
    model: "reasoning-model",
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.stringify(JSON.parse(request.body)).includes("test-secret"), false);
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
  });
  assert.equal(result.reasoning, "检查");
  assert.equal(result.content, "完成");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "context_get_state", input: {} }]);
  assert.deepEqual(deltas.map((entry) => entry.kind), ["reasoning", "content"]);
});
