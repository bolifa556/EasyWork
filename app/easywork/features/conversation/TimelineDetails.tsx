"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RealtimeEnvelope } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { getTimelineDetailCache } from "./timeline-detail-cache.mjs";
import { timelineDetailIds } from "@/shared/timeline-projection.mjs";
import { useDisclosurePending } from "./DisclosureMotion";

const DetailContext = createContext<(ids: string[]) => Promise<void>>(async () => {});
const PageDetailContext = createContext<ReturnType<typeof getTimelineDetailCache> | null>(null);

export function TimelineDetailScope({ scope, events, children }: { scope: string; events: RealtimeEnvelope[]; children: ReactNode }) {
  const { api } = useAppRuntime();
  const cache = useMemo(() => getTimelineDetailCache(scope), [scope]);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
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
  useSyncExternalStore(cache.subscribe, cache.snapshot, () => 0);
  const hydrated = events.map((event) => timelineDetailIds(event).length ? cache.get(event) || event : event);
  return <DetailContext.Provider value={cache.load}>{children(hydrated)}</DetailContext.Provider>;
}

export function TimelineDetails({ events, children }: { events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const cache = useContext(PageDetailContext);
  return cache ? <CachedTimelineDetails cache={cache} events={events}>{children}</CachedTimelineDetails>
    : <LocalTimelineDetails events={events}>{children}</LocalTimelineDetails>;
}

function LocalTimelineDetails({ events, children }: { events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const { api } = useAppRuntime();
  const localId = useId();
  const cache = useMemo(() => getTimelineDetailCache(`local:${localId}`), [localId]);
  useEffect(() => {
    cache.activate(async (url: string, signal: AbortSignal) => (await api.get<{ events: RealtimeEnvelope[]; missingEventIds: string[] }>(url, signal)).data);
    return () => cache.deactivate();
  }, [api, cache]);
  useEffect(() => { cache.ingest(events); }, [cache, events]);
  return <CachedTimelineDetails cache={cache} events={events}>{children}</CachedTimelineDetails>;
}

export function useTimelineDetails(ids: string[], open: boolean) {
  const load = useContext(DetailContext);
  const key = [...new Set(ids)].sort().join(",");
  const [failure, setFailure] = useState<{ key: string; message: string; unavailable: boolean } | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!open || !key) return;
    let cancelled = false;
    void load(key.split(",")).catch((error) => {
      if (!cancelled) setFailure({ key, message: error instanceof Error ? error.message : "详情读取失败", unavailable: error?.code === "TIMELINE_DETAIL_UNAVAILABLE" });
    });
    return () => { cancelled = true; };
  }, [key, open, load, attempt]);
  const currentFailure = open && failure?.key === key ? failure : null;
  const loading = open && Boolean(key);
  useDisclosurePending(loading && !currentFailure);
  return {
    loading,
    ready: !loading || Boolean(currentFailure),
    failure: currentFailure?.message || "",
    unavailable: currentFailure?.unavailable === true,
    retry: () => { setFailure(null); retry((value) => value + 1); },
  };
}

export function TimelineDetailStatus({ state }: { state: ReturnType<typeof useTimelineDetails> }) {
  if (state.unavailable) return null;
  if (state.failure) return <p role="alert">{state.failure} <button type="button" onClick={state.retry}>重试</button></p>;
  return state.loading ? <p role="status">正在读取详情…</p> : null;
}
