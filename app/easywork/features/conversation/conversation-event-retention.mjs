function taskIdOf(event) {
  return String(event.ids.taskId || "");
}

function sourceMessageIdOf(event) {
  return String(event.ids.sourceMessageId || "");
}

export function mergeConversationEvents(current, incoming) {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  let upgraded = false;
  for (const event of incoming) {
    const previous = byId.get(event.eventId);
    if (!previous) byId.set(event.eventId, event);
    else if (previous.payload?.timelineDetailIds?.length && !event.payload?.timelineDetailIds?.length) {
      byId.set(event.eventId, event);
      upgraded = true;
    }
  }
  if (!upgraded && byId.size === current.length) return current;
  const ordered = [...byId.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
  const retained = new Map();
  const previousByTopic = new Map();
  for (const event of ordered) {
    const previous = previousByTopic.get(event.topic);
    const key = event.payload?.realtimeStreamKey;
    const previousKey = previous?.payload?.realtimeStreamKey;
    // A stream key identifies a contiguous cumulative segment, not an entire
    // turn. Do not let a late newline erase reasoning before an output event.
    if (key && key === previousKey && previous.ids?.runId === event.ids?.runId) {
      const text = event.payload.content ?? event.payload.event?.text;
      const priorText = previous.payload.content ?? previous.payload.event?.text;
      if (typeof text === "string" && typeof priorText === "string" && text.startsWith(priorText)) retained.delete(previous.eventId);
    }
    retained.set(event.eventId, event);
    previousByTopic.set(event.topic, event);
  }
  return [...retained.values()];
}

/**
 * Current events are retained only through durable message/task/run identity.
 * Editing a turn therefore cannot hide an unrelated turn, and a deleted turn
 * cannot survive through a timestamp coincidence.
 */
export function retainConversationEvents(current, nextMessages, conversationId, taskById = {}) {
  const retainedMessageIds = new Set(nextMessages.map((message) => message.id));
  const retainedTaskIds = new Set(nextMessages.map((message) => message.taskId).filter(Boolean));
  const retainedRunIds = new Set();
  for (const task of Object.values(taskById || {})) {
    if (!task || !retainedMessageIds.has(String(task.sourceMessageId || ""))) continue;
    if (task.id) retainedTaskIds.add(String(task.id));
    if (task.conversationRunId) retainedRunIds.add(String(task.conversationRunId));
  }
  for (const event of current) {
    const sourceMessageId = sourceMessageIdOf(event);
    const persistedMessageId = String(event.ids.messageId || "");
    if ((sourceMessageId && retainedMessageIds.has(sourceMessageId))
      || (persistedMessageId && retainedMessageIds.has(persistedMessageId))
      || (taskIdOf(event) && retainedTaskIds.has(taskIdOf(event)))) {
      if (event.ids.runId) retainedRunIds.add(event.ids.runId);
    }
  }

  for (const event of current) {
    const eventTaskId = taskIdOf(event);
    if (!eventTaskId) continue;
    const sourceMessageId = sourceMessageIdOf(event);
    if ((sourceMessageId && retainedMessageIds.has(sourceMessageId))
      || (event.ids.runId && retainedRunIds.has(event.ids.runId))) retainedTaskIds.add(eventTaskId);
  }

  return current.filter((event) => {
    const eventTaskId = taskIdOf(event);
    // A derived conversation intentionally references the immutable Task
    // journal of its pre-fork turns.  Those envelopes keep their source
    // conversation identity, but the retained Task reference is sufficient
    // authority to render them in the child.
    if (event.ids.conversationId && event.ids.conversationId !== conversationId && (!eventTaskId || !retainedTaskIds.has(eventTaskId))) return false;
    const sourceMessageId = sourceMessageIdOf(event);
    if (sourceMessageId) return retainedMessageIds.has(sourceMessageId) || Boolean(eventTaskId && retainedTaskIds.has(eventTaskId));
    const persistedMessageId = String(event.ids.messageId || "");
    if (persistedMessageId) return retainedMessageIds.has(persistedMessageId) || Boolean(eventTaskId && retainedTaskIds.has(eventTaskId));
    if (eventTaskId) return retainedTaskIds.has(eventTaskId);
    if (event.ids.runId) return retainedRunIds.has(event.ids.runId);
    return false;
  });
}
