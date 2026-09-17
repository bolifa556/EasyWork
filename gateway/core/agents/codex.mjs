import { createReducerContext, defineAgentAdapter, requireString } from "./contract.mjs";
import { invariant } from "../errors.mjs";
import {
  appendItemText,
  array,
  emitAgentCompatibilityIssue,
  emitAgentEffortAdjustment,
  emitLinkedRemoteArtifacts,
  emitUnmappedAgentEvent,
  idOf,
  normalizeContextUsage,
  normalizeUsage,
  object,
  phaseForStatus,
  planItems,
  recordItem,
  remoteArtifactPath,
  safeDomainValue,
  text,
} from "./common.mjs";

const CAPABILITIES = Object.freeze({
  start: { availability: "available", mode: "native" },
  append: { availability: "available", mode: "native" },
  interrupt: { availability: "available", mode: "native" },
  resume: { availability: "available", mode: "native" },
  respondApproval: { availability: "available", mode: "native" },
  respondInput: { availability: "available", mode: "native" },
  compact: { availability: "available", mode: "native" },
  contextUsage: { availability: "available", mode: "native" },
  fork: { availability: "available", mode: "native" },
  revert: { availability: "available", mode: "native" },
});

const INTERNAL_VERSION_HOOK_STATUS = "__easywork_internal_version_snapshot__";

function preToolUseId(run) {
  const runId = text(run?.id);
  const matched = /^pre-tool-use:\d+:.+:(.+)$/.exec(runId);
  return idOf(matched?.[1]);
}

function sourceOf(method, params = {}, item = {}, extra = {}) {
  return {
    type: method,
    id: idOf(extra.id || item.id),
    sessionId: idOf(extra.sessionId || params.threadId || params.thread?.id),
    turnId: idOf(extra.turnId || params.turnId || params.turn?.id),
    itemId: idOf(extra.itemId || item.id || params.itemId),
    requestId: idOf(extra.requestId),
    agentVersion: text(extra.agentVersion),
  };
}

function itemText(item) {
  return text(item.text);
}

