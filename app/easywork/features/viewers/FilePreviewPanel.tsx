"use client";

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileCode2, LoaderCircle, Pencil, RefreshCw, Save, X } from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import { fileDescriptorFromPreview, registerDefaultViewers, resolveViewer, type FileDescriptor } from "@/app/core/registry/viewers";
import { useAppRuntime } from "../../runtime/AppRuntime";
import type { FilePreviewTab } from "../../runtime/useFilePreviewTabs";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import type { OpenPreview, PreviewDescriptor } from "../workbench/types";
import { announceWorkspaceFilesChanged } from "../workspace/workspaceFileEvents";
import { ViewerActions, ViewerLoading, ViewerToolbar } from "./ViewerChrome";
import styles from "../workspace/ConversationWorkspacePreview.module.css";

registerDefaultViewers();
type Draft = { original: string; value: string; loading: boolean; saving: boolean; error: string | null };
type TabStatus = { dirty: boolean; saving: boolean };

class PreviewErrorBoundary extends Component<{ descriptor: FileDescriptor; onRetry: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className={styles.pendingViewer}>
      <ViewerToolbar descriptor={this.props.descriptor} />
      <div className={styles.previewState} role="alert"><FileCode2 size={20} /><span>{this.state.error.message || "文件查看器暂时不可用"}</span><button onClick={this.props.onRetry}><RefreshCw size={14} />重新打开</button></div>
    </div>;
  }
}

