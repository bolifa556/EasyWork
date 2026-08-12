"use client";

import { Archive, FileText, GitBranch, ListTree, LoaderCircle, ServerCog, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerCapabilityProfile } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { fileDescriptorFromPreview, registerDefaultViewers, resolveViewer } from "@/app/core/registry/viewers";
import { useAppRuntime } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import styles from "./WorkbenchDrawer.module.css";
import type { OpenPreview, OpenPreviewRequest, PreviewDescriptor } from "./types";

const RemoteFilesPane = lazy(() => import("./RemoteFilesPane"));
const TerminalPane = lazy(() => import("./TerminalPane"));
const VersionPane = lazy(() => import("./VersionPane"));
const SchedulerPane = lazy(() => import("./SchedulerPane"));
const TasksPane = lazy(() => import("./TasksPane"));
const ArtifactsPane = lazy(() => import("./ArtifactsPane"));

type Props = {
  serverId: string;
  workspaceId: string;
  workspacePath: string;
  conversationId?: string;
  branchId?: string;
  onClose: () => void;
};

type Tab = "files" | "terminal" | "version" | "tasks" | "artifacts" | "scheduler";
const tabDefinitions = [
  ["files", ListTree, "文件"],
  ["terminal", SquareTerminal, "终端"],
  ["version", GitBranch, "版本"],
  ["tasks", FileText, "任务"],
  ["artifacts", Archive, "产物"],
  ["scheduler", ServerCog, "算力"],
] as const;

function tabIsAvailable(profile: ServerCapabilityProfile | null, candidate: Tab) {
  if (!profile) return false;
  if (candidate === "files") return profile.features.remoteFiles.available && profile.features.remoteFiles.list;
  if (candidate === "terminal") return profile.features.terminal.available && profile.features.terminal.pty;
  if (candidate === "version") return profile.features.versioning.available && profile.features.versioning.shadow && profile.features.versioning.isolated;
  if (candidate === "artifacts") return profile.features.artifacts.available;
  if (candidate === "scheduler") return profile.features.scheduler.available && profile.features.scheduler.type !== "none";
  return true;
}

registerDefaultViewers();

