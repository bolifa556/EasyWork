"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpen, Bot, Box, Brain, Check, ChevronRight, CircleStop, Code2, Copy, Database, Download, File, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileText, FileType2, FileVideo, Gauge, GitBranch, HardDriveDownload, LoaderCircle, MessageCircle, Network, Package, Presentation, Send, ShieldCheck, Square, Terminal, Wrench, X } from "lucide-react";
import type { ArtifactSummary, RealtimeEnvelope, TaskSummary } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { MarkdownContent } from "./MarkdownContent";
import { parseRemoteArtifactLinks } from "@/shared/remote-artifact-links.mjs";
import { artifactAnswerMarkdown, artifactDisplayName, conversationArtifactCards, referencedArtifactCards } from "./artifact-presentation.mjs";
import { canPreviewFile, fileTypeLabel } from "@/shared/file-preview.mjs";
import { groupAgentActivity, groupBackgroundResults, timelineDetailIds } from "@/shared/timeline-projection.mjs";
import { TimelineDetails, TimelineDetailStatus, useTimelineDetails } from "./TimelineDetails";
import { DisclosureMotion } from "./DisclosureMotion";
import { markdownFence, markdownLabel, splitRemoteFinalPresentation } from "./conversation-copy.mjs";
import styles from "./ConversationTimeline.module.css";

type OutputSegment = { id: string; runId: string | null; content: string; target: "final" | "activity" | "handoff" | null; committed: boolean; first: RealtimeEnvelope };
type BackgroundRead = { detailIds: string[]; id: string; name: string; input: Record<string, unknown>; output: unknown };
type BackgroundResultItem = { detailIds: string[]; id: string; source: string; value: unknown };
type BackgroundDisplayItem =
  | { type: "result"; id: string; index: number; result: BackgroundResultItem }
  | { type: "conversation"; id: string; index: number; identity: string; title: string; results: BackgroundResultItem[] };
type ReasoningEntry = { detailIds: string[]; type: "reasoning"; id: string; iteration: number; text: string };
type ThoughtEntry =
  | ReasoningEntry
  | { type: "background"; id: string; reads: BackgroundRead[] }
  | { type: "state"; detailIds: string[]; id: string; state: Record<string, unknown> };
type HandoffReference = { kind: string; name: string; detail?: string; edited?: boolean };
type Handoff = { detailIds: string[]; userMessage: string; contextBrief: string; references: HandoffReference[] };
type ApprovalDecision = "approve" | "approve_session" | "reject";
type ApprovalResponder = (taskId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
type InputResponder = (taskId: string, requestId: string, answers: Record<string, string | string[]>) => Promise<void>;
type AgentQuestion = {
  id: string;
  question: string;
  header?: string;
  multiSelect?: boolean;
  allowCustom?: boolean;
  secret?: boolean;
  required?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

const AGENT_PLAN_TOOLS = new Set(["TodoWrite", "todowrite", "TaskCreate", "TaskUpdate", "update_plan"]);
const WEB_AGENT_PROTOCOL_TOOLS = new Set([
  "resource_search", "resource_read", "conversation_search", "conversation_reference_search",
  "skill_search", "handoff_rewrite_candidate", "handoff_submit",
]);
const TOOL_CALL_ENVELOPE_KEYS = new Set([
  "id", "type", "name", "parameters", "arguments", "input", "function", "tool_call_id",
]);
const TERMINAL_WEB_KINDS = new Set(["run.context.completed", "run.completed", "run.persisted", "run.failed", "run.aborted"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function payloadRecord(payload: unknown) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function orderedEvents(events: RealtimeEnvelope[]) {
  return [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
}

function latestRunEvents(events: RealtimeEnvelope[]) {
  const ordered = orderedEvents(events);
  let startedIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].kind === "run.started") startedIndex = index;
  }
  if (startedIndex < 0) return ordered;
  const runId = ordered[startedIndex].ids.runId;
  return ordered.slice(startedIndex).filter((event) => !runId || event.ids.runId === runId);
}

export function isDirectRemoteAppendTimeline(events: RealtimeEnvelope[]) {
  return latestRunEvents(events.filter((event) => event.producer === "web-agent")).some((event) => {
    if (event.kind === "run.started" && payloadRecord(event.payload).directRemoteTask === true) return true;
    return event.kind === "run.handoff.dispatched" && payloadRecord(event.payload).operation === "append";
  });
}

function serializedArguments(value: unknown) {
  if (value === undefined) return true;
  if (value && typeof value === "object" && !Array.isArray(value)) return true;
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch { return false; }
}

function webToolProtocolShape(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0 && value.every(webToolProtocolShape);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : Array.isArray(record.toolCalls) ? record.toolCalls : null;
  if (toolCalls) {
    if (Object.keys(record).some((key) => !["tool_calls", "toolCalls"].includes(key))) return false;
    return toolCalls.length > 0 && toolCalls.every(webToolProtocolShape);
  }
  const keys = Object.keys(record);
  if (keys.length > 0 && keys.every((key) => key === "candidateIds")) {
    return Array.isArray(record.candidateIds);
  }
  if (!keys.length || keys.some((key) => !TOOL_CALL_ENVELOPE_KEYS.has(key))) return false;
  const fn = payloadRecord(record.function);
  if (Object.keys(fn).some((key) => !["name", "arguments"].includes(key))) return false;
  if (!WEB_AGENT_PROTOCOL_TOOLS.has(String(record.name || fn.name || ""))) return false;
  return serializedArguments(record.parameters)
    && serializedArguments(record.arguments)
    && serializedArguments(record.input)
    && serializedArguments(fn.arguments);
}

function isWorkProtocolReasoning(value: string) {
  const content = String(value || "").trim();
  if (!content || !["{", "["].includes(content[0])) return false;
  try { return webToolProtocolShape(JSON.parse(content)); } catch {
    // Hide an incomplete streamed JSON tool object as well, so a provider that
    // writes handoff_submit into reasoning never flashes its wire format before
    // the complete iteration is classified by the backend.
    return /handoff_submit|candidateIds/.test(content)
      || /^\{\s*(?:"|$)/.test(content)
      || /^\[\s*(?:\{|$)/.test(content);
  }
}

function nestedPayload(event: RealtimeEnvelope) {
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).event && typeof (payload as Record<string, unknown>).event === "object") {
    return (payload as { event: Record<string, unknown> }).event;
  }
  return payload;
}

function textFrom(payload: unknown) {
  if (typeof payload === "string") return payload.replace(/<\/?think>/gi, "");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["text", "content", "command", "message", "summary", "output", "diff"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]).replace(/<\/?think>/gi, "");
  }
  const failure = payloadRecord(record.failure);
  if (typeof failure.message === "string" && failure.message) return failure.message;
  return "";
}

function safeJson(value: unknown, limit = 12_000) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
  } catch { return String(value ?? ""); }
}

export { splitRemoteFinalPresentation } from "./conversation-copy.mjs";

export function classifyConversationOutput(events: RealtimeEnvelope[]) {
  const runEvents = latestRunEvents(events);
  const segments = new Map<string, OutputSegment>();
  const persistedMessages = new Map<string, string>();
  for (const event of runEvents) {
    const runId = event.ids.runId;
    const messageId = event.ids.messageId;
    if (event.kind === "run.persisted" && runId && messageId) persistedMessages.set(runId, messageId);
  }
  for (const event of runEvents) {
    const payload = event.payload as { content?: unknown; segmentId?: unknown; target?: unknown } | null;
    const segmentId = typeof payload?.segmentId === "string" ? payload.segmentId : null;
    if (!segmentId || !["run.output.delta", "run.output.committed"].includes(event.kind)) continue;
    const existing = segments.get(segmentId) ?? { id: segmentId, runId: event.ids.runId ?? null, content: "", target: null, committed: false, first: event };
    if (event.kind === "run.output.delta" && typeof payload?.content === "string") {
      existing.content += payload.content;
      if (["final", "activity", "handoff"].includes(String(payload?.target))) existing.target = payload?.target as OutputSegment["target"];
    }
    if (event.kind === "run.output.committed") {
      existing.committed = true;
      if (!existing.content && typeof payload?.content === "string") existing.content = payload.content;
      if (["final", "activity", "handoff"].includes(String(payload?.target))) existing.target = payload?.target as OutputSegment["target"];
    }
    segments.set(segmentId, existing);
  }
  const ordered = [...segments.values()].sort((a, b) => a.first.occurredAt.localeCompare(b.first.occurredAt) || a.first.sequence - b.first.sequence);
  const latestStartedRunId = runEvents.find((event) => event.kind === "run.started")?.ids.runId
    ?? ordered.at(-1)?.runId
    ?? null;
  const latestRunFailed = [...runEvents].reverse().find((event) => TERMINAL_WEB_KINDS.has(event.kind))?.kind === "run.failed";
  const committedFinals = ordered.filter((segment) => segment.committed && segment.content && segment.target === "final" && (!latestStartedRunId || segment.runId === latestStartedRunId));
  const recoveredFinal = latestRunFailed && !committedFinals.length
    ? ordered.filter((segment) => !segment.committed && segment.content && segment.target === "final" && (!latestStartedRunId || segment.runId === latestStartedRunId)).at(-1)
    : null;
  const liveFinal = !runEvents.some((event) => TERMINAL_WEB_KINDS.has(event.kind))
    ? ordered.filter((segment) => !segment.committed && segment.content && segment.target === "final" && (!latestStartedRunId || segment.runId === latestStartedRunId)).at(-1)
    : null;
  const finalSegments = liveFinal ? [...committedFinals, liveFinal] : recoveredFinal ? [recoveredFinal] : committedFinals;
  const latestFinal = finalSegments.at(-1);
  const streamingSegments = latestFinal
    ? finalSegments.filter((segment) => segment.runId === latestFinal.runId)
    : [];
  return {
    activity: ordered.filter((segment) => segment.target === "activity" && segment.content).map((segment) => ({
      ...segment.first,
      eventId: `activity:${segment.id}`,
      kind: "message",
      status: "completed",
      payload: { text: segment.content, source: "web-agent" },
    } satisfies RealtimeEnvelope)),
    streamingFinal: streamingSegments.map((segment) => segment.content).join(""),
    streamingKey: streamingSegments.map((segment) => segment.id).join(":"),
    streamingMessageId: latestFinal?.runId ? persistedMessages.get(latestFinal.runId) ?? null : null,
  };
}

function sourceLabel(source: string) {
  return ({ memory: "记忆", resources: "文件", conversation: "对话", skills: "Skill", project: "项目", server: "服务器", workspace: "工作区", agent: "Agent" } as Record<string, string>)[source] || source;
}

function compactText(value: unknown, limit = 96) {
  const text = textFrom(value).replace(/\s+/g, " ").trim();
  return text ? `${text.slice(0, limit)}${text.length > limit ? "…" : ""}` : "";
}

function backgroundItems(output: unknown) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [] as Array<{ id: string; source: string; value: unknown }>;
  const values: Array<{ id: string; source: string; value: unknown }> = [];
  for (const [source, raw] of Object.entries(output as Record<string, unknown>)) {
    const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    items.forEach((value, index) => values.push({ id: `${source}:${index}`, source, value }));
  }
  return values;
}

function resultTitle(source: string, value: unknown, index: number) {
  const record = payloadRecord(value);
  if (record.timelineTitle) return String(record.timelineTitle);
  const directText = compactText(value, 84);
  if (source === "conversation") {
    const role = record.role === "user" ? "提问" : record.role === "assistant" ? "回答" : "消息";
    return compactText(record.content || record.text || record.title, 84) || directText || `${role} ${index + 1}`;
  }
  if (source === "memory") {
    return compactText(record.title || record.semanticKey, 84) || `记忆 ${index + 1}`;
  }
  if (source === "skills") {
    const name = String(record.name || record.skillId || "").trim();
    return name || directText || `Skill ${index + 1}`;
  }
  for (const key of ["filename", "name", "title", "semanticKey", "path"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  return directText || `结果 ${index + 1}`;
}

function semanticResultText(source: string, value: unknown) {
  const record = payloadRecord(value);
  const keys = source === "resources"
    ? ["text", "content", "summary"]
    : source === "memory"
      ? ["content", "text", "summary", "value"]
      : source === "conversation"
        ? ["content", "text", "summary"]
        : [];
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]).trim();
  }
  if (source === "skills") {
    return [record.description, ...(Array.isArray(record.instructions) ? record.instructions : [])]
      .filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
      .map((entry) => entry.trim())
      .join("\n\n");
  }
  return "";
}

function handoffSkillKey(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase();
}

function mergeHandoffSkillDetails(target: Map<string, string>, output: unknown) {
  const record = payloadRecord(output);
  const values = Array.isArray(output) ? output : Array.isArray(record.skills) ? record.skills : [];
  for (const value of values) {
    const skill = payloadRecord(value);
    const name = String(skill.name || skill.displayName || "").trim();
    const detail = semanticResultText("skills", skill);
    const key = handoffSkillKey(name);
    if (!key || !detail) continue;
    const current = target.get(key) || "";
    if (detail.length > current.length) target.set(key, detail);
  }
}

function handoffReferences(output: unknown, skillDetails: ReadonlyMap<string, string> = new Map()): HandoffReference[] {
  if (!Array.isArray(output)) return [];
  const seen = new Set<string>();
  return output.flatMap((value) => {
    const record = payloadRecord(value);
    const kind = String(record.kind || "").trim();
    const name = String(record.name || "").trim();
    const key = `${kind}\0${name}`;
    if (!kind || !name || seen.has(key)) return [];
    seen.add(key);
    const eventDetail = String(record.detail || "").trim();
    const skillDetail = kind.toLocaleLowerCase() === "skill" ? skillDetails.get(handoffSkillKey(name)) || "" : "";
    const detail = skillDetail.length > eventDetail.length ? skillDetail : eventDetail;
    return [{ kind, name, ...(detail ? { detail } : {}), ...(record.edited === true ? { edited: true } : {}) }];
  });
}

