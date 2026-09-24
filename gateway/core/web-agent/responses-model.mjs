import { invariant } from "../errors.mjs";

export function isOpenAIReasoningModel(model) {
  const name = String(model).split("/").at(-1);
  return /^(?:o[1-9](?:-|$)|gpt-(?:[5-9]|[1-9]\d)(?:[.-]|$))/i.test(name) && !/-chat(?:-|$)/i.test(name);
}

export function reasoningEffort(model) {
  return /-pro(?:-|$)/i.test(String(model)) ? "high" : "medium";
}

export function responsesBody({ model, messages, tools, toolChoice, limits, systemMessageSeparator }) {
  const instructions = messages.filter((entry) => entry.role === "system")
    .map((entry) => String(entry.content || "").trim()).filter(Boolean).join(systemMessageSeparator);
  const input = messages.filter((entry) => entry.role !== "system").flatMap((entry) => {
    if (entry.role === "tool") return [{ type: "function_call_output", call_id: entry.toolCallId, output: entry.content }];
    // Keep the provider's reasoning item (including its encrypted continuation)
    // with the corresponding function call during this tool loop only.
    if (entry.role === "assistant" && entry.responseItems?.length) return entry.responseItems;
    const content = Array.isArray(entry.content) ? entry.content.map((part) => part.type === "image_url"
      ? { type: "input_image", image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) }
      : { type: "input_text", text: part.text || "" }) : entry.content || "";
    return [
      ...(content ? [{ role: entry.role, content }] : []),
      ...(entry.toolCalls || []).map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.input || {}) })),
    ];
  });
  return {
    model, input, ...(instructions ? { instructions } : {}), store: false, stream: true,
    ...(isOpenAIReasoningModel(model) ? { reasoning: { effort: reasoningEffort(model), summary: "auto" }, include: ["reasoning.encrypted_content"] } : {}),
    ...(tools.length ? {
      tools: tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
      tool_choice: typeof toolChoice === "object" ? { type: "function", name: toolChoice.function.name } : toolChoice,
    } : {}),
    ...(Number.isFinite(limits.maxOutputTokens) && limits.maxOutputTokens > 0 ? { max_output_tokens: limits.maxOutputTokens } : {}),
  };
}

export async function readResponses(response, { parseSse, onDelta, onActivity }) {
  let content = "";
  let reasoning = "";
  let usage = null;
  let terminal = false;
  const items = new Map();
  const texts = new Map();
  const emitText = async (kind, key, text, complete = false) => {
    if (typeof text !== "string" || !text) return;
    const previous = texts.get(key) || "";
    const delta = complete ? (text.startsWith(previous) ? text.slice(previous.length) : previous ? "" : text) : text;
    texts.set(key, complete ? text : previous + text);
    if (!delta) return;
    if (kind === "content") content += delta;
    else reasoning += delta;
    await onDelta?.({ kind, content: delta });
  };
  const acceptItem = async (index, item) => {
    if (!item) return;
    items.set(index, item);
    const key = item.id || index;
    for (const [partIndex, part] of (item.summary || []).entries()) {
      if (part.type === "summary_text") await emitText("reasoning", `reasoning:${key}:${partIndex}`, part.text, true);
    }
    for (const [partIndex, part] of (item.content || []).entries()) {
      if (part.type === "output_text" || part.type === "refusal") await emitText("content", `content:${key}:${partIndex}`, part.text || part.refusal, true);
    }
  };
  const accept = async (payload) => {
    const type = payload.type;
    if (type === "error" || type === "response.failed") {
      invariant(false, "MODEL_REQUEST_FAILED", payload.response?.error?.message || payload.message || payload.error?.message || "模型流返回错误", { status: 502, retryable: true });
    }
    if (type?.startsWith("response.")) await onActivity?.();
    const index = payload.output_index ?? 0;
    if (type === "response.output_item.added" || type === "response.output_item.done") await acceptItem(index, payload.item);
    const key = payload.item_id || items.get(index)?.id || index;
    if (type === "response.output_text.delta" || type === "response.refusal.delta") await emitText("content", `content:${key}:${payload.content_index ?? 0}`, payload.delta);
    if (type === "response.output_text.done" || type === "response.refusal.done") await emitText("content", `content:${key}:${payload.content_index ?? 0}`, payload.text || payload.refusal, true);
    if (type === "response.reasoning_summary_text.delta") await emitText("reasoning", `reasoning:${key}:${payload.summary_index ?? 0}`, payload.delta);
    if (type === "response.reasoning_summary_text.done") await emitText("reasoning", `reasoning:${key}:${payload.summary_index ?? 0}`, payload.text, true);
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const item = items.get(index) || { type: "function_call", id: payload.item_id };
      items.set(index, { ...item, arguments: type.endsWith(".done") ? payload.arguments : (item.arguments || "") + (payload.delta || "") });
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const result = payload.response || {};
      usage = result.usage || usage;
      for (const [outputIndex, item] of (result.output || []).entries()) await acceptItem(outputIndex, item);
      invariant(type !== "response.incomplete", "MODEL_RESPONSE_INCOMPLETE", `模型输出未完成：${result.incomplete_details?.reason || "响应被截断"}`, { status: 502, retryable: true });
      terminal = true;
      return true;
    }
    return false;
  };
  if (response.headers?.get("content-type")?.includes("application/json")) {
    const result = await response.json();
    await accept({ type: result.status === "failed" ? "response.failed" : result.status === "incomplete" ? "response.incomplete" : "response.completed", response: result });
  } else await parseSse(response, accept);
  invariant(terminal, "MODEL_STREAM_INCOMPLETE", "模型流在完成事件前断开", { status: 502, retryable: true });
  const responseItems = [...items.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
  const toolCalls = responseItems.filter((item) => item.type === "function_call").map((item) => {
    let input = {};
    let invalidArguments = false;
    try { input = JSON.parse(item.arguments || "{}"); } catch { invalidArguments = true; }
    return { id: item.call_id || item.id, name: item.name, input, ...(invalidArguments ? { invalidArguments: true } : {}) };
  });
  return { content, reasoning, toolCalls, usage, responseItems };
}