function PreviewTabPane({ tab, active, onStatus }: { tab: FilePreviewTab; active: boolean; onStatus: (id: string, status: TabStatus) => void }) {
  const { api, bootstrap, notify, updateFilePreview } = useAppRuntime();
  const [preview, setPreview] = useState<OpenPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const sourceKey = JSON.stringify(tab.source);
  const initial = useRef(tab);
  const dirty = Boolean(draft && draft.value !== draft.original);

  useEffect(() => { onStatus(tab.id, { dirty, saving: Boolean(draft?.saving) }); }, [dirty, draft?.saving, onStatus, tab.id]);
  useEffect(() => {
    let cancelled = false;
    let created: PreviewDescriptor | null = null;
    let disposed = false;
    const dispose = () => {
      if (!created || disposed) return;
      disposed = true;
      void api.delete("/api/previews/" + encodeURIComponent(created.previewId), { expectedRevision: created.revision }).catch(() => undefined);
    };
    setLoading(true); setError(null); setPreview(null);
    const source = JSON.parse(sourceKey) as FilePreviewTab["source"];
    const request = source.kind === "preview"
      ? api.get<PreviewDescriptor>("/api/previews/" + encodeURIComponent(source.previewId))
      : api.post<PreviewDescriptor>("/api/previews", { source }, { idempotencyKey: commandId("file-preview-create") });
    void request.then(async (result) => {
      if (source.kind !== "preview") created = result.data;
      if (cancelled) { dispose(); return; }
      const descriptor = fileDescriptorFromPreview({ ...result.data, name: result.data.name || initial.current.name, size: result.data.size ?? initial.current.size });
      updateFilePreview(initial.current.id, { name: descriptor.name, size: descriptor.size });
      const definition = resolveViewer(descriptor);
      if (!definition) throw new Error("没有可用的文件查看器");
      const viewer = await definition.load();
      if (cancelled) { dispose(); return; }
      setPreview({ descriptor, previewId: result.data.previewId, revision: result.data.revision, Viewer: viewer.default });
    }).catch((reason: unknown) => {
      dispose();
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开文件预览");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; dispose(); };
  }, [api, attempt, sourceKey, updateFilePreview]);

  const startEdit = async () => {
    if (!preview || draft?.loading || draft?.saving) return;
    setDraft({ original: "", value: "", loading: true, saving: false, error: null });
    try {
      const response = await api.raw("/api/previews/" + encodeURIComponent(preview.previewId) + "/content", { headers: { accept: "text/plain" } });
      if (response.headers.get("x-preview-truncated") === "1") throw new Error("文件内容未完整读取，暂时无法编辑");
      const value = await response.text();
      setDraft({ original: value, value, loading: false, saving: false, error: null });
    } catch (reason) {
      setDraft(null);
      notify(reason instanceof Error ? reason.message : "无法读取文件内容", "error");
    }
  };
  const save = async () => {
    if (!preview || !draft || draft.loading || draft.saving || tab.source.kind !== "remote") return;
    setDraft((current) => current && { ...current, saving: true, error: null });
    const source = tab.source;
    try {
      const body = new Blob([draft.value], { type: preview.descriptor.mime || "text/plain" });
      const endpoint = "/api/servers/" + encodeURIComponent(source.serverId) + "/workspaces/" + encodeURIComponent(source.workspaceId)
        + "/files/content?path=" + encodeURIComponent(source.relativePath) + "&size=" + body.size;
      await api.uploadWithProgress(endpoint, body, () => undefined, {
        method: "PUT", headers: { "content-type": preview.descriptor.mime || "text/plain" }, idempotencyKey: commandId("workspace-file-save"),
      });
      setDraft(null);
      setAttempt((value) => value + 1);
      announceWorkspaceFilesChanged({ serverId: source.serverId, workspaceId: source.workspaceId });
      notify("文件已保存", "success");
    } catch (reason) {
      setDraft((current) => current && { ...current, saving: false, error: reason instanceof Error ? reason.message : "文件保存失败" });
    }
  };
  const canEdit = tab.source.kind === "remote" && preview && ["text", "markdown", "json", "csv"].includes(preview.descriptor.kind);
  const serverId = tab.source.kind === "remote" ? tab.source.serverId : preview?.descriptor.metadata?.serverId;
  const serverName = bootstrap?.servers?.find((server) => server.id === serverId)?.name || String(preview?.descriptor.metadata?.serverName || "");
  const [discardEdit, setDiscardEdit] = useState(false);
  const editingActions = canEdit ? <>
    <Button compact variant="ghost" icon={<Pencil size={14} />} disabled={draft?.loading || draft?.saving} onClick={() => {
      if (!draft) void startEdit();
      else if (dirty) setDiscardEdit(true);
      else setDraft(null);
    }}>{draft ? "退出编辑" : "编辑"}</Button>
    {draft ? <Button compact variant="primary" icon={draft.saving ? <LoaderCircle className={styles.spin} size={14} /> : <Save size={14} />} disabled={draft.loading || draft.saving || !dirty} onClick={() => void save()}>{draft.saving ? "保存中" : "保存"}</Button> : null}
  </> : null;
  const fallback = useMemo(() => fileDescriptorFromPreview({ previewId: tab.id, name: tab.name, size: tab.size, mime: "application/octet-stream", kind: "fallback" }), [tab.id, tab.name, tab.size]);
  return <div className={styles.tabPane} hidden={!active} role="tabpanel" id={"file-pane-" + encodeURIComponent(tab.id)} aria-labelledby={"file-tab-" + encodeURIComponent(tab.id)}>
    <ViewerActions actions={editingActions} serverName={serverName}>
      {loading || error || !preview ? <div className={styles.pendingViewer}>
        <ViewerToolbar descriptor={fallback} />
        {loading ? <ViewerLoading label="正在打开文件" /> : <div className={styles.previewState}><FileCode2 size={20} /><span>{error || "文件内容不可用"}</span><button onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} />重新打开</button></div>}
      </div> : draft ? <div className={styles.pendingViewer}>
        <ViewerToolbar descriptor={preview.descriptor} copyText={draft.value} />
        <div className={styles.editor}>{draft.loading ? <ViewerLoading label="正在读取可编辑内容" /> : <textarea aria-label={"编辑 " + tab.name} spellCheck={false} value={draft.value} disabled={draft.saving} onChange={(event) => setDraft((current) => current && { ...current, value: event.target.value })} onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
        }} />}{draft.error ? <div className={styles.editorError}>{draft.error}</div> : null}</div>
      </div> : <Suspense fallback={<div className={styles.pendingViewer}><ViewerToolbar descriptor={preview.descriptor} /><ViewerLoading label="正在载入查看器" /></div>}>
        <PreviewErrorBoundary key={preview.previewId} descriptor={preview.descriptor} onRetry={() => setAttempt((value) => value + 1)}><preview.Viewer descriptor={preview.descriptor} previewId={preview.previewId} /></PreviewErrorBoundary>
      </Suspense>}
    </ViewerActions>
    {discardEdit ? <Modal title="放弃未保存的修改？" size="compact" onClose={() => setDiscardEdit(false)}><div className={styles.confirmDialog}><p>此文件的修改尚未保存。</p><footer><Button onClick={() => setDiscardEdit(false)}>继续编辑</Button><Button variant="danger" onClick={() => { setDraft(null); setDiscardEdit(false); }}>放弃修改</Button></footer></div></Modal> : null}
  </div>;
}

