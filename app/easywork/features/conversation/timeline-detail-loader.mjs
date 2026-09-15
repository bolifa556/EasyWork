// Explicit expansion and current-page prefetch share requests. Background work
// uses one slot and small batches, leaving capacity for explicit expansion.
export function createTimelineDetailLoader({ getEvent, isLoaded, request, onLoaded, concurrency = 4 }) {
  const unavailable = () => Object.assign(new Error("活动详情不可用"), { code: "TIMELINE_DETAIL_UNAVAILABLE" });
  const aborted = () => Object.assign(new Error("详情加载已取消"), { name: "AbortError" });
  const pending = new Map();
  const queued = new Map();
  const controller = new AbortController();
  let scheduled = false;
  let active = 0;
  let backgroundActive = 0;

  function routeFor(event) {
    return event.ids.taskId && !event.topic.startsWith("conversation:")
      ? `/api/tasks/${encodeURIComponent(event.ids.taskId)}/events/details`
      : `/api/conversations/${encodeURIComponent(event.ids.conversationId || "")}/events/details`;
  }
  function schedule() {
    if (scheduled || controller.signal.aborted) return;
    scheduled = true;
    queueMicrotask(flush);
  }
  async function read(route, entries, background) {
    active += 1;
    if (background) backgroundActive += 1;
    const ids = entries.map(([id]) => id);
    try {
      const result = await request(`${route}?${new URLSearchParams({ ids: ids.join(",") })}`, controller.signal);
      if (controller.signal.aborted) throw aborted();
      const selected = new Set(ids);
      const events = result.events.filter((event) => selected.has(event.eventId));
      if (events.length) onLoaded(events);
      const found = new Set(events.map((event) => event.eventId));
      for (const [id, waiter] of entries) {
        if (found.has(id)) waiter.resolve();
        else waiter.reject(unavailable());
      }
    } catch (error) {
      for (const [, waiter] of entries) waiter.reject(error);
    } finally {
      for (const [id, waiter] of entries) if (pending.get(id) === waiter) pending.delete(id);
      active -= 1;
      if (background) backgroundActive -= 1;
      schedule();
    }
  }
  function flush() {
    scheduled = false;
    if (controller.signal.aborted) return;
    while (active < concurrency) {
      const candidates = [...queued].filter(([, waiter]) => !waiter.background || !backgroundActive)
        .sort((a, b) => Number(a[1].background) - Number(b[1].background));
      if (!candidates.length) break;
      const [firstId, first] = candidates[0];
      const firstEvent = getEvent(firstId);
      if (!firstEvent) {
        queued.delete(firstId); pending.delete(firstId); first.reject(unavailable());
        continue;
      }
      const route = routeFor(firstEvent);
      const entries = [];
      for (const [id, waiter] of candidates) {
        const event = getEvent(id);
        if (event && waiter.background === first.background && routeFor(event) === route) {
          entries.push([id, waiter]);
          queued.delete(id);
          if (entries.length === (first.background ? 8 : 100)) break;
        }
      }
      void read(route, entries, first.background);
    }
  }
  function load(ids, { background = false } = {}) {
    if (controller.signal.aborted) return Promise.reject(aborted());
    const waits = [];
    for (const id of new Set(ids)) {
      if (isLoaded(id)) continue;
      let waiter = pending.get(id);
      if (!waiter) {
        waiter = { background };
        waiter.promise = new Promise((resolve, reject) => Object.assign(waiter, { resolve, reject }));
        pending.set(id, waiter);
        queued.set(id, waiter);
      } else if (!background) waiter.background = false;
      waits.push(waiter.promise);
    }
    if (queued.size) schedule();
    return Promise.all(waits).then(() => undefined);
  }
  load.prefetch = (ids) => load(ids, { background: true });
  load.dispose = () => {
    controller.abort();
    for (const waiter of pending.values()) waiter.reject(aborted());
    queued.clear();
    pending.clear();
  };
  return load;
}
