const DEFERRED_REWIND_AGENTS = new Set(["claude-code", "qoder-cn"]);

export function legacyRegenerationFork(binding) {
  const pendingFork = binding?.native?.pendingFork;
  if (!DEFERRED_REWIND_AGENTS.has(String(binding?.adapterId || ""))
    || !pendingFork
    || typeof pendingFork !== "object"
    || Array.isArray(pendingFork)) return null;
  const sourceSessionId = String(pendingFork.sourceSessionId || "");
  const targetSessionId = String(pendingFork.targetSessionId || "");
  const resumeSessionAt = String(pendingFork.resumeSessionAt || "");
  const bindingId = String(binding.agentBindingId || "");
  const runtimeBindingId = String(binding.native?.runtimeBindingId || bindingId);
  // Webpage branches deliberately share their source binding's native store.
  // The removed implementation of regenerate instead wrote a pending fork to
  // the same binding/store.  That identity difference lets existing explicit
  // branches remain untouched while repairing only the obsolete regenerate
  // state.
  if (!sourceSessionId || !targetSessionId || !resumeSessionAt || !bindingId || runtimeBindingId !== bindingId) return null;
  return { sourceSessionId, targetSessionId, resumeSessionAt };
}

export function migrateLegacyRegenerationFork(binding) {
  const legacy = legacyRegenerationFork(binding);
  if (!legacy) return null;
  const migrated = structuredClone(binding);
  migrated.state = {
    ...(migrated.state || {}),
    sessionId: legacy.sourceSessionId,
    turnId: legacy.resumeSessionAt,
    status: "idle",
  };
  migrated.native = {
    ...(migrated.native || {}),
    sessionId: legacy.sourceSessionId,
    turnId: legacy.resumeSessionAt,
    pendingFork: null,
    pendingRewind: {
      sessionId: legacy.sourceSessionId,
      resumeSessionAt: legacy.resumeSessionAt,
    },
  };
  return {
    binding: migrated,
    receiptSourceSessionId: legacy.targetSessionId,
    receiptTargetSessionId: legacy.sourceSessionId,
  };
}
