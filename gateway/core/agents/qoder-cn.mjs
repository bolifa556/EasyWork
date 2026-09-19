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
  interrupt: { availability: "available", mode: "native" },
  resume: { availability: "available", mode: "native" },
  respondApproval: { availability: "available", mode: "native" },
  respondInput: { availability: "available", mode: "native" },
  compact: { availability: "available", mode: "native" },
  contextUsage: { availability: "available", mode: "native" },
  fork: { availability: "available", mode: "native-deferred" },
  revert: { availability: "available", mode: "native-rewind-deferred" },
});

// Qoder CN exposes compaction as a native slash command on its stream-json
// input channel, rather than as a separate RPC method.
const COMPACT_COMMAND = "/compact";

// Qoder CN's terminal `result.usage` is the aggregate billable usage of the
// whole Agent run (all model/tool-loop requests).  Only the streaming
// `message.usage` and `message_delta.usage` describe the current model request.
// Qoder may report zero token counters there while still publishing the native
// `context_usage_ratio`; the terminal modelUsage context window resolves that
// ratio to tokens. Terminal result token totals remain cumulative billing data
// and are never used as the current context-window occupancy.
export const QODER_CONTEXT_USAGE_SOURCE = "qoder-cn-current-request";

function sourceOf(type, frame = {}, extra = {}) {
  return {
    type,
    id: idOf(extra.id || frame.uuid),
    sessionId: idOf(extra.sessionId || frame.session_id),
    itemId: idOf(extra.itemId),
    requestId: idOf(extra.requestId || frame.request_id),
    agentVersion: text(extra.agentVersion || frame.easywork?.agentVersion),
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  return array(content).map((entry) => text(entry?.text)).filter(Boolean).join("");
}

function structuredContentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(structuredContentText).filter(Boolean).join("\n");
  const record = object(value);
  const direct = [record.text, record.message, record.error_message, record.stdout, record.stderr, record.output]
    .map(structuredContentText)
    .filter(Boolean);
  if (direct.length) return direct.join("\n");
  return Object.keys(record).length ? JSON.stringify(safeDomainValue(record), null, 2) : "";
}

function sessionPermissionUpdates(value) {
  return array(value).flatMap((raw) => {
    const update = object(raw);
    if (!Object.keys(update).length) return [];
    // Qoder's permission suggestions may target localSettings or
    // projectSettings, which makes an "always allow" response create
    // .qoder/settings.local.json in the user's repository. EasyWork's UI
    // explicitly offers "allow for this session", and Qoder's native
    // PermissionUpdate protocol has a matching session destination. Preserve
    // the suggested rule/update verbatim while keeping the grant inside the
    // bound native conversation.
    return [safeDomainValue({ ...update, destination: "session" })];
  });
}

function serverToolResultFailed(block) {
  const result = object(block.content);
  return block.is_error === true || Boolean(result.error_code) || /(?:^|_)error$/.test(text(result.type));
}

function schemaOptions(schema) {
  const source = object(schema);
  if (Array.isArray(source.enum)) return source.enum.map((value) => ({ label: String(value), value })).filter((entry) => entry.label);
  const alternatives = Array.isArray(source.oneOf) ? source.oneOf : Array.isArray(source.anyOf) ? source.anyOf : [];
  return alternatives.map((entry) => {
    const option = object(entry);
    const value = option.const;
    return { label: text(option.title) || String(value ?? ""), value };
  }).filter((entry) => entry.label);
}

