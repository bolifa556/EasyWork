import { invariant } from "../errors.mjs";

function endpoint(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  invariant(/^https?:\/\//i.test(value), "MODEL_URL_INVALID", "模型 API URL 无效", { status: 400 });
  if (/\/chat\/completions$/i.test(value)) return value;
  return /\/v1$/i.test(value) ? `${value}/chat/completions` : `${value}/v1/chat/completions`;
}

function openAiMessages(messages, systemMessageSeparator) {
  const converted = messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
        tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input || {}) } })),
      };
    }
    if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    return { role: message.role, content: message.content };
  });
  const systemContent = converted
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content.trim() : JSON.stringify(message.content ?? ""))
    .filter(Boolean)
    .join(systemMessageSeparator);
  const conversation = converted.filter((message) => message.role !== "system");
  return systemContent ? [{ role: "system", content: systemContent }, ...conversation] : conversation;
}

function openAiTools(tools) {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
}

function openAiToolChoice(value, tools) {
  if (!tools.length) return undefined;
  if (value === undefined || value === null) return "auto";
  if (["auto", "none", "required"].includes(value)) return value;
  const name = typeof value === "string" ? value : String(value?.name || "");
  invariant(tools.some((tool) => tool.name === name), "MODEL_TOOL_CHOICE_INVALID", "指定的模型工具不可用", { status: 500, expose: false });
  return { type: "function", function: { name } };
}

function mergeToolDelta(target, delta, index) {
  // OpenAI-compatible providers commonly include the call id only on the
  // first streamed delta and identify every continuation solely by index.
  // Keying the first chunk by id therefore splits one native tool call into
  // two model calls (the second one has no name and incomplete arguments).
  const key = `index_${index}`;
  const existing = target.get(key) || { id: delta.id || key, name: "", arguments: "" };
  if (delta.id) existing.id = delta.id;
  existing.name += delta.function?.name || "";
  existing.arguments += delta.function?.arguments || "";
  target.set(key, existing);
}

async function parseSse(response, onPayload) {
  invariant(response.body, "MODEL_STREAM_UNAVAILABLE", "模型 API 未返回流", { status: 502 });
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      // [DONE] terminates one Chat Completions response. Some compatible
      // providers deliberately keep the HTTP connection reusable after this
      // marker instead of closing the body. Waiting for EOF in that case left
      // EasyWork's Web Agent permanently "thinking" after the model had
      // already finished, so stop consuming the stream at the protocol
      // boundary itself. Breaking the async iterator also cancels the unused
      // response body.
      if (data === "[DONE]") {
        terminal = true;
        break;
      }
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      await onPayload(parsed);
    }
    if (terminal) break;
  }
}

export class OpenAIChatModel {
  constructor({ baseUrl, apiKey, model, protocol = "auto", fetchImpl = fetch, temperature = null, systemMessageSeparator }) {
    invariant(typeof apiKey === "string" && apiKey, "MODEL_API_KEY_REQUIRED", "模型 API Key 未配置", { status: 503, retryable: true });
    invariant(typeof model === "string" && model.trim(), "MODEL_REQUIRED", "未选择模型", { status: 409 });
    invariant(["auto", "chat-completions"].includes(protocol), "MODEL_PROTOCOL_UNSUPPORTED", "网页 Agent 当前需要 Chat Completions 协议", { status: 409 });
    invariant(typeof systemMessageSeparator === "string" && systemMessageSeparator.length > 0, "MODEL_CONTEXT_LAYOUT_REQUIRED", "模型上下文布局未配置", { status: 500, expose: false });
    this.url = endpoint(baseUrl);
    this.apiKey = apiKey;
    this.model = model.trim();
    this.fetchImpl = fetchImpl;
    this.temperature = temperature;
    this.systemMessageSeparator = systemMessageSeparator;
  }

  async complete({ messages, tools = [], toolChoice, limits, signal, onDelta }) {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: openAiMessages(messages, this.systemMessageSeparator),
        tools: tools.length ? openAiTools(tools) : undefined,
        tool_choice: openAiToolChoice(toolChoice, tools),
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
      let invalidArguments = false;
      try { input = JSON.parse(call.arguments || "{}"); } catch { invalidArguments = true; }
      // Keep a malformed native tool call inside the Agent protocol instead
      // of aborting the whole turn at the transport boundary. The runtime can
      // now return a tool-result error to Chat models, or apply Work's bounded
      // terminal-submit recovery without exposing provider output to users.
      return { id: call.id, name: call.name, input, ...(invalidArguments ? { invalidArguments: true } : {}) };
    });
    return { content, reasoning, toolCalls, usage };
  }
}

export { endpoint as openAIChatEndpoint, parseSse };
