"use client";

import { canPreviewFile } from "@/shared/file-preview.mjs";

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  File,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListTree,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import type { WorkspaceSidebarSession } from "../../runtime/AppRuntime";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { useMobileMenuAnchor } from "../../ui/useMobileMenuAnchor";
import type { RemoteEntry } from "../workbench/types";
import styles from "./WorkspaceSidebar.module.css";
import { WORKSPACE_FILES_CHANGED_EVENT, workspaceFilesRevision, type WorkspaceFilesChangedDetail } from "./workspaceFileEvents";

const WorkspaceVersionView = lazy(() => import("./WorkspaceVersionView"));

type DirectorySnapshot = { path: string; items: RemoteEntry[] };
type ClipboardEntry = { mode: "cut" | "copy"; entry: RemoteEntry };
type ContextTarget = { entry: RemoteEntry | null; left: number; top: number; anchor: HTMLElement | null };
type InlineAction = {
  kind: "create-file" | "create-directory" | "rename";
  entry: RemoteEntry | null;
  parentPath: string;
  value: string;
};
type ExplorerCache = {
  directories: Record<string, RemoteEntry[]>;
  expanded: string[];
};
type UploadStatus = {
  phase: "uploading" | "done" | "error";
  directory: string;
  fileName: string;
  fileIndex: number;
  fileCount: number;
  percent: number;
  detail: string;
};
type UploadConflict = {
  directory: string;
  files: File[];
  conflicts: string[];
};

const explorerCaches = new Map<string, ExplorerCache>();


