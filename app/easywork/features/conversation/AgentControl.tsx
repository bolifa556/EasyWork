"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Download, FolderSearch, LoaderCircle, RefreshCw, Settings2, Shrink } from "lucide-react";
import type { AgentSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { ProgressRing } from "../../ui/ProgressRing";
import styles from "./AgentControl.module.css";

type Usage = { used?: number; limit?: number; ratio?: number };
type ContextState =
  | { status: "idle" | "loading"; usage: null; reason: null }
  | { status: "ready"; usage: Required<Pick<Usage, "used" | "limit" | "ratio">>; reason: null }
  | { status: "unavailable"; usage: null; reason: string };

const initialContext: ContextState = { status: "idle", usage: null, reason: null };

function operationAvailable(agent: AgentSummary | undefined, operation: "contextUsage" | "compact") {
  return agent?.runtimeCapabilities?.[operation]?.availability === "available";
}

function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function AgentSelectionList({
  agents,
  selectedAgentId,
  disabled,
  installingAgentId,
  onSelect,
  onInstall,
  onManualAdd,
}: {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  disabled?: boolean;
  installingAgentId?: string | null;
  onSelect: (agentId: string) => Promise<void>;
  onInstall?: (agentId: string) => Promise<void>;
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
      return ready ? <button key={agent.agentId} className={agent.agentId === selectedAgentId ? styles.activeAgent : undefined} disabled={Boolean(switching) || disabled} onClick={() => void select(agent.agentId)}>
        <span><Bot size={15} /><span className={styles.agentIdentity}><strong>{agent.displayName}{agent.version ? <small>{agent.version}</small> : null}</strong><small>{agent.managed ? "EasyWork 部署" : "用户部署"}</small></span></span>
        {switching === agent.agentId ? <LoaderCircle className={styles.spin} size={15} /> : agent.agentId === selectedAgentId ? <Check size={15} /> : null}
      </button> : <div className={styles.agentUnavailable} key={agent.agentId}>
        <span><Bot size={15} /><span className={styles.agentIdentity}><strong>{agent.displayName}</strong><small>{agent.installed ? "当前安装不可用" : "未安装"}</small></span></span>
        {agent.capabilities.install === "available" && onInstall ? <button className={styles.installButton} disabled={Boolean(installingAgentId) || disabled} onClick={() => void onInstall(agent.agentId)}>{installingAgentId === agent.agentId ? <LoaderCircle className={styles.spin} size={14} /> : <Download size={14} />}{installingAgentId === agent.agentId ? "安装中" : "安装"}</button> : null}
      </div>;
    })}</div>
    {onManualAdd ? <div className={styles.manualRow}><button onClick={onManualAdd}><FolderSearch size={15} />手动添加</button></div> : null}
  </div>;
}

