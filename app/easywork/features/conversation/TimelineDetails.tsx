"use client";

import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RealtimeEnvelope } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { createTimelineDetailSnapshot, getTimelineDetailCache } from "./timeline-detail-cache.mjs";
import { timelineDetailIds } from "@/shared/timeline-projection.mjs";
import { useDisclosurePending } from "./DisclosureMotion";

const DetailContext = createContext<(ids: string[]) => Promise<void>>(async () => {});
const PageDetailContext = createContext<ReturnType<typeof getTimelineDetailCache> | null>(null);

export function TimelineDetailScope({ scope, events, children }: { scope: string; events: RealtimeEnvelope[]; children: ReactNode }) {
  const { api } = useAppRuntime();
  const cache = useMemo(() => getTimelineDetailCache(scope), [scope]);
  useLayoutEffect(() => {
    cache.activate(async (url: string, signal: AbortSignal) => (await api.get<{ events: RealtimeEnvelope[]; missingEventIds: string[] }>(url, signal)).data);
    return () => cache.deactivate();
  }, [api, cache]);
  useLayoutEffect(() => { cache.ingest(events); }, [cache, events]);
  return <PageDetailContext.Provider value={cache}>{children}</PageDetailContext.Provider>;
}

function CachedTimelineDetails({ cache, events, children }: { cache: ReturnType<typeof getTimelineDetailCache>; events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const snapshot = useMemo(() => createTimelineDetailSnapshot(cache, events), [cache, events]);
  const hydrated = useSyncExternalStore(cache.subscribe, snapshot, () => events);
  const target = useRef<HTMLDivElement>(null);
  const key = timelineIntentIds(events).join(",");
  useEffect(() => {
    if (!key || !target.current || typeof IntersectionObserver === "undefined") return;
    let stopPrefetch: (() => void) | undefined;
    // Warm only readable details near the viewport, after the outline paints.
    // Command output and patches remain on demand.
    const observer = new IntersectionObserver(([entry]) => {
      stopPrefetch?.();
      if (entry.isIntersecting) {
        const midpoint = entry.boundingClientRect.top + entry.boundingClientRect.height / 2;
        stopPrefetch = cache.watchVisible(key.split(","), Math.abs(midpoint - window.innerHeight / 2));
      }
    }, { rootMargin: "160px 0px" });
    observer.observe(target.current);
    return () => { stopPrefetch?.(); observer.disconnect(); };
  }, [cache, key]);
  return <DetailContext.Provider value={cache.load}><div ref={target} style={{ minWidth: 0 }}>{children(hydrated)}</div></DetailContext.Provider>;
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
  useLayoutEffect(() => {
    cache.activate(async (url: string, signal: AbortSignal) => (await api.get<{ events: RealtimeEnvelope[]; missingEventIds: string[] }>(url, signal)).data);
    return () => cache.deactivate();
  }, [api, cache]);
  useLayoutEffect(() => { cache.ingest(events); }, [cache, events]);
  return <CachedTimelineDetails cache={cache} events={events}>{children}</CachedTimelineDetails>;
}

export function timelineIntentIds(events: RealtimeEnvelope[]) {
  return [...new Set(events.filter(event => ["reasoning", "run.reasoning.delta", "run.context.state", "run.context.read", "run.handoff.ready", "run.handoff.dispatched"].includes(event.kind)).flatMap(timelineDetailIds))] as string[];
}

// Hover intent, keyboard focus and touch-down share the same deduplicated
// foreground request. Opening a parent also prepares its readable descendants.
export function useTimelineIntent(ids: string[], open = false) {
  const load = useContext(DetailContext);
  const key = [...new Set(ids)].sort().join(",");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const intent = useMemo(() => {
    const cancel = () => clearTimeout(timer.current);
    const prepare = () => { cancel(); if (key) void load(key.split(",")).catch(() => undefined); };
    return { prepare, cancel, handlers: {
      onPointerEnter: (event: { pointerType: string }) => { if (event.pointerType === "mouse") { cancel(); timer.current = setTimeout(prepare, 100); } },
      onPointerLeave: cancel,
      onPointerDown: prepare,
      onFocus: prepare,
    } };
  }, [key, load]);
  useEffect(() => { if (open) intent.prepare(); return intent.cancel; }, [intent, open]);
  return intent.handlers;
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
  const ready = !loading || Boolean(currentFailure);
  useDisclosurePending(!ready);
  const intent = useTimelineIntent(ids);
  return {
    loading,
    ready,
    intent,
    failure: currentFailure?.message || "",
    unavailable: currentFailure?.unavailable === true,
    retry: () => { setFailure(null); retry((value) => value + 1); },
  };
}

export function TimelineDetailStatus({ state }: { state: ReturnType<typeof useTimelineDetails> }) {
  if (state.unavailable) return <p role="status">这条详情已不可用。</p>;
  if (state.failure) return <p role="alert">{state.failure} <button type="button" onClick={state.retry}>重试</button></p>;
  return null;
}
