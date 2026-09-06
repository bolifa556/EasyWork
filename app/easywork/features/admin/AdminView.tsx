"use client";

import {
  Activity,
  Bot,
  Check,
  Copy,
  Database,
  ChevronRight,
  Eye,
  EyeOff,
  Globe2,
  LoaderCircle,
  Network,
  RefreshCw,
  Save,
  ScanText,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
  Unplug,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import { PageFrame } from "../../ui/PageFrame";
import styles from "./AdminView.module.css";

type Purpose = "web" | "agent" | "embedding" | "ocr";
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
    memory: {
      enabled: boolean;
      vectorWeight: number;
      lexicalWeight: number;
      titleWeight: number;
      minimumScore: number;
      diversityLambda: number;
      recallLimit: number;
      resultLimit: number;
      tokenBudget: number;
      pageSize: number;
    };
  };
  ocr?: {
    model: string;
    maxOutputTokens: number;
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
  serverId: string;
  serverName: string;
  host: string;
  status: "connected" | "connecting" | "disconnected" | "failed";
  lastActiveAt: string | null;
  conversationCount: number;
};

type AdminUser = {
  userId: string;
  username: string;
  admin: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  deviceCount: number;
  activeSessionCount: number;
  liveSshCount: number;
};

type AdminUserDetail = {
  user: AdminUser;
  conversations: {
    items: Array<{ id: string; title: string; mode: "chat" | "work"; updatedAt: string; lastMessagePreview: string; revision: number }>;
    nextCursor: string | null;
  };
  taskCount: number;
  activeTaskCount: number;
  servers: Array<ManagedConnection & { desiredConnection: boolean }>;
};

