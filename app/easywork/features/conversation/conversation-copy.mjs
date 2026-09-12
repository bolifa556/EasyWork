import { mergeConversationEvents } from "./conversation-event-retention.mjs";

export function splitRemoteFinalPresentation(value) {
  const content = String(value || "").replace(/\r\n/g, "\n").trim();
  const match = content.match(/^([\s\S]*?\S)\n{2,}(#{1,6}[ \t]+\S[\s\S]*)$/);
  if (!match) return { activity: "", body: content };
  const activity = match[1].trim(), body = match[2].trim();
  const lines = activity.split("\n").filter((line) => line.trim());
  const structured = /^(?:#{1,6}[ \t]|[-*+][ \t]|\d+\.[ \t]|```|>)/m.test(activity);
  return !activity || !body || structured || activity.length > 500 || lines.length > 3
    ? { activity: "", body: content } : { activity, body };
}

// Read an immutable message snapshot, including pages outside the viewport.
export async function loadConversationCopy(api, conversationId, includeActivity = false) {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}`;
  const { data: detail } = await api.get(path);
  const messages = [];
  const cursors = new Set();
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: "100", branchId: detail.summary.activeBranchId });
    if (cursor) query.set("cursor", cursor);
    const result = await api.get(`${path}/messages?${query}`);
    messages.push(...result.data.items);
    cursor = result.data.nextCursor ?? result.meta?.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error("对话分页已更新，请重新复制。");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const snapshot = { detail, messages, events: [], tasks: {} };
  if (!includeActivity) return snapshot;

  async function replay(route) {
    const events = [];
    let after = 0;
    let upperBound;
    for (;;) {
      const { data } = await api.get(`${route}?after=${after}&limit=2000`);
      upperBound ??= data.lastSequence ?? data.events.at(-1)?.sequence ?? 0;
      events.push(...data.events.filter((event) => event.sequence <= upperBound));
      if (!data.hasMore || data.nextAfterSequence >= upperBound) break;
      if (!(data.nextAfterSequence > after)) throw new Error("活动记录分页已更新，请重新复制。");
      after = data.nextAfterSequence;
    }
    return events;
  }

  const webEvents = await replay(`${path}/events`);
  const messageIds = new Set(messages.flatMap((message) => [message.id, message.originMessageId].filter(Boolean)));
  const taskIds = new Set(messages.map((message) => message.taskId).filter(Boolean));
  for (const event of webEvents) {
    if (event.ids.taskId && messageIds.has(event.ids.sourceMessageId)) taskIds.add(event.ids.taskId);
  }
  // Task journals also retain the web trace inherited by a fork. Read only
  // Tasks actually referenced by the selected branch, never other branches.
  const taskEvents = [];
  for (const taskId of taskIds) {
    const taskPath = `/api/tasks/${encodeURIComponent(taskId)}`;
    const [task, history] = await Promise.all([api.get(taskPath), replay(`${taskPath}/events`)]);
    snapshot.tasks[taskId] = task.data;
    taskEvents.push(...history);
  }
  snapshot.events = mergeConversationEvents([], [...webEvents, ...taskEvents]);
  return snapshot;
}

export function markdownFence(value, language = "") {
  const text = String(value ?? "");
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

export function markdownLabel(value) {
  return String(value || "").replace(/\r?\n/g, " ").replace(/[\\`*_[\]<>#]/g, "\\$&");
}

// Both copy choices use the same question/answer order. Activity is inserted
// before its answer; uncompleted turns retain the activity available so far.
/** @param {{ includeActivity?: boolean, activityMarkdown?: (input: any) => string, answerBody?: (value: string) => string, origin?: string }} options */
export function conversationCopyMarkdown(snapshot, { includeActivity = false, activityMarkdown = () => String(), answerBody = (value) => value, origin = "" } = {}) {
  const { detail, messages, events, tasks } = snapshot;
  const groups = groupConversationTimeline(messages, events, tasks);
  const output = [`# ${markdownLabel(detail.summary.title)}`];
  const emitted = new Set();
  const appendActivity = (messageId, finalText = "", taskId = "") => {
    if (!includeActivity || !messageId || emitted.has(messageId)) return;
    emitted.add(messageId);
    const ownedEvents = groups.timelineByUserMessage.get(messageId) || [];
    const activity = activityMarkdown({ events: ownedEvents, mode: detail.summary.mode, taskIdHint: taskId, finalTextHint: finalText, taskById: tasks });
    if (activity.trim()) output.push(activity.trim());
  };
  let pendingUser = null;
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      appendActivity(pendingUser);
      pendingUser = message.id;
      const references = (message.references || []).map((reference) => `[${markdownLabel(reference.title)}](<${origin}/c/${encodeURIComponent(reference.conversationId)}>)`);
      output.push(`## 你\n\n${[references.join(" · "), message.content].filter(Boolean).join("\n\n")}`);
    } else if (message.role === "assistant") {
      const text = detail.summary.mode === "work" && message.taskId ? answerBody(message.content) : message.content;
      output.push("## EasyWork");
      appendActivity(pendingUser, text, message.taskId || "");
      if (text.trim()) output.push(text.trim());
      pendingUser = null;
    }
  }
  appendActivity(pendingUser);
  return `${output.join("\n\n").trim()}\n`;
}

