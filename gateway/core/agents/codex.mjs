import { createReducerContext, defineAgentAdapter, requireString } from "./contract.mjs";
import {
  appendItemText,
  idOf,
  normalizeContextUsage,
  normalizeUsage,
  object,
  phaseForStatus,
  planItems,
  recordItem,
  remoteArtifactPath,
  safeDomainValue,
  safeResultText,
  text,
} from "./common.mjs";

const CAPABILITIES = Object.freeze({
  start: { availability: "available", mode: "native" },
  append: { availability: "available", mode: "native" },
  interrupt: { availability: "available", mode: "native" },
  resume: { availability: "available", mode: "native" },
  compact: { availability: "available", mode: "native" },
  contextUsage: { availability: "available", mode: "native" },
});

function sourceOf(method, params = {}, item = {}, extra = {}) {
  return {
    type: method,
    id: idOf(extra.id || item.id || params.id),
    sessionId: idOf(extra.sessionId || params.threadId || params.thread?.id),
    turnId: idOf(extra.turnId || params.turnId || params.turn?.id),
    itemId: idOf(extra.itemId || item.id || params.itemId),
    requestId: idOf(extra.requestId),
  };
}

function itemText(item) {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => text(part?.text || part?.content)).filter(Boolean).join("");
  }
  return "";
}

function emitCommandItem(context, method, params, item, phase) {
  const source = sourceOf(method, params, item);
  const command = text(item.command || item.cmd);
  const itemId = idOf(item.id) || "command";
  recordItem(context.state, itemId, { type: "commandExecution", command, status: item.status });
  if (phase !== "completed") {
    context.emit("tool_call", phase, {
      name: "commandExecution",
      callId: itemId,
      input: { command, ...(item.cwd ? { cwd: String(item.cwd) } : {}) },
    }, source);
    return;
  }
  const failed = item.status === "failed" || Number(item.exitCode) > 0;
  context.emit("tool_result", failed ? "failed" : "completed", {
    name: "commandExecution",
    callId: itemId,
    text: text(item.aggregatedOutput || item.output),
    ...(Number.isFinite(Number(item.exitCode)) ? { exitCode: Number(item.exitCode) } : {}),
  }, source);
}

function emitFileItem(context, method, params, item, phase) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  context.emit("file_change", phase, {
    action: "patch",
    changes: safeDomainValue(changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      diff: change.diff,
    }))),
  }, sourceOf(method, params, item));
}

function emitToolItem(context, method, params, item, phase) {
  const itemId = idOf(item.id) || "tool";
  const name = text(item.tool || item.name || item.server || item.type || "tool");
  if (phase !== "completed") {
    context.emit("tool_call", phase, {
      name,
      callId: itemId,
      input: safeDomainValue(item.arguments || item.input || {}),
    }, sourceOf(method, params, item));
    return;
  }
  const failed = ["failed", "error"].includes(String(item.status || "").toLowerCase());
  context.emit("tool_result", failed ? "failed" : "completed", {
    name,
    callId: itemId,
    text: safeResultText(item.result || item.output || item.error),
  }, sourceOf(method, params, item));
}

function emitItem(context, method, params, item, phase) {
  const type = text(item.type);
  const source = sourceOf(method, params, item);
  const value = itemText(item);
  if (type === "agentMessage") {
    if (value) {
      context.state.finalText = value;
      context.emit("message", phase, { role: "assistant", text: value, delta: false }, source);
    }
    return;
  }
  if (type === "reasoning") {
    const summary = text(item.summary || value);
    if (summary) context.emit("reasoning", phase, { text: summary, delta: false }, source);
    return;
  }
  if (type === "plan") {
    const items = planItems(item.steps || item.items);
    context.emit("plan", phase, items.length ? { items } : { text: value }, source);
    return;
  }
  if (type === "commandExecution") return emitCommandItem(context, method, params, item, phase);
  if (type === "fileChange") return emitFileItem(context, method, params, item, phase);
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(type)) return emitToolItem(context, method, params, item, phase);
  const artifactPath = remoteArtifactPath(item.path);
  if (type === "imageGeneration" && phase === "completed" && artifactPath) {
    context.emit("artifact", phase, {
      source: "remote",
      path: artifactPath,
      kind: "image",
      name: text(item.name || artifactPath || type),
    }, source);
    return;
  }
  if (type === "imageView" || type === "imageGeneration") {
    context.emit("job_status", phase, {
      operation: type,
      message: value || text(item.path || item.status),
    }, source);
    return;
  }
  if (["webSearch", "contextCompaction", "enteredReviewMode", "exitedReviewMode"].includes(type)) {
    context.emit("job_status", phase, {
      operation: type,
      message: value || text(item.query || item.status),
    }, source);
  }
}

