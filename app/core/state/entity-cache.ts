import { useSyncExternalStore } from "react";

export type CacheKey = readonly (string | number | null | undefined)[];

type CacheEntry<T> = {
  data?: T;
  error?: unknown;
  status: "idle" | "loading" | "ready" | "error";
  updatedAt: number;
  promise?: Promise<T>;
  listeners: Set<() => void>;
  version: number;
};

const stableKey = (key: CacheKey) => JSON.stringify(key);

export class EntityCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  snapshot<T>(key: CacheKey): Readonly<CacheEntry<T>> {
    return this.entry<T>(stableKey(key));
  }

  version(key: CacheKey) {
    return this.entry(stableKey(key)).version;
  }

  subscribe(key: CacheKey, listener: () => void) {
    const entry = this.entry(stableKey(key));
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  async fetch<T>(key: CacheKey, loader: (signal: AbortSignal) => Promise<T>, options: { maxAge?: number; signal?: AbortSignal } = {}) {
    const normalizedKey = stableKey(key);
    const entry = this.entry<T>(normalizedKey);
    const maxAge = options.maxAge ?? 0;
    if (entry.status === "ready" && Date.now() - entry.updatedAt <= maxAge) return entry.data as T;
    if (entry.promise) return entry.promise;
    const controller = new AbortController();
    options.signal?.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
    entry.status = "loading";
    entry.error = undefined;
    this.emit(entry);
    const promise = loader(controller.signal)
      .then((data) => {
        entry.data = data;
        entry.status = "ready";
        entry.updatedAt = Date.now();
        return data;
      })
      .catch((error) => {
        if (controller.signal.aborted) throw error;
        entry.error = error;
        entry.status = "error";
        throw error;
      })
      .finally(() => {
        entry.promise = undefined;
        this.emit(entry);
      });
    entry.promise = promise;
    return promise;
  }

  set<T>(key: CacheKey, updater: T | ((current: T | undefined) => T)) {
    const entry = this.entry<T>(stableKey(key));
    entry.data = typeof updater === "function"
      ? (updater as (current: T | undefined) => T)(entry.data)
      : updater;
    entry.error = undefined;
    entry.status = "ready";
    entry.updatedAt = Date.now();
    this.emit(entry);
  }

  invalidate(prefix: CacheKey) {
    const prefixText = JSON.stringify(prefix).slice(0, -1);
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefixText)) continue;
      entry.updatedAt = 0;
      this.emit(entry);
    }
  }

  remove(prefix: CacheKey) {
    const prefixText = JSON.stringify(prefix).slice(0, -1);
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefixText)) this.entries.delete(key);
    }
  }

  private entry<T>(key: string) {
    let entry = this.entries.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      entry = { status: "idle", updatedAt: 0, listeners: new Set(), version: 0 };
      this.entries.set(key, entry as CacheEntry<unknown>);
    }
    return entry;
  }

  private emit(entry: CacheEntry<unknown>) {
    entry.version += 1;
    for (const listener of entry.listeners) listener();
  }
}

export const entityCache = new EntityCache();

export function useEntitySnapshot<T>(key: CacheKey, cache = entityCache) {
  useSyncExternalStore(
    (listener) => cache.subscribe(key, listener),
    () => cache.version(key),
    () => cache.version(key),
  );
  return cache.snapshot<T>(key);
}