function joinRelative(parent: string, name: string) {
  return [parent.replace(/\/$/, ""), name.replace(/^\//, "")].filter(Boolean).join("/");
}

function parentPath(value: string) {
  const index = value.lastIndexOf("/");
  return index < 0 ? "" : value.slice(0, index);
}

function baseName(value: string) {
  return value.split("/").filter(Boolean).at(-1) || value || "工作目录";
}

function directoryPathChain(value: string) {
  const segments = value.split("/").filter(Boolean);
  return ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function absolutePath(root: string, relative: string) {
  return relative ? `${root.replace(/\/$/, "")}/${relative}` : root;
}

function canPreview(entry: RemoteEntry) {
  if (entry.kind !== "file" && entry.kind !== "symlink") return false;
  return canPreviewFile(entry);
}

function EntryIcon({ entry, open = false }: { entry: RemoteEntry; open?: boolean }) {
  if (entry.kind === "directory") return open ? <FolderOpen size={15} /> : <Folder size={15} />;
  const extension = entry.name.split(".").at(-1)?.toLocaleLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) return <FileImage size={15} />;
  if (extension === "json") return <Braces size={15} />;
  if (["md", "markdown", "txt", "log", "pdf", "csv", "tsv"].includes(extension)) return <FileText size={15} />;
  if (["py", "js", "ts", "tsx", "jsx", "css", "html", "sh", "ps1", "r", "cpp", "c", "h", "java", "rs", "go", "sql"].includes(extension)) return <FileCode2 size={15} />;
  return <File size={15} />;
}

function WorkspaceExplorer({ session, filesRevision }: { session: WorkspaceSidebarSession; filesRevision: number }) {
  const runtime = useAppRuntime();
  const endpoint = `/api/servers/${encodeURIComponent(session.serverId)}/workspaces/${encodeURIComponent(session.workspaceId)}`;
  const remoteFiles = session.capabilities.features.remoteFiles;
  const uploadAvailable = remoteFiles.available && remoteFiles.upload;
  const cacheKey = `${session.serverId}:${session.workspaceId}:${filesRevision}`;
  const initialCache = explorerCaches.get(cacheKey);
  const [directories, setDirectories] = useState<Record<string, RemoteEntry[]>>(() => initialCache?.directories || {});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(initialCache?.expanded || [""]));
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set(initialCache ? [] : [""]));
  const [context, setContext] = useState<ContextTarget | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  useMobileMenuAnchor(context?.anchor, contextRef);
  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
  const [action, setAction] = useState<InlineAction | null>(null);
  const [savingAction, setSavingAction] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RemoteEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus | null>(null);
  const [uploadConflict, setUploadConflict] = useState<UploadConflict | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadDestinationRef = useRef("");
  const uploadFinishTimer = useRef<number | null>(null);
  const uploadingRef = useRef(false);

  const load = useCallback(async (directory: string, signal?: AbortSignal) => {
    setLoadingPaths((current) => new Set(current).add(directory));
    try {
      const result = await runtime.api.get<DirectorySnapshot>(`${endpoint}/files?path=${encodeURIComponent(directory)}`, signal);
      setDirectories((current) => ({ ...current, [directory]: result.data.items }));
    } catch (reason) {
      if (!signal?.aborted) runtime.notify(reason instanceof Error ? reason.message : "无法读取工作目录", "error");
    } finally {
      if (!signal?.aborted) setLoadingPaths((current) => { const next = new Set(current); next.delete(directory); return next; });
    }
  }, [endpoint, runtime]);

  useEffect(() => {
    if (explorerCaches.has(cacheKey)) return undefined;
    const controller = new AbortController();
    const handle = window.setTimeout(() => void load("", controller.signal), 0);
    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [cacheKey, load]);

  useEffect(() => {
    if (!Object.prototype.hasOwnProperty.call(directories, "")) return;
    explorerCaches.set(cacheKey, { directories, expanded: [...expanded] });
  }, [cacheKey, directories, expanded]);

  useEffect(() => {
    if (!action) return undefined;
    const handle = window.requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    return () => window.cancelAnimationFrame(handle);
  }, [action]);

  useEffect(() => {
    if (!context) return undefined;
    const close = () => setContext(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", close);
    };
  }, [context]);

  useEffect(() => () => {
    if (uploadFinishTimer.current !== null) window.clearTimeout(uploadFinishTimer.current);
  }, []);

  const reloadTree = useCallback(async (revealDirectory = "") => {
    const revealPaths = directoryPathChain(revealDirectory);
    explorerCaches.delete(cacheKey);
    setDirectories({});
    setExpanded(new Set(revealPaths));
    await Promise.all(revealPaths.map((path) => load(path)));
  }, [cacheKey, load]);

  const settleUploadStatus = useCallback((next: UploadStatus) => {
    setUploadStatus(next);
    uploadingRef.current = false;
    if (uploadFinishTimer.current !== null) window.clearTimeout(uploadFinishTimer.current);
    uploadFinishTimer.current = window.setTimeout(() => {
      setUploadStatus(null);
      uploadFinishTimer.current = null;
    }, 1800);
  }, []);

  const uploadFiles = useCallback(async (files: File[], directory: string) => {
    if (!files.length || uploadingRef.current) return;
    uploadingRef.current = true;
    if (uploadFinishTimer.current !== null) {
      window.clearTimeout(uploadFinishTimer.current);
      uploadFinishTimer.current = null;
    }
    const totalWeight = files.reduce((sum, file) => sum + Math.max(file.size, 1), 0);
    let completedWeight = 0;
    let completedBytes = 0;
    let uploaded = 0;
    const failures: string[] = [];
    const destinationLabel = directory ? baseName(directory) : "工作目录根目录";
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const path = joinRelative(directory, file.name);
      const updateProgress = (loaded: number) => {
        const currentWeight = file.size ? Math.min(loaded, file.size) : loaded >= file.size ? 1 : 0;
        const percent = Math.min(99, Math.round(((completedWeight + currentWeight) / totalWeight) * 100));
        setUploadStatus({
          phase: "uploading",
          directory,
          fileName: file.name,
          fileIndex: index + 1,
          fileCount: files.length,
          percent,
          detail: `${destinationLabel} · ${formatBytes(Math.min(loaded, file.size))} / ${formatBytes(file.size)}`,
        });
      };
      updateProgress(0);
      try {
        await runtime.api.uploadWithProgress(
          `${endpoint}/files/content?path=${encodeURIComponent(path)}&size=${file.size}`,
          file,
          (loaded) => updateProgress(loaded),
          {
            method: "PUT",
            headers: { "content-type": file.type || "application/octet-stream" },
            idempotencyKey: commandId("workspace-file-upload"),
          },
        );
        uploaded += 1;
        completedBytes += file.size;
      } catch (reason) {
        failures.push(`${file.name}：${reason instanceof Error ? reason.message : "上传失败"}`);
      }
      completedWeight += Math.max(file.size, 1);
    }
    if (uploaded) await reloadTree(directory);
    if (failures.length) {
      const detail = uploaded
        ? `已上传 ${uploaded} 个，${failures.length} 个失败`
        : failures[0];
      settleUploadStatus({ phase: "error", directory, fileName: "上传已结束", fileIndex: files.length, fileCount: files.length, percent: 100, detail });
      runtime.notify(detail, "error");
      return;
    }
    const detail = `${uploaded} 个文件 · ${formatBytes(completedBytes)} · ${destinationLabel}`;
    settleUploadStatus({ phase: "done", directory, fileName: "上传完成", fileIndex: files.length, fileCount: files.length, percent: 100, detail });
    runtime.notify(`已上传 ${uploaded} 个文件`, "success");
  }, [endpoint, reloadTree, runtime, settleUploadStatus]);

  const prepareUpload = useCallback(async (incoming: File[], directory: string) => {
    if (!uploadAvailable) {
      runtime.notify("当前服务器不支持文件上传", "error");
      return;
    }
    if (uploadingRef.current) {
      runtime.notify("请等待当前上传完成", "error");
      return;
    }
    const byName = new Map<string, File>();
    for (const file of incoming) {
      const name = file.name.trim();
      if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) continue;
      if (!byName.has(name)) byName.set(name, file);
    }
    const files = [...byName.values()];
    if (!files.length) {
      runtime.notify("没有可上传的文件", "error");
      return;
    }
    const maxUploadBytes = remoteFiles.maxUploadBytes;
    const oversized = maxUploadBytes === null ? [] : files.filter((file) => file.size > maxUploadBytes);
    if (oversized.length) {
      const suffix = oversized.length > 1 ? ` 等 ${oversized.length} 个文件` : "";
      runtime.notify(`${oversized[0].name}${suffix}超过服务器允许的 ${formatBytes(maxUploadBytes || 0)}`, "error");
      return;
    }
    uploadingRef.current = true;
    setUploadStatus({ phase: "uploading", directory, fileName: "正在检查目标目录", fileIndex: 0, fileCount: files.length, percent: 0, detail: directory ? baseName(directory) : "工作目录根目录" });
    try {
      const result = await runtime.api.get<DirectorySnapshot>(`${endpoint}/files?path=${encodeURIComponent(directory)}`);
      const existing = new Set(result.data.items.map((entry) => entry.name));
      const conflicts = files.filter((file) => existing.has(file.name)).map((file) => file.name);
      const available = files.filter((file) => !existing.has(file.name));
      uploadingRef.current = false;
      setUploadStatus(null);
      if (conflicts.length) {
        setUploadConflict({ directory, files: available, conflicts });
        return;
      }
      await uploadFiles(files, directory);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "无法检查目标目录";
      settleUploadStatus({ phase: "error", directory, fileName: "无法开始上传", fileIndex: 0, fileCount: files.length, percent: 0, detail });
      runtime.notify(detail, "error");
    }
  }, [endpoint, remoteFiles.maxUploadBytes, runtime, settleUploadStatus, uploadAvailable, uploadFiles]);

  const chooseUploadFiles = (directory: string) => {
    if (!uploadAvailable) {
      runtime.notify("当前服务器不支持文件上传", "error");
      return;
    }
    if (uploadingRef.current) {
      runtime.notify("请等待当前上传完成", "error");
      return;
    }
    uploadDestinationRef.current = directory;
    setContext(null);
    uploadInputRef.current?.click();
  };

  const hasDraggedFiles = (event: ReactDragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  const dragOverUploadTarget = (event: ReactDragEvent, directory: string, stop = false) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (stop) event.stopPropagation();
    if (!uploadAvailable || uploadingRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(directory);
  };
  const leaveUploadTarget = (event: ReactDragEvent, directory: string, stop = false) => {
    if (stop) event.stopPropagation();
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropTarget((current) => current === directory ? null : current);
  };
  const dropFiles = (event: ReactDragEvent, directory: string, stop = false) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (stop) event.stopPropagation();
    setDropTarget(null);
    void prepareUpload(Array.from(event.dataTransfer.files), directory);
  };

  const toggleDirectory = async (entry: RemoteEntry) => {
    const isOpen = expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(entry.path); else next.add(entry.path);
      return next;
    });
    if (!isOpen && !directories[entry.path]) await load(entry.path);
  };

  const openContext = (event: ReactMouseEvent, entry: RemoteEntry | null) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 214;
    const height = entry?.kind === "directory" ? 342 : entry ? 334 : 232;
    const anchor = event.currentTarget.getBoundingClientRect();
    const left = event.type === "contextmenu" ? event.clientX : anchor.right - width;
    const top = event.type === "contextmenu" ? event.clientY : anchor.bottom + 4;
    setContext({
      entry,
      anchor: event.type !== "contextmenu" && event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
    });
  };

  const begin = (kind: InlineAction["kind"], entry: RemoteEntry | null) => {
    const destinationParent = kind === "rename" && entry ? parentPath(entry.path) : entry?.kind === "directory" ? entry.path : "";
    setAction({ kind, entry, parentPath: destinationParent, value: kind === "rename" ? entry?.name || "" : "" });
    setContext(null);
  };

  const submitAction = async () => {
    if (!action || savingAction) return;
    const value = action.value.trim();
    if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
      runtime.notify("名称不能包含斜杠", "error");
      return;
    }
    setSavingAction(true);
    try {
      const path = joinRelative(action.parentPath, value);
      if (action.kind === "create-file") await runtime.api.post(`${endpoint}/files`, { path }, { idempotencyKey: commandId("remote-file-create") });
      else if (action.kind === "create-directory") await runtime.api.post(`${endpoint}/directories`, { path }, { idempotencyKey: commandId("remote-directory-create") });
      else if (action.entry) await runtime.api.patch(`${endpoint}/entries`, { path: action.entry.path, destination: path }, { idempotencyKey: commandId("remote-entry-rename") });
      setAction(null);
      runtime.notify(action.kind === "rename" ? "已重命名" : action.kind === "create-file" ? "文件已创建" : "文件夹已创建", "success");
      await reloadTree();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "文件操作失败", "error"); }
    finally { setSavingAction(false); }
  };

  const copyPath = async (entry: RemoteEntry | null, relative = false) => {
    const value = entry?.path || "";
    try {
      await navigator.clipboard.writeText(relative ? value || "." : absolutePath(session.workspacePath, value));
      runtime.notify(relative ? "相对路径已复制" : "路径已复制", "success");
    } catch {
      runtime.notify("浏览器未允许复制路径", "error");
    }
    setContext(null);
  };

  const download = async (entry: RemoteEntry) => {
    setContext(null);
    try {
      const result = await runtime.api.post<{ url: string; expiresAt: string }>(`${endpoint}/files/download`, { path: entry.path });
      const anchor = document.createElement("a");
      anchor.href = result.data.url;
      anchor.download = entry.name;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "下载失败", "error");
    }
  };

  const pasteInto = async (target: RemoteEntry | null) => {
    if (!clipboard) return;
    const directory = target?.kind === "directory" ? target.path : "";
    if (clipboard.entry.kind === "directory" && (directory === clipboard.entry.path || directory.startsWith(`${clipboard.entry.path}/`))) {
      runtime.notify("不能粘贴到源文件夹内部", "error");
      return;
    }
    const destination = joinRelative(directory, clipboard.entry.name);
    if (destination === clipboard.entry.path) {
      runtime.notify("源位置与目标位置相同", "error");
      return;
    }
    setContext(null);
    try {
      if (clipboard.mode === "cut") {
        await runtime.api.patch(`${endpoint}/entries`, { path: clipboard.entry.path, destination }, { idempotencyKey: commandId("remote-entry-move") });
        setClipboard(null);
      } else {
        await runtime.api.post(`${endpoint}/entries/copy`, { path: clipboard.entry.path, destination }, { idempotencyKey: commandId("remote-entry-copy") });
      }
      runtime.notify(clipboard.mode === "cut" ? "已移动" : "已复制", "success");
      await reloadTree();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "粘贴失败", "error"); }
  };

  const remove = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await runtime.api.delete(`${endpoint}/entries`, {
        body: { path: pendingDelete.path, recursive: pendingDelete.kind === "directory", confirmation: pendingDelete.path },
        idempotencyKey: commandId("remote-entry-delete"),
      });
      runtime.notify(`${pendingDelete.kind === "directory" ? "文件夹" : "文件"}已删除`, "success");
      setPendingDelete(null);
      await reloadTree();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "删除失败", "error"); }
    finally { setDeleting(false); }
  };

  const openPreview = (entry: RemoteEntry) => {
    if (!canPreview(entry) || !session.capabilities.features.preview.available) return;
    runtime.openWorkspacePreview({
      conversationId: session.conversationId,
      serverId: session.serverId,
      workspaceId: session.workspaceId,
      relativePath: entry.path,
      name: entry.name,
      size: entry.size,
    });
    runtime.setSidebarOpen(false);
    setContext(null);
  };

  const renderEntries = (directory: string, depth: number) => {
    const entries = directories[directory] || [];
    return entries.map((entry) => {
      const open = entry.kind === "directory" && expanded.has(entry.path);
      const cut = clipboard?.mode === "cut" && clipboard.entry.path === entry.path;
      return <div className={styles.treeBranch} key={entry.path}>
        <div
          className={`${styles.treeRow} ${cut ? styles.cutRow : ""} ${dropTarget === entry.path ? styles.directoryDropTarget : ""}`}
          data-menu-open={context?.entry?.path === entry.path || undefined}
          style={{ "--tree-depth": depth } as CSSProperties}
          onContextMenu={(event) => openContext(event, entry)}
          onDragEnter={entry.kind === "directory" ? (event) => dragOverUploadTarget(event, entry.path, true) : undefined}
          onDragOver={entry.kind === "directory" ? (event) => dragOverUploadTarget(event, entry.path, true) : undefined}
          onDragLeave={entry.kind === "directory" ? (event) => leaveUploadTarget(event, entry.path, true) : undefined}
          onDrop={entry.kind === "directory" ? (event) => dropFiles(event, entry.path, true) : undefined}
        >
          <button
            type="button"
            className={styles.treeRowMain}
            aria-expanded={entry.kind === "directory" ? open : undefined}
            onClick={() => entry.kind === "directory" ? void toggleDirectory(entry) : canPreview(entry) ? openPreview(entry) : undefined}
            onDoubleClick={() => entry.kind !== "directory" && canPreview(entry) && openPreview(entry)}
            title={entry.path}
          >
            <span className={styles.twisty}>{entry.kind === "directory" ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
            <span data-ui-icon="" className={`${styles.entryIcon} ${entry.kind === "directory" ? styles.folderIcon : ""}`}><EntryIcon entry={entry} open={open} /></span>
            <span className={styles.entryName}>{entry.name}</span>
          </button>
          <button
            type="button"
            className={styles.treeRowMenu}
            aria-label={`${entry.name} 更多操作`}
            aria-haspopup="menu"
            aria-expanded={context?.entry?.path === entry.path}
            title="更多操作"
            onClick={(event) => openContext(event, entry)}
          >
            <MoreHorizontal size={17} />
          </button>
        </div>
        {entry.kind === "directory" && open ? <div className={styles.treeChildren}>
          {loadingPaths.has(entry.path) && !directories[entry.path] ? <div className={styles.treeLoading} style={{ "--tree-depth": depth + 1 } as CSSProperties}><LoaderCircle className={styles.spin} size={13} />正在读取</div> : renderEntries(entry.path, depth + 1)}
          {!loadingPaths.has(entry.path) && directories[entry.path]?.length === 0 ? <div className={styles.emptyDirectory} style={{ "--tree-depth": depth + 1 } as CSSProperties}>空文件夹</div> : null}
        </div> : null}
      </div>;
    });
  };

  const contextEntry = context?.entry || null;
  const contextDirectory = contextEntry?.kind === "directory" ? contextEntry : null;
  const contextOperable = Boolean(contextEntry);
  const previewEnabled = Boolean(contextEntry && canPreview(contextEntry) && session.capabilities.features.preview.available);
  const downloadEnabled = Boolean(contextEntry && contextEntry.kind !== "directory" && session.capabilities.features.remoteFiles.download);
  const canPaste = Boolean(
    clipboard
      && (!contextEntry || contextEntry.kind === "directory")
      && (clipboard.mode === "cut" ? session.capabilities.features.remoteFiles.rename : session.capabilities.features.remoteFiles.copy),
  );

  return <div className={styles.explorer} onContextMenu={(event) => openContext(event, null)}>
    <div className={styles.explorerHeader} onContextMenu={(event) => openContext(event, null)}>
      <button className={styles.rootIdentity} title={session.workspacePath} onClick={() => setExpanded((current) => current.has("") ? new Set() : new Set([""]))}>
        {expanded.has("") ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <FolderOpen size={15} />
        <strong>{baseName(session.workspacePath)}</strong>
      </button>
      <div className={styles.explorerActions}>
        <input
          ref={uploadInputRef}
          className={styles.uploadInput}
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = "";
            if (files.length) void prepareUpload(files, uploadDestinationRef.current);
          }}
        />
        <button title={uploadAvailable ? "上传文件" : "当前服务器不支持上传"} aria-label="上传文件到工作目录" disabled={!uploadAvailable || uploadStatus?.phase === "uploading"} onClick={() => chooseUploadFiles("")}>{uploadStatus?.phase === "uploading" ? <LoaderCircle className={styles.spin} size={15} /> : <Upload size={15} />}</button>
        <button title="新建文件" aria-label="新建文件" disabled={!session.capabilities.features.remoteFiles.create} onClick={() => begin("create-file", null)}><FilePlus2 size={15} /></button>
        <button title="新建文件夹" aria-label="新建文件夹" disabled={!session.capabilities.features.remoteFiles.mkdir} onClick={() => begin("create-directory", null)}><FolderPlus size={15} /></button>
        <button title="刷新" aria-label="刷新文件目录" onClick={() => void reloadTree()}><RefreshCw size={14} /></button>
      </div>
    </div>
    {clipboard ? <div className={styles.clipboardBar}><span>{clipboard.mode === "cut" ? <Scissors size={13} /> : <Copy size={13} />}<b>{clipboard.entry.name}</b></span><button className={styles.mobileRootPaste} disabled={!canPaste} onClick={() => void pasteInto(null)}><ClipboardPaste size={14} /><span>粘贴到根目录</span></button><button aria-label="清除剪贴板" onClick={() => setClipboard(null)}><X size={13} /></button></div> : null}
    {action ? <form className={styles.inlineAction} onSubmit={(event) => { event.preventDefault(); void submitAction(); }}>
      <span>{action.kind === "create-file" ? <FilePlus2 size={14} /> : action.kind === "create-directory" ? <FolderPlus size={14} /> : <Pencil size={14} />}</span>
      <input ref={inputRef} value={action.value} placeholder={action.kind === "create-file" ? "文件名" : action.kind === "create-directory" ? "文件夹名" : "新名称"} disabled={savingAction} onChange={(event) => setAction((current) => current ? { ...current, value: event.target.value } : current)} onKeyDown={(event) => { if (event.key === "Escape") setAction(null); }} />
      <button type="submit" aria-label="确认" disabled={!action.value.trim() || savingAction}>{savingAction ? <LoaderCircle className={styles.spin} size={13} /> : <Check size={13} />}</button>
      <button type="button" aria-label="取消" disabled={savingAction} onClick={() => setAction(null)}><X size={13} /></button>
    </form> : null}
    <div
      className={`${styles.treeScroll} ${dropTarget === "" ? styles.rootDropTarget : ""}`}
      onDragEnter={(event) => dragOverUploadTarget(event, "")}
      onDragOver={(event) => dragOverUploadTarget(event, "")}
      onDragLeave={(event) => leaveUploadTarget(event, "")}
      onDrop={(event) => dropFiles(event, "")}
    >
      {uploadStatus ? <div className={`${styles.uploadStatus} ${styles[`upload_${uploadStatus.phase}`] || ""}`} role="status" aria-live="polite">
        <div className={styles.uploadStatusLine}>
          <span data-ui-icon="" className={styles.uploadStatusIcon}>{uploadStatus.phase === "uploading" ? <LoaderCircle className={styles.spin} size={15} /> : uploadStatus.phase === "done" ? <Check size={15} /> : <X size={15} />}</span>
          <strong>{uploadStatus.fileName}</strong>
          <b>{uploadStatus.percent}%</b>
        </div>
        <div data-ui-icon="" className={styles.uploadTrack} aria-hidden="true"><i data-ui-icon="" style={{ width: `${uploadStatus.percent}%` }} /></div>
        <small>{uploadStatus.fileIndex > 0 ? `${uploadStatus.fileIndex}/${uploadStatus.fileCount} · ` : ""}{uploadStatus.detail}</small>
      </div> : null}
      {dropTarget !== null ? <div className={styles.dropHint}><Upload size={16} /><span>松开后上传到</span><strong>{dropTarget ? baseName(dropTarget) : "工作目录根目录"}</strong></div> : null}
      {expanded.has("") ? loadingPaths.has("") && !directories[""] ? <div className={styles.explorerState}><LoaderCircle className={styles.spin} size={17} />正在读取工作目录</div> : directories[""]?.length ? renderEntries("", 0) : <div className={styles.explorerState}><Folder size={18} />当前工作目录为空</div> : null}
    </div>
    {context && typeof document !== "undefined" ? createPortal(<div ref={contextRef} className={styles.contextMenu} role="menu" aria-label={contextEntry ? `${contextEntry.name} 操作` : "工作目录操作"} style={{ left: context.left, top: context.top }} onPointerDown={(event) => event.stopPropagation()}>
      {contextEntry && contextEntry.kind !== "directory" ? <button disabled={!previewEnabled} onClick={() => previewEnabled && openPreview(contextEntry)}><FileText size={15} />打开预览</button> : contextEntry?.kind === "directory" || !contextEntry ? <>
        <button disabled={!uploadAvailable || uploadStatus?.phase === "uploading"} onClick={() => chooseUploadFiles(contextDirectory?.path || "")}><Upload size={15} />上传文件…</button>
        <button disabled={!session.capabilities.features.remoteFiles.create} onClick={() => begin("create-file", contextDirectory)}><FilePlus2 size={15} />新建文件…</button>
        <button disabled={!session.capabilities.features.remoteFiles.mkdir} onClick={() => begin("create-directory", contextDirectory)}><FolderPlus size={15} />新建文件夹…</button>
      </> : null}
      {contextOperable && contextEntry ? <>
        <span data-ui-icon="" className={styles.menuSeparator} />
        <button onClick={() => { setClipboard({ mode: "cut", entry: contextEntry }); setContext(null); }}><Scissors size={15} />剪切</button>
        <button onClick={() => { setClipboard({ mode: "copy", entry: contextEntry }); setContext(null); }}><Copy size={15} />复制</button>
      </> : null}
      {!contextEntry || contextEntry.kind === "directory" ? <button disabled={!canPaste} onClick={() => void pasteInto(contextDirectory)}><ClipboardPaste size={15} />粘贴</button> : null}
      {contextEntry && contextEntry.kind !== "directory" ? <>
        <span data-ui-icon="" className={styles.menuSeparator} />
        <button disabled={!downloadEnabled} onClick={() => downloadEnabled && void download(contextEntry)}><Download size={15} />下载…</button>
      </> : null}
      <span data-ui-icon="" className={styles.menuSeparator} />
      <button onClick={() => void copyPath(contextEntry)}><Clipboard size={15} />复制路径</button>
      <button onClick={() => void copyPath(contextEntry, true)}><Copy size={15} />复制相对路径</button>
      {contextOperable && contextEntry ? <>
        <span data-ui-icon="" className={styles.menuSeparator} />
        <button disabled={!session.capabilities.features.remoteFiles.rename} onClick={() => begin("rename", contextEntry)}><Pencil size={15} />重命名…</button>
        <button className={styles.dangerItem} disabled={!session.capabilities.features.remoteFiles.delete} onClick={() => { setPendingDelete(contextEntry); setContext(null); }}><Trash2 size={15} />删除</button>
      </> : null}
    </div>, document.body) : null}
    {pendingDelete ? <Modal title={`删除${pendingDelete.kind === "directory" ? "文件夹" : "文件"}？`} size="compact" onClose={() => { if (!deleting) setPendingDelete(null); }}><div className={styles.deleteDialog}><p>“{pendingDelete.name}”将从远程工作目录中删除{pendingDelete.kind === "directory" ? "，其中的内容也会一并删除" : ""}。此操作无法撤销。</p><footer><Button disabled={deleting} onClick={() => setPendingDelete(null)}>取消</Button><Button variant="danger" disabled={deleting} icon={deleting ? <LoaderCircle className={styles.spin} size={14} /> : <Trash2 size={14} />} onClick={() => void remove()}>{deleting ? "正在删除" : "删除"}</Button></footer></div></Modal> : null}
    {uploadConflict ? <Modal title="发现同名文件" size="compact" onClose={() => setUploadConflict(null)}><div className={styles.uploadConflictDialog}>
      <p>目标目录中已有以下文件。为避免误删服务器上的内容，EasyWork 不会自动覆盖：</p>
      <ul>{uploadConflict.conflicts.slice(0, 5).map((name) => <li key={name}>{name}</li>)}</ul>
      {uploadConflict.conflicts.length > 5 ? <small>另有 {uploadConflict.conflicts.length - 5} 个同名文件</small> : null}
      <footer><Button onClick={() => setUploadConflict(null)}>关闭</Button>{uploadConflict.files.length ? <Button variant="primary" onClick={() => { const pending = uploadConflict; setUploadConflict(null); void uploadFiles(pending.files, pending.directory); }}>跳过同名文件并继续</Button> : null}</footer>
    </div></Modal> : null}
  </div>;
}