function BackgroundResult({ result, index }: { result: BackgroundResultItem; index: number }) {
  const [open, setOpen] = useState(false);
  const state = useTimelineDetails(result.detailIds, open);
  const semanticText = semanticResultText(result.source, result.value);
  const expandable = Boolean(semanticText || payloadRecord(result.value).timelineHasDetail);
  const title = resultTitle(result.source, result.value, index);
  return <div className={`${styles.backgroundResult} ${open ? styles.backgroundResultOpen : ""}`}>
    {expandable ? <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <small>{sourceLabel(result.source)}</small><span>{title}</span><ChevronRight size={12} />
    </button> : <div className={styles.backgroundResultStatic}><small>{sourceLabel(result.source)}</small><span>{title}</span></div>}
    <DisclosureMotion open={open} ready={state.ready} className={styles.backgroundResultMotion}><div><div className={styles.backgroundResultDetail}>
      <TimelineDetailStatus state={state} />{!state.loading ? <MarkdownContent content={semanticText} compact activity /> : null}
    </div></div></DisclosureMotion>
  </div>;
}

function BackgroundConversation({ group }: { group: Extract<BackgroundDisplayItem, { type: "conversation" }> }) {
  return <div className={styles.backgroundResult}>
    <div className={styles.backgroundResultStatic}><small>对话</small><span>{group.title}</span></div>
  </div>;
}

function BackgroundTrace({ reads }: { reads: BackgroundRead[] }) {
  const [open, setOpen] = useState(false);
  const results: BackgroundResultItem[] = reads.flatMap((item) => backgroundItems(item.output).map((result) => ({
    ...result, id: `${item.id}:${result.id}`, detailIds: item.detailIds,
  })));
  const displayItems = groupBackgroundResults(results) as BackgroundDisplayItem[];
  if (!results.length) return null;
  return <div className={`${styles.backgroundTrace} ${open ? styles.backgroundTraceOpen : ""}`}>
    <button className={styles.backgroundHeading} type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span data-ui-icon="" className={styles.backgroundGlyph}><BookOpen size={15} /></span>
      <span className={styles.backgroundLabel}>已查阅背景</span><ChevronRight className={styles.backgroundChevron} size={13} />
    </button>
    <DisclosureMotion open={open} className={styles.backgroundMotion}><div>{displayItems.map((item) => item.type === "conversation"
      ? <BackgroundConversation key={item.id} group={item} />
      : <BackgroundResult key={item.id} result={item.result} index={item.index} />)}</div></DisclosureMotion>
  </div>;
}

function CurrentStateTrace({ state, detailIds }: { state: Record<string, unknown>; detailIds: string[] }) {
  const [open, setOpen] = useState(false);
  const detailState = useTimelineDetails(detailIds, open);
  const server = payloadRecord(state.server);
  const workspace = payloadRecord(state.workspace);
  const agent = payloadRecord(state.agent);
  const schedulerLabels: Record<string, string> = { slurm: "Slurm", pbs: "PBS", generic: "通用调度器" };
  const serverName = String(server.name || "").trim();
  const schedulerType = String(server.scheduler || "").trim().toLowerCase();
  const scheduler = ["none", "unknown"].includes(schedulerType)
    ? ""
    : schedulerLabels[schedulerType] || String(server.scheduler || "").trim();
  const values = [
    { key: "server", label: "服务器", value: [serverName, scheduler].filter(Boolean).join(" · ") },
    { key: "workspace", label: "工作区", value: String(workspace.name || workspace.path || "").trim() },
    { key: "agent", label: "Agent", value: String(agent.name || "").trim() },
  ].filter((entry) => entry.value);
  if (!values.length && !detailIds.length) return null;
  return <div className={`${styles.backgroundTrace} ${open ? styles.backgroundTraceOpen : ""}`}>
    <button className={styles.backgroundHeading} type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span data-ui-icon="" className={styles.backgroundGlyph}><Network size={15} /></span>
      <span className={styles.backgroundLabel}>已查阅当前状态</span>
      <ChevronRight className={styles.backgroundChevron} size={13} />
    </button>
    <DisclosureMotion open={open} ready={detailState.ready} className={styles.backgroundMotion}><div>
      <TimelineDetailStatus state={detailState} />
      {values.map((entry) => <div className={styles.backgroundResult} key={entry.key}><div className={styles.backgroundResultStatic}><small>{entry.label}</small><span>{entry.value}</span></div></div>)}
    </div></DisclosureMotion>
  </div>;
}

function buildWebTrace(events: RealtimeEnvelope[]) {
  const webEvents = latestRunEvents(events.filter((event) => event.producer === "web-agent"));
  const latestStarted = webEvents.find((event) => event.kind === "run.started");
  const workMode = payloadRecord(latestStarted?.payload).mode === "work";
  const discardedReasoningIterations = new Set<number>();
  const selectedSkillDetails = new Map<string, string>();
  for (const event of webEvents) {
    const payload = payloadRecord(event.payload);
    if (event.kind === "run.context.read") mergeHandoffSkillDetails(selectedSkillDetails, payload.output);
    if (event.kind === "run.handoff.ready") {
      mergeHandoffSkillDetails(selectedSkillDetails, payload.skills);
      const discarded = payload.discardedReasoningIterations;
      if (!Array.isArray(discarded)) continue;
      for (const value of discarded) {
        const iteration = Number(value);
        if (Number.isSafeInteger(iteration) && iteration >= 0) discardedReasoningIterations.add(iteration);
      }
    }
  }
  const handoffIndex = webEvents.findIndex((event) => event.kind === "run.handoff.ready");
  let terminalWorkContentEventId = "";
  if (workMode && handoffIndex >= 0) {
    for (let index = handoffIndex - 1; index >= 0; index -= 1) {
      if (webEvents[index].kind !== "run.reasoning.delta") continue;
      if (payloadRecord(webEvents[index].payload).source === "content") terminalWorkContentEventId = webEvents[index].eventId;
      break;
    }
  }
  const output = classifyConversationOutput(webEvents);
  const activities = new Map(output.activity.map((event) => [event.eventId.replace(/^activity:/, ""), event]));
  const entries: ThoughtEntry[] = [];
  const emittedSegments = new Set<string>();
  const reasoningStreams = new Map<string, string>();
  const visibleReasoningStreams = new Map<string, string>();
  let handoff: Handoff | null = null;
  for (const event of webEvents) {
    const payload = payloadRecord(event.payload);
    if (event.kind === "run.context.state") {
      const state = payloadRecord(payload.state);
      if (Object.keys(state).length) entries.push({ type: "state", detailIds: timelineDetailIds(event), id: `state:${event.eventId}`, state });
      continue;
    }
    if (event.kind === "run.reasoning.delta") {
      // Compatibility for runs persisted before Work terminal content stopped
      // being exposed: the unused model answer immediately before handoff is
      // not part of context collection.
      if (event.eventId === terminalWorkContentEventId) continue;
      const iteration = Number(payload.iteration || 0);
      if (discardedReasoningIterations.has(iteration)) continue;
      const content = String(payload.content || "");
      const streamKey = String(payload.realtimeStreamKey || event.eventId);
      const previousStream = reasoningStreams.get(streamKey) || "";
      const nextStream = content.startsWith(previousStream) ? content : `${previousStream}${content}`;
      reasoningStreams.set(streamKey, nextStream);
      if (workMode && isWorkProtocolReasoning(nextStream)) continue;
      const previousVisibleStream = visibleReasoningStreams.get(streamKey) || "";
      const addition = nextStream.startsWith(previousVisibleStream) ? nextStream.slice(previousVisibleStream.length) : nextStream;
      visibleReasoningStreams.set(streamKey, nextStream);
      if (payload.timelineProtocol === true || (!addition && !payload.timelineHasText)) continue;
      const previous = entries.at(-1);
      if (previous?.type !== "reasoning") {
        const reasoning: ReasoningEntry = {
          type: "reasoning",
          detailIds: timelineDetailIds(event),
          id: `reasoning:${latestStarted?.ids.runId || "web"}:${iteration}:${streamKey}`,
          iteration,
          text: addition,
        };
        entries.push(reasoning);
      }
      else {
        const separator = previous.text && !previous.text.endsWith("\n") && !addition.startsWith("\n") ? "\n\n" : "";
        previous.text += `${separator}${addition}`;
        previous.detailIds.push(...timelineDetailIds(event));
      }
      continue;
    }
    if (event.kind === "run.output.delta") {
      const segmentId = String(payload.segmentId || "");
      const replacement = activities.get(segmentId);
      if (replacement && !emittedSegments.has(segmentId)) {
        emittedSegments.add(segmentId);
        entries.push({
          type: "reasoning",
          detailIds: timelineDetailIds(replacement),
          id: `reasoning:${replacement.eventId}`,
          iteration: Number(payload.iteration || 0),
          text: textFrom(replacement.payload),
        });
      }
      continue;
    }
    if (event.kind === "run.handoff.ready") {
      const rawContextBrief = String(payload.contextBrief || "").trim();
      const references = handoffReferences(payload.references, selectedSkillDetails);
      const nonSkillReferences = references.filter((reference) => reference.kind.toLocaleLowerCase() !== "skill");
      // Runs persisted before reference details were part of the event still
      // have the exact selected semantic text in contextBrief. It can be
      // attributed safely only when there is one non-Skill reference.
      if (rawContextBrief && nonSkillReferences.length === 1 && !nonSkillReferences[0].detail) {
        nonSkillReferences[0].detail = rawContextBrief;
      }
      handoff = {
        detailIds: timelineDetailIds(event),
        userMessage: String(payload.userMessage || "").trim(),
        contextBrief: String(payload.displayBrief || "").trim(),
        references,
      };
      continue;
    }
    if (event.kind === "run.handoff.dispatched") {
      if (handoff) handoff.detailIds.push(...timelineDetailIds(event));
      if (handoff && ["append", "resume"].includes(String(payload.operation || ""))) {
        handoff = { ...handoff, contextBrief: "", references: [] };
      }
      else if (handoff && Array.isArray(payload.references)) {
        const deliveredReferences = handoffReferences(payload.references, selectedSkillDetails);
        handoff = {
          ...handoff,
          contextBrief: payload.contextIncluded === false ? "" : handoff.contextBrief,
          references: deliveredReferences,
        };
      }
      else if (handoff && payload.contextIncluded === false) {
        // `contextIncluded` describes ordinary prompt context only. Skills are
        // installed into the new native Agent conversation through its
        // isolated Skill view, so they remain part of this handoff even when
        // no semantic context paragraph was appended to the prompt.
        handoff = {
          ...handoff,
          contextBrief: "",
          references: handoff.references.filter((reference) => reference.kind.toLocaleLowerCase() === "skill"),
        };
      }
      continue;
    }
    if (event.kind !== "run.context.read") continue;
    if (payload.name === "context_get_state") continue;
    const read: BackgroundRead = {
      detailIds: timelineDetailIds(event),
      id: String(payload.callId || event.eventId),
      name: String(payload.name || ""),
      input: payloadRecord(payload.input),
      output: payload.output,
    };
    if (!backgroundItems(read.output).length) continue;
    const previous = entries.at(-1);
    if (previous?.type === "background") previous.reads.push(read);
    else entries.push({ type: "background", id: `background:${read.id}`, reads: [read] });
  }
  const started = latestStarted ?? webEvents.find((event) => event.kind === "run.started");
  const formalTerminal = [...webEvents].reverse().find((event) => TERMINAL_WEB_KINDS.has(event.kind));
  const persisted = [...webEvents].reverse().find((event) => event.kind === "run.persisted");
  // Work persistence follows the remote Task and can occur minutes after the
  // webpage Agent has finished deciding what to hand off. Keep the thinking
  // duration bounded by that handoff rather than by remote execution time.
  const handoffTerminal = handoff
    ? [...webEvents].reverse().find((event) => ["run.context.completed", "run.handoff.ready"].includes(event.kind))
    : null;
  const terminal = handoffTerminal ?? persisted ?? formalTerminal;
  const running = Boolean(started && !terminal);
  const elapsedMs = started && terminal ? Math.max(0, Date.parse(terminal.occurredAt) - Date.parse(started.occurredAt)) : 0;
  const visibleEntries = entries.filter((entry) => (
    entry.type === "background"
    || entry.type === "state"
    || (entry.type === "reasoning" && entry.detailIds.length > 0)
    || entry.text.trim().length > 0
  ));
  const rawAbortReason = formalTerminal?.kind === "run.aborted"
    ? String(payloadRecord(formalTerminal.payload).reason || "请求已停止")
    : "";
  return {
    runId: String(latestStarted?.ids.runId || "web"),
    conversationId: String(latestStarted?.ids.conversationId || "unknown"),
    entries: visibleEntries,
    handoff,
    started: Boolean(started),
    running,
    elapsedMs,
    aborted: !persisted && formalTerminal?.kind === "run.aborted",
    abortReason: rawAbortReason.trim() === "请求已停止" ? "" : rawAbortReason,
    failure: !handoff && formalTerminal?.kind === "run.failed" ? String(payloadRecord(formalTerminal.payload).message || "请求失败") : "",
  };
}

function ReasoningTrace({ entry, running, disclosureId }: { entry: ReasoningEntry; running: boolean; disclosureId: string }) {
  const [open, toggleOpen] = useTimelineDisclosure(disclosureId, running, true);
  const detailState = useTimelineDetails(entry.detailIds, open);
  const content = entry.text.replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
  return <section className={`${styles.reasoningTrace} ${open ? styles.reasoningTraceOpen : ""}`}>
    <button type="button" className={styles.reasoningHeading} aria-expanded={open} onClick={toggleOpen}>
      <span data-ui-icon="" className={styles.reasoningGlyph}><MessageCircle size={15} /></span>
      <span className={styles.reasoningLabel}>思考内容</span>
      <ChevronRight className={styles.reasoningChevron} size={13} />
    </button>
    <DisclosureMotion open={open} ready={detailState.ready} className={styles.reasoningMotion}><div><div className={styles.reasoningText}><TimelineDetailStatus state={detailState} />{!detailState.loading ? <MarkdownContent content={content} compact activity /> : null}</div></div></DisclosureMotion>
  </section>;
}

