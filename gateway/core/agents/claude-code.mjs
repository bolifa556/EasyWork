import { createReducerContext, defineAgentAdapter, requireString } from "./contract.mjs";
import {
  appendItemText,
  array,
  fileChangeFromTool,
  idOf,
  normalizeContextUsage,
  normalizeUsage,
  object,
  phaseForStatus,
  planItems,
  recordItem,
  safeDomainValue,
  text,
  toolNameIsFileChange,
} from "./common.mjs";

const CAPABILITIES = Object.freeze({
  start: { availability: "available", mode: "native" },
  append: { availability: "available", mode: "native" },
  interrupt: { availability: "available", mode: "process-signal" },
  resume: { availability: "available", mode: "native" },
  compact: { availability: "available", mode: "native" },
  contextUsage: { availability: "available", mode: "derived" },
});

function sourceOf(type, frame = {}, extra = {}) {
  return {
    type,
    id: idOf(extra.id || frame.uuid || frame.id),
    sessionId: idOf(extra.sessionId || frame.session_id || frame.sessionId),
    itemId: idOf(extra.itemId),
    requestId: idOf(extra.requestId || frame.request_id || frame.requestId),
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  return array(content).map((entry) => text(entry?.text || entry?.content)).filter(Boolean).join("");
}

function toolPlan(name, input) {
  if (name === "TodoWrite") return planItems(input.todos);
  if (name === "TaskCreate") return planItems([{
    id: input.taskId || input.id,
    content: input.subject || input.description,
    status: input.status || "pending",
  }]);
  if (name === "TaskUpdate") return planItems([{
    id: input.taskId || input.id,
    content: input.subject || input.description || `Task ${input.taskId || input.id || ""}`,
    status: input.status || "in_progress",
  }]);
  return [];
}

function emitAssistantContent(context, frame, content, completed = false) {
  for (let index = 0; index < content.length; index += 1) {
    const block = object(content[index]);
    const itemId = idOf(block.id) || `${frame.uuid || "assistant"}:${index}`;
    const source = sourceOf(frame.type, frame, { itemId });
    if (block.type === "text" && block.text) {
      const knownText = text(context.state.items[itemId]?.text);
      if (knownText !== text(block.text)) context.state.finalText = `${context.state.finalText}${text(block.text)}`;
      recordItem(context.state, itemId, { partType: "text", text: text(block.text) });
      context.emit("message", completed ? "completed" : "updated", {
        role: "assistant",
        text: text(block.text),
        delta: false,
      }, source);
    } else if (block.type === "thinking" && block.thinking) {
      recordItem(context.state, itemId, { partType: "thinking", reasoning: text(block.thinking) });
      context.emit("reasoning", completed ? "completed" : "updated", { text: text(block.thinking), delta: false }, source);
    } else if (block.type === "tool_use") {
      const name = text(block.name || "tool");
      const input = object(block.input);
      const alreadyStarted = Boolean(context.state.items[itemId]);
      recordItem(context.state, itemId, { type: "tool", name, input: safeDomainValue(input), status: "running" });
      context.emit("tool_call", alreadyStarted ? "updated" : "started", { name, callId: itemId, input: safeDomainValue(input) }, source);
      const items = toolPlan(name, input);
      if (items.length) context.emit("plan", "updated", { items }, source);
    }
  }
}

function emitToolResults(context, frame, content) {
  for (const rawBlock of content) {
    const block = object(rawBlock);
    if (block.type !== "tool_result") continue;
    const toolId = idOf(block.tool_use_id || block.toolUseId) || "tool";
    const known = object(context.state.items[toolId]);
    const name = text(known.name || "tool");
    const failed = Boolean(block.is_error || block.isError);
    const source = sourceOf(frame.type, frame, { itemId: toolId });
    context.emit("tool_result", failed ? "failed" : "completed", {
      name,
      callId: toolId,
      text: contentText(block.content),
    }, source);
    if (toolNameIsFileChange(name)) {
      context.emit("file_change", failed ? "failed" : "completed", fileChangeFromTool(name, known.input, { content: contentText(block.content) }), source);
    }
  }
}

function emitStreamEvent(context, frame) {
  const event = object(frame.event);
  const eventType = text(event.type);
  const index = Number.isInteger(event.index) ? event.index : 0;
  const itemId = `${frame.uuid || frame.session_id || "stream"}:${index}`;
  const source = sourceOf(`stream_event/${eventType}`, frame, { itemId });
  if (eventType === "content_block_start") {
    const block = object(event.content_block || event.contentBlock);
    recordItem(context.state, itemId, {
      partType: block.type,
      toolId: idOf(block.id),
      name: text(block.name),
      input: safeDomainValue(block.input || {}),
    });
    if (block.type === "tool_use") {
      const toolId = idOf(block.id) || itemId;
      recordItem(context.state, toolId, { type: "tool", name: text(block.name || "tool"), input: safeDomainValue(block.input || {}), status: "running" });
      context.emit("tool_call", "started", { name: text(block.name || "tool"), callId: toolId, input: safeDomainValue(block.input || {}) }, sourceOf(`stream_event/${eventType}`, frame, { itemId: toolId }));
    }
  } else if (eventType === "content_block_delta") {
    const delta = object(event.delta);
    const known = object(context.state.items[itemId]);
    if (delta.type === "text_delta") {
      appendItemText(context.state, itemId, "text", text(delta.text));
      context.state.finalText = `${context.state.finalText}${text(delta.text)}`;
      context.emit("message", "updated", { role: "assistant", text: text(delta.text), delta: true }, source);
    } else if (delta.type === "thinking_delta") {
      appendItemText(context.state, itemId, "reasoning", text(delta.thinking));
      context.emit("reasoning", "updated", { text: text(delta.thinking), delta: true }, source);
    } else if (delta.type === "input_json_delta") {
      const toolId = idOf(known.toolId) || itemId;
      appendItemText(context.state, itemId, "partialJson", text(delta.partial_json));
      context.emit("tool_call", "updated", {
        name: text(known.name || "tool"),
        callId: toolId,
        partialJson: text(delta.partial_json),
      }, sourceOf(`stream_event/${eventType}`, frame, { itemId: toolId }));
    }
  } else if (eventType === "content_block_stop") {
    const known = object(context.state.items[itemId]);
    const kind = known.partType === "thinking" ? "reasoning" : known.partType === "tool_use" ? "tool_call" : "message";
    context.emit(kind, "completed", kind === "message"
      ? { role: "assistant", text: text(known.text), delta: false }
      : kind === "reasoning"
        ? { text: text(known.reasoning), delta: false }
        : { name: text(known.name || "tool"), callId: idOf(known.toolId) || itemId }, source);
  } else if (eventType === "message_delta") {
    const usage = normalizeUsage(event.usage);
    if (Object.keys(usage).length) {
      const contextUsage = normalizeContextUsage({ used: usage.total });
      context.state.contextUsage = contextUsage;
      context.emit("usage", "updated", { ...usage, context: contextUsage }, source);
    }
  } else if (eventType === "message_stop") {
    context.emit("status", "completed", { status: "message_complete" }, source);
  }
}

function emitResult(context, frame) {
  const usage = normalizeUsage(frame.usage);
  if (Object.keys(usage).length) {
    const contextUsage = normalizeContextUsage({ used: usage.total, limit: frame.model_context_window });
    context.state.contextUsage = contextUsage;
    context.emit("usage", "completed", { ...usage, context: contextUsage }, sourceOf(frame.type, frame));
  }
  const failed = Boolean(frame.is_error) || ["error", "failed"].includes(String(frame.subtype || "").toLowerCase());
  context.state.status = failed ? "error" : "completed";
  if (failed) {
    context.emit("error", "failed", { message: text(frame.result || frame.error || "Claude Code failed") }, sourceOf(frame.type, frame));
  } else {
    const resultText = text(frame.result || context.state.finalText);
    context.state.finalText = resultText;
    context.state.finalSeen = true;
    context.emit("final", "completed", { text: resultText }, sourceOf(frame.type, frame));
  }
  context.emit("status", failed ? "failed" : "completed", { status: context.state.status }, sourceOf(frame.type, frame));
}

function reduceClaudeCode(previousState, frame, producer) {
  const context = createReducerContext(previousState, producer);
  const type = text(frame.type);
  if (frame.session_id || frame.sessionId) context.state.sessionId = idOf(frame.session_id || frame.sessionId);

  if (type === "system") {
    const subtype = text(frame.subtype);
    if (subtype === "init") {
      context.state.status = "idle";
      context.emit("status", "completed", {
        status: "initialized",
        model: text(frame.model),
        tools: array(frame.tools).map(String),
        slashCommands: array(frame.slash_commands || frame.slashCommands).map(String),
      }, sourceOf(type, frame));
    } else if (subtype === "compact_boundary") {
      context.emit("job_status", "completed", { operation: "compact", preTokens: Number(frame.compact_metadata?.pre_tokens || 0) }, sourceOf(type, frame));
    } else {
      context.emit("job_status", phaseForStatus(frame.status, "updated"), {
        operation: subtype || "system",
        message: text(frame.message || frame.error),
      }, sourceOf(type, frame));
    }
  } else if (type === "stream_event") {
    emitStreamEvent(context, frame);
  } else if (type === "assistant") {
    emitAssistantContent(context, frame, array(frame.message?.content || frame.content), true);
  } else if (type === "user") {
    emitToolResults(context, frame, array(frame.message?.content || frame.content));
  } else if (type === "result") {
    emitResult(context, frame);
  } else if (type === "control_request") {
    const request = object(frame.request);
    const requestId = idOf(frame.request_id || frame.requestId);
    if (requestId) context.state.pendingApprovals[requestId] = { itemId: idOf(request.tool_use_id || request.toolUseId) };
    context.emit("approval_request", "waiting", {
      requestId,
      action: text(request.subtype || "can_use_tool"),
      tool: text(request.tool_name || request.toolName),
      input: safeDomainValue(request.input || {}),
    }, sourceOf(type, frame, { requestId, itemId: request.tool_use_id || request.toolUseId }));
  } else if (type === "control_response") {
    const response = object(frame.response);
    const requestId = idOf(response.request_id || response.requestId || frame.request_id || frame.requestId);
    if (requestId) delete context.state.pendingApprovals[requestId];
    context.emit("approval_response", response.subtype === "error" ? "failed" : "completed", {
      requestId,
      decision: text(response.response?.behavior || response.behavior || response.subtype),
    }, sourceOf(type, frame, { requestId }));
  }

  return { state: context.state, events: context.events };
}

function userFrame(prompt) {
  return { type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] }, parent_tool_use_id: null };
}