type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: string;
  model: string;
  dimensions: string;
  chunkStrategy: "semantic" | "fixed" | "paragraph";
  chunkSize: string;
  chunkOverlap: string;
  batchSize: string;
  hybridEnabled: boolean;
  memoryEnabled: boolean;
  memoryVectorWeight: string;
  memoryLexicalWeight: string;
  memoryTitleWeight: string;
  memoryMinimumScore: string;
  memoryDiversityLambda: string;
  memoryRecallLimit: string;
  memoryResultLimit: string;
  memoryTokenBudget: string;
  memoryPageSize: string;
  maxOutputTokens: string;
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
  embedding: { title: "Embedding API", description: "用于文件索引与记忆语义检索", icon: Database },
  ocr: { title: "OCR API", description: "用于图片与扫描 PDF 的文字识别", icon: ScanText },
};

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function draftOf(provider: Provider): ProviderDraft {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    protocol: provider.protocol || (provider.purpose === "embedding" ? "openai-embeddings" : provider.purpose === "ocr" ? "chat-completions" : "auto"),
    model: provider.embedding?.model ?? provider.ocr?.model ?? "",
    dimensions: provider.embedding?.dimensions?.toString() ?? "",
    chunkStrategy: provider.embedding?.chunkStrategy ?? "semantic",
    chunkSize: String(provider.embedding?.chunkSize ?? 3000),
    chunkOverlap: String(provider.embedding?.chunkOverlap ?? 600),
    batchSize: String(provider.embedding?.batchSize ?? 32),
    hybridEnabled: provider.embedding?.hybridEnabled !== false,
    memoryEnabled: provider.embedding?.memory?.enabled !== false,
    memoryVectorWeight: String(provider.embedding?.memory?.vectorWeight ?? 0.55),
    memoryLexicalWeight: String(provider.embedding?.memory?.lexicalWeight ?? 0.15),
    memoryTitleWeight: String(provider.embedding?.memory?.titleWeight ?? 0.3),
    memoryMinimumScore: String(provider.embedding?.memory?.minimumScore ?? 0.12),
    memoryDiversityLambda: String(provider.embedding?.memory?.diversityLambda ?? 0.72),
    memoryRecallLimit: String(provider.embedding?.memory?.recallLimit ?? 48),
    memoryResultLimit: String(provider.embedding?.memory?.resultLimit ?? 8),
    memoryTokenBudget: String(provider.embedding?.memory?.tokenBudget ?? 3200),
    memoryPageSize: String(provider.embedding?.memory?.pageSize ?? 20),
    maxOutputTokens: String(provider.ocr?.maxOutputTokens ?? 4096),
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
      {points ? <svg data-ui-icon="" viewBox="0 0 100 42" preserveAspectRatio="none" role="img"><defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--ew-green)" stopOpacity=".24" /><stop offset="1" stopColor="var(--ew-green)" stopOpacity="0" /></linearGradient></defs><polygon points={`0,42 ${points} 100,42`} fill="url(#usage-fill)" /><polyline points={points} fill="none" stroke="var(--ew-green)" strokeWidth="1.7" vectorEffect="non-scaling-stroke" /></svg> : <div className={styles.chartEmpty}>暂无调用记录</div>}
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
  const [embeddingTab, setEmbeddingTab] = useState<"files" | "memory">("files");
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

  const changed = keyDirty || JSON.stringify({ ...draft, apiKey: "" }) !== JSON.stringify(draftOf(provider));
  const showStoredKeyMask = provider.hasKey && !showKey && !keyDirty;

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), protocol: provider.purpose === "embedding" ? "openai-embeddings" : provider.purpose === "ocr" ? draft.protocol : "auto" };
      if (provider.purpose === "embedding") Object.assign(patch, {
        model: draft.model.trim(),
        dimensions: draft.dimensions ? Number(draft.dimensions) : null,
        chunkStrategy: draft.chunkStrategy,
        chunkSize: Number(draft.chunkSize),
        chunkOverlap: Number(draft.chunkOverlap),
        batchSize: Number(draft.batchSize),
        hybridEnabled: draft.hybridEnabled,
        memory: {
          enabled: draft.memoryEnabled,
          vectorWeight: Number(draft.memoryVectorWeight),
          lexicalWeight: Number(draft.memoryLexicalWeight),
          titleWeight: Number(draft.memoryTitleWeight),
          minimumScore: Number(draft.memoryMinimumScore),
          diversityLambda: Number(draft.memoryDiversityLambda),
          recallLimit: Number(draft.memoryRecallLimit),
          resultLimit: Number(draft.memoryResultLimit),
          tokenBudget: Number(draft.memoryTokenBudget),
          pageSize: Number(draft.memoryPageSize),
        },
      });
      if (provider.purpose === "ocr") Object.assign(patch, {
        model: draft.model.trim(),
        maxOutputTokens: Number(draft.maxOutputTokens),
      });
      if (!(provider.purpose === "ocr" && draft.protocol === "mineru")) {
        await runtime.api.post(`/api/admin/providers/${provider.purpose}/models`, {
          baseUrl: draft.baseUrl.trim(),
          ...(keyDirty && draft.apiKey ? { apiKey: draft.apiKey } : {}),
        });
      }
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
        : await runtime.api.post<{ models: Array<{ id: string; name: string }> }>(`/api/providers/${provider.id}/models`, { purpose: provider.purpose });
      setModels(result.data.models.map((model) => model.id));
      if (!draft.model && result.data.models[0]) setDraft((current) => ({ ...current, model: result.data.models[0].id }));
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "模型检测失败", "error");
    } finally { setDetecting(false); }
  };

  return (
    <article className={styles.providerCard}>
      <header className={styles.cardHeading}>
        <span data-ui-icon="" className={`${styles.cardIcon} ${styles[provider.purpose]}`}><MetaIcon size={19} /></span>
        <div><h2>{purposeMeta[provider.purpose].title}</h2><p>{purposeMeta[provider.purpose].description}</p></div>
        <span className={`${styles.status} ${provider.configured ? styles.ready : styles.incomplete}`}>{provider.configured ? <><Check size={13} />可用</> : "未配置"}</span>
      </header>
      <div className={styles.formGrid}>
        <label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        {provider.purpose === "ocr" ? <label><span>协议</span><select value={draft.protocol} onChange={(event) => {
          const protocol = event.target.value;
          setDraft((current) => ({ ...current, protocol, ...(protocol === "mineru" ? { model: "mineru" } : {}) }));
        }}><option value="chat-completions">OpenAI 视觉模型</option><option value="mineru">MinerU 文档解析</option></select></label> : null}
        <label className={styles.wideField}><span>API URL</span><input inputMode="url" value={draft.baseUrl} placeholder={draft.protocol === "mineru" ? "https://api.llm.ustc.edu.cn" : "https://api.example.com/v1"} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
        <label className={styles.keyField}><span>API Key</span><span className={styles.keyInput}><input autoComplete="new-password" type={showKey ? "text" : "password"} value={draft.apiKey} placeholder={provider.hasKey ? "" : "输入 API Key"} onChange={(event) => changeApiKey(event.target.value)} />{showStoredKeyMask ? <span className={styles.storedSecretMask} aria-hidden="true">••••••••••••</span> : null}<span className={styles.keyButtons}>{showKey && draft.apiKey ? <button type="button" aria-label="复制 API Key" onClick={() => void copyKey()}><Copy size={16} /></button> : null}<button type="button" aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} disabled={revealingKey} onClick={() => void toggleKey()}>{revealingKey ? <LoaderCircle className={styles.spin} size={16} /> : showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></span></label>
        {["embedding", "ocr"].includes(provider.purpose) ? <label className={styles.modelField}><span>模型</span><span className={styles.modelControl}><input list={`${provider.purpose}-models`} value={draft.model} placeholder="选择或输入模型" readOnly={provider.purpose === "ocr" && draft.protocol === "mineru"} aria-readonly={provider.purpose === "ocr" && draft.protocol === "mineru"} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />{provider.purpose !== "ocr" || draft.protocol !== "mineru" ? <Button type="button" compact onClick={detect} disabled={detecting} icon={detecting ? <LoaderCircle className={styles.spin} size={15} /> : <RefreshCw size={15} />}>检测</Button> : <span className={styles.fixedModel}>固定</span>}</span><datalist id={`${provider.purpose}-models`}>{models.map((model) => <option value={model} key={model} />)}</datalist></label> : null}
        {provider.purpose === "embedding" ? <section className={styles.embeddingSettings}>
          <div className={styles.embeddingTabs} role="tablist" aria-label="Embedding 用途配置">
            <button type="button" role="tab" aria-selected={embeddingTab === "files"} className={embeddingTab === "files" ? styles.active : ""} onClick={() => setEmbeddingTab("files")}>文件</button>
            <button type="button" role="tab" aria-selected={embeddingTab === "memory"} className={embeddingTab === "memory" ? styles.active : ""} onClick={() => setEmbeddingTab("memory")}>记忆</button>
          </div>
          {embeddingTab === "files" ? <div className={styles.embeddingGrid} role="tabpanel">
            <label><span>分块策略</span><select value={draft.chunkStrategy} onChange={(event) => setDraft({ ...draft, chunkStrategy: event.target.value as ProviderDraft["chunkStrategy"] })}><option value="semantic">语义</option><option value="paragraph">段落</option><option value="fixed">固定长度</option></select></label>
            <label><span>分块大小</span><input type="number" min="128" max="20000" value={draft.chunkSize} onChange={(event) => setDraft({ ...draft, chunkSize: event.target.value })} /></label>
            <label><span>重叠字符</span><input type="number" min="0" value={draft.chunkOverlap} onChange={(event) => setDraft({ ...draft, chunkOverlap: event.target.value })} /></label>
            <label><span>批量大小</span><input type="number" min="1" max="256" value={draft.batchSize} onChange={(event) => setDraft({ ...draft, batchSize: event.target.value })} /></label>
            <label><span>向量维度</span><input type="number" min="1" placeholder="自动" value={draft.dimensions} onChange={(event) => setDraft({ ...draft, dimensions: event.target.value })} /></label>
            <label className={styles.toggleLabel}><input type="checkbox" checked={draft.hybridEnabled} onChange={(event) => setDraft({ ...draft, hybridEnabled: event.target.checked })} /><span>混合检索</span></label>
          </div> : <div className={styles.embeddingGrid} role="tabpanel">
            <label className={styles.toggleLabel}><input type="checkbox" checked={draft.memoryEnabled} onChange={(event) => setDraft({ ...draft, memoryEnabled: event.target.checked })} /><span>启用向量语义召回</span></label>
            <span className={styles.memoryHint}>关闭后自动退化为标题与关键词检索；已有向量不会删除。</span>
            <label><span>向量权重</span><input type="number" min="0" max="1" step="0.05" value={draft.memoryVectorWeight} onChange={(event) => setDraft({ ...draft, memoryVectorWeight: event.target.value })} /></label>
            <label><span>正文词法权重</span><input type="number" min="0" max="1" step="0.05" value={draft.memoryLexicalWeight} onChange={(event) => setDraft({ ...draft, memoryLexicalWeight: event.target.value })} /></label>
            <label><span>标题权重</span><input type="number" min="0" max="1" step="0.05" value={draft.memoryTitleWeight} onChange={(event) => setDraft({ ...draft, memoryTitleWeight: event.target.value })} /></label>
            <label><span>最低相关度</span><input type="number" min="0" max="1" step="0.01" value={draft.memoryMinimumScore} onChange={(event) => setDraft({ ...draft, memoryMinimumScore: event.target.value })} /></label>
            <label><span>结果多样性</span><input type="number" min="0" max="1" step="0.01" value={draft.memoryDiversityLambda} onChange={(event) => setDraft({ ...draft, memoryDiversityLambda: event.target.value })} /></label>
            <label><span>候选召回数</span><input type="number" min="8" max="256" value={draft.memoryRecallLimit} onChange={(event) => setDraft({ ...draft, memoryRecallLimit: event.target.value })} /></label>
            <label><span>单次返回数</span><input type="number" min="1" max="20" value={draft.memoryResultLimit} onChange={(event) => setDraft({ ...draft, memoryResultLimit: event.target.value })} /></label>
            <label><span>Token 预算</span><input type="number" min="256" max="20000" value={draft.memoryTokenBudget} onChange={(event) => setDraft({ ...draft, memoryTokenBudget: event.target.value })} /></label>
            <label><span>分页大小</span><input type="number" min="5" max="100" value={draft.memoryPageSize} onChange={(event) => setDraft({ ...draft, memoryPageSize: event.target.value })} /></label>
          </div>}
        </section> : null}
        {provider.purpose === "ocr" && draft.protocol !== "mineru" ? <label><span>最大输出 Token</span><input type="number" min="256" max="32768" value={draft.maxOutputTokens} onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value })} /></label> : null}
      </div>
      <footer className={styles.cardFooter}><span>{provider.updatedAt ? `更新于 ${new Date(provider.updatedAt).toLocaleString("zh-CN")}` : ""}</span><Button variant="primary" onClick={save} disabled={saving || !changed || (keyDirty && !draft.apiKey) || !draft.name.trim() || !draft.baseUrl.trim() || (["embedding", "ocr"].includes(provider.purpose) && !draft.model.trim())} icon={saving ? <LoaderCircle className={styles.spin} size={16} /> : <Save size={16} />}>{saving ? "保存中" : "保存"}</Button></footer>
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
  return <aside className={styles.usagePanel}><div className={styles.sectionTitle}><div><h2>API 用量</h2><p>请求次数与 Token 消耗</p></div><Activity size={19} /></div><div className={styles.usageTabs}>{(["all", "web", "agent", "embedding", "ocr"] as UsageScope[]).map((item) => <button key={item} className={scope === item ? styles.active : ""} onClick={() => setScope(item)}>{item === "all" ? "全部" : item === "web" ? "网页" : item === "agent" ? "Agent" : item === "embedding" ? "Embedding" : "OCR"}</button>)}</div><div className={styles.metrics}><TokenStat title="今日" metrics={usage.daily} /><TokenStat title="近 7 天" metrics={usage.weekly} /><TokenStat title="累计" metrics={usage.total} /></div><UsageChart series={usage.series} /></aside>;
}

