"use client";

import {
  Activity,
  Bot,
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  Globe2,
  LoaderCircle,
  Network,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  Unplug,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { PageFrame } from "../../ui/PageFrame";
import styles from "./AdminView.module.css";

type Purpose = "web" | "agent" | "embedding";
type Provider = {
  id: string;
  revision: number;
  purpose: Purpose;
  name: string;
  baseUrl: string;
  protocol: string;
  configured: boolean;
  hasKey: boolean;
  maskedKey: string;
  updatedAt: string | null;
  embedding?: {
    model: string;
    dimensions: number | null;
    chunkStrategy: "semantic" | "fixed" | "paragraph";
    chunkSize: number;
    chunkOverlap: number;
    batchSize: number;
    hybridEnabled: boolean;
  };
};

type SshPolicy = {
  idleTtlMinutes: number;
  keepaliveIntervalSeconds: number;
  keepaliveCountMax: number;
  connectTimeoutSeconds: number;
  maintenanceIntervalSeconds: number;
  maxConnectionsPerUser: number;
  maxTotalConnections: number;
  allowedCidrs: string[];
  deniedCidrs: string[];
  allowedHosts: string[];
  deniedHosts: string[];
  allowedPorts: number[];
  deniedPorts: number[];
  allowPrivateKeyAuth: boolean;
  allowPasswordAuth: boolean;
};

type PlatformSnapshot = {
  revision: number;
  providers: Record<Purpose, Provider>;
  ssh: SshPolicy;
};

type UsageMetrics = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  errors: number;
  latencyMs: number;
};

type UsageSummary = {
  daily: UsageMetrics;
  weekly: UsageMetrics;
  total: UsageMetrics;
  series: Array<{ date: string } & UsageMetrics>;
};
type UsageScope = "all" | Purpose;

type ManagedConnection = {
  actorId: string;
  username?: string;
  serverId: string;
  serverName: string;
  host: string;
  status: "connected" | "connecting" | "disconnected" | "failed";
  lastActiveAt: string | null;
  conversationCount: number;
};

type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: string;
  chunkStrategy: "semantic" | "fixed" | "paragraph";
  chunkSize: string;
  chunkOverlap: string;
  batchSize: string;
  hybridEnabled: boolean;
};

const emptyUsage: UsageSummary = {
  daily: { requests: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, errors: 0, latencyMs: 0 },
  weekly: { requests: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, errors: 0, latencyMs: 0 },
  total: { requests: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, errors: 0, latencyMs: 0 },
  series: [],
};

const purposeMeta: Record<Purpose, { title: string; description: string; icon: typeof Globe2 }> = {
  web: { title: "网页对话 API", description: "提供给所有用户的网页模型", icon: Globe2 },
  agent: { title: "Agent API", description: "为 EasyWork 部署的远端 Agent 提供模型", icon: Bot },
  embedding: { title: "Embedding API", description: "用于文件解析后的向量索引", icon: Database },
};

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function draftOf(provider: Provider): ProviderDraft {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    model: provider.embedding?.model ?? "",
    dimensions: provider.embedding?.dimensions?.toString() ?? "",
    chunkStrategy: provider.embedding?.chunkStrategy ?? "semantic",
    chunkSize: String(provider.embedding?.chunkSize ?? 3000),
    chunkOverlap: String(provider.embedding?.chunkOverlap ?? 600),
    batchSize: String(provider.embedding?.batchSize ?? 32),
    hybridEnabled: provider.embedding?.hybridEnabled !== false,
  };
}

