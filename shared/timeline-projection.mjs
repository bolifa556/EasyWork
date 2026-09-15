// History carries stable headings and small readable bodies. Large detail stays
// on demand; this projection never changes the durable native journal.
import { isWorkProtocolReasoning } from "./timeline-protocol.mjs";
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const preview = (value, size = 160) => String(value || "").replace(/\s+/g, " ").slice(0, size);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
export const TIMELINE_INLINE_ITEM_BYTES = 2 * 1024;
export const TIMELINE_INLINE_PAGE_BYTES = 64 * 1024;
const encoder = new TextEncoder();

// Reject large native text before JSON serialization/UTF-8 allocation. This
// bounded precheck stops at the inline limit, even for nested payloads.
function mightFitInline(value, budget) {
  budget.remaining -= typeof value === "string" ? value.length + 2 : 2;
  if (budget.remaining < 0) return false;
  if (value && typeof value === "object") {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      budget.remaining -= key.length + 3;
      if (budget.remaining < 0 || !mightFitInline(value[key], budget)) return false;
    }
  }
  return true;
}

function inlineBudget(bytes = TIMELINE_INLINE_PAGE_BYTES) {
  return { remaining: bytes, take(value) {
    if (this.remaining <= 0 || !mightFitInline(value, { remaining: Math.min(this.remaining, TIMELINE_INLINE_ITEM_BYTES) })) return false;
    const size = encoder.encode(JSON.stringify(value)).byteLength;
    if (size > TIMELINE_INLINE_ITEM_BYTES || size > this.remaining) return false;
    this.remaining -= size;
    return true;
  } };
}

function resultHeading(value) {
  const item = record(value);
  const title = item.title || item.name || item.filename || item.semanticKey || item.path || item.content || item.text || value;
  return { ...pick(item, ["id", "name", "filename", "title", "semanticKey", "path", "role", "skillId", "referenceTitle", "sourceConversationId"]),
    timelineTitle: preview(title, 84), timelineHasDetail: Boolean(item.content || item.text || item.summary || item.value || item.description || item.instructions?.length) };
}

export function timelineDetailIds(event) {
  return Array.isArray(event?.payload?.timelineDetailIds) ? event.payload.timelineDetailIds : [];
}

export function summarizeTimelineEvent(event, budget) {
  // Also safe as Array.map's callback (its second argument is an index).
  if (!budget || typeof budget.take !== "function") budget = inlineBudget();
  const original = record(event.payload);
  if (timelineDetailIds(event).length) return event;
  const payload = { ...original };
  let deferred = false;
  if (event.producer === "web-agent") {
    if (event.kind === "run.reasoning.delta") {
      if (budget.take(original)) return event;
      payload.timelineHasText = Boolean(original.content?.trim());
      payload.timelineProtocol = isWorkProtocolReasoning(original.content);
      payload.content = "";
      deferred = payload.timelineHasText;
    } else if (event.kind === "run.context.state") {
      const state = record(original.state);
      const display = { server: pick(record(state.server), ["name", "scheduler"]), workspace: pick(record(state.workspace), ["name", "path"]), agent: pick(record(state.agent), ["name"]) };
      const inline = budget.take(display);
      payload.state = inline ? display : { timelineAvailable: true };
      deferred = !inline;
    } else if (event.kind === "run.context.read") {
      payload.input = {};
      payload.output = Object.fromEntries(Object.entries(record(original.output)).map(([kind, values]) => {
        const project = (value) => {
          const heading = resultHeading(value);
          // Conversation excerpts are title-only in this UI.
          if (kind === "conversation") { deferred = true; return heading; }
          const body = { ...heading, ...pick(record(value), ["content", "text", "summary", "value", "description", "instructions"]), timelineDetailInline: true };
          if (budget.take(body)) return body;
          deferred = true;
          return heading;
        };
        return [kind, Array.isArray(values) ? values.map(project) : values == null ? values : project(values)];
      }));
    } else if (["run.handoff.ready", "run.handoff.dispatched"].includes(event.kind)) {
      for (const key of ["userMessage", "contextBrief", "displayBrief"]) if (key in payload) payload[key] = "";
      if (Array.isArray(payload.references)) payload.references = payload.references.map((ref) => ({ ...pick(record(ref), ["kind", "name", "edited"]), timelineHasDetail: Boolean(ref.detail) }));
      delete payload.skills;
      deferred = true;
    }
    else if (/^run\.tool\./.test(event.kind)) {
      // The semantic context.read/handoff events own these disclosure rows.
      for (const key of ["input", "output", "arguments", "result"]) if (key in payload) payload[key] = {};
      deferred = true;
    }
  } else if (String(event.producer).startsWith("agent:") && !["message", "final", "approval_request", "approval_response", "input_request", "input_response"].includes(event.kind)) {
    const nested = record(original.event || original);
    const summary = { ...nested };
    if (event.kind === "reasoning") {
      if (budget.take(original)) return event;
      const text = [nested.text, nested.content, nested.command, nested.message, nested.summary, nested.output, nested.diff, record(nested.failure).message].find(value => typeof value === "string" && value);
      summary.timelineHasText = Boolean(String(text || "").replace(/<\/?think>/gi, "").trim());
    }
    for (const key of ["text", "content", "output", "result", "diff", "patch", "raw", "metadata", ...(event.kind === "reasoning" ? ["message", "summary"] : [])]) if (key in summary) summary[key] = "";
    if (nested.command) summary.command = preview(nested.command);
    if (nested.input) summary.input = Object.fromEntries(Object.entries(record(nested.input)).map(([key, value]) => [key, typeof value === "string" ? preview(value) : typeof value === "number" || typeof value === "boolean" ? value : null]));
    const fileHeading = (file) => ({ ...pick(record(file), ["path", "file", "filename", "filePath", "file_path", "kind", "type", "operation"]),
      path: file.path || file.file || file.filename || String(file.diff || file.patch || "").match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1] || "", diff: "" });
    for (const key of ["changes", "files"]) if (Array.isArray(nested[key])) summary[key] = nested[key].map(fileHeading);
    if (event.kind === "file_change" && !summary.path && (nested.diff || nested.patch)) summary.path = fileHeading(nested).path;
    if (original.source) payload.source = pick(record(original.source), ["id", "itemId", "type", "method", "requestId", "sessionId", "turnId"]);
    if (original.event) payload.event = summary;
    else Object.assign(payload, summary);
    deferred = true;
  }
  if (deferred) payload.timelineDetailIds = [event.eventId];
  if (Object.keys(payload).length === Object.keys(original).length && Object.keys(payload).every(key => payload[key] === original[key])) return event;
  return { ...event, payload };
}

