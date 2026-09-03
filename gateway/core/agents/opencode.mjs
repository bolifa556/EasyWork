import { createHash } from "node:crypto";

import { createReducerContext, defineAgentAdapter, requireString } from "./contract.mjs";
import { invariant } from "../errors.mjs";
import {
  appendItemText,
  array,
  emitAgentCompatibilityIssue,
  emitAgentEffortAdjustment,
  emitLinkedRemoteArtifacts,
  emitUnmappedAgentEvent,
  fileChangeFromTool,
  idOf,
  normalizeContextUsage,
  normalizeUsage,
  object,
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
  respondApproval: { availability: "available", mode: "native" },
  respondInput: { availability: "available", mode: "native" },
  compact: { availability: "available", mode: "native" },
  contextUsage: { availability: "available", mode: "derived" },
  fork: { availability: "available", mode: "native" },
  revert: { availability: "available", mode: "native" },
});

const TOOL_EVENTS = new Set([
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.next.tool.failed",
]);

// Public server streams also carry installation, workspace, PTY and catalog
// invalidation records. They are useful to native OpenCode clients, but do not
// describe the bound EasyWork turn and must not become activity rows.
const NON_TURN_EVENTS = new Set([
  "catalog.updated",
  "global.disposed",
  "ide.installed",
  "installation.update-available",
  "installation.updated",
  "integration.connection.updated",
  "integration.updated",
  "lsp.updated",
  "mcp.browser.open.failed",
  "mcp.tools.changed",
  "models-dev.refreshed",
  "native",
  "plugin.added",
  "project.directories.updated",
  "project.updated",
  "pty.created",
  "pty.deleted",
  "pty.exited",
  "pty.updated",
  "reference.updated",
  "server.connected",
  "server.heartbeat",
  "tui.command.execute",
  "tui.prompt.append",
  "tui.session.select",
  "tui.toast.show",
  "vcs.branch.updated",
  "workspace.failed",
  "workspace.ready",
  "workspace.status",
  "worktree.failed",
  "worktree.ready",
  "file.watcher.updated",
]);

function looksInteractive(type) {
  return /(?:permission|approval|question|elicitation|input).*(?:ask(?:ed)?|request(?:ed)?|required)$/i.test(String(type || ""));
}

function sourceOf(type, properties, extra = {}) {
  return {
    type,
    id: idOf(extra.id),
    sessionId: idOf(extra.sessionId || properties.sessionID),
    itemId: idOf(extra.itemId || properties.callID || properties.textID || properties.reasoningID || properties.messageID),
    requestId: idOf(extra.requestId || properties.requestID),
    agentVersion: text(extra.agentVersion),
  };
}

function emitUsage(context, usage, type, properties, extra = {}) {
  const normalized = normalizeUsage(usage);
  if (Object.keys(normalized).length === 0) return;
  const contextUsage = normalizeContextUsage({ used: normalized.total, limit: extra.limit });
  if (Object.keys(contextUsage).length) context.state.contextUsage = contextUsage;
  context.emit("usage", "updated", { ...normalized, ...(Object.keys(contextUsage).length ? { context: contextUsage } : {}) }, sourceOf(type, properties, extra));
}

function planTool(name) {
  return /^(?:todo[_-]?write|taskcreate|taskupdate)$/i.test(String(name || ""));
}

function resultText(value) {
  const direct = safeResultText(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      const record = object(entry);
      return text(record.text || record.content || record.output || record.message);
    }).filter(Boolean).join("\n");
  }
  const record = object(value);
  const nested = safeResultText(record.result || record.error);
  if (nested) return nested;
  return Object.keys(record).length ? JSON.stringify(safeDomainValue(record)) : "";
}

function stableSemanticValue(value) {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSemanticValue(value[key])]));
}

function semanticFingerprint(value) {
  const serialized = JSON.stringify(stableSemanticValue(safeDomainValue(value)));
  return createHash("sha256").update(serialized).digest("hex");
}