export default function FilePreviewPanel() {
  const runtime = useAppRuntime();
  const { filePreviewTabs: tabs, activeFilePreviewTabId: activeId, registerFilePreviewCloseHandler, closeFilePreview, hideFilePreview, notify } = runtime;
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  const [pendingClose, setPendingClose] = useState<{ ids: string[]; afterClose?: () => void } | null>(null);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const onStatus = useCallback((id: string, status: TabStatus) => setStatuses((current) => current[id]?.dirty === status.dirty && current[id]?.saving === status.saving ? current : { ...current, [id]: status }), []);
  const finishClose = useCallback((ids: string[], afterClose?: () => void) => { ids.forEach(closeFilePreview); afterClose?.(); }, [closeFilePreview]);
  const requestClose = useCallback((ids: string[], afterClose?: () => void) => {
    if (ids.some((id) => statuses[id]?.saving)) { notify("文件正在保存，请稍后再关闭", "neutral"); return; }
    if (ids.some((id) => statuses[id]?.dirty)) setPendingClose({ ids, afterClose });
    else finishClose(ids, afterClose);
  }, [finishClose, notify, statuses]);
  useEffect(() => registerFilePreviewCloseHandler((conversationId, afterClose) => {
    requestClose(tabs.filter((tab) => !conversationId || tab.conversationId === conversationId).map((tab) => tab.id), afterClose);
  }), [registerFilePreviewCloseHandler, requestClose, tabs]);
  useEffect(() => {
    if (!runtime.filePreviewVisible || !activeId) return;
    buttons.current[activeId]?.focus({ preventScroll: true });
    buttons.current[activeId]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, runtime.filePreviewVisible]);

  return <section className={styles.previewPanel} hidden={!runtime.filePreviewVisible} aria-label="文件预览" data-mobile-swipe-ignore>
    <div className={styles.tabBar} role="tablist" aria-label="已打开文件"><div className={styles.tabScroll}>
      {tabs.map((tab, index) => <div className={styles.fileTab + (tab.id === activeId ? " " + styles.activeTab : "")} key={tab.id} title={tab.source.kind === "remote" ? tab.source.relativePath : tab.name}>
        <button ref={(element) => { buttons.current[tab.id] = element; }} type="button" role="tab" id={"file-tab-" + encodeURIComponent(tab.id)} aria-controls={"file-pane-" + encodeURIComponent(tab.id)} aria-selected={tab.id === activeId} tabIndex={tab.id === activeId ? 0 : -1} className={styles.tabSelect} onClick={() => runtime.selectFilePreview(tab.id)} onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); runtime.selectFilePreview(tabs[next].id); buttons.current[tabs[next].id]?.focus();
        }}><FileCode2 size={14} /><span>{tab.name}</span>{statuses[tab.id]?.dirty ? <i data-ui-icon="" /> : null}</button>
        <button type="button" aria-label={"关闭 " + tab.name} className={styles.tabClose} disabled={statuses[tab.id]?.saving} onClick={() => requestClose([tab.id])}><X size={12} /></button>
      </div>)}
    </div></div>
    <div className={styles.previewBody}><ViewerActions onBack={hideFilePreview}>
      {tabs.map((tab) => <PreviewTabPane key={tab.id} tab={tab} active={tab.id === activeId} onStatus={onStatus} />)}
    </ViewerActions></div>
    {pendingClose ? <Modal title="放弃未保存的修改？" size="compact" onClose={() => setPendingClose(null)}><div className={styles.confirmDialog}><p>要关闭的文件包含尚未保存的修改。</p><footer><Button onClick={() => setPendingClose(null)}>继续编辑</Button><Button variant="danger" onClick={() => { finishClose(pendingClose.ids, pendingClose.afterClose); setPendingClose(null); }}>放弃修改</Button></footer></div></Modal> : null}
  </section>;
}