function emitDelta(context, method, params) {
  const itemId = idOf(params.itemId || params.item?.id) || method;
  const delta = text(params.delta || params.textDelta || params.outputDelta);
  if (!delta) return;
  const source = sourceOf(method, params, params.item, { itemId });
  if (method === "item/agentMessage/delta") {
    appendItemText(context.state, itemId, "text", delta);
    context.state.finalText = text(context.state.items[itemId]?.text);
    context.emit("message", "updated", { role: "assistant", text: delta, delta: true }, source);
  } else if (method.startsWith("item/reasoning/")) {
    appendItemText(context.state, itemId, "reasoning", delta);
    context.emit("reasoning", "updated", { text: delta, delta: true }, source);
  } else if (method === "item/plan/delta") {
    appendItemText(context.state, itemId, "plan", delta);
    context.emit("plan", "updated", { text: delta, delta: true }, source);
  } else if (method === "item/commandExecution/outputDelta") {
    appendItemText(context.state, itemId, "output", delta);
    context.emit("tool_result", "updated", { name: "commandExecution", callId: itemId, text: delta, delta: true }, source);
  } else if (method === "item/fileChange/patchUpdated") {
    context.emit("file_change", "updated", { action: "patch", diff: delta, delta: true }, source);
  }
}

function normalizeCodexTokenUsage(params) {
  const tokenUsage = object(params.tokenUsage || params.usage);
  const total = object(tokenUsage.total || tokenUsage);
  const last = object(tokenUsage.last || {});
  const usage = normalizeUsage(total);
  const context = normalizeContextUsage({
    used: usage.total,
    limit: params.modelContextWindow || tokenUsage.modelContextWindow,
  });
  return { usage, context, last: normalizeUsage(last) };
}

