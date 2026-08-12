import { createReducerContext, defineAgentAdapter, requireString } from "./contract.mjs";
import {
  appendItemText,
  fileChangeFromTool,
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
  toolNameIsFileChange,
} from "./common.mjs";

const CAPABILITIES = Object.freeze({
  start: { availability: "available", mode: "native" },
  append: { availability: "available", mode: "native" },
  interrupt: { availability: "available", mode: "native" },
  resume: { availability: "available", mode: "native" },
  compact: { availability: "available", mode: "native" },
  contextUsage: { availability: "available", mode: "derived" },
});

function sourceOf(type, properties, extra = {}) {
  return {
    type,
    id: idOf(extra.id || properties.id),
    sessionId: idOf(extra.sessionId || properties.sessionID || properties.sessionId),
    itemId: idOf(extra.itemId || properties.partID || properties.partId || properties.messageID || properties.messageId),
    requestId: idOf(extra.requestId || properties.requestID || properties.requestId),
  };
}

function emitUsage(context, usage, type, properties, extra = {}) {
  const normalized = normalizeUsage(usage);
  if (Object.keys(normalized).length === 0) return;
  const contextUsage = normalizeContextUsage({ used: normalized.total, limit: extra.limit });
  if (Object.keys(contextUsage).length) context.state.contextUsage = contextUsage;
  context.emit("usage", "updated", { ...normalized, ...(Object.keys(contextUsage).length ? { context: contextUsage } : {}) }, sourceOf(type, properties, extra));
}

function emitTextPart(context, type, properties, part, delta) {
  const messageId = idOf(part.messageID || part.messageId || properties.messageID || properties.messageId);
  const partId = idOf(part.id || properties.partID || properties.partId) || `${messageId || "message"}:text`;
  const role = context.state.messageRoles[messageId] || text(part.role || properties.role || "assistant");
  if (role === "user") return;
  const hasDelta = typeof delta === "string";
  const content = appendItemText(context.state, partId, "text", hasDelta ? delta : "", hasDelta ? undefined : part.text);
  recordItem(context.state, partId, { partType: "text" });
  if (!content && !delta) return;
  context.state.finalText = content;
  context.emit("message", "updated", {
    role: role || "assistant",
    text: hasDelta ? delta : content,
    delta: hasDelta,
  }, sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: partId }));
}

function emitReasoningPart(context, type, properties, part, delta) {
  const partId = idOf(part.id || properties.partID || properties.partId) || "reasoning";
  const hasDelta = typeof delta === "string";
  const content = appendItemText(context.state, partId, "reasoning", hasDelta ? delta : "", hasDelta ? undefined : part.text);
  recordItem(context.state, partId, { partType: "reasoning" });
  if (!content && !delta) return;
  context.emit("reasoning", part.time?.end ? "completed" : "updated", {
    text: hasDelta ? delta : content,
    delta: hasDelta,
  }, sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: partId }));
}

function emitToolPart(context, type, properties, part) {
  const state = object(part.state);
  const status = text(state.status || "pending");
  const toolId = idOf(part.callID || part.callId || part.id) || "tool";
  const name = text(part.tool || part.name || "tool");
  const source = sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: toolId });
  recordItem(context.state, toolId, { type: "tool", name, status });
  if (["pending", "running"].includes(status)) {
    context.emit("tool_call", status === "pending" ? "started" : "updated", {
      name,
      callId: toolId,
      input: safeDomainValue(state.input || part.input || {}),
    }, source);
    return;
  }
  const failed = status === "error";
  const output = state.output ?? state.error ?? part.output;
  context.emit("tool_result", failed ? "failed" : "completed", {
    name,
    callId: toolId,
    text: safeResultText(output),
    ...(failed ? { error: text(state.error || "Tool failed") } : {}),
  }, source);
  if (toolNameIsFileChange(name)) {
    context.emit("file_change", failed ? "failed" : "completed", fileChangeFromTool(name, state.input || part.input, output), source);
  }
  for (const attachment of Array.isArray(state.attachments) ? state.attachments : []) {
    const path = remoteArtifactPath(attachment.path || attachment.url);
    if (!path) continue;
    context.emit("artifact", "completed", {
      source: "remote",
      path,
      name: text(attachment.filename || "artifact"),
      kind: "file",
    }, sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: attachment.id || toolId }));
  }
}

function emitPart(context, type, properties, part, delta) {
  const partType = text(part.type);
  if (partType === "text") return emitTextPart(context, type, properties, part, delta);
  if (partType === "reasoning") return emitReasoningPart(context, type, properties, part, delta);
  if (partType === "tool") return emitToolPart(context, type, properties, part);
  if (partType === "patch") {
    const files = Array.isArray(part.files) ? part.files : [];
    if (!files.length) return;
    return context.emit("file_change", "completed", {
      action: "patch",
      files: safeDomainValue(files),
      ...(part.hash ? { hash: String(part.hash) } : {}),
    }, sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: part.id }));
  }
  if (partType === "step-finish") {
    emitUsage(context, part.tokens, type, properties, { sessionId: part.sessionID || part.sessionId, itemId: part.id });
    return;
  }
  if (partType === "file") {
    const path = remoteArtifactPath(part.path || part.url);
    if (!path) return;
    return context.emit("artifact", "completed", {
      source: "remote",
      path,
      name: text(part.filename || part.name || "artifact"),
      kind: "file",
    }, sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: part.id }));
  }
  if (["subtask", "agent"].includes(partType)) {
    return context.emit("job_status", "started", {
      operation: partType,
      message: text(part.description || part.name || part.prompt),
    }, sourceOf(type, properties, { sessionId: part.sessionID, itemId: part.id }));
  }
  if (["step-start", "retry", "compaction"].includes(partType)) {
    return context.emit("job_status", partType === "retry" ? "waiting" : "updated", {
      operation: partType,
      message: text(part.message || part.error?.data?.message),
    }, sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: part.id }));
  }
}

