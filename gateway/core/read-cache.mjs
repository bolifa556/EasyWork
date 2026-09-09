// Budgets apply to disposable read models, never to durable records.
export class ReadCache {
  constructor({ maxBytes = 128 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map();
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, bytes) {
    this.delete(key);
    const weight = Math.max(1, Number(bytes) || 1);
    if (weight > this.maxBytes) return;
    this.entries.set(key, { value, bytes: weight });
    this.bytes += weight;
    while (this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  clearPrefix(prefix) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.delete(key);
  }
}

const frozen = new WeakSet();
export function freezeReadSnapshot(value) {
  if (!value || typeof value !== "object" || frozen.has(value)) return value;
  for (const child of Object.values(value)) freezeReadSnapshot(child);
  Object.freeze(value);
  frozen.add(value);
  return value;
}

export const repositoryReadCache = new ReadCache();
