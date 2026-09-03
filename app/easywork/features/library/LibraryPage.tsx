"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Eye,
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
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/app/easywork/ui/Button";
import { Modal } from "@/app/easywork/ui/Modal";
import type {
  LibraryCollection,
  LibraryFile,
  LibraryPageProps,
  LibrarySortKey,
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
};

type FileRow = LibraryFile & { kind: "file" };
type BrowserRow = DirectoryRow | FileRow;
type TreeNode = { name: string; path: string; children: TreeNode[] };

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
    folders.set(folderPath, {
      kind: "directory",
      name: folderName,
      path: folderPath,
      updatedAt,
      size: (existing?.size ?? 0) + file.size,
    });
  }

  return [...folders.values(), ...directFiles];
}

function getDirectoryTree(files: LibraryFile[]) {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const file of files) {
    const segments = file.relativePath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
    segments.pop();
    let node = root;
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      let child = node.children.find((entry) => entry.name === segment);
      if (!child) {
        child = { name: segment, path, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

function DirectoryTree({ nodes, activePath, depth = 0, onSelect }: {
  nodes: TreeNode[];
  activePath: string;
  depth?: number;
  onSelect: (path: string) => void;
}) {
  return nodes.map((node) => (
    <div key={node.path}>
      <button
        className={node.path === activePath ? styles.activeDirectory : ""}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onClick={() => onSelect(node.path)}
      ><Folder size={15} /><span>{node.name}</span></button>
      {node.children.length ? <DirectoryTree nodes={node.children} activePath={activePath} depth={depth + 1} onSelect={onSelect} /> : null}
    </div>
  ));
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
  onSelect,
  onCreate,
  onMenu,
}: {
  collections: LibraryCollection[];
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onMenu: (event: ReactMouseEvent<HTMLButtonElement>, collection: LibraryCollection) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? collections.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : collections;
  }, [collections, query]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.titleLine}><span className={styles.titleIcon}><FileStack size={19} /></span><h1>文件库</h1><span>{collections.length}</span></div>
      </header>

      <div className={styles.collectionToolbar}>
        <label className={styles.searchField}>
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件集" aria-label="搜索文件集" />
        </label>
        <Button className={styles.createCollectionButton} variant="primary" icon={<Plus size={17} />} onClick={onCreate}>新建文件集</Button>
      </div>

      {loading ? (
        <div className={styles.centerState}><LoaderCircle className={styles.spin} size={22} />正在读取文件库</div>
      ) : filtered.length ? (
        <div className={styles.collectionGrid}>
          {filtered.map((collection) => (
            <article key={collection.id} className={styles.collectionCard}>
              <button className={styles.collectionOpen} onClick={() => onSelect(collection.id)}>
                <span className={styles.folderIcon}><Folder size={21} /></span>
                <span className={styles.collectionText}>
                  <strong>{collection.name}</strong>
                  <small>{collection.fileCount} 个文件</small>
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

function CollectionDetail({ collection, files, busyAction, onBack, onUpload, onRetry, onPreview }: {
  collection: LibraryCollection;
  files: LibraryFile[];
  busyAction: string | null;
  onBack: () => void;
  onUpload: (directory: string, files: File[]) => void;
  onRetry: (fileId: string) => void;
  onPreview: (file: LibraryFile) => void;
}) {
  const [directory, setDirectory] = useState("");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<LibrarySortKey>("updatedAt");
  const [direction, setDirection] = useState<SortDirection>("descending");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

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
  const directoryTree = useMemo(() => getDirectoryTree(files), [files]);
  const setSort = (next: LibrarySortKey) => {
    if (sortKey === next) setDirection((value) => value === "ascending" ? "descending" : "ascending");
    else {
      setSortKey(next);
      setDirection(next === "name" ? "ascending" : "descending");
    }
  };
  const receive = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    if (selected.length) onUpload(directory, selected);
    event.currentTarget.value = "";
  };

  return (
    <div className={styles.page}>
      <header className={styles.detailHeader}>
        <Button variant="ghost" iconOnly aria-label="返回文件集" icon={<ArrowLeft size={19} />} onClick={onBack} />
        <div><h1>{collection.name}</h1><span>{collection.fileCount} 个文件</span></div>
        <div className={styles.uploadActions}>
          <Button icon={<Upload size={16} />} disabled={busyAction === "upload"} onClick={() => fileInput.current?.click()}>上传文件</Button>
          <Button icon={<FolderUp size={16} />} disabled={busyAction === "upload"} onClick={() => folderInput.current?.click()}>上传文件夹</Button>
          <input ref={fileInput} className={styles.hiddenInput} type="file" multiple onChange={receive} />
          <input
            ref={(node) => {
              folderInput.current = node;
              if (node) node.setAttribute("webkitdirectory", "");
            }}
            className={styles.hiddenInput}
            type="file"
            multiple
            onChange={receive}
          />
        </div>
      </header>

      <div className={styles.browserToolbar}>
        <nav className={styles.breadcrumbs} aria-label="文件路径">
          <button onClick={() => setDirectory("")}><FolderOpen size={17} />{collection.name}</button>
          {breadcrumbs.map((part, index) => (
            <span key={`${part}-${index}`}><ChevronRight size={14} /><button onClick={() => setDirectory(breadcrumbs.slice(0, index + 1).join("/"))}>{part}</button></span>
          ))}
        </nav>
        <label className={`${styles.searchField} ${styles.fileSearch}`}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前目录" /></label>
      </div>

      <div className={styles.browserLayout}>
        <aside className={styles.directoryTree} aria-label="目录树">
          <button className={!directory ? styles.activeDirectory : ""} onClick={() => setDirectory("")}><FolderOpen size={16} /><span>全部文件</span></button>
          <DirectoryTree nodes={directoryTree} activePath={directory} onSelect={setDirectory} />
        </aside>
        <section className={styles.fileBrowser} aria-label="文件">
        <div className={styles.tableHeader}>
          <SortButton label="名称" sortKey="name" activeKey={sortKey} direction={direction} onSort={setSort} />
          <SortButton label="更新时间" sortKey="updatedAt" activeKey={sortKey} direction={direction} onSort={setSort} />
          <SortButton label="大小" sortKey="size" activeKey={sortKey} direction={direction} onSort={setSort} />
          <span>索引状态</span>
        </div>
        <div className={styles.tableBody}>
          {rows.length ? rows.map((row) => row.kind === "directory" ? (
            <button key={row.path} className={styles.fileRow} onClick={() => setDirectory(row.path)}>
              <span className={styles.fileName}><Folder size={18} /><strong>{row.name}</strong></span>
              <time className={styles.fileTime}>{formatter.format(new Date(row.updatedAt))}</time>
              <span className={styles.fileSize}>{formatSize(row.size)}</span>
              <span className={styles.folderLabel}>文件夹</span>
            </button>
          ) : (
            <div key={row.id} className={`${styles.fileRow} ${row.status === "error" ? styles.errorRow : ""}`}>
              <span className={styles.fileName}><FileText size={18} /><strong>{row.name || basename(row.relativePath)}</strong></span>
              <time className={styles.fileTime}>{formatter.format(new Date(row.updatedAt))}</time>
              <span className={styles.fileSize}>{formatSize(row.size)}</span>
              <span className={styles.statusCell}>
                <Status file={row} />
                <Button compact variant="ghost" icon={<Eye size={14} />} onClick={() => onPreview(row)}>预览</Button>
                {["error", "readable"].includes(row.status) ? <Button compact variant="ghost" icon={<RotateCcw size={14} />} disabled={busyAction === `retry:${row.id}`} onClick={() => onRetry(row.id)}>{row.status === "readable" ? "向量化" : "重试"}</Button> : null}
              </span>
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
  onUploadFiles,
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
          collection={selected}
          files={files}
          busyAction={busyAction}
          onBack={() => onSelectCollection(null)}
          onUpload={(directory, selectedFiles) => onUploadFiles(selected.id, directory, selectedFiles)}
          onRetry={(fileId) => onRetryIndex(selected.id, fileId)}
          onPreview={onPreviewFile}
        />
      ) : (
        <CollectionsView
          collections={collections}
          loading={loading}
          onSelect={onSelectCollection}
          onCreate={() => setDialog({ type: "create" })}
          onMenu={openMenu}
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