function WebThought({ events, handoff = null }: { events: RealtimeEnvelope[]; handoff?: Handoff | null }) {
  const trace = useMemo(() => buildWebTrace(events), [events]);
  const terminalReason = trace.failure || trace.abortReason;
  const hasBody = trace.entries.length > 0 || Boolean(handoff);
  const disclosureId = `web:${trace.conversationId}:${trace.runId}`;
  const [open, toggleOpen] = useTimelineDisclosure(disclosureId, trace.running, hasBody);
  if (!trace.started && !terminalReason) return null;
  const label = trace.running ? "正在思考" : trace.failure ? "处理失败" : trace.aborted ? "思考已停止" : "思考完成";
  return <section className={`${styles.webThought} ${open ? styles.webThoughtOpen : ""} ${trace.running ? styles.webThoughtRunning : ""}`}>
    <button type="button" className={styles.webThoughtHeading} disabled={!hasBody} aria-expanded={hasBody ? open : undefined} onClick={() => hasBody && toggleOpen()}>
      <span data-ui-icon="" className={styles.webThoughtGlyph}>{trace.running ? <LoaderCircle size={17} /> : trace.failure ? <X size={17} /> : trace.aborted ? <Square size={17} /> : <Brain size={17} />}</span>
      <span className={styles.activityHeadingLabel}>{label}</span>
      {hasBody ? <ChevronRight className={styles.webThoughtChevron} size={13} /> : null}
    </button>
    <DisclosureMotion open={hasBody && open} className={styles.webThoughtMotion}><div><div className={styles.webThoughtBody}>
      {trace.entries.map((entry) => entry.type === "reasoning"
        ? <ReasoningTrace key={entry.id} entry={entry} running={trace.running} disclosureId={`${disclosureId}:reasoning:${entry.id}`} />
        : entry.type === "background"
          ? <BackgroundTrace key={entry.id} reads={entry.reads} />
          : <CurrentStateTrace key={entry.id} state={entry.state} detailIds={entry.detailIds} />)}
      {handoff ? <WorkHandoff handoff={handoff} /> : null}
    </div></div></DisclosureMotion>
    {terminalReason ? <div className={styles.runFailure} role="alert">{terminalReason}</div> : null}
  </section>;
}

function WorkHandoff({ handoff }: { handoff: Handoff }) {
  const [open, setOpen] = useState(false);
  const detailState = useTimelineDetails(handoff.detailIds, open);
  const referenceGroups = useMemo(() => {
    const groups = new Map<string, HandoffReference[]>();
    for (const reference of handoff.references) groups.set(reference.kind, [...(groups.get(reference.kind) || []), reference]);
    return [...groups.entries()].map(([kind, references]) => ({ kind, references }));
  }, [handoff.references]);
  if (!handoff.detailIds.length && !handoff.userMessage && !handoff.contextBrief && !handoff.references.length) return null;
  return <section className={`${styles.handoff} ${open ? styles.handoffOpen : ""}`}>
    <button type="button" className={styles.handoffHeading} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span data-ui-icon="" className={styles.handoffGlyph}><Send size={15} /></span><span className={styles.handoffLabel}>发给远端 Agent</span><ChevronRight className={styles.handoffChevron} size={13} />
    </button>
    <DisclosureMotion open={open} ready={detailState.ready} className={styles.handoffMotion}><div><div className={styles.handoffRail}><div className={styles.handoffBody}>
      <TimelineDetailStatus state={detailState} />
      {handoff.userMessage ? <p>{handoff.userMessage}</p> : null}
      {handoff.contextBrief ? <p>{handoff.contextBrief}</p> : null}
      {referenceGroups.map((group) => <HandoffReferenceGroup key={group.kind} kind={group.kind} references={group.references} />)}
    </div></div></div></DisclosureMotion>
  </section>;
}

function HandoffReferenceGroup({ kind, references }: { kind: string; references: HandoffReference[] }) {
  const [open, setOpen] = useState(false);
  if (kind.toLocaleLowerCase() === "skill") return <>{references.map((reference) => <HandoffDetailReference key={`${reference.kind}:${reference.name}`} reference={reference} />)}</>;
  if (references.length === 1) return <HandoffDetailReference reference={references[0]} />;
  return <section className={`${styles.handoffReferenceGroup} ${open ? styles.handoffReferenceGroupOpen : ""}`}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span>{kind}</span><strong>{references.length} 项</strong><ChevronRight size={13} />
    </button>
    <DisclosureMotion open={open} className={styles.handoffReferenceMotion}><div>{references.map((reference) => <HandoffDetailReference key={`${reference.kind}:${reference.name}`} reference={{ ...reference, kind: "" }} />)}</div></DisclosureMotion>
  </section>;
}

function HandoffDetailReference({ reference }: { reference: HandoffReference }) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(reference.detail?.trim());
  return <section className={`${styles.handoffSkillReference} ${open ? styles.handoffSkillReferenceOpen : ""}`}>
    {expandable ? <button type="button" className={styles.handoffSkillHeading} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={styles.handoffReferenceKind}>{reference.kind}</span><strong>{reference.name}</strong>{reference.edited ? <em className={styles.handoffEdited}>本轮整理</em> : null}<ChevronRight size={13} />
    </button> : <div className={styles.handoffReference}>
      <span className={styles.handoffReferenceKind}>{reference.kind}</span><strong>{reference.name}</strong>{reference.edited ? <em className={styles.handoffEdited}>本轮整理</em> : null}
    </div>}
    <DisclosureMotion open={expandable && open} className={styles.handoffSkillMotion}><div><div className={styles.handoffSkillDetail}><MarkdownContent content={reference.detail!} compact activity /></div></div></DisclosureMotion>
  </section>;
}

function isRunningEvent(event: RealtimeEnvelope) {
  return ["started", "updated", "running", "accepted", "queued"].includes(String(event.status));
}

function eventStatusLabel(status: string | null) {
  if (["started", "updated", "running", "accepted", "queued"].includes(String(status))) return "正在进行";
  if (status === "waiting") return "等待";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (["cancelled", "interrupted"].includes(String(status))) return "已取消";
  return status || "等待";
}

function operationLabel(value: unknown) {
  const operation = String(value || "").trim();
  const labels: Record<string, string> = {
    append: "追加指令",
    interrupt: "中断任务",
    resume: "继续任务",
    respondApproval: "响应审批",
    respondInput: "提交回答",
    command: "执行命令",
    imageView: "查看图片",
    imageGeneration: "生成图片",
    subtask: "子任务",
    agent: "远端 Agent",
    retry: "重试连接",
    compaction: "压缩上下文",
    unmapped_agent_event: "Agent 事件未适配",
    agent_compatibility_issue: "Agent 兼容性提示",
    agent_effort_adjusted: "思考强度已调整",
  };
  return labels[operation] || operation;
}

function eventLabel(event: RealtimeEnvelope) {
  const running = isRunningEvent(event);
  if (event.kind === "reasoning") return "Agent";
  if (event.kind === "tool_call") return running ? "正在运行命令" : "运行命令";
  if (event.kind === "tool_result") return "命令结果";
  if (event.kind === "file_change") return running ? "正在编辑文件" : "编辑文件";
  if (event.kind === "approval_request") return ["cancelled", "interrupted"].includes(String(event.status)) ? "已拒绝" : event.status === "completed" ? "已允许" : "需要确认";
  if (event.kind === "approval_response") return "已确认";
  if (event.kind === "input_request") return event.status === "waiting" ? "等待你的回答" : "用户问题";
  if (event.kind === "input_response") return "已提交回答";
  if (event.kind === "artifact") return "结果文件";
  if (event.kind === "job_status") {
    const operation = String(payloadRecord(nestedPayload(event)).operation || "");
    if (["unmapped_agent_event", "agent_compatibility_issue", "agent_effort_adjusted"].includes(operation)) return operationLabel(operation);
    return "作业状态";
  }
  if (event.kind === "ssh_status") return "SSH 连接状态";
  if (event.kind === "index_status") return "文件索引状态";
  if (event.kind === "terminal_output") return "远程终端输出";
  if (event.kind === "file_transfer") return "远程文件传输";
  if (event.kind === "error" || event.status === "failed") return "执行出错";
  if (event.kind === "command") {
    const operation = String(payloadRecord(event.payload).operation || "");
    return `${operationLabel(operation) || "任务指令"}${event.status === "completed" ? "完成" : event.status === "failed" ? "失败" : ""}`;
  }
  if (event.kind === "message") return "Agent";
  return "Agent 事件";
}

function eventIcon(event: RealtimeEnvelope) {
  if (event.status === "failed" || event.kind === "error") return <X size={13} />;
  if (["cancelled", "interrupted"].includes(String(event.status))) return <Square size={9} />;
  if (event.kind.includes("approval")) return <ShieldCheck size={14} />;
  if (event.kind.includes("input_")) return <MessageCircle size={14} />;
  if (event.kind === "file_change") return <FileText size={14} />;
  if (event.kind === "job_status") return <Gauge size={14} />;
  if (event.kind === "artifact") return <FileArchive size={14} />;
  if (event.kind === "reasoning") return <Brain size={14} />;
  if (event.kind === "connection" || event.kind === "ssh_status") return <Network size={14} />;
  if (event.kind === "workspace_scope") return <GitBranch size={14} />;
  if (event.kind === "index_status") return <HardDriveDownload size={14} />;
  if (event.kind === "terminal_output") return <Terminal size={14} />;
  if (event.kind === "file_transfer") return <Download size={14} />;
  if (event.kind === "message") return <MessageCircle size={14} />;
  return <Check size={13} />;
}

function callIdFrom(event: RealtimeEnvelope) {
  const record = payloadRecord(nestedPayload(event));
  return typeof record.callId === "string" ? record.callId : "";
}

function sourceItemId(event: RealtimeEnvelope) {
  const source = payloadRecord(payloadRecord(event.payload).source);
  return String(source.itemId || source.id || "");
}

function mergedNestedPayload(previous: RealtimeEnvelope, current: RealtimeEnvelope, extra: Record<string, unknown> = {}) {
  const previousOuter = payloadRecord(previous.payload);
  const currentOuter = payloadRecord(current.payload);
  return {
    ...previousOuter,
    ...currentOuter,
    timelineDetailIds: [...new Set([...timelineDetailIds(previous), ...timelineDetailIds(current)])],
    event: {
      ...payloadRecord(nestedPayload(previous)),
      ...payloadRecord(nestedPayload(current)),
      ...extra,
    },
  };
}

