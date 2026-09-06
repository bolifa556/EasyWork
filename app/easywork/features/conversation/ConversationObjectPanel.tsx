"use client";

import { useEffect, useState } from "react";
import { FileDiff, FileText, ListTodo } from "lucide-react";
import type { TaskSummary } from "@/app/core/contracts";
import { useAppRuntime, type ConversationPanel } from "../../runtime/AppRuntime";
import { LoadingState } from "../../ui/LoadingState";
import styles from "./ConversationObjectPanel.module.css";

export function ConversationObjectPanel({ panel }: { panel: ConversationPanel }) {
  const { api, view, navigate, openFilePreview } = useAppRuntime();
  const conversationId = view.kind === "conversation" ? view.conversationId : null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskSummary | null>(null);
  useEffect(() => {
    if ((panel.kind === "file" || panel.kind === "artifact") && conversationId) {
      navigate({ kind: "conversation", conversationId }, { replace: true });
      openFilePreview({ conversationId, name: "文件", size: 0, source: panel.kind === "file" ? { kind: "preview", previewId: panel.previewId } : { kind: "artifact", artifactId: panel.artifactId } });
      return;
    }
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setLoading(true); setError(null); setTask(null);
      if (panel.kind !== "task") throw new Error("这项文件变化需要从对应工作区打开");
      const result = await api.get<TaskSummary>("/api/tasks/" + encodeURIComponent(panel.taskId), controller.signal);
      if (!controller.signal.aborted) setTask(result.data);
    })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "内容暂时无法打开"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, conversationId, navigate, openFilePreview, panel]);
  if (loading) return <div className={styles.panel}><LoadingState label="正在打开" /></div>;
  if (error) return <div className={styles.empty}>{panel.kind === "diff" ? <FileDiff size={27} /> : <FileText size={27} />}<strong>暂时无法打开</strong><span>{error}</span></div>;
  if (task) return <div className={styles.detail}><header><ListTodo size={20} /><div><h2>{task.goal}</h2><span>{task.status}</span></div></header>{task.plan.length ? <ol>{task.plan.map((step) => <li key={step.id} data-status={step.status}>{step.text}</li>)}</ol> : <div className={styles.subtle}>该任务没有独立执行计划</div>}</div>;
  return null;
}
