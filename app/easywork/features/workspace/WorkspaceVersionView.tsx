"use client";

import { CheckCircle2, FileWarning, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSidebarSession } from "../../runtime/AppRuntime";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkspaceSidebar.module.css";

type GitBranchStatus = {
  name: string | null;
  detached: boolean;
  unborn: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
};

type GitChange = {
  path: string;
  previousPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
};

type GitCommit = {
  id: string;
  shortId: string;
  author: string;
  authoredAt: string;
  decorations: string;
  subject: string;
};

type GitStatus = {
  workspaceId: string;
  available: boolean;
  repository: boolean;
  workspaceAtRepositoryRoot?: boolean;
  branch?: GitBranchStatus;
  clean?: boolean;
  changesTruncated?: boolean;
  counts?: { staged: number; unstaged: number; untracked: number; conflicted: number };
  changes?: GitChange[];
  commits?: GitCommit[];
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : value;
}

function branchLabel(branch?: GitBranchStatus) {
  if (!branch) return "Git";
  if (branch.detached) return branch.oid ? `游离 HEAD · ${branch.oid.slice(0, 8)}` : "游离 HEAD";
  return branch.name || "未命名分支";
}

function changeBadges(change: GitChange) {
  if (change.conflicted) return [{ label: "冲突", className: styles.gitConflict }];
  if (change.untracked) return [{ label: "未跟踪", className: styles.gitUntracked }];
  const badges = [];
  if (change.staged) badges.push({ label: "已暂存", className: styles.gitStaged });
  if (change.unstaged) badges.push({ label: "未暂存", className: styles.gitUnstaged });
  return badges;
}

export function WorkspaceVersionView({ session }: { session: WorkspaceSidebarSession }) {
  const runtime = useAppRuntime();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runtime.api.get<GitStatus>(`/api/servers/${encodeURIComponent(session.serverId)}/workspaces/${encodeURIComponent(session.workspaceId)}/git/status`, signal);
      setStatus(result.data);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取 Git 版本");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runtime.api, session.serverId, session.workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    const handle = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [load]);

  const visibleStatus = status?.workspaceId === session.workspaceId ? status : null;
  const changes = visibleStatus?.changes || [];
  const commits = visibleStatus?.commits || [];
  const counts = visibleStatus?.counts || { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const changeCount = changes.length;

  if (loading && !visibleStatus) return <div className={styles.versionState}><LoaderCircle className={styles.spin} size={20} /><span>正在读取 Git 版本</span></div>;
  if (error && !visibleStatus) return <div className={styles.versionState}><FileWarning size={21} /><strong>无法读取 Git 版本</strong><span>{error}</span><Button compact onClick={() => void load()}>重试</Button></div>;
  if (!visibleStatus?.available) return <div className={styles.versionState}><FileWarning size={22} /><strong>Git 不可用</strong></div>;
  if (!visibleStatus.repository) return <div className={styles.versionState}><GitBranch size={22} /><strong>尚未建立 Git 仓库</strong></div>;

  return <div className={styles.versionExplorer}>
    <header className={styles.versionHeader}>
      <span><GitBranch size={15} /><strong>Git 版本</strong></span>
      <button type="button" aria-label="刷新 Git 版本" disabled={loading} onClick={() => void load()}>{loading ? <LoaderCircle className={styles.spin} size={14} /> : <RefreshCw size={14} />}</button>
    </header>
    <div className={styles.gitSummary}>
      <span className={styles.gitBranchName} title={branchLabel(visibleStatus.branch)}><GitBranch size={13} />{branchLabel(visibleStatus.branch)}</span>
      <span className={visibleStatus.clean ? styles.gitClean : styles.gitDirty}>{visibleStatus.clean ? "干净" : `${changeCount}${visibleStatus.changesTruncated ? "+" : ""} 项变更`}</span>
      {visibleStatus.branch?.upstream ? <small title={visibleStatus.branch.upstream}>{visibleStatus.branch.ahead ? `领先 ${visibleStatus.branch.ahead}` : ""}{visibleStatus.branch.ahead && visibleStatus.branch.behind ? " · " : ""}{visibleStatus.branch.behind ? `落后 ${visibleStatus.branch.behind}` : ""}{!visibleStatus.branch.ahead && !visibleStatus.branch.behind ? visibleStatus.branch.upstream : ""}</small> : null}
    </div>
    <div className={styles.versionScroll}>
      {error ? <div className={styles.gitInlineError}><span>{error}</span><button type="button" disabled={loading} onClick={() => void load()}>重试</button></div> : null}
      <section className={styles.gitSection} aria-labelledby="git-working-tree">
        <header className={styles.gitSectionHeader}><strong id="git-working-tree">工作区变更</strong><span>{visibleStatus.clean ? <><CheckCircle2 size={12} />没有变更</> : null}</span></header>
        {!visibleStatus.clean ? <div className={styles.gitCountRow}>
          {counts.staged ? <span className={styles.gitStaged}>已暂存 {counts.staged}</span> : null}
          {counts.unstaged ? <span className={styles.gitUnstaged}>未暂存 {counts.unstaged}</span> : null}
          {counts.untracked ? <span className={styles.gitUntracked}>未跟踪 {counts.untracked}</span> : null}
          {counts.conflicted ? <span className={styles.gitConflict}>冲突 {counts.conflicted}</span> : null}
        </div> : null}
        {changes.length ? <div className={styles.gitChangeList}>{changes.map((change, index) => <div className={styles.gitChange} key={`${change.path}:${change.previousPath || ""}:${index}`}>
          <div>{changeBadges(change).map((badge) => <span className={badge.className} key={badge.label}>{badge.label}</span>)}</div>
          <strong title={change.path}>{change.path}</strong>
          {change.previousPath ? <small title={change.previousPath}>原：{change.previousPath}</small> : null}
        </div>)}</div> : null}
        {visibleStatus.changesTruncated ? <p className={styles.gitTruncated}>变更较多，仅显示前 {changes.length} 项。</p> : null}
      </section>
      <section className={styles.gitSection} aria-labelledby="git-commit-history">
        <header className={styles.gitSectionHeader}><strong id="git-commit-history">提交历史</strong><span>{commits.length ? `最近 ${commits.length} 条` : ""}</span></header>
        {commits.length ? <div className={styles.gitCommitList}>{commits.map((commit) => <article className={styles.gitCommit} key={commit.id}>
          <GitCommitHorizontal size={14} />
          <div><strong title={commit.subject}>{commit.subject || "无提交说明"}</strong><span><code>{commit.shortId}</code> · {commit.author} · {formatDate(commit.authoredAt)}</span>{commit.decorations ? <small title={commit.decorations}>{commit.decorations}</small> : null}</div>
        </article>)}</div> : <div className={styles.gitEmptyHistory}><GitCommitHorizontal size={17} /><span>尚无提交</span></div>}
      </section>
    </div>
  </div>;
}

export default WorkspaceVersionView;