function coalesceRemoteEvents(events: RealtimeEnvelope[]) {
  const retractedMessageIds = new Set(events.flatMap((event) => {
    const record = payloadRecord(nestedPayload(event));
    return event.kind === "job_status" && record.operation === "message_retracted" && Array.isArray(record.retractedMessageIds)
      ? record.retractedMessageIds.map(String)
      : [];
  }));
  const result: RealtimeEnvelope[] = [];
  const callIndexes = new Map<string, number>();
  const activityIndexesByItem = new Map<string, number>();
  const approvalIndexes = new Map<string, number>();
  const embeddedApprovalIds = new Set<string>();
  const inputIndexes = new Map<string, number>();
  const textIndexes = new Map<string, number>();
  for (const event of events) {
    const itemId = sourceItemId(event);
    if (event.kind !== "job_status" && [...retractedMessageIds].some((id) => itemId === id || itemId.startsWith(`${id}:`))) continue;
    if (event.kind === "command") {
      const payload = payloadRecord(event.payload);
      const commandId = String(payload.commandId || "");
      const commandKey = commandId ? `command:${commandId}` : "";
      if (commandKey && callIndexes.has(commandKey)) {
        const index = callIndexes.get(commandKey)!;
        const previous = result[index];
        result[index] = {
          ...previous,
          ...event,
          eventId: previous.eventId,
          occurredAt: previous.occurredAt,
          payload: { ...payloadRecord(previous.payload), ...payload },
        };
      } else {
        if (commandKey) callIndexes.set(commandKey, result.length);
        result.push(event);
      }
      continue;
    }
    const callId = callIdFrom(event);
    if (event.kind === "tool_call") {
      const eventPayload = payloadRecord(nestedPayload(event));
      // Claude Code 2.1.245 persisted progress ticks as synthetic tool IDs
      // before the adapter learned to correlate them with their parent call.
      // They never represented independent operations, so hide only those
      // legacy rows while retaining current heartbeats on the real call ID.
      if (eventPayload.heartbeat === true && /-heartbeat-\d+$/u.test(callId)) continue;
      let toolIndex: number;
      if (callId && callIndexes.has(callId)) {
        const index = callIndexes.get(callId)!;
        const previous = result[index];
        result[index] = {
          ...previous,
          ...event,
          eventId: previous.eventId,
          occurredAt: previous.occurredAt,
          payload: mergedNestedPayload(previous, event),
        };
        toolIndex = index;
      } else {
        if (callId) callIndexes.set(callId, result.length);
        toolIndex = result.length;
        result.push(event);
      }
      const itemId = sourceItemId(event);
      if (itemId) activityIndexesByItem.set(itemId, toolIndex);
      continue;
    }
    if ((event.kind === "tool_result" || event.kind === "error") && callId && callIndexes.has(callId)) {
      const index = callIndexes.get(callId)!;
      const started = result[index];
      const startedPayload = payloadRecord(nestedPayload(started));
      const finishedPayload = payloadRecord(nestedPayload(event));
      const previousResult = typeof startedPayload.result === "string" ? startedPayload.result : textFrom(startedPayload.result) || textFrom(startedPayload);
      const resultText = textFrom(finishedPayload);
      const mergedResult = finishedPayload.delta === true
        ? `${previousResult}${resultText}`
        : finishedPayload.output ?? finishedPayload.result ?? finishedPayload.text ?? finishedPayload;
      const rejected = /(?:user\s+rejected|permission\s+(?:denied|rejected)|operation\s+(?:denied|rejected))/i.test(resultText);
      const nextStatus = rejected
        ? "cancelled"
        : event.kind === "error" || event.status === "failed"
          ? "failed"
          : event.status === "updated"
            ? "updated"
            : /(?:running\s+in\s+(?:the\s+)?background|background\s+(?:process|task|command)\s+(?:is\s+)?running|后台(?:任务|进程|命令).*(?:运行|执行)中)/i.test(resultText)
              ? "updated"
            : "completed";
      result[index] = {
        ...started,
        status: nextStatus,
        payload: mergedNestedPayload(started, event, {
          result: mergedResult,
          text: typeof mergedResult === "string" ? mergedResult : textFrom(mergedResult),
          delta: false,
        }),
      };
      const embedded = payloadRecord(payloadRecord(result[index].payload).embeddedApproval) as unknown as RealtimeEnvelope;
      if (embedded?.eventId) {
        result[index] = {
          ...result[index],
          payload: {
            ...payloadRecord(result[index].payload),
            embeddedApproval: {
              ...embedded,
              status: rejected ? "cancelled" : "completed",
              payload: mergedNestedPayload(embedded, event, { resolved: true }),
            },
          },
        };
      }
      continue;
    }
    if (event.kind === "approval_request") {
      const record = payloadRecord(nestedPayload(event));
      const source = payloadRecord(payloadRecord(event.payload).source);
      const requestId = String(record.requestId || source.requestId || "");
      const index = result.length;
      const itemId = sourceItemId(event);
      const toolIndex = itemId ? activityIndexesByItem.get(itemId) : undefined;
      if (toolIndex !== undefined) {
        result[toolIndex] = {
          ...result[toolIndex],
          status: "waiting",
          payload: { ...payloadRecord(result[toolIndex].payload), embeddedApproval: event },
        };
        if (requestId) {
          approvalIndexes.set(requestId, toolIndex);
          embeddedApprovalIds.add(requestId);
        }
        continue;
      }
      if (requestId) approvalIndexes.set(requestId, index);
      result.push(event);
      continue;
    }
    if (event.kind === "approval_response") {
      const record = payloadRecord(nestedPayload(event));
      const source = payloadRecord(payloadRecord(event.payload).source);
      const requestId = String(record.requestId || source.requestId || "");
      const approvalIndex = requestId ? approvalIndexes.get(requestId) : undefined;
      if (approvalIndex !== undefined) {
        const previous = result[approvalIndex];
        const operationAlreadySettled = ["completed", "failed", "cancelled", "interrupted"].includes(String(previous.status));
        const decision = String(record.decision || "").toLowerCase();
        const rejected = /reject|deny|denied/.test(decision);
        if (requestId && embeddedApprovalIds.has(requestId)) {
          const embedded = payloadRecord(payloadRecord(previous.payload).embeddedApproval) as unknown as RealtimeEnvelope;
          result[approvalIndex] = {
            ...previous,
            // A native tool_result may arrive before the asynchronously
            // journaled approval acknowledgement. Resolve the button, but do
            // not reopen an operation that has already reached a terminal state.
            status: operationAlreadySettled ? previous.status : rejected ? "cancelled" : "started",
            payload: {
              ...payloadRecord(previous.payload),
              embeddedApproval: {
                ...embedded,
                status: rejected ? "cancelled" : "completed",
                payload: mergedNestedPayload(embedded, event, { decision, resolved: true }),
              },
            },
          };
        } else {
          result[approvalIndex] = {
            ...previous,
            status: rejected ? "cancelled" : "completed",
            payload: mergedNestedPayload(previous, event, { decision, resolved: true }),
          };
        }
      }
      continue;
    }
    if (event.kind === "input_request") {
      const record = payloadRecord(nestedPayload(event));
      const source = payloadRecord(payloadRecord(event.payload).source);
      const requestId = String(record.requestId || source.requestId || "");
      if (requestId) inputIndexes.set(requestId, result.length);
      result.push(event);
      continue;
    }
    if (event.kind === "input_response") {
      const record = payloadRecord(nestedPayload(event));
      const source = payloadRecord(payloadRecord(event.payload).source);
      const requestId = String(record.requestId || source.requestId || "");
      const index = requestId ? inputIndexes.get(requestId) : undefined;
      if (index !== undefined) result[index] = { ...result[index], status: event.status || "completed" };
      continue;
    }
    if (["message", "reasoning"].includes(event.kind)) {
      const payload = payloadRecord(nestedPayload(event));
      const stableSource = sourceItemId(event);
      const key = `${event.producer}:${event.kind}:${stableSource || event.eventId}`;
      const exactIndex: number | undefined = textIndexes.get(key);
      if (exactIndex !== undefined) {
        const index: number = exactIndex;
        const previous = result[index];
        const previousPayload = payloadRecord(nestedPayload(previous));
        const nextText = payload.delta ? `${textFrom(previousPayload)}${textFrom(payload)}` : textFrom(payload) || textFrom(previousPayload);
        result[index] = { ...previous, status: event.status, payload: mergedNestedPayload(previous, event, { text: nextText, delta: false }) };
        textIndexes.set(key, index);
      } else {
        textIndexes.set(key, result.length);
        result.push(event);
      }
      continue;
    }
    if (event.kind === "file_change") {
      const itemId = sourceItemId(event);
      if (itemId) activityIndexesByItem.set(itemId, result.length);
    }
    result.push(event);
  }
  return result;
}

type RawFileEntry = { path: string; diff: string; output: string; delta: boolean };

function pathFromDiff(diff: string) {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const target = lines.find((line) => line.startsWith("+++ "))?.slice(4).trim() || "";
  if (target && target !== "/dev/null") {
    const unquoted = target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target;
    return unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
  }
  const header = lines.find((line) => line.startsWith("diff --git ")) || "";
  const marker = header.lastIndexOf(" b/");
  if (marker >= 0) return header.slice(marker + 3).replace(/^"|"$/g, "");
  const quotedMarker = header.lastIndexOf(' "b/');
  return quotedMarker >= 0 ? header.slice(quotedMarker + 4).replace(/"$/, "") : "";
}

function fileEntries(record: Record<string, unknown>): RawFileEntry[] {
  const entry = (value: Record<string, unknown>) => {
    const diff = String(value.diff || value.patch || value.content || "");
    return {
      path: String(value.path || value.file || value.filename || pathFromDiff(diff)),
      diff,
      output: String(value.output || value.text || ""),
      delta: value.delta === true || record.delta === true,
    };
  };
  if (Array.isArray(record.files)) return (record.files as Array<Record<string, unknown>>).map(entry);
  if (Array.isArray(record.changes)) return (record.changes as Array<Record<string, unknown>>).map(entry);
  if (record.path || record.diff || record.patch) return [entry(record)];
  return [];
}

function CopyButton({ content, label }: { content: string; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!content.trim()) return null;
  return <button className={`${styles.blockCopyButton} ${copied ? styles.copied : ""}`} type="button" aria-label={copied ? "已复制" : label} onClick={(event) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    });
  }}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>;
}

function conciseToolValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(conciseToolValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") return safeJson(value, 320).replace(/\s+/g, " ");
  return value == null ? "" : String(value);
}

function toolParts(event: RealtimeEnvelope, includeDetails = true) {
  const record = payloadRecord(nestedPayload(event));
  const input = payloadRecord(record.input);
  const name = String(record.name || "tool");
  const normalizedName = name.toLowerCase().replace(/[.\s-]+/g, "_");
  const shell = /^(?:bash|shell|command|command_execution|execute|execute_command|run_command|terminal)$/.test(normalizedName)
    || Boolean(input.command || record.command);
  const search = /(?:^|_)(?:grep|search|search_text|ripgrep)(?:_|$)/.test(normalizedName);
  const discover = /(?:^|_)(?:glob|find|find_files|list|list_files)(?:_|$)/.test(normalizedName);
  const command = String(input.command || record.command || "");
  const primary = conciseToolValue(input.pattern || input.query || input.search || input.glob || input.path || input.directory);
  const location = conciseToolValue(input.path || input.directory || input.cwd);
  const summary = shell
    ? command || name
    : [name, primary, location && location !== primary ? location : ""].filter(Boolean).join(" · ");
  const label = shell ? "运行命令" : search ? "搜索内容" : discover ? "查找文件" : "调用工具";
  if (!includeDetails) return { label, summary, output: "", detail: "", shell };
  const output = typeof record.result === "string" ? record.result : textFrom(record.result) || String(record.text || record.output || "");
  const inputText = Object.keys(input).length ? safeJson(input) : "";
  const detail = shell
    ? `$ ${command || name}${output ? `\n${output}` : ""}`
    : [inputText, output].filter(Boolean).join("\n\n");
  return { label, summary, output, detail, shell };
}

function EmbeddedApproval({ event, taskId, taskStatus, onApproval }: { event: RealtimeEnvelope; taskId?: string; taskStatus?: string; onApproval?: ApprovalResponder }) {
  const embedded = payloadRecord(payloadRecord(event.payload).embeddedApproval) as unknown as RealtimeEnvelope;
  const record = payloadRecord(nestedPayload(embedded));
  const source = payloadRecord(payloadRecord(embedded?.payload).source);
  const requestId = String(record.requestId || source.requestId || "");
  const [responding, setResponding] = useState<ApprovalDecision | null>(null);
  const [submitted, setSubmitted] = useState<{ requestId: string; decision: ApprovalDecision } | null>(null);
  const [error, setError] = useState("");
  if (!embedded?.eventId) return null;
  const submittedDecision = submitted?.requestId === requestId ? submitted.decision : null;
  // The approval request event is immutable history and can remain `waiting`
  // for a short time after the native response has been accepted.  The Task
  // status is the authoritative live gate: once it leaves waiting_approval,
  // keeping these buttons clickable invites a duplicate response to the same
  // native request.
  const pending = embedded.status === "waiting"
    && (!taskStatus || taskStatus === "waiting_approval")
    && !submittedDecision
    && Boolean(taskId && requestId && onApproval);
  // The task moves back to `running` as soon as EasyWork accepts the click,
  // while the native approval_response can arrive a moment later.  During
  // that gap the immutable request is still `waiting`; calling it "allowed"
  // is observably wrong for a rejection.  Keep the card neutral until the
  // native response resolves it to completed/cancelled.
  const resolutionLabel = pending
    ? "需要确认"
    : embedded.status === "cancelled"
      ? "已拒绝"
      : embedded.status === "completed"
        ? "已允许"
        : "处理中";
  const respond = async (decision: ApprovalDecision) => {
    if (!pending || !taskId || !onApproval || responding || submittedDecision) return;
    setSubmitted({ requestId, decision });
    setResponding(decision);
    setError("");
    try { await onApproval(taskId, requestId, decision); }
    catch (reason) {
      setSubmitted(null);
      setError(reason instanceof Error ? reason.message : "审批响应失败");
    }
    finally { setResponding(null); }
  };
  return <div className={`${styles.embeddedApproval} ${embedded.status === "cancelled" ? styles.embeddedApprovalRejected : ""}`}>
    <div className={styles.embeddedApprovalHeading}><ShieldCheck size={14} /><strong>{resolutionLabel}</strong><span>{approvalRequestDetail(record)}</span></div>
    {approvalRequestText(record) ? <div className={styles.embeddedApprovalDetail}><MarkdownContent content={approvalRequestText(record)} compact activity /></div> : null}
    {pending ? <div className={styles.approvalActions}>
      <button type="button" disabled={Boolean(responding)} onClick={() => void respond("approve")}>{responding === "approve" ? <LoaderCircle className={styles.spin} size={13} /> : null}允许一次</button>
      {record.allowSession !== false ? <button type="button" disabled={Boolean(responding)} onClick={() => void respond("approve_session")}>{responding === "approve_session" ? <LoaderCircle className={styles.spin} size={13} /> : null}本会话允许</button> : null}
      <button type="button" className={styles.rejectApproval} disabled={Boolean(responding)} onClick={() => void respond("reject")}>{responding === "reject" ? <LoaderCircle className={styles.spin} size={13} /> : null}拒绝</button>
    </div> : null}
    {error ? <small className={styles.approvalError}>{error}</small> : null}
  </div>;
}

function CommandItem({ event, taskId, taskStatus, onApproval }: { event: RealtimeEnvelope; taskId?: string; taskStatus?: string; onApproval?: ApprovalResponder }) {
  const [open, setOpen] = useState(event.status === "waiting");
  const detailState = useTimelineDetails(timelineDetailIds(event), open);
  const tool = useMemo(() => toolParts(event, open), [event, open]);
  const cancelled = ["cancelled", "interrupted"].includes(String(event.status));
  return <article className={`${styles.commandItem} ${open ? styles.itemOpen : ""} ${isRunningEvent(event) ? styles.running : ""} ${event.status === "failed" ? styles.error : ""} ${cancelled ? styles.cancelled : ""}`}>
    <button type="button" className={styles.commandSummary} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={styles.commandStatus}>{event.status === "failed" ? <X size={12} /> : ["cancelled", "interrupted"].includes(String(event.status)) ? <Square size={8} /> : tool.shell ? <Terminal size={12} /> : <Wrench size={12} />}</span>
      <span className={styles.operationKind}>{tool.label}</span><code>{tool.summary}</code><small>{eventStatusLabel(event.status)}</small><ChevronRight className={styles.itemChevron} size={13} />
    </button>
    <DisclosureMotion open={open} ready={detailState.ready} className={styles.itemMotion}><div><div className={styles.terminalWrap}>
      <TimelineDetailStatus state={detailState} /><CopyButton content={tool.detail} label={tool.shell ? "复制命令和输出" : "复制工具输入和结果"} />
      {!detailState.loading ? <pre className={styles.remoteTerminal}><code>{tool.detail || (isRunningEvent(event) ? "等待远端结果…" : "Agent 未返回可显示的工具结果。")}</code></pre> : null}
      <EmbeddedApproval event={event} taskId={taskId} taskStatus={taskStatus} onApproval={onApproval} />
    </div></div></DisclosureMotion>
  </article>;
}

