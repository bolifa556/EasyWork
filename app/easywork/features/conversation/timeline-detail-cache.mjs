import { createTimelineDetailLoader } from "./timeline-detail-loader.mjs";

const pages = new Map();
const MAX_BYTES = 64 * 1024 * 1024;
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
    prefetch() {
      const ids = [...source.values()].filter(event => deferred(event) && !page.get(event) && !attempted.has(event.eventId)).map(event => event.eventId);
      ids.forEach(id => attempted.add(id));
      return loader && ids.length ? loader.prefetch(ids) : Promise.resolve();
    },
    deactivate() {
      loader?.dispose(); loader = null; page.active = false;
      source.clear(); attempted.clear(); trimCache();
    },
    reset() {
      loader?.dispose(); loader = null; page.active = false;
      loaded.clear(); source.clear(); attempted.clear(); page.bytes = 0;
      version += 1; for (const listener of listeners) listener();
    },
  };
  pages.set(scope, page);
  return page;
}
