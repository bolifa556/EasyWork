import { invariant } from "../errors.mjs";

function endpoint(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  invariant(/^https?:\/\//i.test(value), "MODEL_URL_INVALID", "模型 API URL 无效", { status: 400 });
  return /\/chat\/completions$/i.test(value) ? value : `${value}/v1/chat/completions`;
}

function openAiMessages(messages) {
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input || {}) } })),
      };
    }
    if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    return { role: message.role, content: message.content };
  });
}

function openAiTools(tools) {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

function mergeToolDelta(target, delta, index) {
  const key = delta.id || `index_${index}`;
  const existing = target.get(key) || { id: delta.id || key, name: "", arguments: "" };
  if (delta.id && existing.id.startsWith("index_")) existing.id = delta.id;
  existing.name += delta.function?.name || "";
  existing.arguments += delta.function?.arguments || "";
  target.set(key, existing);
}

async function parseSse(response, onPayload) {
  invariant(response.body, "MODEL_STREAM_UNAVAILABLE", "模型 API 未返回流", { status: 502 });
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      await onPayload(parsed);
    }
  }
}

export class OpenAIChatModel {
  constructor({ baseUrl, apiKey, model, protocol = "auto", fetchImpl = fetch, temperature = null }) {
    invariant(typeof apiKey === "string" && apiKey, "MODEL_API_KEY_REQUIRED", "模型 API Key 未配置", { status: 503, retryable: true });
    invariant(typeof model === "string" && model.trim(), "MODEL_REQUIRED", "未选择模型", { status: 409 });
    invariant(["auto", "chat-completions"].includes(protocol), "MODEL_PROTOCOL_UNSUPPORTED", "网页 Agent 当前需要 Chat Completions 协议", { status: 409 });
    this.url = endpoint(baseUrl);
    this.apiKey = apiKey;
    this.model = model.trim();
    this.fetchImpl = fetchImpl;
    this.temperature = temperature;
  }

  async complete({ messages, tools, limits, signal, onDelta }) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: openAiMessages(messages),
        tools: tools.length ? openAiTools(tools) : undefined,
        tool_choice: tools.length ? "auto" : undefined,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: limits.maxOutputTokens,
        ...(this.temperature === null ? {} : { temperature: this.temperature }),
      }),
      signal,
    });
    let errorBody = null;
    if (!response.ok) {
      try { errorBody = await response.json(); } catch { /* handled below */ }
      invariant(false, "MODEL_REQUEST_FAILED", errorBody?.error?.message || `模型 API 返回 ${response.status}`, { status: 502, retryable: response.status >= 500 });
    }
    let content = "";
    let reasoning = "";
    let usage = null;
    const toolDeltas = new Map();
    await parseSse(response, async (payload) => {
      usage = payload.usage || usage;
      const delta = payload.choices?.[0]?.delta || {};
      const contentDelta = delta.content || "";
      const reasoningDelta = delta.reasoning_content || delta.reasoning || "";
      if (contentDelta) { content += contentDelta; await onDelta?.({ kind: "content", content: contentDelta }); }
      if (reasoningDelta) { reasoning += reasoningDelta; await onDelta?.({ kind: "reasoning", content: reasoningDelta }); }
      for (const [index, tool] of (delta.tool_calls || []).entries()) mergeToolDelta(toolDeltas, tool, tool.index ?? index);
    });
    const toolCalls = [...toolDeltas.values()].map((call) => {
      let input = {};
      try { input = JSON.parse(call.arguments || "{}"); } catch { invariant(false, "MODEL_TOOL_ARGUMENTS_INVALID", `模型返回了无效工具参数：${call.name}`, { status: 502 }); }
      return { id: call.id, name: call.name, input };
    });
    return { content, reasoning, toolCalls, usage };
  }
}

export { endpoint as openAIChatEndpoint, parseSse };