function toolFileEntry(event: RealtimeEnvelope): FileEntry | null {
  const record = payloadRecord(nestedPayload(event));
  const input = payloadRecord(record.input);
  const name = String(record.name || "").toLowerCase().replace(/[.\s-]+/g, "_");
  if (!/^(?:read|read_file|view|view_file|view_image|edit|write|write_file|create_file|apply_patch)$/.test(name)) return null;
  const filePath = String(input.file_path || input.filePath || input.path || input.filename || record.path || "");
  if (!filePath) return null;
  const result = typeof record.result === "string" ? record.result : textFrom(record.result) || String(record.output || record.text || "");
  const operation = /^(?:edit|write|write_file|create_file|apply_patch)$/.test(name) ? "edit" : "read";
  return { id: `tool-file:${event.eventId}`, path: filePath, output: result, operation, status: event.status, event };
}

function operationEntries(events: RealtimeEnvelope[]) {
  const mergedFiles = mergedFileEntries(events.filter((event) => event.kind === "file_change"));
  const changedPaths = new Set(mergedFiles.map((file) => file.path).filter(Boolean));
  const changedSources = new Set(events.filter((event) => event.kind === "file_change").flatMap((event) => [sourceItemId(event), callIdFrom(event)]).filter(Boolean));
  const emittedFiles = new Set<string>();
  const entries: Array<{ type: "tool"; id: string; event: RealtimeEnvelope } | { type: "file"; id: string; file: FileEntry }> = [];
  for (const event of events) {
    if (event.kind === "tool_call") {
      const record = payloadRecord(nestedPayload(event));
      const input = payloadRecord(record.input);
      const name = String(record.name || "").toLowerCase();
      const path = String(input.file_path || input.filePath || input.path || record.path || "");
      const mutation = /^(?:edit|write|apply_patch|write_file|create_file)$/.test(name);
      const duplicated = mutation && (changedSources.has(sourceItemId(event)) || changedSources.has(callIdFrom(event)) || (path && changedPaths.has(path)));
      const file = toolFileEntry(event);
      if (!duplicated && file) entries.push({ type: "file", id: file.id, file });
      else if (!duplicated) entries.push({ type: "tool", id: event.eventId, event });
      continue;
    }
    for (const file of mergedFiles) {
      if (emittedFiles.has(file.id)) continue;
      const appearsHere = fileEntries(payloadRecord(nestedPayload(event))).some((raw) => raw.path ? raw.path === file.path : sourceItemId(event) === file.id);
      if (!appearsHere) continue;
      emittedFiles.add(file.id);
      entries.push({ type: "file", id: `file:${file.id}`, file });
    }
  }
  for (const file of mergedFiles) if (!emittedFiles.has(file.id)) entries.push({ type: "file", id: `file:${file.id}`, file });
  return entries;
}

function OperationGroup({ events, taskId, taskStatus, onApproval }: { events: RealtimeEnvelope[]; taskId?: string; taskStatus?: string; onApproval?: ApprovalResponder }) {
  const entries = useMemo(() => operationEntries(events), [events]);
  const waiting = events.some((event) => event.status === "waiting");
  const running = events.some(isRunningEvent);
  const failed = events.some((event) => event.status === "failed");
  const cancelled = events.every((event) => ["cancelled", "interrupted"].includes(String(event.status)));
  const [open, setOpen] = useState(waiting);
  return <section className={`${styles.activityGroup} ${open ? styles.groupOpen : ""} ${running ? styles.running : ""} ${failed ? styles.error : ""}`}>
    <button type="button" className={`${styles.groupHeading} ${styles.commandGroupHeading}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span data-ui-icon="" className={styles.groupGlyph}>{failed ? <X size={13} /> : <Wrench size={14} />}</span>
      <strong>{waiting ? `等待执行 ${entries.length} 个操作` : running ? `正在执行 ${entries.length} 个操作` : cancelled ? `已取消 ${entries.length} 个操作` : `执行了 ${entries.length} 个操作`}</strong>
      <ChevronRight className={styles.groupChevron} size={13} />
    </button>
    <DisclosureMotion open={open} className={styles.groupMotion}><div><div className={styles.commandList}>{entries.map((entry) => entry.type === "tool"
      ? <CommandItem key={entry.id} event={entry.event} taskId={taskId} taskStatus={taskStatus} onApproval={onApproval} />
      : <FileItem key={entry.id} file={entry.file} taskId={taskId} taskStatus={taskStatus} onApproval={onApproval} />)}</div></div></DisclosureMotion>
  </section>;
}

function diffTone(line: string) {
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return styles.diffMeta;
  if (line.startsWith("@@")) return styles.diffHunk;
  if (line.startsWith("+")) return styles.diffAdded;
  if (line.startsWith("-")) return styles.diffRemoved;
  return "";
}

function DiffView({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return <div className={styles.fileDiff} aria-label="文件修改差异"><CopyButton content={content} label="复制 Diff" /><span className={styles.diffCaption}><Code2 size={13} />Diff</span><div className={styles.diffLines} data-mobile-swipe-ignore>{lines.map((line, index) => <div className={`${styles.diffLine} ${diffTone(line)}`} key={`${index}:${line}`}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div></div>;
}

type FileEntry = { path?: string; diff?: string; output?: string; operation?: "read" | "edit"; status?: string | null; id: string; event: RealtimeEnvelope };

function mergedFileEntries(events: RealtimeEnvelope[]) {
  const merged = new Map<string, FileEntry>();
  for (const event of events) {
    for (const [index, file] of fileEntries(payloadRecord(nestedPayload(event))).entries()) {
      const key = file.path || sourceItemId(event) || `${event.eventId}:${index}`;
      const previous = merged.get(key);
      const nextDiff = file.delta
        ? `${previous?.diff || ""}${file.diff}`
        : previous?.diff && file.diff && previous.diff !== file.diff
          ? `${previous.diff}\n\n${file.diff}`
          : file.diff || previous?.diff;
      merged.set(key, {
        id: previous?.id || key,
        path: file.path || previous?.path,
        diff: nextDiff,
        output: file.output || previous?.output,
        operation: "edit",
        status: previous?.status === "failed" || event.status === "failed" ? "failed" : previous?.status === "updated" || isRunningEvent(event) ? "updated" : event.status,
        event: previous ? { ...event, payload: { ...payloadRecord(event.payload), timelineDetailIds: [...new Set([...timelineDetailIds(previous.event), ...timelineDetailIds(event)])] } } : event,
      });
    }
  }
  return [...merged.values()];
}

function FileItem({ file, taskId, taskStatus, onApproval }: { file: FileEntry; taskId?: string; taskStatus?: string; onApproval?: ApprovalResponder }) {
  const [open, setOpen] = useState(false);
  const detailState = useTimelineDetails(timelineDetailIds(file.event), open);
  const name = file.path?.split(/[\\/]/).filter(Boolean).at(-1) || "未命名文件";
  const running = ["started", "updated", "running"].includes(String(file.status));
  const cancelled = ["cancelled", "interrupted"].includes(String(file.status));
  const reading = file.operation === "read";
  return <article className={`${styles.fileItem} ${open ? styles.itemOpen : ""} ${running ? styles.running : ""} ${file.status === "failed" ? styles.error : ""} ${cancelled ? styles.cancelled : ""}`}>
    <button type="button" className={styles.fileSummary} aria-expanded={open} onClick={() => setOpen((value) => !value)}><span className={styles.fileStatus}>{file.status === "failed" ? <X size={12} /> : cancelled ? <Square size={8} /> : <FileText size={13} />}</span><span className={styles.operationKind}>{reading ? "读取文件" : "编辑文件"}</span><span className={styles.fileCopy}><strong>{name}</strong>{file.path ? <small>{file.path}</small> : null}</span><ChevronRight className={styles.itemChevron} size={13} /></button>
    <DisclosureMotion open={open} ready={detailState.ready} className={styles.itemMotion}><div><div className={styles.fileDetail}><TimelineDetailStatus state={detailState} />{detailState.loading ? null : file.diff ? <DiffView content={file.diff} /> : file.output ? <><CopyButton content={file.output} label={reading ? "复制文件内容" : "复制文件修改内容"} /><pre className={styles.fileRaw}>{file.output}</pre></> : <p className={styles.fileEmpty}>{reading ? "Agent 未返回可显示的文件内容。" : "Agent 未返回可显示的差异内容。"}</p>}<EmbeddedApproval event={file.event} taskId={taskId} taskStatus={taskStatus} onApproval={onApproval} /></div></div></DisclosureMotion>
  </article>;
}

function approvalValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(approvalValue).filter(Boolean).join(" ");
  return "";
}

function approvalRequestDetail(record: Record<string, unknown>) {
  const tool = approvalValue(record.tool);
  const permission = approvalValue(record.permission);
  const action = approvalValue(record.action);
  const actionLabel = action === "command_execution"
    ? "运行命令"
    : action === "file_change"
      ? "修改文件"
      : action === "can_use_tool"
        ? "使用工具"
        : "";
  const operation = tool || permission || actionLabel || "继续执行";
  return operation;
}

function approvalRequestText(record: Record<string, unknown>) {
  const input = payloadRecord(record.input);
  const details = payloadRecord(record.details);
  const metadata = payloadRecord(record.metadata);
  const reason = approvalValue(input.description || details.description || metadata.description || record.reason);
  const command = approvalValue(input.command || details.command || metadata.command || record.command);
  const filePath = approvalValue(input.file_path || input.filePath || details.path || details.file || metadata.path || metadata.file);
  const url = approvalValue(input.url || details.url || metadata.url);
  const query = approvalValue(input.query || details.query || metadata.query);
  const patterns = approvalValue(record.patterns);
  const sections: string[] = [];
  if (reason) sections.push(reason);
  if (command) sections.push(`\`\`\`sh\n${command}\n\`\`\``);
  if (filePath) sections.push(`文件：\`${filePath}\``);
  if (url) sections.push(`地址：${url}`);
  if (query) sections.push(`内容：${query}`);
  if (patterns && !command) sections.push(`范围：\`${patterns}\``);
  return sections.join("\n\n") || "Agent 需要你的确认后才能继续。";
}

function agentQuestions(record: Record<string, unknown>) {
  const input = payloadRecord(record.input);
  return (Array.isArray(input.questions) ? input.questions : []).flatMap((value, index) => {
    const question = payloadRecord(value);
    const text = String(question.question || "").trim();
    if (!text) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((entry) => {
      const option = payloadRecord(entry);
      const label = String(option.label || "").trim();
      return label ? [{ label, description: String(option.description || "").trim() }] : [];
    });
    return [{
      id: String(question.id ?? text ?? index),
      question: text,
      header: String(question.header || "").trim(),
      multiSelect: question.multiSelect === true || question.multiple === true,
      allowCustom: question.allowCustom === true || question.custom === true || question.isOther === true || question.is_other === true || options.length === 0,
      secret: question.isSecret === true || question.is_secret === true,
      required: question.required !== false,
      options,
    } satisfies AgentQuestion];
  });
}

function AgentInputRequest({ event, taskId, taskStatus, onInput }: { event: RealtimeEnvelope; taskId?: string; taskStatus?: string; onInput?: InputResponder }) {
  const record = payloadRecord(nestedPayload(event));
  const questions = agentQuestions(record);
  const source = payloadRecord(payloadRecord(event.payload).source);
  const requestId = String(record.requestId || source.requestId || "");
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const pending = event.status === "waiting" && taskStatus === "waiting_input" && Boolean(taskId && requestId && onInput);
  const answerFor = (question: AgentQuestion) => {
    const custom = String(freeText[question.id] || "").trim();
    if (custom) return question.multiSelect ? [...(answers[question.id] || []), custom] : [custom];
    return answers[question.id] || [];
  };
  const complete = questions.length > 0 && questions.every((question) => question.required === false || answerFor(question).length > 0);
  const choose = (question: AgentQuestion, label: string) => {
    setAnswers((current) => {
      const selected = current[question.id] || [];
      const next = question.multiSelect
        ? selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label]
        : [label];
      return { ...current, [question.id]: next };
    });
    if (!question.multiSelect) setFreeText((current) => ({ ...current, [question.id]: "" }));
  };
  const submit = async () => {
    if (!pending || !complete || !taskId || !onInput || submitting) return;
    setSubmitting(true); setError("");
    try {
      await onInput(taskId, requestId, Object.fromEntries(questions.map((question) => [question.id, answerFor(question)])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "回答提交失败");
    } finally { setSubmitting(false); }
  };
  if (!questions.length) return null;
  return <section className={styles.inputRequest} aria-label="Agent 等待用户回答">
    <div className={styles.inputRequestHeading}><MessageCircle size={15} /><strong>{pending ? "Agent 正在等待你的回答" : "Agent 用户问题"}</strong><small>{pending ? "回答后继续原会话" : "已处理"}</small></div>
    <div className={styles.inputQuestionList}>{questions.map((question) => <fieldset className={styles.inputQuestion} key={question.id} disabled={!pending || submitting}>
      {question.header ? <legend>{question.header}</legend> : null}
      <p>{question.question}</p>
      {question.options?.length ? <div className={styles.inputOptions}>{question.options.map((option) => {
        const checked = (answers[question.id] || []).includes(option.label);
        return <label className={`${styles.inputOption} ${checked ? styles.inputOptionSelected : ""}`} key={option.label}>
          <input type={question.multiSelect ? "checkbox" : "radio"} name={question.id} checked={checked} onChange={() => choose(question, option.label)} />
          <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
        </label>;
      })}</div> : null}
      {question.allowCustom ? question.secret ? <input type="password" autoComplete="off" value={freeText[question.id] || ""} placeholder="输入敏感内容" onChange={(change) => {
        const value = change.target.value;
        setFreeText((current) => ({ ...current, [question.id]: value }));
        if (value && !question.multiSelect) setAnswers((current) => ({ ...current, [question.id]: [] }));
      }} /> : <textarea value={freeText[question.id] || ""} placeholder={question.options?.length ? "输入其他回答" : "输入回答"} onChange={(change) => {
        const value = change.target.value;
        setFreeText((current) => ({ ...current, [question.id]: value }));
        if (value && !question.multiSelect) setAnswers((current) => ({ ...current, [question.id]: [] }));
      }} /> : null}
    </fieldset>)}</div>
    {pending ? <div className={styles.inputActions}><button type="button" disabled={!complete || submitting} onClick={() => void submit()}>{submitting ? <LoaderCircle className={styles.spin} size={14} /> : null}提交并继续</button></div> : null}
    {error ? <small className={styles.approvalError}>{error}</small> : null}
  </section>;
}

