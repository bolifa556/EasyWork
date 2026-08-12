"use client";

import { Ban, ChevronDown, ChevronRight, Clock3, Cpu, FileText, Gauge, LoaderCircle, Play, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ServerCapabilityProfile } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";
import type { ResourceBreakdown, SchedulerJob, SchedulerPartition, SchedulerSummary } from "./types";

const jobLabels: Record<SchedulerJob["state"], string> = {
  pending: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
  unknown: "未知",
};

function decode(value: string) {
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function Breakdown({ label, value, icon }: { label: string; value: ResourceBreakdown; icon: ReactNode }) {
  const available = value.total ? Math.round((value.idle / value.total) * 100) : 0;
  return <article className={styles.resourceCard}><span className={styles.resourceIcon}>{icon}</span><span className={styles.resourceText}><strong>{label}</strong><small>{value.idle} 空闲 · {value.allocated} 使用中 · {value.mixed} 混合</small></span><span className={styles.resourceValue}>{value.total}<small>{available}% 空闲</small></span></article>;
}

export default function SchedulerPane({ serverId, capability }: { serverId: string; capability: ServerCapabilityProfile["features"]["scheduler"] }) {
  const runtime = useAppRuntime();
  const [summary, setSummary] = useState<SchedulerSummary | null>(null);
  const [partitions, setPartitions] = useState<SchedulerPartition[]>([]);
  const [jobs, setJobs] = useState<SchedulerJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [partition, setPartition] = useState("");
  const [scriptPath, setScriptPath] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [summaryResult, partitionResult, jobResult] = await Promise.all([
        capability.resourceSummary ? runtime.api.get<SchedulerSummary>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/resources`, signal) : Promise.resolve(null),
        capability.partitions ? runtime.api.get<SchedulerPartition[]>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/partitions`, signal) : Promise.resolve(null),
        capability.userJobs ? runtime.api.get<SchedulerJob[]>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs`, signal) : Promise.resolve(null),
      ]);
      setSummary(summaryResult?.data || null);
      setPartitions(partitionResult?.data || []);
      setJobs(jobResult?.data || []);
      if (partitionResult?.data?.length) setPartition((current) => current || partitionResult.data.find((item) => item.isDefault)?.id || partitionResult.data[0].id);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取算力信息");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [capability.partitions, capability.resourceSummary, capability.userJobs, runtime.api, serverId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const loadOutput = async (jobId: string) => {
    setExpandedJob((current) => current === jobId ? null : jobId);
    if (outputs[jobId] !== undefined) return;
    setBusy(`output:${jobId}`);
    try {
      const result = await runtime.api.get<{ bytesBase64: string; eof: boolean }>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs/${encodeURIComponent(jobId)}/output?stream=stdout&offset=0&maxBytes=262144`);
      setOutputs((current) => ({ ...current, [jobId]: decode(result.data.bytesBase64) || "作业暂时没有输出" }));
    } catch (reason) {
      setOutputs((current) => ({ ...current, [jobId]: reason instanceof Error ? reason.message : "无法读取作业输出" }));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (jobId: string) => {
    if (!window.confirm(`确定取消作业 ${jobId} 吗？`)) return;
    setBusy(`cancel:${jobId}`);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs/${encodeURIComponent(jobId)}/cancel`, {}, { idempotencyKey: commandId("scheduler-cancel") });
      await load();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "取消作业失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!partition || !scriptPath.trim()) return;
    setBusy("submit");
    try {
      const result = await runtime.api.post<{ jobId: string }>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs`, {
        partition,
        scriptPath: scriptPath.trim(),
        args: [],
      }, { idempotencyKey: commandId("scheduler-submit") });
      runtime.notify(`作业 ${result.data.jobId} 已提交`, "success");
      setScriptPath("");
      setShowSubmit(false);
      await load();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "提交作业失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const sortedJobs = useMemo(() => [...jobs].sort((left, right) => {
    const order: Record<SchedulerJob["state"], number> = { running: 0, pending: 1, failed: 2, timeout: 3, cancelled: 4, completed: 5, unknown: 6 };
    return order[left.state] - order[right.state] || left.id.localeCompare(right.id);
  }), [jobs]);

  if (loading) return <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在读取调度器</span></div>;
  if (error) return <div className={styles.state}><ServerCog size={22} /><strong>调度器暂时不可用</strong><span>{error}</span><Button compact onClick={() => void load()}>重试</Button></div>;

  return <div className={styles.schedulerPane}>
    <header className={styles.sectionToolbar}>
      <div className={styles.sectionIdentity}><ServerCog size={18} /><span><strong>{capability.type === "slurm" ? "Slurm" : capability.type === "pbs" ? "PBS" : "远端任务"}</strong><small>{summary?.scope.label || `${partitions.length} 个可用队列`}</small></span></div>
      <span className={styles.spacer} />
      <Button compact iconOnly variant="ghost" aria-label="刷新算力信息" icon={<RefreshCw size={15} />} disabled={Boolean(busy)} onClick={() => void load()} />
      {capability.submitJob ? <Button compact variant="secondary" icon={<Play size={15} />} onClick={() => setShowSubmit((value) => !value)}>提交作业</Button> : null}
    </header>
    {showSubmit ? <div className={styles.submitBar}>
      <select aria-label="分区" value={partition} onChange={(event) => setPartition(event.target.value)}>{partitions.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? "（默认）" : ""}</option>)}</select>
      <input aria-label="脚本路径" value={scriptPath} placeholder="远端脚本绝对路径" onChange={(event) => setScriptPath(event.target.value)} />
      <Button compact variant="primary" disabled={!partition || !scriptPath.trim() || Boolean(busy)} icon={busy === "submit" ? <LoaderCircle className={styles.spin} size={14} /> : <Play size={14} />} onClick={() => void submit()}>提交</Button>
    </div> : null}
    <div className={styles.schedulerScroll}>
      {summary ? <section className={styles.resourceGrid}>
        <Breakdown label="节点" value={summary.nodes} icon={<ServerCog size={17} />} />
        <Breakdown label="CPU 核心" value={summary.cpuCores} icon={<Cpu size={17} />} />
        <Breakdown label="加速卡" value={summary.accelerators} icon={<Gauge size={17} />} />
        <article className={styles.resourceCard}><span className={styles.resourceIcon}><Clock3 size={17} /></span><span className={styles.resourceText}><strong>我的作业</strong><small>{summary.currentUserJobs.running} 运行 · {summary.currentUserJobs.pending} 等待</small></span><span className={styles.resourceValue}>{summary.currentUserJobs.running + summary.currentUserJobs.pending}<small>{new Date(summary.sampledAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></span></article>
      </section> : null}
      <section className={styles.schedulerSection}>
        <div className={styles.sectionHeading}><span>作业</span><small>{sortedJobs.length}</small></div>
        {sortedJobs.length ? <div className={styles.jobList}>{sortedJobs.map((job) => {
          const open = expandedJob === job.id;
          return <article className={styles.job} key={job.id}>
            <button className={styles.jobMain} onClick={() => capability.jobOutput ? void loadOutput(job.id) : undefined}>{capability.jobOutput ? open ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <FileText size={15} />}<span className={styles.jobName}><strong>{job.name || job.id}</strong><small>{job.id} · {job.partition} · {job.nodes ?? 0} 节点 / {job.cpuCores ?? 0} 核</small></span><span className={`${styles.jobState} ${styles[`job_${job.state}`] || ""}`}>{jobLabels[job.state]}</span><span className={styles.jobTime}>{job.elapsed || job.locationOrReason || ""}</span></button>
            {capability.cancelJob && ["running", "pending"].includes(job.state) ? <Button compact variant="danger" icon={busy === `cancel:${job.id}` ? <LoaderCircle className={styles.spin} size={14} /> : <Ban size={14} />} disabled={Boolean(busy)} onClick={() => void cancel(job.id)}>取消</Button> : null}
            {open ? <pre className={styles.jobOutput}>{busy === `output:${job.id}` ? "正在读取作业输出…" : outputs[job.id]}</pre> : null}
          </article>;
        })}</div> : <div className={styles.inlineEmpty}>当前没有作业</div>}
      </section>
    </div>
  </div>;
}
