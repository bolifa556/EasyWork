import crypto from "node:crypto";

const text = (value) => String(value || "").trim();
const digest = (value) => crypto.createHash("sha256").update(text(value).replace(/\r\n/g, "\n")).digest("hex");
const sourceKey = (value) => `${text(value?.conversationId)}\0${text(value?.snapshotId)}`;

export function collectConversationReferences(messages, currentMessageId) {
  const references = new Map();
  if (!Array.isArray(messages) || !messages.some((message) => message.id === currentMessageId)) return [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message.role === "user") {
      for (const reference of message.references || []) {
        if (!reference.referenceId || !reference.conversationId || !reference.snapshotId) continue;
        references.set(sourceKey(reference), { ...reference, sourceMessageId: message.id });
      }
    }
    if (message.id === currentMessageId) break;
  }
  return [...references.values()];
}

function referenceOf(fragment) {
  return fragment?.presented?.reference;
}

export function isConversationReferenceObservation(fragment) {
  return fragment?.toolName === "conversation_reference_search"
    || text(fragment?.knowledge?.key).startsWith("conversation-reference:");
}

export function filterReferenceObservations(fragments, references) {
  const allowed = new Set(references.map(sourceKey));
  return fragments.filter((fragment) => !isConversationReferenceObservation(fragment)
    || allowed.has(sourceKey(referenceOf(fragment))));
}

function memoryKey(entry) {
  // Equal facts need not be repeated through another reference. Changed facts
  // have a different digest and remain readable.
  return digest(entry?.content?.value ?? entry?.content ?? entry?.text);
}

function messageKey(entry) {
  // Message ids are immutable across frozen snapshots.
  return `${text(entry?.sourceConversationId)}\0${text(entry?.id)}\0${text(entry?.role)}`;
}

const turnKey = (entry) => `${text(entry?.sourceConversationId)}\0${text(entry?.sourceSnapshotId)}\0${text(entry?.referenceTurnId || entry?.id)}`;

function referenceMessages(value) {
  return [...(value?.recentConversation || []), ...(value?.matchedConversation || [])];
}

export function conversationReferenceReadState(reference, fragments) {
  const turns = new Set();
  const memories = new Set();
  for (const fragment of fragments) {
    if (!isConversationReferenceObservation(fragment) || sourceKey(referenceOf(fragment)) !== sourceKey(reference)) continue;
    for (const entry of fragment.presented?.memory || []) memories.add(memoryKey(entry));
    for (const entry of referenceMessages(fragment.presented)) turns.add(text(entry.referenceTurnId || entry.id));
  }
  return { ...reference, readTurns: turns.size, readMemories: memories.size };
}

export function pruneReadConversationReference(output, observedFragments) {
  const knownMessages = new Set();
  const knownMemories = new Set();
  const knownTurns = new Set();
  for (const fragment of observedFragments || []) {
    if (isConversationReferenceObservation(fragment)) {
      for (const entry of referenceMessages(fragment.presented)) {
        knownMessages.add(messageKey(entry));
        if (fragment.knowledge?.key === `conversation-reference:${entry.sourceConversationId}:${entry.sourceSnapshotId}:${entry.referenceTurnId || entry.id}`) {
          knownTurns.add(turnKey(entry));
        }
      }
      for (const entry of fragment.presented?.memory || []) knownMemories.add(memoryKey(entry));
    } else if (text(fragment?.knowledge?.key).startsWith("memory:")) {
      knownMemories.add(digest(fragment.knowledge.content));
    }
  }
  const unreadTurns = (entries = []) => {
    const groups = new Map();
    for (const entry of entries) {
      const key = text(entry.referenceTurnId || entry.id);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return [...groups.values()].filter((group) => !knownTurns.has(turnKey(group[0]))
      && !group.every((entry) => knownMessages.has(messageKey(entry)))).flat();
  };
  const memory = (output?.memory || []).filter((entry) => !knownMemories.has(memoryKey(entry)));
  const recentConversation = unreadTurns(output?.recentConversation);
  const matchedConversation = unreadTurns(output?.matchedConversation);
  const hadResults = (output?.memory?.length || 0) + referenceMessages(output).length > 0;
  return {
    output: { ...output, memory, recentConversation, matchedConversation },
    allObserved: hadResults && !memory.length && !recentConversation.length && !matchedConversation.length,
  };
}
