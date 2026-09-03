"use client";

import {
  ArrowLeft,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  FileCode2,
  FileText,
  LoaderCircle,
  PackageCheck,
  PackageMinus,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Store,
  Trash2,
  Upload,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { commandId } from "@/app/core/gateway/client";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { readSkillMetadata, splitServerRules } from "./skill-metadata.mjs";
import { installedSkillsAfterUninstall, uninstallInstalledSkill } from "./skill-uninstall.mjs";
import styles from "./SkillsView.module.css";

type SkillTab = "installed" | "market" | "uploads";
type DetailSource = "installed" | "market" | "upload";
const INSTALL_FEEDBACK_MS = 360;
type ReviewTab = "pending" | "reviewed";
type ReviewStatus = "pending" | "approved" | "rejected";
type SkillApplicability = { mode: "all" | "chat" | "work"; serverKind: "all" | "compute" | "standard"; allowServers: string[]; denyServers: string[]; forceEnabled: boolean };

type SkillSummary = {
  id: string;
  skillId: string;
  name: string;
  description: string;
  updatedAt: string;
  fileCount?: number;
  revision?: number;
  installed?: boolean;
  createdAt?: string;
  applicability: SkillApplicability;
};

type UploadSummary = SkillSummary & {
  status: ReviewStatus;
  uploaderId: string;
  submittedAt: string;
  reviewedAt: string | null;
  revision: number;
  fileCount: number;
};

type SkillFile = {
  path: string;
  size: number;
  sha256: string;
  binary: boolean;
  content: string | null;
  truncated: boolean;
};

type SkillDetail = SkillSummary & {
  entrypoint: string;
  primaryFile: string;
  files: SkillFile[];
  status?: ReviewStatus;
  uploaderId?: string;
  submittedAt?: string;
  reviewedAt?: string | null;
};

type ListResult<T> = { items: T[]; revision: number };
type SkillsPageCache = {
  installed: SkillSummary[];
  market: SkillSummary[];
  uploads: UploadSummary[];
  loadedListKeys: string[];
};
type PackageFile = { path: string; content: string };
type DirectoryEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, failure?: (reason: DOMException) => void) => void;
  createReader?: () => { readEntries: (success: (entries: DirectoryEntry[]) => void, failure?: (reason: DOMException) => void) => void };
};

const tabs: Array<{ id: SkillTab; label: string }> = [
  { id: "installed", label: "已安装" },
  { id: "market", label: "市场" },
  { id: "uploads", label: "上传管理" },
];
const skillsPageCache = new Map<string, SkillsPageCache>();

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDate(value?: string | null) {
  if (!value) return "—";
  return dateTime.format(new Date(value));
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const defaultApplicability: SkillApplicability = { mode: "all", serverKind: "all", allowServers: [], denyServers: [], forceEnabled: false };

function applicabilityLabel(value?: SkillApplicability) {
  if (value?.mode === "chat") return "仅聊天模式可见";
  const kind = value?.serverKind === "compute" ? "算力服务器" : value?.serverKind === "standard" ? "普通服务器" : "全部服务器";
  const rules = (value?.allowServers.length || 0) + (value?.denyServers.length || 0);
  return rules ? `${kind} · ${rules} 条服务器规则` : kind;
}

function ApplicabilityFields({ value, onChange }: { value: SkillApplicability; onChange: (value: SkillApplicability) => void }) {
  const [allowText, setAllowText] = useState(value.allowServers.join(", "));
  const [denyText, setDenyText] = useState(value.denyServers.join(", "));
  const chatOnly = value.mode === "chat";
  return <div className={styles.scopeFields}>
    <label><span>适用模式</span><select value={value.mode} onChange={(event) => onChange({ ...value, mode: event.target.value as SkillApplicability["mode"], forceEnabled: event.target.value !== "chat" && value.forceEnabled })}><option value="all">全部模式</option><option value="chat">聊天模式</option><option value="work">工作模式</option></select></label>
    <fieldset disabled={chatOnly} className={styles.serverScopeFields}>
      <label><span>适用服务器</span><select value={value.serverKind} onChange={(event) => onChange({ ...value, serverKind: event.target.value as SkillApplicability["serverKind"] })}><option value="all">全部服务器</option><option value="standard">普通服务器</option><option value="compute">算力服务器</option></select></label>
      <label><span>仅允许</span><input value={allowText} placeholder="留空表示不限制；可填服务器 ID、名称或主机名" onChange={(event) => { setAllowText(event.target.value); onChange({ ...value, allowServers: splitServerRules(event.target.value) }); }} /></label>
      <label><span>禁止</span><input value={denyText} placeholder="可填多个，以逗号分隔" onChange={(event) => { setDenyText(event.target.value); onChange({ ...value, denyServers: splitServerRules(event.target.value) }); }} /></label>
    </fieldset>
    {!chatOnly ? <label className={styles.forceSkill}><span>是否强制启用该技能</span><select value={value.forceEnabled ? "yes" : "no"} onChange={(event) => onChange({ ...value, forceEnabled: event.target.value === "yes" })}><option value="no">否，按需选择</option><option value="yes">是，自动发送</option></select><small>工作对话中，符合服务器范围时自动发送给远端 Agent；同一远端对话不重复发送相同版本。</small></label> : null}
  </div>;
}

function ApplicabilityDialog({ initial, busy, onClose, onSave }: { initial: SkillApplicability; busy: boolean; onClose: () => void; onSave: (value: SkillApplicability) => void }) {
  const [value, setValue] = useState(() => ({ ...initial, allowServers: [...initial.allowServers], denyServers: [...initial.denyServers] }));
  return <Modal title="技能适用范围" size="compact" onClose={onClose}><div className={styles.scopeDialog}><ApplicabilityFields value={value} onChange={setValue} /><footer><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => onSave(value)}>{busy ? "保存中" : "保存"}</Button></footer></div></Modal>;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未完成";
}