export function WorkspaceSidebar({ session }: { session: WorkspaceSidebarSession }) {
  const [section, setSection] = useState<"files" | "version">("files");
  const [filesRevision, setFilesRevision] = useState(() => workspaceFilesRevision(session));
  useEffect(() => {
    const refreshChangedWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceFilesChangedDetail>).detail;
      if (detail?.serverId !== session.serverId || detail.workspaceId !== session.workspaceId) return;
      const nextRevision = workspaceFilesRevision(detail);
      explorerCaches.delete(`${session.serverId}:${session.workspaceId}:${filesRevision}`);
      setFilesRevision(nextRevision);
    };
    window.addEventListener(WORKSPACE_FILES_CHANGED_EVENT, refreshChangedWorkspace);
    return () => window.removeEventListener(WORKSPACE_FILES_CHANGED_EVENT, refreshChangedWorkspace);
  }, [filesRevision, session.serverId, session.workspaceId]);
  return <section className={styles.workspaceSidebar} aria-label="对话工作目录">
    <div className={styles.sidebarTabs} role="tablist" aria-label="工作区视图"><button type="button" role="tab" aria-selected={section === "files"} className={section === "files" ? styles.activeSidebarTab : ""} onClick={() => setSection("files")}><ListTree size={14} />文件</button><button type="button" role="tab" aria-selected={section === "version"} className={section === "version" ? styles.activeSidebarTab : ""} onClick={() => setSection("version")}><GitBranch size={14} />版本</button></div>
    <div className={styles.sidebarBody}>{section === "files" ? <WorkspaceExplorer key={`${session.serverId}:${session.workspaceId}:${filesRevision}`} session={session} filesRevision={filesRevision} /> : <Suspense fallback={<div className={styles.versionState}><LoaderCircle className={styles.spin} size={20} /><span>正在载入版本视图</span></div>}><WorkspaceVersionView session={session} /></Suspense>}</div>
  </section>;
}
