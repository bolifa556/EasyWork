// HTTP is a catch-up path when a live socket is quiet/disconnected. Publish
// each page immediately; do not buffer output behind the rest of history.
export async function catchUpConversation({ conversationId, after = 0, request, onPage, signal }) {
  let cursor = after;
  let upperBound;
  let reset = false;
  for (;;) {
    signal?.throwIfAborted();
    let page;
    try {
      page = await request(`/api/conversations/${encodeURIComponent(conversationId)}/events?after=${cursor}&limit=500`, signal);
    } catch (error) {
      if (error?.code !== "REALTIME_REPLAY_EXPIRED" || reset || cursor === 0) throw error;
      cursor = 0;
      reset = true;
      continue;
    }
    signal?.throwIfAborted();
    upperBound ??= page.lastSequence ?? page.events.at(-1)?.sequence ?? cursor;
    const events = page.events.filter((event) => event.sequence <= upperBound);
    if (events.length) onPage(events);
    const next = Math.min(upperBound, page.nextAfterSequence ?? events.at(-1)?.sequence ?? cursor);
    if (!page.hasMore || next >= upperBound || next <= cursor) return Math.max(cursor, next);
    cursor = next;
  }
}
