import type { BootstrapResponse, ConversationSummary } from "@/app/core/contracts";
import type { ConversationsChangedDetail } from "./cacheEvents";

type Summary = Omit<ConversationSummary, "runningTaskId"> & { runningTaskId?: string | null };

function newerSummary(previous: ConversationSummary, incoming: Summary): ConversationSummary {
  if (previous.revision > incoming.revision) return previous;
  const next = { ...incoming, runningTaskId: incoming.runningTaskId === undefined ? previous.runningTaskId : incoming.runningTaskId };
  return Object.keys(next).every(key => JSON.stringify(previous[key as keyof ConversationSummary]) === JSON.stringify(next[key as keyof ConversationSummary])) ? previous : next;
}

// Keep existing rows in place, update only changed records, and prepend new
// conversations. A renamed title must not reorder or truncate loaded history.
export function reconcileConversationRows(current: ConversationSummary[], incoming: Summary[], projectId: string | null, insert = true, placement: "prepend" | "append" = "prepend") {
  const updates = new Map(incoming.map(item => [item.id, item]));
  const known = new Set(current.map(item => item.id));
  const existing = current.map(item => updates.has(item.id) ? newerSummary(item, updates.get(item.id)!) : item)
    .filter(item => item.projectId === projectId);
  const added = insert ? [...updates.values()].filter(item => !known.has(item.id) && item.projectId === projectId)
    .map(item => ({ ...item, runningTaskId: item.runningTaskId ?? null })) : [];
  const next = (placement === "append" ? [...existing, ...added] : [...added, ...existing]).sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
}

export function preserveConversationRows(current: ConversationSummary[], incoming: ConversationSummary[]) {
  const known = new Map(current.map(item => [item.id, item]));
  const next = incoming.map(item => known.has(item.id) ? newerSummary(known.get(item.id)!, item) : item);
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
}

export function applyConversationListChange(current: ConversationSummary[], change: ConversationsChangedDetail, projectId: string | null) {
  if (change.kind === "deleted") return current.some(item => item.id === change.conversationId) ? current.filter(item => item.id !== change.conversationId) : current;
  if (change.conversation) return reconcileConversationRows(current, [change.conversation], projectId, change.kind !== "renamed");
  if (change.kind !== "renamed" || !change.title) return current;
  const previous = current.find(item => item.id === change.conversationId);
  if (!previous || previous.revision > (change.revision ?? previous.revision)) return current;
  return reconcileConversationRows(current, [{ ...previous, title: change.title, revision: change.revision ?? previous.revision }], projectId, false);
}

// Pagination cursors read an immutable index generation. Keep one latest change
// per conversation so an older page cannot restore a moved/deleted row or title.
export function mergeConversationListChange(previous: ConversationsChangedDetail | undefined, change: ConversationsChangedDetail): ConversationsChangedDetail {
  if (!previous || change.kind === "deleted" || change.kind === "created") return change;
  if (previous.kind === "deleted") return previous;
  const previousRevision = previous.conversation?.revision ?? previous.revision;
  const revision = change.conversation?.revision ?? change.revision;
  if (previousRevision !== undefined && revision !== undefined && previousRevision > revision) return previous;
  if (change.conversation) return change;
  if (change.kind !== "renamed" || !change.title) return previous;
  if (!previous.conversation) return change;
  return { ...change, kind: previous.kind,
    conversation: { ...previous.conversation, title: change.title, revision: revision ?? previous.conversation.revision } };
}

export function reconcileConversationPage(current: ConversationSummary[], incoming: Summary[], projectId: string | null, changes: Iterable<ConversationsChangedDetail>, placement: "prepend" | "append" = "prepend") {
  let rows = reconcileConversationRows(current, incoming, projectId, true, placement);
  for (const change of changes) rows = applyConversationListChange(rows, change, projectId);
  return rows.length === current.length && rows.every((item, index) => item === current[index]) ? current : rows;
}

export function applyBootstrapConversationChange(current: BootstrapResponse | null, change: ConversationsChangedDetail) {
  if (!current) return current;
  const recentConversations = applyConversationListChange(current.recentConversations, change, null);
  const navigation = current.conversationNavigation;
  const conversation = navigation?.conversation ?? null;
  const selected = conversation && conversation.id === change.conversationId
    ? applyConversationListChange([conversation], change, change.conversation ? change.conversation.projectId : conversation.projectId)[0] ?? null : conversation;
  const page = navigation?.projectConversations;
  const items = page ? applyConversationListChange(page.items, change, page.projectId) : undefined;
  const conversationNavigation = navigation && (selected !== conversation || items !== page?.items)
    ? { ...navigation, conversation: selected, projectConversations: page ? { ...page, items: items! } : null } : navigation;
  return recentConversations === current.recentConversations && conversationNavigation === navigation ? current : { ...current, recentConversations, conversationNavigation };
}