function eventDetailLabel(event: RealtimeEnvelope, record: Record<string, unknown>) {
  if (event.kind === "approval_request") return approvalRequestDetail(record);
  const source = payloadRecord(payloadRecord(event.payload).source);
  const direct = record.detail || record.reason || record.message || record.path || record.file || record.name;
  const operation = operationLabel(record.operation);
  const agent = event.producer.startsWith("agent:") ? event.producer.slice(6) : "";
  return String(direct || operation || source.cwd || source.path || agent || "");
}

function artifactFileIcon(name: string, mime: string) {
  const suffix = name.split(".").at(-1)?.toLowerCase() || "";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "heic"].includes(suffix)) return <FileImage size={20} />;
  if (mime.startsWith("audio/") || ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff"].includes(suffix)) return <FileAudio size={20} />;
  if (mime.startsWith("video/") || ["mp4", "mov", "mkv", "avi", "webm", "wmv", "m4v", "mpeg"].includes(suffix)) return <FileVideo size={20} />;
  if (["zip", "7z", "rar", "tar", "gz", "bz2", "xz", "tgz", "zst", "cab"].includes(suffix)) return <FileArchive size={20} />;
  if (["xls", "xlsx", "xlsm", "ods", "csv", "tsv", "numbers"].includes(suffix)) return <FileSpreadsheet size={20} />;
  if (["ppt", "pptx", "pps", "ppsx", "odp", "key"].includes(suffix)) return <Presentation size={20} />;
  if (["epub", "mobi", "azw", "azw3", "fb2"].includes(suffix)) return <BookOpen size={20} />;
  if (["db", "sqlite", "sqlite3", "duckdb", "parquet", "feather", "mdb", "accdb"].includes(suffix)) return <Database size={20} />;
  if (["ttf", "otf", "woff", "woff2", "eot"].includes(suffix)) return <FileType2 size={20} />;
  if (["exe", "msi", "dmg", "pkg", "deb", "rpm", "apk", "appimage", "iso"].includes(suffix)) return <Package size={20} />;
  if (["dwg", "dxf", "step", "stp", "iges", "igs", "stl", "obj", "3mf", "blend"].includes(suffix)) return <Box size={20} />;
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "java", "c", "cc", "cpp", "h", "hpp", "rs", "go", "rb", "php", "swift", "kt", "sh", "ps1", "json", "yaml", "yml", "toml", "xml", "html", "css", "sql"].includes(suffix)) return <FileCode2 size={20} />;
  if (mime.startsWith("text/") || ["txt", "md", "pdf", "doc", "docx", "odt", "rtf", "log", "pages"].includes(suffix)) return <FileText size={20} />;
  return <File size={20} />;
}

function displayFileSize(value: unknown) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "远端文件";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(0.1, size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${Math.max(0.1, size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(0.1, size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export type ArtifactCardData = Pick<ArtifactSummary, "id" | "name" | "mime" | "size" | "createdAt"> & { workspaceId?: string; path?: string; failure?: string };

function ArtifactCardRow({ artifact }: { artifact: ArtifactCardData }) {
  const runtime = useAppRuntime();
  const artifactId = String(artifact.id || "");
  const name = artifactDisplayName(artifact.name || "结果文件");
  const mime = String(artifact.mime || "application/octet-stream");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const previewable = !artifact.failure && canPreviewFile({ name, mime }) && runtime.view.kind === "conversation";
  const openPreview = () => {
    if (previewable && runtime.view.kind === "conversation") runtime.openFilePreview({ conversationId: runtime.view.conversationId, name, size: Number(artifact.size) || 0, source: { kind: "artifact", artifactId } });
  };
  const download = async () => {
    if (!artifactId || downloading) return;
    setDownloading(true); setError("");
    try {
      const result = await runtime.api.post<{ url: string }>(`/api/artifacts/${encodeURIComponent(artifactId)}/download`, {});
      window.location.assign(result.data.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "下载链接生成失败");
    } finally { setDownloading(false); }
  };
  const contents = <><span data-ui-icon="" className={styles.artifactGlyph}>{artifactFileIcon(name, mime)}</span><span className={styles.artifactCopy}><strong>{name}</strong><small className={styles.artifactMeta}><span className={styles.artifactFileMeta}>{fileTypeLabel({ name, mime })} · {displayFileSize(artifact.size)}</span>{previewable ? <span className={styles.artifactOpenHint} aria-hidden="true">打开文件</span> : null}</small>{error || artifact.failure ? <em>{error || artifact.failure}</em> : null}</span></>;
  return <article className={styles.artifactCard} data-artifact-id={artifactId} data-previewable={previewable}>
    {previewable ? <button type="button" className={styles.artifactPreview} aria-label={`预览 ${name}`} onClick={openPreview}>{contents}</button> : <div className={styles.artifactPreview}>{contents}</div>}
    <button className={styles.artifactDownload} data-ui-icon="" type="button" aria-label={`下载 ${name}`} aria-busy={downloading} disabled={!artifactId || downloading || Boolean(artifact.failure)} onClick={() => void download()}>{downloading ? <LoaderCircle className={styles.spin} size={17} /> : <Download size={17} />}</button>
  </article>;
}

export function ConversationArtifactCards({ events = [], artifacts = [] }: { events?: RealtimeEnvelope[]; artifacts?: ArtifactSummary[] }) {
  const cards: ArtifactCardData[] = useMemo(() => conversationArtifactCards(orderedEvents(events), artifacts), [artifacts, events]);
  if (!cards.length) return null;
  return <div className={styles.artifactCards} aria-label="下载文件">{cards.map((artifact) => <ArtifactCardRow key={artifact.id} artifact={artifact} />)}</div>;
}

export function ConversationAnswer({ content, events = [], artifacts = [], artifactHistory = [], workspaceId }: { content: string; events?: RealtimeEnvelope[]; artifacts?: ArtifactSummary[]; artifactHistory?: ArtifactCardData[]; workspaceId?: string }) {
  const markdown = useMemo(() => artifactAnswerMarkdown(content, orderedEvents(events)), [content, events]);
  const cards: ArtifactCardData[] = useMemo(() => referencedArtifactCards(markdown, conversationArtifactCards(orderedEvents(events), artifacts), artifactHistory, {
    workspaceId, before: orderedEvents(events).at(-1)?.occurredAt,
  }), [markdown, events, artifacts, artifactHistory, workspaceId]);
  return <MarkdownContent content={markdown} artifactCards={cards} renderArtifact={(id) => {
    const card = cards.find((entry) => entry.id === id);
    return card ? <div className={styles.artifactCards} aria-label="下载文件"><ArtifactCardRow artifact={card} /></div> : null;
  }} />;
}

function EventRow({ event, taskId, taskStatus, onApproval }: { event: RealtimeEnvelope; taskId?: string; taskStatus?: string; onApproval?: ApprovalResponder }) {
  const record = payloadRecord(nestedPayload(event));
  const [open, setOpen] = useState(event.kind === "approval_request" && event.status === "waiting");
  const text = !open ? "" : event.kind === "approval_request"
    ? approvalRequestText(record)
    : textFrom(record) || (event.kind !== "command" && Object.keys(record).length ? safeJson(record) : "");
  const detail = event.kind === "approval_request" ? "" : eventDetailLabel(event, record);
  const secondary = detail || (event.kind !== "approval_request" && event.producer.startsWith("agent:") ? event.producer.slice(6) : "");
  const expandable = Boolean(timelineDetailIds(event).length || textFrom(record) || Object.keys(record).length);
  const detailState = useTimelineDetails(timelineDetailIds(event), open);
  const [responding, setResponding] = useState<ApprovalDecision | null>(null);
  const [submitted, setSubmitted] = useState<{ requestId: string; decision: ApprovalDecision } | null>(null);
  const [approvalError, setApprovalError] = useState("");
  const requestId = String(record.requestId || payloadRecord(payloadRecord(event.payload).source).requestId || "");
  const submittedDecision = submitted?.requestId === requestId ? submitted.decision : null;
  const approvalPending = event.kind === "approval_request" && event.status === "waiting" && taskStatus === "waiting_approval" && !submittedDecision && Boolean(taskId && requestId && onApproval);
  const respond = async (decision: ApprovalDecision) => {
    if (!approvalPending || !taskId || !onApproval || responding || submittedDecision) return;
    setSubmitted({ requestId, decision }); setResponding(decision); setApprovalError("");
    try { await onApproval(taskId, requestId, decision); }
    catch (reason) { setSubmitted(null); setApprovalError(reason instanceof Error ? reason.message : "审批响应失败"); }
    finally { setResponding(null); }
  };
  return <article className={`${styles.agentEvent} ${styles[`kind_${event.kind}`] || ""} ${open ? styles.itemOpen : ""} ${isRunningEvent(event) ? styles.running : ""} ${event.status === "failed" || event.kind === "error" ? styles.error : ""}`}>
    <button type="button" className={styles.eventSummary} aria-expanded={expandable ? open : undefined} onClick={() => expandable && setOpen((value) => !value)}><span data-ui-icon="" className={styles.eventGlyph}>{eventIcon(event)}</span><span className={styles.eventCopy}><strong>{eventLabel(event)}</strong>{secondary ? <small>{secondary}</small> : null}</span><span className={styles.eventStatus}>{event.kind === "approval_request" && event.status === "waiting" ? "等待操作" : eventStatusLabel(event.status)}</span>{expandable ? <ChevronRight className={styles.itemChevron} size={13} /> : <span />}</button>
    <DisclosureMotion open={expandable && open} ready={detailState.ready} className={styles.itemMotion}><div><div className={styles.eventDetail}><TimelineDetailStatus state={detailState} />{text && !detailState.loading ? <div className={styles.eventOutput}><MarkdownContent content={text} compact activity /></div> : null}{approvalPending ? <div className={styles.approvalActions}><button type="button" disabled={Boolean(responding)} onClick={() => void respond("approve")}>{responding === "approve" ? <LoaderCircle className={styles.spin} size={13} /> : null}允许一次</button>{record.allowSession !== false ? <button type="button" disabled={Boolean(responding)} onClick={() => void respond("approve_session")}>{responding === "approve_session" ? <LoaderCircle className={styles.spin} size={13} /> : null}本会话允许</button> : null}<button type="button" className={styles.rejectApproval} disabled={Boolean(responding)} onClick={() => void respond("reject")}>{responding === "reject" ? <LoaderCircle className={styles.spin} size={13} /> : null}拒绝</button></div> : null}{approvalError ? <small className={styles.approvalError}>{approvalError}</small> : null}</div></div></DisclosureMotion>
  </article>;
}

function AgentThought({ event }: { event: RealtimeEnvelope }) {
  const content = textFrom(nestedPayload(event)).trim();
  if (!content) return null;
  return <section className={`${styles.agentThought} ${event.status === "failed" ? styles.error : ""}`} aria-label="Agent 中间输出">
    <div className={styles.agentThoughtContent}><MarkdownContent content={content} compact activity /></div>
  </section>;
}

function AgentFinalActivity({ content }: { content: string }) {
  return <section className={styles.agentThought} aria-label="Agent 最终输出前言">
    <div className={styles.agentThoughtContent}><MarkdownContent content={content} compact activity /></div>
  </section>;
}

type ActivitySegment =
  | { type: "operations"; id: string; events: RealtimeEnvelope[] }
  | { type: "event"; id: string; event: RealtimeEnvelope };

export function normalizeRemoteArtifactLinkText(value: string) {
  return parseRemoteArtifactLinks(value).cleaned.replace(/\s+/g, " ").trim();
}

function normalizedActivityText(event: RealtimeEnvelope) {
  return normalizeRemoteArtifactLinkText(textFrom(nestedPayload(event)));
}

function comparableFinalBody(value: string) {
  return String(value || "").trim().replace(/[\s。！？!?…]+$/gu, "").trim();
}

function substantiallySameFinalBody(candidate: string, finalText: string) {
  const left = comparableFinalBody(candidate);
  const right = comparableFinalBody(finalText);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length / longer.length >= .86 && (longer.startsWith(shorter) || longer.endsWith(shorter));
}

function finalSummaryMessageIds(events: RealtimeEnvelope[], finalTexts: string[]) {
  const hidden = new Set<string>();
  for (const finalText of finalTexts) {
    // Native agents can journal the same final answer under more than one
    // source item (for example, an assistant item and a content-block item).
    // Remove every complete copy before handling genuinely chunked finals;
    // stopping at the first match leaves one duplicate inside Agent activity.
    for (const event of events) {
      if (event.kind === "message" && substantiallySameFinalBody(normalizedActivityText(event), finalText)) {
        hidden.add(event.eventId);
      }
    }
    const suffix: RealtimeEnvelope[] = [];
    let combined = "";
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.kind !== "message") {
        if (suffix.length && ["tool_call", "file_change", "reasoning"].includes(event.kind)) break;
        continue;
      }
      if (hidden.has(event.eventId)) continue;
      const record = payloadRecord(nestedPayload(event));
      if (record.messagePhase === "commentary" || record.delivery === "async") {
        if (suffix.length) break;
        continue;
      }
      const text = normalizedActivityText(event);
      if (!text) continue;
      suffix.unshift(event);
      combined = `${text} ${combined}`.trim();
      if (record.messagePhase === "final_answer" || substantiallySameFinalBody(combined, finalText)) {
        suffix.forEach((candidate) => hidden.add(candidate.eventId));
        break;
      }
      if (combined.length > finalText.length * 1.16) break;
    }
  }
  return hidden;
}

function activityIdentity(event: RealtimeEnvelope) {
  // Journal IDs identify deliveries. A cumulative stream replaces its previous
  // delivery, but must keep the same mounted disclosure and its reader state.
  const itemId = sourceItemId(event);
  return itemId ? `${event.producer}:${event.kind}:${itemId}`
    : String(payloadRecord(event.payload).realtimeStreamKey || event.eventId);
}

function activitySegments(events: RealtimeEnvelope[], finalTextHints: string[] = []) {
  const segments: ActivitySegment[] = [];
  const finalTexts = [...new Set([
    ...events.filter((event) => event.kind === "final").map(normalizedActivityText),
    ...finalTextHints.map(normalizeRemoteArtifactLinkText),
  ].filter(Boolean))];
  const visibleEvents = orderedEvents(events).filter(visibleRemoteEvent);
  const coalesced = coalesceRemoteEvents(visibleEvents);
  const finalMessageIds = finalSummaryMessageIds(coalesced, finalTexts);
  for (const event of coalesced) {
    if (finalMessageIds.has(event.eventId)) continue;
    const type = ["tool_call", "file_change"].includes(event.kind) ? "operations" : null;
    const previous = segments.at(-1);
    if (!type && previous?.type === "event" && !timelineDetailIds(event).length && !timelineDetailIds(previous.event).length && normalizedActivityText(previous.event) === normalizedActivityText(event)) {
      const sameNarrativeKind = ["message", "reasoning", "error"].includes(event.kind) && previous.event.kind === event.kind;
      const repeatedCommandFailure = event.producer === "task-orchestrator"
        && event.kind === "command"
        && event.status === "failed"
        && (previous.event.kind === "error" || previous.event.status === "failed");
      if (sameNarrativeKind || repeatedCommandFailure) continue;
    }
    if (type && previous?.type === type) previous.events.push(event);
    else if (type === "operations") segments.push({ type, id: activityIdentity(event), events: [event] });
    else segments.push({ type: "event", id: activityIdentity(event), event });
  }
  return segments;
}

function settledEvents(events: RealtimeEnvelope[], status: string) {
  if (!TERMINAL_TASK_STATUSES.has(status)) return events;
  const pointNoticeOperations = new Set([
    "warning",
    "guardianWarning",
    "deprecationNotice",
    "configWarning",
    "agent_switched",
    "model_switched",
    "model_fallback",
    "model_refusal_fallback",
    "model_safety_buffering",
  ]);
  return events.map((event) => {
    if (event.status === "waiting" && ["approval_request", "input_request"].includes(event.kind)) return { ...event, status: "cancelled" };
    if (isRunningEvent(event) && ["tool_call", "file_change", "job_status"].includes(event.kind)) {
      return { ...event, status: status === "completed" ? "completed" : "interrupted" };
    }
    const operation = String(payloadRecord(nestedPayload(event)).operation || "");
    if (event.kind === "job_status" && pointNoticeOperations.has(operation) && isRunningEvent(event)) return { ...event, status: "completed" };
    return event;
  });
}

const TIMELINE_DISCLOSURE_PREFIX = "easywork.timeline-disclosure:v1:";

function storedTimelineDisclosure(identity: string) {
  if (typeof window === "undefined" || !identity) return false;
  try { return localStorage.getItem(`${TIMELINE_DISCLOSURE_PREFIX}${identity}`) === "open"; }
  catch { return false; }
}

function writeTimelineDisclosure(identity: string, open: boolean) {
  if (typeof window === "undefined" || !identity) return;
  try {
    const key = `${TIMELINE_DISCLOSURE_PREFIX}${identity}`;
    if (open) localStorage.setItem(key, "open");
    else localStorage.removeItem(key);
  } catch { /* browser storage is an enhancement; in-memory state still works */ }
}

function useTimelineDisclosure(identity: string, running: boolean, expandable: boolean) {
  const [choice, setChoice] = useState(() => ({
    identity,
    running,
    expandable,
    open: Boolean(expandable && (running || storedTimelineDisclosure(identity))),
  }));
  const samePhase = choice.identity === identity && choice.running === running && choice.expandable === expandable;
  const justFinished = choice.identity === identity && choice.running && !running;
  const open = expandable && (samePhase
    ? choice.open
    : justFinished
      ? false
      : running || storedTimelineDisclosure(identity));
  useEffect(() => {
    if (samePhase) return;
    if (justFinished) writeTimelineDisclosure(identity, false);
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setChoice({ identity, running, expandable, open });
    });
    return () => { cancelled = true; };
  }, [identity, running, expandable, open, samePhase, justFinished]);
  const toggleOpen = () => {
    const next = expandable ? !open : false;
    if (!running) writeTimelineDisclosure(identity, next);
    setChoice({ identity, running, expandable, open: next });
  };
  return [open, toggleOpen] as const;
}