export function AgentControl({
  serverId,
  agents,
  selectedAgentId,
  bindingId,
  contextRevision,
  workspacePath,
  disabled,
  canConfigure = true,
  installingAgentId = null,
  onSelect,
  onInstall,
  onManualAdd,
  onConfigure,
}: {
  serverId: string;
  agents: AgentSummary[];
  selectedAgentId: string | null;
  bindingId: string | null;
  contextRevision: number;
  workspacePath: string | null;
  disabled?: boolean;
  canConfigure?: boolean;
  installingAgentId?: string | null;
  onSelect: (agentId: string) => Promise<void>;
  onInstall?: (agentId: string) => Promise<void>;
  onManualAdd?: () => void;
  onConfigure: () => void;
}) {
  const runtime = useAppRuntime();
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<ContextState>(initialContext);
  const [compacting, setCompacting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = agents.find((agent) => agent.agentId === selectedAgentId);

  const refreshContext = useCallback(async () => {
    if (!selected || !bindingId) {
      setContext({ status: "unavailable", usage: null, reason: bindingId ? "当前 Agent 不可用" : "开始一次 Agent 对话后即可读取" });
      return;
    }
    if (!operationAvailable(selected, "contextUsage")) {
      setContext({ status: "unavailable", usage: null, reason: selected.runtimeCapabilities?.contextUsage?.reason || "该 Agent 不提供上下文用量" });
      return;
    }
    setContext({ status: "loading", usage: null, reason: null });
    try {
      const query = new URLSearchParams({ bindingId, source: selected.managed ? "managed" : "user" });
      if (workspacePath) query.set("workspacePath", workspacePath);
      const result = await runtime.api.get<{ contextUsage: Usage | null }>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(selected.agentId)}/context?${query}`);
      const usage = result.data.contextUsage;
      const used = Number(usage?.used);
      const limit = Number(usage?.limit);
      if (!Number.isFinite(used) || used < 0 || !Number.isFinite(limit) || limit <= 0) {
        setContext({ status: "unavailable", usage: null, reason: "Agent 未返回可验证的上下文上限" });
        return;
      }
      const ratio = Number.isFinite(Number(usage?.ratio)) ? Number(usage?.ratio) : used / limit;
      setContext({ status: "ready", usage: { used, limit, ratio: Math.max(0, Math.min(1, ratio)) }, reason: null });
    } catch (reason) {
      setContext({ status: "unavailable", usage: null, reason: reason instanceof Error ? reason.message : "上下文读取失败" });
    }
  }, [bindingId, runtime.api, selected, serverId, workspacePath]);

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
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const compact = async () => {
    if (!selected || !bindingId || !operationAvailable(selected, "compact") || compacting) return;
    setCompacting(true);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(selected.agentId)}/compact`, {
        bindingId,
        workspacePath: workspacePath || undefined,
        source: selected.managed ? "managed" : "user",
      }, { idempotencyKey: commandId("agent-compact") });
      runtime.notify("已请求 Agent 压缩上下文", "success");
      await refreshContext();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "Agent 上下文压缩失败", "error");
    } finally { setCompacting(false); }
  };

  return <div className={styles.root} ref={root}>
    <button className={styles.trigger} disabled={disabled} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Bot size={16} />
      <span>{selected?.displayName ?? "选择 Agent"}</span>
      {context.status === "ready" ? <ProgressRing size={19} value={context.usage.ratio} /> : context.status === "loading" ? <LoaderCircle className={styles.spin} size={16} /> : null}
      <ChevronDown size={14} />
    </button>
    {open ? <div className={styles.menu}>
      <AgentSelectionList agents={agents} selectedAgentId={selected?.agentId ?? null} disabled={disabled} installingAgentId={installingAgentId} onSelect={async (agentId) => { try { await onSelect(agentId); setOpen(false); } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "Agent 切换失败", "error"); } }} onInstall={onInstall} onManualAdd={onManualAdd ? () => { setOpen(false); onManualAdd(); } : undefined} />
      {selected ? <><div className={styles.contextBlock}>
        <div className={styles.contextTitle}><span>上下文</span><button aria-label="刷新 Agent 上下文" disabled={context.status === "loading"} onClick={() => void refreshContext()}><RefreshCw size={14} /></button></div>
        {context.status === "ready" ? <><div className={styles.meter}><span style={{ width: `${context.usage.ratio * 100}%` }} /></div><div className={styles.usage}><span>{Math.round(context.usage.ratio * 100)}%</span><span>{formatTokens(context.usage.used)} / {formatTokens(context.usage.limit)}</span></div></> : <p className={styles.unavailable}>{context.status === "loading" ? "正在读取…" : context.reason}</p>}
      </div>
      <div className={styles.actions}>
        <button disabled={!canConfigure} title={canConfigure ? undefined : "当前远端不提供 Agent 配置"} onClick={onConfigure}><Settings2 size={15} /><span>Agent 配置</span><ChevronRight size={14} /></button>
        <button disabled={!bindingId || !operationAvailable(selected, "compact") || compacting} title={operationAvailable(selected, "compact") ? undefined : selected.runtimeCapabilities?.compact?.reason || "该 Agent 不支持压缩"} onClick={() => void compact()}>{compacting ? <LoaderCircle className={styles.spin} size={15} /> : <Shrink size={15} />}<span>{compacting ? "压缩中" : "压缩上下文"}</span></button>
      </div></> : null}
    </div> : null}
  </div>;
}
