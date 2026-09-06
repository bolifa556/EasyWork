import { parseRemoteArtifactLinks } from "../../../shared/remote-artifact-links.mjs";
export { remoteArtifactPath } from "../../../shared/remote-artifact-links.mjs";

export function text(value) {
  return typeof value === "string" ? value : "";
}

export function idOf(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function array(value) {
  return Array.isArray(value) ? value : [];
}

export function appendItemText(state, itemId, field, delta, replacement) {
  const key = String(itemId || "anonymous");
  const item = object(state.items[key]);
  const next = replacement !== undefined ? text(replacement) : `${text(item[field])}${text(delta)}`;
  state.items[key] = { ...item, [field]: next };
  return next;
}

export function recordItem(state, itemId, patch) {
  const key = String(itemId || "anonymous");
  state.items[key] = { ...object(state.items[key]), ...object(patch) };
  return state.items[key];
}

export function normalizeUsage(value) {
  const usage = object(value);
  const cache = object(usage.cache);
  const input = number(usage.input ?? usage.input_tokens ?? usage.inputTokens);
  const output = number(usage.output ?? usage.output_tokens ?? usage.outputTokens);
  const reasoning = number(
    usage.reasoning
      ?? usage.reasoning_tokens
      ?? usage.reasoningTokens
      ?? usage.reasoning_output_tokens
      ?? usage.reasoningOutputTokens,
  );
  const cachedInput = number(
    usage.cached_input_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cacheReadInputTokens
      ?? cache.read,
  );
  const cacheWrite = number(usage.cache_creation_input_tokens ?? usage.cacheWriteInputTokens ?? cache.write);
  const total = number(usage.total ?? usage.total_tokens ?? usage.totalTokens, input + output + reasoning);
  const normalized = { input, output, reasoning, cachedInput, cacheWrite, total };
  for (const key of Object.keys(normalized)) {
    if (!Number.isFinite(normalized[key])) delete normalized[key];
  }
  return normalized;
}

export function normalizeContextUsage(value) {
  const source = object(value);
  const used = number(source.used ?? source.total ?? source.total_tokens ?? source.totalTokens);
  const limit = number(source.limit ?? source.model_context_window ?? source.modelContextWindow);
  const remaining = number(source.remaining, Number.isFinite(limit) && Number.isFinite(used) ? limit - used : undefined);
  const result = { used, limit, remaining };
  for (const key of Object.keys(result)) {
    if (!Number.isFinite(result[key])) delete result[key];
  }
  if (Number.isFinite(result.used) && Number.isFinite(result.limit) && result.limit > 0) {
    result.ratio = Math.min(1, Math.max(0, result.used / result.limit));
  }
  return result;
}

function number(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  return fallback;
}

export function toolNameIsFileChange(name) {
  return /^(?:edit|write|apply_patch|multiedit|notebookedit)$/i.test(String(name || ""));
}

export function fileChangeFromTool(name, input = {}, output = {}) {
  const source = object(input);
  const result = object(output);
  const structured = object(result.structured);
  const path = text(
    source.file_path
      || source.filePath
      || source.path
      || result.file_path
      || result.filePath
      || result.path
      || result.target
      || structured.file_path
      || structured.filePath
      || structured.path
      || structured.target
      || structured.resource,
  );
  const explicitDiff = text(structured.diff || result.diff || source.diff || source.patch);
  const before = text(source.old_string || source.oldString || source.before);
  const after = text(source.new_string || source.newString || source.content || source.after);
  const edits = array(source.edits).map((entry) => object(entry));
  const existed = typeof structured.existed === "boolean"
    ? structured.existed
    : typeof result.existed === "boolean"
      ? result.existed
      : undefined;
  const diff = explicitDiff || syntheticUnifiedDiff({
    path,
    write: /^write$/i.test(String(name)),
    existed,
    before,
    after,
    edits,
  });
  const change = {
    action: /^write$/i.test(String(name)) ? "write" : "edit",
  };
  if (path) change.path = path;
  if (diff) change.diff = diff;
  if (existed !== undefined) change.existed = existed;
  return change;
}

function prefixedLines(value, prefix) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => `${prefix}${line}`).join("\n");
}

function syntheticUnifiedDiff({ path, write, existed, before, after, edits }) {
  // A Write over an existing file does not expose the overwritten bytes.  A
  // plus-only pseudo diff would falsely describe the previous file as empty,
  // so leave it unqualified and let the version ledger use its materialized or
  // pre-execution snapshot instead.
  if (write && existed === true && !before && !edits.length) return "";
  const hunks = [];
  if (edits.length) {
    for (const edit of edits) {
      const oldText = text(edit.old_string || edit.oldString || edit.before);
      const newText = text(edit.new_string || edit.newString || edit.after);
      if (!oldText && !newText) continue;
      hunks.push(`@@\n${prefixedLines(oldText, "-")}${oldText && newText ? "\n" : ""}${prefixedLines(newText, "+")}`);
    }
  } else if (before || after) {
    hunks.push(`@@\n${prefixedLines(before, "-")}${before && after ? "\n" : ""}${prefixedLines(after, "+")}`);
  }
  if (!hunks.length) return "";
  const target = (path || "file").replace(/^\/+/, "");
  const header = write && existed === false
    ? `--- /dev/null\n+++ b/${target}`
    : `--- a/${target}\n+++ b/${target}`;
  return `${header}\n${hunks.join("\n")}`;
}

