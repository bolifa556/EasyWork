"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Bot, Brain, Check, ChevronDown, ChevronRight, Clipboard, Copy, FileDiff, ListChecks, LoaderCircle, MessageCircle, Search, ShieldQuestion, TerminalSquare, X } from "lucide-react";
import type { RealtimeEnvelope, TaskSummary } from "@/app/core/contracts";
import styles from "./ConversationTimeline.module.css";

type OutputSegment = { id: string; runId: string | null; content: string; target: "final" | "activity" | "handoff" | null; first: RealtimeEnvelope };
type WebSearch = { id: string; name: string; input: Record<string, unknown>; output: unknown; error: string; running: boolean };
type ThoughtEntry =
  | { type: "reasoning" | "activity"; id: string; text: string }
  | { type: "search"; id: string; search: WebSearch };
type Handoff = { userMessage: string; contextBrief: string };

const WEB_SEARCH_TOOLS = new Set(["context_get_state", "memory_search", "resource_search", "conversation_search", "skill_search"]);
const TERMINAL_WEB_KINDS = new Set(["run.context.completed", "run.completed", "run.persisted", "run.failed", "run.aborted"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

function payloadRecord(payload: unknown) {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function orderedEvents(events: RealtimeEnvelope[]) {
  return [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
}

function nestedPayload(event: RealtimeEnvelope) {
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).event && typeof (payload as Record<string, unknown>).event === "object") {
    return (payload as { event: Record<string, unknown> }).event;
  }
  return payload;
}

function textFrom(payload: unknown) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["text", "content", "command", "message", "summary", "output", "diff"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  return "";
}

function safeJson(value: unknown, limit = 12_000) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
  } catch { return String(value ?? ""); }
}

export function classifyConversationOutput(events: RealtimeEnvelope[]) {
  const segments = new Map<string, OutputSegment>();
  const persistedRuns = new Set(events.filter((event) => event.kind === "run.persisted").map((event) => event.ids.runId).filter(Boolean));
  for (const event of events) {
    const payload = event.payload as { content?: unknown; segmentId?: unknown; target?: unknown } | null;
    const segmentId = typeof payload?.segmentId === "string" ? payload.segmentId : null;
    if (!segmentId || !["run.output.delta", "run.output.committed"].includes(event.kind)) continue;
    const existing = segments.get(segmentId) ?? { id: segmentId, runId: event.ids.runId ?? null, content: "", target: null, first: event };
    if (event.kind === "run.output.delta" && typeof payload?.content === "string") {
      existing.content += payload.content;
      if (["final", "activity", "handoff"].includes(String(payload?.target))) existing.target = payload?.target as OutputSegment["target"];
    }
    if (event.kind === "run.output.committed" && ["final", "activity", "handoff"].includes(String(payload?.target))) existing.target = payload?.target as OutputSegment["target"];
    segments.set(segmentId, existing);
  }
  const ordered = [...segments.values()].sort((a, b) => a.first.occurredAt.localeCompare(b.first.occurredAt) || a.first.sequence - b.first.sequence);
  return {
    activity: ordered.filter((segment) => segment.target === "activity" && segment.content).map((segment) => ({
      ...segment.first,
      eventId: `activity:${segment.id}`,
      kind: "message",
      status: "completed",
      payload: { text: segment.content, source: "web-agent" },
    } satisfies RealtimeEnvelope)),
    streamingFinal: ordered.filter((segment) => segment.content && (segment.target === "final" || segment.target === null) && !persistedRuns.has(segment.runId)).map((segment) => segment.content).join(""),
  };
}

function webToolLabel(name: string, running: boolean) {
  const labels: Record<string, [string, string]> = {
    context_get_state: ["正在读取当前状态", "已读取当前状态"],
    memory_search: ["正在查询记忆", "已查询记忆"],
    resource_search: ["正在搜索文件", "已搜索文件"],
    conversation_search: ["正在查找对话", "已查找对话"],
    skill_search: ["正在查询 Skill", "已查询 Skill"],
  };
  return (labels[name] || ["正在查找相关内容", "已完成查询"])[running ? 0 : 1];
}

function sourceLabel(source: string) {
  return ({ memory: "记忆", resources: "文件", conversation: "对话", skills: "Skill" } as Record<string, string>)[source] || source;
}

