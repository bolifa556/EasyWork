"use client";

import { Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { FileCode2, LoaderCircle, Pencil, RefreshCw, Save, X } from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import { fileDescriptorFromPreview, registerDefaultViewers, resolveViewer } from "@/app/core/registry/viewers";
import { useAppRuntime, type WorkspacePreviewTab } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import type { OpenPreview, PreviewDescriptor } from "../workbench/types";
import styles from "./ConversationWorkspacePreview.module.css";
import { announceWorkspaceFilesChanged } from "./workspaceFileEvents";

type LoadedPreview = OpenPreview & { tabId: string };
type Draft = { original: string; value: string; loading: boolean; saving: boolean; error: string | null };
type PendingClose = { kind: "tab" | "edit"; id: string } | { kind: "all"; afterClose?: () => void };
export type WorkspacePreviewHandle = { requestCloseAll: (afterClose: () => void) => void };

registerDefaultViewers();

function editable(preview?: LoadedPreview | null) {
  return Boolean(preview && ["text", "markdown", "json", "csv"].includes(preview.descriptor.kind));
}

export function ConversationWorkspacePreview({ conversationId, ref }: { conversationId: string; ref?: Ref<WorkspacePreviewHandle> }) {
  const runtime = useAppRuntime();
  const tabs = useMemo(() => runtime.workspacePreviewTabs.filter((entry) => entry.conversationId === conversationId), [conversationId, runtime.workspacePreviewTabs]);
  const activeId = tabs.some((entry) => entry.id === runtime.activeWorkspacePreviewTabId)
    ? runtime.activeWorkspacePreviewTabId
    : tabs.at(-1)?.id || null;
  const activeTab = tabs.find((entry) => entry.id === activeId) || null;
  const [loaded, setLoaded] = useState<Record<string, LoadedPreview>>({});
  const loadedRef = useRef<Record<string, LoadedPreview>>({});
  const loadingRef = useRef(new Set<string>());
  const [loadingTabs, setLoadingTabs] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  useEffect(() => { loadedRef.current = loaded; }, [loaded]);

  const disposePreview = useCallback((preview?: LoadedPreview | null) => {
    if (!preview) return;
    void runtime.api.delete(`/api/previews/${encodeURIComponent(preview.previewId)}`, { expectedRevision: preview.revision }).catch(() => undefined);
  }, [runtime.api]);

  const createPreview = useCallback(async (tab: WorkspacePreviewTab) => {
    if (loadingRef.current.has(tab.id) || loadedRef.current[tab.id]) return;
    loadingRef.current.add(tab.id);
    setLoadingTabs((current) => new Set(current).add(tab.id));
    setErrors((current) => { const next = { ...current }; delete next[tab.id]; return next; });
    try {
      const result = await runtime.api.post<PreviewDescriptor>("/api/previews", {
        source: { kind: "remote", serverId: tab.serverId, workspaceId: tab.workspaceId, relativePath: tab.relativePath },
      }, { idempotencyKey: commandId("workspace-preview-create") });
      const data = result.data;
      if (!runtime.workspacePreviewTabs.some((entry) => entry.id === tab.id)) {
        await runtime.api.delete(`/api/previews/${encodeURIComponent(data.previewId)}`, { expectedRevision: data.revision }).catch(() => undefined);
        return;
      }
      const descriptor = fileDescriptorFromPreview({
        previewId: data.previewId,
        name: data.name || tab.name,
        mime: data.mime || "application/octet-stream",
        size: Number.isFinite(data.size) ? data.size : tab.size,
        kind: data.kind,
        delivery: data.delivery,
        metadata: data.metadata,
      });
      const definition = resolveViewer(descriptor);
      if (!definition) throw new Error("没有可用的文件查看器");
      const viewer = await definition.load();
      const next = { tabId: tab.id, descriptor, previewId: data.previewId, revision: data.revision, Viewer: viewer.default };
      loadedRef.current = { ...loadedRef.current, [tab.id]: next };
      setLoaded((current) => ({ ...current, [tab.id]: next }));
    } catch (reason) {
      setErrors((current) => ({ ...current, [tab.id]: reason instanceof Error ? reason.message : "无法打开文件预览" }));
    } finally {
      loadingRef.current.delete(tab.id);
      setLoadingTabs((current) => { const next = new Set(current); next.delete(tab.id); return next; });
    }
  }, [runtime.api, runtime.workspacePreviewTabs]);

  useEffect(() => {
    const ids = new Set(tabs.map((entry) => entry.id));
    for (const [id, preview] of Object.entries(loadedRef.current)) {
      if (ids.has(id)) continue;
      disposePreview(preview);
      delete loadedRef.current[id];
      setLoaded((current) => { const next = { ...current }; delete next[id]; return next; });
      setDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
    }
    for (const tab of tabs) if (!loadedRef.current[tab.id]) void createPreview(tab);
  }, [createPreview, disposePreview, tabs]);

  useEffect(() => () => {
    for (const preview of Object.values(loadedRef.current)) disposePreview(preview);
    loadedRef.current = {};
  }, [disposePreview]);

  const activePreview = activeId ? loaded[activeId] || null : null;
  const activeDraft = activeId ? drafts[activeId] || null : null;

  const startEdit = async () => {
    if (!activeId || !activePreview || !editable(activePreview)) return;
    if (activeDraft) {
      requestClose({ kind: "edit", id: activeId });
      return;
    }
    setDrafts((current) => ({ ...current, [activeId]: { original: "", value: "", loading: true, saving: false, error: null } }));
    try {
      const response = await runtime.api.raw(`/api/previews/${encodeURIComponent(activePreview.previewId)}/content`, { method: "GET", headers: { accept: "text/plain" } });
      const value = await response.text();
      setDrafts((current) => ({ ...current, [activeId]: { original: value, value, loading: false, saving: false, error: null } }));
    } catch (reason) {
      setDrafts((current) => ({ ...current, [activeId]: { original: "", value: "", loading: false, saving: false, error: reason instanceof Error ? reason.message : "无法读取文件内容" } }));
    }
  };

  const save = async () => {
    if (!activeId || !activeTab || !activePreview || !activeDraft || activeDraft.loading || activeDraft.saving) return;
    setDrafts((current) => ({ ...current, [activeId]: { ...current[activeId], saving: true, error: null } }));
    try {
      const body = new Blob([activeDraft.value], { type: activePreview.descriptor.mime || "text/plain" });
      const endpoint = `/api/servers/${encodeURIComponent(activeTab.serverId)}/workspaces/${encodeURIComponent(activeTab.workspaceId)}/files/content?path=${encodeURIComponent(activeTab.relativePath)}&size=${body.size}`;
      await runtime.api.uploadWithProgress(endpoint, body, () => undefined, {
        method: "PUT",
        headers: { "content-type": activePreview.descriptor.mime || "text/plain" },
        idempotencyKey: commandId("workspace-file-save"),
      });
      disposePreview(activePreview);
      delete loadedRef.current[activeId];
      setLoaded((current) => { const next = { ...current }; delete next[activeId]; return next; });
      setDrafts((current) => { const next = { ...current }; delete next[activeId]; return next; });
      runtime.openWorkspacePreview({ ...activeTab, size: body.size });
      runtime.notify("文件已保存", "success");
      announceWorkspaceFilesChanged({ serverId: activeTab.serverId, workspaceId: activeTab.workspaceId });
      void createPreview({ ...activeTab, size: body.size });
    } catch (reason) {
      setDrafts((current) => ({ ...current, [activeId]: { ...current[activeId], saving: false, error: reason instanceof Error ? reason.message : "文件保存失败" } }));
    }
  };

  const isDirty = useCallback((id: string) => Boolean(drafts[id] && drafts[id].value !== drafts[id].original), [drafts]);
  const performClose = (request: PendingClose) => {
    if (request.kind === "tab") runtime.closeWorkspacePreview(request.id);
    else if (request.kind === "edit") setDrafts((current) => { const next = { ...current }; delete next[request.id]; return next; });
    else {
      runtime.closeWorkspacePreviews(conversationId);
      request.afterClose?.();
    }
    setPendingClose(null);
  };
  const requestClose = (request: PendingClose) => {
    const dirty = request.kind === "all" ? tabs.some((entry) => isDirty(entry.id)) : isDirty(request.id);
    if (dirty) setPendingClose(request); else performClose(request);
  };

  useImperativeHandle(ref, () => ({
    requestCloseAll: (afterClose) => requestClose({ kind: "all", afterClose }),
  }));

  if (!tabs.length) return null;

  return <section className={styles.previewPanel} aria-label="工作目录文件预览">
    <div className={styles.tabBar} role="tablist" aria-label="已打开文件">
      <div className={styles.tabScroll}>{tabs.map((tab) => <div className={`${styles.fileTab} ${tab.id === activeId ? styles.activeTab : ""}`} key={tab.id} title={tab.relativePath}>
        <button type="button" role="tab" aria-selected={tab.id === activeId} className={styles.tabSelect} onClick={() => runtime.selectWorkspacePreview(tab.id)}><FileCode2 size={14} /><span>{tab.name}</span>{isDirty(tab.id) ? <i /> : null}</button>
        <button type="button" aria-label={`关闭 ${tab.name}`} className={styles.tabClose} onClick={() => requestClose({ kind: "tab", id: tab.id })}><X size={12} /></button>
      </div>)}</div>
      <span className={styles.tabSpacer} />
      {editable(activePreview) ? <Button compact variant={activeDraft ? "secondary" : "ghost"} icon={<Pencil size={14} />} disabled={!activePreview || activeDraft?.loading || activeDraft?.saving} onClick={() => void startEdit()}>{activeDraft ? "退出编辑" : "编辑"}</Button> : null}
      {activeDraft ? <Button compact variant="primary" icon={activeDraft.saving ? <LoaderCircle className={styles.spin} size={14} /> : <Save size={14} />} disabled={activeDraft.loading || activeDraft.saving || activeDraft.value === activeDraft.original} onClick={() => void save()}>{activeDraft.saving ? "保存中" : "保存"}</Button> : null}
      <Button compact iconOnly variant="ghost" aria-label="关闭文件预览并返回对话" icon={<X size={17} />} onClick={() => requestClose({ kind: "all" })} />
    </div>
    <div className={styles.previewBody}>
      {!activeId || loadingTabs.has(activeId) && !activePreview ? <div className={styles.previewState}><LoaderCircle className={styles.spin} size={20} />正在打开文件</div> : errors[activeId] && !activePreview ? <div className={styles.previewState}><FileCode2 size={20} /><span>{errors[activeId]}</span>{activeTab ? <button onClick={() => void createPreview(activeTab)}><RefreshCw size={14} />重新打开</button> : null}</div> : activePreview ? activeDraft ? <div className={styles.editor}>
        {activeDraft.loading ? <div className={styles.previewState}><LoaderCircle className={styles.spin} size={19} />正在读取可编辑内容</div> : <textarea aria-label={`编辑 ${activeTab?.name || "文件"}`} spellCheck={false} value={activeDraft.value} onChange={(event) => setDrafts((current) => ({ ...current, [activeId]: { ...current[activeId], value: event.target.value } }))} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") { event.preventDefault(); void save(); } }} />}
        {activeDraft.error ? <div className={styles.editorError}>{activeDraft.error}</div> : null}
      </div> : <Suspense fallback={<div className={styles.previewState}><LoaderCircle className={styles.spin} size={20} />正在载入查看器</div>}><activePreview.Viewer descriptor={activePreview.descriptor} previewId={activePreview.previewId} /></Suspense> : null}
    </div>
    {pendingClose ? <Modal title="放弃未保存的修改？" size="compact" onClose={() => setPendingClose(null)}><div className={styles.confirmDialog}><p>{pendingClose.kind === "all" ? "返回对话后，所有尚未保存到远程服务器的修改都会丢失。" : "此文件在网页中的修改尚未保存到远程服务器。"}</p><footer><Button onClick={() => setPendingClose(null)}>继续编辑</Button><Button variant="danger" onClick={() => performClose(pendingClose)}>放弃修改</Button></footer></div></Modal> : null}
  </section>;
}
