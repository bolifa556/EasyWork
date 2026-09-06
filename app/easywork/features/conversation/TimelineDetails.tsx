"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RealtimeEnvelope } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { createTimelineDetailLoader } from "./timeline-detail-loader.mjs";

const DetailContext = createContext<(ids: string[]) => Promise<void>>(async () => {});

export function TimelineDetails({ events, children }: { events: RealtimeEnvelope[]; children: (events: RealtimeEnvelope[]) => ReactNode }) {
  const { api } = useAppRuntime();
  const [loaded, setLoaded] = useState<Map<string, RealtimeEnvelope>>(() => new Map());
  const loadedRef = useRef(loaded);
  const byId = useMemo(() => new Map(events.map((event) => [event.eventId, event])), [events]);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const load = useMemo(() => createTimelineDetailLoader({
    getEvent: (id: string) => byIdRef.current.get(id),
    isLoaded: (id: string) => loadedRef.current.has(id),
    request: async (url: string) => (await api.get<{ events: RealtimeEnvelope[]; missingEventIds: string[] }>(url)).data,
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
  return { loading: open && Boolean(key), failure: currentFailure?.message || "", unavailable: currentFailure?.unavailable === true, retry: () => retry((value) => value + 1) };
}

export function TimelineDetailStatus({ state }: { state: ReturnType<typeof useTimelineDetails> }) {
  if (state.unavailable) return null;
  if (state.failure) return <p role="alert">{state.failure} <button type="button" onClick={state.retry}>重试</button></p>;
  return state.loading ? <p role="status">正在读取详情…</p> : null;
}
