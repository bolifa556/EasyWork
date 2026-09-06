"use client";

import {
  CheckCircle2,
  ChevronRight,
  FileText,
  Folder,
  FolderLock,
  FolderUp,
  Globe2,
  Link2,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  Search,
  TerminalSquare,
  TriangleAlert,
  Unlink,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Button } from "@/app/easywork/ui/Button";
import { FileDeleteButton } from "@/app/easywork/ui/FileDeleteButton";
import type { CollectionSummary, ResourceStatus } from "@/app/core/contracts";
import type { ProjectFile, ProjectPageProps } from "./types";
import styles from "./ProjectPage.module.css";

type Tab = "conversations" | "files" | "collections";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const order = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** order;
  return `${value >= 10 || order === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[order]}`;
}

function ResourceStatusLabel({ status }: { status: ResourceStatus }) {
  if (status === "ready") return <span className={`${styles.fileStatus} ${styles.ready}`}><CheckCircle2 size={14} />已就绪</span>;
  if (status === "readable") return <span className={`${styles.fileStatus} ${styles.readable}`}><FileText size={14} />可直接读取</span>;
  if (status === "error") return <span className={`${styles.fileStatus} ${styles.failed}`}><TriangleAlert size={14} />索引失败</span>;
  const label = status === "pending" ? "等待索引" : status === "extracting" ? "正在解析" : "正在索引";
  return <span className={`${styles.fileStatus} ${styles.processing}`}><LoaderCircle size={14} />{label}</span>;
}

