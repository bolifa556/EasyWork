// Deliberately scoped to this loaded page: route changes reuse it, while a
// refresh, a new tab, or another device starts with no user choices. Keep both
// explicit open and explicit closed choices so live updates do not override a
// disclosure after the user has touched it. A completed parent scope is the
// deliberate exception: it closes its whole descendant tree.
const timelineDisclosureChoices = new Map();
const updatingDisclosureScopes = new Set();
const timelineDisclosureListeners = new Map();

function notifyTimelineDisclosure(identity) {
  for (const listener of timelineDisclosureListeners.get(identity) || []) listener();
}

export function subscribeTimelineDisclosure(identity, listener) {
  if (!identity) return () => {};
  let listeners = timelineDisclosureListeners.get(identity);
  if (!listeners) {
    listeners = new Set();
    timelineDisclosureListeners.set(identity, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) timelineDisclosureListeners.delete(identity);
  };
}

export function hasTimelineDisclosureChoice(identity) {
  return Boolean(identity && timelineDisclosureChoices.has(identity));
}

export function readTimelineDisclosure(identity) {
  return Boolean(identity && timelineDisclosureChoices.get(identity));
}

export function writeTimelineDisclosure(identity, open) {
  if (!identity) return;
  const next = Boolean(open);
  if (timelineDisclosureChoices.has(identity) && timelineDisclosureChoices.get(identity) === next) return;
  timelineDisclosureChoices.set(identity, next);
  notifyTimelineDisclosure(identity);
}

export function collapseTimelineDisclosureDescendants(identity) {
  if (!identity) return false;
  const prefix = `${identity}:`;
  const changedIdentities = new Set();
  for (const key of [...updatingDisclosureScopes]) {
    if (!key.startsWith(prefix)) continue;
    updatingDisclosureScopes.delete(key);
    if (timelineDisclosureChoices.get(key) !== false) changedIdentities.add(key);
    timelineDisclosureChoices.set(key, false);
  }
  for (const [key, open] of timelineDisclosureChoices) {
    if (!key.startsWith(prefix)) continue;
    if (open) changedIdentities.add(key);
    // Keep an explicit closed choice so a still-settling child cannot reopen
    // itself from its automatic `updating` state on the same render.
    timelineDisclosureChoices.set(key, false);
  }
  for (const key of changedIdentities) notifyTimelineDisclosure(key);
  return changedIdentities.size > 0;
}

export function updateTimelineDisclosureScope(identity, updating) {
  if (!identity) return false;
  if (updating) {
    updatingDisclosureScopes.add(identity);
    return false;
  }
  // A scope may finish while its conversation is not mounted. Retain the live
  // marker in page memory so the first completed render still closes children.
  if (!updatingDisclosureScopes.delete(identity)) return false;
  return collapseTimelineDisclosureDescendants(identity);
}
