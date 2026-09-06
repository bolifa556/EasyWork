"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  FileStack,
  FileText,
  Folder,
  FolderOpen,
  FolderUp,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/app/easywork/ui/Button";
import { FileDeleteButton } from "@/app/easywork/ui/FileDeleteButton";
import { Modal } from "@/app/easywork/ui/Modal";
import type {
  LibraryCollection,
  LibraryFile,
  LibraryPageProps,
  LibrarySortKey,
  LibraryUploadFile,
  SortDirection,
} from "./types";
import styles from "./LibraryPage.module.css";

type CollectionDialog =
  | { type: "create" }
  | { type: "rename"; collection: LibraryCollection }
  | { type: "delete"; collection: LibraryCollection }
  | null;

type MenuState = { collection: LibraryCollection; left: number; top: number } | null;

type DirectoryRow = {
  kind: "directory";
  name: string;
  path: string;
  updatedAt: string;
  size: number;
  fileCount: number;
  failedCount: number;
  processingCount: number;
  status: "ready" | "partial" | "unready" | "processing";
};

type FileRow = LibraryFile & { kind: "file" };
type BrowserRow = DirectoryRow | FileRow;

type DroppedFileEntry = {
  isFile: true;
  isDirectory: false;
  name: string;
  fullPath?: string;
  file: (success: (file: File) => void, failure?: (reason: DOMException) => void) => void;
};

type DroppedDirectoryEntry = {
  isFile: false;
  isDirectory: true;
  name: string;
  fullPath?: string;
  createReader: () => {
    readEntries: (success: (entries: DroppedEntry[]) => void, failure?: (reason: DOMException) => void) => void;
  };
};

type DroppedEntry = DroppedFileEntry | DroppedDirectoryEntry;
type DroppableItem = DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null };

type PickedFileHandle = { kind: "file"; name: string; getFile: () => Promise<File> };
type PickedDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterableIterator<PickedFileHandle | PickedDirectoryHandle>;
};

const formatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** order;
  return `${value >= 10 || order === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[order]}`;
}

function basename(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function cleanRelativePath(value: string, fallback: string) {
  const parts = value.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || fallback;
}

function selectedFiles(files: FileList | null): LibraryUploadFile[] {
  return Array.from(files ?? [], (file) => ({
    file,
    relativePath: cleanRelativePath(file.webkitRelativePath || file.name, file.name),
  }));
}

function containsFiles(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types || []).includes("Files");
}

function entryFile(entry: DroppedFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject));
}

