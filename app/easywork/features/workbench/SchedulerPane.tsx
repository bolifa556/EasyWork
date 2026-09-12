"use client";

import { CalendarDays, ChevronLeft, ChevronRight, Cpu, Gauge, LoaderCircle, Play, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { ServerCapabilityProfile } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";
import type { ResourceBreakdown, SchedulerDashboard, SchedulerJob, SchedulerPartition, SchedulerResourceSnapshot, SchedulerSummary, SystemMonitorSnapshot } from "./types";
import { DEFAULT_JOB_COLUMNS, DEFAULT_JOB_TABLE_WIDTH, JOB_COLUMNS, JOB_COLUMN_WIDTHS_KEY, MAX_JOB_COLUMN_WIDTH, normalizeJobColumnWidths, resizeJobColumn } from "./job-table-columns";

const schedulerDashboardCache = new Map<string, SchedulerDashboard>();
const schedulerHistoryCache = new Map<string, SchedulerJob[]>();
const systemMonitorCache = new Map<string, SystemMonitorSnapshot>();
const RESOURCE_REFRESH_MS = 30_000;
const HISTORY_PAGE_SIZE = 50;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * 42;

type HistoryPreset = "7" | "30" | "90" | "180" | "365" | "custom";
type HistoryRange = { startDate: string; endDate: string };

function localIsoDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentHistoryRange(days = 30): HistoryRange {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return { startDate: localIsoDate(start), endDate: localIsoDate(end) };
}

function historyCacheKey(serverId: string, range: HistoryRange) {
  return `${serverId}:${range.startDate}:${range.endDate}`;
}

const breakdownColors = {
  idle: "#829f73",
  allocated: "#c89c5b",
  mixed: "#8e89b3",
  unavailable: "#c78172",
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function formatJobDateTime(value?: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  return `${localIsoDate(date).replaceAll("-", "/")} ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function Donut({ segments, value, caption, label }: {
  segments: Array<{ value: number; color: string }>;
  value: string;
  caption: string;
  label: string;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  let offset = 0;
  return <div className={styles.donut} role="img" aria-label={label}>
    <svg data-ui-icon="" viewBox="0 0 100 100" aria-hidden="true">
      <circle className={styles.donutTrack} cx="50" cy="50" r="42" />
      {total > 0 ? segments.map((segment, index) => {
        const length = (Math.max(0, segment.value) / total) * DONUT_CIRCUMFERENCE;
        const dashLength = Math.max(0, length - 1.4);
        const dashOffset = -offset;
        offset += length;
        return <circle
          className={styles.donutSegment}
          cx="50"
          cy="50"
          r="42"
          key={`${segment.color}:${index}`}
          stroke={segment.color}
          strokeDasharray={`${dashLength} ${DONUT_CIRCUMFERENCE - dashLength}`}
          strokeDashoffset={dashOffset}
        />;
      }) : null}
    </svg>
    <span className={styles.donutCenter}><strong>{value}</strong><small>{caption}</small></span>
  </div>;
}

function Legend({ items }: { items: Array<{ label: string; value: number; color: string }> }) {
  return <div className={styles.chartLegend}>{items.map((item) => <span key={item.label}>
    <i data-ui-icon="" style={{ backgroundColor: item.color }} />
    <small>{item.label}</small>
    <strong>{item.value}</strong>
  </span>)}</div>;
}

function BreakdownChart({ label, value, icon }: { label: string; value: ResourceBreakdown; icon: ReactNode }) {
  const available = value.total ? Math.round((value.idle / value.total) * 100) : 0;
  const items = [
    { label: "空闲", value: value.idle, color: breakdownColors.idle },
    { label: "使用", value: value.allocated, color: breakdownColors.allocated },
    { label: "混合", value: value.mixed, color: breakdownColors.mixed },
    { label: "不可用", value: value.unavailable, color: breakdownColors.unavailable },
  ];
  return <article className={styles.chartCard}>
    <header><span>{icon}<strong>{label}</strong></span><small>总数 {value.total}</small></header>
    <div className={styles.chartBody}>
      <Donut segments={items} value={`${available}%`} caption="空闲" label={`${label} ${available}% 空闲`} />
      <Legend items={items} />
    </div>
  </article>;
}

function UsageChart({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: ReactNode }) {
  const percentage = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return <article className={`${styles.chartCard} ${styles.usageChartCard}`}>
    <header><span>{icon}<strong>{label}</strong></span><small>{detail}</small></header>
    <div className={`${styles.chartBody} ${styles.usageChartBody}`}>
      <Donut
        segments={[{ value: percentage, color: breakdownColors.allocated }, { value: 100 - percentage, color: "#dfe7da" }]}
        value={`${Math.round(percentage)}%`}
        caption="已使用"
        label={`${label} 已使用 ${Math.round(percentage)}%`}
      />
    </div>
  </article>;
}

function EmptyMetricCard({ label, detail }: { label: string; detail: string }) {
  return <article className={`${styles.chartCard} ${styles.emptyChartCard}`}>
    <header><span><ServerCog size={16} /><strong>{label}</strong></span></header>
    <div className={styles.inlineNotice}>{detail}</div>
  </article>;
}

function SystemMonitorPane({ serverId }: { serverId: string }) {
  const runtime = useAppRuntime();
  const cached = systemMonitorCache.get(serverId) || null;
  const [snapshot, setSnapshot] = useState<SystemMonitorSnapshot | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal, refresh = false) => {
    if (!systemMonitorCache.has(serverId)) setLoading(true);
    try {
      const result = await runtime.api.get<SystemMonitorSnapshot>(`/api/servers/${encodeURIComponent(serverId)}/system/monitor${refresh ? "?refresh=1" : ""}`, signal);
      systemMonitorCache.set(serverId, result.data);
      setSnapshot(result.data);
      setError(null);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取服务器资源");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtime.api, serverId]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void load(controller.signal, true), 0);
    const interval = window.setInterval(() => void load(controller.signal, true), 5_000);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(interval); };
  }, [load]);

  if (loading && !snapshot) return <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在读取服务器资源</span></div>;
  if (error && !snapshot) return <div className={styles.state}><ServerCog size={22} /><strong>资源监控暂时不可用</strong><span>{error}</span><Button compact onClick={() => void load(undefined, true)}>重试</Button></div>;
  if (!snapshot) return null;

  return <div className={styles.schedulerPane}>
    <header className={styles.sectionToolbar}>
      <div className={styles.sectionIdentity}><ServerCog size={18} /><span><strong>服务器资源</strong></span></div>
      <span className={styles.spacer} />
      {error ? <small className={styles.staleHint}>更新失败，显示上次结果</small> : null}
      <Button compact iconOnly variant="ghost" aria-label="刷新服务器资源" icon={<RefreshCw size={15} />} onClick={() => void load(undefined, true)} />
    </header>
    <div className={styles.schedulerScroll}>
      <section className={`${styles.metricGrid} ${styles.systemMetricGrid}`}>
        <UsageChart label="CPU" value={snapshot.cpu.usagePercent} detail={`${snapshot.cpu.cores} 个逻辑核心`} icon={<Cpu size={16} />} />
        <UsageChart label="内存" value={snapshot.memory.usagePercent} detail={`${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)}`} icon={<Gauge size={16} />} />
        {snapshot.gpus.length ? snapshot.gpus.flatMap((gpu) => [
          <UsageChart key={`${gpu.index}:usage`} label={`${gpu.name} 利用率`} value={gpu.utilizationPercent} detail={`GPU ${gpu.index}`} icon={<ServerCog size={16} />} />,
          <UsageChart key={`${gpu.index}:memory`} label={`${gpu.name} 显存`} value={gpu.memoryTotalBytes ? (gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100 : 0} detail={`${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`} icon={<Gauge size={16} />} />,
        ]) : <EmptyMetricCard label="GPU" detail="当前服务器未检测到 NVIDIA GPU" />}
      </section>
      <section className={styles.schedulerSection}>
        <div className={styles.sectionHeading}><span>进程</span><small>{snapshot.processes.length}</small><time>{new Date(snapshot.sampledAt).toLocaleTimeString("zh-CN")}</time></div>
        <div className={styles.processTable}>
          <div className={styles.processHead}><span>PID</span><span>用户</span><span>CPU</span><span>内存</span><span>状态</span><span>命令</span></div>
          {snapshot.processes.map((process) => <div className={styles.processRow} key={process.pid}><code>{process.pid}</code><span>{process.user}</span><strong>{process.cpuPercent.toFixed(1)}%</strong><span>{process.memoryPercent.toFixed(1)}%</span><span>{process.state}</span><code title={process.command}>{process.command}</code></div>)}
        </div>
      </section>
    </div>
  </div>;
}

const jobLabels: Record<SchedulerJob["state"], string> = {
  pending: "等待中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
  unknown: "未知",
};

function isActiveJob(job: SchedulerJob) {
  return job.state === "running" || job.state === "pending";
}

function jobApplication(job: SchedulerJob) {
  const source = String(job.name || "").toLocaleLowerCase("en-US");
  if (/(^|[_.-])(python|py)([_.-]|$)|\.py$/u.test(source)) return "Python";
  if (/(^|[_.-])matlab([_.-]|$)|\.m$/u.test(source)) return "MATLAB";
  if (/(^|[_.-])(rscript|r-lang)([_.-]|$)|\.r$/u.test(source)) return "R";
  if (/(^|[_.-])julia([_.-]|$)|\.jl$/u.test(source)) return "Julia";
  if (/(^|[_.-])(node|npm|javascript|typescript)([_.-]|$)|\.[cm]?[jt]sx?$/u.test(source)) return "Node.js";
  if (/(^|[_.-])(gromacs|gmx)([_.-]|$)/u.test(source)) return "GROMACS";
  if (/(^|[_.-])(lammps|lmp)([_.-]|$)/u.test(source)) return "LAMMPS";
  if (/(^|[_.-])(bash|shell|sh)([_.-]|$)|\.(?:ba)?sh$/u.test(source)) return "Shell";
  return "批处理";
}

function JobList({ jobs, capability, history = false, busy, columnWidths, onColumnWidthsChange, onCancel }: {
  jobs: SchedulerJob[];
  capability: ServerCapabilityProfile["features"]["scheduler"];
  history?: boolean;
  busy: string | null;
  columnWidths: number[] | null;
  onColumnWidthsChange: (widths: number[] | null) => void;
  onCancel?: (jobId: string) => void;
}) {
  const tableRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ index: number; pointerId: number; startX: number; widths: number[]; next: number[] } | null>(null);
  const paintFrame = useRef<number | null>(null);
  const [resizingColumn, setResizingColumn] = useState<number | null>(null);
  const readWidths = () => Array.from(headRef.current?.children || []).map((cell) => cell.getBoundingClientRect().width);
  const paintWidths = (widths: number[]) => {
    tableRef.current?.style.setProperty("--job-columns", widths.map((width) => `${width}px`).join(" "));
    tableRef.current?.style.setProperty("--job-table-width", `${widths.reduce((sum, width) => sum + width, 0)}px`);
  };
  useEffect(() => () => {
    if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
  }, []);
  const startColumnResize = (index: number, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const widths = readWidths();
    if (widths.length !== JOB_COLUMNS.length) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { index, pointerId: event.pointerId, startX: event.clientX, widths, next: widths };
    setResizingColumn(index);
  };
  const moveColumnResize = (event: PointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resize.next = resizeJobColumn(resize.widths, resize.index, event.clientX - resize.startX);
    if (paintFrame.current === null) paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      if (resizeRef.current) paintWidths(resizeRef.current.next);
    });
  };
  const finishColumnResize = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current);
    paintFrame.current = null;
    resizeRef.current = null;
    const next = cancelled ? resize.widths : resize.next;
    paintWidths(next);
    onColumnWidthsChange(next);
    setResizingColumn(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeColumnWithKeyboard = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const widths = readWidths();
    if (widths.length !== JOB_COLUMNS.length) return;
    const delta = event.key === "Home" ? JOB_COLUMNS[index].min - widths[index]
      : event.key === "End" ? MAX_JOB_COLUMN_WIDTH - widths[index]
      : (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 12);
    onColumnWidthsChange(resizeJobColumn(widths, index, delta));
  };
  return <div className={styles.jobTableViewport}>
    <div ref={tableRef} className={`${styles.jobTable} ${resizingColumn !== null ? styles.resizingColumns : ""}`} role="table" aria-label={history ? "历史作业" : "当前作业"} style={{
      "--job-columns": columnWidths ? columnWidths.map((width) => `${width}px`).join(" ") : DEFAULT_JOB_COLUMNS,
      "--job-table-width": columnWidths ? `${columnWidths.reduce((sum, width) => sum + width, 0)}px` : undefined,
      "--job-table-min-width": `${DEFAULT_JOB_TABLE_WIDTH}px`,
    } as CSSProperties}>
      <div ref={headRef} className={styles.jobTableHead} role="row">
        {JOB_COLUMNS.map((column, index) => <span role="columnheader" key={column.label}>
          <span className={styles.jobColumnLabel}>{column.label}</span>
          <button type="button" className={styles.columnResizeHandle} role="separator" aria-orientation="vertical" aria-label={`调整${column.label}列宽`} aria-valuemin={column.min} aria-valuemax={MAX_JOB_COLUMN_WIDTH} aria-valuenow={columnWidths?.[index] ?? column.width} title="拖动调整列宽，双击恢复默认"
            onPointerDown={(event) => startColumnResize(index, event)} onPointerMove={moveColumnResize} onPointerUp={finishColumnResize} onPointerCancel={(event) => finishColumnResize(event, true)} onLostPointerCapture={finishColumnResize}
            onKeyDown={(event) => resizeColumnWithKeyboard(index, event)} onDoubleClick={() => onColumnWidthsChange(null)} />
        </span>)}
      </div>
      <div className={styles.jobList} role="rowgroup">{jobs.map((job) => {
        return <article className={`${styles.job} ${history ? styles.historyJob : ""}`} role="row" key={job.id}>
          <div className={styles.jobNameCell} role="cell">
            <span className={styles.jobName}><strong title={job.name || job.id}>{job.name || job.id}</strong><small>ID {job.id}</small></span>
          </div>
          <span className={`${styles.jobCell} ${styles.jobApplication}`} role="cell" data-label="应用"><strong>{jobApplication(job)}</strong></span>
          <span className={`${styles.jobCell} ${styles.jobResource}`} role="cell" data-label="队列 / 资源"><strong>{job.partition || "未指定"}</strong><small>{job.nodes ?? 0} 节点 · {job.cpuCores ?? 0} 核</small></span>
          <span className={`${styles.jobCell} ${styles.jobDuration}`} role="cell" data-label="运行时长"><strong>{job.elapsed || "—"}</strong>{job.timeLeft ? <small>剩余 {job.timeLeft}</small> : null}</span>
          <span className={`${styles.jobCell} ${styles.jobDate} ${styles.jobStart}`} role="cell" data-label="开始时间"><time>{formatJobDateTime(job.startedAt || job.submittedAt)}</time></span>
          <span className={`${styles.jobCell} ${styles.jobDate} ${styles.jobEnd}`} role="cell" data-label="结束时间"><time>{formatJobDateTime(job.endedAt || job.expectedEndAt)}</time>{job.expectedEndAt && !job.endedAt ? <small>预计</small> : null}</span>
          <span className={styles.jobStatusCell} role="cell" data-label="作业状态">
            <span className={`${styles.jobState} ${styles[`job_${job.state}`] || ""}`}>{jobLabels[job.state]}</span>
            {onCancel && capability.cancelJob && isActiveJob(job) ? <button type="button" className={styles.jobCancel} aria-label={`取消作业 ${job.id}`} aria-busy={busy === `cancel:${job.id}`} disabled={Boolean(busy)} onClick={() => onCancel(job.id)}>{busy === `cancel:${job.id}` ? "取消中" : "取消"}</button> : null}
          </span>
        </article>;
      })}</div>
    </div>
  </div>;
}

type SchedulerPaneProps = {
  serverId: string;
  workspaceId: string;
  conversationId: string;
  branchId: string;
  capability: ServerCapabilityProfile["features"]["scheduler"];
};

function ClusterSchedulerPane({ serverId, workspaceId, conversationId, branchId, capability }: SchedulerPaneProps) {
  const runtime = useAppRuntime();
  const cached = schedulerDashboardCache.get(serverId);
  const [initialHistoryRange] = useState<HistoryRange>(() => recentHistoryRange(30));
  const [summary, setSummary] = useState<SchedulerSummary | null>(cached?.summary || null);
  const [partitions, setPartitions] = useState<SchedulerPartition[]>(cached?.partitions || []);
  const [jobs, setJobs] = useState<SchedulerJob[]>(cached?.jobs || []);
  const [history, setHistory] = useState<SchedulerJob[]>(() => schedulerHistoryCache.get(historyCacheKey(serverId, initialHistoryRange)) || []);
  const [historyRange, setHistoryRange] = useState<HistoryRange>(initialHistoryRange);
  const [historyDraft, setHistoryDraft] = useState<HistoryRange>(initialHistoryRange);
  const [historyPreset, setHistoryPreset] = useState<HistoryPreset>("30");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(Boolean(capability.jobHistory));
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<number[] | null>(() => {
    try { return normalizeJobColumnWidths(JSON.parse(localStorage.getItem(JOB_COLUMN_WIDTHS_KEY) || "null")); }
    catch { return null; }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  const [jobTab, setJobTab] = useState<"current" | "history">("current");
  const [partition, setPartition] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const historyRequestRef = useRef(0);
  const currentRequestRef = useRef(0);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const changeColumnWidths = (widths: number[] | null) => {
    setColumnWidths(widths);
    try {
      if (widths) localStorage.setItem(JOB_COLUMN_WIDTHS_KEY, JSON.stringify(widths));
      else localStorage.removeItem(JOB_COLUMN_WIDTHS_KEY);
    } catch { /* Resizing remains available when browser storage is disabled. */ }
  };

  const remember = useCallback((patch: Partial<SchedulerDashboard>) => {
    const current = schedulerDashboardCache.get(serverId);
    schedulerDashboardCache.set(serverId, { scheduler: "slurm", summary: null, partitions: [], jobs: [], history: [], sampledAt: "", ...current, ...patch });
  }, [serverId]);

  const applyPartitions = useCallback((next: SchedulerPartition[]) => {
    setPartitions(next);
    if (next.length) setPartition((current) => current || next.find((item) => item.isDefault)?.id || next[0].id);
  }, []);

  const loadResources = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await runtime.api.get<SchedulerResourceSnapshot>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/resource-dashboard?refresh=1`, signal);
      setSummary(result.data.summary || null);
      applyPartitions(result.data.partitions || []);
      remember({ summary: result.data.summary || null, partitions: result.data.partitions || [], sampledAt: result.data.sampledAt });
      setError(null);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "资源更新失败");
    }
  }, [applyPartitions, remember, runtime.api, serverId]);

  const loadHistory = useCallback(async (range: HistoryRange, signal?: AbortSignal, quiet = false) => {
    if (!capability.jobHistory) {
      setHistoryLoading(false);
      return;
    }
    const requestId = ++historyRequestRef.current;
    if (!quiet) { setHistoryPage(1); setHistoryLoading(true); }
    try {
      const query = new URLSearchParams({ startDate: range.startDate, endDate: range.endDate, utcOffsetMinutes: String(-new Date().getTimezoneOffset()) });
      const result = await runtime.api.get<SchedulerJob[]>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs/history?${query}`, signal);
      if (requestId !== historyRequestRef.current || signal?.aborted) return;
      schedulerHistoryCache.set(historyCacheKey(serverId, range), result.data || []);
      setHistory(result.data || []);
      setHistoryRange(range);
      remember({ history: result.data || [] });
      setHistoryError(null);
    } catch (reason) {
      if (requestId === historyRequestRef.current && !signal?.aborted) setHistoryError(reason instanceof Error ? reason.message : "历史作业更新失败");
    } finally {
      if (requestId === historyRequestRef.current && !signal?.aborted) setHistoryLoading(false);
    }
  }, [capability.jobHistory, remember, runtime.api, serverId]);

  const loadCurrentJobs = useCallback(async (signal?: AbortSignal) => {
    const requestId = ++currentRequestRef.current;
    try {
      const result = await runtime.api.get<SchedulerJob[]>(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs`, signal);
      if (signal?.aborted || requestId !== currentRequestRef.current) return;
      const nextJobs = result.data || [];
      setJobs(nextJobs);
      remember({ jobs: nextJobs });
      setJobsError(null);
    } catch (reason) {
      if (!signal?.aborted && requestId === currentRequestRef.current) setJobsError(reason instanceof Error ? reason.message : "当前作业更新失败");
    }
  }, [remember, runtime.api, serverId]);

  const loadDashboard = useCallback(async (signal?: AbortSignal) => {
    if (!schedulerDashboardCache.has(serverId)) setLoading(true);
    // A failed resource probe must not discard a successful job query.
    await Promise.allSettled([loadResources(signal), loadCurrentJobs(signal)]);
    if (!signal?.aborted) setLoading(false);
  }, [loadResources, loadCurrentJobs, serverId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = false, dirty = false;
    const refreshJobs = async () => {
      if (active) { dirty = true; return; }
      active = true;
      do {
        dirty = false;
        await Promise.allSettled([loadCurrentJobs(controller.signal), loadHistory(historyRange, controller.signal, true)]);
      } while (dirty && !controller.signal.aborted);
      active = false;
    };
    const unsubscribe = runtime.realtime?.subscribe(`scheduler:${serverId}`, (event) => {
      if (event.kind === "jobs.changed") void refreshJobs();
    });
    const unsubscribeState = runtime.realtime?.onState((state) => { if (state === "open") void refreshJobs(); });
    // Reconnect/focus and polling repair missed notifications and changes made
    // outside EasyWork; native submissions trigger the same refresh immediately.
    const onFocus = () => { void refreshJobs(); };
    window.addEventListener("focus", onFocus);
    const interval = window.setInterval(onFocus, RESOURCE_REFRESH_MS);
    return () => { controller.abort(); unsubscribe?.(); unsubscribeState?.(); window.clearInterval(interval); window.removeEventListener("focus", onFocus); };
  }, [historyRange, loadCurrentJobs, loadHistory, runtime.realtime, serverId]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => {
      void loadDashboard(controller.signal, true);
      void loadHistory(initialHistoryRange, controller.signal);
    }, 0);
    const resourceInterval = window.setInterval(() => void loadResources(controller.signal), RESOURCE_REFRESH_MS);
    return () => { controller.abort(); window.clearTimeout(initial); window.clearInterval(resourceInterval); };
  }, [initialHistoryRange, loadDashboard, loadHistory, loadResources]);

  const cancel = async (jobId: string) => {
    if (!window.confirm(`确定取消作业 ${jobId} 吗？`)) return;
    setBusy(`cancel:${jobId}`);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/scheduler/jobs/${encodeURIComponent(jobId)}/cancel`, {}, { idempotencyKey: commandId("scheduler-cancel") });
      await Promise.all([loadCurrentJobs(), loadHistory(historyRange)]);
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
        workspaceId,
        conversationId,
        branchId,
        partition,
        scriptPath,
        args: [],
      }, { idempotencyKey: commandId("scheduler-submit") });
      runtime.notify(`作业 ${result.data.jobId} 已提交`, "success");
      setScriptPath("");
      setShowSubmit(false);
      await Promise.all([loadCurrentJobs(), loadHistory(historyRange)]);
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "提交作业失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    setBusy("refresh");
    try {
      await Promise.all([loadDashboard(undefined, true), loadHistory(historyRange)]);
    } finally {
      setBusy(null);
    }
  };

  const chooseJobTab = (tab: "current" | "history") => {
    setJobTab(tab);
    if (tab === "current") void loadCurrentJobs();
    else void loadHistory(historyRange, undefined, true);
  };

  const chooseHistoryPreset = (value: HistoryPreset) => {
    setHistoryPreset(value);
    if (value === "custom") return;
    const range = recentHistoryRange(Number(value));
    setHistoryDraft(range);
    void loadHistory(range);
  };

  const applyCustomHistoryRange = () => {
    if (!historyDraft.startDate || !historyDraft.endDate || historyDraft.startDate > historyDraft.endDate) {
      runtime.notify("请选择有效的历史作业时间范围", "error");
      return;
    }
    void loadHistory(historyDraft);
  };

  const currentJobs = useMemo(() => [...jobs].sort((left, right) => {
    const order: Record<SchedulerJob["state"], number> = { running: 0, pending: 1, failed: 2, timeout: 3, cancelled: 4, completed: 5, unknown: 6 };
    return order[left.state] - order[right.state] || left.id.localeCompare(right.id);
  }), [jobs]);
  const historicalJobs = useMemo(() => [...history].sort((left, right) => {
    const leftTime = Date.parse(left.endedAt || left.startedAt || left.submittedAt || "") || 0;
    const rightTime = Date.parse(right.endedAt || right.startedAt || right.submittedAt || "") || 0;
    return rightTime - leftTime || right.id.localeCompare(left.id);
  }), [history]);
  const historyPageCount = Math.max(1, Math.ceil(historicalJobs.length / HISTORY_PAGE_SIZE));
  const visibleHistoricalJobs = useMemo(() => {
    const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
    return historicalJobs.slice(start, start + HISTORY_PAGE_SIZE);
  }, [historicalJobs, historyPage]);
  const firstVisibleHistoryJob = historicalJobs.length ? (historyPage - 1) * HISTORY_PAGE_SIZE + 1 : 0;
  const lastVisibleHistoryJob = Math.min(historyPage * HISTORY_PAGE_SIZE, historicalJobs.length);

  const historyRangeLabel = `${historyRange.startDate.replaceAll("-", "/")} 至 ${historyRange.endDate.replaceAll("-", "/")}`;

  const hasCachedData = Boolean(cached || summary || partitions.length || jobs.length);
  if (loading && !hasCachedData) return <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在读取调度器</span></div>;
  if (error && !hasCachedData) return <div className={styles.state}><ServerCog size={22} /><strong>调度器暂时不可用</strong><span>{error}</span><Button compact onClick={() => void loadDashboard()}>重试</Button></div>;

  return <div className={styles.schedulerPane}>
    {jobsError ? <p role="alert">{jobsError}</p> : null}
    <header className={styles.sectionToolbar}>
      <div className={styles.sectionIdentity}><ServerCog size={18} /><span><strong>{capability.type === "slurm" ? "Slurm" : "远端作业"}</strong><small>{summary?.scope.label || `${partitions.length} 个可用队列`}</small></span></div>
      <span className={styles.spacer} />
      {error ? <small className={styles.staleHint}>更新失败，显示上次结果</small> : null}
      <Button compact iconOnly variant="ghost" aria-label="刷新算力信息" icon={busy === "refresh" ? <LoaderCircle className={styles.spin} size={15} /> : <RefreshCw size={15} />} disabled={Boolean(busy)} onClick={() => void refreshAll()} />
      {capability.submitJob ? <Button compact variant="secondary" icon={<Play size={15} />} onClick={() => setShowSubmit((value) => !value)}>提交作业</Button> : null}
    </header>
    {showSubmit ? <div className={styles.submitBar}>
      <select aria-label="分区" value={partition} onChange={(event) => setPartition(event.target.value)}>{partitions.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? "（默认）" : ""}</option>)}</select>
      <input aria-label="脚本路径" value={scriptPath} placeholder="远端脚本路径（相对路径以当前工作区为准）" onChange={(event) => setScriptPath(event.target.value)} />
      <Button compact variant="primary" disabled={!partition || !scriptPath.trim() || Boolean(busy)} icon={busy === "submit" ? <LoaderCircle className={styles.spin} size={14} /> : <Play size={14} />} onClick={() => void submit()}>提交</Button>
    </div> : null}
    <div className={styles.schedulerScroll}>
      {summary ? <section className={styles.metricGrid}>
        <BreakdownChart label="节点" value={summary.nodes} icon={<ServerCog size={16} />} />
        <BreakdownChart label="CPU 核心" value={summary.cpuCores} icon={<Cpu size={16} />} />
        <BreakdownChart label="加速卡" value={summary.accelerators} icon={<Gauge size={16} />} />
      </section> : null}
      <section className={styles.schedulerSection}>
        <div className={styles.jobTabs} role="tablist" aria-label="作业列表">
          <button type="button" role="tab" aria-selected={jobTab === "current"} onClick={() => chooseJobTab("current")}><span>当前作业</span><small>{currentJobs.length}</small></button>
          <button type="button" role="tab" aria-selected={jobTab === "history"} onClick={() => chooseJobTab("history")}><span>历史作业</span><small>{historyLoading ? <LoaderCircle className={styles.spin} size={12} aria-label="正在读取历史作业" /> : historicalJobs.length}</small></button>
        </div>
        {jobTab === "history" && capability.jobHistory ? <div className={styles.historyFilter}>
          <label className={styles.historyPreset}><CalendarDays size={15} /><span>时间范围</span><select aria-label="历史作业时间范围" value={historyPreset} onChange={(event) => chooseHistoryPreset(event.target.value as HistoryPreset)}>
            <option value="7">近 7 天</option>
            <option value="30">近 1 个月</option>
            <option value="90">近 3 个月</option>
            <option value="180">近 6 个月</option>
            <option value="365">近 1 年</option>
            <option value="custom">自定义</option>
          </select></label>
          {historyPreset === "custom" ? <div className={styles.historyCustomRange}>
            <label><span>开始</span><input type="date" aria-label="历史作业开始日期" value={historyDraft.startDate} max={historyDraft.endDate} onChange={(event) => setHistoryDraft((current) => ({ ...current, startDate: event.target.value }))} /></label>
            <i>至</i>
            <label><span>结束</span><input type="date" aria-label="历史作业结束日期" value={historyDraft.endDate} min={historyDraft.startDate} onChange={(event) => setHistoryDraft((current) => ({ ...current, endDate: event.target.value }))} /></label>
            <Button compact variant="secondary" disabled={historyLoading} icon={historyLoading ? <LoaderCircle className={styles.spin} size={14} /> : <RefreshCw size={14} />} onClick={applyCustomHistoryRange}>查询</Button>
          </div> : <span className={styles.historyRangeText}>{historyRangeLabel}</span>}
          {historyError ? <small className={styles.historyError}>{historyError}</small> : null}
        </div> : null}
        {jobTab === "current"
          ? currentJobs.length
            ? <JobList jobs={currentJobs} capability={capability} columnWidths={columnWidths} onColumnWidthsChange={changeColumnWidths} busy={busy} onCancel={(jobId) => void cancel(jobId)} />
            : <div className={styles.inlineEmpty}>当前没有作业</div>
          : historyLoading && !historicalJobs.length
            ? <div className={styles.inlineEmpty}><LoaderCircle className={styles.spin} size={16} />正在读取历史作业</div>
            : historyError && !historicalJobs.length
              ? <div className={styles.inlineEmpty}>历史作业暂时无法读取</div>
            : historicalJobs.length
            ? <>
              <JobList jobs={visibleHistoricalJobs} capability={capability} history columnWidths={columnWidths} onColumnWidthsChange={changeColumnWidths} busy={busy} />
              {historyPageCount > 1 ? <nav className={styles.historyPagination} aria-label="历史作业分页">
                <span><strong>{firstVisibleHistoryJob}–{lastVisibleHistoryJob}</strong> / {historicalJobs.length}</span>
                <div>
                  <button type="button" aria-label="上一页历史作业" disabled={historyPage <= 1} onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}><ChevronLeft size={15} />上一页</button>
                  <small>第 {historyPage} / {historyPageCount} 页</small>
                  <button type="button" aria-label="下一页历史作业" disabled={historyPage >= historyPageCount} onClick={() => setHistoryPage((page) => Math.min(historyPageCount, page + 1))}>下一页<ChevronRight size={15} /></button>
                </div>
              </nav> : null}
            </>
            : <div className={styles.inlineEmpty}>{capability.jobHistory ? `${historyRangeLabel} 暂无历史作业` : "当前调度器未提供历史作业查询"}</div>}
      </section>
    </div>
  </div>;
}

export default function SchedulerPane(props: SchedulerPaneProps) {
  return props.capability.type === "none" ? <SystemMonitorPane serverId={props.serverId} /> : <ClusterSchedulerPane {...props} />;
}