function taskPreparationDetail(status: string) {
  if (TERMINAL_TASK_STATUSES.has(status)) return "";
  if (status === "waiting_input") return "远端 Agent 正在等待你的回答";
  if (status === "waiting_approval") return "远端 Agent 正在等待你的确认";
  return "";
}

function agentFailureMessage(events: RealtimeEnvelope[], task?: TaskSummary, failure?: { code: string; message: string } | null) {
  const failureEvents = orderedEvents(events).filter((event) => event.kind === "error" || event.status === "failed");
  for (let index = failureEvents.length - 1; index >= 0; index -= 1) {
    const message = textFrom(nestedPayload(failureEvents[index])).trim();
    if (message) return message;
  }
  return task?.failure?.message?.trim() || failure?.message?.trim() || "Agent 调用失败，请稍后重试";
}

function AgentFailureNotice({ message }: { message: string }) {
  return <section className={styles.agentFailureNotice} role="alert" aria-label="Agent 调用失败">
    <X size={15} strokeWidth={1.8} aria-hidden="true" />
    <span>{message}</span>
  </section>;
}

function AgentReasoning({ event }: { event: RealtimeEnvelope }) {
  const detailState = useTimelineDetails(timelineDetailIds(event), true);
  const content = textFrom(nestedPayload(event)).replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").trim();
  return <section className={`${styles.reasoningText} ${styles.agentReasoningText}`} aria-label="Agent 思考文本">
    <TimelineDetailStatus state={detailState} />
    {!detailState.loading ? <MarkdownContent content={content} compact activity /> : null}
  </section>;
}

function AgentActivityItem({ segment, taskId, status, onApproval, onInput }: { segment: ActivitySegment; taskId?: string; status: string; onApproval?: ApprovalResponder; onInput?: InputResponder }) {
  if (segment.type === "operations") return <OperationGroup events={segment.events} taskId={taskId} taskStatus={status} onApproval={onApproval} />;
  const event = segment.event;
  if (event.kind === "input_request") return <AgentInputRequest event={event} taskId={taskId} taskStatus={status} onInput={onInput} />;
  if (event.kind === "reasoning") return <AgentReasoning event={event} />;
  if (event.kind === "message") return <AgentThought event={event} />;
  return <EventRow event={event} taskId={taskId} taskStatus={status} onApproval={onApproval} />;
}

function AgentThinking({ segments, id, running, taskId, status, onApproval, onInput }: { segments: ActivitySegment[]; id: string; running: boolean; taskId?: string; status: string; onApproval?: ApprovalResponder; onInput?: InputResponder }) {
  const [open, toggleOpen] = useTimelineDisclosure(`remote-thinking:${taskId}:${id}`, running, true);
  return <section className={styles.agentThinking}>
    <button className={styles.reasoningHeading} type="button" aria-expanded={open} onClick={toggleOpen}>
      <span data-ui-icon="" className={styles.reasoningGlyph}><Brain size={15} /></span>
      <span className={styles.reasoningLabel}>{running ? "Agent思考中" : "Agent已思考"}</span><ChevronRight className={styles.reasoningChevron} size={13} />
    </button>
    <DisclosureMotion open={open} className={styles.agentThinkingMotion}><div className={styles.agentThinkingBody}>{segments.map((segment) => <AgentActivityItem key={segment.id} segment={segment} taskId={taskId} status={status} onApproval={onApproval} onInput={onInput} />)}</div></DisclosureMotion>
  </section>;
}

function AgentCallContents({ events, status, taskId, finalTextHint, running, onApproval, onInput }: { events: RealtimeEnvelope[]; status: string; taskId?: string; finalTextHint: string; running: boolean; onApproval?: ApprovalResponder; onInput?: InputResponder }) {
  const segments = useMemo(() => activitySegments(
    settledEvents(events, status),
    TERMINAL_TASK_STATUSES.has(status) && finalTextHint ? [finalTextHint] : [],
  ), [events, finalTextHint, status]);
  const groups = useMemo(() => groupAgentActivity(segments) as Array<ActivitySegment | { type: "thinking"; id: string; segments: ActivitySegment[] }>, [segments]);
  return <>{groups.map((group, index) => group.type === "thinking"
    ? <AgentThinking key={group.id} segments={group.segments} id={group.id} running={running && index === groups.length - 1} taskId={taskId} status={status} onApproval={onApproval} onInput={onInput} />
    : <AgentActivityItem key={group.id} segment={group} taskId={taskId} status={status} onApproval={onApproval} onInput={onInput} />)}</>;
}

function AgentCall({ events, status, task, taskId, finalTextHint = "", failure = null, detailsLoading = false, onApproval, onInput }: { events: RealtimeEnvelope[]; status: string; task?: TaskSummary; taskId?: string; finalTextHint?: string; failure?: { code: string; message: string } | null; detailsLoading?: boolean; onApproval?: ApprovalResponder; onInput?: InputResponder }) {
  const finalActivities = useMemo(() => [...new Set(events
    .filter((event) => event.kind === "final")
    .map((event) => splitRemoteFinalPresentation(textFrom(nestedPayload(event))).activity)
    .filter(Boolean))], [events]);
  // Do not coalesce commands or construct detail rows while the call is closed.
  // A message-only turn still needs the normal final-answer deduplication.
  const hasActivity = useMemo(() => finalActivities.length > 0
    || events.some((event) => event.kind !== "message" && visibleRemoteEvent(event))
    || activitySegments(events, TERMINAL_TASK_STATUSES.has(status) && finalTextHint ? [finalTextHint] : []).length > 0,
  [events, finalActivities, finalTextHint, status]);
  const stageDetail = taskPreparationDetail(status);
  const hasDetails = detailsLoading || hasActivity || Boolean(stageDetail);
  const running = !TERMINAL_TASK_STATUSES.has(status);
  // Disclosure auto-open/auto-close follows the authoritative Task snapshot,
  // not a partially hydrated event page.  Otherwise historical status pages
  // can momentarily look live during reload and erase the user's saved choice.
  const disclosureRunning = Boolean(task && !TERMINAL_TASK_STATUSES.has(task.status) && running);
  const failed = status === "failed";
  const interrupted = ["interrupted", "cancelled"].includes(status);
  const conversationId = String(events[0]?.ids.conversationId || task?.conversationId || "unknown");
  const disclosureId = `agent:${conversationId}:${taskId || "unknown"}`;
  const [open, toggleOpen] = useTimelineDisclosure(disclosureId, disclosureRunning, hasDetails);
  if (failed) return <AgentFailureNotice message={agentFailureMessage(events, task, failure)} />;
  return <section className={`${styles.agentCall} ${open ? styles.agentCallOpen : ""} ${running ? styles.agentCallRunning : ""} ${interrupted ? styles.agentCallInterrupted : ""} ${hasDetails ? "" : styles.agentCallNoDetails}`}>
    <button type="button" className={styles.agentCallHeading} aria-expanded={hasDetails ? open : undefined} onClick={() => hasDetails && toggleOpen()}>
      <span data-ui-icon="" className={styles.agentCallGlyph}>{interrupted ? <CircleStop size={17} strokeWidth={1.8} /> : <Bot size={17} />}</span>
      <span className={styles.activityHeadingLabel}>{running ? "Agent调用中" : interrupted ? "Agent调用已停止" : "Agent调用完成"}</span>
      {hasDetails ? <ChevronRight className={styles.agentCallChevron} size={13} /> : null}
    </button>
    <DisclosureMotion open={hasDetails && open} ready={!detailsLoading || disclosureRunning} className={styles.agentCallMotion}><div><div className={styles.agentActivity}>
      {stageDetail ? <div className={styles.agentCallStage}><LoaderCircle className={styles.spin} size={15} /><span>{stageDetail}</span></div> : null}
      <AgentCallContents events={events} status={status} taskId={taskId} finalTextHint={finalTextHint} running={disclosureRunning} onApproval={onApproval} onInput={onInput} />
      {finalActivities.map((content, index) => <AgentFinalActivity key={`final-activity:${index}:${content}`} content={content} />)}
      {detailsLoading ? <p role="status">正在载入活动记录…</p> : null}
    </div></div></DisclosureMotion>
  </section>;
}

function visibleRemoteEvent(event: RealtimeEnvelope) {
  if (event.kind === "plan" || event.kind === "plan_state") return false;
  // Artifacts appear at their file-link positions in the assistant body.
  if (event.kind === "artifact") return false;
  if (event.producer === "task-orchestrator") {
    if (event.kind === "status") return false;
    // Command lifecycle records are internal control-plane acknowledgements.
    // Successful create/append/interrupt/resume records duplicate user-visible
    // actions and expose implementation fields such as commandId/result. Keep
    // only failures, whose concise failure message is rendered by EventRow.
    if (event.kind === "command") return event.status === "failed";
    if (event.kind === "error") return true;
  }
  if (["usage", "context_delivery", "final", "status"].includes(event.kind)) return false;
  if (["tool_call", "tool_result"].includes(event.kind)) {
    const name = String(payloadRecord(nestedPayload(event)).name || "");
    if (name === "AskUserQuestion" || AGENT_PLAN_TOOLS.has(name)) return false;
  }
  if (event.kind === "file_change" && fileEntries(payloadRecord(nestedPayload(event))).length === 0) return false;
  if (event.kind === "job_status") {
    const operation = String(payloadRecord(nestedPayload(event)).operation || "");
    return ["unmapped_agent_event", "agent_compatibility_issue", "agent_effort_adjusted"].includes(operation);
  }
  if (["message", "reasoning"].includes(event.kind) && !textFrom(nestedPayload(event)).trim() && !payloadRecord(nestedPayload(event)).timelineHasText) return false;
  return true;
}

function eventTaskId(event: RealtimeEnvelope) {
  return String(event.ids.taskId || "");
}