function reduceOpenCode(previousState, frame, producer) {
  const context = createReducerContext(previousState, producer);
  const type = text(frame.type || frame.event);
  const properties = object(frame.properties || frame.data);
  const source = sourceOf(type, properties);

  if (type === "message.updated") {
    const info = object(properties.info || properties.message);
    const messageId = idOf(info.id || properties.messageID || properties.messageId);
    if (messageId && info.role) context.state.messageRoles[messageId] = String(info.role);
    if (info.sessionID || info.sessionId) context.state.sessionId = idOf(info.sessionID || info.sessionId);
    if (info.tokens) emitUsage(context, info.tokens, type, properties, { itemId: messageId, sessionId: context.state.sessionId });
    if (info.error) context.emit("error", "failed", { message: text(info.error?.data?.message || info.error?.message || "OpenCode message failed") }, source);
  } else if (type === "message.part.updated") {
    emitPart(context, type, properties, object(properties.part), properties.delta);
  } else if (type === "todo.updated") {
    context.emit("plan", "updated", { items: planItems(properties.todos || properties.items) }, source);
  } else if (type === "permission.asked") {
    const permission = object(properties.permission || properties);
    const requestId = idOf(permission.id || properties.id || properties.requestID);
    if (requestId) context.state.pendingApprovals[requestId] = { type: "permission" };
    context.emit("approval_request", "waiting", {
      requestId,
      permission: text(permission.permission || permission.type),
      patterns: safeDomainValue(permission.patterns || permission.pattern || []),
      metadata: safeDomainValue(permission.metadata || {}),
    }, sourceOf(type, properties, { requestId }));
  } else if (type === "permission.replied") {
    const requestId = idOf(properties.permissionID);
    if (requestId) delete context.state.pendingApprovals[requestId];
    context.emit("approval_response", "completed", {
      requestId,
      decision: text(properties.response),
    }, sourceOf(type, properties, { requestId }));
  } else if (type === "file.edited") {
    const editedPath = text(properties.file || properties.path);
    if (editedPath) context.emit("file_change", "completed", { action: "edit", path: editedPath }, source);
  } else if (type === "session.diff") {
    const changes = Array.isArray(properties.diff) ? properties.diff : [];
    if (changes.length) context.emit("file_change", "updated", { action: "diff", changes: safeDomainValue(changes) }, source);
  } else if (type === "command.executed") {
    context.emit("job_status", "completed", { operation: "command", command: text(properties.name), arguments: text(properties.arguments) }, source);
  } else if (type === "session.status") {
    const status = text(properties.status?.type || properties.status || "unknown");
    context.state.status = status;
    context.state.sessionId = idOf(properties.sessionID || properties.sessionId) || context.state.sessionId;
    context.emit("status", phaseForStatus(status), { status }, source);
  } else if (type === "session.compacted") {
    context.emit("status", "completed", { status: "compacted" }, source);
  } else if (type === "session.idle") {
    context.state.status = "idle";
    context.state.finalSeen = true;
    context.emit("status", "completed", { status: "idle" }, source);
    context.emit("final", "completed", { text: context.state.finalText }, source);
  } else if (type === "session.error") {
    context.state.status = "error";
    context.emit("error", "failed", { message: text(properties.error?.data?.message || properties.error?.message || properties.message || "OpenCode session failed") }, source);
  }

  return { state: context.state, events: context.events };
}

function httpRequest(method, path, body) {
  return { method, path, ...(body === undefined ? {} : { body }) };
}

function buildOpenCodeOperation(operation, input) {
  if (operation === "start") {
    const prompt = requireString(input, "prompt", operation);
    if (input.sessionId) {
      return { transport: "http", request: httpRequest("POST", `/session/${encodeURIComponent(input.sessionId)}/prompt_async`, { parts: [{ type: "text", text: prompt }] }) };
    }
    return {
      transport: "http",
      transaction: [
        httpRequest("POST", "/session", input.title ? { title: String(input.title) } : {}),
        httpRequest("POST", "/session/$session.id/prompt_async", { parts: [{ type: "text", text: prompt }] }),
      ],
    };
  }
  if (operation === "append" || operation === "resume") {
    const sessionId = requireString(input, "sessionId", operation);
    const prompt = requireString(input, "prompt", operation);
    return { transport: "http", request: httpRequest("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, { parts: [{ type: "text", text: prompt }] }) };
  }
  if (operation === "interrupt") {
    const sessionId = requireString(input, "sessionId", operation);
    return { transport: "http", request: httpRequest("POST", `/session/${encodeURIComponent(sessionId)}/abort`) };
  }
  if (operation === "compact") {
    const sessionId = requireString(input, "sessionId", operation);
    const providerID = requireString(input, "providerId", operation);
    const modelID = requireString(input, "modelId", operation);
    return { transport: "http", request: httpRequest("POST", `/session/${encodeURIComponent(sessionId)}/summarize`, { providerID, modelID }) };
  }
  return { transport: "event-cache", action: "context-usage.snapshot", sessionId: idOf(input.sessionId) };
}

export function createOpenCodeAdapter(options = {}) {
  return defineAgentAdapter({
    id: "opencode",
    protocol: "opencode-server-sse",
    capabilities: CAPABILITIES,
    reduce: reduceOpenCode,
    buildOperation: buildOpenCodeOperation,
  }, options);
}
