import type { AgentSummary } from "@/app/core/contracts";

export type AgentConfigField = {
  key: string;
  label: string;
  type: "string" | "enum" | "number";
  nativeKey: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
};

export type AgentConfiguration = {
  agentId: string;
  configScope?: string;
  source: "managed" | "user";
  managed: boolean;
  writable: boolean;
  inherited?: boolean;
  path?: string;
  revision: number | null;
  updatedAt?: string | null;
  fields: AgentConfigField[];
  values: Record<string, string>;
  reason?: string;
};

type CachedConfiguration = { configuration: AgentConfiguration; savedAt: number };

const memory = new Map<string, CachedConfiguration>();
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
// Configuration field labels/options are part of the cached payload. Keep the
// cache namespace versioned so a UI/schema release cannot keep rendering stale
// option metadata for up to MAX_AGE_MS (for example, pre-bilingual labels).
const PREFIX = "easywork.agent-configuration:v3:";

function cacheKey(actorId: string | undefined, serverId: string, configScope: string, agentId: string) {
  if (!actorId || !serverId || !configScope || !agentId) return null;
  return `${actorId}:${serverId}:${configScope}:${agentId}`;
}

function valid(value: CachedConfiguration | null): value is CachedConfiguration {
  return Boolean(value
    && Number.isFinite(value.savedAt)
    && Date.now() - value.savedAt <= MAX_AGE_MS
    && value.configuration
    && typeof value.configuration === "object"
    && typeof value.configuration.agentId === "string"
    && Array.isArray(value.configuration.fields)
    && value.configuration.values
    && typeof value.configuration.values === "object");
}

export function readAgentConfigurationCache(actorId: string | undefined, serverId: string, configScope: string, agentId: string) {
  const key = cacheKey(actorId, serverId, configScope, agentId);
  if (!key) return null;
  const known = memory.get(key);
  if (valid(known || null)) return structuredClone(known!.configuration);
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(`${PREFIX}${key}`) || "null") as CachedConfiguration | null;
    if (!valid(parsed)) return null;
    memory.set(key, parsed);
    return structuredClone(parsed.configuration);
  } catch { return null; }
}

export function writeAgentConfigurationCache(actorId: string | undefined, serverId: string, configScope: string, configuration: AgentConfiguration) {
  const key = cacheKey(actorId, serverId, configScope, configuration.agentId);
  if (!key) return;
  const existing = readAgentConfigurationCache(actorId, serverId, configScope, configuration.agentId);
  const existingRevision = Number(existing?.revision);
  const nextRevision = Number(configuration.revision);
  if (Number.isSafeInteger(existingRevision) && Number.isSafeInteger(nextRevision) && existingRevision > nextRevision) return;
  const cached = { configuration: structuredClone({ ...configuration, configScope }), savedAt: Date.now() };
  memory.delete(key);
  memory.set(key, cached);
  while (memory.size > 120) memory.delete(memory.keys().next().value as string);
  if (typeof window === "undefined") return;
  try { localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(cached)); } catch { /* the in-memory snapshot remains usable */ }
}

export function copyAgentConfigurationCache(actorId: string | undefined, serverId: string, sourceScope: string, targetScope: string, agentIds: string[]) {
  for (const agentId of agentIds) {
    const configuration = readAgentConfigurationCache(actorId, serverId, sourceScope, agentId);
    if (configuration) writeAgentConfigurationCache(actorId, serverId, targetScope, { ...configuration, configScope: targetScope, revision: 0 });
  }
}

export function mergeCachedAgentConfigurations(agents: AgentSummary[], actorId: string | undefined, serverId: string, configScope: string) {
  return agents.map((agent) => {
    const qoderReady = agent.agentId === "qoder-cn"
      && agent.installed
      && agent.status === "ready"
      && agent.authentication?.authenticated === true;
    // Deployment state is server-wide and can be reused immediately across
    // conversations.  Model/config values are conversation-scoped, though, so
    // never leak another scope's values while using that shared inventory.
    const scopedAgent = agent.configuration?.configScope && agent.configuration.configScope !== configScope
      ? { ...agent, configuration: null, model: null, configured: qoderReady }
      : agent;
    const cached = readAgentConfigurationCache(actorId, serverId, configScope, agent.agentId);
    const remote = agent.configuration?.configScope === configScope ? agent.configuration as AgentConfiguration : null;
    const cachedRevision = Number(cached?.revision);
    const remoteRevision = Number(remote?.revision);
    const configuration = remote && (
      !cached
      || (Number.isSafeInteger(remoteRevision)
        && (!Number.isSafeInteger(cachedRevision) || remoteRevision > cachedRevision))
    ) ? remote : cached;
    if (!configuration) return scopedAgent;
    const model = String(configuration.values.model || "").trim() || null;
    return {
      ...scopedAgent,
      configuration,
      model,
      configured: scopedAgent.agentId === "qoder-cn"
        ? qoderReady
        : Boolean(scopedAgent.installed && scopedAgent.status === "ready" && model),
    };
  });
}