async function directoryEntries(entry: DroppedDirectoryEntry) {
  const reader = entry.createReader();
  const entries: DroppedEntry[] = [];
  while (true) {
    const batch = await new Promise<DroppedEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

async function filesFromDroppedEntry(entry: DroppedEntry, parentPath = ""): Promise<LibraryUploadFile[]> {
  const relativePath = cleanRelativePath(entry.fullPath || [parentPath, entry.name].filter(Boolean).join("/"), entry.name);
  if (entry.isFile) return [{ file: await entryFile(entry), relativePath }];
  const nested = await directoryEntries(entry);
  const children = await Promise.all(nested.map((child) => filesFromDroppedEntry(child, relativePath)));
  return children.flat();
}

async function droppedFiles(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => (item as DroppableItem).webkitGetAsEntry?.() || null)
    .filter((entry): entry is DroppedEntry => Boolean(entry));
  if (entries.length) return (await Promise.all(entries.map((entry) => filesFromDroppedEntry(entry)))).flat();
  return selectedFiles(dataTransfer.files);
}

async function filesFromPickedDirectory(directory: PickedDirectoryHandle, parentPath = ""): Promise<LibraryUploadFile[]> {
  const directoryPath = cleanRelativePath([parentPath, directory.name].filter(Boolean).join("/"), directory.name);
  const files: LibraryUploadFile[] = [];
  for await (const entry of directory.values()) {
    if (entry.kind === "file") files.push({ file: await entry.getFile(), relativePath: `${directoryPath}/${entry.name}` });
    else files.push(...await filesFromPickedDirectory(entry, directoryPath));
  }
  return files;
}

async function pickFolderFiles() {
  const picker = (window as typeof window & { showDirectoryPicker?: () => Promise<PickedDirectoryHandle> }).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持直接选择文件夹，请将文件夹拖放到目标目录");
  const directory = await picker.call(window);
  return filesFromPickedDirectory(directory);
}

function getRows(files: LibraryFile[], directory: string): BrowserRow[] {
  const prefix = directory ? `${directory}/` : "";
  const folders = new Map<string, DirectoryRow>();
  const directFiles: FileRow[] = [];

  for (const file of files) {
    const normalized = file.relativePath.replace(/^\/+/, "");
    if (!normalized.startsWith(prefix)) continue;
    const remainder = normalized.slice(prefix.length);
    const nextSlash = remainder.indexOf("/");
    if (nextSlash === -1) {
      directFiles.push({ ...file, kind: "file" });
      continue;
    }

    const folderName = remainder.slice(0, nextSlash);
    const folderPath = `${prefix}${folderName}`;
    const existing = folders.get(folderPath);
    const updatedAt = existing && existing.updatedAt > file.updatedAt ? existing.updatedAt : file.updatedAt;
    const fileCount = (existing?.fileCount ?? 0) + 1;
    const failedCount = (existing?.failedCount ?? 0) + (file.status === "error" ? 1 : 0);
    const processingCount = (existing?.processingCount ?? 0) + (["pending", "extracting", "embedding"].includes(file.status) ? 1 : 0);
    folders.set(folderPath, {
      kind: "directory",
      name: folderName,
      path: folderPath,
      updatedAt,
      size: (existing?.size ?? 0) + file.size,
      fileCount,
      failedCount,
      processingCount,
      status: failedCount === fileCount ? "unready" : failedCount > 0 ? "partial" : processingCount > 0 ? "processing" : "ready",
    });
  }

  return [...folders.values(), ...directFiles];
}

function Status({ file }: { file: LibraryFile }) {
  if (file.status === "ready") {
    return <span className={`${styles.status} ${styles.ready}`}><CheckCircle2 size={15} />已就绪</span>;
  }
  if (file.status === "readable") {
    return <span className={`${styles.status} ${styles.readable}`}><FileText size={15} />可直接读取</span>;
  }
  if (file.status === "error") {
    return <span className={`${styles.status} ${styles.failed}`}><TriangleAlert size={15} />索引失败</span>;
  }
  const labels = { pending: "等待索引", extracting: "正在解析", embedding: "正在索引" } as const;
  return <span className={`${styles.status} ${styles.processing}`}><LoaderCircle size={15} />{labels[file.status]}</span>;
}

function FolderStatus({ folder }: { folder: DirectoryRow }) {
  if (folder.status === "ready") return <span className={`${styles.status} ${styles.ready}`}><CheckCircle2 size={15} />已就绪</span>;
  if (folder.status === "partial") return <span className={`${styles.status} ${styles.partial}`}><TriangleAlert size={15} />部分就绪</span>;
  if (folder.status === "unready") return <span className={`${styles.status} ${styles.failed}`}><TriangleAlert size={15} />未就绪</span>;
  return <span className={`${styles.status} ${styles.processing}`}><LoaderCircle size={15} />正在处理</span>;
}

function CollectionEditor({
  dialog,
  busy,
  onClose,
  onSubmit,
}: {
  dialog: Exclude<CollectionDialog, null>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name?: string) => void;
}) {
  const [name, setName] = useState(dialog.type === "rename" ? dialog.collection.name : "");
  const deletion = dialog.type === "delete";
  const title = dialog.type === "create" ? "新建文件集" : dialog.type === "rename" ? "重命名文件集" : "删除文件集";
  return (
    <Modal title={title} size="compact" onClose={onClose}>
      {deletion ? (
        <div className={styles.deleteDialog}>
          <p>确认删除“{dialog.collection.name}”？文件与索引将一并移除。</p>
          <div className={styles.dialogActions}>
            <Button onClick={onClose}>取消</Button>
            <Button variant="danger" disabled={busy} onClick={() => onSubmit()}>{busy ? "正在删除" : "删除"}</Button>
          </div>
        </div>
      ) : (
        <form className={styles.editorForm} onSubmit={(event) => { event.preventDefault(); onSubmit(name.trim()); }}>
          <label htmlFor="collection-name">文件集名称</label>
          <input
            id="collection-name"
            autoFocus
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="输入名称"
          />
          <div className={styles.dialogActions}>
            <Button type="button" onClick={onClose}>取消</Button>
            <Button variant="primary" type="submit" disabled={!name.trim() || busy}>{busy ? "正在保存" : "保存"}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function CollectionMenu({ state, onClose, onRename, onDelete }: {
  state: Exclude<MenuState, null>;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      <button className={styles.menuScrim} aria-label="关闭菜单" onClick={onClose} />
      <div className={styles.collectionMenu} style={{ left: state.left, top: state.top }} role="menu">
        <button role="menuitem" onClick={onRename}><Pencil size={16} />重命名</button>
        <button role="menuitem" className={styles.dangerItem} onClick={onDelete}><Trash2 size={16} />删除</button>
      </div>
    </>,
    document.body,
  );
}

function CollectionsView({
  collections,
  loading,
  uploadBusy,
  onSelect,
  onCreate,
  onMenu,
  onUpload,
  onUploadError,
}: {
  collections: LibraryCollection[];
  loading: boolean;
  uploadBusy: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMenu: (event: ReactMouseEvent<HTMLButtonElement>, collection: LibraryCollection) => void;
  onUpload: (collectionId: string, files: LibraryUploadFile[]) => void;
  onUploadError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [dropCollectionId, setDropCollectionId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? collections.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : collections;
  }, [collections, query]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleLine}><span data-ui-icon="" className={styles.titleIcon}><FileStack size={19} /></span><h1>文件库</h1></div>
      </header>

      <div className={styles.collectionToolbar}>
        <label className={styles.searchField}>
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件集" aria-label="搜索文件集" />
        </label>
        <Button compact className={styles.createCollectionButton} icon={<Plus size={15} />} onClick={onCreate}>新建文件集</Button>
      </div>

      {loading ? (
        <div className={styles.centerState}><LoaderCircle className={styles.spin} size={22} />正在读取文件库</div>
      ) : filtered.length ? (
        <div className={styles.collectionGrid}>
          {filtered.map((collection) => (
            <article
              key={collection.id}
              className={`${styles.collectionCard} ${dropCollectionId === collection.id ? styles.collectionDropTarget : ""}`}
              onDragEnter={(event) => {
                if (!containsFiles(event) || uploadBusy) return;
                event.preventDefault();
                setDropCollectionId(collection.id);
              }}
              onDragOver={(event) => {
                if (!containsFiles(event) || uploadBusy) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setDropCollectionId(collection.id);
              }}
              onDragLeave={(event) => {
                if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
                setDropCollectionId((current) => current === collection.id ? null : current);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDropCollectionId(null);
                if (uploadBusy) return;
                void droppedFiles(event.dataTransfer).then((files) => {
                  if (files.length) onUpload(collection.id, files);
                }).catch((reason: unknown) => onUploadError(reason instanceof Error ? reason.message : "无法读取拖放的文件"));
              }}
            >
              <button className={styles.collectionOpen} onClick={() => onSelect(collection.id)}>
                <span data-ui-icon="" className={styles.folderIcon}><Folder size={21} /></span>
                <span className={styles.collectionText}>
                  <strong>{collection.name}</strong>
                </span>
                <ChevronRight size={18} />
              </button>
              <button
                className={styles.moreButton}
                aria-label={`${collection.name}的更多操作`}
                onClick={(event) => onMenu(event, collection)}
              ><MoreHorizontal size={18} /></button>
            </article>
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <Folder size={28} />
          <strong>{query ? "没有匹配的文件集" : "还没有文件集"}</strong>
        </div>
      )}
    </div>
  );
}

function SortButton({ label, sortKey, activeKey, direction, onSort }: {
  label: string;
  sortKey: LibrarySortKey;
  activeKey: LibrarySortKey;
  direction: SortDirection;
  onSort: (key: LibrarySortKey) => void;
}) {
  const active = sortKey === activeKey;
  return (
    <button
      className={styles.sortButton}
      onClick={() => onSort(sortKey)}
      aria-label={`${label}${active ? `，${direction === "ascending" ? "升序" : "降序"}` : "，点击排序"}`}
    >
      {label}
      {active ? direction === "ascending" ? <ArrowUp size={14} /> : <ArrowDown size={14} /> : null}
    </button>
  );
}

function CollectionDetail({ collection, files, busyAction, onBack, onUpload, onUploadError, onRetry, onPreview, onDelete }: {
  collection: LibraryCollection;
  files: LibraryFile[];
  busyAction: string | null;
  onBack: () => void;
  onUpload: (directory: string, files: LibraryUploadFile[]) => void;
  onUploadError: (message: string) => void;
  onRetry: (fileId: string) => void;
  onPreview: (file: LibraryFile) => void;
  onDelete: (files: LibraryFile[]) => void | Promise<void>;
}) {
  const [directory, setDirectory] = useState("");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<LibrarySortKey>("updatedAt");
  const [direction, setDirection] = useState<SortDirection>("descending");
  const [dropDirectory, setDropDirectory] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const visible = getRows(files, directory).filter((row) => !needle || row.name.toLocaleLowerCase().includes(needle));
    const factor = direction === "ascending" ? 1 : -1;
    return visible.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      if (sortKey === "size") return (a.size - b.size) * factor;
      if (sortKey === "updatedAt") return a.updatedAt.localeCompare(b.updatedAt) * factor;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true }) * factor;
    });
  }, [directory, direction, files, query, sortKey]);

  const breadcrumbs = directory.split("/").filter(Boolean);
  const setSort = (next: LibrarySortKey) => {
    if (sortKey === next) setDirection((value) => value === "ascending" ? "descending" : "ascending");
    else {
      setSortKey(next);
      setDirection(next === "name" ? "ascending" : "descending");
    }
  };
  const receive = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = selectedFiles(event.currentTarget.files);
    if (selected.length) onUpload(directory, selected);
    event.currentTarget.value = "";
  };
  const changeDirectory = (next: string) => {
    setDirectory(next);
    setQuery("");
    setDropDirectory(null);
  };
  const parentDirectory = breadcrumbs.slice(0, -1).join("/");
  const chooseFolder = async () => {
    try {
      const selected = await pickFolderFiles();
      if (selected.length) onUpload(directory, selected);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      onUploadError(reason instanceof Error ? reason.message : "无法读取所选文件夹");
    }
  };
  const activateDropTarget = (event: ReactDragEvent<HTMLElement>, targetDirectory: string) => {
    if (!containsFiles(event) || busyAction) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDropDirectory(targetDirectory);
  };
  const leaveDropTarget = (event: ReactDragEvent<HTMLElement>, targetDirectory: string) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setDropDirectory((current) => current === targetDirectory ? null : current);
  };
  const uploadDrop = (event: ReactDragEvent<HTMLElement>, targetDirectory: string) => {
    event.preventDefault();
    event.stopPropagation();
    setDropDirectory(null);
    if (busyAction) return;
    void droppedFiles(event.dataTransfer).then((selected) => {
      if (selected.length) onUpload(targetDirectory, selected);
    }).catch((reason: unknown) => onUploadError(reason instanceof Error ? reason.message : "无法读取拖放的文件"));
  };

  return (
    <div
      className={styles.page}
      onDragEnter={(event) => activateDropTarget(event, directory)}
      onDragOver={(event) => activateDropTarget(event, directory)}
      onDragLeave={(event) => leaveDropTarget(event, directory)}
      onDrop={(event) => uploadDrop(event, directory)}
    >
      <header className={styles.detailHeader}>
        <Button className={styles.collectionBack} variant="ghost" iconOnly aria-label="返回文件集" icon={<ArrowLeft size={19} />} onClick={onBack} />
        <div><h1>{collection.name}</h1></div>

      </header>

      {busyAction === "upload" ? <div className={styles.mobileUploadStatus} role="status" aria-live="polite"><span><LoaderCircle className={styles.spin} size={16} /><strong>正在上传到 {directory || collection.name}</strong></span><small>完成后文件会自动出现在当前目录</small><i data-ui-icon="" aria-hidden="true"><b /></i></div> : null}

        <nav className={styles.breadcrumbs} aria-label="文件路径">
          <button
            className={dropDirectory === "" ? styles.breadcrumbDropTarget : ""}
            onClick={() => changeDirectory("")}
            onDragEnter={(event) => activateDropTarget(event, "")}
            onDragOver={(event) => activateDropTarget(event, "")}
            onDragLeave={(event) => leaveDropTarget(event, "")}
            onDrop={(event) => uploadDrop(event, "")}
          ><FolderOpen size={17} />{collection.name}</button>
          {breadcrumbs.map((part, index) => (
            <span key={`${part}-${index}`}><ChevronRight size={14} /><button
              className={dropDirectory === breadcrumbs.slice(0, index + 1).join("/") ? styles.breadcrumbDropTarget : ""}
              onClick={() => changeDirectory(breadcrumbs.slice(0, index + 1).join("/"))}
              onDragEnter={(event) => activateDropTarget(event, breadcrumbs.slice(0, index + 1).join("/"))}
              onDragOver={(event) => activateDropTarget(event, breadcrumbs.slice(0, index + 1).join("/"))}
              onDragLeave={(event) => leaveDropTarget(event, breadcrumbs.slice(0, index + 1).join("/"))}
              onDrop={(event) => uploadDrop(event, breadcrumbs.slice(0, index + 1).join("/"))}
            >{part}</button></span>
          ))}
        </nav>
      <div className={styles.browserToolbar}>
        <div className={styles.directoryActions}>
          {directory ? <Button className={styles.directoryBack} compact iconOnly variant="ghost" aria-label="返回上一级目录" icon={<ArrowLeft size={17} />} onClick={() => changeDirectory(parentDirectory)} /> : null}
          <label className={`${styles.searchField} ${styles.fileSearch}`}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前目录" aria-label="搜索当前目录" /></label>
        </div>
        <div className={styles.uploadActions}>
          <Button compact aria-label="上传文件" icon={busyAction === "upload" ? <LoaderCircle className={styles.spin} size={16} /> : <Upload size={16} />} disabled={Boolean(busyAction)} onClick={() => fileInput.current?.click()}><span><span className={styles.uploadVerb}>上传</span>文件</span></Button>
          <Button compact aria-label="上传文件夹" icon={busyAction === "upload" ? <LoaderCircle className={styles.spin} size={16} /> : <FolderUp size={16} />} disabled={Boolean(busyAction)} onClick={() => void chooseFolder()}><span><span className={styles.uploadVerb}>上传</span>文件夹</span></Button>
          <input ref={fileInput} className={styles.hiddenInput} type="file" multiple onChange={receive} />
        </div>
      </div>

      <div className={styles.browserLayout}>
        <section
          className={`${styles.fileBrowser} ${dropDirectory === directory ? styles.currentDirectoryDropTarget : ""}`}
          aria-label="文件"
          onDragEnter={(event) => activateDropTarget(event, directory)}
          onDragOver={(event) => activateDropTarget(event, directory)}
          onDragLeave={(event) => leaveDropTarget(event, directory)}
          onDrop={(event) => uploadDrop(event, directory)}
        >
        <div className={styles.tableHeader}>
          <SortButton label="名称" sortKey="name" activeKey={sortKey} direction={direction} onSort={setSort} />
          <SortButton label="更新时间" sortKey="updatedAt" activeKey={sortKey} direction={direction} onSort={setSort} />
          <SortButton label="大小" sortKey="size" activeKey={sortKey} direction={direction} onSort={setSort} />
          <span>索引状态</span>
          <span className={styles.actionHeader}>操作</span>
        </div>
        <div className={styles.tableBody}>
          {rows.length ? rows.map((row) => row.kind === "directory" ? (
            <div
              key={row.path}
              className={`${styles.fileRow} ${dropDirectory === row.path ? styles.folderDropTarget : ""}`}
              onDragEnter={(event) => activateDropTarget(event, row.path)}
              onDragOver={(event) => activateDropTarget(event, row.path)}
              onDragLeave={(event) => leaveDropTarget(event, row.path)}
              onDrop={(event) => uploadDrop(event, row.path)}
            >
              <button className={`${styles.fileName} ${styles.fileNameButton}`} title={`打开 ${row.path}`} onClick={() => changeDirectory(row.path)}><Folder size={18} /><strong>{row.name}</strong></button>
              <time className={styles.fileTime}>{formatter.format(new Date(row.updatedAt))}</time>
              <span className={styles.fileSize}>{formatSize(row.size)}</span>
              <span className={styles.folderLabel}><FolderStatus folder={row} /></span>
              <FileDeleteButton
                folder
                path={row.path}
                disabled={Boolean(busyAction)}
                onDelete={() => onDelete(files.filter((file) => file.relativePath.replace(/^\/+/, "").startsWith(`${row.path}/`)))}
              />
            </div>
          ) : (
            <div key={row.bindingId} className={`${styles.fileRow} ${row.status === "error" ? styles.errorRow : ""}`}>
              <button className={`${styles.fileName} ${styles.fileNameButton}`} title={`预览 ${row.relativePath}`} onClick={() => onPreview(row)}><FileText size={18} /><strong>{row.name || basename(row.relativePath)}</strong></button>
              <time className={styles.fileTime}>{formatter.format(new Date(row.updatedAt))}</time>
              <span className={styles.fileSize}>{formatSize(row.size)}</span>
              <span className={styles.statusCell}>
                <Status file={row} />
                {["error", "readable"].includes(row.status) ? <Button compact variant="ghost" icon={<RotateCcw size={14} />} disabled={Boolean(busyAction)} onClick={() => onRetry(row.id)}>{row.status === "readable" ? "向量化" : "重试"}</Button> : null}
              </span>
              <FileDeleteButton
                path={row.relativePath}
                disabled={Boolean(busyAction)}
                onDelete={() => onDelete([row])}
              />
              {row.status === "error" && row.error ? <span className={styles.errorReason}>{row.error}</span> : null}
            </div>
          )) : (
            <div className={styles.emptyDirectory}><FolderOpen size={25} /><span>{query ? "当前目录没有匹配项" : "当前目录为空"}</span></div>
          )}
        </div>
        </section>
      </div>
    </div>
  );
}