function nextSource(type, properties, itemId) {
  return sourceOf(type, properties, {
    sessionId: properties.sessionID,
    itemId,
  });
}

function nextItem(context, properties) {
  const callId = idOf(properties.callID);
  return { callId, known: object(context.state.items[callId || "tool"]) };
}

function emitNextText(context, type, properties, kind) {
  const id = idOf(kind === "reasoning" ? properties.reasoningID : properties.textID) || kind;
  const delta = typeof properties.delta === "string" ? properties.delta : null;
  const full = text(properties.text);
  const content = appendItemText(context.state, id, kind, delta || "", delta === null && full ? full : undefined);
  if (kind === "message") context.state.finalText = content;
  if (!delta && !full && type.endsWith(".started")) return;
  context.emit(kind, type.endsWith(".ended") ? "completed" : "updated", kind === "message"
    ? { role: "assistant", text: delta ?? content, delta: delta !== null }
    : { text: delta ?? content, delta: delta !== null }, nextSource(type, properties, id));
}

function emitNextTool(context, type, properties) {
  const { callId, known } = nextItem(context, properties);
  const itemId = callId || "tool";
  const source = nextSource(type, properties, itemId);
  if (type === "session.next.tool.input.started") {
    recordItem(context.state, itemId, { name: text(properties.name), partialInput: "" });
    return;
  }
  if (type === "session.next.tool.input.delta") {
    appendItemText(context.state, itemId, "partialInput", text(properties.delta));
    return;
  }
  if (type === "session.next.tool.input.ended") {
    recordItem(context.state, itemId, { rawInput: text(properties.text) });
    return;
  }
  if (type === "session.next.tool.called") {
    const name = text(properties.tool);
    const input = safeDomainValue(properties.input);
    recordItem(context.state, itemId, { name, input, status: "running" });
    if (!planTool(name)) context.emit("tool_call", "started", { name, callId: itemId, input }, source);
    return;
  }
  const name = text(known.name) || "tool";
  if (type === "session.next.tool.progress") {
    if (!planTool(name)) context.emit("tool_result", "updated", {
      name,
      callId: itemId,
      text: resultText(properties.content) || resultText(properties.structured),
      delta: false,
    }, source);
    return;
  }
  if (type === "session.next.tool.failed") {
    const message = resultText(properties.error) || resultText(properties.result) || "Tool failed";
    recordItem(context.state, itemId, { status: "failed" });
    if (!planTool(name)) context.emit("tool_result", "failed", { name, callId: itemId, text: message, error: message }, source);
    return;
  }
  const output = properties.result ?? properties.content ?? properties.structured;
  recordItem(context.state, itemId, { status: "completed" });
  if (!planTool(name)) context.emit("tool_result", "completed", { name, callId: itemId, text: resultText(output) }, source);
  if (!planTool(name) && toolNameIsFileChange(name)) {
    context.emit("file_change", "completed", fileChangeFromTool(name, known.input, {
      result: properties.result,
      content: properties.content,
      structured: properties.structured,
    }), source);
  }
  for (const rawPath of Array.isArray(properties.outputPaths) ? properties.outputPaths : []) {
    const path = remoteArtifactPath(rawPath);
    if (!path) continue;
    context.emit("artifact", "completed", { source: "remote", path, name: path.split("/").at(-1) || "artifact", kind: "file" }, source);
  }
  for (const attachment of array(properties.content).filter((entry) => entry?.type === "file")) {
    const path = remoteArtifactPath(attachment.uri);
    if (!path) continue;
    context.emit("artifact", "completed", {
      source: "remote",
      path,
      name: text(attachment.name || path.split("/").at(-1) || "artifact"),
      kind: "file",
    }, source);
  }
}

