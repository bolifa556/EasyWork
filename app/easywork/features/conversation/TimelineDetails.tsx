"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RealtimeEnvelope } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { createTimelineDetailLoader } from "./timeline-detail-loader.mjs";
import { getTimelineDetailCache } from "./timeline-detail-cache.mjs";
import { timelineDetailIds } from "@/shared/timeline-projection.mjs";
import { useDisclosurePending } from "./DisclosureMotion";

const DetailContext = createContext<(ids: string[]) => Promise<void>>(async () => {});
const PageDetailContext = createContext<ReturnType<typeof getTimelineDetailCache> | null>(null);

export function TimelineDetailScope({ scope, events, children }: { scope: string; events: RealtimeEnvelope[]; children: ReactNode }) {
  const { api } = useAppRuntime();
  const cache = useMemo(() => getTimelineDetailCache(scope), [scope]);
  const currentEvents = useRef(events);
  currentEvents.current = events;
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    cache.ingest(currentEvents.current);
    cache.activate(async (url: string, signal: AbortSignal) => (await api.get<{ events: RealtimeEnvelope[]; missingEventIds: string[] }>(url, signal)).data);
    return () => {
      if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current);
      prefetchTimer.current = null;
      cache.deactivate();
    };
  }, [api, cache]);
  useEffect(() => {
    cache.ingest(events);
    if (prefetchTimer.current !== null) return;
    // The page shell and outlines paint first. Only this mounted conversation
    // supplies event IDs; navigation disposes its queued/in-flight requests.
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null;
      void cache.prefetch().catch(() => undefined);
    }, 80);
  }, [cache, events]);
  return <PageDetailContext.Provider value={cache}>{children}</PageDetailContext.Provider>;
}

function CachedTimelineDetails({ cache, events, children }: { cache: ReturnType<typeof getTimelineDetailCache>; events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const version = useSyncExternalStore(cache.subscribe, cache.snapshot, () => 0);
  const hydrated = useMemo(() => events.map((event) => timelineDetailIds(event).length ? cache.get(event) || event : event), [cache, events, version]);
  return <DetailContext.Provider value={cache.load}>{children(hydrated)}</DetailContext.Provider>;
}

export function TimelineDetails({ events, children }: { events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const cache = useContext(PageDetailContext);
  return cache ? <CachedTimelineDetails cache={cache} events={events}>{children}</CachedTimelineDetails>
    : <LocalTimelineDetails events={events}>{children}</LocalTimelineDetails>;
}

function LocalTimelineDetails({ events, children }: { events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const { api } = useAppRuntime();
  const [loaded, setLoaded] = useState<Map<string, RealtimeEnvelope>>(() => new Map());
  const loadedRef = useRef(loaded);
  const byId = useMemo(() => new Map(events.map((event) => [event.eventId, event])), [events]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const load = useMemo(() => createTimelineDetailLoader({
    getEvent: (id: string) => byIdRef.current.get(id),
    isLoaded: (id: string) => loadedRef.current.has(id),
    request: async (url: string, signal: AbortSignal) => (await api.get<{ events: RealtimeEnvelope[]; missingEventIds: string[] }>(url, signal)).data,
    onLoaded: (incoming: RealtimeEnvelope[]) => {
      const next = new Map(loadedRef.current);
      for (const event of incoming) next.set(event.eventId, event);
      loadedRef.current = next;
      setLoaded(next);
    },
  }), [api]);
  const hydrated = useMemo(() => events.map((event) => loaded.get(event.eventId) || event), [events, loaded]);
  return <DetailContext.Provider value={load}>{children(hydrated)}</DetailContext.Provider>;
}

export function useTimelineDetails(ids: string[], open: boolean) {
  const load = useContext(DetailContext);
  const key = [...new Set(ids)].sort().join(",");
  const [failure, setFailure] = useState<{ key: string; message: string; unavailable: boolean } | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!open || !key) return;
    let cancelled = false;
    setFailure(null);
    void load(key.split(",")).catch((error) => {
      if (!cancelled) setFailure({ key, message: error instanceof Error ? error.message : "详情读取失败", unavailable: error?.code === "TIMELINE_DETAIL_UNAVAILABLE" });
    });
    return () => { cancelled = true; };
  }, [key, open, load, attempt]);
  const currentFailure = open && failure?.key === key ? failure : null;
  const loading = open && Boolean(key);
  useDisclosurePending(loading && !currentFailure);
  return { loading, ready: !loading || Boolean(currentFailure), failure: currentFailure?.message || "", unavailable: currentFailure?.unavailable === true, retry: () => retry((value) => value + 1) };
}

export function TimelineDetailStatus({ state }: { state: ReturnType<typeof useTimelineDetails> }) {
  if (state.unavailable) return null;
  if (state.failure) return <p role="alert">{state.failure} <button type="button" onClick={state.retry}>重试</button></p>;
  return state.loading ? <p role="status">正在读取详情…</p> : null;
}