function relativeFilePath(file: File) {
  const withPath = file as File & { webkitRelativePath?: string };
  const segments = (withPath.webkitRelativePath || file.name).split("/");
  return (withPath.webkitRelativePath ? segments.slice(1) : segments).join("/") || file.name;
}

function readEntryFile(entry: DirectoryEntry) {
  return new Promise<File>((resolve, reject) => {
    if (!entry.file) { reject(new Error("无法读取拖入的文件")); return; }
    entry.file(resolve, reject);
  });
}

async function readDirectoryEntries(entry: DirectoryEntry) {
  const reader = entry.createReader?.();
  if (!reader) return [];
  const entries: DirectoryEntry[] = [];
  while (true) {
    const batch = await new Promise<DirectoryEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

async function packageFilesFromEntry(entry: DirectoryEntry, prefix = ""): Promise<PackageFile[]> {
  const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    return [{ path: entryPath || file.name, content: await file.text() }];
  }
  if (!entry.isDirectory) return [];
  const children = await readDirectoryEntries(entry);
  return (await Promise.all(children.map((child) => packageFilesFromEntry(child, entryPath)))).flat();
}

async function packageFilesFromTransfer(transfer: DataTransfer) {
  const entries = [...transfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => DirectoryEntry | null }).webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is DirectoryEntry => entry !== null);
  if (entries.length) {
    const groups = await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory) return packageFilesFromEntry(entry);
      const children = await readDirectoryEntries(entry);
      return (await Promise.all(children.map((child) => packageFilesFromEntry(child)))).flat();
    }));
    return groups.flat();
  }
  return Promise.all([...transfer.files].map(async (file) => ({ path: relativeFilePath(file), content: await file.text() })));
}

function tabForSource(source: DetailSource): SkillTab {
  return source === "market" ? "market" : source === "upload" ? "uploads" : "installed";
}

function primaryContent(detail: SkillDetail) {
  const exact = detail.files.find((file) => file.path === detail.primaryFile && file.content !== null);
  const skillDoc = detail.files.find((file) => /(^|\/)SKILL\.md$/i.test(file.path) && file.content !== null);
  const readme = detail.files.find((file) => /(^|\/)README(?:\.[^/]+)?$/i.test(file.path) && file.content !== null);
  return exact ?? skillDoc ?? readme ?? detail.files.find((file) => file.content !== null) ?? null;
}

function statusCopy(status: ReviewStatus) {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已拒绝";
  return "待审核";
}

function SkillsHeader({ count }: { count: number | null }) {
  return <header className={styles.pageHeader}>
    <div className={styles.titleLine}>
      <span className={styles.titleIcon}><Sparkles size={19} /></span>
      <h1>技能</h1>
      {count !== null ? <span>{count}</span> : null}
    </div>
  </header>;
}