function emitV1TextPart(context, type, properties, part, delta) {
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

function emitV1ReasoningPart(context, type, properties, part, delta) {
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

function emitV1ToolPart(context, type, properties, part) {
  const state = object(part.state);
  const status = text(state.status || "pending").toLowerCase();
  const toolId = idOf(part.callID || part.callId || part.id) || "tool";
  const name = text(part.tool || part.name || "tool");
  const source = sourceOf(type, properties, { sessionId: part.sessionID || part.sessionId, itemId: toolId });
  const prior = object(context.state.items[toolId]);
  const stateInput = object(state.input);
  const partInput = object(part.input);
  const input = safeDomainValue(
    Object.keys(stateInput).length ? stateInput : Object.keys(partInput).length ? partInput : prior.input || {},
  );
  if (["pending", "running"].includes(status)) {
    recordItem(context.state, toolId, { type: "tool", name, status, input });
    if (planTool(name)) {
      const items = state.input?.todos || state.input?.items || part.input?.todos || part.input?.items;
      if (Array.isArray(items)) {
        context.state.plan = planItems(items);
        context.emit("plan", "updated", { items: context.state.plan }, source);
      }
      return;
    }
    context.emit("tool_call", prior.status ? "updated" : "started", {
      name,
      callId: toolId,
      input,
    }, source);
    return;
  }
  const failed = ["error", "failed"].includes(status);
  const output = state.output ?? state.error ?? part.output ?? part.error;
  const attachments = array(state.attachments || part.attachments);
  const terminalFingerprint = semanticFingerprint({
    phase: failed ? "failed" : "completed",
    name,
    input,
    output: resultText(output),
    attachments,
  });
  // OpenCode may publish a completed tool snapshot on the live stream and
  // return the same semantic snapshot again when EasyWork recovers the
  // terminal message history. Preserve legitimate terminal corrections, but
  // suppress an exact replay so the timeline and durable report stay singular.
  if (prior.terminalFingerprint === terminalFingerprint) return;
  recordItem(context.state, toolId, { type: "tool", name, status, input, terminalFingerprint });
  if (!planTool(name)) context.emit("tool_result", failed ? "failed" : "completed", {
    name,
    callId: toolId,
    text: resultText(output),
    ...(failed ? { error: resultText(output) || "Tool failed" } : {}),
  }, source);
  if (!failed && !planTool(name) && toolNameIsFileChange(name)) {
    context.emit("file_change", "completed", fileChangeFromTool(name, input, state.output || part.output), source);
  }
  for (const attachment of attachments) {
    const artifactPath = remoteArtifactPath(attachment.url || attachment.path);
    if (!artifactPath) continue;
    context.emit("artifact", "completed", {
      source: "remote",
      path: artifactPath,
      name: text(attachment.filename || attachment.name || artifactPath.split("/").at(-1) || "artifact"),
      kind: "file",
    }, source);
  }
}

function emitV1Part(context, type, properties, part, delta) {
  const partType = text(part.type);
  if (partType === "text") return emitV1TextPart(context, type, properties, part, delta);
  if (partType === "reasoning") return emitV1ReasoningPart(context, type, properties, part, delta);
  if (partType === "tool") return emitV1ToolPart(context, type, properties, part);
  if (partType === "patch") {
    const files = Array.isArray(part.files) ? part.files : [];
    if (files.length) context.emit("file_change", "completed", { action: "patch", files: safeDomainValue(files), ...(part.hash ? { hash: String(part.hash) } : {}) }, sourceOf(type, properties, { itemId: part.id }));
    return;
  }
  if (partType === "step-finish") {
    emitUsage(context, part.tokens, type, properties, { sessionId: part.sessionID || part.sessionId, itemId: part.id });
    return;
  }
  if (partType === "file") {
    const artifactPath = remoteArtifactPath(part.path || part.url);
    if (artifactPath) context.emit("artifact", "completed", { source: "remote", path: artifactPath, name: text(part.filename || part.name || artifactPath.split("/").at(-1) || "artifact"), kind: "file" }, sourceOf(type, properties, { itemId: part.id }));
    return;
  }
  if (["subtask", "agent"].includes(partType)) {
    context.emit("job_status", "started", { operation: partType, message: text(part.description || part.name || part.prompt) }, sourceOf(type, properties, { itemId: part.id }));
    return;
  }
  if (["step-start", "retry", "compaction", "snapshot"].includes(partType)) return;
  emitUnmappedAgentEvent(context, "OpenCode", "V1 内容块", partType, sourceOf(type, properties, { itemId: part.id }));
}

function emitV1PartDelta(context, type, properties) {
  if (text(properties.field) !== "text") return;
  const partId = idOf(properties.partID || properties.partId);
  const known = object(context.state.items[partId || ""]);
  const partType = text(known.partType);
  if (!partId || !["text", "reasoning"].includes(partType)) return;
  const part = {
    id: partId,
    type: partType,
    sessionID: properties.sessionID || properties.sessionId,
    messageID: properties.messageID || properties.messageId,
  };
  if (partType === "reasoning") return emitV1ReasoningPart(context, type, properties, part, text(properties.delta));
  return emitV1TextPart(context, type, properties, part, text(properties.delta));
}

function normalizeQuestionRequest(properties) {
  return (Array.isArray(properties.questions) ? properties.questions : []).map((question, index) => ({
    id: String(index),
    header: text(question?.header),
    question: text(question?.question),
    multiSelect: question?.multiple === true,
    allowCustom: question?.custom !== false,
    required: true,
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
      label: text(option?.label),
      description: text(option?.description),
    })).filter((option) => option.label),
  })).filter((question) => question.question);
}

