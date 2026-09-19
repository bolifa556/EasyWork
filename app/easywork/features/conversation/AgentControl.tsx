"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Database, Download, FileText, FolderSearch, LoaderCircle, LogIn, Plus, RefreshCw, Save, Settings2, Trash2, X } from "lucide-react";
import type { AgentSummary, ModelProviderSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Modal } from "../../ui/Modal";
import { AgentContextRing } from "../../ui/ProgressRing";
import {
  readAgentConfigurationCache,
  writeAgentConfigurationCache,
  type AgentConfiguration,
} from "./agent-configuration-cache";
import styles from "./AgentControl.module.css";

type Usage = { used?: number; limit?: number; ratio?: number };
type ContextState =
  | { status: "idle" | "loading"; usage: null; reason: null }
  | { status: "ready"; usage: { used: number; limit: number | null; ratio: number | null }; reason: null }
  | { status: "unavailable"; usage: null; reason: string };
type ModelSummary = {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  isNew?: boolean;
  isFree?: boolean;
  priceFactor?: number | null;
  originalPriceFactor?: number | null;
  contextTiers?: { label: string; tokens: number; isDefault: boolean }[];
  defaultContextWindow?: number | null;
  efforts?: string[];
  defaultEffort?: string | null;
  promotion?: { active: boolean; badge?: Record<string, string>; discountFactor?: number; originalPriceFactor?: number } | null;
};
type QoderQuota = { total: number | null; used: number | null; remaining: number | null; percentage: number | null; unit: string | null };
type QoderUsage = {
  userQuota: QoderQuota | null;
  addOnQuota: QoderQuota | null;
  orgResourcePackage: (QoderQuota & { available?: boolean }) | null;
  totalUsagePercentage: number | null;
  expiresAt: number | null;
  isQuotaExceeded: boolean;
};
type QoderCatalog = { agentId: "qoder-cn"; models: ModelSummary[]; usage: QoderUsage | null; usageError?: string | null; fetchedAt: string };
type CachedQoderCatalog = { value: QoderCatalog; savedAt: number };
type AgentUpdate = { agentId: string; installedVersion: string; availableVersion: string; updateAvailable: boolean };
type MenuPage = "root" | "config" | "models";
type MenuAnchor = { top: number; right: number; bottom: number; left: number };

const initialContext: ContextState = { status: "idle", usage: null, reason: null };
type CachedContext = { state: Extract<ContextState, { status: "ready" }>; contextRevision: number; savedAt: number };
const agentContextCache = new Map<string, CachedContext>();
// v4 also drops Qoder snapshots created before native context_usage_ratio was
// preserved, so the first open after upgrading reads the corrected binding.
const AGENT_CONTEXT_CACHE_PREFIX = "easywork.agent-context:v4:";
const QODER_CATALOG_CACHE_PREFIX = "easywork.qoder-catalog:v1:";
const QODER_CATALOG_CACHE_SCOPE = "qoder-cn";
const QODER_CATALOG_FRESH_MS = 5 * 60_000;
const QODER_CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const qoderCatalogCache = new Map<string, CachedQoderCatalog>();

function readCachedContext(key: string | null) {
  if (!key) return null;
  const memory = agentContextCache.get(key);
  if (memory) return memory;
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(`${AGENT_CONTEXT_CACHE_PREFIX}${key}`) || "null") as CachedContext | null;
    if (!parsed || parsed.state?.status !== "ready" || !Number.isFinite(parsed.savedAt) || Date.now() - parsed.savedAt > 30 * 24 * 60 * 60 * 1_000) return null;
    if (!Number.isFinite(parsed.state.usage?.used) || parsed.state.usage.used < 0) return null;
    agentContextCache.set(key, parsed);
    return parsed;
  } catch { return null; }
}

function writeCachedContext(key: string | null, value: CachedContext) {
  if (!key) return;
  agentContextCache.delete(key);
  agentContextCache.set(key, value);
  while (agentContextCache.size > 80) agentContextCache.delete(agentContextCache.keys().next().value as string);
  if (typeof window === "undefined") return;
  try { localStorage.setItem(`${AGENT_CONTEXT_CACHE_PREFIX}${key}`, JSON.stringify(value)); } catch { /* memory cache remains available */ }
}

function clearCachedContext(key: string | null) {
  if (!key) return;
  agentContextCache.delete(key);
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(`${AGENT_CONTEXT_CACHE_PREFIX}${key}`); } catch { /* nothing else to clear */ }
}

function qoderCatalogKey(actorId: string | undefined, serverId: string, agent: AgentSummary | undefined) {
  if (!actorId || !agent) return null;
  // The native catalog belongs to the signed-in Qoder account on this server.
  // Agent version arrives asynchronously during discovery and changes after an
  // update; including it here made the same catalog look empty on each scan.
  return `${actorId}:${serverId}:${QODER_CATALOG_CACHE_SCOPE}`;
}

function validCachedQoderCatalog(value: CachedQoderCatalog | null) {
  return Boolean(value
    && Array.isArray(value.value?.models)
    && Number.isFinite(value.savedAt)
    && Date.now() - value.savedAt <= QODER_CATALOG_MAX_AGE_MS);
}

function readCachedQoderCatalog(key: string | null) {
  if (!key) return null;
  const memory = qoderCatalogCache.get(key);
  if (memory && Date.now() - memory.savedAt <= QODER_CATALOG_MAX_AGE_MS) return memory;
  if (typeof window === "undefined") return null;
  try {
    const storageKey = `${QODER_CATALOG_CACHE_PREFIX}${key}`;
    let parsed = JSON.parse(localStorage.getItem(storageKey) || "null") as CachedQoderCatalog | null;
    // Migrate the previous actor:server:agent-version entries. Pick the newest
    // usable snapshot so an upgrade keeps displaying the last verified native
    // model name while the background refresh checks for catalog changes.
    if (!validCachedQoderCatalog(parsed) && key.endsWith(`:${QODER_CATALOG_CACHE_SCOPE}`)) {
      const legacyPrefix = `${QODER_CATALOG_CACHE_PREFIX}${key.slice(0, -QODER_CATALOG_CACHE_SCOPE.length)}`;
      for (let index = 0; index < localStorage.length; index += 1) {
        const candidateKey = localStorage.key(index);
        if (!candidateKey?.startsWith(legacyPrefix) || candidateKey === storageKey) continue;
        const candidate = JSON.parse(localStorage.getItem(candidateKey) || "null") as CachedQoderCatalog | null;
        if (validCachedQoderCatalog(candidate) && (!validCachedQoderCatalog(parsed) || candidate!.savedAt > parsed!.savedAt)) parsed = candidate;
      }
      if (validCachedQoderCatalog(parsed)) localStorage.setItem(storageKey, JSON.stringify(parsed));
    }
    if (!validCachedQoderCatalog(parsed)) return null;
    qoderCatalogCache.set(key, parsed!);
    return parsed!;
  } catch { return null; }
}