function ApiPanel({ snapshot, usages, reload }: { snapshot: PlatformSnapshot; usages: Record<UsageScope, UsageSummary>; reload: () => Promise<void> }) {
  return <div className={styles.apiPanel}>
    <section className={styles.providers}>{(["web", "agent", "embedding", "ocr"] as Purpose[]).map((purpose) => <ProviderCard key={`${purpose}:${snapshot.providers[purpose].revision}`} provider={snapshot.providers[purpose]} revision={snapshot.revision} onSaved={reload} />)}</section>
    <UsagePanel usages={usages} />
  </div>;
}

function parseLines(value: string) { return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean); }
function parsePorts(value: string) { return parseLines(value).map(Number).filter((port) => Number.isInteger(port)); }

function SshPanel({ snapshot, reload }: { snapshot: PlatformSnapshot; reload: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [draft, setDraft] = useState(() => snapshot.ssh);
  const [saving, setSaving] = useState(false);
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
  </div>;
}

function connectionLabel(status: ManagedConnection["status"]) {
  return status === "connected" ? "已连接" : status === "connecting" ? "连接中" : status === "failed" ? "失败" : "未连接";
}

function UserPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const runtime = useAppRuntime();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ items: AdminUser[]; total: number; page: number; limit: number; hasMore: boolean } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadUsers = useCallback(async (search: string, nextPage: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: "30" });
      if (search.trim()) params.set("query", search.trim());
      const response = await runtime.api.get<{ items: AdminUser[]; total: number; page: number; limit: number; hasMore: boolean }>(`/api/admin/users?${params}`);
      setResult(response.data);
      if (selectedId && !response.data.items.some((user) => user.userId === selectedId) && search.trim()) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "用户列表读取失败", "error");
    } finally { setLoading(false); }
  }, [runtime, selectedId]);

  const loadDetail = useCallback(async (userId: string, cursor?: string) => {
    setDetailLoading(true);
    try {
      const suffix = cursor ? `?conversationCursor=${encodeURIComponent(cursor)}` : "";
      const response = await runtime.api.get<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(userId)}${suffix}`);
      setDetail((current) => cursor && current
        ? { ...response.data, conversations: { ...response.data.conversations, items: [...current.conversations.items, ...response.data.conversations.items] } }
        : response.data);
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "用户详情读取失败", "error");
    } finally { setDetailLoading(false); }
  }, [runtime]);

  useEffect(() => {
    const handle = window.setTimeout(() => void loadUsers(query, page), query ? 280 : 0);
    return () => window.clearTimeout(handle);
  }, [loadUsers, page, query, refreshKey]);

  useEffect(() => {
    if (!selectedId) return;
    const handle = window.setTimeout(() => void loadDetail(selectedId), 0);
    return () => window.clearTimeout(handle);
  }, [loadDetail, selectedId, refreshKey]);

  const disconnect = async (connection: AdminUserDetail["servers"][number]) => {
    if (!selectedId) return;
    setDisconnecting(connection.serverId);
    try {
      await runtime.api.post(`/api/admin/ssh-connections/${encodeURIComponent(selectedId)}/${encodeURIComponent(connection.serverId)}/disconnect`, {}, { idempotencyKey: commandId("admin-ssh-disconnect") });
      runtime.notify("SSH 连接已断开", "success");
      await Promise.all([loadDetail(selectedId), loadUsers(query, page)]);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "断开失败", "error"); }
    finally { setDisconnecting(null); }
  };

  const removeUser = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await runtime.api.delete(`/api/admin/users/${encodeURIComponent(pendingDelete.userId)}`, { idempotencyKey: commandId("admin-delete-user") });
      runtime.notify(`用户 ${pendingDelete.username} 已删除`, "success");
      if (selectedId === pendingDelete.userId) { setSelectedId(null); setDetail(null); }
      setPendingDelete(null);
      onChanged();
      await loadUsers(query, page);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "删除用户失败", "error"); }
    finally { setDeleting(false); }
  };

  return <div className={styles.userPanel}>
    <section className={styles.userListCard}>
      <div className={styles.sectionTitle}><div><h2>用户</h2><p>{result ? `共 ${result.total} 位用户` : "按需读取账号与在线状态"}</p></div><UsersRound size={20} /></div>
      <label className={styles.userSearch}><Search size={16} /><input value={query} placeholder="搜索用户名或用户 ID" onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
      {loading && !result ? <div className={styles.unavailable}><LoaderCircle className={styles.spin} size={22} /><strong>正在读取用户</strong></div> : result?.items.length ? <div className={styles.userRows}>{result.items.map((user) => <button type="button" className={`${styles.userRow} ${selectedId === user.userId ? styles.selectedUser : ""}`} key={user.userId} onClick={() => setSelectedId(user.userId)}><span data-ui-icon="" className={styles.userAvatar}>{user.username.slice(0, 1).toLocaleUpperCase("zh-CN")}</span><span className={styles.userIdentity}><strong>{user.username}{user.admin ? <em>管理员</em> : null}</strong><small>{user.activeSessionCount} 个活跃登录 · {user.liveSshCount} 个 SSH</small></span><time>{user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleDateString("zh-CN") : "—"}</time><ChevronRight size={16} /></button>)}</div> : <div className={styles.unavailable}><Network size={22} /><strong>没有匹配的用户</strong></div>}
      {result && result.total > result.limit ? <footer className={styles.pager}><Button compact disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button><span>{page} / {Math.ceil(result.total / result.limit)}</span><Button compact disabled={!result.hasMore || loading} onClick={() => setPage((value) => value + 1)}>下一页</Button></footer> : null}
    </section>
    <section className={styles.userDetailCard}>
      {!selectedId ? <div className={styles.unavailable}><UsersRound size={24} /><strong>选择一位用户</strong><span>仅在选中后读取其对话和服务器，避免拖慢页面。</span></div> : detailLoading && !detail ? <div className={styles.unavailable}><LoaderCircle className={styles.spin} size={22} /><strong>正在读取用户详情</strong></div> : detail ? <>
        <header className={styles.userDetailHeader}><div><strong>{detail.user.username}</strong><span>{detail.user.deviceCount} 台设备 · {detail.user.activeSessionCount} 个活跃登录 · {detail.taskCount} 个任务</span></div><Button compact variant="danger" icon={<Trash2 size={14} />} onClick={() => setPendingDelete(detail.user)}>删除用户</Button></header>
        <div className={styles.detailSection}><h3>SSH 连接 <span>{detail.servers.length}</span></h3>{detail.servers.length ? <div className={styles.detailRows}>{detail.servers.map((server) => <div className={styles.detailRow} key={server.serverId}><span><strong>{server.serverName}</strong><small>{server.host} · {server.conversationCount} 个对话</small></span><em className={`${styles.connectionStatus} ${styles[server.status]}`}>{connectionLabel(server.status)}</em><Button compact disabled={server.status !== "connected" || Boolean(disconnecting)} icon={disconnecting === server.serverId ? <LoaderCircle className={styles.spin} size={13} /> : <Unplug size={13} />} onClick={() => void disconnect(server)}>断开</Button></div>)}</div> : <p className={styles.emptyDetail}>尚未配置服务器</p>}</div>
        <div className={styles.detailSection}><h3>对话 <span>{detail.conversations.items.length}{detail.conversations.nextCursor ? "+" : ""}</span></h3>{detail.conversations.items.length ? <div className={styles.conversationRows}>{detail.conversations.items.map((conversation) => <div className={styles.conversationRow} key={conversation.id}><span><strong>{conversation.title}</strong><small>{conversation.lastMessagePreview || "暂无消息"}</small></span><em>{conversation.mode === "work" ? "工作" : "聊天"}</em><time>{new Date(conversation.updatedAt).toLocaleString("zh-CN")}</time></div>)}</div> : <p className={styles.emptyDetail}>暂无对话</p>}{detail.conversations.nextCursor ? <Button compact disabled={detailLoading} onClick={() => void loadDetail(selectedId, detail.conversations.nextCursor || undefined)}>加载更多</Button> : null}</div>
      </> : null}
    </section>
    {pendingDelete ? <Modal title="删除用户？" subtitle="账号、对话、服务器、技能、文件、记忆和运行数据都会永久删除。" size="compact" onClose={() => { if (!deleting) setPendingDelete(null); }}><div className={styles.deleteDialog}><p>确认删除“{pendingDelete.username}”及其全部数据？该操作无法撤销，当前登录会话也会立即失效。</p><footer><Button disabled={deleting} onClick={() => setPendingDelete(null)}>取消</Button><Button variant="danger" disabled={deleting} icon={deleting ? <LoaderCircle className={styles.spin} size={14} /> : <Trash2 size={14} />} onClick={() => void removeUser()}>{deleting ? "正在删除" : "删除全部数据"}</Button></footer></div></Modal> : null}
  </div>;
}

export default function AdminView() {
  const runtime = useAppRuntime();
  const { api, notify } = runtime;
  const [tab, setTab] = useState<"api" | "ssh" | "users">("api");
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);
  const [usages, setUsages] = useState<Record<UsageScope, UsageSummary>>({ all: emptyUsage, web: emptyUsage, agent: emptyUsage, embedding: emptyUsage, ocr: emptyUsage });
  const [userRefreshKey, setUserRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [platformResult, usageResult] = await Promise.allSettled([
      api.get<PlatformSnapshot>("/api/admin/platform"),
      api.get<UsageSummary>("/api/admin/usage?seriesDays=14"),
    ]);
    if (platformResult.status === "fulfilled") setSnapshot(platformResult.value.data);
    else notify(platformResult.reason instanceof Error ? platformResult.reason.message : "管理员配置读取失败", "error");
    if (usageResult.status === "fulfilled") setUsages((current) => ({ ...current, all: usageResult.value.data }));
    if (platformResult.status === "fulfilled") {
      const scoped = await Promise.allSettled((["web", "agent", "embedding", "ocr"] as Purpose[]).map(async (purpose) => ({
        purpose,
        result: await api.get<UsageSummary>(`/api/admin/usage?seriesDays=14&providerId=${encodeURIComponent(platformResult.value.data.providers[purpose].id)}`),
      })));
      setUsages((current) => {
        const next = { ...current };
        for (const entry of scoped) if (entry.status === "fulfilled") next[entry.value.purpose] = entry.value.result.data;
        return next;
      });
    }
  }, [api, notify]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load().finally(() => setLoading(false)); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  if (loading) return <LoadingState label="正在读取管理员配置" />;
  if (!snapshot) return <PageFrame icon={<ServerCog size={19} />} title="管理员面板"><div className={styles.pageError}>管理员配置暂时不可用</div></PageFrame>;
  return (
    <PageFrame icon={<ServerCog size={19} />} title="管理员面板" actions={<Button compact onClick={() => { if (tab === "users") setUserRefreshKey((value) => value + 1); else void load(); }} icon={<RefreshCw size={15} />}>刷新</Button>}>
      <div className={styles.tabs} role="tablist"><button className={tab === "api" ? styles.activeTab : ""} onClick={() => setTab("api")} role="tab" aria-selected={tab === "api"}><Activity size={16} />模型API</button><button className={tab === "ssh" ? styles.activeTab : ""} onClick={() => setTab("ssh")} role="tab" aria-selected={tab === "ssh"}><ServerCog size={16} />SSH管理</button><button className={tab === "users" ? styles.activeTab : ""} onClick={() => setTab("users")} role="tab" aria-selected={tab === "users"}><UsersRound size={16} />用户管理</button></div>
      <div className={styles.tabStage}>{tab === "api" ? <ApiPanel key={`api:${snapshot.revision}`} snapshot={snapshot} usages={usages} reload={load} /> : tab === "ssh" ? <SshPanel key={`ssh:${snapshot.revision}`} snapshot={snapshot} reload={load} /> : <UserPanel refreshKey={userRefreshKey} onChanged={() => setUserRefreshKey((value) => value + 1)} />}</div>
    </PageFrame>
  );
}
