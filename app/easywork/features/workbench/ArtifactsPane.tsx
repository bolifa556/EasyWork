"use client";

import { Archive, Download, Eye, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";
import type { ArtifactSummary, OpenPreviewRequest } from "./types";

function humanSize(size: number | null) {
  if (size === null) return "远端";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
}

export default function ArtifactsPane({ workspaceId, previewAvailable, onPreview }: { workspaceId: string; previewAvailable: boolean; onPreview: (request: OpenPreviewRequest) => Promise<void> }) {
  const runtime = useAppRuntime();
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runtime.api.get<{ items: ArtifactSummary[] }>(`/api/artifacts?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`, signal);
      setItems(result.data.items || []);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取产物");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtime.api, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  const download = async (item: ArtifactSummary) => {
    setBusy(item.id);
    try {
      const issued = await runtime.api.post<{ downloadToken: string }>(`/api/artifacts/${encodeURIComponent(item.id)}/download`, { ttlMs: 60_000 }, { idempotencyKey: commandId("artifact-download") });
      const response = await runtime.api.raw(`/api/artifacts/${encodeURIComponent(item.id)}/download?token=${encodeURIComponent(issued.data.downloadToken)}`, { method: "GET" });
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "下载产物失败", "error");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在读取产物</span></div>;
  if (error) return <div className={styles.state}><Archive size={22} /><strong>无法读取产物</strong><span>{error}</span><Button compact onClick={() => void load()}>重试</Button></div>;

  return <div className={styles.structuredPane}>
    <header className={styles.sectionToolbar}><div className={styles.sectionIdentity}><Archive size={18} /><span><strong>任务产物</strong><small>{items.length} 个文件</small></span></div><span className={styles.spacer} /><Button compact iconOnly variant="ghost" aria-label="刷新产物" icon={<RefreshCw size={15} />} onClick={() => void load()} /></header>
    {items.length ? <div className={styles.artifactGrid}>{items.map((item) => <article className={styles.artifactCard} key={item.id}>
      <span className={styles.artifactIcon}><Archive size={18} /></span>
      <span className={styles.artifactIdentity}><strong>{item.name}</strong><small>{item.kind} · {humanSize(item.size)} · {new Date(item.createdAt).toLocaleString("zh-CN")}</small></span>
      <span className={styles.lifecycle}>{item.lifecycle}</span>
      {previewAvailable ? <Button compact iconOnly variant="ghost" aria-label={`预览 ${item.name}`} icon={<Eye size={16} />} onClick={() => void onPreview({ source: { kind: "artifact", artifactId: item.id }, fallbackName: item.name, fallbackMime: item.mime, fallbackSize: item.size ?? 0 })} /> : null}
      <Button compact iconOnly variant="ghost" aria-label={`下载 ${item.name}`} icon={busy === item.id ? <LoaderCircle className={styles.spin} size={16} /> : <Download size={16} />} disabled={Boolean(busy)} onClick={() => void download(item)} />
    </article>)}</div> : <div className={styles.state}><Archive size={23} /><strong>这个工作区还没有产物</strong></div>}
  </div>;
}
