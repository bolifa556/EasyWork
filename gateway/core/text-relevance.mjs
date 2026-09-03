function normalizedSearchText(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

function explicitTokens(value) {
  return normalizedSearchText(value).match(/[a-z0-9][a-z0-9._:/@-]*/g) || [];
}

export function requiredExplicitQueryAnchors(value) {
  const anchors = [...new Set(explicitTokens(value).filter((token) => (
    token.length >= 3
      && (/[0-9]/.test(token) || /[._:/@]/.test(token))
  )))];
  const hasExactLocator = anchors.some((token) => /[._/@:]/.test(token) && token.length >= 5);
  const hasLongNumber = anchors.some((token) => /^\d{5,}$/.test(token));
  return anchors.length >= 2 || hasExactLocator || hasLongNumber ? anchors : [];
}

export function containsExplicitQueryAnchor(value, anchors) {
  const haystack = normalizedSearchText(value);
  return (Array.isArray(anchors) ? anchors : []).some((anchor) => haystack.includes(anchor));
}