function EmptySection({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return <div className={styles.emptySection}>{icon}<strong>{title}</strong>{action}</div>;
}

function ConversationTab({
  conversations,
  onOpen,
  onCreate,
}: {
  conversations: ProjectPageProps["conversations"];
  onOpen: ProjectPageProps["onOpenConversation"];
  onCreate: ProjectPageProps["onCreateConversation"];
}) {
  return (
    <section className={styles.sectionPanel}>
      <div className={styles.sectionActions}>
        <Button icon={<MessageSquare size={16} />} onClick={() => onCreate("chat")}>新建聊天</Button>
        <Button icon={<TerminalSquare size={16} />} onClick={() => onCreate("work")}>新建工作</Button>
      </div>
      {conversations.length ? (
        <div className={styles.conversationList}>
          {conversations.map((conversation) => (
            <button key={conversation.id} className={styles.conversationRow} onClick={() => onOpen(conversation.id)}>
              <span data-ui-icon="" className={`${styles.modeIcon} ${conversation.mode === "work" ? styles.workMode : styles.chatMode}`}>
                {conversation.mode === "work" ? <TerminalSquare size={17} /> : <MessageSquare size={17} />}
              </span>
              <span className={styles.conversationText}>
                <strong>{conversation.title}</strong>
                <small>{conversation.mode === "work" ? "工作" : "聊天"}</small>
              </span>
              <time>{formatDate(conversation.lastMessageAt)}</time>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      ) : (
        <EmptySection icon={<MessageSquare size={25} />} title="这个项目还没有对话" />
      )}
    </section>
  );
}

function FilesTab({ files, busyAction, onUpload, onRetry, onDelete, onPreview }: {
  files: ProjectFile[];
  busyAction: string | null;
  onUpload: (files: File[]) => void;
  onRetry: (fileId: string) => void;
  onDelete: ProjectPageProps["onDeleteFile"];
  onPreview: ProjectPageProps["onPreviewFile"];
}) {
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return files
      .filter((file) => !needle || file.name.toLocaleLowerCase().includes(needle) || file.relativePath.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [files, query]);
  const receive = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    if (selected.length) onUpload(selected);
    event.currentTarget.value = "";
  };

  return (
    <section className={styles.sectionPanel}>
      <div className={styles.fileToolbar}>
        <label className={styles.searchField}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目文件" /></label>
        <div className={styles.sectionActions}>
          <Button icon={busyAction === "upload" ? <LoaderCircle className={styles.spin} size={16} /> : <Upload size={16} />} disabled={Boolean(busyAction)} onClick={() => fileInput.current?.click()}>上传文件</Button>
          <Button icon={busyAction === "upload" ? <LoaderCircle className={styles.spin} size={16} /> : <FolderUp size={16} />} disabled={Boolean(busyAction)} onClick={() => folderInput.current?.click()}>上传文件夹</Button>
          <input className={styles.hiddenInput} ref={fileInput} type="file" multiple onChange={receive} />
          <input
            className={styles.hiddenInput}
            ref={(node) => { folderInput.current = node; if (node) node.setAttribute("webkitdirectory", ""); }}
            type="file"
            multiple
            onChange={receive}
          />
        </div>
      </div>
      {busyAction === "upload" ? <div className={styles.mobileUploadStatus} role="status" aria-live="polite"><span><LoaderCircle className={styles.spin} size={16} /><strong>正在上传项目文件</strong></span><small>完成后文件会自动加入项目资料</small><i data-ui-icon="" aria-hidden="true"><b /></i></div> : null}
      {visible.length ? (
        <div className={styles.projectFiles}>
          <div className={styles.fileHeader}><span>名称</span><span>更新时间</span><span>大小</span><span>索引状态</span><span className={styles.actionHeader}>操作</span></div>
          {visible.map((file) => (
            <div key={file.bindingId} className={`${styles.projectFileRow} ${file.status === "error" ? styles.fileError : ""}`}>
              <button type="button" className={styles.projectFileName} onClick={() => onPreview(file)}><FileText size={17} /><span><strong>{file.name}</strong>{file.relativePath && file.relativePath !== file.name ? <small>{file.relativePath}</small> : null}</span></button>
              <time className={styles.projectFileTime}>{formatDate(file.updatedAt)}</time>
              <span className={styles.projectFileSize}>{formatSize(file.size)}</span>
              <span className={styles.fileStatusCell}>
                <ResourceStatusLabel status={file.status} />
                {["error", "readable"].includes(file.status) ? <Button compact variant="ghost" icon={<RotateCcw size={14} />} disabled={Boolean(busyAction)} onClick={() => onRetry(file.id)}>{file.status === "readable" ? "向量化" : "重试"}</Button> : null}
              </span>
              <FileDeleteButton
                path={file.relativePath}
                disabled={Boolean(busyAction)}
                onDelete={() => onDelete(file)}
              />
              {file.status === "error" && file.error ? <span className={styles.fileErrorReason}>{file.error}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptySection
          icon={<FileText size={25} />}
          title={query ? "没有匹配的文件" : "这个项目还没有文件"}
          action={!query ? <Button variant="ghost" icon={<Upload size={16} />} onClick={() => fileInput.current?.click()}>上传文件</Button> : undefined}
        />
      )}
    </section>
  );
}

function CollectionCard({ collection, linked, busy, onToggle }: {
  collection: CollectionSummary;
  linked: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <article className={`${styles.linkCard} ${linked ? styles.linkedCard : ""}`}>
      <span className={styles.linkFolder}><Folder size={19} /></span>
      <span className={styles.linkText}><strong>{collection.name}</strong><small>{collection.fileCount} 个文件</small></span>
      <Button
        compact
        variant={linked ? "ghost" : "secondary"}
        icon={linked ? <Unlink size={15} /> : <Link2 size={15} />}
        disabled={busy}
        onClick={onToggle}
      >{linked ? "取消关联" : "关联"}</Button>
    </article>
  );
}

function CollectionsTab({ collections, linkedIds, busyAction, onLink, onUnlink }: {
  collections: ProjectPageProps["collections"];
  linkedIds: string[];
  busyAction: string | null;
  onLink: ProjectPageProps["onLinkCollection"];
  onUnlink: ProjectPageProps["onUnlinkCollection"];
}) {
  const [query, setQuery] = useState("");
  const linkedSet = useMemo(() => new Set(linkedIds), [linkedIds]);
  const ordered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return collections
      .filter((collection) => !needle || collection.name.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(linkedSet.has(b.id)) - Number(linkedSet.has(a.id)) || a.name.localeCompare(b.name, "zh-CN"));
  }, [collections, linkedSet, query]);

  return (
    <section className={styles.sectionPanel}>
      <div className={styles.collectionLinkToolbar}>
        <span>{linkedIds.length} 个已关联</span>
        <label className={styles.searchField}><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件集" /></label>
      </div>
      {ordered.length ? (
        <div className={styles.linkGrid}>
          {ordered.map((collection) => {
            const linked = linkedSet.has(collection.id);
            return <CollectionCard key={collection.id} collection={collection} linked={linked} busy={busyAction === `collection:${collection.id}`} onToggle={() => linked ? onUnlink(collection.id) : onLink(collection.id)} />;
          })}
        </div>
      ) : (
        <EmptySection icon={<Folder size={25} />} title={query ? "没有匹配的文件集" : "文件库中还没有文件集"} />
      )}
    </section>
  );
}

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "conversations", label: "对话" },
  { id: "files", label: "文件" },
  { id: "collections", label: "关联文件集" },
];

export default function ProjectPage({
  project,
  conversations,
  files,
  collections,
  linkedCollectionIds,
  loading = false,
  busyAction = null,
  initialTab = "conversations",
  onOpenConversation,
  onCreateConversation,
  onMemoryModeChange,
  onUploadFiles,
  onRetryFile,
  onPreviewFile,
  onDeleteFile,
  onLinkCollection,
  onUnlinkCollection,
}: ProjectPageProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const count = {
    conversations: conversations.length,
    files: files.length,
    collections: linkedCollectionIds.length,
  };

  return (
    <div className={styles.page}>
      <header className={styles.projectHeader}>
        <div className={styles.projectIdentity}>
          <span data-ui-icon="" className={styles.projectMark}><Folder size={24} /></span>
          <div><h1>{project.name}</h1><span>{project.conversationCount} 个对话</span></div>
        </div>
        <div className={styles.memoryControl} aria-label="项目记忆范围">
          <button
            type="button"
            className={project.memoryMode === "project-only" ? styles.activeMemory : ""}
            disabled={busyAction === "memory"}
            onClick={() => project.memoryMode !== "project-only" && onMemoryModeChange("project-only")}
          ><FolderLock size={15} />仅项目内</button>
          <button
            type="button"
            className={project.memoryMode === "global" ? styles.activeMemory : ""}
            disabled={busyAction === "memory"}
            onClick={() => project.memoryMode !== "global" && onMemoryModeChange("global")}
          ><Globe2 size={15} />全局记忆</button>
        </div>
      </header>

      <nav className={styles.tabs} aria-label="项目内容">
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? styles.activeTab : ""} onClick={() => setTab(item.id)}>
            {item.label}<span>{count[item.id]}</span>
          </button>
        ))}
      </nav>

      {loading ? (
        <div className={styles.loading}><LoaderCircle size={21} />正在读取项目</div>
      ) : (
        <div key={tab} className={styles.tabContent}>
          {tab === "conversations" ? <ConversationTab conversations={conversations} onOpen={onOpenConversation} onCreate={onCreateConversation} /> : null}
          {tab === "files" ? <FilesTab files={files} busyAction={busyAction} onUpload={onUploadFiles} onRetry={onRetryFile} onDelete={onDeleteFile} onPreview={onPreviewFile} /> : null}
          {tab === "collections" ? <CollectionsTab collections={collections} linkedIds={linkedCollectionIds} busyAction={busyAction} onLink={onLinkCollection} onUnlink={onUnlinkCollection} /> : null}
        </div>
      )}
    </div>
  );
}