function UsageChart({ series }: { series: UsageSummary["series"] }) {
  const points = useMemo(() => {
    if (!series.length) return "";
    const maximum = Math.max(...series.map((item) => item.requests), 1);
    return series.map((item, index) => {
      const x = series.length === 1 ? 50 : (index / (series.length - 1)) * 100;
      const y = 38 - (item.requests / maximum) * 34;
      return `${x},${y}`;
    }).join(" ");
  }, [series]);
  return (
    <div className={styles.chart} aria-label="最近请求趋势">
      {points ? <svg viewBox="0 0 100 42" preserveAspectRatio="none" role="img"><defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--ew-green)" stopOpacity=".24" /><stop offset="1" stopColor="var(--ew-green)" stopOpacity="0" /></linearGradient></defs><polygon points={`0,42 ${points} 100,42`} fill="url(#usage-fill)" /><polyline points={points} fill="none" stroke="var(--ew-green)" strokeWidth="1.7" vectorEffect="non-scaling-stroke" /></svg> : <div className={styles.chartEmpty}>暂无调用记录</div>}
      {series.length ? <div className={styles.chartDates}><span>{series[0].date.slice(5)}</span><span>{series.at(-1)?.date.slice(5)}</span></div> : null}
    </div>
  );
}

function ProviderCard({ provider, revision, onSaved }: { provider: Provider; revision: number; onSaved: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [draft, setDraft] = useState(() => draftOf(provider));
  const [showKey, setShowKey] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const [revealingKey, setRevealingKey] = useState(false);
  const keyDirtyRef = useRef(false);
  const revealTimer = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const MetaIcon = purposeMeta[provider.purpose].icon;

  useEffect(() => () => { if (revealTimer.current) window.clearTimeout(revealTimer.current); }, []);

  const changeApiKey = (value: string) => {
    setDraft((current) => ({ ...current, apiKey: value }));
    setKeyDirty(true);
    keyDirtyRef.current = true;
  };

  const toggleKey = async () => {
    if (showKey) {
      setShowKey(false);
      if (!keyDirtyRef.current) setDraft((current) => ({ ...current, apiKey: "" }));
      return;
    }
    if (keyDirtyRef.current || !provider.hasKey) { setShowKey(true); return; }
    setRevealingKey(true);
    try {
      const result = await runtime.api.post<{ apiKey: string; expiresAt: string }>(`/api/admin/providers/${provider.purpose}/reveal`, {});
      setDraft((current) => ({ ...current, apiKey: result.data.apiKey }));
      setShowKey(true);
      const remaining = Math.max(0, Date.parse(result.data.expiresAt) - Date.now());
      if (revealTimer.current) window.clearTimeout(revealTimer.current);
      revealTimer.current = window.setTimeout(() => {
        setShowKey(false);
        if (!keyDirtyRef.current) setDraft((current) => ({ ...current, apiKey: "" }));
      }, remaining);
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "无法显示 API Key", "error");
    } finally { setRevealingKey(false); }
  };

  const copyKey = async () => {
    if (!draft.apiKey) return;
    await navigator.clipboard.writeText(draft.apiKey);
    runtime.notify("API Key 已复制", "success");
  };

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), protocol: provider.purpose === "embedding" ? "openai-embeddings" : "auto" };
      if (provider.purpose === "embedding") Object.assign(patch, {
        model: draft.model.trim(),
        dimensions: draft.dimensions ? Number(draft.dimensions) : null,
        chunkStrategy: draft.chunkStrategy,
        chunkSize: Number(draft.chunkSize),
        chunkOverlap: Number(draft.chunkOverlap),
        batchSize: Number(draft.batchSize),
        hybridEnabled: draft.hybridEnabled,
      });
      await runtime.api.patch(`/api/admin/providers/${provider.purpose}`, {
        patch,
        ...(keyDirty && draft.apiKey ? { apiKey: draft.apiKey } : {}),
      }, { expectedRevision: revision, idempotencyKey: commandId(`admin-${provider.purpose}`) });
      runtime.notify(`${purposeMeta[provider.purpose].title} 已保存`, "success");
      await onSaved();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "保存失败", "error");
    } finally { setSaving(false); }
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const result = keyDirty && draft.apiKey
        ? await runtime.api.post<{ models: Array<{ id: string; name: string }> }>(`/api/admin/providers/${provider.purpose}/models`, {
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey,
        })
        : await runtime.api.post<{ models: Array<{ id: string; name: string }> }>(`/api/providers/${provider.id}/models`, { purpose: "embedding" });
      setModels(result.data.models.map((model) => model.id));
      if (!draft.model && result.data.models[0]) setDraft((current) => ({ ...current, model: result.data.models[0].id }));
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "模型检测失败", "error");
    } finally { setDetecting(false); }
  };

  return (
    <article className={styles.providerCard}>
      <header className={styles.cardHeading}>
        <span className={`${styles.cardIcon} ${styles[provider.purpose]}`}><MetaIcon size={19} /></span>
        <div><h2>{purposeMeta[provider.purpose].title}</h2><p>{purposeMeta[provider.purpose].description}</p></div>
        <span className={`${styles.status} ${provider.configured ? styles.ready : styles.incomplete}`}>{provider.configured ? <><Check size={13} />可用</> : "未配置"}</span>
      </header>
      <div className={styles.formGrid}>
        <label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className={styles.wideField}><span>API URL</span><input inputMode="url" value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
        <label className={styles.keyField}><span>API Key</span><span className={styles.keyInput}><input type={showKey ? "text" : "password"} value={draft.apiKey} placeholder={provider.hasKey ? provider.maskedKey : "输入 API Key"} onChange={(event) => changeApiKey(event.target.value)} /><span className={styles.keyButtons}>{showKey && draft.apiKey ? <button type="button" aria-label="复制 API Key" onClick={() => void copyKey()}><Copy size={16} /></button> : null}<button type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} disabled={revealingKey} onClick={() => void toggleKey()}>{revealingKey ? <LoaderCircle className={styles.spin} size={16} /> : showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></span></label>
        {provider.purpose === "embedding" ? <>
          <label className={styles.modelField}><span>模型</span><span className={styles.modelControl}><input list="embedding-models" value={draft.model} placeholder="选择或输入模型" onChange={(event) => setDraft({ ...draft, model: event.target.value })} /><Button type="button" compact onClick={detect} disabled={detecting} icon={detecting ? <LoaderCircle className={styles.spin} size={15} /> : <RefreshCw size={15} />}>检测</Button></span><datalist id="embedding-models">{models.map((model) => <option value={model} key={model} />)}</datalist></label>
          <label><span>分块策略</span><select value={draft.chunkStrategy} onChange={(event) => setDraft({ ...draft, chunkStrategy: event.target.value as ProviderDraft["chunkStrategy"] })}><option value="semantic">语义</option><option value="paragraph">段落</option><option value="fixed">固定长度</option></select></label>
          <label><span>分块大小</span><input type="number" min="128" max="20000" value={draft.chunkSize} onChange={(event) => setDraft({ ...draft, chunkSize: event.target.value })} /></label>
          <label><span>重叠字符</span><input type="number" min="0" value={draft.chunkOverlap} onChange={(event) => setDraft({ ...draft, chunkOverlap: event.target.value })} /></label>
          <label><span>批量大小</span><input type="number" min="1" max="256" value={draft.batchSize} onChange={(event) => setDraft({ ...draft, batchSize: event.target.value })} /></label>
          <label><span>向量维度</span><input type="number" min="1" placeholder="自动" value={draft.dimensions} onChange={(event) => setDraft({ ...draft, dimensions: event.target.value })} /></label>
          <label className={styles.toggleLabel}><input type="checkbox" checked={draft.hybridEnabled} onChange={(event) => setDraft({ ...draft, hybridEnabled: event.target.checked })} /><span>混合检索</span></label>
        </> : null}
      </div>
      <footer className={styles.cardFooter}><span>{provider.updatedAt ? `更新于 ${new Date(provider.updatedAt).toLocaleString("zh-CN")}` : ""}</span><Button variant="primary" onClick={save} disabled={saving || !draft.name.trim() || !draft.baseUrl.trim() || (provider.purpose === "embedding" && !draft.model.trim())} icon={saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}>{saving ? "保存中" : "保存"}</Button></footer>
    </article>
  );
}