/**
 * @param {import('../../../core/contracts').ConversationMessage[]} messages
 * @param {import('../../../core/contracts').RealtimeEnvelope[]} events
 * @param {Record<string, import('../../../core/contracts').TaskSummary>} tasks
 */
export function groupConversationTimeline(messages, events, tasks = {}) {
  const users = messages.filter((message) => message.role === "user");
  const taskIdByUserMessage = new Map();
  let owner = null;
  for (const message of messages) {
    if (message.role === "user") { owner = message.id; continue; }
    if (owner && message.taskId) taskIdByUserMessage.set(owner, message.taskId);
    owner = null;
  }
  const runStartByUserMessage = new Map();
  const userRecords = users.map((message) => {
    const sourceId = message.originMessageId || message.id;
    const runStart = events.filter((event) => event.kind === "run.started" && event.ids.sourceMessageId === sourceId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence).at(-1);
    if (runStart) runStartByUserMessage.set(message.id, runStart);
    const handoff = runStart?.ids.runId ? events.find((event) => event.kind === "run.handoff.dispatched" && event.ids.runId === runStart.ids.runId) : undefined;
    const taskId = String(handoff?.ids.taskId || taskIdByUserMessage.get(message.id) || "");
    if (taskId) taskIdByUserMessage.set(message.id, taskId);
    return { message, task: taskId ? tasks[taskId] ?? null : null };
  });
  const timelineByUserMessage = new Map();
  for (const message of users) {
    const sourceId = message.originMessageId || message.id;
    const runId = runStartByUserMessage.get(message.id)?.ids.runId;
    const taskId = taskIdByUserMessage.get(message.id);
    const owned = events.filter((event) => {
      if (taskId && event.ids.taskId) {
        return event.ids.taskId === taskId && event.ids.sourceMessageId === sourceId
          && (!runId || !event.ids.runId || event.ids.runId === runId);
      }
      if (event.ids.sourceMessageId) {
        if (event.ids.sourceMessageId !== sourceId) return false;
        return runId && event.ids.runId ? event.ids.runId === runId : !runId;
      }
      if (runId && event.ids.runId === runId) return true;
      const task = tasks[event.ids.taskId];
      if (task?.sourceMessageId) return task.sourceMessageId === sourceId;
      return Boolean(runId && task?.conversationRunId === runId);
    });
    if (owned.length) timelineByUserMessage.set(message.id, owned);
  }
  const timelineByAssistantMessage = new Map();
  const usersWithAssistant = new Set();
  let responseUserId = null;
  for (const message of messages) {
    if (message.role === "user") { responseUserId = message.id; continue; }
    if (!responseUserId) continue;
    usersWithAssistant.add(responseUserId);
    const timeline = timelineByUserMessage.get(responseUserId);
    if (timeline?.length) timelineByAssistantMessage.set(message.id, timeline);
    responseUserId = null;
  }
  return { userRecords, timelineByUserMessage, timelineByAssistantMessage, usersWithAssistant };
}
