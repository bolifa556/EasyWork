import { createTimelineDetailLoader } from "./timeline-detail-loader.mjs";

const pages = new Map();
const MAX_BYTES = 64 * 1024 * 1024;
const PREFETCH_RECENT_EVENTS = 24;
let retainedBytes = 0;
const deferred = (event) => Array.isArray(event?.payload?.timelineDetailIds) && event.payload.timelineDetailIds.length > 0;
const identity = (event) => `${event?.actorId || ""}:${event?.ids?.taskId || event?.ids?.conversationId || ""}:${event?.sequence ?? ""}`;

function trimCache() {
  for (const [key, page] of pages) {
    if (retainedBytes <= MAX_BYTES) break;
    if (page.active) continue;
    retainedBytes -= page.bytes;
    page.reset();
    pages.delete(key);
  }
}
export function clearTimelineDetailCache() {
  for (const page of pages.values()) page.reset();
  pages.clear();
  retainedBytes = 0;
}
export function getTimelineDetailCache(scope) {
  if (pages.has(scope)) {
    const page = pages.get(scope);
    pages.delete(scope); pages.set(scope, page);
    return page;
  }
  const loaded = new Map();
  const listeners = new Set();
  let version = 0;
  let source = new Map();
  let loader = null;
  let attempted = new Set();
  const visible = new Map();
  let visibleTimer = null;
  const clearVisible = () => { clearTimeout(visibleTimer); visibleTimer = null; visible.clear(); };
  const page = {
    active: false,
    bytes: 0,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() { return version; },
    get(event) {
      const cached = loaded.get(event.eventId);
      return cached && identity(cached.event) === identity(event) ? cached.event : undefined;
    },
    ingest(events) { source = new Map(events.map(event => [event.eventId, event])); },
    activate(request) {
      page.active = true;
      attempted = new Set();
      loader = createTimelineDetailLoader({
        getEvent: id => source.get(id),
        isLoaded: id => { const event = source.get(id); return Boolean(event && (!deferred(event) || page.get(event))); },
        request,
        onLoaded: events => {
          let changed = false;
          for (const event of events) {
            const current = source.get(event.eventId);
            if (!current || identity(current) !== identity(event) || page.get(current)) continue;
            const previous = loaded.get(event.eventId);
            const bytes = JSON.stringify(event).length * 2 + 256;
            loaded.set(event.eventId, { event, bytes });
            page.bytes += bytes - (previous?.bytes || 0);
            retainedBytes += bytes - (previous?.bytes || 0);
            changed = true;
          }
          if (changed) { version += 1; for (const listener of listeners) listener(); trimCache(); }
        },
      });
    },
    load(ids) { return loader ? loader(ids) : Promise.resolve(); },
    watchVisible(ids, distance = 0) {
      const token = Symbol();
      visible.set(token, { ids, distance });
      // One viewport selection pass collects adjacent messages together. The
      // loader's existing batch sizes and concurrency remain unchanged.
      if (visibleTimer === null) visibleTimer = setTimeout(() => {
        visibleTimer = null;
        const selected = [...visible.values()].sort((a, b) => a.distance - b.distance).flatMap(item => item.ids);
        void page.prefetch(selected).catch(() => undefined);
      }, 80);
      return () => visible.delete(token);
    },
    prefetch(requestedIds) {
      // Warm the newest part of the conversation; old collapsed history should
      // not compete with the detail the user is opening or fill the cache.
      const candidates = requestedIds ? [...new Set(requestedIds)].map(id => source.get(id)).filter(Boolean)
        : [...source.values()].filter(deferred).slice(-PREFETCH_RECENT_EVENTS).reverse();
      const ids = candidates.filter(deferred)
        .filter(event => !page.get(event) && !attempted.has(event.eventId)).map(event => event.eventId);
      ids.forEach(id => attempted.add(id));
      return loader && ids.length ? loader.prefetch(ids) : Promise.resolve();
    },
    deactivate() {
      clearVisible();
      loader?.dispose(); loader = null; page.active = false;
      source.clear(); attempted.clear(); trimCache();
    },
    reset() {
      clearVisible();
      loader?.dispose(); loader = null; page.active = false;
      loaded.clear(); source.clear(); attempted.clear(); page.bytes = 0;
      version += 1; for (const listener of listeners) listener();
    },
  };
  pages.set(scope, page);
  return page;
}

// A detail update must retain the snapshot of every unrelated message. React
// can then skip re-projecting and re-rendering the rest of a long conversation.
export function createTimelineDetailSnapshot(cache, events) {
  let snapshot = events;
  return () => {
    const next = events.map(event => deferred(event) ? cache.get(event) || event : event);
    if (next.some((event, index) => event !== snapshot[index])) snapshot = next;
    return snapshot;
  };
}