function writeCachedQoderCatalog(key: string | null, value: QoderCatalog) {
  if (!key) return;
  const cached = { value, savedAt: Date.now() };
  qoderCatalogCache.delete(key);
  qoderCatalogCache.set(key, cached);
  while (qoderCatalogCache.size > 24) qoderCatalogCache.delete(qoderCatalogCache.keys().next().value as string);
  if (typeof window === "undefined") return;
  try { localStorage.setItem(`${QODER_CATALOG_CACHE_PREFIX}${key}`, JSON.stringify(cached)); } catch { /* memory cache remains available */ }
}

function sameQoderModels(left: ModelSummary[], right: ModelSummary[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function operationAvailable(agent: AgentSummary | undefined, operation: "contextUsage" | "compact") {
  return agent?.runtimeCapabilities?.[operation]?.availability === "available";
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function formatCredits(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function qoderModelPrice(model: ModelSummary) {
  const priceFactor = typeof model.priceFactor === "number" ? model.priceFactor : model.promotion?.discountFactor;
  const originalPriceFactor = typeof model.originalPriceFactor === "number" ? model.originalPriceFactor : model.promotion?.originalPriceFactor;
  if (model.isFree || priceFactor === 0) return "免费";
  if (typeof priceFactor !== "number" || !Number.isFinite(priceFactor)) return "";
  const current = `${Number(priceFactor).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}× Credits`;
  return typeof originalPriceFactor === "number" && Number.isFinite(originalPriceFactor) && originalPriceFactor !== priceFactor
    ? `${current}（原 ${Number(originalPriceFactor).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}×）`
    : current;
}

function qoderQuotaSummary(quota: QoderQuota | null | undefined) {
  if (!quota) return null;
  const unit = quota.unit || "Credits";
  const valid = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (valid(quota.remaining) && valid(quota.total)) return `${formatCredits(quota.remaining)} / ${formatCredits(quota.total)} ${unit}`;
  if (valid(quota.used) && valid(quota.total)) return `已用 ${formatCredits(quota.used)} / ${formatCredits(quota.total)} ${unit}`;
  if (valid(quota.percentage)) return `已用 ${formatCredits(quota.percentage)}%`;
  return null;
}

function qoderModelLabel(modelId: string, models: ModelSummary[], loading = false) {
  const normalized = String(modelId || "auto").trim() || "auto";
  const native = models.find((model) => model.id === normalized);
  if (native?.name) return native.name;
  if (normalized === "auto") return "Auto";
  // Internal qmodel_* identifiers are transport details. Keep them out of the
  // UI even during the first catalog read or after a model disappears.
  return loading ? "正在读取模型" : "当前模型";
}

function missingConfigurationLabel(agent: AgentSummary, needsLogin: boolean) {
  if (needsLogin) return "需要登录";
  if (agent.agentId === "qoder-cn") return agent.model ? "当前模型" : "自动选择";
  return agent.managed && !agent.configured ? "需要配置api" : null;
}

function sourceOf(agent: AgentSummary) {
  return agent.managed || agent.source === "managed" ? "managed" : "user";
}

function errorText(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) return fallback;
  const details = (reason as Error & { details?: unknown }).details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const body = String((details as { body?: unknown }).body || "").trim();
    if (body) {
      try {
        const parsed = JSON.parse(body) as { error?: { name?: unknown; message?: unknown } | string; message?: unknown };
        const remote = typeof parsed.error === "string"
          ? parsed.error
          : String(parsed.error?.message || parsed.error?.name || parsed.message || "").trim();
        if (remote) return `${reason.message}：${remote}`;
      } catch { return `${reason.message}：${body.slice(0, 240)}`; }
    }
  }
  return reason.message || fallback;
}

function errorCode(reason: unknown) {
  if (!reason || typeof reason !== "object") return "";
  return String((reason as { code?: unknown }).code || "");
}

export function AgentSelectionList({
  agents,
  selectedAgentId,
  disabled,
  installingAgentId,
  loggingInAgentId,
  onSelect,
  onInstall,
  onLogin,
  onManualAdd,
}: {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  disabled?: boolean;
  installingAgentId?: string | null;
  loggingInAgentId?: string | null;
  onSelect: (agentId: string) => Promise<void>;
  onInstall?: (agentId: string) => Promise<void>;
  onLogin?: (agentId: string) => Promise<void>;
  onManualAdd?: () => void;
}) {
  const [switching, setSwitching] = useState<string | null>(null);
  const select = async (agentId: string) => {
    if (agentId === selectedAgentId || switching || disabled) return;
    setSwitching(agentId);
    try { await onSelect(agentId); }
    finally { setSwitching(null); }
  };
  return <div className={styles.selectionPanel}>
    <div className={styles.agentList}>{agents.map((agent) => {
      const ready = agent.installed && agent.status === "ready";
      const needsLogin = agent.authentication?.required === true && !agent.authentication.authenticated;
      const requirement = missingConfigurationLabel(agent, needsLogin);
      const modelLabel = agent.agentId === "qoder-cn" ? requirement : agent.model || requirement;
      return ready ? <div className={styles.agentReadyRow} key={agent.agentId}><button className={agent.agentId === selectedAgentId ? styles.activeAgent : undefined} disabled={Boolean(switching) || disabled} onClick={() => void select(agent.agentId)}>
        <span><Bot size={15} /><span className={styles.agentIdentity}><strong>{agent.displayName}{modelLabel ? <small>{modelLabel}</small> : null}</strong><small>EasyWork已部署</small></span></span>
        {switching === agent.agentId ? <LoaderCircle className={styles.spin} size={15} /> : agent.agentId === selectedAgentId ? <Check size={15} /> : null}
      </button>{needsLogin && onLogin ? <button className={styles.installButton} disabled={Boolean(loggingInAgentId) || Boolean(switching) || disabled} onClick={() => void onLogin(agent.agentId)}>{loggingInAgentId === agent.agentId ? <LoaderCircle className={styles.spin} size={14} /> : <LogIn size={14} />}{loggingInAgentId === agent.agentId ? "等待登录" : "登录"}</button> : null}</div> : <div className={styles.agentUnavailable} key={agent.agentId}>
        <span><Bot size={15} /><span className={styles.agentIdentity}><strong>{agent.displayName}{agent.installed && modelLabel ? <small>{modelLabel}</small> : null}</strong><small>{agent.installed ? "EasyWork已部署" : "未部署"}</small></span></span>
        {agent.capabilities.install === "available" && onInstall ? <button className={styles.installButton} disabled={Boolean(installingAgentId) || disabled} onClick={() => void onInstall(agent.agentId)}>{installingAgentId === agent.agentId ? <LoaderCircle className={styles.spin} size={14} /> : <Download size={14} />}{installingAgentId === agent.agentId ? "安装中" : "安装"}</button> : null}
      </div>;
    })}
      {onManualAdd ? <button className={styles.manualRow} onClick={onManualAdd}><FolderSearch size={15} />手动添加</button> : null}
    </div>
  </div>;
}

export function AgentControl({
  serverId,
  agents,
  selectedAgentId,
  bindingId,
  bindingIdsByAgent,
  contextRevision,
  cacheScope,
  workspacePath,
  disabled,
  canConfigure = true,
  installingAgentId = null,
  loggingInAgentId = null,
  onBeforeSelect,
  onSelect,
  onInstall,
  onLogin,
  onConfigure,
  onManualAdd,
  onAgentsChanged,
  triggerVariant = "toolbar",
  triggerLabel,
  loading = false,
  loadError = null,
  onRetry,
  initialPage = "root",
}: {
  serverId: string;
  agents: AgentSummary[];
  selectedAgentId: string | null;
  bindingId: string | null;
  bindingIdsByAgent?: Readonly<Record<string, string>>;
  contextRevision: number;
  cacheScope: string;
  workspacePath: string | null;
  disabled?: boolean;
  canConfigure?: boolean;
  installingAgentId?: string | null;
  loggingInAgentId?: string | null;
  onBeforeSelect?: (agentId: string) => Promise<boolean>;
  onSelect: (agentId: string) => Promise<void>;
  onInstall?: (agentId: string) => Promise<void>;
  onLogin?: (agentId: string) => Promise<void>;
  onConfigure?: (agent: AgentSummary) => void;
  onManualAdd?: () => void;
  onAgentsChanged?: () => Promise<void>;
  triggerVariant?: "toolbar" | "setup";
  triggerLabel?: string;
  loading?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
  initialPage?: "root" | "config";
}) {
  const runtime = useAppRuntime();
  const actorId = runtime.bootstrap?.actor.id;
  const qoderAgent = agents.find((agent) => agent.agentId === "qoder-cn");
  const qoderCatalogCacheKey = qoderCatalogKey(actorId, serverId, qoderAgent);
  const contextCacheKey = actorId && bindingId && selectedAgentId
    ? `${actorId}:${serverId}:${cacheScope}:${bindingId}:${selectedAgentId}`
    : null;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [selectingAgentId, setSelectingAgentId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<{ agentId: string; message: string } | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [page, setPage] = useState<MenuPage>("root");
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [config, setConfig] = useState<AgentConfiguration | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configMutationError, setConfigMutationError] = useState<string | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [contextLimitDraft, setContextLimitDraft] = useState("");
  const [context, setContext] = useState<ContextState>(() => readCachedContext(contextCacheKey)?.state ?? initialContext);
  const [compacting, setCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [deploymentBusy, setDeploymentBusy] = useState<string | null>(null);
  const [updateAgent, setUpdateAgent] = useState<AgentSummary | null>(null);
  const [updateState, setUpdateState] = useState<AgentUpdate | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<AgentSummary | null>(null);
  const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [qoderCatalogStateKey, setQoderCatalogStateKey] = useState(qoderCatalogCacheKey);
  const [storedQoderModels, setQoderModels] = useState<ModelSummary[]>(() => readCachedQoderCatalog(qoderCatalogCacheKey)?.value.models ?? []);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [storedQoderUsage, setQoderUsage] = useState<QoderUsage | null>(() => readCachedQoderCatalog(qoderCatalogCacheKey)?.value.usage ?? null);
  const [qoderUsageBusy, setQoderUsageBusy] = useState(false);
  const [storedQoderUsageError, setQoderUsageError] = useState<string | null>(() => {
    const cached = readCachedQoderCatalog(qoderCatalogCacheKey);
    return cached?.value.usageError || (cached && !cached.value.usage ? "Qoder 当前未返回积分信息" : null);
  });
  const qoderCatalogStateCurrent = qoderCatalogStateKey === qoderCatalogCacheKey;
  const currentCachedQoderCatalog = qoderCatalogStateCurrent
    ? null
    : readCachedQoderCatalog(qoderCatalogCacheKey);
  const qoderModels = qoderCatalogStateCurrent ? storedQoderModels : currentCachedQoderCatalog?.value.models ?? [];
  const qoderUsage = qoderCatalogStateCurrent ? storedQoderUsage : currentCachedQoderCatalog?.value.usage ?? null;
  const qoderUsageError = qoderCatalogStateCurrent
    ? storedQoderUsageError
    : currentCachedQoderCatalog?.value.usageError || (currentCachedQoderCatalog && !currentCachedQoderCatalog.value.usage ? "Qoder 当前未返回积分信息" : null);
  const selected = agents.find((agent) => agent.agentId === selectedAgentId);
  const installingAgent = agents.find((agent) => agent.agentId === installingAgentId);
  const setupConfigured = Boolean(triggerVariant === "setup" && selected?.installed && selected.status === "ready" && (!selected.managed || selected.configured));
  const configAgent = agents.find((agent) => agent.agentId === configAgentId) ?? selected;
  const contextAgent = page === "config" ? configAgent ?? selected : selected;
  const contextBindingId = contextAgent
    ? bindingIdsByAgent?.[contextAgent.agentId] ?? (contextAgent.agentId === selectedAgentId ? bindingId : null)
    : null;
  const candidateConfiguration = configAgent?.configuration as AgentConfiguration | null | undefined;
  const incomingConfiguration = candidateConfiguration
    && candidateConfiguration.configScope === cacheScope
    && candidateConfiguration.agentId === configAgent?.agentId
    ? candidateConfiguration
    : null;
  const currentConfigRevision = Number(config?.revision);
  const incomingConfigRevision = Number(incomingConfiguration?.revision);
  const resolvedConfig = incomingConfiguration && (
    !config
    || config.agentId !== incomingConfiguration.agentId
    || (Number.isSafeInteger(incomingConfigRevision)
      && (!Number.isSafeInteger(currentConfigRevision) || incomingConfigRevision > currentConfigRevision))
  ) ? incomingConfiguration : config;

  useEffect(() => {
    if (!incomingConfiguration) return;
    writeAgentConfigurationCache(actorId, serverId, cacheScope, incomingConfiguration);
  }, [actorId, cacheScope, incomingConfiguration, serverId]);

  const refreshContext = useCallback(async (force = false) => {
    if (!contextAgent || !contextBindingId) {
      setContext({
        status: "unavailable",
        usage: null,
        reason: contextAgent
          ? `${contextAgent.displayName} 尚未建立原生会话；运行一次后可读取实时用量，自动压缩窗口仍可修改。`
          : "当前 Agent 不可用",
      });
      return;
    }
    if (!operationAvailable(contextAgent, "contextUsage")) {
      setContext({ status: "unavailable", usage: null, reason: contextAgent.runtimeCapabilities?.contextUsage?.reason || "该 Agent 不提供上下文用量" });
      return;
    }
    const cacheKey = actorId
      ? `${actorId}:${serverId}:${cacheScope}:${contextBindingId}:${contextAgent.agentId}`
      : null;
    const cached = readCachedContext(cacheKey);
    if (cached) setContext(cached.state);
    else setContext({ status: "loading", usage: null, reason: null });
    if (!force && cached && cached.contextRevision >= contextRevision) return;
    try {
      const query = new URLSearchParams({ bindingId: contextBindingId, configScope: cacheScope, source: sourceOf(contextAgent) });
      if (workspacePath) query.set("workspacePath", workspacePath);
      const result = await runtime.api.get<{ contextUsage: Usage | null; contextUsageReason?: string | null }>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(contextAgent.agentId)}/context?${query}`);
      const used = Number(result.data.contextUsage?.used);
      const limit = Number(result.data.contextUsage?.limit);
      if (!Number.isFinite(used) || used < 0) {
        clearCachedContext(cacheKey);
        setContext({ status: "unavailable", usage: null, reason: result.data.contextUsageReason || "Agent 未返回可验证的上下文用量；配置仍可正常修改。" });
        return;
      }
      const verifiedLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
      const ratioValue = Number(result.data.contextUsage?.ratio);
      const ratio = verifiedLimit === null ? null : Math.max(0, Math.min(1, Number.isFinite(ratioValue) ? ratioValue : used / verifiedLimit));
      const ready = { status: "ready", usage: { used, limit: verifiedLimit, ratio }, reason: null } as const;
      setContext(ready);
      writeCachedContext(cacheKey, { state: ready, contextRevision, savedAt: Date.now() });
    } catch (reason) { if (!cached) setContext({ status: "unavailable", usage: null, reason: reason instanceof Error ? reason.message : "上下文读取失败" }); }
  }, [actorId, cacheScope, contextAgent, contextBindingId, contextRevision, runtime.api, serverId, workspacePath]);

  const loadConfig = useCallback(async (agent: AgentSummary, cached = false) => {
    setConfigBusy(true);
    setConfigError(null);
    setConfigMutationError(null);
    try {
      const query = new URLSearchParams({ source: sourceOf(agent), configScope: cacheScope });
      if (cached) query.set("cached", "1");
      const result = await runtime.api.get<AgentConfiguration>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/config?${query}`);
      setConfig(result.data);
      writeAgentConfigurationCache(actorId, serverId, cacheScope, result.data);
      setContextLimitDraft(result.data.values.contextLimit || "");
      // Refresh the compact root-row summary after the first lazy read so the
      // configured model appears without requiring a save or full rescan.
      void onAgentsChanged?.().catch(() => undefined);
    } catch (reason) {
      setConfig(null);
      const message = reason instanceof Error ? reason.message : "Agent 配置读取失败";
      setConfigError(message);
      runtime.notify(message, "error");
    } finally { setConfigBusy(false); }
  }, [actorId, cacheScope, onAgentsChanged, runtime, serverId]);

  useEffect(() => {
    const handle = window.setTimeout(() => setPortalTarget(document.body), 0);
    return () => window.clearTimeout(handle);
  }, []);
  useEffect(() => {
    if (!disabled) return;
    const handle = window.setTimeout(() => {
      setOpen(false);
      setPage("root");
    }, 0);
    return () => window.clearTimeout(handle);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const updateAnchor = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left });
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [open]);
  useEffect(() => {
    if (contextRevision < 0) return;
    const handle = window.setTimeout(() => void refreshContext(), 0);
    return () => window.clearTimeout(handle);
  }, [contextRevision, refreshContext]);
  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => void refreshContext(), 0);
    return () => window.clearTimeout(handle);
  }, [open, refreshContext]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || document.querySelector(`.${styles.portal}`)?.contains(target)) return;
      setOpen(false); setPage("root");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const compact = async () => {
    if (!contextAgent || !contextBindingId || !operationAvailable(contextAgent, "compact") || compacting) return;
    setCompacting(true);
    setCompactError(null);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(contextAgent.agentId)}/compact`, { bindingId: contextBindingId, configScope: cacheScope, workspacePath: workspacePath || undefined, source: sourceOf(contextAgent) }, { idempotencyKey: commandId("agent-compact") });
      runtime.notify("已请求 Agent 压缩上下文", "success");
      await refreshContext(true);
    } catch (reason) {
      const message = errorText(reason, "Agent 上下文压缩失败");
      setCompactError(message);
      runtime.notify(message, "error");
    }
    finally { setCompacting(false); }
  };

  const loadQoderCatalog = async ({ includeModels = false, force = false, notifyError = false } = {}) => {
    setQoderCatalogStateKey(qoderCatalogCacheKey);
    const cached = readCachedQoderCatalog(qoderCatalogCacheKey);
    if (cached) {
      setQoderModels((current) => sameQoderModels(current, cached.value.models) ? current : cached.value.models);
      if (includeModels) setModels((current) => sameQoderModels(current, cached.value.models) ? current : cached.value.models);
      setQoderUsage(cached.value.usage);
      setQoderUsageError(cached.value.usageError || (cached.value.usage ? null : "Qoder 当前未返回积分信息"));
    }
    if (!force && cached && Date.now() - cached.savedAt <= QODER_CATALOG_FRESH_MS) return cached.value;
    if (!cached) {
      setQoderModels([]);
      if (includeModels) setModels([]);
      setQoderUsage(null);
      setQoderUsageBusy(true);
      setQoderUsageError(null);
    }
    try {
      const query = force ? "?force=1" : "";
      const result = await runtime.api.get<QoderCatalog>(`/api/servers/${encodeURIComponent(serverId)}/agents/qoder-cn/catalog${query}`);
      writeCachedQoderCatalog(qoderCatalogCacheKey, result.data);
      setQoderModels((current) => sameQoderModels(current, result.data.models) ? current : result.data.models);
      if (includeModels) setModels((current) => sameQoderModels(current, result.data.models) ? current : result.data.models);
      setQoderUsage(result.data.usage);
      setQoderUsageError(result.data.usageError || (result.data.usage ? null : "Qoder 当前未返回积分信息"));
      return result.data;
    } catch (reason) {
      const message = errorText(reason, "Qoder 原生模型目录读取失败");
      if (!cached) {
        if (includeModels) setModels([]);
        setQoderUsage(null);
        setQoderUsageError(message);
      }
      if (notifyError) runtime.notify(message, "error");
      return null;
    } finally { setQoderUsageBusy(false); }
  };

  const openConfig = async (agent: AgentSummary) => {
    const cachedSnapshot = readAgentConfigurationCache(actorId, serverId, cacheScope, agent.agentId);
    const remoteSnapshot = agent.configuration?.configScope === cacheScope ? agent.configuration as AgentConfiguration : null;
    const snapshot = cachedSnapshot || remoteSnapshot;
    const currentSnapshot = config?.agentId === agent.agentId ? config : null;
    const currentRevision = Number(currentSnapshot?.revision);
    const snapshotRevision = Number(snapshot?.revision);
    const nextConfig = snapshot && (
      !currentSnapshot
      || (Number.isSafeInteger(snapshotRevision)
        && (!Number.isSafeInteger(currentRevision) || snapshotRevision > currentRevision))
    ) ? snapshot : currentSnapshot;
    setConfigAgentId(agent.agentId);
    setConfigError(null);
    setConfigMutationError(null);
    setCompactError(null);
    setConfig(nextConfig ?? null);
    setContextLimitDraft(nextConfig?.values.contextLimit || "");
    setPage("config");
    if (canConfigure && !nextConfig) void loadConfig(agent, true);
    if (agent.agentId === "qoder-cn" && agent.authentication?.authenticated) void loadQoderCatalog({ includeModels: true });
    else {
      setQoderUsage(null);
      setQoderUsageError(null);
      setQoderUsageBusy(false);
    }
  };

  const changeFields = async (values: Record<string, string>) => {
    if (!configAgent || !resolvedConfig?.writable || resolvedConfig.revision == null || configBusy) return;
    setConfigBusy(true);
    setConfigSaving(true);
    setConfigMutationError(null);
    try {
      const endpoint = `/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(configAgent.agentId)}/config`;
      const patchConfiguration = async (base: AgentConfiguration, commandPrefix: string) => {
        const revision = base.revision;
        if (revision == null) throw new Error("Agent 配置缺少 revision");
        return (await runtime.api.patch<AgentConfiguration>(endpoint, {
          source: sourceOf(configAgent), configScope: cacheScope, expectedRevision: revision, values,
        }, { expectedRevision: revision, idempotencyKey: commandId(commandPrefix) })).data;
      };
      let nextConfiguration: AgentConfiguration;
      try {
        nextConfiguration = await patchConfiguration(resolvedConfig, "agent-config");
      } catch (reason) {
        if (errorCode(reason) !== "REVISION_CONFLICT") throw reason;
        // A native effort adaptation or another open browser tab can advance
        // this conversation-scoped document while the configuration menu is
        // open. Re-read the authoritative document once and replay the user's
        // same edit on that revision. This is a user-triggered mutation, not a
        // per-turn capability probe.
        const query = new URLSearchParams({ source: sourceOf(configAgent), configScope: cacheScope });
        const latest = (await runtime.api.get<AgentConfiguration>(`${endpoint}?${query}`)).data;
        setConfig(latest);
        writeAgentConfigurationCache(actorId, serverId, cacheScope, latest);
        const alreadyApplied = Object.entries(values).every(([field, value]) => latest.values[field] === value);
        nextConfiguration = alreadyApplied ? latest : await patchConfiguration(latest, "agent-config-retry");
      }
      setConfig(nextConfiguration);
      writeAgentConfigurationCache(actorId, serverId, cacheScope, nextConfiguration);
      setContextLimitDraft(nextConfiguration.values.contextLimit || "");
      if (values.model && providerId) {
        localStorage.setItem(`easywork.agent-provider:${serverId}:${configAgent.agentId}`, providerId);
        localStorage.setItem(`easywork.agent-model:${serverId}:${configAgent.agentId}`, values.model);
      }
      // The PATCH already persisted and refreshed every active isolated
      // runtime. Re-scanning deployments only refreshes list badges, so do it
      // in the background instead of freezing every config control on SSH I/O.
      void onAgentsChanged?.().catch(() => undefined);
      if (values.contextLimit) await refreshContext(true);
      runtime.notify("Agent 配置已更新", "success");
    } catch (reason) {
      const message = errorText(reason, "Agent 配置失败");
      setConfigMutationError(message);
      runtime.notify(message, "error");
    }
    finally { setConfigBusy(false); setConfigSaving(false); }
  };
  const changeField = (field: string, value: string) => changeFields({ [field]: value });

  const openModels = async () => {
    setPage("models");
    setProviderId("");
    setProviders([]);
    if (configAgent?.agentId === "qoder-cn") {
      const cachedModels = qoderModels.length ? qoderModels : readCachedQoderCatalog(qoderCatalogCacheKey)?.value.models ?? [];
      setModels(cachedModels);
    } else setModels([]);
    setModelsBusy(true);
    try {
      if (configAgent?.agentId === "qoder-cn") {
        await loadQoderCatalog({ includeModels: true, notifyError: true });
        return;
      }
      const result = await runtime.api.get<ModelProviderSummary[]>("/api/providers?purpose=agent");
      setProviders(result.data);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "模型 API 读取失败", "error"); }
    finally { setModelsBusy(false); }
  };

  const chooseProvider = async (id: string) => {
    setProviderId(id);
    setModels([]);
    setModelsBusy(true);
    try {
      const result = await runtime.api.post<{ models: ModelSummary[] }>(`/api/providers/${encodeURIComponent(id)}/models`, { purpose: "agent" });
      setModels(result.data.models);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "模型读取失败", "error"); }
    finally { setModelsBusy(false); }
  };

  const chooseModel = (item: ModelSummary) => {
    const values: Record<string, string> = { model: item.id };
    if (configAgent?.agentId === "qoder-cn") {
      const supportedWindows = (item.contextTiers || []).map((tier) => tier.tokens);
      const configuredWindow = Number(resolvedConfig?.values.contextLimit);
      const contextWindow = supportedWindows.includes(configuredWindow)
        ? configuredWindow
        : item.defaultContextWindow || supportedWindows[0] || null;
      if (contextWindow) values.contextLimit = String(contextWindow);
    }
    setPage("config");
    void changeFields(values);
  };

  const deploy = async (agent: AgentSummary, action: "update" | "uninstall") => {
    if (deploymentBusy) return;
    setDeploymentBusy(agent.agentId);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/${action}`, { source: sourceOf(agent) });
      runtime.notify(action === "update" ? "Agent 已更新" : "Agent 已卸载", "success");
      await onAgentsChanged?.();
      if (action === "uninstall") { setPage("root"); setPendingUninstall(null); }
      else setUpdateAgent(null);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "Agent 操作失败", "error"); }
    finally { setDeploymentBusy(null); }
  };

  const checkUpdate = async (agent: AgentSummary) => {
    if (updateChecking || deploymentBusy) return;
    setUpdateAgent(agent);
    setUpdateState(null);
    setUpdateError(null);
    setUpdateChecking(true);
    try {
      const result = await runtime.api.get<AgentUpdate>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/update`);
      setUpdateState(result.data);
    } catch (reason) { setUpdateError(reason instanceof Error ? reason.message : "Agent 更新检查失败"); }
    finally { setUpdateChecking(false); }
  };

  const nativeFields = resolvedConfig?.fields.filter((field) => !["model", "contextLimit"].includes(field.key)) ?? [];
  const contextLimitField = resolvedConfig?.fields.find((field) => field.key === "contextLimit") ?? null;
  const contextLimitChanged = Boolean(contextLimitField && contextLimitDraft !== (resolvedConfig?.values.contextLimit || ""));
  const initialConfigLoading = page === "config" && canConfigure && Boolean(configAgent) && resolvedConfig?.agentId !== configAgent?.agentId && !configError;
  const initialConfigFailed = page === "config" && canConfigure && Boolean(configAgent) && resolvedConfig?.agentId !== configAgent?.agentId && Boolean(configError);
  const isQoderConfig = configAgent?.agentId === "qoder-cn";
  const qoderAuthenticated = configAgent?.authentication?.authenticated === true;
  const visibleModels = isQoderConfig || providerId ? models : providers;
  // Configurations cached before Qoder model selection was introduced do not
  // contain a model key. Qoder itself treats that state as Auto, so keep the
  // menu label and selected row aligned with the native effective value.
  const selectedModelId = isQoderConfig
    ? String(resolvedConfig?.values.model || "auto")
    : String(resolvedConfig?.values.model || "");
  const selectedNativeModel = isQoderConfig ? qoderModels.find((model) => model.id === selectedModelId) : null;
  const selectedModelLabel = isQoderConfig
    ? qoderModelLabel(selectedModelId, qoderModels, qoderUsageBusy)
    : selectedModelId || "尚未选择";
  const qoderContextTiers = selectedNativeModel?.contextTiers || [];
  const qoderPlanCredits = qoderQuotaSummary(qoderUsage?.userQuota);
  const qoderAddOnCredits = qoderQuotaSummary(qoderUsage?.addOnQuota);
  const qoderOrgCredits = qoderUsage?.orgResourcePackage?.available === true
    ? qoderQuotaSummary(qoderUsage.orgResourcePackage)
    : null;
  const rootStateVisible = Boolean(loadError || !agents.length);
  // Keep the model page stable while its native catalog is loading. The list
  // owns the remaining height and scrolls inside it after the response arrives.
  const modelMenuHeight = 360;
  const calculatedMenuHeight = page === "root"
    ? Math.min(390, 12 + agents.length * 58 + (rootStateVisible ? 62 : 0) + (onManualAdd ? 45 : 0))
    : page === "config"
      ? initialConfigLoading || initialConfigFailed ? 174 : 18 + 43 + (configAgent ? 54 : 0) + (configAgent && ["opencode", "codex", "claude-code"].includes(configAgent.agentId) && onConfigure ? 46 : 0) + nativeFields.length * 52 + (configAgent?.status === "ready" ? (context.status === "unavailable" ? 139 : 112) + (configMutationError ? 42 : 0) : 0) + (configAgent?.status === "ready" && (triggerVariant === "setup" || configAgent.managed) ? 38 : 0) + (isQoderConfig && qoderAuthenticated ? 52 : 0)
      : modelMenuHeight;
  const viewportGap = 14;
  const anchoredOnMobile = triggerVariant === "toolbar" && typeof window !== "undefined" && window.innerWidth <= 719;
  const roomBelow = anchor && typeof window !== "undefined" ? window.innerHeight - anchor.bottom - viewportGap : 0;
  const menuHeight = anchoredOnMobile && anchor
    ? Math.min(calculatedMenuHeight, Math.max(0, roomBelow - 8))
    : typeof window === "undefined"
    ? calculatedMenuHeight
    : Math.min(calculatedMenuHeight, Math.max(220, window.innerHeight - 28));
  const pageStyle = { "--agent-menu-height": `${menuHeight}px` } as CSSProperties;
  const desiredMenuWidth = page === "config" ? 400 : 360;
  const menuWidth = typeof window === "undefined" ? desiredMenuWidth : Math.min(desiredMenuWidth, window.innerWidth - 28);
  const menuLeft = anchor && typeof window !== "undefined"
    ? Math.max(viewportGap, Math.min(anchor.right - menuWidth, window.innerWidth - menuWidth - viewportGap))
    : viewportGap;
  const menuTop = anchor
    ? anchoredOnMobile || roomBelow >= menuHeight + 8 ? anchor.bottom + 8 : Math.max(viewportGap, anchor.top - menuHeight - 8)
    : viewportGap;
  const portalStyle = { top: menuTop, left: menuLeft, width: menuWidth } as CSSProperties;
  const selectAgent = async (agent: AgentSummary) => {
    if (selectingAgentId || disabled) return;
    if (agent.agentId === selectedAgentId) {
      setOpen(false);
      setPage("root");
      return;
    }
    setSelectionError(null);
    try {
      if (onBeforeSelect && !await onBeforeSelect(agent.agentId)) return;
      setSelectingAgentId(agent.agentId);
      await onSelect(agent.agentId);
      setOpen(false);
    } catch (reason) {
      setSelectionError({ agentId: agent.agentId, message: errorText(reason, "Agent 检查失败") });
    } finally {
      setSelectingAgentId(null);
    }
  };
  const completeSetupConfig = async (agent: AgentSummary) => {
    if (triggerVariant !== "setup" || selectingAgentId || configBusy || configSaving || disabled) return;
    setConfigMutationError(null);
    if (agent.agentId === selectedAgentId) {
      setOpen(false);
      setPage("root");
      return;
    }
    setSelectingAgentId(agent.agentId);
    try {
      await onSelect(agent.agentId);
      setOpen(false);
      setPage("root");
    } catch (reason) {
      const message = errorText(reason, "Agent 检查失败");
      setConfigMutationError(message);
      runtime.notify(message, "error");
    } finally {
      setSelectingAgentId(null);
    }
  };
  return <div className={styles.root} ref={root}>
    <button ref={trigger} className={`${styles.trigger} ${triggerVariant === "setup" ? styles.setupTrigger : ""} ${setupConfigured ? styles.setupReady : ""} ${installingAgent ? styles.setupInstalling : ""}`} disabled={disabled} aria-label={triggerVariant === "toolbar" ? `Agent 配置${selected ? `：${selected.displayName}` : ""}` : undefined} title={triggerVariant === "toolbar" ? "Agent 配置" : undefined} aria-expanded={open} onClick={() => {
      if (open) { setOpen(false); setPage("root"); return; }
      setOpen(true);
      const qoder = agents.find((agent) => agent.agentId === "qoder-cn" && agent.authentication?.authenticated);
      if (qoder) void loadQoderCatalog();
      if (initialPage === "config" && selected) void openConfig(selected);
      else setPage("root");
    }}>
      {installingAgent ? <LoaderCircle className={styles.spin} size={16} /> : triggerVariant === "setup" ? setupConfigured ? <Bot size={16} /> : <Settings2 size={16} /> : <Bot size={15} />}<span>{installingAgent ? `正在安装 ${installingAgent.displayName}` : triggerLabel ?? selected?.displayName ?? "选择 Agent"}</span>
      {triggerVariant === "toolbar" ? loading ? <LoaderCircle className={styles.spin} size={15} /> : selected?.status === "ready" ? <AgentContextRing value={context.status === "ready" ? context.usage.ratio ?? 0 : 0} readable={context.status === "ready" && context.usage.ratio !== null} /> : null : null}
      {triggerVariant === "toolbar" ? <ChevronDown size={13} /> : null}
    </button>
    {open && portalTarget && anchor ? createPortal(<div className={`${styles.portal} ${triggerVariant === "toolbar" ? styles.anchoredPortal : ""}`} style={portalStyle}><div className={`${styles.menu} ${styles[page]}`} style={pageStyle}>
      <div className={styles.track}>
        <section className={`${styles.menuPanel} ${styles.rootPanel}`}>
          <div className={styles.rootList}>
            {loading && !agents.length ? <div className={styles.rootState} role="status"><LoaderCircle className={styles.spin} size={17} /><span>正在读取 Agent</span></div> : loadError ? <div className={`${styles.rootState} ${styles.rootStateError}`} role="alert"><span><X size={16} /><span><strong>Agent 列表读取失败</strong><small title={loadError}>{loadError}</small></span></span>{onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={13} />重试</button> : null}</div> : !agents.length ? <div className={styles.rootState} role="status"><span>未读取到 Agent</span>{onRetry ? <button type="button" onClick={onRetry}><RefreshCw size={13} />重试</button> : null}</div> : null}
            {agents.map((agent) => {
            const ready = agent.installed && agent.status === "ready";
            const installing = installingAgentId === agent.agentId;
            const needsLogin = agent.authentication?.required === true && !agent.authentication.authenticated;
            const loggingIn = loggingInAgentId === agent.agentId;
            const requirement = missingConfigurationLabel(agent, needsLogin);
            const configuredModelId = agent.agentId === resolvedConfig?.agentId
              ? String(resolvedConfig.values.model || "").trim()
              : String(agent.model || "").trim();
            const configuredModelLabel = agent.agentId === "qoder-cn"
              ? needsLogin ? null : qoderModelLabel(configuredModelId, qoderModels, qoderUsageBusy)
              : configuredModelId;
            return <div className={`${styles.rootRow} ${ready && agent.agentId === selectedAgentId ? styles.rootActive : ""}`} key={agent.agentId}>
              <button className={styles.rootSelect} disabled={!ready || disabled || Boolean(selectingAgentId)} onClick={() => void selectAgent(agent)}>
                <span data-ui-icon="" className={styles.rootIcon}><Bot size={16} /></span>
                <span className={styles.rootIdentity}><strong><span>{agent.displayName}</span>{agent.installed && configuredModelLabel ? <em>{configuredModelLabel}</em> : agent.installed && requirement ? <em>{requirement}</em> : null}</strong><small>{agent.installed ? "EasyWork已部署" : "未部署"}</small></span>
                {selectingAgentId === agent.agentId ? <LoaderCircle className={styles.spin} size={14} /> : ready && agent.agentId === selectedAgentId ? <Check size={14} /> : null}
              </button>
              {!ready && agent.capabilities.install === "available" && onInstall ? <button className={`${styles.inlineAction} ${installing ? styles.installing : ""}`} aria-label={installing ? `正在安装 ${agent.displayName}` : `安装 ${agent.displayName}`} disabled={Boolean(installingAgentId)} onClick={() => void onInstall(agent.agentId)}>{installing ? <LoaderCircle className={styles.spin} size={13} /> : <><Download size={13} /><span>安装</span></>}</button> : ready ? <span className={styles.rowActions}>{needsLogin && onLogin ? <button className={styles.loginAction} aria-label={loggingIn ? `正在登录 ${agent.displayName}` : `登录 ${agent.displayName}`} disabled={loggingIn || disabled || Boolean(selectingAgentId)} onClick={() => void onLogin(agent.agentId)}>{loggingIn ? <LoaderCircle className={styles.spin} size={13} /> : <LogIn size={13} />}<span>{loggingIn ? "等待登录" : "登录"}</span></button> : agent.managed ? <button aria-label={`检测 ${agent.displayName} 更新`} title="更新" disabled={deploymentBusy === agent.agentId || updateChecking} onClick={() => void checkUpdate(agent)}><RefreshCw className={deploymentBusy === agent.agentId || updateChecking && updateAgent?.agentId === agent.agentId ? styles.spin : ""} size={14} /></button> : null}<button aria-label={`配置 ${agent.displayName}`} onClick={() => void openConfig(agent)}><ChevronRight size={15} /></button></span> : null}
            </div>;
            })}
            {selectionError ? <div className={styles.selectionError} role="alert"><X size={14} /><span><strong>无法选择 {agents.find((agent) => agent.agentId === selectionError.agentId)?.displayName || "Agent"}</strong><small>{selectionError.message}</small></span></div> : null}
            {onManualAdd ? <button className={styles.rootManual} onClick={() => { setOpen(false); onManualAdd(); }}><Plus size={14} />手动添加</button> : null}
          </div>
        </section>

        <section className={`${styles.menuPanel} ${styles.configPanel}`}>
          <button className={styles.back} onClick={() => setPage("root")}><ChevronLeft size={15} />返回</button>
          {initialConfigLoading ? <div className={styles.configLoading} role="status"><LoaderCircle className={styles.spin} size={22} /><span>正在读取 Agent 配置</span></div> : initialConfigFailed ? <div className={styles.configLoading} role="alert"><X size={22} /><span>{configError}</span><button type="button" onClick={() => configAgent && void loadConfig(configAgent, true)}><RefreshCw size={14} />重新读取</button></div> : <>
          {configAgent && ["opencode", "codex", "claude-code"].includes(configAgent.agentId) && onConfigure ? <button className={styles.option} disabled={!canConfigure} onClick={() => { setOpen(false); onConfigure(configAgent); }}><FileText size={16} /><span>打开配置</span><ChevronRight size={15} /></button> : null}
          {configAgent && ["opencode", "codex", "claude-code", "qoder-cn"].includes(configAgent.agentId) ? <button className={styles.option} disabled={Boolean(resolvedConfig && !resolvedConfig.writable) || isQoderConfig && !qoderAuthenticated} onClick={() => void openModels()}><Bot size={16} /><span className={styles.optionCopy}><span>选择模型</span><small title={isQoderConfig ? selectedNativeModel?.description || selectedModelLabel : selectedModelId}>{isQoderConfig && !qoderAuthenticated ? "登录后可选择" : selectedModelLabel}</small></span><ChevronRight size={15} /></button> : null}
          {nativeFields.map((field) => <label className={styles.nativeSetting} key={field.key}><span>{field.label}</span>{field.type === "enum" ? <span className={styles.selectControl}><select disabled={!resolvedConfig?.writable || configBusy} value={resolvedConfig?.values[field.key] || field.options?.[0]?.value || ""} onChange={(event) => void changeField(field.key, event.target.value)}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><ChevronDown aria-hidden="true" size={14} /></span> : <input disabled={!resolvedConfig?.writable || configBusy} value={resolvedConfig?.values[field.key] || ""} onChange={(event) => setConfig((current) => current ? { ...current, values: { ...current.values, [field.key]: event.target.value } } : current)} onBlur={(event) => void changeField(field.key, event.target.value)} />}</label>)}
          {configAgent?.status === "ready" ? <div className={styles.contextControls}>
            <div className={styles.usageRow}><i data-ui-icon=""><b style={{ width: `${context.status === "ready" && context.usage.ratio !== null ? context.usage.ratio * 100 : 0}%` }} /></i><strong>{context.status === "ready" ? `${formatTokens(context.usage.used)} / ${context.usage.limit === null ? "上限未知" : formatTokens(context.usage.limit)}` : context.status === "loading" ? "正在读取实时用量" : "暂时没有实时用量"}</strong></div>
            {context.status === "unavailable" ? <p className={styles.contextReason}>{context.reason}</p> : null}
            <div className={styles.contextActions}><span className={styles.contextLimitGroup}><small>{contextLimitField?.label || "上下文容量"}</small>{isQoderConfig && qoderContextTiers.length ? <span className={styles.selectControl}><select disabled={!contextLimitField || !resolvedConfig?.writable || configBusy} value={contextLimitDraft} aria-label={contextLimitField?.label || "上下文容量"} onChange={(event) => { setContextLimitDraft(event.target.value); void changeField("contextLimit", event.target.value); }}>{!qoderContextTiers.some((tier) => String(tier.tokens) === contextLimitDraft) && contextLimitDraft ? <option value={contextLimitDraft}>{formatTokens(Number(contextLimitDraft))}</option> : null}{qoderContextTiers.map((tier) => <option value={tier.tokens} key={tier.tokens}>{tier.label}{tier.isDefault ? "（默认）" : ""}</option>)}</select><ChevronDown aria-hidden="true" size={14} /></span> : <span className={styles.limitControl}><input type="text" inputMode="numeric" disabled={!contextLimitField || !resolvedConfig?.writable || configBusy} value={contextLimitDraft} aria-label={contextLimitField?.label || "上下文容量"} placeholder={contextLimitField ? "输入 Token 数" : "原生配置自行管理"} onChange={(event) => { setContextLimitDraft(event.target.value); setConfigMutationError(null); }} /><button type="button" aria-label={`保存${contextLimitField?.label || "上下文容量"}`} disabled={!resolvedConfig?.writable || configBusy || !contextLimitChanged} onClick={() => void changeField("contextLimit", contextLimitDraft)}>{configSaving ? <LoaderCircle className={styles.spin} size={13} /> : <Save size={13} />}</button></span>}</span><button disabled={!contextBindingId || !operationAvailable(configAgent, "compact") || compacting} onClick={() => void compact()}>{compacting ? <LoaderCircle className={styles.spin} size={13} /> : <Database size={13} />}压缩</button></div>
            {configMutationError ? <p className={styles.operationError} role="alert">{configMutationError}</p> : null}
            {compactError ? <p className={styles.operationError} role="alert">{compactError}</p> : null}
          </div> : null}
          {isQoderConfig && qoderAuthenticated ? <div className={styles.qoderCredits}><span>当前积分</span>{qoderUsageBusy ? <strong><LoaderCircle className={styles.spin} size={13} />正在读取</strong> : qoderPlanCredits || qoderAddOnCredits || qoderOrgCredits ? <span className={styles.qoderCreditValues}>{qoderPlanCredits ? <strong title="套餐积分">{qoderPlanCredits}</strong> : null}{qoderAddOnCredits ? <small title="附加积分">附加 {qoderAddOnCredits}</small> : null}{qoderOrgCredits ? <small title="组织资源包">资源包 {qoderOrgCredits}</small> : null}</span> : <strong title={qoderUsageError || undefined}>暂时无法读取</strong>}</div> : null}
          {configAgent?.status === "ready" && (triggerVariant === "setup" || configAgent.managed) ? <div className={`${styles.configFooter} ${triggerVariant === "setup" ? "" : styles.uninstallFooter}`}>{configSaving ? <span className={styles.runtimeConfiguring}><LoaderCircle className={styles.spin} size={14} />配置中</span> : <span aria-hidden="true" />}{triggerVariant === "setup" ? <button className={styles.complete} disabled={configBusy || configSaving || Boolean(selectingAgentId) || disabled} onClick={() => void completeSetupConfig(configAgent)}>{selectingAgentId === configAgent.agentId ? <LoaderCircle className={styles.spin} size={16} /> : <Check size={16} />}<span>{selectingAgentId === configAgent.agentId ? "完成中" : "完成"}</span></button> : <button className={styles.uninstall} disabled={deploymentBusy === configAgent.agentId} onClick={() => { setOpen(false); setPendingUninstall(configAgent); }}><Trash2 size={16} /><span>卸载 Agent</span></button>}</div> : null}
          </>}
        </section>

        <section className={`${styles.menuPanel} ${styles.modelPanel}`}>
          <button className={styles.back} onClick={() => { if (!isQoderConfig && providerId) { setProviderId(""); setModels([]); } else setPage("config"); }}><ChevronLeft size={15} />返回</button>
          <div className={styles.modelViewport}>{modelsBusy && !visibleModels.length ? <div className={styles.menuState}><LoaderCircle className={styles.spin} size={15} />正在检测模型</div> : visibleModels.length ? <div className={styles.modelList}>{isQoderConfig || providerId ? models.map((item) => { const price = isQoderConfig ? qoderModelPrice(item) : ""; const badge = item.promotion?.active ? item.promotion.badge?.zh || item.promotion.badge?.en : ""; const detail = [badge, price, item.description].filter(Boolean).join(" · "); return <button key={item.id} className={selectedModelId === item.id ? styles.modelSelected : ""} title={item.description || (isQoderConfig ? item.name : item.id)} onClick={() => chooseModel(item)}><span><strong>{item.name}{item.isDefault ? " · 默认" : ""}</strong>{detail ? <small>{detail}</small> : null}</span>{selectedModelId === item.id ? <Check size={14} /> : null}</button>; }) : providers.map((item) => <button key={item.id} disabled={!item.configured} onClick={() => void chooseProvider(item.id)}><span><strong>{item.name}</strong><small>{item.configured ? item.baseUrl || "已配置" : "未配置"}</small></span><ChevronRight size={14} /></button>)}</div> : <div className={styles.menuState}>{isQoderConfig ? "当前 Qoder 账号没有可用模型" : providerId ? "当前 API 没有可用模型" : "请先配置模型 API"}</div>}</div>
        </section>
      </div>
    </div></div>, portalTarget) : null}
    {updateAgent ? <Modal title={`${updateAgent.displayName} 更新`} floating onClose={() => { if (!deploymentBusy) setUpdateAgent(null); }}><div className={`${styles.updateDialog} ${updateError ? styles.updateError : ""}`}>
      <span className={styles.updateHero}>{updateChecking ? <LoaderCircle className={styles.spin} size={23} /> : updateError ? <X size={22} /> : <Check size={22} />}</span>
      <h3>{updateChecking ? `正在检查 ${updateAgent.displayName}` : updateError ? "更新未完成" : updateState?.updateAvailable ? "发现新版本" : "当前已是最新版本"}</h3>
      <p>{updateError || (updateChecking ? "正在连接远端服务器…" : updateState?.updateAvailable ? `${updateAgent.displayName} 有可用的新版本` : `${updateAgent.displayName} 已与主机版本一致`)}</p>
      {updateState ? <div className={styles.updateVersions}><span><small>当前版本</small><strong>{updateState.installedVersion}</strong></span><ChevronRight size={16} /><span><small>可用版本</small><strong>{updateState.availableVersion}</strong></span></div> : null}
      <div className={styles.dialogActions}>{updateState?.updateAvailable ? <><button type="button" disabled={Boolean(deploymentBusy)} onClick={() => setUpdateAgent(null)}>稍后</button><button type="button" disabled={Boolean(deploymentBusy)} onClick={() => void deploy(updateAgent, "update")}>{deploymentBusy ? <LoaderCircle className={styles.spin} size={15} /> : <Download size={15} />}{deploymentBusy ? "更新中" : "更新"}</button></> : updateError ? <><button type="button" onClick={() => setUpdateAgent(null)}>关闭</button><button type="button" onClick={() => void checkUpdate(updateAgent)}><RefreshCw size={15} />重新检测</button></> : !updateChecking ? <button type="button" onClick={() => setUpdateAgent(null)}>完成</button> : null}</div>
    </div></Modal> : null}
    {pendingUninstall ? <Modal title={`卸载 ${pendingUninstall.displayName}`} floating onClose={() => { if (!deploymentBusy) setPendingUninstall(null); }}><div className={styles.confirmDialog}><p>将从当前服务器删除 EasyWork 部署的 Agent 应用。已有网页对话与配置会保留，重新安装后仍可继续使用。</p><div className={styles.dialogActions}><button type="button" disabled={Boolean(deploymentBusy)} onClick={() => setPendingUninstall(null)}>取消</button><button className={styles.dangerAction} type="button" disabled={Boolean(deploymentBusy)} onClick={() => void deploy(pendingUninstall, "uninstall")}>{deploymentBusy ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />}{deploymentBusy ? "卸载中" : "确认卸载"}</button></div></div></Modal> : null}
  </div>;
}
