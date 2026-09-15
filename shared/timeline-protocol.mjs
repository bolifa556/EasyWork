// Both the history outline and the hydrated UI must classify protocol-only
// reasoning identically, or a disclosure appears/disappears after hydration.
const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const WEB_AGENT_PROTOCOL_TOOLS = new Set([
  "resource_search", "resource_read", "conversation_search", "conversation_reference_search",
  "skill_search", "handoff_rewrite_candidate", "handoff_submit",
]);
const TOOL_CALL_ENVELOPE_KEYS = new Set([
  "id", "type", "name", "parameters", "arguments", "input", "function", "tool_call_id",
]);

function serializedArguments(value) {
  if (value === undefined) return true;
  if (value && typeof value === "object" && !Array.isArray(value)) return true;
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch { return false; }
}

function webToolProtocolShape(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every(webToolProtocolShape);
  if (!value || typeof value !== "object") return false;
  const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : Array.isArray(value.toolCalls) ? value.toolCalls : null;
  if (toolCalls) {
    if (Object.keys(value).some(key => !["tool_calls", "toolCalls"].includes(key))) return false;
    return toolCalls.length > 0 && toolCalls.every(webToolProtocolShape);
  }
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every(key => key === "candidateIds")) return Array.isArray(value.candidateIds);
  if (!keys.length || keys.some(key => !TOOL_CALL_ENVELOPE_KEYS.has(key))) return false;
  const fn = record(value.function);
  if (Object.keys(fn).some(key => !["name", "arguments"].includes(key))) return false;
  if (!WEB_AGENT_PROTOCOL_TOOLS.has(String(value.name || fn.name || ""))) return false;
  return serializedArguments(value.parameters) && serializedArguments(value.arguments)
    && serializedArguments(value.input) && serializedArguments(fn.arguments);
}

export function isWorkProtocolReasoning(value) {
  const content = String(value || "").trim();
  if (!content || !["{", "["].includes(content[0])) return false;
  try { return webToolProtocolShape(JSON.parse(content)); } catch {
    // Incomplete streamed protocol must not flash before its final classification.
    return /handoff_submit|candidateIds/.test(content)
      || /^\{\s*(?:"|$)/.test(content)
      || /^\[\s*(?:\{|$)/.test(content);
  }
}
