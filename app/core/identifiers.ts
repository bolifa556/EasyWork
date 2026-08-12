let fallbackSequence = 0;

function uuidFromRandomValues(source: Crypto) {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomIdentifier() {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  if (typeof source?.getRandomValues === "function") return uuidFromRandomValues(source);

  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function prefixedIdentifier(prefix: string) {
  return `${prefix}_${randomIdentifier()}`;
}
