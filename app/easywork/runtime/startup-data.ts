import type { GatewayClient } from "@/app/core/gateway/client";
import type { AppView } from "./AppRuntime";

export function prefetchRouteData(api: GatewayClient, view: AppView) {
  if (view.kind === "servers") {
    api.prefetch("/api/servers?includeConversationTitles=false");
    return;
  }
  if (view.kind !== "conversation") return;
  const id = encodeURIComponent(view.conversationId);
  api.prefetch(`/api/conversations/${id}`);
  api.prefetch(`/api/conversations/${id}/messages?limit=100`);
  api.prefetch(`/api/artifacts?conversationId=${id}&limit=100`);
  api.prefetch(`/api/conversations/${id}/events?limit=2000`);
}
