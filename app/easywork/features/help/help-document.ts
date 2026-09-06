export type HelpPayload = { content: string; mediaType: string; etag: string; lastModified: string };
let cached: HelpPayload | null = null;
let loadedAt = 0;
let pending: Promise<HelpPayload> | null = null;

export function cachedHelpDocument() { return cached; }

export function loadHelpDocument() {
  if (pending) return pending;
  if (cached && Date.now() - loadedAt < 60_000) return Promise.resolve(cached);
  pending = (async () => {
    // This document is public and identical for every visitor. It can load
    // while a new device establishes its guest session.
    const response = await fetch("/api/help", { credentials: "omit", headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok || !body.data?.content?.trim()) throw new Error(body.error?.message || "帮助读取失败");
    cached = body.data;
    loadedAt = Date.now();
    return cached!;
  })().finally(() => { pending = null; });
  return pending;
}

export function prefetchHelpDocument() { void loadHelpDocument().catch(() => undefined); }
