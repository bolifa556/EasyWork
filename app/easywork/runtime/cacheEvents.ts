export const CONVERSATIONS_CHANGED_EVENT = "easywork:conversations-changed";

export type ConversationsChangedDetail = {
  conversationId: string;
  kind: "deleted" | "renamed";
};

export function announceConversationsChanged(detail: ConversationsChangedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ConversationsChangedDetail>(CONVERSATIONS_CHANGED_EVENT, { detail }));
}
