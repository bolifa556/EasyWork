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
  const reasoning = number(usage.reasoning ?? usage.reasoning_tokens ?? usage.reasoningTokens);
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
  const path = text(source.file_path || source.filePath || source.path || result.file_path || result.filePath || result.path);
  const diff = text(result.diff || source.diff || source.patch);
  const change = {
    action: /^write$/i.test(String(name)) ? "write" : "edit",
  };
  if (path) change.path = path;
  if (diff) change.diff = diff;
  return change;
}

export function planItems(value) {
  return array(value).map((entry, index) => {
    const item = typeof entry === "string" ? { content: entry } : object(entry);
    return {
      id: idOf(item.id) || String(index + 1),
      text: text(item.content || item.text || item.title),
      status: text(item.status || "pending"),
      ...(item.priority ? { priority: String(item.priority) } : {}),
    };
  }).filter((item) => item.text);
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

export function remoteArtifactPath(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  if (!candidate || candidate.includes("\0")) return "";
  if (!candidate.startsWith("file://")) return candidate.startsWith("/") ? candidate : "";
  try {
    const url = new URL(candidate);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) return "";
    const path = decodeURIComponent(url.pathname);
    return path.startsWith("/") && !path.includes("\0") ? path : "";
  } catch {
    return "";
  }
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
