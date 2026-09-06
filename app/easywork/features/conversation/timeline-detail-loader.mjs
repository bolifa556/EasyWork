// Only rows that are actually expanded request details. Sibling rows opened
// in the same render share a request, without prefetching their descendants.
export function createTimelineDetailLoader({ getEvent, isLoaded, request, onLoaded }) {
  const unavailable = () => Object.assign(new Error("活动详情不可用"), { code: "TIMELINE_DETAIL_UNAVAILABLE" });
  const pending = new Map();
  const queued = new Map();
  let scheduled = false;

  async function read(route, entries) {
    const ids = entries.map(([id]) => id);
    try {
      const result = await request(`${route}?${new URLSearchParams({ ids: ids.join(",") })}`);
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
      for (const [id] of entries) pending.delete(id);
    }
  }

  function flush() {
    scheduled = false;
    const groups = new Map();
    for (const [id, waiter] of queued) {
      const event = getEvent(id);
      if (!event) {
        waiter.reject(unavailable());
        pending.delete(id);
        continue;
      }
      const route = event.ids.taskId && !event.topic.startsWith("conversation:")
        ? `/api/tasks/${encodeURIComponent(event.ids.taskId)}/events/details`
        : `/api/conversations/${encodeURIComponent(event.ids.conversationId || "")}/events/details`;
      if (!groups.has(route)) groups.set(route, []);
      groups.get(route).push([id, waiter]);
    }
    queued.clear();
    for (const [route, entries] of groups) {
      // Keep GET URLs bounded; all requested rows are still read.
      for (let offset = 0; offset < entries.length; offset += 100) void read(route, entries.slice(offset, offset + 100));
    }
  }

  return function load(ids) {
    const waits = [];
    for (const id of new Set(ids)) {
      if (isLoaded(id)) continue;
      let waiter = pending.get(id);
      if (!waiter) {
        waiter = {};
        waiter.promise = new Promise((resolve, reject) => Object.assign(waiter, { resolve, reject }));
        pending.set(id, waiter);
        queued.set(id, waiter);
      }
      waits.push(waiter.promise);
    }
    if (queued.size && !scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
    return Promise.all(waits).then(() => undefined);
  };
}