function processDescriptor(args, stdin, cwd) {
  return { transport: "process-jsonl", executable: "claude", args, ...(cwd ? { cwd: String(cwd) } : {}), ...(stdin ? { stdin } : {}) };
}

function baseArgs() {
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
}

function buildClaudeCodeOperation(operation, input) {
  if (operation === "start") {
    const prompt = requireString(input, "prompt", operation);
    const args = baseArgs();
    return processDescriptor(args, [userFrame(prompt)], input.cwd);
  }
  if (operation === "append") {
    return { transport: "process-jsonl-stdin", frames: [userFrame(requireString(input, "prompt", operation))] };
  }
  if (operation === "interrupt") {
    return { transport: "process-signal", signal: "SIGINT", processId: requireString(input, "processId", operation) };
  }
  if (operation === "resume") {
    const args = [...baseArgs(), "--resume", requireString(input, "sessionId", operation)];
    return processDescriptor(args, [userFrame(requireString(input, "prompt", operation))], input.cwd);
  }
  if (operation === "compact") {
    if (input.processId) return { transport: "process-jsonl-stdin", frames: [userFrame("/compact")] };
    const args = [...baseArgs(), "--resume", requireString(input, "sessionId", operation)];
    return processDescriptor(args, [userFrame("/compact")], input.cwd);
  }
  return { transport: "event-cache", action: "result-usage.snapshot", sessionId: idOf(input.sessionId) };
}

export function createClaudeCodeAdapter(options = {}) {
  return defineAgentAdapter({
    id: "claude-code",
    protocol: "claude-code-stream-json",
    capabilities: CAPABILITIES,
    reduce: reduceClaudeCode,
    buildOperation: buildClaudeCodeOperation,
  }, options);
}