export default function WorkbenchDrawer({ serverId, workspaceId, workspacePath, conversationId, branchId, onClose }: Props) {
  const runtime = useAppRuntime();
  const [tab, setTab] = useState<Tab>("files");
  const [capabilities, setCapabilities] = useState<ServerCapabilityProfile | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRef = useRef<OpenPreview | null>(null);
  const mountedRef = useRef(true);

  const enabledTabs = useMemo(() => tabDefinitions.filter(([id]) => tabIsAvailable(capabilities, id)), [capabilities]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setCapabilities(null);
      setCapabilityError(null);
      void runtime.api.get<ServerCapabilityProfile>(`/api/servers/${encodeURIComponent(serverId)}/capabilities`, controller.signal).then(
        (result) => setCapabilities(result.data),
        (reason: Error) => { if (!controller.signal.aborted) setCapabilityError(reason.message); },
      );
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [runtime.api, serverId]);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = previewRef.current;
      if (current) void runtime.api.delete(`/api/previews/${encodeURIComponent(current.previewId)}`, { expectedRevision: current.revision }).catch(() => undefined);
    };
  }, [runtime.api]);

  const activeTab = capabilities && !tabIsAvailable(capabilities, tab)
    ? enabledTabs[0]?.[0] || tab
    : tab;

  const closePreview = useCallback(() => {
    const current = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    setPreviewError(null);
    if (current) void runtime.api.delete(`/api/previews/${encodeURIComponent(current.previewId)}`, { expectedRevision: current.revision }).catch(() => undefined);
  }, [runtime.api]);

  const openPreview = useCallback(async (request: OpenPreviewRequest) => {
    if (!capabilities?.features.preview.available) {
      setPreviewError(capabilities?.features.preview.reason || "文件预览不可用");
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const previous = previewRef.current;
      if (previous) await runtime.api.delete(`/api/previews/${encodeURIComponent(previous.previewId)}`, { expectedRevision: previous.revision }).catch(() => undefined);
      const result = await runtime.api.post<PreviewDescriptor>("/api/previews", { source: request.source }, { idempotencyKey: commandId("preview-create") });
      const data = result.data;
      if (!mountedRef.current) {
        await runtime.api.delete(`/api/previews/${encodeURIComponent(data.previewId)}`, { expectedRevision: data.revision }).catch(() => undefined);
        return;
      }
      const publicDescriptor = fileDescriptorFromPreview({
        previewId: data.previewId,
        name: data.name || request.fallbackName,
        mime: data.mime || request.fallbackMime || "application/octet-stream",
        size: Number.isFinite(data.size) ? data.size : request.fallbackSize || 0,
        kind: data.kind,
        delivery: data.delivery,
        metadata: data.metadata,
      });
      const definition = resolveViewer(publicDescriptor);
      if (!definition) throw new Error("没有可用的文件查看器");
      const loaded = await definition.load();
      const next = { descriptor: publicDescriptor, previewId: data.previewId, revision: data.revision, Viewer: loaded.default };
      previewRef.current = next;
      setPreview(next);
    } catch (reason) {
      if (mountedRef.current) setPreviewError(reason instanceof Error ? reason.message : "无法打开文件预览");
    } finally {
      if (mountedRef.current) setPreviewLoading(false);
    }
  }, [capabilities?.features.preview, runtime.api]);

  return <section className={styles.drawer} aria-label="工作台">
    <header className={styles.header}>
      <div className={styles.tabs} role="tablist" aria-label="工作台功能">{enabledTabs.map(([id, Icon, label]) => <button key={id} role="tab" aria-selected={activeTab === id} className={`${styles.tab} ${activeTab === id ? styles.active : ""}`} onClick={() => { setTab(id); setPreviewError(null); }}><Icon size={16} /><span>{label}</span></button>)}</div>
      <span className={styles.spacer} />
      <Button compact iconOnly variant="ghost" aria-label="收起工作台" icon={<X size={17} />} onClick={onClose} />
    </header>
    <div className={styles.body}>
      {!capabilities || capabilityError || enabledTabs.length === 0 ? <div className={styles.capabilityState}>{capabilityError || (capabilities ? "当前服务器没有可用的工作台能力" : <><LoaderCircle className={styles.spin} size={20} />正在检测服务器能力</>)}</div> : null}
      {capabilities ? <Suspense fallback={<div className={styles.state}><LoaderCircle className={styles.spin} size={21} />正在载入</div>}>
        {activeTab === "files" && tabIsAvailable(capabilities, "files") ? <RemoteFilesPane key={`${serverId}:${workspaceId}`} serverId={serverId} workspaceId={workspaceId} workspacePath={workspacePath} capability={capabilities.features.remoteFiles} previewAvailable={capabilities.features.preview.available} onPreview={openPreview} /> : null}
        {activeTab === "terminal" && tabIsAvailable(capabilities, "terminal") ? <TerminalPane serverId={serverId} resumeAvailable={capabilities.features.terminal.resume} cacheScope={`${conversationId || "workbench"}:${workspaceId}`} /> : null}
        {activeTab === "version" && tabIsAvailable(capabilities, "version") ? <VersionPane serverId={serverId} workspaceId={workspaceId} conversationId={conversationId} branchId={branchId} /> : null}
        {activeTab === "tasks" ? <TasksPane serverId={serverId} /> : null}
        {activeTab === "artifacts" && tabIsAvailable(capabilities, "artifacts") ? <ArtifactsPane workspaceId={workspaceId} previewAvailable={capabilities.features.preview.available} onPreview={openPreview} /> : null}
        {activeTab === "scheduler" && tabIsAvailable(capabilities, "scheduler") ? <SchedulerPane serverId={serverId} capability={capabilities.features.scheduler} /> : null}
      </Suspense> : null}
      {previewError ? <div className={styles.previewError}><span>{previewError}</span><Button compact variant="ghost" onClick={() => setPreviewError(null)}>关闭</Button></div> : null}
    </div>
    {previewLoading ? <div className={styles.previewLoading}><LoaderCircle className={styles.spin} size={22} />正在打开预览</div> : null}
    {preview ? <div className={styles.preview}>
      <div className={styles.previewClose}><Button compact variant="secondary" icon={<X size={16} />} onClick={closePreview}>关闭</Button></div>
      <Suspense fallback={<div className={styles.state}><LoaderCircle className={styles.spin} size={21} />正在载入查看器</div>}><preview.Viewer descriptor={preview.descriptor} previewId={preview.previewId} /></Suspense>
    </div> : null}
  </section>;
}
