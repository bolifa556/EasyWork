"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, LoaderCircle, RefreshCw, Save, Settings2 } from "lucide-react";
import type { AgentSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import { readAgentConfigurationCache, writeAgentConfigurationCache, type AgentConfiguration } from "./agent-configuration-cache";
import styles from "./AgentConfigDialog.module.css";

function sourceOf(agent: AgentSummary) {
  return agent.managed || agent.source === "managed" ? "managed" : "user";
}

function errorCode(reason: unknown) {
  if (!reason || typeof reason !== "object") return "";
  return String((reason as { code?: unknown }).code || "");
}

export function AgentConfigDialog({ serverId, configScope, agent, onChanged, onClose }: { serverId: string; configScope: string; agent: AgentSummary; onChanged?: () => Promise<void>; onClose: () => void }) {
  const runtime = useAppRuntime();
  const actorId = runtime.bootstrap?.actor.id;
  const [initialConfig] = useState(() => readAgentConfigurationCache(actorId, serverId, configScope, agent.agentId));
  const [config, setConfig] = useState<AgentConfiguration | null>(initialConfig);
  const [content, setContent] = useState(() => initialConfig ? JSON.stringify(initialConfig.values, null, 2) : "");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!initialConfig);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const query = new URLSearchParams({ source: sourceOf(agent), configScope });
      const result = await runtime.api.get<AgentConfiguration>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/config?${query}`);
      setConfig(result.data);
      setContent(JSON.stringify(result.data.values, null, 2));
      writeAgentConfigurationCache(actorId, serverId, configScope, result.data);
    } catch (reason) { setLoadError(reason instanceof Error ? reason.message : "Agent 配置读取失败"); }
    finally { setLoading(false); }
  }, [actorId, agent, configScope, runtime.api, serverId]);

  useEffect(() => {
    if (initialConfig) return;
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [initialConfig, load]);

  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(content) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      return value as Record<string, unknown>;
    } catch { return null; }
  }, [content]);
  const changes = useMemo(() => {
    if (!parsed || !config) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => typeof value === "string" && value.trim() && value !== config.values[key]));
  }, [config, parsed]);

  const edit = (next: string) => {
    setContent(next);
    try {
      const value = JSON.parse(next) as unknown;
      setParseError(value && typeof value === "object" && !Array.isArray(value) ? null : "配置根节点必须是 JSON 对象");
    } catch { setParseError("配置必须是有效的 JSON"); }
  };

  const save = async () => {
    if (!config?.writable || config.revision == null || !parsed || parseError || !Object.keys(changes).length) return;
    setSaving(true);
    try {
      const endpoint = `/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/config`;
      const patchConfiguration = async (base: AgentConfiguration, commandPrefix: string) => {
        const revision = base.revision;
        if (revision == null) throw new Error("Agent 配置缺少 revision");
        return (await runtime.api.patch<AgentConfiguration>(endpoint, {
          source: base.source,
          configScope,
          expectedRevision: revision,
          values: changes,
        }, { expectedRevision: revision, idempotencyKey: commandId(commandPrefix) })).data;
      };
      let nextConfiguration: AgentConfiguration;
      try {
        nextConfiguration = await patchConfiguration(config, "agent-config");
      } catch (reason) {
        if (errorCode(reason) !== "REVISION_CONFLICT") throw reason;
        const query = new URLSearchParams({ source: sourceOf(agent), configScope });
        const latest = (await runtime.api.get<AgentConfiguration>(`${endpoint}?${query}`)).data;
        const alreadyApplied = Object.entries(changes).every(([field, value]) => latest.values[field] === value);
        nextConfiguration = alreadyApplied ? latest : await patchConfiguration(latest, "agent-config-retry");
      }
      setConfig(nextConfiguration);
      setContent(JSON.stringify(nextConfiguration.values, null, 2));
      writeAgentConfigurationCache(actorId, serverId, configScope, nextConfiguration);
      await onChanged?.().catch(() => undefined);
      runtime.notify("Agent 配置已保存", "success");
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "Agent 配置失败", "error"); }
    finally { setSaving(false); }
  };

  return <Modal title={`${agent.displayName} 配置`} size="wide" floating panelClassName={styles.nativePanel} bodyClassName={styles.nativeBody} onClose={onClose}>
    {loading && !config ? <LoadingState label="正在读取 Agent 配置" /> : loadError && !config ? <div className={styles.unavailable}><Settings2 size={23} /><strong>配置暂时不可用</strong><span>{loadError}</span><Button compact icon={<RefreshCw size={14} />} onClick={() => void load()}>重新读取</Button></div> : config ? <div className={styles.nativeEditor}>
      <div className={styles.nativePath}><FileText size={15} /><code>{config.path || "当前对话的 EasyWork 隔离配置"}</code><Button compact variant="ghost" disabled={loading || saving} icon={loading ? <LoaderCircle className={styles.spin} size={14} /> : <RefreshCw size={14} />} onClick={() => void load()}>{loading ? "读取中" : "重新读取远端"}</Button></div>
      <textarea value={content} disabled={!config.writable || saving} spellCheck={false} aria-label="Agent 原生配置文件" onChange={(event) => edit(event.target.value)} />
      <footer><span className={styles.parseError}>{parseError}</span><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!config.writable || saving || !Object.keys(changes).length || Boolean(parseError)} icon={saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />} onClick={() => void save()}>{saving ? "配置中" : "保存配置"}</Button></footer>
    </div> : null}
  </Modal>;
}