function terminalWebTaskStatus(events: RealtimeEnvelope[], taskId: string) {
  let status = "";
  for (const event of orderedEvents(events)) {
    if (taskId && eventTaskId(event) !== taskId) continue;
    if (["run.persisted", "run.superseded"].includes(event.kind)) status = "completed";
    else if (event.kind === "run.suspended") status = ["interrupted", "cancelled"].includes(String(event.status)) ? String(event.status) : "interrupted";
    else if (event.kind === "run.failed") status = "failed";
    else if (event.kind === "run.aborted") status = "cancelled";
  }
  return status;
}

function remoteTaskStatus(events: RealtimeEnvelope[], taskById: Readonly<Record<string, TaskSummary>> = {}, fallbackTaskId = "", settledTaskIds: ReadonlySet<string> = new Set(), webTerminalStatus = "") {
  // Do not infer a live call merely from the presence of historical native
  // events.  Event history is hydrated in pages, so a completed task can
  // temporarily arrive without its terminal page; treating that partial
  // history as `running` makes the disclosure flash open and then clears the
  // user's persisted open/closed choice when the terminal page arrives.
  // A task is live only when the authoritative Task snapshot or an explicit
  // orchestrator status says so.
  // `run.handoff.dispatched` proves a Task has just been created. Before its
  // authoritative snapshot arrives, that Task is queued rather than complete;
  // treating this hydration gap as terminal makes the heading briefly lie.
  let status: string = fallbackTaskId
    ? taskById[fallbackTaskId]?.status || webTerminalStatus || (settledTaskIds.has(fallbackTaskId) ? "completed" : "queued")
    : "completed";
  for (const event of orderedEvents(events)) {
    if (event.producer === "task-orchestrator" && event.kind === "status" && event.status) status = event.status;
    // Native tool failures are details inside a still-running Agent turn. Only
    // the Task orchestrator can declare the whole call failed; otherwise one
    // rejected command makes the heading lie while the Agent is still retrying.
    if (event.producer === "task-orchestrator" && (event.kind === "error" || event.status === "failed")) status = "failed";
  }
  // A native Task can span several webpage turns (for example, live append or
  // interrupt/resume). Each timeline block deliberately contains only the
  // events from its own webpage turn, so an earlier block may not contain the
  // later terminal event. Preserve an explicit per-turn terminal state; only
  // fall back to the authoritative Task snapshot while the block still looks
  // active.
  if (!TERMINAL_TASK_STATUSES.has(status)) {
    const taskId = orderedEvents(events).map(eventTaskId).filter(Boolean).at(-1) || fallbackTaskId;
    const taskStatus = taskId ? taskById[taskId]?.status : undefined;
    if (taskStatus && TERMINAL_TASK_STATUSES.has(taskStatus)) status = taskStatus;
    else if (webTerminalStatus) status = webTerminalStatus;
    else if (taskId && settledTaskIds.has(taskId)) status = "completed";
  }
  return status;
}

function HydratedConversationTimeline({ events, mode = "chat", taskIdHint = "", finalTextHint = "", loading = false, taskById = {}, settledTaskIds = new Set(), onApproval, onInput }: { events: RealtimeEnvelope[]; mode?: "chat" | "work"; taskIdHint?: string; finalTextHint?: string; loading?: boolean; taskById?: Readonly<Record<string, TaskSummary>>; settledTaskIds?: ReadonlySet<string>; onApproval?: ApprovalResponder; onInput?: InputResponder }) {
  const webTrace = useMemo(() => buildWebTrace(events), [events]);
  const directRemoteAppend = useMemo(() => isDirectRemoteAppendTimeline(events), [events]);
  const remoteAll = useMemo(() => orderedEvents(events.filter((event) => event.producer === "task-orchestrator" || event.producer.startsWith("agent:"))), [events]);
  const handedOffTaskId = useMemo(() => orderedEvents(events)
    .filter((event) => event.kind === "run.handoff.dispatched")
    .map(eventTaskId)
    .filter(Boolean)
    .at(-1) || "", [events]);
  const remoteTaskId = remoteAll.map(eventTaskId).filter(Boolean).at(-1) || handedOffTaskId || taskIdHint;
  const launchFailureEvent = useMemo(() => !remoteTaskId && (webTrace.handoff || directRemoteAppend)
    ? [...orderedEvents(events)].reverse().find((event) => event.kind === "run.failed") ?? null
    : null, [directRemoteAppend, events, remoteTaskId, webTrace.handoff]);
  const launchFailure = launchFailureEvent ? {
    code: String(payloadRecord(launchFailureEvent.payload).code || "REMOTE_AGENT_START_FAILED"),
    message: String(payloadRecord(launchFailureEvent.payload).message || "远端 Agent 启动失败"),
  } : null;
  const webTerminalStatus = terminalWebTaskStatus(events, remoteTaskId);
  const status = remoteTaskStatus(remoteAll, taskById, remoteTaskId, settledTaskIds, webTerminalStatus);
  // Input preparation can fail before `run.started` is durably emitted (for
  // example, while validating a restored workspace binding).  The terminal
  // event is still the complete webpage-Agent trace for that turn and must be
  // rendered instead of leaving an empty EasyWork message in history.
  // Initial Work preparation always owns one thinking region, even when the
  // backend can prove that no webpage-model call or context read is needed.
  // Its handoff remains the final module inside that region. A live append is
  // sent straight to the native Agent and therefore creates no webpage trace.
  const showThought = !directRemoteAppend && (
    webTrace.started
    || webTrace.running
    || webTrace.entries.length > 0
    || Boolean(webTrace.handoff)
    || Boolean(webTrace.failure || webTrace.abortReason)
  );
  const showHandoff = mode === "work" && !directRemoteAppend && webTrace.handoff;
  if (!showThought && !remoteTaskId) return null;
  return <section className={styles.workflow} aria-label="Agent 活动">
    {showThought ? <WebThought events={events} handoff={showHandoff ? webTrace.handoff : null} /> : null}
    {mode === "work" && remoteTaskId ? <AgentCall key={remoteTaskId} events={remoteAll} status={status} task={taskById[remoteTaskId]} taskId={remoteTaskId} finalTextHint={finalTextHint} detailsLoading={loading} onApproval={onApproval} onInput={onInput} /> : null}
    {mode === "work" && launchFailure ? <AgentCall key={launchFailureEvent!.eventId} events={[]} status="failed" taskId={`launch:${String(launchFailureEvent!.ids.runId || launchFailureEvent!.eventId)}`} failure={launchFailure} /> : null}
  </section>;
}

export function ConversationTimeline(props: Parameters<typeof HydratedConversationTimeline>[0]) {
  return <TimelineDetails events={props.events}>{(events) => <HydratedConversationTimeline {...props} events={events} />}</TimelineDetails>;
}

/** Markdown projection of the same semantic rows used by the disclosures. */
export function conversationTimelineMarkdown({ events, mode = "chat", taskIdHint = "", finalTextHint = "", taskById = {} }: Parameters<typeof HydratedConversationTimeline>[0]) {
  const output: string[] = [];
  const heading = (label: string, level = 4) => output.push(`${"#".repeat(level)} ${markdownLabel(label)}`);
  const trace = buildWebTrace(events);
  const directAppend = isDirectRemoteAppendTimeline(events);
  if (!directAppend && (trace.started || trace.entries.length || trace.handoff || trace.failure || trace.abortReason)) {
    heading(trace.running ? "正在思考" : trace.failure ? "处理失败" : trace.aborted ? "思考已停止" : "思考完成", 3);
    for (const entry of trace.entries) {
      if (entry.type === "reasoning") {
        heading("思考内容");
        output.push(entry.text.trim());
      } else if (entry.type === "state") {
        const server = payloadRecord(entry.state.server);
        const workspace = payloadRecord(entry.state.workspace);
        const agent = payloadRecord(entry.state.agent);
        const schedulerType = String(server.scheduler || "");
        const scheduler = ["none", "unknown"].includes(schedulerType) ? "" : ({ slurm: "Slurm", pbs: "PBS", generic: "通用调度器" } as Record<string, string>)[schedulerType] || schedulerType;
        const values = [
          ["服务器", [server.name, scheduler].filter(Boolean).join(" · ")],
          ["工作区", workspace.name || workspace.path],
          ["Agent", agent.name],
        ].filter(([, value]) => value);
        if (values.length) {
          heading("已查阅当前状态");
          output.push(values.map(([label, value]) => `- ${label}：${markdownLabel(value)}`).join("\n"));
        }
      } else if (entry.type === "background") {
        heading("已查阅背景");
        const results: BackgroundResultItem[] = entry.reads.flatMap((read) => backgroundItems(read.output).map((result) => ({ ...result, detailIds: [] })));
        const displayItems = groupBackgroundResults(results) as BackgroundDisplayItem[];
        displayItems.forEach((item) => {
          if (item.type === "conversation") {
            output.push(`- 对话：${markdownLabel(item.title)}`);
            return;
          }
          heading(`${sourceLabel(item.result.source)} ${resultTitle(item.result.source, item.result.value, item.index)}`, 5);
          const content = semanticResultText(item.result.source, item.result.value);
          if (content) output.push(content);
        });
      } else if (entry.text.trim()) output.push(entry.text.trim());
    }
    if (mode === "work" && trace.handoff) {
      heading("发给远端 Agent");
      if (trace.handoff.userMessage) output.push(trace.handoff.userMessage);
      if (trace.handoff.contextBrief) output.push(trace.handoff.contextBrief);
      for (const reference of trace.handoff.references) {
        heading(`${reference.kind} ${reference.name}${reference.edited ? "（本轮整理）" : ""}`, 5);
        if (reference.detail) output.push(reference.detail);
      }
    }
    if (trace.failure || trace.abortReason) output.push(trace.failure || trace.abortReason);
  }
  if (mode !== "work") return output.filter(Boolean).join("\n\n");

  const remote = orderedEvents(events.filter((event) => event.producer === "task-orchestrator" || event.producer.startsWith("agent:")));
  const handedOffTask = orderedEvents(events).filter((event) => event.kind === "run.handoff.dispatched").map(eventTaskId).filter(Boolean).at(-1);
  const taskId = remote.map(eventTaskId).filter(Boolean).at(-1) || handedOffTask || taskIdHint;
  if (!taskId) {
    const failure = [...orderedEvents(events)].reverse().find((event) => event.kind === "run.failed");
    if (failure && (trace.handoff || directAppend)) output.push(String(payloadRecord(failure.payload).message || "远端 Agent 启动失败"));
    return output.filter(Boolean).join("\n\n");
  }
  const status = remoteTaskStatus(remote, taskById, taskId, new Set(), terminalWebTaskStatus(events, taskId));
  if (status === "failed") {
    output.push(agentFailureMessage(remote, taskById[taskId]));
    return output.filter(Boolean).join("\n\n");
  }
  const running = !TERMINAL_TASK_STATUSES.has(status);
  heading(running ? "Agent调用中" : ["cancelled", "interrupted"].includes(status) ? "Agent调用已停止" : "Agent调用完成", 3);
  const stage = taskPreparationDetail(status);
  if (stage) output.push(stage);
  const segments = activitySegments(settledEvents(remote, status), !running && finalTextHint ? [finalTextHint] : []);
  const groups = groupAgentActivity(segments) as Array<ActivitySegment | { type: "thinking"; id: string; segments: ActivitySegment[] }>;
  const appendEmbeddedApproval = (event: RealtimeEnvelope) => {
    const approval = payloadRecord(payloadRecord(event.payload).embeddedApproval);
    if (!Object.keys(approval).length) return;
    const text = approvalRequestText(payloadRecord(nestedPayload(approval as RealtimeEnvelope)));
    if (text) { heading("请求审批", 5); output.push(text); }
  };
  const appendSegment = (segment: ActivitySegment) => {
    if (segment.type === "operations") {
      const entries = operationEntries(segment.events);
      const label = segment.events.some((event) => event.status === "waiting") ? "等待执行"
        : segment.events.some(isRunningEvent) ? "正在执行"
          : segment.events.every((event) => ["cancelled", "interrupted"].includes(String(event.status))) ? "已取消" : "执行了";
      heading(`${label} ${entries.length} 个操作`, 5);
      for (const entry of entries) {
        if (entry.type === "tool") {
          const parts = toolParts(entry.event);
          heading(`${parts.label} ${parts.summary} ${eventStatusLabel(entry.event.status)}`, 6);
          if (parts.detail) output.push(markdownFence(parts.detail, parts.shell ? "shell" : ""));
          appendEmbeddedApproval(entry.event);
        } else {
          const { file } = entry;
          heading(`${file.operation === "read" ? "读取文件" : "编辑文件"} ${file.path || "未命名文件"}`, 6);
          if (file.diff || file.output) output.push(markdownFence(file.diff || file.output, file.diff ? "diff" : ""));
          else output.push(file.operation === "read" ? "Agent 未返回可显示的文件内容。" : "Agent 未返回可显示的差异内容。");
          appendEmbeddedApproval(file.event);
        }
      }
      return;
    }
    const event = segment.event;
    const record = payloadRecord(nestedPayload(event));
    if (event.kind === "message" || event.kind === "reasoning") {
      output.push(normalizedActivityText(event));
    } else if (event.kind === "input_request") {
      heading("Agent 需要补充信息", 5);
      for (const question of agentQuestions(record)) {
        output.push(question.question);
        if (question.options.length) output.push(question.options.map((option) => `- ${markdownLabel(option.label)}${option.description ? `：${option.description}` : ""}`).join("\n"));
      }
    } else {
      heading(`${eventLabel(event)} ${eventStatusLabel(event.status)}`, 5);
      const text = event.kind === "approval_request" ? approvalRequestText(record)
        : textFrom(record) || (event.kind !== "command" && Object.keys(record).length ? safeJson(record) : "");
      if (text) output.push(text);
    }
  };
  groups.forEach((group, index) => {
    if (group.type === "thinking") {
      heading(running && index === groups.length - 1 ? "Agent思考中" : "Agent已思考");
      group.segments.forEach(appendSegment);
    } else appendSegment(group);
  });
  output.push(...new Set(remote.filter((event) => event.kind === "final").map((event) => splitRemoteFinalPresentation(textFrom(nestedPayload(event))).activity).filter(Boolean)));
  return output.filter(Boolean).join("\n\n");
}
