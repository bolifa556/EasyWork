"use client";

import {
  ChevronLeft,
  Download,
  Eye,
  File,
  FileWarning,
  Folder,
  FolderPlus,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerCapabilityProfile } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";
import type { OpenPreviewRequest, RemoteEntry } from "./types";

function humanSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(size < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

function joinRelative(parent: string, name: string) {
  return [parent.replace(/^\/+|\/+$/g, ""), name.replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
}

function validEntryName(value: string) {
  const name = value.trim();
  return name && ![".", ".."].includes(name) && !/[\\/\0]/.test(name);
}

type Action =
  | { kind: "mkdir"; value: string }
  | { kind: "rename"; entry: RemoteEntry; value: string }
  | { kind: "delete"; entry: RemoteEntry };

type Transfer = { path: string; label: string; loaded: number; total: number };

type Props = {
  serverId: string;
  workspaceId: string;
  workspacePath: string;
  capability: ServerCapabilityProfile["features"]["remoteFiles"];
  previewAvailable: boolean;
  onPreview: (request: OpenPreviewRequest) => Promise<void>;
};

export default function RemoteFilesPane({ serverId, workspaceId, workspacePath, capability, previewAvailable, onPreview }: Props) {
  const runtime = useAppRuntime();
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [mutating, setMutating] = useState(false);
  const [generation, setGeneration] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const actionInput = useRef<HTMLInputElement>(null);
  const endpoint = `/api/servers/${encodeURIComponent(serverId)}/workspaces/${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await runtime.api.get<{ items: RemoteEntry[] }>(`${endpoint}/files?path=${encodeURIComponent(path)}`, signal);
      setEntries(Array.isArray(result.data.items) ? result.data.items : []);
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "无法读取远端目录");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [endpoint, path, runtime.api]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [generation, load]);

  useEffect(() => {
    if (action && action.kind !== "delete") window.setTimeout(() => actionInput.current?.focus(), 30);
  }, [action]);

  const upload = async (files: FileList | null) => {
    const selected = [...(files ? Array.from(files) : [])];
    if (!selected.length) return;
    const maxBytes = capability.maxUploadBytes ?? Number.MAX_SAFE_INTEGER;
    const tooLarge = selected.find((file) => file.size > maxBytes);
    if (tooLarge) {
      runtime.notify(`${tooLarge.name} 超过 ${humanSize(maxBytes)} 的上传上限`, "error");
      return;
    }
    const total = selected.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    try {
      for (const file of selected) {
        const target = joinRelative(path, file.name);
        setTransfer({ path: target, label: `正在上传 ${file.name}`, loaded: completed, total });
        await runtime.api.uploadWithProgress(`${endpoint}/files/content?path=${encodeURIComponent(target)}&size=${file.size}`, file, (loaded) => {
          setTransfer({ path: target, label: `正在上传 ${file.name}`, loaded: completed + loaded, total });
        }, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          idempotencyKey: commandId("remote-upload"),
        });
        completed += file.size;
      }
      setGeneration((value) => value + 1);
      runtime.notify(selected.length === 1 ? "文件已上传" : `${selected.length} 个文件已上传`, "success");
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "上传失败", "error");
    } finally {
      setTransfer(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const download = async (entry: RemoteEntry) => {
    try {
      setTransfer({ path: entry.path, label: `正在下载 ${entry.name}`, loaded: 0, total: entry.size });
      const response = await runtime.api.raw(`${endpoint}/files/content?path=${encodeURIComponent(entry.path)}`);
      const total = Number(response.headers.get("content-length")) || entry.size;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loaded += value.byteLength;
            setTransfer({ path: entry.path, label: `正在下载 ${entry.name}`, loaded, total });
          }
        }
      } else chunks.push(new Uint8Array(await response.arrayBuffer()));
      const blob = new Blob(chunks);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "下载失败", "error");
    } finally {
      setTransfer(null);
    }
  };

  const applyAction = async () => {
    if (!action) return;
    setMutating(true);
    try {
      if (action.kind === "mkdir") {
        if (!validEntryName(action.value)) throw new Error("请输入有效的文件夹名称");
        await runtime.api.post(`${endpoint}/directories`, { path: joinRelative(path, action.value.trim()) }, { idempotencyKey: commandId("remote-mkdir") });
      } else if (action.kind === "rename") {
        if (!validEntryName(action.value)) throw new Error("请输入有效的新名称");
        await runtime.api.patch(`${endpoint}/entries`, {
          path: action.entry.path,
          destination: joinRelative(path, action.value.trim()),
        }, { idempotencyKey: commandId("remote-rename") });
      } else {
        await runtime.api.delete(`${endpoint}/entries`, {
          body: { path: action.entry.path, recursive: action.entry.kind === "directory", confirmation: action.entry.path },
          idempotencyKey: commandId("remote-delete"),
        });
      }
      setAction(null);
      setGeneration((value) => value + 1);
      runtime.notify(action.kind === "mkdir" ? "文件夹已创建" : action.kind === "rename" ? "名称已更新" : "已删除", "success");
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "文件操作失败", "error");
    } finally {
      setMutating(false);
    }
  };

  const crumbs = useMemo(() => {
    const labels = path.split("/").filter(Boolean);
    return [{ label: workspacePath.split("/").filter(Boolean).at(-1) || workspacePath, path: "" }, ...labels.map((label, index) => ({
      label,
      path: labels.slice(0, index + 1).join("/"),
    }))];
  }, [path, workspacePath]);
  const parentPath = path ? path.split("/").slice(0, -1).join("/") : "";
  const percent = transfer?.total ? Math.min(100, Math.round((transfer.loaded / transfer.total) * 100)) : 0;

  return <div className={styles.pane}>
    <div className={styles.toolbar}>
      <Button compact iconOnly variant="ghost" aria-label="上一级" icon={<ChevronLeft size={17} />} disabled={!path || loading} onClick={() => setPath(parentPath)} />
      <nav className={styles.breadcrumbs} aria-label="当前路径">{crumbs.map((crumb, index) => <button key={crumb.path || "root"} disabled={crumb.path === path} onClick={() => setPath(crumb.path)}>{index ? <span>/</span> : null}{crumb.label}</button>)}</nav>
      <Button compact iconOnly variant="ghost" aria-label="刷新目录" icon={<RefreshCw size={16} />} disabled={loading || Boolean(transfer)} onClick={() => setGeneration((value) => value + 1)} />
      {capability.mkdir ? <Button compact variant="ghost" icon={<FolderPlus size={16} />} disabled={Boolean(transfer)} onClick={() => setAction({ kind: "mkdir", value: "" })}>新建文件夹</Button> : null}
      {capability.upload ? <><input ref={fileInput} className={styles.visuallyHidden} type="file" multiple onChange={(event) => void upload(event.target.files)} /><Button compact variant="secondary" icon={transfer?.label.startsWith("正在上传") ? <LoaderCircle className={styles.spin} size={15} /> : <Upload size={15} />} disabled={Boolean(transfer)} onClick={() => fileInput.current?.click()}>上传</Button></> : null}
    </div>
    {transfer ? <div className={styles.transferBar} role="status"><span>{transfer.label}</span><div><i style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div> : null}
    <div className={styles.paneContent}>
      {loading ? <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><span>正在读取目录</span></div> : error ? <div className={styles.state}><FileWarning size={22} /><strong>无法读取目录</strong><span>{error}</span><Button compact onClick={() => setGeneration((value) => value + 1)}>重试</Button></div> : entries.length ? <div className={styles.fileList} role="tree" aria-label="远端文件">
        {entries.map((entry) => <div className={styles.fileRow} key={entry.path} role="treeitem" aria-selected={false} aria-expanded={entry.kind === "directory" ? false : undefined}>
          <button className={styles.fileMain} onClick={() => entry.kind === "directory" ? setPath(entry.path) : entry.kind === "file" && previewAvailable ? void onPreview({ source: { kind: "remote", serverId, workspaceId, relativePath: entry.path }, fallbackName: entry.name, fallbackSize: entry.size }) : undefined}>
            <span className={`${styles.fileIcon} ${entry.kind === "directory" ? styles.directoryIcon : ""}`}>{entry.kind === "directory" ? <Folder size={18} /> : <File size={18} />}</span>
            <span className={styles.fileIdentity}><strong>{entry.name}</strong><small>{entry.kind === "directory" ? "文件夹" : entry.kind === "symlink" ? "符号链接（只读）" : humanSize(entry.size)}{entry.modifiedAt ? ` · ${new Date(entry.modifiedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}</small></span>
          </button>
          {entry.kind !== "symlink" ? <div className={styles.rowActions}>
            {entry.kind === "file" && previewAvailable ? <Button compact iconOnly variant="ghost" aria-label={`预览 ${entry.name}`} icon={<Eye size={16} />} onClick={() => void onPreview({ source: { kind: "remote", serverId, workspaceId, relativePath: entry.path }, fallbackName: entry.name, fallbackSize: entry.size })} /> : null}
            {entry.kind === "file" && capability.download ? <Button compact iconOnly variant="ghost" aria-label={`下载 ${entry.name}`} icon={transfer?.path === entry.path ? <LoaderCircle className={styles.spin} size={16} /> : <Download size={16} />} disabled={Boolean(transfer)} onClick={() => void download(entry)} /> : null}
            {capability.rename ? <Button compact iconOnly variant="ghost" aria-label={`重命名 ${entry.name}`} icon={<Pencil size={15} />} disabled={Boolean(transfer)} onClick={() => setAction({ kind: "rename", entry, value: entry.name })} /> : null}
            {capability.delete ? <Button compact iconOnly variant="ghost" aria-label={`删除 ${entry.name}`} icon={<Trash2 size={15} />} disabled={Boolean(transfer)} onClick={() => setAction({ kind: "delete", entry })} /> : null}
          </div> : null}
        </div>)}
      </div> : <div className={styles.state}><Folder size={23} /><strong>这个文件夹是空的</strong>{capability.upload ? <Button compact variant="secondary" icon={<Upload size={15} />} onClick={() => fileInput.current?.click()}>上传文件</Button> : null}</div>}
      {action ? <div className={styles.fileActionBackdrop} onMouseDown={(event) => { if (event.currentTarget === event.target && !mutating) setAction(null); }}>
        <section className={styles.fileActionDialog} role="dialog" aria-modal="true" aria-label={action.kind === "mkdir" ? "新建文件夹" : action.kind === "rename" ? "重命名" : "确认删除"}>
          <header><strong>{action.kind === "mkdir" ? "新建文件夹" : action.kind === "rename" ? "重命名" : "删除文件"}</strong><button aria-label="关闭" disabled={mutating} onClick={() => setAction(null)}><X size={17} /></button></header>
          {action.kind === "delete" ? <p>确定删除 <b>{action.entry.name}</b>{action.entry.kind === "directory" ? " 及其中的全部内容" : ""}？此操作不能撤销。</p> : <input ref={actionInput} value={action.value} maxLength={255} onChange={(event) => setAction({ ...action, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void applyAction(); }} />}
          <footer><Button compact variant="ghost" disabled={mutating} onClick={() => setAction(null)}>取消</Button><Button compact variant={action.kind === "delete" ? "danger" : "primary"} disabled={mutating || (action.kind !== "delete" && !validEntryName(action.value))} icon={mutating ? <LoaderCircle className={styles.spin} size={14} /> : undefined} onClick={() => void applyAction()}>{mutating ? "处理中" : action.kind === "delete" ? "删除" : "确定"}</Button></footer>
        </section>
      </div> : null}
    </div>
  </div>;
}