export function planItems(value) {
  return array(value).map((entry, index) => {
    const item = typeof entry === "string" ? { content: entry } : object(entry);
    return {
      id: idOf(item.id) || String(index + 1),
      text: text(item.content || item.text || item.title || item.step),
      status: normalizePlanItemStatus(item.status),
      ...(item.priority ? { priority: String(item.priority) } : {}),
    };
  }).filter((item) => item.text);
}

export function normalizePlanItemStatus(value) {
  const compact = String(value || "pending").replace(/[\s_-]/g, "").toLowerCase();
  if (["inprogress", "active", "running"].includes(compact)) return "in_progress";
  if (["done", "complete", "completed", "success", "succeeded"].includes(compact)) return "completed";
  if (["error", "failed", "failure"].includes(compact)) return "failed";
  if (["deleted", "removed"].includes(compact)) return "deleted";
  if (["cancelled", "canceled", "skipped"].includes(compact)) return "skipped";
  return "pending";
}

export function phaseForStatus(status, fallback = "updated") {
  const value = String(status || "").toLowerCase();
  if (["pending", "queued", "created"].includes(value)) return "started";
  if (["running", "in_progress", "active", "busy"].includes(value)) return "updated";
  if (["completed", "complete", "done", "success", "succeeded", "idle"].includes(value)) return "completed";
  if (["error", "failed", "failure"].includes(value)) return "failed";
  if (["cancelled", "canceled", "aborted", "interrupted"].includes(value)) return "cancelled";
  if (["waiting", "blocked", "approval"].includes(value)) return "waiting";
  return fallback;
}

export function safeResultText(value) {
  if (typeof value === "string") return value;
  const source = object(value);
  return text(source.output || source.content || source.text || source.message);
}

/**
 * A remote Agent can expose an existing workspace file without copying its
 * bytes through the model protocol by returning a standard Markdown file URL.
 * The adapter turns that URL into a canonical remote Artifact and removes the
 * unusable file:// target from the assistant body.  The Artifact service later
 * verifies scope/hash and streams the file only when the user downloads it.
 */
export function emitLinkedRemoteArtifacts(context, value, source = {}) {
  const { original, cleaned, artifacts } = parseRemoteArtifactLinks(value);

  recordItem(context.state, "easywork:linked-final", { original, cleaned, paths: artifacts.map((artifact) => artifact.path) });

  const emittedPaths = new Set();
  for (const artifact of artifacts) {
    const itemId = `download:${artifact.path}`;
    // Deduplicate repeated links within this answer, not across the binding's
    // later tasks: each delivery must verify and register its own Artifact.
    if (emittedPaths.has(artifact.path)) continue;
    emittedPaths.add(artifact.path);
    recordItem(context.state, itemId, { artifactEmitted: true, path: artifact.path, name: artifact.name });
    context.emit("artifact", "completed", artifact, { ...source, itemId });
  }
  return cleaned || (artifacts.length ? "文件已准备好下载。" : original);
}

const SENSITIVE_FIELD = /^(?:api[-_]?key|password|passwd|private[-_]?key|secret|credential|two[-_]?factor[-_]?code|otp|authorization)$/i;

export function safeDomainValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value
      .replace(/-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/gi, "[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => safeDomainValue(entry, seen));
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) continue;
    result[key] = safeDomainValue(entry, seen);
  }
  return result;
}

export function emitUnmappedAgentEvent(context, agentName, category, eventType, source = {}) {
  const type = text(eventType) || "unknown";
  const section = text(category) || "事件";
  const agentVersion = text(source.agentVersion);
  context.emit("job_status", "completed", {
    operation: "unmapped_agent_event",
    message: `${agentName}${agentVersion ? ` ${agentVersion}` : " 当前版本"} 的${section}尚未适配前端展示：${type}`,
    eventType: type,
    category: section,
    ...(agentVersion ? { agentVersion } : {}),
  }, source);
}

export function emitAgentCompatibilityIssue(context, agentName, issue, source = {}) {
  const detail = object(issue);
  const feature = text(detail.feature) || "native_protocol";
  const agentVersion = text(detail.agentVersion || source.agentVersion);
  const message = text(detail.message)
    || `${agentName}${agentVersion ? ` ${agentVersion}` : " 当前版本"} 的 ${feature} 能力与 EasyWork 尚未完全兼容。`;
  context.emit("job_status", detail.blocking === true ? "failed" : "completed", {
    operation: "agent_compatibility_issue",
    message,
    feature,
    blocking: detail.blocking === true,
    ...(detail.eventType ? { eventType: text(detail.eventType) } : {}),
    ...(agentVersion ? { agentVersion } : {}),
  }, source);
}

export function emitAgentEffortAdjustment(context, adjustment, source = {}) {
  const detail = safeDomainValue(object(adjustment));
  context.emit("job_status", "completed", {
    ...detail,
    operation: "agent_effort_adjusted",
  }, source);
}