function PrimaryTabs({ active, onChange }: { active: SkillTab; onChange: (tab: SkillTab) => void }) {
  return <nav className={styles.primaryTabs} aria-label="技能分类">
    {tabs.map((tab) => <button key={tab.id} className={active === tab.id ? styles.activeTab : ""} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </nav>;
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className={styles.searchField}>
    <Search size={16} />
    <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
  </label>;
}

function EmptyState({ tab, authenticated }: { tab: SkillTab; authenticated: boolean }) {
  const copy = tab === "market"
    ? ["市场里还没有技能", "管理员审核通过后，技能会出现在这里。"]
    : tab === "uploads"
      ? authenticated
        ? ["还没有上传记录", "上传技能后，可以在这里查看审核状态。"]
        : ["登录后管理上传", "注册或登录账号后即可上传技能。"]
      : ["还没有安装技能", "从市场安装后，网页 Agent 才能按需读取它。"];
  const Icon = tab === "market" ? Store : tab === "uploads" ? UploadCloud : PackageCheck;
  return <section className={styles.emptyState}><Icon size={28} /><strong>{copy[0]}</strong><span>{copy[1]}</span></section>;
}

function SkillCards({ items, source, authenticated, admin, busy, onOpen, onInstall, onEdit, onDelete, onUninstall }: {
  items: SkillSummary[];
  source: "installed" | "market";
  authenticated: boolean;
  admin: boolean;
  busy: string | null;
  onOpen: (item: SkillSummary) => void;
  onInstall: (item: SkillSummary) => void;
  onEdit: (item: SkillSummary) => void;
  onDelete: (item: SkillSummary) => void;
  onUninstall: (item: SkillSummary) => void;
}) {
  return <div className={styles.skillGrid}>{items.map((item) => {
    const installing = source === "market" && busy === item.id && !item.installed;
    return <article className={styles.skillCard} key={item.id}>
    <button className={styles.skillOpen} onClick={() => onOpen(item)}>
      <span className={`${styles.skillIcon} ${source === "market" ? styles.marketIcon : ""}`}>{source === "market" ? <Store size={19} /> : <Sparkles size={19} />}</span>
      <span className={styles.skillCopy}><span className={styles.skillNameLine}><strong>{item.name}</strong><span className={styles.skillScope}><SlidersHorizontal size={11} />{applicabilityLabel(item.applicability)}</span></span><small>{item.description || "暂无简介"}</small></span>
    </button>
    <div className={styles.skillActions}>
      {source === "market" ? <>
        <Button compact className={`${styles.skillAction} ${styles.installAction}`} disabled={!authenticated || item.installed || busy !== null} aria-busy={installing} icon={installing ? <LoaderCircle className={styles.spin} size={14} /> : item.installed ? <Check size={14} /> : <Plus size={14} />} onClick={() => onInstall(item)}>{installing ? "安装中" : item.installed ? "已安装" : authenticated ? "安装" : "登录后安装"}</Button>
        {admin ? <><Button compact className={styles.skillAction} disabled={busy !== null} icon={<Pencil size={14} />} onClick={() => onEdit(item)}>编辑</Button><Button compact className={`${styles.skillAction} ${styles.deleteAction}`} disabled={busy !== null} icon={<Trash2 size={14} />} onClick={() => onDelete(item)}>删除</Button></> : null}
      </> : <Button compact className={`${styles.skillAction} ${styles.uninstallAction}`} disabled={busy !== null} icon={<PackageMinus size={14} />} onClick={() => onUninstall(item)}>卸载</Button>}
    </div>
  </article>})}</div>;
}

function StatusBadge({ status }: { status: ReviewStatus }) {
  const Icon = status === "approved" ? CheckCircle2 : status === "rejected" ? XCircle : Clock3;
  return <span className={`${styles.statusBadge} ${styles[status]}`}><Icon size={14} />{statusCopy(status)}</span>;
}

function UserUploadTable({ items, onOpen }: { items: UploadSummary[]; onOpen: (item: UploadSummary) => void }) {
  return <section className={styles.table} aria-label="上传记录">
    <div className={`${styles.tableHeader} ${styles.userColumns}`}><span>技能名称</span><span>审核状态</span><span>更新时间</span></div>
    <div className={styles.tableBody}>{items.map((item) => <div className={`${styles.tableRow} ${styles.userColumns}`} key={item.id}>
      <button className={styles.nameButton} onClick={() => onOpen(item)}><FileCode2 size={17} /><span><strong>{item.name}</strong><small>{item.description || "暂无简介"}</small></span></button>
      <StatusBadge status={item.status} />
      <time>{formatDate(item.updatedAt)}</time>
    </div>)}</div>
  </section>;
}

function AdminUploadTable({ items, busy, onOpen, onReview }: {
  items: UploadSummary[];
  busy: string | null;
  onOpen: (item: UploadSummary) => void;
  onReview: (item: UploadSummary, decision: "approve" | "reject") => void;
}) {
  return <section className={styles.table} aria-label="技能审核">
    <div className={`${styles.tableHeader} ${styles.adminColumns}`}><span>技能名称</span><span>上传时间</span><span>审核</span></div>
    <div className={styles.tableBody}>{items.map((item) => <div className={`${styles.tableRow} ${styles.adminColumns}`} key={item.id}>
      <button className={styles.nameButton} onClick={() => onOpen(item)}><FileCode2 size={17} /><span><strong>{item.name}</strong><small>{item.description || `上传用户 ${item.uploaderId}`}</small></span></button>
      <time>{formatDate(item.submittedAt)}</time>
      {item.status === "pending" ? <span className={styles.reviewActions}>
        <Button compact variant="primary" disabled={busy === item.id} icon={<Check size={14} />} onClick={() => onReview(item, "approve")}>通过</Button>
        <Button compact variant="danger" disabled={busy === item.id} icon={<X size={14} />} onClick={() => onReview(item, "reject")}>拒绝</Button>
      </span> : <StatusBadge status={item.status} />}
    </div>)}</div>
  </section>;
}

function UploadPanel({ onUploaded, authenticated }: { onUploaded: () => Promise<void>; authenticated: boolean }) {
  const runtime = useAppRuntime();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<PackageFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);

  const acceptFiles = (loaded: PackageFile[]) => {
    if (!loaded.length) {
      runtime.notify("没有读取到可上传的文件", "error");
      return;
    }
    const merged = [...new Map([...files, ...loaded].map((file) => [file.path, file])).values()];
    const metadata = readSkillMetadata(merged);
    setFiles(merged);
    if (metadata.name) setName(metadata.name);
    if (metadata.description) setDescription(metadata.description);
  };

  const receive = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selected = [...(input.files ?? [])];
    const loaded = await Promise.all(selected.map(async (file) => ({ path: relativeFilePath(file), content: await file.text() })));
    acceptFiles(loaded);
    input.value = "";
  };

  const receiveTransfer = async (transfer: DataTransfer) => {
    if (!authenticated || reading) return;
    setReading(true);
    try { acceptFiles(await packageFilesFromTransfer(transfer)); }
    catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setReading(false); }
  };

  const pasteFiles = (event: ReactClipboardEvent<HTMLElement>) => {
    if (![...event.clipboardData.items].some((item) => item.kind === "file")) return;
    event.preventDefault();
    void receiveTransfer(event.clipboardData);
  };

  const dropFiles = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void receiveTransfer(event.dataTransfer);
  };

  const submit = async () => {
    if (!authenticated) {
      runtime.notify("请先登录后再上传技能", "error");
      return;
    }
    setBusy(true);
    try {
      await runtime.api.post("/api/skill-center/uploads", { name: name.trim(), description: description.trim(), files }, { idempotencyKey: commandId("skill-submit") });
      runtime.notify("技能已提交审核", "success");
      setName("");
      setDescription("");
      setFiles([]);
      await onUploaded();
    } catch (reason) {
      runtime.notify(errorMessage(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  return <section className={styles.uploadPanel} onPaste={pasteFiles}>
    <div className={styles.uploadIntro}><span className={styles.uploadIcon}><UploadCloud size={21} /></span><span><strong>上传技能</strong><small>拖入技能文件夹或多个文件，也可以按 Ctrl+V 粘贴文件。</small></span></div>
    <div
      className={`${styles.dropZone} ${dragging ? styles.dropZoneActive : ""} ${!authenticated ? styles.dropZoneDisabled : ""}`}
      role="group"
      tabIndex={authenticated ? 0 : -1}
      aria-label="拖放或粘贴技能文件"
      onDragEnter={(event) => { event.preventDefault(); if (authenticated) setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={dropFiles}
    >
      <span className={styles.dropIcon}>{reading ? <LoaderCircle className={styles.spin} size={20} /> : <UploadCloud size={20} />}</span>
      <span className={styles.dropCopy}><strong>{reading ? "正在读取文件" : files.length ? `已选择 ${files.length} 个文件` : "拖放技能文件到这里"}</strong><small>{files.length ? `${files.slice(0, 4).map((file) => file.path).join(" · ")}${files.length > 4 ? " …" : ""}` : "支持文件夹、多个文件和 Ctrl+V 粘贴"}</small></span>
      <span className={styles.dropActions}>
        {files.length ? <Button type="button" compact variant="ghost" disabled={reading} onClick={() => setFiles([])}>清空</Button> : null}
        <Button type="button" compact disabled={!authenticated || reading} onClick={() => fileInput.current?.click()}>选择文件</Button>
      </span>
      <input ref={fileInput} className={styles.hiddenInput} type="file" multiple onChange={(event) => void receive(event)} />
    </div>
    <div className={styles.uploadFields}>
      <label><span>技能名称</span><input value={name} disabled={!authenticated} placeholder="输入技能名称" onChange={(event) => setName(event.target.value)} /></label>
      <label className={styles.descriptionField}><span>简介</span><textarea value={description} disabled={!authenticated} placeholder="简要说明这个技能能做什么" onChange={(event) => setDescription(event.target.value)} /></label>
    </div>
    <div className={styles.uploadFooter}>
      {!authenticated ? <span>当前为访客，请登录后上传。</span> : null}
      <Button variant="primary" disabled={!authenticated || !name.trim() || files.length === 0 || busy || reading} icon={busy ? <LoaderCircle className={styles.spin} size={16} /> : <Upload size={16} />} onClick={() => void submit()}>{busy ? "提交中" : "提交审核"}</Button>
    </div>
  </section>;
}

function EditMarketForm({ item, busy, onCancel, onSave }: {
  item: SkillDetail;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, description: string, fileUpdates: PackageFile[]) => void;
}) {
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const editableFiles = item.files.filter((file) => /\.md$/i.test(file.path) && !file.binary && !file.truncated && file.content !== null);
  const [activePath, setActivePath] = useState(editableFiles.find((file) => file.path === item.primaryFile)?.path ?? editableFiles[0]?.path ?? null);
  const [contents, setContents] = useState<Record<string, string>>(() => Object.fromEntries(editableFiles.map((file) => [file.path, file.content ?? ""])));
  const activeFile = editableFiles.find((file) => file.path === activePath) ?? null;
  const fileUpdates = editableFiles.flatMap((file) => contents[file.path] === file.content ? [] : [{ path: file.path, content: contents[file.path] ?? "" }]);
  const changed = name.trim() !== item.name
    || description.trim() !== item.description
    || fileUpdates.length > 0;
  return <section className={styles.editForm}>
    <label><span>技能名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label><span>简介</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <div className={styles.markdownEdit}>
      <div className={styles.markdownEditHeader}><span>技能内容</span>{editableFiles.length > 1 ? <nav aria-label="选择要编辑的技能文件">{editableFiles.map((file) => <button key={file.path} className={file.path === activeFile?.path ? styles.activeEditFile : ""} onClick={() => setActivePath(file.path)}>{file.path}</button>)}</nav> : activeFile ? <small>{activeFile.path}</small> : null}</div>
      {activeFile ? <textarea className={styles.markdownTextarea} aria-label={`${activeFile.path} 技能内容`} spellCheck={false} value={contents[activeFile.path] ?? ""} onChange={(event) => setContents((current) => ({ ...current, [activeFile.path]: event.target.value }))} /> : <div className={styles.noEditableMarkdown}>该技能没有可直接编辑的内容。</div>}
    </div>
    <footer><Button disabled={busy} onClick={onCancel}>取消</Button><Button variant="primary" disabled={!name.trim() || !changed || busy} onClick={() => onSave(name.trim(), description.trim(), fileUpdates)}>{busy ? "保存中" : "保存"}</Button></footer>
  </section>;
}

function DetailPage({ source, id, admin, startEditing, onBack, onChanged, onEditFinished }: {
  source: DetailSource;
  id: string;
  admin: boolean;
  startEditing: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onEditFinished: () => void;
}) {
  const runtime = useAppRuntime();
  const { api, notify } = runtime;
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loadedEndpoint, setLoadedEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(source === "market" && admin && startEditing);
  const [scopeOpen, setScopeOpen] = useState(false);

  const endpoint = source === "market"
    ? `/api/skill-center/market/${encodeURIComponent(id)}`
    : source === "upload"
      ? `/api/skill-center/uploads/${encodeURIComponent(id)}`
      : `/api/skill-center/installed/${encodeURIComponent(id)}`;

  const fetchDetail = useCallback((signal?: AbortSignal) => api.get<SkillDetail>(endpoint, signal), [api, endpoint]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchDetail(signal);
    if (signal?.aborted) return;
    setDetail(result.data);
    setSelectedPath((current) => current && result.data.files.some((file) => file.path === current) ? current : result.data.primaryFile);
    setLoadedEndpoint(endpoint);
  }, [endpoint, fetchDetail]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDetail(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setDetail(result.data);
      setSelectedPath((current) => current && result.data.files.some((file) => file.path === current) ? current : result.data.primaryFile);
      setLoadedEndpoint(endpoint);
    }).catch((reason) => { if (!controller.signal.aborted) notify(errorMessage(reason), "error"); });
    return () => controller.abort();
  }, [endpoint, fetchDetail, notify]);

  const review = async (decision: "approve" | "reject") => {
    if (!detail) return;
    setBusy(decision);
    try {
      await runtime.api.post(`/api/skill-center/uploads/${encodeURIComponent(detail.id)}/review`, { decision }, { expectedRevision: detail.revision, idempotencyKey: commandId("skill-review") });
      runtime.notify(decision === "approve" ? "技能已通过并进入市场" : "技能已拒绝", "success");
      await Promise.all([load(), onChanged()]);
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusy(null); }
  };

  const saveMarketSkill = async (name: string, description: string, fileUpdates: PackageFile[]) => {
    if (!detail || source !== "market" || !admin || busy !== null) return;
    setBusy("save");
    try {
      await runtime.api.patch(`/api/skill-center/market/${encodeURIComponent(detail.id)}`, { name, description, ...(fileUpdates.length ? { fileUpdates } : {}) }, { expectedRevision: detail.revision ?? 0 });
      runtime.notify(fileUpdates.length ? "技能信息和内容已更新" : "市场信息已更新", "success");
      setEditing(false);
      onEditFinished();
      await Promise.all([load(), onChanged()]);
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusy(null); }
  };

  const saveApplicability = async (applicability: SkillApplicability) => {
    if (!detail || busy !== null) return;
    if (source !== "installed" && !(source === "market" && admin)) return;
    setBusy("scope");
    try {
      if (source === "installed") {
        const result = await runtime.api.patch<{ applicability: SkillApplicability }>(`/api/skill-center/installed/${encodeURIComponent(detail.skillId)}/applicability`, applicability);
        setDetail((current) => current?.id === detail.id ? { ...current, applicability: result.data.applicability } : current);
      } else {
        const result = await runtime.api.patch<{ item: SkillSummary }>(`/api/skill-center/market/${encodeURIComponent(detail.id)}`, { applicability }, { expectedRevision: detail.revision ?? 0 });
        const saved = result.data.item;
        // Keep the content editor mounted with its drafts; only advance saved scope and revision.
        setDetail((current) => current?.id === saved.id ? { ...current, applicability: saved.applicability, revision: saved.revision, updatedAt: saved.updatedAt } : current);
      }
      runtime.notify("技能适用范围已更新", "success");
      setScopeOpen(false);
      await onChanged();
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusy(null); }
  };

  if (loadedEndpoint !== endpoint) return <div className={styles.detailState}><LoaderCircle className={styles.spin} size={22} />正在读取技能</div>;
  if (!detail) return <div className={styles.detailState}><XCircle size={22} />技能内容不可用</div>;
  const selected = detail.files.find((file) => file.path === selectedPath) ?? primaryContent(detail);
  const displayedApplicability = detail.applicability || defaultApplicability;
  const canEditScope = source === "installed" || (source === "market" && admin);

  return <div className={styles.detailPage}>
    <header className={styles.detailHeader}>
      <Button variant="ghost" iconOnly aria-label="返回技能列表" icon={<ArrowLeft size={19} />} onClick={onBack} />
      <div className={styles.detailTitle}><span className={styles.detailIcon}><Sparkles size={19} /></span><span><h1>{detail.name}</h1><small>{detail.description || "暂无简介"}</small></span></div>
      <div className={styles.detailActions}>
        {source === "upload" && admin && detail.status === "pending" ? <><Button variant="primary" disabled={busy !== null} icon={<Check size={15} />} onClick={() => void review("approve")}>通过</Button><Button variant="danger" disabled={busy !== null} icon={<X size={15} />} onClick={() => void review("reject")}>拒绝</Button></> : null}
      </div>
    </header>

    <div className={styles.detailMeta}>{source === "upload" && detail.status ? <StatusBadge status={detail.status} /> : null}{canEditScope ? <button type="button" className={styles.scopeButton} disabled={busy !== null} onClick={() => setScopeOpen(true)}><SlidersHorizontal size={14} />{applicabilityLabel(displayedApplicability)}</button> : <span><SlidersHorizontal size={14} />{applicabilityLabel(displayedApplicability)}</span>}{source === "upload" ? <><span>上传时间 {formatDate(detail.submittedAt)}</span>{detail.reviewedAt ? <span>审核时间 {formatDate(detail.reviewedAt)}</span> : null}</> : null}</div>
    {source === "market" && admin && editing ? <EditMarketForm key={detail.id} item={detail} busy={busy !== null} onCancel={() => { setEditing(false); onEditFinished(); }} onSave={(name, description, fileUpdates) => void saveMarketSkill(name, description, fileUpdates)} /> : null}

    {source === "market" && admin && editing ? null : <div className={styles.detailLayout}>
      {detail.files.length > 1 ? <aside className={styles.fileList} aria-label="技能文件">
        <div className={styles.fileListTitle}><span>文件</span><small>{detail.files.length}</small></div>
        {detail.files.map((file) => <button key={file.path} className={selected?.path === file.path ? styles.activeFile : ""} onClick={() => setSelectedPath(file.path)}>
          <FileText size={15} /><span>{file.path}</span><small>{formatSize(file.size)}</small>
        </button>)}
      </aside> : null}
      <article className={styles.document}>
        <div className={styles.documentHeading}><span>{selected?.path || detail.entrypoint}</span>{selected?.truncated ? <small>仅显示部分内容</small> : null}</div>
        {selected?.binary ? <div className={styles.binaryState}>二进制文件无法直接预览</div> : selected?.content !== null && selected?.content !== undefined
          ? /\.md$/i.test(selected.path) ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown> : <pre><code>{selected.content}</code></pre>
          : <div className={styles.binaryState}>此文件没有可预览内容</div>}
      </article>
    </div>}
    {scopeOpen ? <ApplicabilityDialog initial={displayedApplicability} busy={busy === "scope"} onClose={() => { if (busy !== "scope") setScopeOpen(false); }} onSave={(value) => void saveApplicability(value)} /> : null}
  </div>;
}

export default function SkillsView() {
  const runtime = useAppRuntime();
  const { api, notify } = runtime;
  const view = runtime.view.kind === "skills" ? runtime.view : { kind: "skills" as const };
  const activeTab: SkillTab = view.tab || (view.detailSource ? tabForSource(view.detailSource) : "installed");
  const admin = runtime.bootstrap?.actor.roles.includes("admin") === true;
  const authenticated = runtime.bootstrap?.actor.type === "user";
  const cacheKey = `${runtime.bootstrap?.actor.id || "unresolved"}:${admin ? "admin" : "member"}`;
  const initialCache = skillsPageCache.get(cacheKey);
  const reviewTab: ReviewTab = view.reviewTab || "pending";
  const [installed, setInstalled] = useState<SkillSummary[]>(() => initialCache?.installed || []);
  const [market, setMarket] = useState<SkillSummary[]>(() => initialCache?.market || []);
  const [uploads, setUploads] = useState<UploadSummary[]>(() => initialCache?.uploads || []);
  const [loadedListKeys, setLoadedListKeys] = useState<Set<string>>(() => new Set(initialCache?.loadedListKeys || []));
  const [query, setQuery] = useState("");
  const [busyReview, setBusyReview] = useState<string | null>(null);
  const [busyMarket, setBusyMarket] = useState<string | null>(null);
  const [editingMarket, setEditingMarket] = useState<SkillSummary | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: "delete" | "uninstall"; item: SkillSummary } | null>(null);
  const [showUploader, setShowUploader] = useState(false);
  const listKeyFor = useCallback((tab: SkillTab) => `${authenticated ? "user" : "guest"}:${admin ? "admin" : "member"}:${tab}${tab === "uploads" ? `:${reviewTab}` : ""}`, [admin, authenticated, reviewTab]);
  const activeListKey = listKeyFor(activeTab);

  const loadTab = useCallback(async (tab: SkillTab, signal?: AbortSignal) => {
    const key = listKeyFor(tab);
    try {
      if (tab === "installed") {
        const result = await api.get<ListResult<SkillSummary>>("/api/skill-center/installed", signal);
        if (!signal?.aborted) setInstalled(result.data.items);
      } else if (tab === "market") {
        const result = await api.get<ListResult<SkillSummary>>("/api/skill-center/market", signal);
        if (!signal?.aborted) setMarket(result.data.items);
      } else if (authenticated) {
        const status = admin ? reviewTab : undefined;
        const result = await api.get<ListResult<UploadSummary>>(`/api/skill-center/uploads${status ? `?status=${status}` : ""}`, signal);
        if (!signal?.aborted) setUploads(result.data.items);
      } else if (!signal?.aborted) {
        setUploads([]);
      }
      if (!signal?.aborted) setLoadedListKeys((current) => new Set(current).add(key));
    } catch (reason) {
      if (!signal?.aborted) notify(errorMessage(reason), "error");
    }
  }, [admin, api, authenticated, listKeyFor, notify, reviewTab]);

  const invalidateTab = useCallback((tab: SkillTab) => {
    const key = listKeyFor(tab);
    setLoadedListKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, [listKeyFor]);

  useEffect(() => {
    if (loadedListKeys.has(activeListKey)) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => loadTab(activeTab, controller.signal));
    return () => controller.abort();
  }, [activeListKey, activeTab, loadTab, loadedListKeys]);

  useEffect(() => {
    skillsPageCache.set(cacheKey, { installed, market, uploads, loadedListKeys: [...loadedListKeys] });
  }, [cacheKey, installed, loadedListKeys, market, uploads]);

  const navigateTab = (tab: SkillTab) => {
    setQuery("");
    setEditingMarket(null);
    runtime.navigate({ kind: "skills", tab, ...(tab === "uploads" && admin ? { reviewTab } : {}) });
  };
  const openDetail = (source: DetailSource, item: SkillSummary) => runtime.navigate({ kind: "skills", tab: tabForSource(source), detailSource: source, detailId: source === "installed" ? item.skillId : item.id, ...(source === "upload" && admin ? { reviewTab } : {}) });
  const editMarketSkill = (item: SkillSummary) => {
    setEditingMarket(item);
    openDetail("market", item);
  };
  const back = () => {
    setEditingMarket(null);
    runtime.navigate({ kind: "skills", tab: activeTab, ...(activeTab === "uploads" && admin ? { reviewTab } : {}) });
  };
  const changeReviewTab = (tab: ReviewTab) => runtime.navigate({ kind: "skills", tab: "uploads", reviewTab: tab });

  const review = async (item: UploadSummary, decision: "approve" | "reject") => {
    setBusyReview(item.id);
    try {
      await runtime.api.post(`/api/skill-center/uploads/${encodeURIComponent(item.id)}/review`, { decision }, { expectedRevision: item.revision, idempotencyKey: commandId("skill-review") });
      runtime.notify(decision === "approve" ? "技能已通过并进入市场" : "技能已拒绝", "success");
      setUploads((current) => current.filter((entry) => entry.id !== item.id));
      invalidateTab("market");
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusyReview(null); }
  };

  const installMarketSkill = async (item: SkillSummary) => {
    if (!authenticated) {
      runtime.notify("请先登录后再安装技能", "error");
      return;
    }
    const feedbackStartedAt = Date.now();
    setBusyMarket(item.id);
    try {
      await runtime.api.post(`/api/skill-center/market/${encodeURIComponent(item.id)}/install`, {}, { idempotencyKey: commandId("skill-install") });
      const feedbackRemaining = INSTALL_FEEDBACK_MS - (Date.now() - feedbackStartedAt);
      if (feedbackRemaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, feedbackRemaining));
      runtime.notify("技能已安装", "success");
      setMarket((current) => current.map((entry) => entry.id === item.id ? { ...entry, installed: true } : entry));
      invalidateTab("installed");
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusyMarket(null); }
  };

  const deleteMarketSkill = async (item: SkillSummary) => {
    setBusyMarket(item.id);
    try {
      await runtime.api.delete(`/api/skill-center/market/${encodeURIComponent(item.id)}`, { expectedRevision: item.revision ?? 0 });
      runtime.notify("市场技能已删除", "success");
      if (editingMarket?.id === item.id) setEditingMarket(null);
      setPendingAction(null);
      setMarket((current) => current.filter((entry) => entry.id !== item.id));
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusyMarket(null); }
  };

  const uninstallSkill = async (item: SkillSummary) => {
    setBusyMarket(item.id);
    try {
      const result = await uninstallInstalledSkill(runtime.api, item, (items: SkillSummary[]) => {
        setInstalled(items);
        const installedIds = new Set(items.map((entry) => entry.skillId));
        setMarket((current) => current.map((entry) => ({ ...entry, installed: installedIds.has(entry.skillId) })));
        setPendingAction((current) => {
          if (current?.kind !== "uninstall" || current.item.skillId !== item.skillId) return current;
          const latest = items.find((entry) => entry.skillId === item.skillId);
          return latest ? { ...current, item: latest } : current;
        });
      });
      runtime.notify("技能已卸载", "success");
      setPendingAction(null);
      setInstalled((current) => installedSkillsAfterUninstall(current, result));
      setMarket((current) => current.map((entry) => entry.skillId === item.skillId ? { ...entry, installed: false } : entry));
    } catch (reason) { runtime.notify(errorMessage(reason), "error"); }
    finally { setBusyMarket(null); }
  };

  if (view.detailId && view.detailSource) return <DetailPage key={`${view.detailSource}:${view.detailId}`} source={view.detailSource} id={view.detailId} admin={admin} startEditing={editingMarket?.id === view.detailId} onBack={back} onChanged={async () => {
    if (view.detailSource === "upload") invalidateTab("market");
    await loadTab(activeTab);
  }} onEditFinished={() => setEditingMarket(null)} />;

  const list = activeTab === "market" ? market : installed;
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = list.filter((item) => !needle || `${item.name}\n${item.description}`.toLocaleLowerCase("zh-CN").includes(needle));
  const count = activeTab === "uploads" ? uploads.length : list.length;

  return <div className={styles.page}>
    <SkillsHeader count={loadedListKeys.has(activeListKey) ? count : null} />
    <div className={styles.toolbar}>
      <PrimaryTabs active={activeTab} onChange={navigateTab} />
      {activeTab !== "uploads"
        ? <SearchField value={query} onChange={setQuery} placeholder={activeTab === "market" ? "搜索市场技能" : "搜索已安装技能"} />
        : admin ? <Button compact icon={showUploader ? <X size={15} /> : <Upload size={15} />} onClick={() => setShowUploader((visible) => !visible)}>{showUploader ? "收起上传" : "上传技能"}</Button> : null}
    </div>

    {activeTab === "uploads" && admin && showUploader ? <UploadPanel authenticated={authenticated} onUploaded={async () => { await loadTab("uploads"); setShowUploader(false); }} /> : null}
    {activeTab === "uploads" && admin ? <nav className={styles.reviewTabs} aria-label="审核分类"><button className={reviewTab === "pending" ? styles.activeReview : ""} onClick={() => changeReviewTab("pending")}>待审核</button><button className={reviewTab === "reviewed" ? styles.activeReview : ""} onClick={() => changeReviewTab("reviewed")}>已审核</button></nav> : null}
    {activeTab === "uploads" && !admin ? <UploadPanel authenticated={authenticated} onUploaded={() => loadTab("uploads")} /> : null}
    {!loadedListKeys.has(activeListKey) ? <div className={styles.centerState}><LoaderCircle className={styles.spin} size={22} />正在读取列表</div>
      : activeTab === "uploads"
        ? uploads.length
          ? admin
            ? <AdminUploadTable items={uploads} busy={busyReview} onOpen={(item) => openDetail("upload", item)} onReview={(item, decision) => void review(item, decision)} />
            : <UserUploadTable items={uploads} onOpen={(item) => openDetail("upload", item)} />
          : <EmptyState tab="uploads" authenticated={authenticated} />
        : filtered.length
          ? <SkillCards items={filtered} source={activeTab === "market" ? "market" : "installed"} authenticated={authenticated} admin={admin} busy={busyMarket} onOpen={(item) => openDetail(activeTab === "market" ? "market" : "installed", item)} onInstall={(item) => void installMarketSkill(item)} onEdit={editMarketSkill} onDelete={(item) => setPendingAction({ kind: "delete", item })} onUninstall={(item) => setPendingAction({ kind: "uninstall", item })} />
          : query ? <section className={styles.emptyState}><Search size={27} /><strong>没有匹配的技能</strong><span>换个关键词试试。</span></section> : <EmptyState tab={activeTab} authenticated={authenticated} />}
    {pendingAction ? <Modal size="compact" title={pendingAction.kind === "delete" ? "删除市场技能" : "卸载技能"} onClose={() => setPendingAction(null)}>
      <div className={styles.confirmDialog}>
        <span className={styles.confirmIcon}><AlertTriangle size={22} /></span>
        <div className={styles.confirmCopy}>
          <strong>{pendingAction.kind === "delete" ? `确定删除“${pendingAction.item.name}”？` : `确定卸载“${pendingAction.item.name}”？`}</strong>
          <p>{pendingAction.kind === "delete" ? "它将从技能市场中移除，用户已经安装的副本不会受到影响。" : "卸载后，网页 Agent 将立即无法检索或选择该技能；历史任务记录不受影响。"}</p>
        </div>
        <footer className={styles.confirmActions}>
          <Button disabled={busyMarket !== null} onClick={() => setPendingAction(null)}>取消</Button>
          <Button variant="danger" disabled={busyMarket !== null} icon={busyMarket ? <LoaderCircle className={styles.spin} size={15} /> : pendingAction.kind === "delete" ? <Trash2 size={15} /> : <PackageMinus size={15} />} onClick={() => void (pendingAction.kind === "delete" ? deleteMarketSkill(pendingAction.item) : uninstallSkill(pendingAction.item))}>{busyMarket ? "处理中" : pendingAction.kind === "delete" ? "确认删除" : "确认卸载"}</Button>
        </footer>
      </div>
    </Modal> : null}
  </div>;
}
