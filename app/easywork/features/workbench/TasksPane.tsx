"use client";

import { CircleStop, LoaderCircle, MessageSquareText, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TaskStatus, TaskSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";

const statusLabel: Record<TaskStatus, string> = {
  queued: "排队中",
  preparing: "准备中",
  delivering_context: "同步上下文",
  running: "运行中",
  waiting_approval: "等待确认",
  waiting_append: "等待追加",
  interrupting: "正在中断",
  interrupted: "已中断",
  recovering: "恢复中",
  finalizing: "整理结果",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const activeStatuses = new Set<TaskStatus>(["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_append", "interrupting", "recovering", "finalizing"]);

export default function TasksPane({ serverId }: { serverId: string }) {
  const runtime = useAppRuntime();
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runtime.api.get<TaskSummary[]>("/api/tasks?limit=200", signal);
      setTasks(result.data.filter((task) => task.route.serverId === serverId));
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取任务");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtime.api, serverId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  const interrupt = async (task: TaskSummary) => {
    setBusy(task.id);
    try {
      await runtime.api.post(`/api/tasks/${encodeURIComponent(task.id)}/interrupt`, {}, { idempotencyKey: commandId("task-interrupt") });
      await load();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "中断任务失败", "error");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在读取任务</span></div>;
  if (error) return <div className={styles.state}><ServerCog size={22} /><strong>无法读取任务</strong><span>{error}</span><Button compact onClick={() => void load()}>重试</Button></div>;

  return <div className={styles.structuredPane}>
    <header className={styles.sectionToolbar}><div className={styles.sectionIdentity}><ServerCog size={18} /><span><strong>远端任务</strong><small>{tasks.length} 个任务</small></span></div><span className={styles.spacer} /><Button compact iconOnly variant="ghost" aria-label="刷新任务" icon={<RefreshCw size={15} />} onClick={() => void load()} /></header>
    {tasks.length ? <div className={styles.taskList}>{tasks.map((task) => <article className={styles.taskRow} key={task.id}>
      <span className={`${styles.taskStatusDot} ${activeStatuses.has(task.status) ? styles.taskRunning : task.status === "failed" ? styles.taskFailed : ""}`} />
      <span className={styles.taskIdentity}><strong>{task.goal}</strong><small>{task.route.agentId} · {task.plan.length ? `${task.plan.filter((item) => item.status === "completed").length}/${task.plan.length} 步` : task.id}</small></span>
      <span className={styles.taskStatus}>{statusLabel[task.status]}</span>
      {activeStatuses.has(task.status) ? <Button compact variant="ghost" icon={busy === task.id ? <LoaderCircle className={styles.spin} size={14} /> : <CircleStop size={14} />} disabled={Boolean(busy)} onClick={() => void interrupt(task)}>中断</Button> : null}
      <Button compact variant="ghost" icon={<MessageSquareText size={14} />} onClick={() => runtime.navigate({ kind: "conversation", conversationId: task.conversationId })}>对话</Button>
    </article>)}</div> : <div className={styles.state}><ServerCog size={23} /><strong>这台服务器还没有任务</strong></div>}
  </div>;
}