function TokenStat({ title, metrics }: { title: string; metrics: UsageMetrics }) {
  const tokens = metrics.inputTokens + metrics.outputTokens + metrics.embeddingTokens;
  return <article className={styles.metric}><span>{title}</span><strong>{formatCount(metrics.requests)}</strong><small>{formatCount(tokens)} tokens · {metrics.errors} 次错误</small></article>;
}

function UsagePanel({ usages }: { usages: Record<UsageScope, UsageSummary> }) {
  const [scope, setScope] = useState<UsageScope>("all");
  const usage = usages[scope];
  return <aside className={styles.usagePanel}><div className={styles.sectionTitle}><div><h2>API 用量</h2><p>请求次数与 Token 消耗</p></div><Activity size={19} /></div><div className={styles.usageTabs}>{(["all", "web", "agent", "embedding"] as UsageScope[]).map((item) => <button key={item} className={scope === item ? styles.active : ""} onClick={() => setScope(item)}>{item === "all" ? "全部" : item === "web" ? "网页" : item === "agent" ? "Agent" : "Embedding"}</button>)}</div><div className={styles.metrics}><TokenStat title="今日" metrics={usage.daily} /><TokenStat title="近 7 天" metrics={usage.weekly} /><TokenStat title="累计" metrics={usage.total} /></div><UsageChart series={usage.series} /></aside>;
}