function reduceCodex(previousState, frame, producer) {
  const context = createReducerContext(previousState, producer);
  const method = text(frame.method);
  const params = object(frame.params);

  if (!method && frame.id != null && context.state.pendingApprovals[String(frame.id)]) {
    const requestId = String(frame.id);
    const pending = context.state.pendingApprovals[requestId];
    delete context.state.pendingApprovals[requestId];
    context.emit("approval_response", frame.error ? "failed" : "completed", {
      requestId,
      decision: text(frame.result?.decision || frame.result || (frame.error ? "error" : "completed")),
    }, sourceOf("jsonrpc/response", {}, {}, { requestId, itemId: pending.itemId }));
    return { state: context.state, events: context.events };
  }

  if (method === "thread/started" || method === "thread/resumed") {
    context.state.sessionId = idOf(params.thread?.id || params.threadId);
    context.state.status = "idle";
    context.emit("status", "completed", { status: method === "thread/started" ? "thread_started" : "thread_resumed" }, sourceOf(method, params));
  } else if (method === "turn/started") {
    context.state.turnId = idOf(params.turn?.id || params.turnId);
    context.state.status = "running";
    context.state.finalSeen = false;
    context.emit("status", "started", { status: "running" }, sourceOf(method, params));
  } else if (method === "turn/completed") {
    const status = text(params.turn?.status || params.status || "completed");
    context.state.status = status;
    const phase = phaseForStatus(status, "completed");
    context.emit("status", phase, { status }, sourceOf(method, params));
    if (phase === "failed") {
      context.emit("error", "failed", { message: text(params.turn?.error?.message || params.error?.message || "Codex turn failed") }, sourceOf(method, params));
    } else {
      context.state.finalSeen = true;
      context.emit("final", phase, { text: context.state.finalText }, sourceOf(method, params));
    }
  } else if (method === "item/started" || method === "item/updated" || method === "item/completed") {
    const phase = method === "item/started" ? "started" : method === "item/completed" ? "completed" : "updated";
    emitItem(context, method, params, object(params.item), phase);
  } else if (method.includes("/delta") || method.endsWith("/outputDelta") || method.endsWith("/patchUpdated") || method.endsWith("/summaryTextDelta") || method.endsWith("/textDelta")) {
    emitDelta(context, method, params);
  } else if (method === "thread/tokenUsage/updated") {
    const normalized = normalizeCodexTokenUsage(params);
    context.state.contextUsage = normalized.context;
    context.emit("usage", "updated", normalized, sourceOf(method, params));
  } else if (method.endsWith("/requestApproval")) {
    const requestId = idOf(frame.id);
    if (requestId) context.state.pendingApprovals[requestId] = { itemId: idOf(params.itemId) };
    context.emit("approval_request", "waiting", {
      requestId,
      action: method.includes("fileChange") ? "file_change" : "command_execution",
      reason: text(params.reason),
      details: safeDomainValue(params.command ? { command: params.command } : params.changes || {}),
    }, sourceOf(method, params, {}, { requestId }));
  } else if (method === "error") {
    const message = text(params.error?.message || params.message || "Codex app-server error");
    const retrying = params.willRetry === true
      || params.retryable === true
      || params.error?.willRetry === true
      || params.error?.retryable === true
      || /^reconnecting(?:\.{3}|…)?\s*\d+\s*\/\s*\d+/i.test(message);
    if (retrying) {
      context.state.status = "running";
      context.emit("status", "updated", { status: "reconnecting", message }, sourceOf(method, params));
    } else {
      context.state.status = "error";
      context.emit("error", "failed", { message }, sourceOf(method, params));
    }
  } else if (method === "turn/diff/updated") {
    context.emit("file_change", "updated", { action: "diff", diff: text(params.diff) }, sourceOf(method, params));
  } else if (method === "serverRequest/resolved") {
    context.emit("approval_response", "completed", {
      requestId: idOf(params.requestId),
      decision: text(params.decision || "resolved"),
    }, sourceOf(method, params, {}, { requestId: params.requestId }));
  }

  return { state: context.state, events: context.events };
}

function rpc(method, params) {
  return { method, params };
}

function buildCodexOperation(operation, input) {
  if (operation === "start") {
    const prompt = requireString(input, "prompt", operation);
    if (input.threadId) {
      return { transport: "json-rpc", calls: [rpc("turn/start", { threadId: String(input.threadId), input: [{ type: "text", text: prompt }] })] };
    }
    return {
      transport: "json-rpc",
      calls: [
        rpc("thread/start", input.cwd ? { cwd: String(input.cwd) } : {}),
        rpc("turn/start", { threadId: "$thread.id", input: [{ type: "text", text: prompt }] }),
      ],
    };
  }
  if (operation === "append") {
    return {
      transport: "json-rpc",
      calls: [rpc("turn/steer", {
        threadId: requireString(input, "threadId", operation),
        expectedTurnId: requireString(input, "turnId", operation),
        input: [{ type: "text", text: requireString(input, "prompt", operation) }],
      })],
    };
  }
  if (operation === "interrupt") {
    return { transport: "json-rpc", calls: [rpc("turn/interrupt", { threadId: requireString(input, "threadId", operation), turnId: requireString(input, "turnId", operation) })] };
  }
  if (operation === "resume") {
    const threadId = requireString(input, "threadId", operation);
    const prompt = requireString(input, "prompt", operation);
    return { transport: "json-rpc", calls: [rpc("thread/resume", { threadId }), rpc("turn/start", { threadId, input: [{ type: "text", text: prompt }] })] };
  }
  if (operation === "compact") {
    return { transport: "json-rpc", calls: [rpc("thread/compact/start", { threadId: requireString(input, "threadId", operation) })] };
  }
  return { transport: "event-cache", action: "thread-token-usage.snapshot", threadId: idOf(input.threadId) };
}

export function createCodexAdapter(options = {}) {
  return defineAgentAdapter({
    id: "codex",
    protocol: "codex-app-server-jsonrpc",
    capabilities: CAPABILITIES,
    reduce: reduceCodex,
    buildOperation: buildCodexOperation,
  }, options);
}