function elicitationQuestions(request) {
  const schema = object(request.requested_schema);
  const properties = object(schema.properties);
  const required = new Set(array(schema.required).map(String));
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

function elicitationInput(request) {
  const mode = text(request.mode || "form");
  if (mode === "url") {
    return {
      mode,
      url: text(request.url),
      elicitationId: text(request.elicitation_id),
      questions: [{
        id: "action",
        header: text(request.title || request.display_name || request.mcp_server_name) || "外部操作",
        question: text(request.message) || "请在链接中完成操作后继续。",
        required: true,
        allowCustom: false,
        options: [
          { label: "已完成", description: text(request.url) },
          { label: "取消", description: "不继续这项操作" },
        ],
      }],
    };
  }
  const questions = elicitationQuestions(request);
  if (!questions.length) {
    questions.push({
      id: "action",
      header: text(request.title || request.display_name || request.mcp_server_name) || "外部操作",
      question: text(request.message) || "是否继续？",
      required: true,
      allowCustom: false,
      options: [{ label: "继续", description: "" }, { label: "取消", description: "" }],
    });
  }
  return {
    mode,
    questions,
    schema: safeDomainValue(request.requested_schema || {}),
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

function planTool(name) {
  return ["TodoWrite", "TaskCreate", "TaskList", "TaskUpdate"].includes(String(name || ""));
}

const QODER_SERVER_TOOL_RESULT_TYPES = new Set([
  "advisor_tool_result",
  "bash_code_execution_tool_result",
  "code_execution_tool_result",
  "mcp_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "web_fetch_tool_result",
  "web_search_tool_result",
]);

const QODER_TOOL_USE_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

function errorDetail(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).trim();
  if (Array.isArray(value)) return value.map((entry) => errorDetail(entry, depth + 1)).filter(Boolean).join("; ");
  if (typeof value !== "object") return "";
  return ["message", "reason", "detail", "description", "error", "stderr"]
    .map((key) => errorDetail(value[key], depth + 1))
    .filter(Boolean)
    .join("; ");
}

function qoderErrorMessage(frame) {
  const details = [frame.error, frame.errors, frame.message, frame.stderr, frame.result]
    .map((value) => errorDetail(value))
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  return (details.join(" · ") || `Qoder CN ${text(frame.subtype || "operation")} failed`).slice(0, 16_384);
}

function splitTaggedThinking(value) {
  const source = text(value);
  const closeIndex = source.indexOf("</think>");
  if (closeIndex < 0) return { reasoning: "", final: source };
  const openIndex = source.lastIndexOf("<think>", closeIndex);
  const reasoningStart = openIndex >= 0 ? openIndex + "<think>".length : 0;
  const reasoning = source.slice(reasoningStart, closeIndex).trim();
  const before = openIndex >= 0 ? source.slice(0, openIndex) : "";
  const after = source.slice(closeIndex + "</think>".length);
  const final = `${before}${after}`.trim();
  return final ? { reasoning, final } : { reasoning: "", final: source };
}

function qoderContextTokens(usage) {
  const tokens = [usage?.input, usage?.cachedInput, usage?.cacheWrite]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return tokens.length ? tokens.reduce((total, value) => total + value, 0) : null;
}

function qoderNativeContextRatio(usage) {
  const ratio = Number(usage?.context_usage_ratio ?? usage?.contextUsageRatio ?? usage?.ratio);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : null;
}

function qoderMessageContextUsage(usage, limit) {
  const ratio = qoderNativeContextRatio(usage);
  const reportedLimit = Number(limit ?? usage?.limit);
  const verifiedLimit = Number.isFinite(reportedLimit) && reportedLimit > 0 ? reportedLimit : null;
  const explicitUsed = Number(usage?.used);
  const promptTokens = qoderContextTokens(usage);
  const used = ratio !== null && verifiedLimit
    ? Math.round(ratio * verifiedLimit)
    : Number.isFinite(explicitUsed) && explicitUsed >= 0
      ? explicitUsed
      : promptTokens;
  if (!Number.isFinite(used)) {
    return ratio === null
      ? null
      : { ratio, ...(verifiedLimit ? { limit: verifiedLimit } : {}), source: QODER_CONTEXT_USAGE_SOURCE };
  }
  const contextUsage = normalizeContextUsage({
    used,
    limit: verifiedLimit,
  });
  return Number.isFinite(contextUsage.used)
    ? { ...contextUsage, ...(ratio !== null ? { ratio } : {}), source: QODER_CONTEXT_USAGE_SOURCE }
    : null;
}

function updateQoderRequestUsage(context, rawUsage, source, phase = "updated") {
  const usage = normalizeUsage(rawUsage);
  const ratio = qoderNativeContextRatio(rawUsage);
  if (!Object.keys(usage).length && ratio === null) return;
  const previous = object(context.state.items.__qoderRequestUsage).usage || {};
  const merged = { ...previous, ...usage, ...(ratio !== null ? { ratio } : {}) };
  recordItem(context.state, "__qoderRequestUsage", { usage: merged });
  const contextUsage = qoderMessageContextUsage(merged, context.state.contextUsage?.limit);
  if (contextUsage) context.state.contextUsage = contextUsage;
  context.emit("usage", phase, {
    ...merged,
    ...(contextUsage ? { context: contextUsage } : {}),
  }, source);
}

function emitPlanSnapshot(context, source) {
  context.emit("plan", "updated", { items: context.state.plan }, source);
}

function replacePlanSnapshot(context, nextPlan, source) {
  if (JSON.stringify(context.state.plan) === JSON.stringify(nextPlan)) return false;
  context.state.plan = nextPlan;
  emitPlanSnapshot(context, source);
  return true;
}

function parsedToolInput(value) {
  const raw = text(value).trim();
  if (!raw) return {};
  try {
    return object(JSON.parse(raw));
  } catch {
    return {};
  }
}

function upsertPlanItem(plan, item) {
  const index = plan.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...plan, item];
  const next = [...plan];
  next[index] = { ...next[index], ...item, text: item.text || next[index].text };
  return next;
}

function applyToolPlan(context, name, input, toolId, source) {
  if (name === "TodoWrite") {
    replacePlanSnapshot(context, planItems(input.todos), source);
    return;
  }
  if (name === "TaskCreate") {
    const provisionalId = `pending:${toolId}`;
    const item = planItems([{
      id: provisionalId,
      content: input.subject,
      status: "pending",
    }])[0];
    if (!item) return;
    const nextPlan = upsertPlanItem(context.state.plan, item);
    recordItem(context.state, toolId, { planProvisionalId: provisionalId });
    replacePlanSnapshot(context, nextPlan, source);
    return;
  }
  if (name !== "TaskUpdate") return;
  const taskId = idOf(input.taskId);
  if (!taskId) return;
  if (String(input.status || "").toLowerCase() === "deleted") {
    replacePlanSnapshot(context, context.state.plan.filter((entry) => entry.id !== taskId), source);
    return;
  }
  const existing = context.state.plan.find((entry) => entry.id === taskId);
  const item = planItems([{
    id: taskId,
    content: input.subject || input.activeForm || input.description || existing?.text || `Task ${taskId}`,
    status: input.status || existing?.status || "in_progress",
  }])[0];
  if (!item) return;
  replacePlanSnapshot(context, upsertPlanItem(context.state.plan, item), source);
}

function nativeTaskCreateResult(context, frame, toolId, source) {
  const result = object(frame.tool_use_result);
  const task = object(result.task);
  const assignedId = idOf(task.id);
  if (!assignedId) return false;
  const known = object(context.state.items[toolId]);
  const provisionalId = idOf(known.planProvisionalId) || `pending:${toolId}`;
  const provisional = context.state.plan.find((entry) => entry.id === provisionalId);
  const existing = context.state.plan.find((entry) => entry.id === assignedId);
  const item = planItems([{
    id: assignedId,
    content: task.subject || known.input?.subject || provisional?.text || existing?.text || `Task ${assignedId}`,
    status: task.status || provisional?.status || "pending",
  }])[0];
  if (!item) return false;

  // Qoder's native task store can reuse a numeric id after a resumed CLI
  // process. The newly acknowledged native task supersedes the stale item;
  // keeping both would produce duplicate keys and misleading progress.
  const provisionalIndex = context.state.plan.findIndex((entry) => entry.id === provisionalId);
  const existingIndex = context.state.plan.findIndex((entry) => entry.id === assignedId);
  const insertionIndex = provisionalIndex >= 0
    ? provisionalIndex
    : existingIndex >= 0 ? existingIndex : context.state.plan.length;
  const before = context.state.plan.slice(0, insertionIndex)
    .filter((entry) => ![provisionalId, assignedId].includes(entry.id));
  const after = context.state.plan.slice(insertionIndex)
    .filter((entry) => ![provisionalId, assignedId].includes(entry.id));
  recordItem(context.state, toolId, {
    name: "TaskCreate",
    planProvisionalId: assignedId,
    input: Object.keys(object(known.input)).length ? known.input : { subject: item.text },
  });
  replacePlanSnapshot(context, [...before, item, ...after], source);
  return true;
}

function nativeTaskUpdateResult(context, frame, toolId, source) {
  const result = object(frame.tool_use_result);
  const task = object(result.task);
  const taskId = idOf(result.taskId || task.id);
  const status = text(object(result.statusChange).to || task.status);
  if (!taskId || !status) return false;
  const known = object(context.state.items[toolId]);
  recordItem(context.state, toolId, { name: "TaskUpdate" });
  applyToolPlan(context, "TaskUpdate", {
    ...object(known.input),
    taskId,
    status,
    subject: task.subject || known.input?.subject,
  }, toolId, source);
  return true;
}

function nativeTaskListResult(context, frame, source) {
  const result = object(frame.tool_use_result);
  if (!Object.hasOwn(result, "tasks")) return false;
  replacePlanSnapshot(context, planItems(array(result.tasks).map((task) => ({
    id: task?.id,
    content: task?.subject,
    status: task?.status,
  }))), source);
  return true;
}

function inferredPlanResultName(frame, knownName, block) {
  const observedName = text(knownName);
  if (observedName && observedName !== "tool") return observedName;
  const result = object(frame.tool_use_result);
  if (Object.hasOwn(result, "tasks")) return "TaskList";
  if (idOf(result.taskId) && (result.statusChange || array(result.updatedFields).length)) return "TaskUpdate";
  if (idOf(object(result.task).id) && /created\s+successfully/i.test(contentText(block?.content))) return "TaskCreate";
  return observedName;
}

function emitServerToolResult(context, frame, block) {
  const toolId = idOf(block.tool_use_id);
  if (!toolId) return;
  const known = object(context.state.items[toolId]);
  const name = text(known.name) || text(block.type).replace(/_tool_result$/, "");
  const failed = serverToolResultFailed(block);
  recordItem(context.state, toolId, { status: failed ? "failed" : "completed", name });
  context.emit("tool_result", failed ? "failed" : "completed", {
    name,
    callId: toolId,
    text: structuredContentText(block.content),
  }, sourceOf(frame.type, frame, { itemId: toolId }));
}

function emitSpecialContentBlock(context, frame, block, source) {
  if (block.type === "redacted_thinking") {
    context.emit("job_status", "completed", {
      operation: "redacted_thinking",
      message: "部分思考内容已由模型安全机制隐藏",
    }, source);
    return true;
  }
  if (block.type === "compaction") {
    context.emit("job_status", block.content === null ? "failed" : "completed", {
      operation: "model_compaction",
      message: text(block.content),
    }, source);
    return true;
  }
  if (block.type === "fallback") {
    context.emit("job_status", "completed", {
      operation: "model_fallback",
      message: `${text(block.from?.model)} → ${text(block.to?.model)}`,
      reason: safeDomainValue(block.trigger),
    }, source);
    return true;
  }
  if (block.type === "container_upload") {
    context.emit("job_status", "completed", {
      operation: "container_upload",
      fileId: text(block.file_id),
    }, source);
    return true;
  }
  return false;
}

function emitUnknownContentBlock(context, block, source) {
  emitUnmappedAgentEvent(context, "Qoder CN", "内容块", block.type, source);
}

function completedContentItemId(state, frame, block, index) {
  if (idOf(block.id)) return idOf(block.id);
  const messageId = idOf(frame.message?.id);
  const completedBlockKey = `${idOf(frame.uuid) || messageId || "assistant"}:${index}`;
  const streamedIds = array(state.items[`qoder-stream:${messageId}`]?.blockIds);
  const existing = streamedIds.find((id) => state.items[id]?.completedBlockKey === completedBlockKey);
  if (existing) return existing;
  // The CLI emits one completed assistant frame per content block. Its array
  // index is usually zero, even when the corresponding stream index is not.
  // Match the first not-yet-completed block in native message order, without
  // using text similarity or merging distinct blocks sharing message.id.
  const pending = streamedIds.find((id) => state.items[id]?.partType === block.type && !state.items[id]?.completedBlockKey);
  if (pending) {
    recordItem(state, pending, { completedBlockKey });
    return pending;
  }
  return completedBlockKey;
}

function emitAssistantContent(context, frame, content, completed = false) {
  for (let index = 0; index < content.length; index += 1) {
    const block = object(content[index]);
    const itemId = completedContentItemId(context.state, frame, block, index);
    const source = sourceOf(frame.type, frame, { itemId });
    if (block.type === "text" && block.text) {
      const split = splitTaggedThinking(block.text);
      const knownText = text(context.state.items[itemId]?.text);
      if (knownText !== split.final) context.state.finalText = `${context.state.finalText}${split.final}`;
      const citations = array(block.citations).map((citation) => safeDomainValue(citation));
      recordItem(context.state, itemId, { partType: "text", text: split.final, rawText: text(block.text), citations });
      if (split.reasoning) context.emit("reasoning", completed ? "completed" : "updated", { text: split.reasoning, delta: false }, sourceOf(frame.type, frame, { itemId: `${itemId}:thinking` }));
      if (split.final) context.emit("message", completed ? "completed" : "updated", {
        role: "assistant",
        text: split.final,
        delta: false,
        ...(citations.length ? { citations } : {}),
      }, source);
    } else if (block.type === "thinking" && block.thinking) {
      recordItem(context.state, itemId, { partType: "thinking", reasoning: text(block.thinking) });
      context.emit("reasoning", completed ? "completed" : "updated", { text: text(block.thinking), delta: false }, source);
    } else if (QODER_TOOL_USE_TYPES.has(block.type)) {
      const name = text(block.name || "tool");
      const input = safeDomainValue(block.input);
      const alreadyStarted = Boolean(context.state.items[itemId]);
      recordItem(context.state, itemId, { type: "tool", name, input, status: "running" });
      applyToolPlan(context, name, object(block.input), itemId, source);
      // Qoder's Todo/Task tools feed the dedicated native plan surface. They
      // are not commands and must not also create repeated Agent activity rows.
      if (!planTool(name)) context.emit("tool_call", alreadyStarted ? "updated" : "started", { name, callId: itemId, input }, source);
    } else if (QODER_SERVER_TOOL_RESULT_TYPES.has(block.type)) {
      emitServerToolResult(context, frame, block);
    } else {
      if (!emitSpecialContentBlock(context, frame, block, source)) emitUnknownContentBlock(context, block, source);
    }
  }
}

function emitToolResults(context, frame, content) {
  for (const rawBlock of content) {
    const block = object(rawBlock);
    if (block.type !== "tool_result") continue;
    const toolId = idOf(block.tool_use_id) || "tool";
    const known = object(context.state.items[toolId]);
    const name = text(inferredPlanResultName(frame, known.name, block) || "tool");
    const failed = block.is_error === true;
    const source = sourceOf(frame.type, frame, { itemId: toolId });
    recordItem(context.state, toolId, { status: failed ? "failed" : "completed", name });
    if (planTool(name)) {
      if (!failed && name === "TaskCreate") nativeTaskCreateResult(context, frame, toolId, source);
      if (!failed && name === "TaskList") nativeTaskListResult(context, frame, source);
      if (!failed && name === "TaskUpdate") nativeTaskUpdateResult(context, frame, toolId, source);
      continue;
    }
    if (!planTool(name)) context.emit("tool_result", failed ? "failed" : "completed", {
      name,
      callId: toolId,
      text: contentText(block.content),
    }, source);
    if (!planTool(name) && toolNameIsFileChange(name)) {
      context.emit("file_change", failed ? "failed" : "completed", fileChangeFromTool(name, known.input, { content: contentText(block.content) }), source);
    }
  }
}

function emitStreamEvent(context, frame) {
  const event = object(frame.event);
  const eventType = text(event.type);
  const index = Number.isInteger(event.index) ? event.index : 0;
  if (eventType === "message_start") {
    context.state.streamMessageId = idOf(event.message?.id || frame.uuid) || context.state.streamMessageId;
    recordItem(context.state, `qoder-stream:${context.state.streamMessageId}`, { blockIds: [] });
    updateQoderRequestUsage(context, event.message?.usage, sourceOf(`stream_event/${eventType}`, frame, { itemId: context.state.streamMessageId }));
    return;
  }
  // Qoder's include-partial-messages stream may assign a fresh wrapper UUID
  // to every delta. The message id (or the first UUID observed for the active
  // message) is the stable identity of all content blocks in that message.
  const messageId = idOf(event.message?.id)
    || context.state.streamMessageId
    || idOf(frame.uuid || frame.session_id)
    || "stream";
  if (!context.state.streamMessageId && !["message_stop", "message_delta"].includes(eventType)) {
    context.state.streamMessageId = messageId;
  }
  const itemId = `${messageId}:${index}`;
  const source = sourceOf(`stream_event/${eventType}`, frame, { itemId });
  if (eventType === "content_block_start") {
    const block = object(event.content_block);
    const messageKey = `qoder-stream:${messageId}`;
    const blockIds = array(context.state.items[messageKey]?.blockIds);
    recordItem(context.state, messageKey, { blockIds: [...blockIds.filter((id) => id !== itemId), itemId] });
    recordItem(context.state, itemId, {
      partType: block.type,
      completedBlockKey: null,
      toolId: idOf(block.id),
      name: text(block.name),
      input: safeDomainValue(block.input),
      citations: array(block.citations).map((citation) => safeDomainValue(citation)),
      // Some OpenAI-compatible providers reuse one Messages API id and block
      // index across consecutive Qoder tool-loop messages. Clear per-block
      // accumulators so JSON/text from the previous native block cannot bleed
      // into the next one.
      ...(block.type === "thinking" ? { reasoning: "" } : {}),
      ...(block.type === "text" ? { text: "" } : {}),
      ...(QODER_TOOL_USE_TYPES.has(block.type) ? { partialJson: "" } : {}),
    });
    if (["text", "thinking"].includes(block.type)) {
      // Text and thinking blocks are opened empty and populated by their
      // corresponding delta events. The start frame is lifecycle metadata,
      // not an unknown user-visible content block.
    } else if (QODER_TOOL_USE_TYPES.has(block.type)) {
      const toolId = idOf(block.id) || itemId;
      const input = safeDomainValue(block.input);
      recordItem(context.state, toolId, { type: "tool", name: text(block.name || "tool"), input, status: "running" });
      if (!planTool(block.name)) context.emit("tool_call", "started", { name: text(block.name || "tool"), callId: toolId, input }, sourceOf(`stream_event/${eventType}`, frame, { itemId: toolId }));
    } else if (QODER_SERVER_TOOL_RESULT_TYPES.has(block.type)) {
      emitServerToolResult(context, frame, block);
    } else {
      if (!emitSpecialContentBlock(context, frame, block, source)) emitUnknownContentBlock(context, block, source);
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
      // Task/Todo input deltas belong exclusively to the native plan surface.
      // Emitting them as ordinary tool calls creates duplicate command rows
      // which can never receive a visible tool_result because plan results are
      // intentionally consumed below.
      if (!planTool(known.name)) context.emit("tool_call", "updated", {
        name: text(known.name || "tool"),
        callId: toolId,
        partialJson: text(delta.partial_json),
      }, sourceOf(`stream_event/${eventType}`, frame, { itemId: toolId }));
    } else if (delta.type === "citations_delta") {
      const citations = array(known.citations);
      recordItem(context.state, itemId, { citations: [...citations, safeDomainValue(delta.citation)] });
    } else if (delta.type === "compaction_delta") {
      recordItem(context.state, itemId, { compaction: text(delta.content) });
      context.emit("job_status", "updated", {
        operation: "model_compaction",
        message: text(delta.content),
      }, source);
    } else if (delta.type === "signature_delta") {
      // The signature is opaque model-verification data. Qoder CN owns it;
      // EasyWork neither renders nor persists it.
    } else {
      emitUnmappedAgentEvent(context, "Qoder CN", "内容增量", delta.type, source);
    }
  } else if (eventType === "content_block_stop") {
    const known = object(context.state.items[itemId]);
    if (!["text", "thinking", ...QODER_TOOL_USE_TYPES].includes(known.partType)) return;
    const kind = known.partType === "thinking" ? "reasoning" : QODER_TOOL_USE_TYPES.has(known.partType) ? "tool_call" : "message";
    const split = kind === "message" ? splitTaggedThinking(known.text) : null;
    if (split?.reasoning) context.emit("reasoning", "completed", { text: split.reasoning, delta: false }, sourceOf(`stream_event/${eventType}`, frame, { itemId: `${itemId}:thinking` }));
    // content_block_stop only says Qoder finished serializing the tool input;
    // the command/edit itself is still running until a tool_result arrives.
    let completedInput = null;
    if (kind === "tool_call") {
      const toolId = idOf(known.toolId) || itemId;
      // A completed assistant tool_use may already carry the effective input
      // after native permission updates. Otherwise finish the streamed JSON
      // now, while this block index still belongs to the same tool_use_id.
      const nativeInput = object(context.state.items[toolId]?.input);
      const input = Object.keys(nativeInput).length ? nativeInput : parsedToolInput(known.partialJson);
      if (Object.keys(input).length) {
        completedInput = safeDomainValue(input);
        recordItem(context.state, toolId, { type: "tool", name: known.name, input: completedInput });
        if (planTool(known.name)) applyToolPlan(context, known.name, input, toolId, sourceOf(`stream_event/${eventType}`, frame, { itemId: toolId }));
      }
      if (planTool(known.name)) return;
    }
    context.emit(kind, kind === "tool_call" ? "updated" : "completed", kind === "message"
      ? {
          role: "assistant",
          text: split?.final || text(known.text).replace(/<\/?think>/gi, ""),
          delta: false,
          ...(array(known.citations).length ? { citations: safeDomainValue(known.citations) } : {}),
        }
      : kind === "reasoning"
        ? { text: text(known.reasoning), delta: false }
        : { name: text(known.name || "tool"), callId: idOf(known.toolId) || itemId, ...(completedInput ? { input: completedInput } : {}) }, source);
  } else if (eventType === "message_delta") {
    updateQoderRequestUsage(context, event.usage, source);
  } else if (eventType === "message_stop") {
    context.emit("status", "completed", { status: "message_complete" }, source);
    context.state.streamMessageId = null;
  } else {
    emitUnmappedAgentEvent(context, "Qoder CN", "流事件", eventType, source);
  }
}

function emitResult(context, frame) {
  const usage = normalizeUsage(frame.usage);
  const resultContextRatio = qoderNativeContextRatio(frame.usage);
  if (Object.keys(usage).length || resultContextRatio !== null) {
    const modelUsage = object(frame.modelUsage);
    const modelEntries = Object.values(modelUsage)
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
      .sort((left, right) => Number(right.inputTokens || 0) - Number(left.inputTokens || 0));
    const reportedLimit = modelEntries.find((entry) => Number(entry.contextWindow) > 0)?.contextWindow;
    const currentRequestUsage = context.state.contextUsage?.source === QODER_CONTEXT_USAGE_SOURCE
      ? context.state.contextUsage
      : resultContextRatio !== null
        ? { ratio: resultContextRatio, source: QODER_CONTEXT_USAGE_SOURCE }
        : null;
    const latestRequestUsage = currentRequestUsage
      ? qoderMessageContextUsage(currentRequestUsage, reportedLimit ?? currentRequestUsage.limit)
      : context.state.contextUsage?.source === "qoder-cn-context-report"
        ? context.state.contextUsage
        : null;
    // Keep the aggregate result usage on the canonical event for billing and
    // Task reports, but never overwrite the binding's current-window snapshot
    // with that aggregate.  A run without a message_delta has no verifiable
    // context snapshot and is deliberately reported as unavailable.
    context.state.contextUsage = latestRequestUsage;
    context.emit("usage", "completed", {
      ...usage,
      ...(latestRequestUsage ? { context: latestRequestUsage } : {}),
    }, sourceOf(frame.type, frame));
  }
  for (const denial of array(frame.permission_denials)) {
    const toolId = idOf(denial?.tool_use_id);
    if (!toolId || context.state.items[toolId]?.status === "failed") continue;
    const name = text(denial?.tool_name) || "tool";
    recordItem(context.state, toolId, { status: "failed", name });
    context.emit("tool_result", "failed", {
      name,
      callId: toolId,
      text: "权限被拒绝",
    }, sourceOf(frame.type, frame, { itemId: toolId }));
  }
  if (frame.deferred_tool_use) {
    const deferred = object(frame.deferred_tool_use);
    context.emit("job_status", "waiting", {
      operation: "deferred_tool_use",
      name: text(deferred.name),
      input: safeDomainValue(deferred.input),
    }, sourceOf(frame.type, frame, { itemId: deferred.id }));
  }
  const failed = frame.is_error === true || frame.subtype !== "success";
  const reportedQueuedTurns = Number.isInteger(frame.queued_turn_count) && frame.queued_turn_count >= 0
    ? frame.queued_turn_count
    : null;
  const queuedTurnCount = Number.isInteger(frame.easywork?.queuedTurnCount)
    ? frame.easywork.queuedTurnCount
    : reportedQueuedTurns ?? 0;
  const terminalResult = frame.easywork?.terminalResult !== false && queuedTurnCount === 0;
  if (!terminalResult) {
    // Qoder emits one result per native turn. When another user send is
    // queued, this is a turn boundary rather than the EasyWork Task's final
    // answer. The already-streamed assistant text remains visible, while the
    // reducer resets only its per-turn accumulator for the following reply.
    context.state.status = "running";
    context.state.finalText = "";
    context.state.finalSeen = false;
    context.state.streamMessageId = null;
    context.emit("status", "updated", {
      status: "running",
      turnStatus: failed ? "failed" : "completed",
      queuedTurnCount,
    }, sourceOf(frame.type, frame));
    return;
  }
  context.state.status = failed ? "error" : "completed";
  if (failed) {
    context.emit("error", "failed", { message: qoderErrorMessage(frame) }, sourceOf(frame.type, frame));
  } else {
    const split = splitTaggedThinking(frame.result || context.state.finalText);
    const resultText = emitLinkedRemoteArtifacts(context, split.final, sourceOf(frame.type, frame));
    const hasNativeThinking = Object.values(context.state.items).some((item) => item?.partType === "thinking");
    if (split.reasoning && !hasNativeThinking) {
      context.emit("reasoning", "completed", { text: split.reasoning, delta: false }, sourceOf(frame.type, frame, { itemId: "result-thinking" }));
    }
    context.state.finalText = resultText;
    context.state.finalSeen = true;
    context.emit("final", "completed", { text: resultText }, sourceOf(frame.type, frame));
  }
  context.emit("status", failed ? "failed" : "completed", { status: context.state.status }, sourceOf(frame.type, frame));
}

function emitQoderSystem(context, frame) {
  const subtype = text(frame.subtype);
  const source = sourceOf(frame.type, frame, { itemId: frame.task_id || frame.tool_use_id || frame.hook_id });
  if (subtype === "init") {
    context.state.status = "running";
    context.state.contextUsage = null;
    context.state.finalText = "";
    context.state.finalSeen = false;
    context.state.streamMessageId = null;
    context.state.pendingApprovals = {};
    context.state.pendingInputs = {};
    delete context.state.items.__qoderRequestUsage;
    context.emit("status", "completed", {
      status: "initialized",
      model: text(frame.model),
      permissionMode: text(frame.permissionMode),
      tools: array(frame.tools).map(String),
      skills: array(frame.skills).map(String),
      slashCommands: array(frame.slash_commands).map(String),
    }, source);
    return;
  }
  if (subtype === "compact_boundary") {
    context.emit("job_status", "completed", {
      operation: "compact",
      trigger: text(frame.compact_metadata?.trigger),
      preTokens: Number(frame.compact_metadata?.pre_tokens || 0),
      postTokens: Number(frame.compact_metadata?.post_tokens || 0),
      durationMs: Number(frame.compact_metadata?.duration_ms || 0),
    }, source);
    return;
  }
  if (subtype === "status") {
    const compactFailed = frame.compact_result === "failed";
    const status = frame.status === null ? "idle" : text(frame.status);
    context.emit("job_status", compactFailed ? "failed" : status === "idle" ? "completed" : "updated", {
      operation: status === "compacting" ? "compact" : "agent_status",
      status,
      message: text(frame.compact_error),
    }, source);
    return;
  }
  if (subtype === "api_retry") {
    context.emit("job_status", "waiting", {
      operation: "api_retry",
      attempt: Number(frame.attempt || 0),
      maxRetries: Number(frame.max_retries || 0),
      retryDelayMs: Number(frame.retry_delay_ms || 0),
      errorStatus: frame.error_status ?? null,
      message: text(frame.error),
    }, source);
    return;
  }
  if (subtype === "model_queue_status") {
    const queued = frame.status === "queued";
    context.emit("job_status", queued ? "waiting" : "completed", {
      operation: "model_queue",
      status: text(frame.status),
      model: text(frame.model_key),
      queueType: text(frame.queue_type),
      queueCount: Number(frame.queue_count || 0),
      waitTimeMs: Number(frame.wait_time_ms || 0),
      elapsedMs: Number(frame.queue_wait_elapsed_ms || 0),
      maxWaitMs: Number(frame.queue_max_wait_ms || 0),
      serviceAvailable: frame.service_available !== false,
      requestSetId: text(frame.request_set_id),
    }, sourceOf(frame.type, frame, { requestId: frame.request_id }));
    return;
  }
  if (subtype === "control_request_progress") {
    context.emit("job_status", frame.status === "api_retry" ? "waiting" : "started", {
      operation: "control_request",
      requestId: text(frame.request_id),
      status: text(frame.status),
      attempt: Number(frame.attempt || 0),
      maxRetries: Number(frame.max_retries || 0),
      retryDelayMs: Number(frame.retry_delay_ms || 0),
    }, sourceOf(frame.type, frame, { requestId: frame.request_id }));
    return;
  }
  if (["hook_started", "hook_progress", "hook_response"].includes(subtype)) {
    if (text(frame.hook_event) === "PreToolUse") {
      context.emit("job_status", subtype === "hook_started" ? "started" : subtype === "hook_progress" ? "updated" : phaseForStatus(frame.outcome, "completed"), {
        operation: "easywork.version.snapshot",
        visibility: "internal",
      }, source);
      return;
    }
    const phase = subtype === "hook_started" ? "started" : subtype === "hook_progress" ? "updated" : phaseForStatus(frame.outcome, "completed");
    context.emit("job_status", phase, {
      operation: "hook",
      name: text(frame.hook_name),
      hookEvent: text(frame.hook_event),
      message: text(frame.output || frame.stderr || frame.stdout),
      ...(Number.isFinite(Number(frame.exit_code)) ? { exitCode: Number(frame.exit_code) } : {}),
    }, source);
    return;
  }
  if (subtype === "plugin_install") {
    context.emit("job_status", phaseForStatus(frame.status), {
      operation: "plugin_install",
      name: text(frame.name),
      message: text(frame.error),
    }, source);
    return;
  }
  if (["task_started", "task_progress", "task_updated", "task_notification"].includes(subtype)) {
    const patch = object(frame.patch);
    const taskStatus = text(frame.status || patch.status || (subtype === "task_started" ? "running" : ""));
    const phase = subtype === "task_started" ? "started" : subtype === "task_progress" ? "updated" : phaseForStatus(taskStatus, "updated");
    recordItem(context.state, `task:${frame.task_id}`, {
      type: "backgroundTask",
      status: taskStatus,
      description: text(patch.description || frame.description || frame.summary),
      toolUseId: idOf(frame.tool_use_id),
    });
    if (!frame.skip_transcript) context.emit("job_status", phase, {
      operation: "agent_task",
      taskId: text(frame.task_id),
      toolUseId: text(frame.tool_use_id),
      taskType: text(frame.task_type || frame.subagent_type),
      description: text(patch.description || frame.description),
      summary: text(frame.summary),
      message: text(patch.error),
      usage: safeDomainValue(frame.usage || {}),
      background: frame.is_backgrounded === true || patch.is_backgrounded === true,
    }, source);
    return;
  }
  if (subtype === "background_tasks_changed") {
    context.emit("job_status", array(frame.tasks).length ? "updated" : "completed", {
      operation: "background_tasks",
      count: array(frame.tasks).length,
      tasks: safeDomainValue(array(frame.tasks)),
    }, source);
    return;
  }
  if (subtype === "plan_mode_changed") {
    context.emit("job_status", "completed", {
      operation: "plan_mode",
      active: object(frame.plan_mode).active === true,
    }, source);
    return;
  }
  if (subtype === "goal_updated") {
    const goal = object(frame.goal);
    const status = text(goal.status);
    const phase = status === "complete"
      ? "completed"
      : ["paused", "blocked", "usage_limited", "budget_limited"].includes(status)
        ? "waiting"
        : "updated";
    context.emit("job_status", phase, {
      operation: "goal",
      goalId: text(goal.id),
      status,
      message: text(goal.objective),
      reason: text(frame.reason),
      turnsUsed: Number(goal.turns_used || 0),
      ...(goal.max_turns !== null && goal.max_turns !== undefined && Number.isFinite(Number(goal.max_turns)) ? { maxTurns: Number(goal.max_turns) } : {}),
      timeUsedSeconds: Number(goal.time_used_seconds || 0),
      ...(goal.credits_budget !== null && goal.credits_budget !== undefined && Number.isFinite(Number(goal.credits_budget)) ? { creditsBudget: Number(goal.credits_budget) } : {}),
      ...(goal.credits_used !== null && goal.credits_used !== undefined && Number.isFinite(Number(goal.credits_used)) ? { creditsUsed: Number(goal.credits_used) } : {}),
    }, sourceOf(frame.type, frame, { itemId: goal.id }));
    return;
  }
  if (subtype === "goal_cleared") {
    context.emit("job_status", "completed", {
      operation: "goal",
      goalId: text(frame.goal_id),
      status: "cleared",
      reason: text(frame.reason),
    }, sourceOf(frame.type, frame, { itemId: frame.goal_id }));
    return;
  }
  if (subtype === "session_state_changed") {
    context.state.status = text(frame.state || context.state.status);
    context.emit("status", frame.state === "idle" ? "completed" : frame.state === "requires_action" ? "waiting" : "updated", {
      status: text(frame.state),
    }, source);
    return;
  }
  if (subtype === "permission_denied") {
    const toolId = idOf(frame.tool_use_id) || "permission-denied";
    recordItem(context.state, toolId, { status: "failed", name: text(frame.tool_name || "tool") });
    context.emit("tool_result", "failed", {
      name: text(frame.tool_name || "tool"),
      callId: toolId,
      text: text(frame.message || frame.decision_reason || "权限被拒绝"),
      decisionReason: text(frame.decision_reason_type),
    }, sourceOf(frame.type, frame, { itemId: toolId }));
    return;
  }
  if (subtype === "files_persisted") {
    const failures = array(frame.failed);
    context.emit("job_status", failures.length ? "failed" : "completed", {
      operation: "files_persisted",
      files: safeDomainValue(array(frame.files).map((file) => ({ name: file?.filename, fileId: file?.file_id }))),
      failures: safeDomainValue(failures),
      processedAt: text(frame.processed_at),
    }, source);
    return;
  }
  if (subtype === "artifacts_update") {
    for (const rawArtifact of array(frame.artifacts)) {
      const artifact = object(rawArtifact);
      const path = text(artifact.path || artifact.display_path || artifact.relative_path);
      if (!path) continue;
      const artifactSource = sourceOf(frame.type, frame, { itemId: `artifact:${path}` });
      if (artifact.kind === "changed") {
        // Qoder's artifact snapshot is authoritative for changes made through
        // shell commands as well as edit tools. Record it in the version ledger
        // but keep it internal so a normal Edit/Write result is not shown twice.
        context.emit("file_change", "completed", {
          action: artifact.is_new === true ? "create" : "edit",
          path,
          changes: [safeDomainValue({
            path,
            displayPath: text(artifact.display_path),
            relativePath: text(artifact.relative_path),
            additions: Number(artifact.additions || 0),
            deletions: Number(artifact.deletions || 0),
            isNew: artifact.is_new === true,
          })],
          visibility: "internal",
        }, artifactSource);
      } else if (artifact.kind === "presented") {
        context.emit("artifact", "completed", {
          source: "remote",
          path,
          name: text(artifact.name) || path.split("/").filter(Boolean).at(-1) || "artifact",
          kind: "file",
        }, artifactSource);
      }
    }
    return;
  }
  if (subtype === "memory_generation") {
    const result = object(frame.result);
    context.emit("job_status", result.status === "failed" ? "failed" : "completed", {
      operation: "memory_generation",
      visibility: "internal",
      status: text(result.status),
      attemptId: text(result.attemptId),
      origin: text(result.origin),
      message: text(result.reason),
      writtenFiles: array(result.writtenFiles).length,
      failedFiles: array(result.failedFiles).length,
      durationMs: Number(result.durationMs || 0),
      ...(result.credits !== null && result.credits !== undefined && Number.isFinite(Number(result.credits)) ? { credits: Number(result.credits) } : {}),
    }, source);
    return;
  }
  if (subtype === "memory_consumption") {
    const result = object(frame.result);
    const files = array(result.files);
    context.emit("job_status", result.status === "failed" ? "failed" : "completed", {
      operation: "memory_consumption",
      visibility: "internal",
      status: text(result.status),
      files: files.length,
      unavailableFiles: files.filter((file) => object(file).status !== "loaded").length,
    }, source);
    return;
  }
  if (subtype === "skill_evolution") {
    const result = object(frame.result);
    context.emit("job_status", result.status === "failed" ? "failed" : "completed", {
      operation: "skill_evolution",
      visibility: "internal",
      status: text(result.status),
      attemptId: text(result.attemptId),
      message: text(result.reason),
      suggestions: array(result.suggestions).length,
      durationMs: Number(result.durationMs || 0),
    }, source);
    return;
  }
  if (subtype === "memory_recall") {
    context.emit("job_status", "completed", {
      operation: "memory_recall",
      mode: text(frame.mode),
      count: array(frame.memories).length,
      scopes: [...new Set(array(frame.memories).map((memory) => text(memory?.scope)).filter(Boolean))],
    }, source);
    return;
  }
  if (subtype === "elicitation_complete") {
    context.emit("job_status", "completed", {
      operation: "elicitation",
      server: text(frame.mcp_server_name),
      elicitationId: text(frame.elicitation_id),
    }, source);
    return;
  }
  if (["model_refusal_fallback", "model_refusal_no_fallback"].includes(subtype)) {
    context.emit("job_status", subtype === "model_refusal_fallback" ? "completed" : "failed", {
      operation: subtype,
      message: text(frame.content || frame.api_refusal_explanation),
      originalModel: text(frame.original_model),
      fallbackModel: text(frame.fallback_model),
      retractedMessageIds: array(frame.retracted_message_uuids).map(String),
    }, source);
    return;
  }
  if (subtype === "informational") {
    context.emit("job_status", frame.prevent_continuation ? "failed" : "completed", {
      operation: subtype,
      level: text(frame.level),
      message: text(frame.content),
    }, source);
    return;
  }
  if (subtype === "notification") {
    context.emit("job_status", "completed", {
      operation: subtype,
      level: text(frame.priority),
      message: text(frame.text),
    }, source);
    return;
  }
  if (subtype === "local_command_output") {
    context.emit("message", "completed", {
      role: "assistant",
      text: text(frame.content),
      delta: false,
    }, source);
    return;
  }
  if (subtype === "mirror_error") {
    context.emit("job_status", "failed", {
      operation: subtype,
      message: text(frame.error),
    }, source);
    return;
  }
  if (subtype === "worker_shutting_down") {
    context.emit("job_status", "cancelled", {
      operation: subtype,
      message: text(frame.reason),
    }, source);
    return;
  }
  if (subtype === "session_title_changed") {
    // The webpage conversation owns its title. Preserve the native revision in
    // the journal without replacing the user-visible EasyWork title.
    context.emit("job_status", "completed", {
      operation: "session_title",
      visibility: "internal",
      title: text(frame.title),
      titleSource: text(frame.source),
      revision: Number(frame.revision || 0),
    }, source);
    return;
  }
  if (subtype === "available_models_update") {
    context.emit("job_status", "completed", {
      operation: "available_models",
      visibility: "internal",
      currentModel: text(frame.currentModel),
      count: array(frame.models).length,
    }, source);
    return;
  }
  if (subtype === "commands_changed") {
    context.emit("job_status", "completed", {
      operation: "available_commands",
      visibility: "internal",
      count: array(frame.commands).length,
    }, source);
    return;
  }
  // Current bridge/cache metadata. These messages are consumed deliberately:
  // they carry no additional assistant text and must never become transcript
  // rows or leak the remote control plane into the webpage conversation.
  if (["thinking_tokens", "post_turn_summary", "task_summary"].includes(subtype)) return;
  emitUnmappedAgentEvent(context, "Qoder CN", "system 事件", subtype, source);
}

function emitQoderSpecial(context, frame) {
  const type = text(frame.type);
  if (type === "command_lifecycle") {
    const status = text(frame.state);
    const phase = status === "queued"
      ? "waiting"
      : status === "started"
        ? "updated"
        : status === "completed"
          ? "completed"
          : "cancelled";
    context.emit("job_status", phase, {
      operation: "command_lifecycle",
      commandId: text(frame.command_uuid),
      status,
    }, sourceOf(type, frame, { itemId: frame.command_uuid }));
    return true;
  }
  if (type === "active_goal") {
    const goal = object(frame.value);
    context.emit("job_status", frame.value ? "updated" : "completed", {
      operation: "active_goal",
      message: text(goal.condition),
      iterations: Number(goal.iterations || 0),
      lastReason: text(goal.last_reason),
    }, sourceOf(type, frame));
    return true;
  }
  if (type === "tool_progress") {
    const reportedToolId = idOf(frame.tool_use_id) || "tool";
    const heartbeatParentId = frame.heartbeat === true
      ? reportedToolId.replace(/-heartbeat-\d+$/u, "")
      : reportedToolId;
    // Qoder CN 2.1.245 emits long-running tool heartbeats with synthetic
    // IDs such as `<tool-use-id>-heartbeat-0`. They are progress updates for
    // the existing call, not new tool calls. Correlate them only when the
    // parent is already known; an uncorrelated heartbeat carries no durable
    // lifecycle state and is safer to ignore than to leave an orphan running.
    if (frame.heartbeat === true
      && heartbeatParentId !== reportedToolId
      && !context.state.items[heartbeatParentId]) return true;
    const toolId = heartbeatParentId;
    const known = object(context.state.items[toolId]);
    recordItem(context.state, toolId, { status: "running", name: text(frame.tool_name || known.name || "tool") });
    if (!planTool(frame.tool_name || known.name)) context.emit("tool_call", "updated", {
      name: text(frame.tool_name || known.name || "tool"),
      callId: toolId,
      elapsedSeconds: Number(frame.elapsed_time_seconds || 0),
      heartbeat: frame.heartbeat === true,
      taskId: text(frame.task_id),
      retry: safeDomainValue(frame.subagent_retry || {}),
    }, sourceOf(type, frame, { itemId: toolId }));
    return true;
  }
  if (type === "tool_use_summary") {
    context.emit("job_status", "completed", {
      operation: "tool_summary",
      message: text(frame.summary),
      toolUseIds: array(frame.preceding_tool_use_ids).map(String),
    }, sourceOf(type, frame));
    return true;
  }
  if (type === "rate_limit_event") {
    const info = object(frame.rate_limit_info);
    context.emit("job_status", info.status === "rejected" ? "waiting" : "updated", {
      operation: "rate_limit",
      status: text(info.status),
      resetsAt: Number(info.resetsAt || 0),
      utilization: Number(info.utilization || 0),
      rateLimitType: text(info.rateLimitType),
    }, sourceOf(type, frame));
    return true;
  }
  if (type === "auth_status") {
    context.emit("job_status", frame.error ? "failed" : frame.isAuthenticating ? "updated" : "completed", {
      operation: "authentication",
      message: text(frame.error) || array(frame.output).map(String).join("\n"),
    }, sourceOf(type, frame));
    return true;
  }
  if (type === "prompt_suggestion") {
    context.emit("job_status", "completed", { operation: "prompt_suggestion", message: text(frame.suggestion) }, sourceOf(type, frame));
    return true;
  }
  if (type === "cloud_agent_event") {
    const data = object(frame.data);
    context.emit("job_status", phaseForStatus(data.status, "updated"), {
      operation: "cloud_agent",
      cloudEvent: text(frame.event),
      cloudId: text(frame.id),
      status: text(data.status),
      message: text(data.message || data.summary),
    }, sourceOf(type, frame, { itemId: frame.id }));
    return true;
  }
  if (type === "conversation_reset") {
    context.state.sessionId = idOf(frame.new_conversation_id) || context.state.sessionId;
    context.state.finalText = "";
    context.state.finalSeen = false;
    context.state.items = {};
    context.emit("status", "updated", { status: "conversation_reset", sessionId: context.state.sessionId }, sourceOf(type, frame));
    return true;
  }
  if (type === "autocompact_state") {
    // The current SDK bridge forwards this level signal in addition to the
    // authoritative compact_boundary/status events. It is control-plane state,
    // not assistant output.
    return true;
  }
  return false;
}

function reduceQoderCn(previousState, frame, producer) {
  const context = createReducerContext(previousState, producer);
  const type = text(frame.type);
  if (frame.session_id) context.state.sessionId = idOf(frame.session_id);

  if (type === "easywork_native_boundary") {
    // Transport resolves Qoder's authoritative JSONL leaf because the
    // terminal stream-json result omits the final transcript UUID. Keep this
    // control-plane frame invisible while advancing (or deliberately
    // clearing) the resume/fork boundary.
    context.state.turnId = frame.turn_id ? idOf(frame.turn_id) : null;
  } else if (type === "easywork_compatibility_issue") {
    emitAgentCompatibilityIssue(context, "Qoder CN", {
      ...object(frame.issue),
      agentVersion: text(frame.easywork?.agentVersion),
    }, sourceOf(type, frame));
  } else if (type === "easywork_effort_adjusted") {
    emitAgentEffortAdjustment(context, object(frame.adjustment), sourceOf(type, frame));
  } else if (type === "system") {
    emitQoderSystem(context, frame);
  } else if (type === "stream_event") {
    emitStreamEvent(context, frame);
  } else if (type === "assistant") {
    // Qoder's stream-json assistant UUID is an SDK event identifier and is not
    // guaranteed to exist in the native transcript. Only the transport's
    // verified active-leaf boundary may advance the resumable turn.
    const retractedMessageIds = array(frame.supersedes).map(String);
    if (retractedMessageIds.length) context.emit("job_status", "updated", {
      operation: "message_retracted",
      retractedMessageIds,
    }, sourceOf(type, frame));
    if (frame.error) context.emit("job_status", frame.error === "max_output_tokens" ? "waiting" : "failed", {
      operation: "assistant_error",
      message: text(frame.error),
      recoverable: frame.error === "max_output_tokens",
    }, sourceOf(type, frame));
    if (frame.aborted === true) context.emit("job_status", "cancelled", {
      operation: "assistant_stream",
      message: "Qoder CN 的当前输出已中断",
    }, sourceOf(type, frame));
    if (frame.context_usage) {
      const contextUsage = normalizeContextUsage({
        used: frame.context_usage.total_tokens,
        limit: frame.context_usage.raw_max_tokens,
      });
      if (Object.keys(contextUsage).length) {
        context.state.contextUsage = { ...contextUsage, source: "qoder-cn-context-report" };
        context.emit("usage", "completed", { context: context.state.contextUsage }, sourceOf(type, frame));
      }
    }
    if (!frame.context_usage) updateQoderRequestUsage(context, frame.message?.usage, sourceOf(type, frame));
    emitAssistantContent(context, frame, array(frame.message?.content), true);
  } else if (type === "user") {
    emitToolResults(context, frame, array(frame.message?.content));
  } else if (type === "result") {
    emitResult(context, frame);
  } else if (type === "control_cancel_request") {
    const requestId = idOf(frame.request_id);
    const wasInput = Boolean(requestId && context.state.pendingInputs[requestId]);
    const wasApproval = Boolean(requestId && context.state.pendingApprovals[requestId]);
    if (requestId) delete context.state.pendingInputs[requestId];
    if (requestId) delete context.state.pendingApprovals[requestId];
    if (wasInput || wasApproval) context.emit(wasInput ? "input_response" : "approval_response", "cancelled", {
      requestId,
      decision: "cancelled",
    }, sourceOf(type, frame, { requestId }));
  } else if (type === "control_request") {
    const request = object(frame.request);
    const requestId = idOf(frame.request_id);
    const tool = text(request.tool_name);
    const input = safeDomainValue(request.input || {});
    if (request.subtype === "can_use_tool" && tool === "AskUserQuestion") {
      if (requestId) context.state.pendingInputs[requestId] = {
        type: "ask_user_question",
        itemId: idOf(request.tool_use_id),
        input,
        questions: safeDomainValue(array(request.input?.questions)),
      };
      context.emit("input_request", "waiting", {
        requestId,
        tool,
        input,
      }, sourceOf(type, frame, { requestId, itemId: request.tool_use_id }));
    } else if (request.subtype === "can_use_tool") {
      if (requestId) context.state.pendingApprovals[requestId] = {
        type: "can_use_tool",
        itemId: idOf(request.tool_use_id),
        suggestions: safeDomainValue(request.permission_suggestions || []),
        defaultToNo: request.default_to_no === true,
      };
      context.emit("approval_request", "waiting", {
        requestId,
        action: "can_use_tool",
        tool,
        input,
        title: text(request.title),
        description: text(request.description),
        displayName: text(request.display_name),
        reason: text(request.decision_reason),
        blockedPath: text(request.blocked_path),
        allowSession: request.suppress_always_allow_rule !== true,
        defaultToNo: request.default_to_no === true,
      }, sourceOf(type, frame, { requestId, itemId: request.tool_use_id }));
    } else if (request.subtype === "elicitation") {
      const elicitation = elicitationInput(request);
      if (requestId) context.state.pendingInputs[requestId] = {
        type: "qoder_elicitation",
        itemId: idOf(request.tool_use_id),
        mode: elicitation.mode,
        schema: elicitation.schema || {},
        questions: safeDomainValue(elicitation.questions),
      };
      context.emit("input_request", "waiting", {
        requestId,
        tool: "mcp_elicitation",
        server: text(request.mcp_server_name),
        message: text(request.message),
        input: safeDomainValue(elicitation),
      }, sourceOf(type, frame, { requestId, itemId: request.tool_use_id }));
    } else if (request.subtype === "request_user_dialog") {
      const payload = object(request.payload);
      const choices = array(payload.options || payload.choices).map((choice) => typeof choice === "string"
        ? { label: choice, description: "" }
        : { label: text(choice?.label || choice?.title || choice?.value), description: text(choice?.description) }).filter((choice) => choice.label);
      const dialogInput = { questions: [{
        id: "response",
        header: text(payload.title) || text(request.dialog_kind),
        question: text(payload.message || payload.description) || "Agent 需要你的回答后才能继续。",
        required: true,
        allowCustom: choices.length === 0,
        options: choices,
      }] };
      if (requestId) context.state.pendingInputs[requestId] = {
        type: "qoder_dialog",
        itemId: idOf(request.tool_use_id),
        dialogKind: text(request.dialog_kind),
        questions: safeDomainValue(dialogInput.questions),
      };
      context.emit("input_request", "waiting", {
        requestId,
        tool: "request_user_dialog",
        dialogKind: text(request.dialog_kind),
        input: safeDomainValue(dialogInput),
      }, sourceOf(type, frame, { requestId, itemId: request.tool_use_id }));
    } else {
      // All remaining control-request subtypes travel from an SDK host to the
      // CLI. EasyWork does not advertise those host capabilities, so receiving
      // one is a protocol violation; fail visibly instead of misrendering it as
      // a permission prompt and leaving the native process parked forever.
      const agentVersion = text(frame.easywork?.agentVersion);
      const eventType = text(request.subtype || "unknown");
      context.emit("error", "failed", {
        message: `Qoder CN${agentVersion ? ` ${agentVersion}` : " 当前版本"} 发出了无法安全代答的控制请求：${eventType}`,
        ...(agentVersion ? { agentVersion } : {}),
        eventType,
      }, sourceOf(type, frame, { requestId, agentVersion }));
    }
  } else if (type === "control_response") {
    const response = object(frame.response);
    const requestId = idOf(response.request_id);
    const wasInput = Boolean(requestId && context.state.pendingInputs[requestId]);
    const wasApproval = Boolean(requestId && context.state.pendingApprovals[requestId]);
    if (requestId) delete context.state.pendingApprovals[requestId];
    if (requestId) delete context.state.pendingInputs[requestId];
    if (wasInput || wasApproval || response.subtype === "error") {
      context.emit(wasInput ? "input_response" : "approval_response", response.subtype === "error" ? "failed" : "completed", {
        requestId,
        decision: text(response.response?.behavior || response.subtype),
        ...(response.subtype === "error" ? { error: text(response.error) } : {}),
      }, sourceOf(type, frame, { requestId }));
    }
    const pending = [...array(response.pending_permission_requests), ...array(response.pending_user_dialog_requests)];
    for (const requestFrame of pending) {
      const pendingRequestId = idOf(requestFrame?.request_id);
      if (!pendingRequestId || context.state.pendingInputs[pendingRequestId] || context.state.pendingApprovals[pendingRequestId]) continue;
      const nested = reduceQoderCn(context.state, requestFrame, producer);
      context.state = nested.state;
      context.events.push(...nested.events);
    }
  } else if (type === "keep_alive") {
    // Protocol heartbeat: it carries no user-visible state by definition.
  } else {
    if (!emitQoderSpecial(context, frame)) emitUnmappedAgentEvent(context, "Qoder CN", "事件", type, sourceOf(type, frame));
  }

  return { state: context.state, events: context.events };
}

function userFrame(prompt, priority = null) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}

