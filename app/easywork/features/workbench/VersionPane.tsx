"use client";

import { Check, ChevronDown, ChevronRight, Clock3, FileDiff, GitCommitHorizontal, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";
import type { VersionChange, VersionStatus } from "./types";

function changeKind(change: VersionChange) {
  if (!change.before.exists) return { label: "新增", className: styles.changeAdded };
  if (!change.after.exists) return { label: "删除", className: styles.changeDeleted };
  return { label: "修改", className: styles.changeModified };
}

function shortHash(value: string | null) {
  return value ? value.slice(0, 10) : "—";
}

type Props = { serverId: string; workspaceId: string; conversationId?: string; branchId?: string };

export default function VersionPane({ serverId, workspaceId, conversationId, branchId }: Props) {
  const runtime = useAppRuntime();
  const [status, setStatus] = useState<VersionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runtime.api.get<VersionStatus>(`/api/servers/${encodeURIComponent(serverId)}/versioning/status?workspaceId=${encodeURIComponent(workspaceId)}`, signal);
      setStatus(result.data);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取版本状态");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtime.api, serverId, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  const activeCheckpoints = useMemo(() => (status?.checkpoints || [])
    .filter((checkpoint) => checkpoint.status === "retained" && (!branchId || checkpoint.logicalBranchId === branchId))
    .sort((left, right) => right.sequence - left.sequence), [branchId, status?.checkpoints]);

  const checkpoint = async () => {
    if (!conversationId || !branchId) return;
    setBusy("checkpoint");
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/versioning/commit`, {
        workspaceId,
        checkpointId: commandId("checkpoint"),
        branchId,
        conversationId,
        message: "用户创建的 EasyWork checkpoint",
      }, { idempotencyKey: commandId("version-checkpoint") });
      await load();
      runtime.notify("Checkpoint 已创建", "success");
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "Checkpoint 创建失败", "error");
    } finally {
      setBusy(null);
    }
  };

  const rewind = async (checkpointId: string) => {
    if (!branchId || !window.confirm("回退会撤销此分支在该 Checkpoint 之后的文件修改；其他分支的有效修改会保留。确定继续吗？")) return;
    setBusy(checkpointId);
    try {
      const result = await runtime.api.post<{ applied: boolean; conflict?: { message?: string } | null }>(`/api/servers/${encodeURIComponent(serverId)}/versioning/rewind`, {
        workspaceId,
        branchId,
        targetCheckpointId: checkpointId,
        rewindId: commandId("version-rewind-request"),
      }, { idempotencyKey: commandId("version-rewind") });
      if (!result.data.applied) throw new Error(result.data.conflict?.message || "工作区存在冲突，未执行回退");
      await load();
      runtime.notify("工作区已回退", "success");
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "回退失败", "error");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在检查工作区版本</span></div>;
  if (error) return <div className={styles.state}><FileDiff size={22} /><strong>无法读取版本状态</strong><span>{error}</span><Button compact onClick={() => void load()}>重试</Button></div>;
  if (!status?.versioned) return <div className={styles.state}><ShieldCheck size={24} /><strong>这个工作区尚未启用版本快照</strong></div>;

  return <div className={styles.versionPane}>
    <header className={styles.sectionToolbar}>
      <div className={styles.sectionIdentity}><ShieldCheck size={18} /><span><strong>EasyWork 版本</strong><small>隔离快照，不操作用户 Git</small></span></div>
      <span className={styles.spacer} />
      <Button compact iconOnly variant="ghost" aria-label="刷新版本状态" icon={<RefreshCw size={15} />} disabled={Boolean(busy)} onClick={() => void load()} />
      {conversationId && branchId ? <Button compact variant="secondary" icon={busy === "checkpoint" ? <LoaderCircle className={styles.spin} size={15} /> : <GitCommitHorizontal size={15} />} disabled={Boolean(busy)} onClick={() => void checkpoint()}>创建 Checkpoint</Button> : null}
    </header>
    <div className={styles.versionColumns}>
      <section className={styles.versionSection}>
        <div className={styles.sectionHeading}><span>工作区变化</span><small>{status.changes.length}</small></div>
        <div className={styles.changeSummary}><span className={styles.changeAdded}>+{status.counts.added}</span><span className={styles.changeModified}>~{status.counts.modified}</span><span className={styles.changeDeleted}>−{status.counts.deleted}</span></div>
        {status.changes.length ? <div className={styles.changeList}>{status.changes.map((change) => {
          const kind = changeKind(change);
          const isOpen = expanded === change.path;
          return <div className={styles.changeItem} key={change.path}>
            <button className={styles.changeButton} onClick={() => setExpanded(isOpen ? null : change.path)}>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span className={kind.className}>{kind.label}</span><strong>{change.path}</strong></button>
            {isOpen ? <div className={styles.snapshotGrid}><span>之前</span><code>{shortHash(change.before.sha256)}</code><small>{change.before.exists ? `${change.before.size} B` : "不存在"}</small><span>现在</span><code>{shortHash(change.after.sha256)}</code><small>{change.after.exists ? `${change.after.size} B` : "不存在"}</small></div> : null}
          </div>;
        })}</div> : <div className={styles.inlineEmpty}><Check size={17} />工作区与最近快照一致</div>}
      </section>
      <section className={styles.versionSection}>
        <div className={styles.sectionHeading}><span>Checkpoint</span><small>{activeCheckpoints.length}</small></div>
        {activeCheckpoints.length ? <div className={styles.checkpointList}>{activeCheckpoints.map((checkpoint, index) => <article className={styles.checkpoint} key={checkpoint.id}>
          <span className={styles.checkpointMark}><Clock3 size={14} /></span>
          <span className={styles.checkpointText}><strong>{checkpoint.message || `Checkpoint ${checkpoint.sequence}`}</strong><small>{new Date(checkpoint.createdAt).toLocaleString("zh-CN")} · {checkpoint.id}</small></span>
          {index > 0 ? <Button compact variant="ghost" icon={busy === checkpoint.id ? <LoaderCircle className={styles.spin} size={14} /> : <RotateCcw size={14} />} disabled={Boolean(busy)} onClick={() => void rewind(checkpoint.id)}>回退到这里</Button> : <span className={styles.currentBadge}>当前</span>}
        </article>)}</div> : <div className={styles.inlineEmpty}>还没有 Checkpoint</div>}
      </section>
    </div>
  </div>;
}
