// Deliberately scoped to this loaded page: route changes reuse it, while a
// refresh, a new tab, or another device starts with no user choices. Keep both
// explicit open and explicit closed choices so live updates never override a
// disclosure after the user has touched it.
const timelineDisclosureChoices = new Map();

export function hasTimelineDisclosureChoice(identity) {
  return Boolean(identity && timelineDisclosureChoices.has(identity));
}

export function readTimelineDisclosure(identity) {
  return Boolean(identity && timelineDisclosureChoices.get(identity));
}

export function writeTimelineDisclosure(identity, open) {
  if (!identity) return;
  timelineDisclosureChoices.set(identity, Boolean(open));
}