export function summarizeTimelinePage(events, cache = new WeakMap()) {
  let remaining = TIMELINE_INLINE_PAGE_BYTES;
  return events.map(event => {
    let projection = cache.get(event);
    if (!projection) {
      const budget = inlineBudget();
      const summary = summarizeTimelineEvent(event, budget);
      const bytes = TIMELINE_INLINE_PAGE_BYTES - budget.remaining;
      projection = { summary, bytes, outline: bytes ? summarizeTimelineEvent(event, inlineBudget(0)) : summary };
      cache.set(event, projection);
    }
    if (projection.bytes > remaining) return projection.outline;
    remaining -= projection.bytes;
    return projection.summary;
  });
}

export function timelineReplayView(replay, view) {
  return view === "summary" ? { ...replay, events: summarizeTimelinePage(replay.events) } : replay;
}

function conversationBackgroundTitle(value) {
  const item = record(value);
  return String(item.referenceTitle || item.conversationTitle || item.title || "").trim();
}

function conversationBackgroundIdentity(value) {
  const item = record(value);
  return String(item.sourceConversationId || item.conversationId || item.referenceId || conversationBackgroundTitle(item)).trim();
}

// Timeline context results preserve source order. Only adjacent excerpts from
// the same conversation share a disclosure, so intervening sources remain
// visible exactly where the Web Agent read them.
export function groupBackgroundResults(results) {
  const groups = [];
  for (const [index, result] of (Array.isArray(results) ? results : []).entries()) {
    if (result?.source !== "conversation") {
      groups.push({ type: "result", id: String(result?.id || `result:${index}`), index, result });
      continue;
    }
    const title = conversationBackgroundTitle(result.value) || "引用对话";
    const identity = conversationBackgroundIdentity(result.value);
    const previous = groups.at(-1);
    if (identity && previous?.type === "conversation" && previous.identity === identity) {
      previous.results.push(result);
      continue;
    }
    groups.push({
      type: "conversation",
      id: `conversation:${String(result?.id || index)}`,
      index,
      identity: identity || `result:${String(result?.id || index)}`,
      title,
      results: [result],
    });
  }
  return groups;
}

// Intermediate assistant messages are native narrative boundaries, independent
// of language or of a provider's optional commentary phase.
export function groupAgentActivity(segments) {
  const groups = [];
  for (const segment of segments) {
    if (segment.type === "event" && segment.event.kind === "message") groups.push(segment);
    else {
      const previous = groups.at(-1);
      if (previous?.type === "thinking") previous.segments.push(segment);
      else groups.push({ type: "thinking", id: segment.id, segments: [segment] });
    }
  }
  return groups;
}