function codexResultText(value) {
  if (value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(codexResultText).filter(Boolean).join("\n");
  const record = object(value);
  const direct = [record.text, record.message, record.output, record.content, record.structuredContent]
    .map(codexResultText)
    .filter(Boolean);
  if (direct.length) return direct.join("\n");
  return Object.keys(record).length ? JSON.stringify(safeDomainValue(record), null, 2) : "";
}

function emitCommandItem(context, method, params, item, phase) {
  const source = sourceOf(method, params, item);
  const command = text(item.command);
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
  const failed = ["failed", "declined"].includes(String(item.status || "").toLowerCase()) || Number(item.exitCode) > 0;
  context.emit("tool_result", failed ? "failed" : "completed", {
    name: "commandExecution",
    callId: itemId,
    text: text(item.aggregatedOutput),
    ...(Number.isFinite(Number(item.exitCode)) ? { exitCode: Number(item.exitCode) } : {}),
  }, source);
}

function emitFileItem(context, method, params, item, phase) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const status = String(item.status || "").toLowerCase();
  const settledPhase = status === "failed" ? "failed" : status === "declined" ? "cancelled" : phase;
  context.emit("file_change", settledPhase, {
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
  const name = text(item.tool || item.server || item.type || "tool");
  if (phase !== "completed") {
    context.emit("tool_call", phase, {
      name,
      callId: itemId,
      input: safeDomainValue(item.arguments || (item.type === "collabAgentToolCall" ? {
        prompt: item.prompt,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
        receiverThreadIds: item.receiverThreadIds,
      } : {})),
    }, sourceOf(method, params, item));
    return;
  }
  const failed = ["failed", "error"].includes(String(item.status || "").toLowerCase()) || item.success === false || Boolean(item.error);
  context.emit("tool_result", failed ? "failed" : "completed", {
    name,
    callId: itemId,
    text: codexResultText(item.error || item.result || item.contentItems || item.agentsStates),
  }, sourceOf(method, params, item));
}

function emitItem(context, method, params, item, phase) {
  const type = text(item.type);
  const source = sourceOf(method, params, item);
  const value = itemText(item);
  if (type === "agentMessage") {
    const messagePhase = text(item.phase);
    const delivery = text(item.delivery);
    const intermediate = messagePhase === "commentary" || delivery === "async";
    recordItem(context.state, idOf(item.id) || "agent-message", {
      type,
      messagePhase,
      delivery,
      text: value,
    });
    if (value) {
      // 0.149+ classifies assistant prose explicitly. Commentary and async
      // delivery stay in Agent activity; only final_answer (or an unclassified
      // legacy message) can become the outer final when the turn completes.
      if (!intermediate) context.state.finalText = value;
      context.emit("message", phase, {
        role: "assistant",
        text: value,
        delta: false,
        ...(messagePhase ? { messagePhase } : {}),
        ...(delivery ? { delivery } : {}),
      }, source);
    }
    return;
  }
  if (type === "reasoning") {
    const summary = array(item.summary).map(text).filter(Boolean).join("\n")
      || array(item.content).map(text).filter(Boolean).join("\n")
      || value;
    if (summary) context.emit("reasoning", phase, { text: summary, delta: false }, source);
    return;
  }
  if (type === "functionCallOutput") {
    context.emit("tool_result", phase, {
      name: [text(item.namespace), text(item.name)].filter(Boolean).join(".") || "functionCall",
      callId: idOf(item.id) || "function-call",
      text: codexResultText(item.output),
    }, source);
    return;
  }
  // The authoritative Todo snapshot is turn/plan/updated. A Plan item only
  // carries model prose and is intentionally not rendered inside Agent activity.
  if (type === "plan" || type === "userMessage" || type === "hookPrompt") return;
  if (type === "commandExecution") return emitCommandItem(context, method, params, item, phase);
  if (type === "fileChange") return emitFileItem(context, method, params, item, phase);
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(type)) return emitToolItem(context, method, params, item, phase);
  if (type === "subAgentActivity") {
    const activity = text(item.kind);
    context.emit("job_status", activity === "started" ? "started" : activity === "interrupted" ? "cancelled" : "updated", {
      operation: "subagent",
      message: text(item.agentPath),
      agentThreadId: text(item.agentThreadId),
    }, source);
    return;
  }
  if (type === "sleep") {
    context.emit("job_status", phase, {
      operation: "sleep",
      durationMs: Number(item.durationMs || 0),
      message: Number(item.durationMs) > 0 ? `等待 ${Number(item.durationMs)} 毫秒` : "等待",
    }, source);
    return;
  }
  const artifactPath = remoteArtifactPath(item.savedPath);
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
      message: value || text(item.query || item.review || item.status),
      ...(type === "webSearch" ? { results: safeDomainValue(array(item.results)) } : {}),
    }, source);
  }
}

function emitDelta(context, method, params) {
  const itemId = idOf(params.itemId) || method;
  const delta = text(params.delta);
  if (!delta) return;
  const source = sourceOf(method, params, params.item, { itemId });
  if (method === "item/agentMessage/delta") {
    const content = appendItemText(context.state, itemId, "text", delta);
    const known = object(context.state.items[itemId]);
    const intermediate = text(known.messagePhase) === "commentary" || text(known.delivery) === "async";
    if (!intermediate) context.state.finalText = content;
    context.emit("message", "updated", {
      role: "assistant",
      text: delta,
      delta: true,
      ...(known.messagePhase ? { messagePhase: text(known.messagePhase) } : {}),
      ...(known.delivery ? { delivery: text(known.delivery) } : {}),
    }, source);
  } else if (method.startsWith("item/reasoning/")) {
    appendItemText(context.state, itemId, "reasoning", delta);
    context.emit("reasoning", "updated", { text: delta, delta: true }, source);
  } else if (method === "item/plan/delta") {
    // Plan deltas are proposal prose. The authoritative structured snapshot is
    // delivered by turn/plan/updated and rendered only by the plan surface.
    appendItemText(context.state, itemId, "plan", delta);
  } else if (method === "item/commandExecution/outputDelta") {
    appendItemText(context.state, itemId, "output", delta);
    context.emit("tool_result", "updated", { name: "commandExecution", callId: itemId, text: delta, delta: true }, source);
  }
}