function ApiPanel({ snapshot, usages, reload }: { snapshot: PlatformSnapshot; usages: Record<UsageScope, UsageSummary>; reload: () => Promise<void> }) {
  return <div className={styles.apiPanel}>
    <section className={styles.providers}>{(["web", "agent", "embedding"] as Purpose[]).map((purpose) => <ProviderCard key={purpose} provider={snapshot.providers[purpose]} revision={snapshot.revision} onSaved={reload} />)}</section>
    <UsagePanel usages={usages} />
  </div>;
}

function parseLines(value: string) { return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean); }
function parsePorts(value: string) { return parseLines(value).map(Number).filter((port) => Number.isInteger(port)); }

function SshPanel({ snapshot, connections, connectionsAvailable, reload }: { snapshot: PlatformSnapshot; connections: ManagedConnection[]; connectionsAvailable: boolean; reload: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [draft, setDraft] = useState(() => snapshot.ssh);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const set = <K extends keyof SshPolicy>(key: K, value: SshPolicy[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    try {
      await runtime.api.patch("/api/admin/ssh-policy", { policy: draft }, { expectedRevision: snapshot.revision, idempotencyKey: commandId("admin-ssh") });
      runtime.notify("SSH 策略已保存", "success");
      await reload();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "保存失败", "error"); }
    finally { setSaving(false); }
  };
  const disconnect = async (connection: ManagedConnection) => {
    const key = `${connection.actorId}:${connection.serverId}`;
    setDisconnecting(key);
    try {
      await runtime.api.post(`/api/admin/ssh-connections/${encodeURIComponent(connection.actorId)}/${encodeURIComponent(connection.serverId)}/disconnect`, {}, { idempotencyKey: commandId("admin-ssh-disconnect") });
      runtime.notify("SSH 连接已断开", "success");
      await reload();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "断开失败", "error");
    } finally { setDisconnecting(null); }
  };
  return <div className={styles.sshPanel}>
    <section className={styles.policyCard}>
      <div className={styles.sectionTitle}><div><h2>连接策略</h2><p>对所有用户的主机发起连接生效</p></div><ShieldCheck size={20} /></div>
      <div className={styles.policyGrid}>
        <label><span>闲置断开</span><span className={styles.unitInput}><input type="number" min="5" value={draft.idleTtlMinutes} onChange={(event) => set("idleTtlMinutes", Number(event.target.value))} /><em>分钟</em></span></label>
        <label><span>Keepalive 间隔</span><span className={styles.unitInput}><input type="number" min="10" value={draft.keepaliveIntervalSeconds} onChange={(event) => set("keepaliveIntervalSeconds", Number(event.target.value))} /><em>秒</em></span></label>
        <label><span>Keepalive 重试</span><input type="number" min="1" value={draft.keepaliveCountMax} onChange={(event) => set("keepaliveCountMax", Number(event.target.value))} /></label>
        <label><span>连接超时</span><span className={styles.unitInput}><input type="number" min="3" value={draft.connectTimeoutSeconds} onChange={(event) => set("connectTimeoutSeconds", Number(event.target.value))} /><em>秒</em></span></label>
        <label><span>单用户连接上限</span><input type="number" min="1" value={draft.maxConnectionsPerUser} onChange={(event) => set("maxConnectionsPerUser", Number(event.target.value))} /></label>
        <label><span>平台连接上限</span><input type="number" min="1" value={draft.maxTotalConnections} onChange={(event) => set("maxTotalConnections", Number(event.target.value))} /></label>
      </div>
      <div className={styles.networkGrid}>
        <label><span>允许网段</span><textarea value={draft.allowedCidrs.join("\n")} placeholder="留空表示不限制" onChange={(event) => set("allowedCidrs", parseLines(event.target.value))} /></label>
        <label><span>拒绝网段</span><textarea value={draft.deniedCidrs.join("\n")} placeholder="例如 10.0.0.0/8" onChange={(event) => set("deniedCidrs", parseLines(event.target.value))} /></label>
        <label><span>允许主机</span><textarea value={draft.allowedHosts.join("\n")} placeholder="域名或 IP，每行一个" onChange={(event) => set("allowedHosts", parseLines(event.target.value))} /></label>
        <label><span>拒绝主机</span><textarea value={draft.deniedHosts.join("\n")} placeholder="域名或 IP，每行一个" onChange={(event) => set("deniedHosts", parseLines(event.target.value))} /></label>
        <label><span>允许端口</span><input value={draft.allowedPorts.join(", ")} placeholder="留空表示不限制" onChange={(event) => set("allowedPorts", parsePorts(event.target.value))} /></label>
        <label><span>拒绝端口</span><input value={draft.deniedPorts.join(", ")} placeholder="例如 23, 3389" onChange={(event) => set("deniedPorts", parsePorts(event.target.value))} /></label>
      </div>
      <div className={styles.authOptions}><label><input type="checkbox" checked={draft.allowPrivateKeyAuth} onChange={(event) => set("allowPrivateKeyAuth", event.target.checked)} />允许密钥登录</label><label><input type="checkbox" checked={draft.allowPasswordAuth} onChange={(event) => set("allowPasswordAuth", event.target.checked)} />允许密码登录</label></div>
      <div className={styles.policyActions}><Button variant="primary" onClick={save} disabled={saving || (!draft.allowPasswordAuth && !draft.allowPrivateKeyAuth)} icon={saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}>{saving ? "保存中" : "保存策略"}</Button></div>
    </section>
    <section className={styles.connectionCard}>
      <div className={styles.sectionTitle}><div><h2>用户连接</h2><p>{connectionsAvailable ? `${connections.length} 个 SSH 会话` : "连接信息暂时不可用"}</p></div><UsersRound size={20} /></div>
      {connectionsAvailable && connections.length ? <div className={styles.connectionTable}><div className={styles.connectionHeader}><span>用户</span><span>服务器</span><span>对话</span><span>状态</span><span>最近活动</span><span /></div>{connections.map((item) => { const key = `${item.actorId}:${item.serverId}`; return <div className={styles.connectionRow} key={key}><strong>{item.username || item.actorId}</strong><span>{item.serverName}<small>{item.host}</small></span><span>{item.conversationCount}</span><span className={`${styles.connectionStatus} ${styles[item.status]}`}>{item.status === "connected" ? "已连接" : item.status === "connecting" ? "连接中" : item.status === "failed" ? "失败" : "未连接"}</span><time>{item.lastActiveAt ? new Date(item.lastActiveAt).toLocaleString("zh-CN") : "—"}</time><Button compact variant="danger" disabled={item.status !== "connected" || Boolean(disconnecting)} icon={disconnecting === key ? <LoaderCircle className={styles.spin} size={14} /> : <Unplug size={14} />} onClick={() => void disconnect(item)}>断开</Button></div>; })}</div> : <div className={styles.unavailable}><Network size={23} /><strong>{connectionsAvailable ? "暂无用户 SSH 连接" : "连接信息暂时不可用"}</strong></div>}
    </section>
  </div>;
}