function reduceOpenCode(previousState, frame, producer) {
  const context = createReducerContext(previousState, producer);
  const type = text(frame.type);
  const properties = object(frame.data);
  const agentVersion = text(frame.easywork?.agentVersion);
  const v1Envelope = frame.easywork?.eventEnvelope === "properties"
    || String(frame.easywork?.eventSource || "").startsWith("v1-");
  const source = sourceOf(type, properties, { id: frame.id, agentVersion });
  const sequence = Number(frame.durable?.seq);
  if (Number.isSafeInteger(sequence) && sequence >= 0) context.state.eventSequence = sequence;

  if (type === "easywork.compatibility.issue") {
    emitAgentCompatibilityIssue(context, "OpenCode", {
      ...object(properties.issue),
      agentVersion,
    }, source);
  } else if (type === "easywork.effort.adjusted") {
    emitAgentEffortAdjustment(context, properties, source);
  } else if (v1Envelope && type === "message.updated") {
    const info = object(properties.info || properties.message);
    const messageId = idOf(info.id || properties.messageID || properties.messageId);
    if (messageId && info.role) context.state.messageRoles[messageId] = String(info.role);
    if (messageId && info.role === "assistant") context.state.turnId = messageId;
    if (info.sessionID || info.sessionId) context.state.sessionId = idOf(info.sessionID || info.sessionId);
    if (info.tokens) emitUsage(context, info.tokens, type, properties, { itemId: messageId, sessionId: context.state.sessionId });
    if (info.error) context.emit("error", "failed", {
      message: resultText(info.error) || "OpenCode message failed",
      ...(agentVersion ? { agentVersion } : {}),
    }, source);
  } else if (v1Envelope && type === "message.part.updated") {
    emitV1Part(context, type, properties, object(properties.part), properties.delta);
  } else if (v1Envelope && type === "message.part.delta") {
    emitV1PartDelta(context, type, properties);
  } else if (type === "todo.updated") {
    context.state.plan = planItems(properties.todos || properties.items);
    context.emit("plan", "updated", { items: context.state.plan }, source);
  } else if (v1Envelope && ["permission.updated", "permission.asked"].includes(type)) {
    const permission = object(properties.permission || properties);
    const requestId = idOf(permission.id || properties.id || properties.requestID);
    const alreadyPending = Boolean(requestId && context.state.pendingApprovals[requestId]);
    if (requestId) context.state.pendingApprovals[requestId] = {
      type: "permission",
      permission: text(permission.type || permission.permission),
      itemId: idOf(permission.callID || permission.callId),
      sessionId: idOf(permission.sessionID || permission.sessionId),
    };
    if (!alreadyPending) {
      context.emit("approval_request", "waiting", {
        requestId,
        permission: text(permission.type || permission.permission),
        patterns: safeDomainValue(permission.pattern || permission.patterns || []),
        metadata: safeDomainValue(permission.metadata || {}),
        allowSession: true,
      }, sourceOf(type, properties, { requestId }));
    }
  } else if (v1Envelope && type === "permission.replied") {
    const requestId = idOf(properties.permissionID || properties.requestID);
    if (requestId) delete context.state.pendingApprovals[requestId];
    context.emit("approval_response", "completed", { requestId, decision: text(properties.response || properties.reply) }, sourceOf(type, properties, { requestId }));
  } else if (v1Envelope && type === "question.asked") {
    const requestId = idOf(properties.id || properties.requestID);
    const questions = normalizeQuestionRequest(properties);
    if (requestId) context.state.pendingInputs[requestId] = {
      type: "question",
      sessionId: idOf(properties.sessionID || properties.sessionId),
      questions: safeDomainValue(questions),
    };
    context.emit("input_request", "waiting", { requestId, tool: "question", input: { questions: safeDomainValue(questions) } }, sourceOf(type, properties, { requestId }));
  } else if (v1Envelope && ["question.replied", "question.rejected"].includes(type)) {
    const requestId = idOf(properties.requestID || properties.id);
    if (requestId) delete context.state.pendingInputs[requestId];
    context.emit("input_response", type.endsWith("rejected") ? "cancelled" : "completed", {
      requestId,
      ...(type.endsWith("replied") ? { answers: safeDomainValue(properties.answers) } : { decision: "rejected" }),
    }, sourceOf(type, properties, { requestId }));
  } else if (v1Envelope && type === "session.status") {
    const status = text(properties.status?.type || properties.status || "unknown");
    context.state.status = status;
    context.state.sessionId = idOf(properties.sessionID || properties.sessionId) || context.state.sessionId;
    context.emit("status", status === "idle" ? "completed" : status === "retry" ? "waiting" : "updated", { status }, source);
    if (status === "idle") {
      context.state.finalText = emitLinkedRemoteArtifacts(context, context.state.finalText, source);
      context.state.finalSeen = true;
      context.emit("final", "completed", { text: context.state.finalText }, source);
    }
  } else if (v1Envelope && type === "session.idle") {
    context.state.status = "idle";
    context.state.finalText = emitLinkedRemoteArtifacts(context, context.state.finalText, source);
    context.state.finalSeen = true;
    context.emit("status", "completed", { status: "idle" }, source);
    context.emit("final", "completed", { text: context.state.finalText }, source);
  } else if (v1Envelope && type === "session.error") {
    context.state.status = "error";
    context.emit("error", "failed", {
      message: resultText(properties.error) || text(properties.message) || "OpenCode session failed",
      ...(agentVersion ? { agentVersion } : {}),
    }, source);
  } else if (v1Envelope && type === "session.compacted") {
    context.emit("job_status", "completed", { operation: "compact", visibility: "internal" }, source);
  } else if (v1Envelope && type === "session.diff") {
    const changes = Array.isArray(properties.diff) ? properties.diff : [];
    if (changes.length) context.emit("file_change", "updated", { action: "diff", changes: safeDomainValue(changes) }, source);
  } else if (v1Envelope && type === "file.edited") {
    // The authoritative pre-execution snapshot and tool result already carry
    // the file mutation. This V1 watcher event is only an invalidation signal.
  } else if (v1Envelope && type === "command.executed") {
    context.emit("job_status", "completed", { operation: "command", command: text(properties.name), arguments: text(properties.arguments) }, source);
  } else if (type === "session.next.text.started" || type === "session.next.text.delta" || type === "session.next.text.ended") {
    emitNextText(context, type, properties, "message");
  } else if (type === "session.next.reasoning.started" || type === "session.next.reasoning.delta" || type === "session.next.reasoning.ended") {
    emitNextText(context, type, properties, "reasoning");
  } else if (TOOL_EVENTS.has(type)) {
    emitNextTool(context, type, properties);
  } else if (type === "session.next.shell.started") {
    const callId = idOf(properties.callID) || "shell";
    const command = text(properties.command);
    recordItem(context.state, callId, { name: "Bash", input: { command }, status: "running" });
    context.emit("tool_call", "started", { name: "Bash", callId, input: { command } }, nextSource(type, properties, callId));
  } else if (type === "session.next.shell.ended") {
    const callId = idOf(properties.callID) || "shell";
    recordItem(context.state, callId, { status: "completed" });
    context.emit("tool_result", "completed", { name: "Bash", callId, text: text(properties.output) }, nextSource(type, properties, callId));
  } else if (type === "session.next.step.started") {
    context.state.status = "running";
    context.state.sessionId = idOf(properties.sessionID);
    context.state.finalText = "";
    context.state.finalSeen = false;
    context.emit("status", "started", {
      status: "running",
      agent: text(properties.agent),
      model: safeDomainValue(properties.model),
    }, source);
  } else if (type === "session.next.step.ended") {
    if (properties.assistantMessageID) context.state.turnId = idOf(properties.assistantMessageID);
    emitUsage(context, properties.tokens, type, properties, { itemId: properties.assistantMessageID });
    const files = (Array.isArray(properties.files) ? properties.files : []).map((path) => ({ path: String(path) }));
    if (files.length) context.emit("file_change", "completed", { action: "step", changes: files }, source);
    const finish = text(properties.finish);
    const terminal = finish !== "tool-calls";
    context.state.status = terminal ? "idle" : "running";
    context.emit("status", terminal ? "completed" : "updated", { status: finish }, source);
    if (terminal) {
      context.state.finalText = emitLinkedRemoteArtifacts(context, context.state.finalText, source);
      context.state.finalSeen = true;
      context.emit("final", "completed", { text: context.state.finalText }, source);
    }
  } else if (type === "session.next.step.failed") {
    context.state.status = "error";
    context.emit("error", "failed", { message: resultText(properties.error) || "OpenCode step failed" }, source);
  } else if (type === "session.next.retried") {
    context.emit("job_status", "waiting", {
      operation: "retry",
      message: resultText(properties.error),
      attempt: Number(properties.attempt || 0),
    }, source);
  } else if (type === "session.next.compaction.started" || type === "session.next.compaction.delta" || type === "session.next.compaction.ended") {
    context.emit("job_status", type.endsWith("started") ? "started" : type.endsWith("ended") ? "completed" : "updated", {
      operation: "compaction",
      message: text(properties.text) || (type.endsWith("ended") ? "OpenCode 已压缩原生会话上下文" : type.endsWith("started") ? "OpenCode 正在压缩原生会话上下文" : ""),
      reason: text(properties.reason),
      ...(properties.recent ? { recent: text(properties.recent) } : {}),
    }, source);
  } else if (type === "session.next.agent.switched" || type === "session.next.model.switched") {
    context.emit("job_status", "completed", {
      operation: type.endsWith("agent.switched") ? "agent_switched" : "model_switched",
      message: type.endsWith("agent.switched") ? text(properties.agent) : text(properties.model?.id),
    }, source);
  } else if (type === "session.next.moved") {
    context.emit("job_status", "completed", {
      operation: "workspace_moved",
      message: text(properties.subdirectory) || text(properties.location?.directory),
    }, source);
  } else if (type === "session.next.revert.staged" || type === "session.next.revert.cleared" || type === "session.next.revert.committed") {
    context.emit("file_change", type.endsWith("committed") ? "completed" : "updated", {
      action: type.endsWith("staged") ? "revert_staged" : type.endsWith("committed") ? "revert" : "revert_cleared",
      revert: safeDomainValue(properties.revert || {}),
    }, source);
  } else if (["session.next.prompted", "session.next.prompt.admitted", "session.next.context.updated", "session.next.synthetic"].includes(type)) {
    // These are native transcript/control records. Prompted/admitted duplicate
    // the webpage user message; context/synthetic content belongs only to the
    // OpenCode conversation and must not leak into EasyWork memory or activity.
  } else if (type === "permission.v2.asked") {
    const requestId = idOf(properties.id);
    const tool = object(properties.source);
    const permission = text(properties.action);
    if (requestId) context.state.pendingApprovals[requestId] = {
      type: "permission",
      permission,
      itemId: idOf(tool.callID),
      sessionId: idOf(properties.sessionID),
    };
    context.emit("approval_request", "waiting", {
      requestId,
      permission,
      patterns: safeDomainValue(properties.resources),
      metadata: safeDomainValue(properties.metadata),
      // A saved allow rule would bypass the next V2 pre-mutation barrier and
      // make an authoritative preimage impossible. File and shell mutations
      // are therefore approved once; the user's global "全部允许" mode is
      // handled internally by the transport on every operation.
      allowSession: !["edit", "bash"].includes(permission) && array(properties.save).length > 0,
    }, sourceOf(type, properties, { requestId, itemId: tool.callID }));
  } else if (type === "permission.v2.replied") {
    const requestId = idOf(properties.requestID);
    if (requestId) delete context.state.pendingApprovals[requestId];
    context.emit("approval_response", "completed", {
      requestId,
      decision: text(properties.reply),
    }, sourceOf(type, properties, { requestId }));
  } else if (type === "question.v2.asked") {
    const requestId = idOf(properties.id);
    const questions = normalizeQuestionRequest(properties);
    const tool = object(properties.tool);
    if (requestId) context.state.pendingInputs[requestId] = {
      type: "question",
      itemId: idOf(tool.callID),
      sessionId: idOf(properties.sessionID),
      questions: safeDomainValue(questions),
    };
    context.emit("input_request", "waiting", {
      requestId,
      tool: "question",
      input: { questions: safeDomainValue(questions) },
    }, sourceOf(type, properties, { requestId, sessionId: properties.sessionID, itemId: tool.callID }));
  } else if (["question.v2.replied", "question.v2.rejected"].includes(type)) {
    const requestId = idOf(properties.requestID);
    if (requestId) delete context.state.pendingInputs[requestId];
    const rejected = type.endsWith("rejected");
    context.emit("input_response", rejected ? "cancelled" : "completed", {
      requestId,
      ...(!rejected ? { answers: safeDomainValue(properties.answers) } : { decision: "rejected" }),
    }, sourceOf(type, properties, { requestId, sessionId: properties.sessionID }));
  } else if ([
    // OpenCode 1.18.19 still publishes these durable session metadata events
    // on the current /api/event stream alongside session.next.*. They are not
    // an alternate EasyWork input format and contain no additional activity
    // beyond the authoritative session.next.* records.
    "session.created",
    "session.updated",
    "session.deleted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.delta",
    "message.part.removed",
    "server.connected",
    "file.edited",
    "file.watcher.updated",
    "project.directories.updated",
    "models-dev.refreshed",
    "catalog.updated",
    "reference.updated",
    "plugin.added",
    "integration.updated",
    "integration.connection.updated",
    "pty.created",
    "pty.updated",
    "pty.exited",
    "pty.deleted",
  ].includes(type) || NON_TURN_EVENTS.has(type)) {
    // Current server-wide lifecycle events do not describe the bound turn.
  } else if (looksInteractive(type)) {
    context.state.status = "error";
    context.emit("error", "failed", {
      message: `OpenCode${agentVersion ? ` ${agentVersion}` : " 当前版本"} 发出了无法安全代答的交互事件：${type || "unknown"}`,
      ...(agentVersion ? { agentVersion } : {}),
      eventType: type || "unknown",
    }, source);
  } else {
    emitUnmappedAgentEvent(context, "OpenCode", "事件", type, source);
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
      return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(input.sessionId)}/prompt`, { prompt: { text: prompt }, delivery: "steer", resume: true }) };
    }
    return {
      transport: "http",
      transaction: [
        httpRequest("POST", "/api/session", {}),
        httpRequest("POST", "/api/session/$session.id/prompt", { prompt: { text: prompt }, delivery: "steer", resume: true }),
      ],
    };
  }
  if (operation === "append") {
    const sessionId = requireString(input, "sessionId", operation);
    const prompt = requireString(input, "prompt", operation);
    return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { prompt: { text: prompt }, delivery: "steer", resume: true }) };
  }
  if (operation === "resume") {
    const sessionId = requireString(input, "sessionId", operation);
    const prompt = requireString(input, "prompt", operation);
    return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { prompt: { text: prompt }, delivery: "steer", resume: true }) };
  }
  if (operation === "interrupt") {
    const sessionId = requireString(input, "sessionId", operation);
    return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`) };
  }
  if (operation === "respondApproval") {
    const requestId = requireString(input, "requestId", operation);
    const decision = requireString(input, "decision", operation);
    invariant(["approve", "approve_session", "reject"].includes(decision), "AGENT_APPROVAL_DECISION_INVALID", "OpenCode 审批结果无效", { status: 400 });
    const mutation = ["edit", "bash"].includes(text(input.pendingApproval?.permission));
    const reply = decision === "approve_session" && !mutation ? "always" : decision === "reject" ? "reject" : "once";
    const sessionId = requireString(input.pendingApproval, "sessionId", operation);
    return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, { reply }) };
  }
  if (operation === "respondInput") {
    const requestId = requireString(input, "requestId", operation);
    const answers = input.answers;
    const pendingInput = object(input.pendingInput);
    const questions = Array.isArray(pendingInput.questions) ? pendingInput.questions : [];
    invariant(answers && typeof answers === "object" && !Array.isArray(answers), "AGENT_INPUT_ANSWERS_INVALID", "OpenCode 用户回答无效", { status: 400 });
    const orderedAnswers = questions.map((question, index) => {
      const id = text(question?.id || index);
      const raw = answers[id] ?? answers[text(question?.question)];
      return (Array.isArray(raw) ? raw : [raw]).map((value) => text(value)).filter(Boolean);
    });
    invariant(orderedAnswers.length > 0 && orderedAnswers.every((answer) => answer.length > 0), "AGENT_INPUT_ANSWERS_REQUIRED", "OpenCode 用户回答不能为空", { status: 400 });
    return {
      transport: "http",
      request: httpRequest("POST", `/api/session/${encodeURIComponent(requireString(pendingInput, "sessionId", operation))}/question/${encodeURIComponent(requestId)}/reply`, { answers: orderedAnswers }),
    };
  }
  if (operation === "compact") {
    const sessionId = requireString(input, "sessionId", operation);
    return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/compact`) };
  }
  if (operation === "fork") {
    const sessionId = requireString(input, "sessionId", operation);
    return {
      transport: "http",
      request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/fork`, {}),
      boundary: { mode: "retain-through", messageId: idOf(input.retainedMessageId) },
    };
  }
  if (operation === "revert") {
    const sessionId = requireString(input, "sessionId", operation);
    if (input.undo === true) {
      return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/unrevert`, {}), undo: true };
    }
    if (input.commit === true) {
      return { transport: "http", request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/revert`, {}), phase: "commit" };
    }
    return {
      transport: "http",
      request: httpRequest("POST", `/api/session/${encodeURIComponent(sessionId)}/revert`, {}),
      boundary: { mode: "retain-through", messageId: idOf(input.retainedMessageId) },
      ...(input.stageOnly === true ? { phase: "stage" } : {}),
    };
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