function processDescriptor(args, stdin, cwd) {
  return { transport: "process-jsonl", executable: "qoderclicn", args, ...(cwd ? { cwd: String(cwd) } : {}), ...(stdin ? { stdin } : {}) };
}

function baseArgs() {
  return ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
}

function resumedArgs(input) {
  const pendingRewind = object(input.pendingRewind);
  if (pendingRewind.sessionId && pendingRewind.resumeSessionAt) {
    return [
      ...baseArgs(),
      "--resume", String(pendingRewind.sessionId),
      "--resume-session-at", String(pendingRewind.resumeSessionAt),
      ...(pendingRewind.resumeDropsTurn
        ? ["--resume-drops-turn", String(pendingRewind.resumeDropsTurn)]
        : []),
    ];
  }
  const pendingFork = object(input.pendingFork);
  if (pendingFork.sourceSessionId && pendingFork.targetSessionId && pendingFork.resumeSessionAt) {
    return [
      ...baseArgs(),
      "--resume", String(pendingFork.sourceSessionId),
      "--fork-session",
      "--session-id", String(pendingFork.targetSessionId),
      "--resume-session-at", String(pendingFork.resumeSessionAt),
    ];
  }
  return input.sessionId
    ? [...baseArgs(), "--resume", String(input.sessionId)]
    : baseArgs();
}

