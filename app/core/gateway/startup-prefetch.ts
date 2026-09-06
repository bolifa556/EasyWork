// Short-lived, single-use requests. Never persist account data across reloads.
export class StartupPrefetch {
  private entries = new Map<string, { token: string | null; expires: number; promise: Promise<unknown> }>();

  clear() { this.entries.clear(); }

  start<T>(path: string, token: string | null, request: () => Promise<T>) {
    const current = this.entries.get(path);
    if (current?.token === token && current.expires > Date.now()) return;
    for (const [key, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(key);
    if (this.entries.size >= 24) this.entries.delete(this.entries.keys().next().value!);
    const entry = { token, expires: Date.now() + 15_000, promise: request() };
    this.entries.set(path, entry);
    void entry.promise.catch(() => {
      if (this.entries.get(path) === entry) this.entries.delete(path);
    });
  }

  take<T>(path: string, token: string | null, signal?: AbortSignal): Promise<T> | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    this.entries.delete(path);
    if (entry.token !== token || entry.expires <= Date.now()) return undefined;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (!signal) return entry.promise as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      entry.promise.then((value) => resolve(value as T), reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
