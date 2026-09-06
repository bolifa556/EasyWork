// Historical timeline transport contains disclosure headings, not their bodies.
// This is a view of the journal; native events and their full text stay durable.
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const preview = (value, size = 160) => String(value || "").replace(/\s+/g, " ").slice(0, size);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));

function resultHeading(value) {
  const item = record(value);
  const title = item.title || item.name || item.filename || item.semanticKey || item.path || item.content || item.text || value;
  return { ...pick(item, ["id", "name", "filename", "title", "semanticKey", "path", "role", "skillId"]),
    timelineTitle: preview(title, 84), timelineHasDetail: Boolean(item.content || item.text || item.summary || item.value || item.description || item.instructions?.length) };
}

export function timelineDetailIds(event) {
  return Array.isArray(event?.payload?.timelineDetailIds) ? event.payload.timelineDetailIds : [];
}

export function summarizeTimelineEvent(event) {
  const original = record(event.payload);
  if (timelineDetailIds(event).length) return event;
  const payload = { ...original };
  let deferred = false;
  if (event.producer === "web-agent") {
    if (event.kind === "run.reasoning.delta") {
      payload.timelineHasText = Boolean(original.content?.trim());
      payload.timelineProtocol = /^[\s]*[\[{]/.test(original.content || "") && /handoff_submit|candidateIds|tool_calls/.test(original.content || "");
      payload.content = "";
      deferred = payload.timelineHasText;
    } else if (event.kind === "run.context.state") {
      payload.state = { timelineAvailable: true };
      deferred = true;
    } else if (event.kind === "run.context.read") {
      payload.input = {};
      payload.output = Object.fromEntries(Object.entries(record(original.output)).map(([kind, values]) =>
        [kind, Array.isArray(values) ? values.map(resultHeading) : values == null ? values : resultHeading(values)]));
      deferred = true;
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
    if (event.kind === "reasoning") summary.timelineHasText = Boolean(nested.text || nested.content);
    for (const key of ["text", "content", "output", "result", "diff", "patch", "raw", "metadata"]) if (key in summary) summary[key] = "";
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
  if (!deferred) return event;
  payload.timelineDetailIds = [event.eventId];
  return { ...event, payload };
}

export function timelineReplayView(replay, view) {
  return view === "summary" ? { ...replay, events: replay.events.map(summarizeTimelineEvent) } : replay;
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