function buildQoderCnOperation(operation, input) {
  if (operation === "start") {
    const prompt = requireString(input, "prompt", operation);
    return processDescriptor(resumedArgs(input), [userFrame(prompt)], input.cwd);
  }
  if (operation === "append") {
    return {
      transport: "process-jsonl-stdin",
      // Qoder's stream-json protocol has a native immediate-priority user
      // frame. It steers the active turn without manufacturing a separate
      // interrupt/result boundary in the webpage conversation.
      frames: [userFrame(requireString(input, "prompt", operation), "now")],
    };
  }
  if (operation === "interrupt") {
    const commandId = requireString(input, "commandId", operation);
    return {
      transport: "process-jsonl-stdin",
      frames: [{
        type: "control_request",
        request_id: `easywork-interrupt-${commandId}`,
        request: { subtype: "interrupt" },
      }],
    };
  }
  if (operation === "respondApproval") {
    const requestId = requireString(input, "requestId", operation);
    const decision = requireString(input, "decision", operation);
    const pendingApproval = object(input.pendingApproval);
    invariant(["approve", "approve_session", "reject"].includes(decision), "AGENT_APPROVAL_DECISION_INVALID", "Qoder CN 审批结果无效", { status: 400 });
    const sessionUpdates = decision === "approve_session"
      ? sessionPermissionUpdates(pendingApproval.suggestions)
      : [];
    const response = decision === "reject"
      ? { behavior: "deny", message: "User rejected this operation." }
      : {
          behavior: "allow",
          ...(sessionUpdates.length
            ? { updatedPermissions: sessionUpdates }
            : {}),
        };
    return {
      transport: "process-jsonl-stdin",
      frames: [{ type: "control_response", response: { subtype: "success", request_id: requestId, response } }],
    };
  }
  if (operation === "respondInput") {
    const requestId = requireString(input, "requestId", operation);
    const answers = input.answers;
    const pendingInput = object(input.pendingInput);
    const originalInput = object(pendingInput.input);
    invariant(answers && typeof answers === "object" && !Array.isArray(answers), "AGENT_INPUT_ANSWERS_INVALID", "Qoder CN 用户回答无效", { status: 400 });
    if (pendingInput.type === "qoder_elicitation") {
      const mode = text(pendingInput.mode || "form");
      const actionAnswer = array(answers.action).length ? text(array(answers.action)[0]) : text(answers.action);
      const schema = object(pendingInput.schema);
      const properties = object(schema.properties);
      const content = {};
      for (const question of array(pendingInput.questions)) {
        const id = text(question?.id);
        if (!id || id === "action") continue;
        const raw = answers[id] ?? answers[text(question?.question)];
        const values = (Array.isArray(raw) ? raw : [raw]).map((value) => text(value)).filter(Boolean);
        if (!values.length) continue;
        content[id] = coercedElicitationValue(properties[id], values);
      }
      return {
        transport: "process-jsonl-stdin",
        frames: [{
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: {
              action: /^(?:取消|cancel)$/i.test(actionAnswer) ? "cancel" : "accept",
              ...(mode === "form" ? { content: safeDomainValue(content) } : {}),
            },
          },
        }],
      };
    }
    if (pendingInput.type === "qoder_dialog") {
      const raw = answers.response;
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw ?? "")];
      invariant(values.some((value) => value.trim()), "AGENT_INPUT_ANSWERS_REQUIRED", "Qoder CN 用户回答不能为空", { status: 400 });
      return {
        transport: "process-jsonl-stdin",
        frames: [{
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: { behavior: "completed", result: values.length === 1 ? values[0] : values },
          },
        }],
      };
    }
    const cleanAnswers = Object.fromEntries(Object.entries(answers).map(([question, answer]) => [
      String(question),
      Array.isArray(answer) ? answer.map(String).join(", ") : String(answer ?? ""),
    ]).filter(([question, answer]) => question.trim() && answer.trim()));
    invariant(Object.keys(cleanAnswers).length > 0, "AGENT_INPUT_ANSWERS_REQUIRED", "Qoder CN 用户回答不能为空", { status: 400 });
    return {
      transport: "process-jsonl-stdin",
      frames: [{
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: {
            behavior: "allow",
            updatedInput: { ...originalInput, answers: cleanAnswers },
          },
        },
      }],
    };
  }
  if (operation === "resume") {
    requireString(input, "sessionId", operation);
    const args = resumedArgs(input);
    return processDescriptor(args, [userFrame(requireString(input, "prompt", operation))], input.cwd);
  }
  if (operation === "compact") {
    if (input.processId) return { transport: "process-jsonl-stdin", frames: [userFrame(COMPACT_COMMAND)] };
    const args = [...baseArgs(), "--resume", requireString(input, "sessionId", operation)];
    return processDescriptor(args, [userFrame(COMPACT_COMMAND)], input.cwd);
  }
  if (operation === "fork") {
    return {
      transport: "native-deferred",
      sourceSessionId: requireString(input, "sourceSessionId", operation),
      targetSessionId: requireString(input, "targetSessionId", operation),
      resumeSessionAt: requireString(input, "resumeSessionAt", operation),
    };
  }
  if (operation === "revert") {
    return {
      transport: "native-rewind-deferred",
      sessionId: requireString(input, "sessionId", operation),
      resumeSessionAt: requireString(input, "resumeSessionAt", operation),
      ...(input.resumeDropsTurn ? { resumeDropsTurn: String(input.resumeDropsTurn) } : {}),
    };
  }
  return { transport: "event-cache", action: "result-usage.snapshot", sessionId: idOf(input.sessionId) };
}

export function createQoderCnAdapter(options = {}) {
  return defineAgentAdapter({
    id: "qoder-cn",
    protocol: "qoder-cn-stream-json",
    capabilities: CAPABILITIES,
    reduce: reduceQoderCn,
    buildOperation: buildQoderCnOperation,
  }, options);
}
