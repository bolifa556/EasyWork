import type { ConversationDetail } from "@/app/core/contracts";
import type { GatewayClient } from "@/app/core/gateway/client";

export type ConversationReferenceSelection = {
  conversationId: string;
  title: string;
  mode: "chat" | "work";
  projectId: string | null;
  updatedAt: string;
};

export function conversationReferenceClipboard(conversation: { id: string; title: string }, origin: string) {
  const text = `${origin}/c/${encodeURIComponent(conversation.id)}`;
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return { text, html: `<a href="${escape(text)}">${escape(conversation.title)}</a>` };
}

// Only a standalone link to this EasyWork site is a reference. Pasted prose,
// Markdown exports and links to other sites retain normal textarea behavior.
export function pastedConversationId(text: string, origin: string) {
  try {
    const value = text.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) return null;
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password) return null;
    const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
    const id = match ? decodeURIComponent(match[1]) : "";
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id) ? id : null;
  } catch { return null; }
}

export async function resolveConversationReference(api: Pick<GatewayClient, "get">, id: string, currentId?: string, signal?: AbortSignal): Promise<ConversationReferenceSelection> {
  if (id === currentId) throw new Error("不能引用当前对话");
  // Resolve through the actor-scoped API; clipboard titles and permissions
  // are never trusted. Sending the message revalidates and freezes its snapshot.
  const { data } = await api.get<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`, signal);
  const { summary } = data;
  return { conversationId: summary.id, title: summary.title, mode: summary.mode, projectId: summary.projectId, updatedAt: summary.updatedAt };
}
