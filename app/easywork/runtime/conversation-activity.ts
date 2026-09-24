import type { BootstrapResponse, ConversationActivitySnapshot } from "../../core/contracts";

export function mergeConversationActivity(
  current: ConversationActivitySnapshot | undefined,
  incoming: ConversationActivitySnapshot | undefined,
) {
  if (!incoming) return current;
  if (current?.instanceId === incoming.instanceId && current.revision >= incoming.revision) return current;
  return incoming;
}

export function applyConversationActivity(
  current: BootstrapResponse | null,
  incoming: ConversationActivitySnapshot,
) {
  // Historical events from a previous gateway process cannot resurrect its
  // runs. Bootstrap establishes the current process, including after reconnect.
  if (!current || current.conversationActivity?.instanceId !== incoming.instanceId) return current;
  const activity = mergeConversationActivity(current.conversationActivity, incoming);
  return activity === current.conversationActivity ? current : { ...current, conversationActivity: activity };
}
