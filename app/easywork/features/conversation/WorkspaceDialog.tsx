"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Home, LoaderCircle, Search, Sparkles, X } from "lucide-react";
import type { WorkspaceSummary } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Modal } from "../../ui/Modal";
import styles from "./WorkspaceDialog.module.css";

type DirectorySnapshot = { home: string; path: string; parent: string | null; directories: Array<{ name: string; path: string }> };
export const VIRTUAL_WORKSPACE_SELECTION = "__virtual__";
export const PENDING_USER_WORKSPACE_SELECTION = "pending-user-workspace";

export function WorkspaceDialog({
  serverId,
  serverName,
  conversationId,
  branchId,
  options,
  current,
  allowVirtual,
  busy,
  onClose,
  onSelect,
}: {
  serverId: string;
  serverName: string;
  conversationId?: string;
  branchId?: string;
  options: WorkspaceSummary[];
  current: string | null;
  allowVirtual: boolean;
  busy?: boolean;
  onClose: () => void;
  onSelect: (workspaceId: string, workspace?: WorkspaceSummary, workspacePath?: string) => Promise<void>;
}) {
  const runtime = useAppRuntime();
  const initialKind = current === VIRTUAL_WORKSPACE_SELECTION || options.find((item) => item.id === current)?.kind === "virtual" ? "virtual" : "user";
  const [kind, setKind] = useState<"virtual" | "user">(initialKind);
  const [snapshot, setSnapshot] = useState<DirectorySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const load = useCallback(async (path?: string | null) => {
    setLoading(true);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const result = await runtime.api.get<DirectorySnapshot>(`/api/servers/${encodeURIComponent(serverId)}/directories${query}`);
      setSnapshot(result.data);
      setFilter("");
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "目录读取失败", "error"); }
    finally { setLoading(false); }
  }, [runtime, serverId]);

  useEffect(() => {
    if (kind !== "user" || snapshot) return;
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [kind, load, snapshot]);

  const directories = useMemo(() => {
    const term = filter.trim().toLocaleLowerCase();
    return term ? snapshot?.directories.filter((entry) => entry.name.toLocaleLowerCase().includes(term)) ?? [] : snapshot?.directories ?? [];
  }, [filter, snapshot]);

  const selectVirtual = async () => {
    if (selecting || busy) return;
    setSelecting(true);
    try {
      if (!conversationId) await onSelect(VIRTUAL_WORKSPACE_SELECTION);
      else {
        const existing = options.find((item) => item.id === current && item.kind === "virtual");
        if (existing) await onSelect(existing.id, existing);
        else {
          const result = await runtime.api.post<{ workspace: WorkspaceSummary }>(`/api/servers/${encodeURIComponent(serverId)}/workspaces/virtual`, {
            conversationId,
            branchId: branchId || "main",
            expectedRevision: 0,
          }, { expectedRevision: 0, idempotencyKey: commandId("workspace-virtual") });
          await onSelect(result.data.workspace.id, result.data.workspace);
        }
      }
      onClose();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "虚拟工作区选择失败", "error"); }
    finally { setSelecting(false); }
  };

  const selectUser = async () => {
    if (!snapshot || selecting || busy) return;
    setSelecting(true);
    try {
      const existing = options.find((item) => item.kind === "user" && item.canonicalPath === snapshot.path);
      if (existing) await onSelect(existing.id, existing);
      else if (!conversationId) {
        await onSelect(PENDING_USER_WORKSPACE_SELECTION, undefined, snapshot.path);
      } else {
        const result = await runtime.api.post<{ workspace: WorkspaceSummary }>(`/api/servers/${encodeURIComponent(serverId)}/workspaces/user`, {
          conversationId,
          path: snapshot.path,
          expectedRevision: 0,
        }, { expectedRevision: 0, idempotencyKey: commandId("workspace-user") });
        await onSelect(result.data.workspace.id, result.data.workspace);
      }
      onClose();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "工作区登记失败", "error"); }
    finally { setSelecting(false); }
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!snapshot || !name || creatingFolder || /[\\/\0]/.test(name) || name === "." || name === "..") return;
    setCreatingFolder(true);
    try {
      const result = await runtime.api.post<DirectorySnapshot>(`/api/servers/${encodeURIComponent(serverId)}/directories`, { parent: snapshot.path, name }, { idempotencyKey: commandId("workspace-directory-create") });
      setSnapshot(result.data);
      setNewFolderName("");
      setNewFolderOpen(false);
      runtime.notify("文件夹已创建", "success");
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "文件夹创建失败", "error"); }
    finally { setCreatingFolder(false); }
  };

  const headerAction = <label className={styles.kindSelect}><span>工作区类型</span><span className={styles.kindControl}><select aria-label="工作区类型" value={kind} onChange={(event) => setKind(event.target.value as "virtual" | "user")}><option value="virtual" disabled={!allowVirtual}>虚拟工作区</option><option value="user">用户工作区</option></select><ChevronDown size={14} /></span></label>;

  return <><Modal title="选择工作区" size="wide" floating panelClassName={`${styles.panel} ${kind === "virtual" ? styles.virtualPanel : ""}`} bodyClassName={styles.body} headerAction={headerAction} onClose={onClose}>
    {kind === "virtual" ? <div className={styles.virtual}>
      <div className={styles.virtualCard}><span className={styles.sparkle}><Sparkles size={22} /></span><div><small>{serverName}</small><code>{conversationId ? options.find((item) => item.id === current)?.canonicalPath || "将在当前对话下创建隔离目录" : "将在对话首次执行时分配"}</code><p>EasyWork 只记录该对话实际修改的文件，用于分支和回溯；不会扫描目录或影响用户 Git。</p></div></div>
      <footer><button className={styles.primary} disabled={!allowVirtual || busy || selecting} onClick={() => void selectVirtual()}>{selecting ? <LoaderCircle className={styles.spin} size={15} /> : <Check size={15} />}选择当前文件夹</button></footer>
    </div> : <div className={styles.user}>
      <div className={styles.directoryToolbar}>
        <span className={styles.currentPath}><FolderOpen size={17} /><code title={snapshot?.path}>{snapshot?.path || "正在读取…"}</code></span>
        <label><Search size={14} /><input value={filter} placeholder="筛选文件夹" onChange={(event) => setFilter(event.target.value)} /></label>
        <button aria-label="返回主目录" disabled={loading || !snapshot} onClick={() => void load(snapshot?.home)}><Home size={16} /></button>
        <button aria-label="在当前目录新建文件夹" title="新建文件夹" disabled={loading || !snapshot || creatingFolder} onClick={() => { setNewFolderOpen(true); setNewFolderName(""); }}><FolderPlus size={16} /></button>
        <button aria-label="返回上一级" disabled={loading || !snapshot?.parent} onClick={() => void load(snapshot?.parent)}><ArrowLeft size={16} /></button>
      </div>
      <div className={styles.directoryList}>{newFolderOpen ? <form className={styles.newFolderRow} onSubmit={(event) => { event.preventDefault(); void createFolder(); }}><FolderPlus size={16} /><input autoFocus value={newFolderName} placeholder="输入新文件夹名称" disabled={creatingFolder} onChange={(event) => setNewFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setNewFolderOpen(false); }} /><button type="submit" aria-label="创建文件夹" disabled={!newFolderName.trim() || creatingFolder}>{creatingFolder ? <LoaderCircle className={styles.spin} size={14} /> : <Check size={14} />}</button><button type="button" aria-label="取消新建" disabled={creatingFolder} onClick={() => setNewFolderOpen(false)}><X size={14} /></button></form> : null}{loading ? <div className={styles.empty}><LoaderCircle className={styles.spin} size={18} />正在读取文件夹</div> : directories.length ? directories.map((entry) => <button key={entry.path} onDoubleClick={() => void load(entry.path)} onClick={() => void load(entry.path)}><span><Folder size={17} /><strong>{entry.name}</strong></span><ChevronRight size={15} /></button>) : <div className={styles.empty}><Folder size={20} />当前文件夹没有可显示的子文件夹</div>}</div>
      <footer><button className={styles.primary} disabled={!snapshot || loading || busy || selecting} onClick={() => void selectUser()}>{selecting ? <LoaderCircle className={styles.spin} size={15} /> : <Check size={15} />}{selecting ? "正在选择" : "选择当前文件夹"}</button></footer>
    </div>}
  </Modal></>;
}
