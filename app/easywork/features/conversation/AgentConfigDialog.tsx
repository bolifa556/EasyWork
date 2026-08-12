"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle, Save, Settings2 } from "lucide-react";
import type { AgentSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import styles from "./AgentConfigDialog.module.css";

type ConfigField = {
  key: string;
  label: string;
  type: "string" | "enum";
  nativeKey: string;
  options?: Array<{ value: string; label: string }>;
};

type AgentConfiguration = {
  agentId: string;
  source: "managed" | "user";
  managed: boolean;
  writable: boolean;
  path?: string;
  revision: number | null;
  updatedAt: string | null;
  fields: ConfigField[];
  values: Record<string, string>;
  reason?: string;
};

type ProviderSummary = { id: string; name: string; configured: boolean };
type ModelSummary = { id: string; name: string };

export function AgentConfigDialog({ serverId, agent, onClose }: { serverId: string; agent: AgentSummary; onClose: () => void }) {
  const runtime = useAppRuntime();
  const source = agent.managed || agent.source === "managed" ? "managed" : "user";
  const [config, setConfig] = useState<AgentConfiguration | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [detectingModels, setDetectingModels] = useState(false);

  const providerStorageKey = `easywork.agent-provider:${serverId}:${agent.agentId}`;
  const modelStorageKey = `easywork.agent-model:${serverId}:${agent.agentId}`;

  const loadModels = async (nextProviderId: string, preserveModel = "") => {
    setDetectingModels(true);
    setModels([]);
    try {
      const result = await runtime.api.post<{ models: ModelSummary[] }>(`/api/providers/${encodeURIComponent(nextProviderId)}/models`, { purpose: "agent" });
      setModels(result.data.models);
      const existing = preserveModel || values.model || localStorage.getItem(modelStorageKey) || "";
      if (existing && result.data.models.some((item) => item.id === existing)) {
        setValues((current) => ({ ...current, model: existing }));
        localStorage.setItem(modelStorageKey, existing);
      }
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "无法检测 Agent 模型", "error");
    } finally { setDetectingModels(false); }
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      runtime.api.get<AgentConfiguration>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/config?source=${source}`),
      source === "managed" ? runtime.api.get<ProviderSummary[]>("/api/providers?purpose=agent") : Promise.resolve(null),
    ]).then(async ([configResult, providerResult]) => {
      if (!active) return;
      setConfig(configResult.data);
      setValues(configResult.data.values);
      const available = providerResult?.data || [];
      setProviders(available);
      if (configResult.data.fields.some((field) => field.key === "model") && available.length) {
        const stored = localStorage.getItem(providerStorageKey);
        const selected = available.find((item) => item.id === stored)?.id || available[0].id;
        setProviderId(selected);
        localStorage.setItem(providerStorageKey, selected);
        await loadModels(selected, configResult.data.values.model || "");
      }
    }, (reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
    // Provider/model selection is loaded once for this concrete server Agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.agentId, runtime.api, serverId, source]);

  const chooseProvider = async (nextProviderId: string) => {
    setProviderId(nextProviderId);
    localStorage.setItem(providerStorageKey, nextProviderId);
    localStorage.removeItem(modelStorageKey);
    setValues((current) => ({ ...current, model: "" }));
    await loadModels(nextProviderId);
  };

  const chooseModel = (model: string) => {
    setValues((current) => ({ ...current, model }));
    if (model) localStorage.setItem(modelStorageKey, model);
    else localStorage.removeItem(modelStorageKey);
  };

  const changes = useMemo(() => Object.fromEntries(Object.entries(values).filter(([key, value]) => value.trim() && value !== config?.values[key])), [config?.values, values]);
  const save = async () => {
    if (!config?.writable || config.revision == null || !Object.keys(changes).length) return;
    setSaving(true);
    try {
      const result = await runtime.api.patch<AgentConfiguration>(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agent.agentId)}/config`, {
        source: "managed",
        expectedRevision: config.revision,
        values: changes,
      }, { expectedRevision: config.revision, idempotencyKey: commandId("agent-config") });
      setConfig(result.data);
      setValues(result.data.values);
      runtime.notify("Agent 配置已保存", "success");
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "Agent 配置失败", "error");
    } finally { setSaving(false); }
  };

  return <Modal title={`${agent.displayName} 配置`} size="normal" onClose={onClose}>
    {!config && !error ? <LoadingState label="正在读取 Agent 配置" /> : error ? <div className={styles.unavailable}><Settings2 size={23} /><strong>配置暂时不可用</strong><span>{error}</span></div> : config ? <div className={styles.layout}>
      <div className={styles.identity}><div><strong>{agent.displayName}</strong><span>{agent.version || "版本未知"}</span></div><span className={styles.source}>{config.managed ? "EasyWork 部署" : "用户部署"}</span></div>
      {config.fields.length ? <div className={styles.fields}>{config.fields.map((field) => field.key === "model" ? <div className={`${styles.modelRoute} ${styles.wide}`} key={field.key}><span className={styles.fieldLabel}>模型</span><div className={styles.modelSteps}><label><span>API</span><select disabled={!config.writable || saving || !providers.length} value={providerId} onChange={(event) => void chooseProvider(event.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><ChevronRight size={17} /><label><span>模型</span><select disabled={!config.writable || saving || detectingModels || !providerId} value={values.model ?? ""} onChange={(event) => chooseModel(event.target.value)}><option value="">{detectingModels ? "检测中" : "选择模型"}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div></div> : <label key={field.key}><span>{field.label}</span>{field.type === "enum" ? <select disabled={!config.writable || saving} value={values[field.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}><option value="">未设置</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input disabled={!config.writable || saving} value={values[field.key] ?? ""} placeholder="未设置" onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} />}</label>)}</div> : <div className={styles.readonly}><strong>使用 Agent 自己的配置</strong><span>用户部署的 Agent 不由 EasyWork 修改。</span></div>}
      {config.writable ? <footer className={styles.actions}><Button variant="primary" disabled={saving || !Object.keys(changes).length} icon={saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />} onClick={() => void save()}>{saving ? "配置中" : "保存"}</Button></footer> : null}
    </div> : null}
  </Modal>;
}