function schemaOptions(schema) {
  const source = object(schema);
  if (Array.isArray(source.enum)) return source.enum.map((value) => ({ label: String(value), value })).filter((entry) => entry.label);
  const alternatives = Array.isArray(source.oneOf) ? source.oneOf : Array.isArray(source.anyOf) ? source.anyOf : [];
  return alternatives.map((entry) => {
    const option = object(entry);
    const value = option.const ?? option.value ?? option.title;
    return { label: text(option.title) || String(value ?? ""), value };
  }).filter((entry) => entry.label);
}

function elicitationQuestions(params) {
  const schema = object(params.requestedSchema);
  const properties = object(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const questions = [];
  for (const [id, raw] of Object.entries(properties)) {
    const property = object(raw);
    const options = schemaOptions(property);
    if (!options.length && String(property.type || "") === "boolean") {
      options.push({ label: "是", value: true }, { label: "否", value: false });
    }
    questions.push({
      id,
      header: text(property.title) || id,
      question: text(property.description || property.title) || `请输入 ${id}`,
      required: required.has(id),
      allowCustom: options.length === 0,
      isSecret: String(property.format || "") === "password" || property.writeOnly === true,
      options: options.map((option) => ({ label: option.label, description: "" })),
    });
  }
  return questions;
}

function elicitationInput(params) {
  const mode = text(params.mode || "form");
  if (mode === "url") {
    return {
      mode,
      questions: [{
        id: "action",
        header: text(params.title || params.serverName) || "外部操作",
        question: text(params.message) || "请在链接中完成操作后继续。",
        required: true,
        allowCustom: false,
        options: [
          { label: "已完成", description: text(params.url) },
          { label: "取消", description: "不继续这项操作" },
        ],
      }],
      url: text(params.url),
      elicitationId: text(params.elicitationId),
    };
  }
  if (mode === "openai/userVerification") {
    return {
      mode,
      questions: [{
        id: "proof",
        header: text(params.title) || "用户验证",
        question: text(params.description) || "请输入设备验证凭据。",
        required: true,
        allowCustom: true,
        isSecret: true,
        options: [],
      }],
      schema: { properties: { proof: { type: "string", writeOnly: true } }, required: ["proof"] },
      challenge: text(params.challenge),
    };
  }
  const questions = elicitationQuestions(params);
  if (!questions.length && ["openai/form", "openaiForm"].includes(mode)) {
    questions.push({
      id: "response",
      header: text(params.title || params.serverName) || "外部表单",
      question: text(params.message) || "请输入表单响应。",
      required: true,
      allowCustom: true,
      isSecret: false,
      options: [],
    });
  }
  return {
    mode,
    questions,
    schema: safeDomainValue(params.requestedSchema || {}),
  };
}

function coercedElicitationValue(schema, values) {
  const source = object(schema);
  const options = schemaOptions(source);
  const first = values[0];
  const matched = options.find((entry) => entry.label === first);
  const raw = matched ? matched.value : first;
  if (source.type === "boolean") return raw === true || /^(?:true|yes|是)$/i.test(String(raw));
  if (source.type === "integer") return Number.parseInt(String(raw), 10);
  if (source.type === "number") return Number(raw);
  if (source.type === "array") return values;
  return String(raw ?? "");
}

function normalizeCodexTokenUsage(params) {
  const tokenUsage = object(params.tokenUsage);
  const total = object(tokenUsage.total);
  const last = object(tokenUsage.last || {});
  const usage = normalizeUsage(total);
  const lastUsage = normalizeUsage(last);
  const context = normalizeContextUsage({
    // Codex reports `total` as lifetime/session billing usage and `last` as
    // the latest active context window.  Only the latter can drive the context
    // occupancy indicator.
    used: lastUsage.total,
    limit: tokenUsage.modelContextWindow,
  });
  return { usage, context, last: lastUsage };
}

function reduceCodex(previousState, frame, producer) {
  const context = createReducerContext(previousState, producer);
  const method = text(frame.method);
  const params = object(frame.params);
  const agentVersion = text(frame.easywork?.agentVersion);

  if (!method && frame.id != null && context.state.pendingInputs[String(frame.id)]) {
    const requestId = String(frame.id);
    const pending = context.state.pendingInputs[requestId];
    delete context.state.pendingInputs[requestId];
    context.emit("input_response", frame.error ? "failed" : "completed", {
      requestId,
      answers: safeDomainValue(frame.result?.answers || {}),
    }, sourceOf("jsonrpc/response", {}, {}, { requestId, itemId: pending.itemId }));
    return { state: context.state, events: context.events };
  }

  if (!method && frame.id != null && context.state.pendingApprovals[String(frame.id)]) {
    const requestId = String(frame.id);
    const pending = context.state.pendingApprovals[requestId];
    delete context.state.pendingApprovals[requestId];
    context.emit("approval_response", frame.error ? "failed" : "completed", {
      requestId,
      decision: text(frame.result?.decision || frame.result?.scope || (frame.error ? "error" : "completed")),
    }, sourceOf("jsonrpc/response", {}, {}, { requestId, itemId: pending.itemId }));
    return { state: context.state, events: context.events };
  }

  if (method === "easywork/compatibilityIssue") {
    emitAgentCompatibilityIssue(context, "Codex", { ...params, agentVersion }, sourceOf(method, params, {}, { agentVersion }));
  } else if (method === "easywork/effortAdjusted") {
    emitAgentEffortAdjustment(context, params, sourceOf(method, params, {}, { agentVersion }));
  } else if (method === "thread/started") {
    context.state.sessionId = idOf(params.thread?.id);
    context.state.status = "idle";
    context.emit("status", "completed", { status: "thread_started" }, sourceOf(method, params));
  } else if (method === "turn/started") {
    context.state.turnId = idOf(params.turn?.id);
    context.state.status = "running";
    context.state.finalText = "";
    context.state.finalSeen = false;
    context.state.items = {};
    context.state.plan = [];
    context.emit("status", "started", { status: "running" }, sourceOf(method, params));
  } else if (method === "turn/completed") {
    const status = text(params.turn?.status || "completed");
    context.state.status = status;
    const phase = phaseForStatus(status, "completed");
    context.emit("status", phase, { status }, sourceOf(method, params));
    if (phase === "failed") {
      context.emit("error", "failed", { message: text(params.turn?.error?.message || "Codex turn failed") }, sourceOf(method, params));
    } else if (phase === "completed") {
      context.state.finalText = emitLinkedRemoteArtifacts(context, context.state.finalText, sourceOf(method, params));
      context.state.finalSeen = true;
      context.emit("final", phase, { text: context.state.finalText }, sourceOf(method, params));
    }
  } else if (method === "item/started" || method === "item/completed") {
    const phase = method === "item/started" ? "started" : "completed";
    emitItem(context, method, params, object(params.item), phase);
  } else if (method === "item/fileChange/patchUpdated") {
    const changes = Array.isArray(params.changes) ? params.changes : [];
    if (changes.length) context.emit("file_change", "updated", {
      action: "patch",
      changes: safeDomainValue(changes),
    }, sourceOf(method, params, {}, { itemId: params.itemId }));
  } else if (method === "item/commandExecution/terminalInteraction") {
    context.emit("tool_call", "updated", {
      name: "commandExecution",
      callId: idOf(params.itemId) || "command",
      interaction: "stdin",
      processId: text(params.processId),
    }, sourceOf(method, params, {}, { itemId: params.itemId }));
  } else if (method === "item/mcpToolCall/progress") {
    context.emit("tool_result", "updated", {
      name: "mcpToolCall",
      callId: idOf(params.itemId) || "mcp",
      text: text(params.message),
      delta: false,
    }, sourceOf(method, params, {}, { itemId: params.itemId }));
  } else if ([
    "item/agentMessage/delta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
  ].includes(method)) {
    emitDelta(context, method, params);
  } else if (method === "thread/tokenUsage/updated") {
    const normalized = normalizeCodexTokenUsage(params);
    context.state.contextUsage = normalized.context;
    context.emit("usage", "updated", normalized, sourceOf(method, params));
  } else if (method === "item/tool/requestUserInput") {
    const requestId = idOf(frame.id);
    const questions = (Array.isArray(params.questions) ? params.questions : []).map((question, index) => ({
      id: text(question?.id || index),
      header: text(question?.header),
      question: text(question?.question),
      isOther: question?.isOther === true,
      isSecret: question?.isSecret === true,
      options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
        label: text(option?.label),
        description: text(option?.description),
      })).filter((option) => option.label),
    })).filter((question) => question.id && question.question);
    if (requestId) context.state.pendingInputs[requestId] = {
      itemId: idOf(params.itemId),
      wireRequestId: frame.id,
      questions: safeDomainValue(questions),
    };
    context.emit("input_request", "waiting", {
      requestId,
      tool: "request_user_input",
      input: { questions: safeDomainValue(questions) },
    }, sourceOf(method, params, {}, { requestId, itemId: params.itemId }));
  } else if (method === "mcpServer/elicitation/request") {
    const requestId = idOf(frame.id);
    const input = elicitationInput(params);
    if (requestId) context.state.pendingInputs[requestId] = {
      type: "mcp_elicitation",
      itemId: idOf(params.itemId),
      wireRequestId: frame.id,
      questions: safeDomainValue(input.questions),
      mode: input.mode,
      schema: input.schema || {},
    };
    context.emit("input_request", "waiting", {
      requestId,
      tool: "mcp_elicitation",
      server: text(params.serverName),
      message: text(params.message),
      input: safeDomainValue(input),
    }, sourceOf(method, params, {}, { requestId }));
  } else if ([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval",
  ].includes(method)) {
    const requestId = idOf(frame.id);
    const permissionRequest = method === "item/permissions/requestApproval";
    const fileRequest = method.includes("fileChange") || method === "applyPatchApproval";
    const approvalKind = text(params.kind || "command");
    if (requestId) context.state.pendingApprovals[requestId] = {
      type: permissionRequest ? "permissions" : fileRequest ? "file_change" : "command_execution",
      itemId: idOf(params.itemId || params.callId),
      wireRequestId: frame.id,
      ...(permissionRequest ? { permissions: safeDomainValue(params.permissions || {}) } : {}),
    };
    context.emit("approval_request", "waiting", {
      requestId,
      action: permissionRequest ? "permissions" : fileRequest ? "file_change" : approvalKind === "writeStdin" ? "write_stdin" : "command_execution",
      reason: text(params.reason),
      details: safeDomainValue(permissionRequest
        ? { permissions: params.permissions, cwd: params.cwd }
        : approvalKind === "writeStdin"
          ? { kind: approvalKind, approvalId: params.approvalId, command: params.command, cwd: params.cwd }
        : params.command
          ? { command: params.command, cwd: params.cwd, parsedCommand: params.parsedCmd, commandActions: params.commandActions }
          : params.changes || params.fileChanges || {}),
    }, sourceOf(method, params, {}, { requestId, itemId: params.itemId || params.callId }));
  } else if (method === "error") {
    const message = text(params.error?.message || "Codex app-server error");
    const retrying = params.willRetry === true;
    if (retrying) {
      context.state.status = "running";
      context.emit("status", "updated", { status: "reconnecting", message }, sourceOf(method, params));
    } else {
      context.state.status = "error";
      context.emit("error", "failed", { message }, sourceOf(method, params));
    }
  } else if (method === "turn/diff/updated") {
    context.emit("file_change", "updated", { action: "diff", diff: text(params.diff) }, sourceOf(method, params));
  } else if (method === "turn/plan/updated") {
    context.state.plan = planItems(params.plan);
    context.emit("plan", "updated", { items: context.state.plan }, sourceOf(method, params));
  } else if (method === "thread/compacted") {
    context.emit("job_status", "completed", {
      operation: "compact",
      visibility: "internal",
    }, sourceOf(method, params));
  } else if (method === "thread/status/changed") {
    const status = text(params.status?.type || "unknown");
    context.state.status = status;
    context.emit("status", phaseForStatus(status), { status }, sourceOf(method, params));
  } else if (method === "hook/started" || method === "hook/completed") {
    const run = object(params.run);
    if (text(run.statusMessage) === INTERNAL_VERSION_HOOK_STATUS) {
      const toolUseId = preToolUseId(run);
      if (method === "hook/completed" && toolUseId) {
        context.emit("tool_call", phaseForStatus(run.status, "completed"), {
          name: "easywork.version.snapshot",
          callId: toolUseId,
          visibility: "internal",
        }, sourceOf(method, params, {}, { itemId: toolUseId }));
      } else {
        context.emit("job_status", method.endsWith("started") ? "started" : phaseForStatus(run.status, "completed"), {
          operation: "easywork.version.snapshot",
          visibility: "internal",
        }, sourceOf(method, params, {}, { itemId: toolUseId || run.id }));
      }
      return { state: context.state, events: context.events };
    }
    context.emit("job_status", method.endsWith("started") ? "started" : phaseForStatus(run.status, "completed"), {
      operation: "hook",
      name: text(run.eventName || run.id),
      message: text(run.statusMessage),
    }, sourceOf(method, params, {}, { itemId: run.id }));
  } else if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    const review = object(params.review);
    const reviewStatus = text(review.status || (method.endsWith("started") ? "inProgress" : ""));
    const phase = method.endsWith("started") || reviewStatus === "inProgress"
      ? "started"
      : reviewStatus === "approved"
        ? "completed"
        : reviewStatus === "aborted"
          ? "cancelled"
          : "failed";
    const message = review.rationale
      ? text(review.rationale)
      : reviewStatus === "approved"
        ? "安全审查已批准"
        : reviewStatus === "denied"
          ? "安全审查未批准"
          : reviewStatus === "timedOut"
            ? "安全审查已超时"
            : reviewStatus === "aborted"
              ? "安全审查已中止"
              : "正在进行安全审查";
    context.emit("job_status", phase, {
      operation: "auto_approval_review",
      status: reviewStatus,
      message,
      reviewId: text(params.reviewId),
      review: safeDomainValue(review),
      action: safeDomainValue(params.action),
      decisionSource: text(params.decisionSource),
    }, sourceOf(method, params, {}, { itemId: params.targetItemId, id: params.reviewId }));
  } else if (method === "autoApprovalReview/strictReviewRequired") {
    context.emit("job_status", "waiting", {
      operation: "auto_approval_review",
      status: "strict_review_required",
      message: "正在进行严格安全审查",
      startedAtMs: Number(params.startedAtMs || 0),
    }, sourceOf(method, params));
  } else if (["warning", "guardianWarning", "deprecationNotice", "configWarning"].includes(method)) {
    // These notifications are point-in-time notices, not long-running jobs.
    // Mark them terminal so a completed turn cannot retain a false
    // "running" badge in the activity timeline.
    context.emit("job_status", "completed", {
      operation: method,
      message: text(params.message || params.summary || params.details),
    }, sourceOf(method, params));
  } else if (method === "model/rerouted") {
    context.emit("job_status", "completed", {
      operation: "model_rerouted",
      message: `${text(params.fromModel)} → ${text(params.toModel)}`,
      reason: safeDomainValue(params.reason),
    }, sourceOf(method, params));
  } else if (method === "model/safetyBuffering/updated") {
    context.emit("job_status", "updated", {
      operation: "model_safety_buffering",
      message: params.showBufferingUi ? "模型正在执行安全缓冲" : "模型安全缓冲状态已更新",
      model: text(params.model),
    }, sourceOf(method, params));
  } else if (method === "model/verification") {
    const verifications = array(params.verifications);
    const failed = verifications.some((entry) => ["failed", "error", "rejected"].includes(String(entry?.status || "").toLowerCase()));
    context.emit("job_status", failed ? "failed" : "completed", {
      operation: "model_verification",
      message: verifications.length ? `模型校验 ${verifications.length} 项` : "模型校验完成",
      verifications: safeDomainValue(verifications),
    }, sourceOf(method, params));
  } else if (method === "mcpServer/startupStatus/updated" || method === "mcpServer/oauthLogin/completed") {
    const failed = params.success === false || String(params.status || "").toLowerCase() === "failed";
    context.emit("job_status", failed ? "failed" : phaseForStatus(params.status, "completed"), {
      operation: "mcp_server",
      name: text(params.name),
      message: text(params.error || params.failureReason || params.status),
    }, sourceOf(method, params));
  } else if (method === "modelProvider/authRecoveryStarted" || method === "modelProvider/authRecoveryCompleted") {
    context.emit("job_status", method.endsWith("Started") ? "started" : "completed", {
      operation: "provider_auth_recovery",
      name: text(params.provider),
      message: text(params.message),
    }, sourceOf(method, params));
  } else if (method === "serverRequest/resolved") {
    const requestId = idOf(params.requestId);
    const wasInput = Boolean(requestId && context.state.pendingInputs[requestId]);
    const wasApproval = Boolean(requestId && context.state.pendingApprovals[requestId]);
    if (requestId) delete context.state.pendingApprovals[requestId];
    if (requestId) delete context.state.pendingInputs[requestId];
    if (wasInput || wasApproval) context.emit(wasInput ? "input_response" : "approval_response", "completed", {
      requestId,
      decision: "resolved",
    }, sourceOf(method, params, {}, { requestId }));
  } else if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
    context.emit("job_status", "completed", {
      operation: "active_goal",
      message: method.endsWith("cleared") ? "" : text(params.goal?.condition || params.goal?.objective || params.goal?.text),
    }, sourceOf(method, params));
  } else if (["thread/archived", "thread/deleted", "thread/unarchived", "thread/closed", "thread/reverted"].includes(method)) {
    const status = method.slice("thread/".length);
    context.state.status = ["deleted", "closed"].includes(status) ? "cancelled" : context.state.status;
    context.emit("status", ["deleted", "closed"].includes(status) ? "cancelled" : "completed", { status: `thread_${status}` }, sourceOf(method, params));
  } else if (["thread/environment/connected", "thread/environment/disconnected"].includes(method)) {
    context.emit("job_status", method === "thread/environment/connected" ? "completed" : "cancelled", {
      operation: "environment",
      message: text(params.environment?.name || params.environmentId || params.message),
    }, sourceOf(method, params));
  } else if ([
    "item/reasoning/summaryPartAdded", "skills/changed", "thread/name/updated",
    "thread/queue/changed", "thread/settings/updated", "account/updated",
    "account/rateLimits/updated", "account/login/completed", "app/list/updated",
    "remoteControl/status/changed", "externalAgentConfig/import/progress",
    "externalAgentConfig/import/completed", "fs/changed", "turn/moderationMetadata",
    "fuzzyFileSearch/sessionUpdated", "fuzzyFileSearch/sessionCompleted",
    "command/exec/outputDelta", "process/outputDelta", "process/exited",
    "thread/realtime/started", "thread/realtime/itemAdded", "thread/realtime/transcript/delta",
    "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta", "thread/realtime/sdp",
    "thread/realtime/item/started", "thread/realtime/item/transcript/delta", "thread/realtime/item/completed",
    "thread/realtime/error", "thread/realtime/closed", "windows/worldWritableWarning",
    "windowsSandbox/setupCompleted", "rawResponseItem/completed", "rawResponse/completed",
    "project/changed", "thread/project/updated", "item/fileChange/outputDelta",
    "mcpServer/event/stream/notification",
  ].includes(method)) {
    // Current app-server notifications outside EasyWork's text coding-task
    // surface are consumed explicitly so they cannot become accidental rows.
  } else if (method) {
    if (frame.id != null) {
      context.emit("error", "failed", {
        message: `Codex${agentVersion ? ` ${agentVersion}` : " 当前版本"} 发出了无法安全代答的服务端请求：${method}`,
        ...(agentVersion ? { agentVersion } : {}),
        eventType: method,
      }, sourceOf(method, params, {}, { requestId: frame.id, agentVersion }));
    } else {
      emitUnmappedAgentEvent(context, "Codex", "通知", method, sourceOf(method, params, {}, { agentVersion }));
    }
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
      return { transport: "json-rpc", calls: [rpc("turn/start", { threadId: String(input.threadId), input: [{ type: "text", text: prompt }], ...(input.cwd ? { cwd: String(input.cwd) } : {}) })] };
    }
    return {
      transport: "json-rpc",
      calls: [
        rpc("thread/start", {
          ...(input.cwd ? { cwd: String(input.cwd) } : {}),
          // Codex only exposes thread/revert for paginated histories. Select
          // that persistence contract when EasyWork creates the native thread
          // so later Web conversation rewinds can reuse the same Codex thread.
          historyMode: "paginated",
        }),
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
  if (operation === "respondApproval") {
    const requestId = requireString(input, "requestId", operation);
    const decision = requireString(input, "decision", operation);
    const pendingApproval = object(input.pendingApproval);
    invariant(["approve", "approve_session", "reject"].includes(decision), "AGENT_APPROVAL_DECISION_INVALID", "Codex 审批结果无效", { status: 400 });
    if (pendingApproval.type === "permissions") {
      return {
        transport: "json-rpc-response",
        requestId: pendingApproval.wireRequestId ?? requestId,
        result: {
          permissions: decision === "reject" ? {} : safeDomainValue(pendingApproval.permissions || {}),
          scope: decision === "approve_session" ? "session" : "turn",
        },
      };
    }
    return {
      transport: "json-rpc-response",
      requestId: pendingApproval.wireRequestId ?? requestId,
      result: { decision: decision === "approve_session" ? "acceptForSession" : decision === "approve" ? "accept" : "decline" },
    };
  }
  if (operation === "respondInput") {
    const requestId = requireString(input, "requestId", operation);
    const answers = input.answers;
    const pendingInput = object(input.pendingInput);
    const questions = Array.isArray(pendingInput.questions) ? pendingInput.questions : [];
    invariant(answers && typeof answers === "object" && !Array.isArray(answers), "AGENT_INPUT_ANSWERS_INVALID", "Codex 用户回答无效", { status: 400 });
    if (pendingInput.type === "mcp_elicitation") {
      const mode = text(pendingInput.mode || "form");
      const actionAnswer = array(answers.action).length ? text(array(answers.action)[0]) : text(answers.action);
      if (mode === "url") {
        return {
          transport: "json-rpc-response",
          requestId: pendingInput.wireRequestId ?? requestId,
          result: { action: actionAnswer === "取消" ? "cancel" : "accept", content: null, _meta: null },
        };
      }
      const schema = object(pendingInput.schema);
      const properties = object(schema.properties);
      const content = {};
      for (const question of questions) {
        const id = text(question?.id);
        if (!id) continue;
        const raw = answers[id] ?? answers[text(question?.question)];
        const values = (Array.isArray(raw) ? raw : [raw]).map((value) => text(value)).filter(Boolean);
        if (!values.length) continue;
        content[id] = coercedElicitationValue(properties[id], values);
      }
      return {
        transport: "json-rpc-response",
        requestId: pendingInput.wireRequestId ?? requestId,
        result: { action: "accept", content: safeDomainValue(content), _meta: null },
      };
    }
    const result = {};
    for (const question of questions) {
      const id = text(question?.id);
      if (!id) continue;
      const raw = answers[id] ?? answers[text(question?.question)];
      const values = (Array.isArray(raw) ? raw : [raw]).map((value) => text(value)).filter(Boolean);
      if (!values.length) continue;
      const allowed = new Set((Array.isArray(question?.options) ? question.options : []).map((option) => text(option?.label)).filter(Boolean));
      result[id] = {
        answers: values.map((value) => allowed.has(value) ? value : `user_note: ${value}`),
      };
    }
    invariant(Object.keys(result).length > 0, "AGENT_INPUT_ANSWERS_REQUIRED", "Codex 用户回答不能为空", { status: 400 });
    return {
      transport: "json-rpc-response",
      requestId: pendingInput.wireRequestId ?? requestId,
      result: { answers: result },
    };
  }
  if (operation === "resume") {
    const threadId = requireString(input, "threadId", operation);
    const prompt = requireString(input, "prompt", operation);
    return { transport: "json-rpc", calls: [rpc("thread/resume", { threadId, ...(input.cwd ? { cwd: String(input.cwd) } : {}) }), rpc("turn/start", { threadId, input: [{ type: "text", text: prompt }], ...(input.cwd ? { cwd: String(input.cwd) } : {}) })] };
  }
  if (operation === "fork") {
    const threadId = requireString(input, "threadId", operation);
    const path = input.path == null ? "" : String(input.path).trim();
    const lastTurnId = input.lastTurnId == null ? "" : String(input.lastTurnId).trim();
    const beforeTurnId = input.beforeTurnId == null ? "" : String(input.beforeTurnId).trim();
    invariant(!(lastTurnId && beforeTurnId), "AGENT_OPERATION_INPUT_INVALID", "Codex fork 不能同时指定 lastTurnId 与 beforeTurnId", { status: 400 });
    return {
      transport: "json-rpc",
      calls: [rpc("thread/fork", {
        threadId,
        ...(path ? { path } : {}),
        ...(lastTurnId ? { lastTurnId } : {}),
        ...(beforeTurnId ? { beforeTurnId } : {}),
        ...(input.cwd ? { cwd: String(input.cwd) } : {}),
        excludeTurns: true,
      })],
    };
  }
  if (operation === "revert") {
    return {
      transport: "json-rpc",
      calls: [rpc("thread/revert", {
        threadId: requireString(input, "threadId", operation),
        beforeTurnId: requireString(input, "beforeTurnId", operation),
      })],
    };
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
