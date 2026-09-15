import type { ConversationSummary } from "@/app/core/contracts";

export const CONVERSATIONS_CHANGED_EVENT = "easywork:conversations-changed";

export type ConversationsChangedDetail = {
  conversationId: string;
  kind: "created" | "updated" | "deleted" | "renamed";
  conversation?: Omit<ConversationSummary, "runningTaskId"> & { runningTaskId?: string | null };
  title?: string;
  revision?: number;
};

const CHANNEL_NAME = "easywork-conversations";
const STORAGE_KEY = "easywork.conversations-changed";

export function announceConversationsChanged(detail: ConversationsChangedDetail, { broadcast = true } = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ConversationsChangedDetail>(CONVERSATIONS_CHANGED_EVENT, { detail }));
  if (!broadcast) return;
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(detail);
    channel.close();
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ detail, nonce: `${Date.now()}:${Math.random()}` }));
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function subscribeConversationsChanged(listener: (detail: ConversationsChangedDetail) => void) {
  if (typeof window === "undefined") return () => undefined;
  const local = (event: Event) => listener((event as CustomEvent<ConversationsChangedDetail>).detail);
  const storage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try { listener(JSON.parse(event.newValue).detail as ConversationsChangedDetail); } catch { /* ignore malformed external state */ }
  };
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
  if (channel) channel.onmessage = (event) => listener(event.data as ConversationsChangedDetail);
  window.addEventListener(CONVERSATIONS_CHANGED_EVENT, local);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, local);
    window.removeEventListener("storage", storage);
    channel?.close();
  };
}