export default function AdminView() {
  const runtime = useAppRuntime();
  const { api, notify } = runtime;
  const [tab, setTab] = useState<"api" | "ssh">("api");
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);
  const [usages, setUsages] = useState<Record<UsageScope, UsageSummary>>({ all: emptyUsage, web: emptyUsage, agent: emptyUsage, embedding: emptyUsage });
  const [connections, setConnections] = useState<ManagedConnection[]>([]);
  const [connectionsAvailable, setConnectionsAvailable] = useState(true);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [platformResult, usageResult, connectionResult] = await Promise.allSettled([
      api.get<PlatformSnapshot>("/api/admin/platform"),
      api.get<UsageSummary>("/api/admin/usage?seriesDays=14"),
      api.get<{ items: ManagedConnection[] }>("/api/admin/ssh-connections"),
    ]);
    if (platformResult.status === "fulfilled") setSnapshot(platformResult.value.data);
    else notify(platformResult.reason instanceof Error ? platformResult.reason.message : "管理员配置读取失败", "error");
    if (usageResult.status === "fulfilled") setUsages((current) => ({ ...current, all: usageResult.value.data }));
    if (platformResult.status === "fulfilled") {
      const scoped = await Promise.allSettled((["web", "agent", "embedding"] as Purpose[]).map(async (purpose) => ({
        purpose,
        result: await api.get<UsageSummary>(`/api/admin/usage?seriesDays=14&providerId=${encodeURIComponent(platformResult.value.data.providers[purpose].id)}`),
      })));
      setUsages((current) => {
        const next = { ...current };
        for (const entry of scoped) if (entry.status === "fulfilled") next[entry.value.purpose] = entry.value.result.data;
        return next;
      });
    }
    if (connectionResult.status === "fulfilled") { setConnections(connectionResult.value.data.items); setConnectionsAvailable(true); }
    else setConnectionsAvailable(false);
  }, [api, notify]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load().finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  if (loading) return <LoadingState label="正在读取管理员配置" />;
  if (!snapshot) return <PageFrame icon={<ServerCog size={19} />} title="管理员面板"><div className={styles.pageError}>管理员配置暂时不可用</div></PageFrame>;
  return (
    <PageFrame icon={<ServerCog size={19} />} title="管理员面板" actions={<Button compact onClick={() => void load()} icon={<RefreshCw size={15} />}>刷新</Button>}>
      <div className={styles.tabs} role="tablist"><button className={tab === "api" ? styles.activeTab : ""} onClick={() => setTab("api")} role="tab" aria-selected={tab === "api"}><Activity size={16} />模型 API</button><button className={tab === "ssh" ? styles.activeTab : ""} onClick={() => setTab("ssh")} role="tab" aria-selected={tab === "ssh"}><ServerCog size={16} />SSH</button></div>
      <div className={styles.tabStage}>{tab === "api" ? <ApiPanel key={`api:${snapshot.revision}`} snapshot={snapshot} usages={usages} reload={load} /> : <SshPanel key={`ssh:${snapshot.revision}`} snapshot={snapshot} connections={connections} connectionsAvailable={connectionsAvailable} reload={load} />}</div>
    </PageFrame>
  );
}
