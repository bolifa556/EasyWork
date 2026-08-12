"use client";

import { Suspense, useEffect, useState, type ComponentType } from "react";
import { Archive, FileDiff, FileText, ListTodo } from "lucide-react";
import type { TaskSummary } from "@/app/core/contracts";
import { fileDescriptorFromPreview, registerDefaultViewers, resolveViewer, type FileDescriptor, type ViewerProps } from "@/app/core/registry/viewers";
import type { ConversationPanel } from "../../runtime/AppRuntime";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { LoadingState } from "../../ui/LoadingState";
import styles from "./ConversationObjectPanel.module.css";

registerDefaultViewers();

type PreviewDescriptor = {
  previewId: string;
  kind: FileDescriptor["kind"];
  name: string;
  mime: string;
  size: number;
  metadata?: Record<string, unknown>;
  delivery?: { acceptsRange?: boolean; maxBytes?: number };
};
type ArtifactDetail = { id: string; name: string; kind: string; mime: string; size: number | null; createdAt: string; updatedAt: string; lifecycle: string };
type PreviewState = { descriptor: FileDescriptor; Viewer: ComponentType<ViewerProps> };

export function ConversationObjectPanel({ panel }: { panel: ConversationPanel }) {
  const runtime = useAppRuntime();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [artifact, setArtifact] = useState<ArtifactDetail | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    let active = true;
    const handle = window.setTimeout(() => {
      if (!active) return;
      setLoading(true); setError(null); setTask(null); setArtifact(null); setPreview(null);
      void (async () => {
      try {
        if (panel.kind === "file") {
          const result = await runtime.api.get<PreviewDescriptor>(`/api/previews/${encodeURIComponent(panel.previewId)}`);
          const descriptor = fileDescriptorFromPreview(result.data);
          const viewer = resolveViewer(descriptor);
          if (!viewer) throw new Error("没有可用的文件查看器");
          const loaded = await viewer.load();
          if (active) setPreview({ descriptor, Viewer: loaded.default });
        } else if (panel.kind === "task") {
          const result = await runtime.api.get<TaskSummary>(`/api/tasks/${encodeURIComponent(panel.taskId)}`);
          if (active) setTask(result.data);
        } else if (panel.kind === "artifact") {
          const result = await runtime.api.get<ArtifactDetail>(`/api/artifacts/${encodeURIComponent(panel.artifactId)}`);
          if (active) setArtifact(result.data);
        } else {
          throw new Error("这项文件变化需要从对应工作区打开");
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "内容暂时无法打开");
      } finally { if (active) setLoading(false); }
      })();
    }, 0);
    return () => { active = false; window.clearTimeout(handle); };
  }, [panel, runtime.api]);

  if (loading) return <div className={styles.panel}><LoadingState label="正在打开" /></div>;
  if (error) return <div className={styles.empty}>{panel.kind === "diff" ? <FileDiff size={27} /> : <FileText size={27} />}<strong>暂时无法打开</strong><span>{error}</span></div>;
  if (preview) return <div className={styles.viewer}><Suspense fallback={<LoadingState label="正在载入查看器" />}><preview.Viewer descriptor={preview.descriptor} previewId={panel.kind === "file" ? panel.previewId : ""} /></Suspense></div>;
  if (task) return <div className={styles.detail}><header><ListTodo size={20} /><div><h2>{task.goal}</h2><span>{task.status}</span></div></header>{task.plan.length ? <ol>{task.plan.map((step) => <li key={step.id} data-status={step.status}>{step.text}</li>)}</ol> : <div className={styles.subtle}>该任务没有独立执行计划</div>}</div>;
  if (artifact) return <div className={styles.detail}><header><Archive size={20} /><div><h2>{artifact.name}</h2><span>{artifact.kind} · {artifact.size == null ? "远端文件" : `${Math.ceil(artifact.size / 1024)} KB`}</span></div></header><dl><div><dt>类型</dt><dd>{artifact.mime}</dd></div><div><dt>状态</dt><dd>{artifact.lifecycle}</dd></div><div><dt>更新时间</dt><dd>{new Date(artifact.updatedAt).toLocaleString("zh-CN")}</dd></div></dl></div>;
  return null;
}