export default function LibraryPage({
  collections,
  selectedCollectionId,
  files,
  loading = false,
  busyAction = null,
  onSelectCollection,
  onCreateCollection,
  onRenameCollection,
  onDeleteCollection,
  onDeleteFiles,
  onUploadFiles,
  onUploadError,
  onRetryIndex,
  onPreviewFile,
}: LibraryPageProps) {
  const [dialog, setDialog] = useState<CollectionDialog>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const selected = collections.find((item) => item.id === selectedCollectionId) ?? null;
  const pending = busyAction === "collection";

  const openMenu = (event: ReactMouseEvent<HTMLButtonElement>, collection: LibraryCollection) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ collection, left: Math.max(12, Math.min(window.innerWidth - 172, rect.right - 160)), top: Math.min(window.innerHeight - 112, rect.bottom + 6) });
  };

  const submitDialog = async (name?: string) => {
    if (!dialog) return;
    try {
      if (dialog.type === "create" && name) await onCreateCollection(name);
      if (dialog.type === "rename" && name) await onRenameCollection(dialog.collection.id, name);
      if (dialog.type === "delete") await onDeleteCollection(dialog.collection.id);
      setDialog(null);
    } catch {
      // The connected layer owns the persistent error surface (toast); keep the form open.
    }
  };

  return (
    <>
      {selected ? (
        <CollectionDetail
          key={selected.id}
          collection={selected}
          files={files}
          busyAction={busyAction}
          onBack={() => onSelectCollection(null)}
          onUpload={(directory, selectedFiles) => onUploadFiles(selected.id, directory, selectedFiles)}
          onUploadError={onUploadError}
          onRetry={(fileId) => onRetryIndex(selected.id, fileId)}
          onPreview={onPreviewFile}
          onDelete={(selectedFiles) => onDeleteFiles(selected.id, selectedFiles)}
        />
      ) : (
        <CollectionsView
          collections={collections}
          loading={loading}
          uploadBusy={Boolean(busyAction)}
          onSelect={onSelectCollection}
          onCreate={() => setDialog({ type: "create" })}
          onMenu={openMenu}
          onUpload={(collectionId, selectedFiles) => onUploadFiles(collectionId, "", selectedFiles)}
          onUploadError={onUploadError}
        />
      )}
      {menu ? (
        <CollectionMenu
          state={menu}
          onClose={() => setMenu(null)}
          onRename={() => { setDialog({ type: "rename", collection: menu.collection }); setMenu(null); }}
          onDelete={() => { setDialog({ type: "delete", collection: menu.collection }); setMenu(null); }}
        />
      ) : null}
      {dialog ? <CollectionEditor dialog={dialog} busy={pending} onClose={() => setDialog(null)} onSubmit={submitDialog} /> : null}
    </>
  );
}