function searchResults(output: unknown) {
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
  for (const key of ["filename", "name", "title", "semanticKey", "path", "id"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  const text = textFrom(record);
  return text ? `${text.slice(0, 72)}${text.length > 72 ? "…" : ""}` : `${sourceLabel(source)}结果 ${index + 1}`;
}

function SearchTrace({ search }: { search: WebSearch }) {
  const [open, setOpen] = useState(false);
  const [openedResult, setOpenedResult] = useState<string | null>(null);
  const results = searchResults(search.output);
  const hasDetails = Boolean(results.length || search.error || Object.keys(search.input).length);
  return <div className={`${styles.webSearch} ${open ? styles.webSearchOpen : ""}`}>
    <button className={styles.webSearchHeading} type="button" disabled={!hasDetails} aria-expanded={hasDetails ? open : undefined} onClick={() => hasDetails && setOpen((value) => !value)}>
      <Search size={15} />
      <span>{webToolLabel(search.name, search.running)}{!search.running && results.length ? ` · ${results.length} 项` : ""}</span>
      {search.running ? <LoaderCircle className={styles.spin} size={13} /> : hasDetails ? <ChevronRight className={styles.webSearchChevron} size={13} /> : null}
    </button>
    <div className={styles.webSearchMotion}><div>
      {typeof search.input.query === "string" && search.input.query ? <div className={styles.searchQuery}>{search.input.query}</div> : null}
      {search.error ? <div className={styles.searchError}>{search.error}</div> : null}
      {results.map((result, index) => {
        const expanded = openedResult === result.id;
        return <div className={`${styles.searchResult} ${expanded ? styles.searchResultOpen : ""}`} key={result.id}>
          <button type="button" onClick={() => setOpenedResult(expanded ? null : result.id)} aria-expanded={expanded}>
            <ChevronRight size={12} /><small>{sourceLabel(result.source)}</small><span>{resultTitle(result.source, result.value, index)}</span>
          </button>
          <div className={styles.searchResultMotion}><div><pre>{safeJson(result.value)}</pre></div></div>
        </div>;
      })}
    </div></div>
  </div>;
}

function buildWebTrace(events: RealtimeEnvelope[]) {
  const webEvents = orderedEvents(events.filter((event) => event.producer === "web-agent"));
  const output = classifyConversationOutput(webEvents);
  const activities = new Map(output.activity.map((event) => [event.eventId.replace(/^activity:/, ""), event]));
  const completedTools = new Map<string, RealtimeEnvelope>();
  for (const event of webEvents) {
    if (!["run.tool.completed", "run.tool.failed"].includes(event.kind)) continue;
    const callId = String(payloadRecord(event.payload).callId || "");
    if (callId) completedTools.set(callId, event);
  }
  const entries: ThoughtEntry[] = [];
  const reasoningByIteration = new Map<number, number>();
  const emittedSegments = new Set<string>();
  let handoff: Handoff | null = null;
  let activeLabel = "正在思考";
  for (const event of webEvents) {
    const payload = payloadRecord(event.payload);
    if (event.kind === "run.reasoning.delta") {
      const iteration = Number(payload.iteration || 0);
      const existingIndex = reasoningByIteration.get(iteration);
      if (existingIndex === undefined) {
        reasoningByIteration.set(iteration, entries.length);
        entries.push({ type: "reasoning", id: `reasoning:${event.ids.runId}:${iteration}`, text: String(payload.content || "") });
      } else {
        const current = entries[existingIndex];
        if (current?.type === "reasoning") current.text += String(payload.content || "");
      }
      continue;
    }
    if (event.kind === "run.output.delta") {
      const segmentId = String(payload.segmentId || "");
      const replacement = activities.get(segmentId);
      if (replacement && !emittedSegments.has(segmentId)) {
        emittedSegments.add(segmentId);
        entries.push({ type: "activity", id: replacement.eventId, text: textFrom(replacement.payload) });
      }
      continue;
    }
    if (event.kind === "run.handoff.ready") {
      handoff = {
        userMessage: String(payload.userMessage || "").trim(),
        contextBrief: String(payload.contextBrief || "").trim(),
      };
      activeLabel = "正在交给远端 Agent";
      continue;
    }
    if (event.kind !== "run.tool.started") continue;
    const name = String(payload.name || "");
    if (!WEB_SEARCH_TOOLS.has(name)) continue;
    const callId = String(payload.callId || event.eventId);
    const completed = completedTools.get(callId);
    const completedPayload = payloadRecord(completed?.payload);
    const error = payloadRecord(completedPayload.error);
    const running = !completed;
    if (running) activeLabel = webToolLabel(name, true);
    entries.push({
      type: "search",
      id: `search:${callId}`,
      search: {
        id: callId,
        name,
        input: payloadRecord(payload.input),
        output: completedPayload.output,
        error: completed?.kind === "run.tool.failed" ? String(error.message || "查询失败") : "",
        running,
      },
    });
  }
  const started = webEvents.find((event) => event.kind === "run.started");
  const terminal = [...webEvents].reverse().find((event) => TERMINAL_WEB_KINDS.has(event.kind));
  const running = Boolean(started && !terminal);
  const elapsedMs = started && terminal ? Math.max(0, Date.parse(terminal.occurredAt) - Date.parse(started.occurredAt)) : 0;
  return { entries, handoff, running, activeLabel, elapsedMs, failed: terminal?.kind === "run.failed", aborted: terminal?.kind === "run.aborted" };
}

function WebThought({ events }: { events: RealtimeEnvelope[] }) {
  const trace = useMemo(() => buildWebTrace(events), [events]);
  const [open, setOpen] = useState(false);
  if (!trace.entries.length) return null;
  const seconds = Math.max(1, Math.round(trace.elapsedMs / 1000));
  const label = trace.running ? trace.activeLabel : trace.aborted ? "思考已停止" : trace.failed ? "思考未完成" : `思考了 ${seconds} 秒`;
  return <section className={`${styles.webThought} ${open ? styles.webThoughtOpen : ""} ${trace.running ? styles.webThoughtRunning : ""}`}>
    <button type="button" className={styles.webThoughtHeading} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Brain size={16} /><span>{label}</span>
    </button>
    <div className={styles.webThoughtMotion}><div><div className={styles.webThoughtBody}>
      {trace.entries.map((entry) => entry.type === "search"
        ? <SearchTrace key={entry.id} search={entry.search} />
        : <p key={entry.id} className={entry.type === "reasoning" ? styles.reasoningText : styles.activityText}>{entry.text}</p>)}
    </div></div></div>
  </section>;
}

function WorkHandoff({ handoff }: { handoff: Handoff }) {
  const [open, setOpen] = useState(false);
  const combined = [handoff.userMessage, handoff.contextBrief].filter(Boolean).join("\n\n");
  const long = combined.length > 240;
  const previewSource = handoff.contextBrief || handoff.userMessage;
  const preview = previewSource.length > 240 ? `${previewSource.slice(0, 240).trimEnd()}…` : previewSource;
  if (!combined) return null;
  return <section className={styles.handoff}>
    <div className={styles.handoffLabel}>发给远端 Agent</div>
    {open ? <><p>{handoff.userMessage}</p>{handoff.contextBrief ? <p>{handoff.contextBrief}</p> : null}</> : <p>{preview}</p>}
    {long ? <button type="button" onClick={() => setOpen((value) => !value)}>{open ? "收起" : "查看完整内容"}</button> : null}
  </section>;
}

function eventLabel(event: RealtimeEnvelope) {
  const running = ["started", "updated", "running", "accepted", "queued", null].includes(event.status);
  if (event.kind === "reasoning") return "Agent";
  if (event.kind === "plan") return "执行计划";
  if (event.kind === "tool_call") return running ? "正在运行命令" : "运行命令";
  if (event.kind === "tool_result") return "命令结果";
  if (event.kind === "file_change") return running ? "正在编辑文件" : "编辑文件";
  if (event.kind === "approval_request") return "等待确认";
  if (event.kind === "approval_response") return "已确认";
  if (event.kind === "artifact") return "结果文件";
  if (event.kind === "job_status") return "作业状态";
  if (event.kind === "error" || event.status === "failed") return "执行出错";
  if (event.kind === "command") {
    const operation = String(payloadRecord(event.payload).operation || "");
    const names: Record<string, string> = { append: "追加指令", interrupt: "中断任务", resume: "继续任务" };
    return `${names[operation] || "任务指令"}${event.status === "completed" ? "完成" : event.status === "failed" ? "失败" : ""}`;
  }
  if (event.kind === "message") return "Agent";
  return "Agent 事件";
}

function eventIcon(kind: string) {
  if (kind === "reasoning") return <Brain size={17} />;
  if (kind === "plan") return <ListChecks size={17} />;
  if (["tool_call", "tool_result"].includes(kind)) return <TerminalSquare size={17} />;
  if (kind === "file_change") return <FileDiff size={17} />;
  if (kind.includes("approval")) return <ShieldQuestion size={17} />;
  if (kind === "artifact") return <Clipboard size={17} />;
  if (kind === "error") return <AlertTriangle size={17} />;
  if (kind === "message") return <MessageCircle size={17} />;
  return <Bot size={17} />;
}

function tone(kind: string) {
  if (kind === "plan" || kind === "reasoning") return styles.purple;
  if (kind === "file_change" || kind === "artifact") return styles.blue;
  if (kind === "error") return styles.red;
  if (kind.includes("tool")) return styles.teal;
  return styles.amber;
}

function callIdFrom(event: RealtimeEnvelope) {
  const record = payloadRecord(nestedPayload(event));
  return typeof record.callId === "string" ? record.callId : typeof record.id === "string" ? record.id : "";
}

function sourceItemId(event: RealtimeEnvelope) {
  const source = payloadRecord(payloadRecord(event.payload).source);
  return String(source.itemId || source.id || "");
}

function coalesceRemoteEvents(events: RealtimeEnvelope[]) {
  const result: RealtimeEnvelope[] = [];
  const callIndexes = new Map<string, number>();
  const textIndexes = new Map<string, number>();
  for (const event of events) {
    const callId = callIdFrom(event);
    if (event.kind === "tool_call") {
      if (callId && callIndexes.has(callId)) {
        const index = callIndexes.get(callId)!;
        result[index] = { ...result[index], ...event, eventId: result[index].eventId, occurredAt: result[index].occurredAt };
      } else {
        if (callId) callIndexes.set(callId, result.length);
        result.push(event);
      }
      continue;
    }
    if ((event.kind === "tool_result" || event.kind === "error") && callId && callIndexes.has(callId)) {
      const index = callIndexes.get(callId)!;
      const started = result[index];
      const startedPayload = payloadRecord(nestedPayload(started));
      const finishedPayload = payloadRecord(nestedPayload(event));
      result[index] = {
        ...started,
        status: event.kind === "error" || event.status === "failed" ? "failed" : "completed",
        payload: {
          ...payloadRecord(started.payload),
          event: {
            ...startedPayload,
            result: finishedPayload.output ?? finishedPayload.result ?? finishedPayload.text ?? finishedPayload,
            text: textFrom(finishedPayload),
          },
        },
      };
      continue;
    }
    if (["message", "reasoning"].includes(event.kind)) {
      const payload = payloadRecord(nestedPayload(event));
      const key = `${event.producer}:${event.kind}:${sourceItemId(event) || event.eventId}`;
      if (textIndexes.has(key)) {
        const index = textIndexes.get(key)!;
        const previous = result[index];
        const previousPayload = payloadRecord(nestedPayload(previous));
        const nextText = payload.delta ? `${textFrom(previousPayload)}${textFrom(payload)}` : textFrom(payload) || textFrom(previousPayload);
        result[index] = { ...previous, status: event.status, payload: { ...payloadRecord(previous.payload), event: { ...previousPayload, ...payload, text: nextText, delta: false } } };
      } else {
        textIndexes.set(key, result.length);
        result.push(event);
      }
      continue;
    }
    result.push(event);
  }
  return result;
}

function toolDetail(record: Record<string, unknown>) {
  const input = payloadRecord(record.input);
  const command = typeof input.command === "string" ? input.command : typeof record.command === "string" ? record.command : "";
  const result = typeof record.result === "string" ? record.result : record.result != null ? safeJson(record.result) : textFrom(record);
  const inputText = command || (Object.keys(input).length ? safeJson(input) : "");
  return [inputText, result && result !== inputText ? result : ""].filter(Boolean).join("\n\n");
}

function fileEntries(record: Record<string, unknown>) {
  if (Array.isArray(record.files)) return record.files as Array<{ path?: string; diff?: string }>;
  if (Array.isArray(record.changes)) return (record.changes as Array<Record<string, unknown>>).map((change) => ({ path: String(change.path || ""), diff: String(change.diff || "") }));
  if (record.path || record.diff) return [{ path: String(record.path || ""), diff: String(record.diff || "") }];
  return [];
}

function TimelineRow({ event }: { event: RealtimeEnvelope }) {
  const record = payloadRecord(nestedPayload(event));
  const text = event.kind.includes("tool") ? toolDetail(record) : textFrom(record);
  const items = Array.isArray(record.items) ? record.items as Array<{ id?: string; text?: string; status?: string }> : [];
  const files = fileEntries(record);
  const expandable = Boolean(text || items.length || files.length);
  const [open, setOpen] = useState(false);
  const copyText = text || items.map((item) => item.text || "").filter(Boolean).join("\n") || files.map((file) => `${file.path || "file"}\n${file.diff || ""}`).join("\n\n");
  return <div className={styles.row} data-kind={event.kind}>
    <div className={styles.head}>
      <button className={`${styles.rowButton} ${tone(event.kind)}`} aria-expanded={expandable ? open : undefined} onClick={() => expandable && setOpen((value) => !value)}>
        {expandable ? open ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <span className={styles.chevronSpace} />}
        {eventIcon(event.kind)}<span>{eventLabel(event)}</span>
        {event.producer.startsWith("agent:") ? <small>{event.producer.slice(6)}</small> : null}
        {["started", "running", "updated"].includes(String(event.status)) ? <LoaderCircle className={styles.spin} size={14} /> : null}
      </button>
      {expandable && !["reasoning", "message"].includes(event.kind) ? <button className={styles.copy} aria-label={`复制${eventLabel(event)}`} onClick={() => void navigator.clipboard.writeText(copyText)}><Copy size={14} /></button> : null}
    </div>
    {open ? <div className={styles.details}>
      {items.length ? <div className={styles.plan}>{items.map((item, index) => <div key={item.id || index} className={styles.planItem}><span className={item.status === "completed" ? styles.done : item.status === "failed" ? styles.failed : item.status === "running" ? styles.running : ""}>{item.status === "completed" ? <Check size={14} /> : <span />}</span><span>{item.text || "未命名步骤"}</span></div>)}</div> : null}
      {files.length ? <div className={styles.files}>{files.map((file, index) => <details key={`${file.path}:${index}`}><summary><FileDiff size={14} />{file.path || "未命名文件"}</summary>{file.diff ? <pre>{file.diff}</pre> : <p>Agent 未提供 diff 内容</p>}</details>)}</div> : null}
      {text ? <pre className={["reasoning", "message"].includes(event.kind) ? styles.prose : event.kind.includes("tool") ? styles.terminal : styles.body}>{text}</pre> : null}
    </div> : null}
  </div>;
}

type ActivitySegment =
  | { type: "tools"; id: string; events: RealtimeEnvelope[] }
  | { type: "files"; id: string; events: RealtimeEnvelope[] }
  | { type: "event"; id: string; event: RealtimeEnvelope };

function activitySegments(events: RealtimeEnvelope[]) {
  const segments: ActivitySegment[] = [];
  for (const event of coalesceRemoteEvents(events)) {
    const type = event.kind === "tool_call" ? "tools" : event.kind === "file_change" ? "files" : null;
    const previous = segments.at(-1);
    if (type && previous?.type === type) previous.events.push(event);
    else if (type === "tools") segments.push({ type, id: event.eventId, events: [event] });
    else if (type === "files") segments.push({ type, id: event.eventId, events: [event] });
    else segments.push({ type: "event", id: event.eventId, event });
  }
  return segments;
}

function TimelineGroup({ type, events }: { type: "tools" | "files"; events: RealtimeEnvelope[] }) {
  const running = events.some((event) => ["started", "updated", "running", "accepted", "queued", null].includes(event.status));
  const failed = events.some((event) => event.status === "failed");
  const [open, setOpen] = useState(false);
  const label = running
    ? type === "tools" ? `正在运行 ${events.length} 个命令` : `正在编辑 ${events.length} 个文件`
    : type === "tools" ? `运行了 ${events.length} 个命令` : `已编辑 ${events.length} 个文件`;
  return <section className={`${styles.group} ${failed ? styles.groupFailed : ""} ${open ? styles.groupOpen : ""}`}>
    <button type="button" className={`${styles.groupHeading} ${type === "tools" ? styles.teal : styles.blue}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {running ? <LoaderCircle className={styles.spin} size={17} /> : type === "tools" ? <TerminalSquare size={17} /> : <FileDiff size={17} />}
      <strong>{label}</strong>
      <small>{type === "tools" ? "远程终端" : "远程文件"}</small>
      <ChevronRight className={styles.groupChevron} size={14} />
    </button>
    <div className={styles.groupMotion}><div>{events.map((event) => <TimelineRow key={event.eventId} event={event} />)}</div></div>
  </section>;
}

function AgentCall({ events, status }: { events: RealtimeEnvelope[]; status: string }) {
  const segments = useMemo(() => activitySegments(events), [events]);
  const hasDetails = segments.length > 0;
  const running = !TERMINAL_TASK_STATUSES.has(status);
  const failed = status === "failed";
  const interrupted = ["interrupted", "cancelled"].includes(status);
  const [open, setOpen] = useState(Boolean(hasDetails && running));
  if (!hasDetails && !running && !failed && !interrupted) return null;
  return <section className={`${styles.agentCall} ${open ? styles.agentCallOpen : ""} ${running ? styles.agentCallRunning : ""} ${failed ? styles.agentCallFailed : ""}`}>
    <button type="button" className={styles.agentCallHeading} aria-expanded={hasDetails ? open : undefined} onClick={() => hasDetails && setOpen((value) => !value)}>
      <span className={styles.agentCallGlyph}>{running ? <LoaderCircle size={15} /> : failed ? <X size={14} /> : <Bot size={15} />}</span>
      <strong>{running ? "Agent调用中" : interrupted ? "Agent调用已停止" : failed ? "Agent调用失败" : "Agent调用完成"}</strong>
      {hasDetails ? <ChevronRight className={styles.agentCallChevron} size={14} /> : null}
    </button>
    {hasDetails ? <div className={styles.agentCallMotion}><div><div className={styles.agentActivity}>
      {segments.map((segment) => segment.type === "event"
        ? <TimelineRow key={segment.id} event={segment.event} />
        : <TimelineGroup key={segment.id} type={segment.type} events={segment.events} />)}
    </div></div></div> : null}
  </section>;
}

function visibleRemoteEvent(event: RealtimeEnvelope) {
  if (event.producer === "task-orchestrator") {
    if (event.kind === "status") return false;
    if (event.kind === "command") return !["create", "start"].includes(String(payloadRecord(event.payload).operation || ""));
  }
  if (["usage", "context_delivery", "final", "status"].includes(event.kind)) return false;
  if (event.kind === "file_change" && fileEntries(payloadRecord(nestedPayload(event))).length === 0) return false;
  if (event.kind === "job_status") {
    const record = payloadRecord(nestedPayload(event));
    if (!textFrom(record).trim() && !Array.isArray(record.items)) return false;
  }
  if (["message", "reasoning"].includes(event.kind) && !textFrom(nestedPayload(event)).trim()) return false;
  return true;
}

function remoteTaskStatus(events: RealtimeEnvelope[]) {
  const status = orderedEvents(events).filter((event) => event.producer === "task-orchestrator" && event.kind === "status").at(-1)?.status;
  if (status) return status;
  const latestTerminalEvent = orderedEvents(events).filter((event) => event.kind === "error" || event.status === "failed").at(-1);
  return latestTerminalEvent ? "failed" : events.length ? "running" : "completed";
}

export function ConversationTimeline({ events, mode = "chat" }: { events: RealtimeEnvelope[]; mode?: "chat" | "work" }) {
  const webTrace = useMemo(() => buildWebTrace(events), [events]);
  const remote = useMemo(() => orderedEvents(events.filter((event) => (event.producer === "task-orchestrator" || event.producer.startsWith("agent:")) && visibleRemoteEvent(event))), [events]);
  const remoteAll = useMemo(() => events.filter((event) => event.producer === "task-orchestrator" || event.producer.startsWith("agent:")), [events]);
  const status = remoteTaskStatus(remoteAll);
  const showThought = webTrace.entries.length > 0;
  const showHandoff = mode === "work" && webTrace.handoff;
  if (!showThought && !showHandoff && !remoteAll.length) return null;
  return <section className={styles.workflow} aria-label="Agent 活动">
    {showThought ? <WebThought events={events} /> : null}
    {showHandoff ? <WorkHandoff handoff={webTrace.handoff!} /> : null}
    {mode === "work" && remoteAll.length ? <AgentCall key={`${remoteAll[0]?.ids.taskId}:${status}`} events={remote} status={status} /> : null}
  </section>;
}

export function TaskPlanSummary({ task }: { task?: TaskSummary | null }) {
  if (!task) return <span className={styles.noPlan}>未产生远端任务</span>;
  const plan = Array.isArray(task.plan) ? task.plan : [];
  if (!plan.length) return <span className={styles.noPlan}>{["completed", "failed", "cancelled"].includes(task.status) ? "Agent 未提供执行计划" : "Agent 正在执行"}</span>;
  return <div className={styles.railPlan}>{plan.map((step) => <div key={step.id}><span data-status={step.status}>{step.status === "completed" ? <Check size={12} /> : step.status === "running" ? <LoaderCircle className={styles.spin} size={12} /> : <span />}</span><span>{step.text}</span></div>)}</div>;
}
