"use client";

import { ListTodo, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { TaskSummary } from "@/app/core/contracts";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { PageFrame, pageFrameStyles } from "../../ui/PageFrame";
import styles from "./TaskCenter.module.css";

const statusLabel: Record<TaskSummary["status"], string> = {
  queued: "排队中", preparing: "准备中", delivering_context: "同步上下文", running: "运行中",
  waiting_approval: "等待确认", waiting_append: "等待追加", interrupting: "正在中断", interrupted: "已中断",
  recovering: "恢复中", finalizing: "整理结果", completed: "已完成", failed: "失败", cancelled: "已取消",
};

export default function TaskCenter() {
  const runtime = useAppRuntime();
  const { api, notify } = runtime;
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [filter, setFilter] = useState<"all" | "running" | "completed">("all");
  const load = async () => {
    try {
      const result = await runtime.api.get<TaskSummary[]>("/api/tasks?limit=100");
      setTasks(result.data);
    } catch (error) {
      notify(error instanceof Error ? error.message : "任务读取失败", "error");
    }
  };
  useEffect(() => {
    let active = true;
    void api.get<TaskSummary[]>("/api/tasks?limit=100").then(
      (result) => { if (active) setTasks(result.data); },
      (error: Error) => { if (active) notify(error.message, "error"); },
    );
    return () => { active = false; };
  }, [api, notify]);
  const shown = tasks.filter((task) => filter === "all" || (filter === "running" ? !["completed","failed","cancelled"].includes(task.status) : task.status === "completed"));
  return <PageFrame icon={<ListTodo size={19} />} title="任务" count={tasks.length} actions={<Button compact variant="ghost" icon={<RotateCw size={15} />} onClick={() => void load()}>刷新</Button>}>
    <div className={styles.filters}>{(["all","running","completed"] as const).map((value) => <button key={value} className={`${styles.filter} ${filter === value ? styles.active : ""}`} onClick={() => setFilter(value)}>{value === "all" ? "全部" : value === "running" ? "进行中" : "已完成"}</button>)}</div>
    {shown.length ? <section className={`${pageFrameStyles.surface} ${styles.list}`}>{shown.map((task) => <article key={task.id} className={styles.task}><div className={styles.name}><strong>{task.goal}</strong><span>{task.id}</span></div><div className={styles.meta}>{task.route.agentId}</div><span className={`${styles.status} ${task.status === "completed" ? styles.done : task.status === "failed" ? styles.failed : ""}`}>{statusLabel[task.status]}</span><Button compact variant="ghost" onClick={() => runtime.navigate({ kind: "conversation", conversationId: task.conversationId })}>打开</Button></article>)}</section> : <div className={styles.empty}><ListTodo size={25} /><strong>{tasks.length ? "没有符合筛选的任务" : "还没有任务"}</strong></div>}
  </PageFrame>;
}
