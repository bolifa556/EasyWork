"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export type FilePreviewSource =
  | { kind: "remote"; serverId: string; workspaceId: string; relativePath: string }
  | { kind: "resource"; resourceVersionId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "preview"; previewId: string };

export type FilePreviewTab = {
  id: string;
  source: FilePreviewSource;
  conversationId?: string;
  name: string;
  size: number;
};

export type WorkspacePreviewTab = {
  id: string;
  conversationId: string;
  serverId: string;
  workspaceId: string;
  relativePath: string;
  name: string;
  size: number;
};

type CloseHandler = (conversationId?: string, afterClose?: () => void) => void;

export function useFilePreviewTabs() {
  const [state, setState] = useState<{ tabs: FilePreviewTab[]; activeId: string | null; visible: boolean }>({ tabs: [], activeId: null, visible: false });
  const { tabs: filePreviewTabs, activeId: activeFilePreviewTabId, visible: filePreviewVisible } = state;
  const closeHandler = useRef<CloseHandler | null>(null);

  const openFilePreview = useCallback((input: Omit<FilePreviewTab, "id">) => {
    const source = input.source;
    const identity = source.kind === "remote" ? [source.kind, source.serverId, source.workspaceId, source.relativePath]
      : source.kind === "resource" ? [source.kind, source.resourceVersionId]
        : source.kind === "artifact" ? [source.kind, source.artifactId]
          : [source.kind, source.previewId];
    const id = JSON.stringify([input.conversationId || "", ...identity]);
    setState((current) => ({
      tabs: current.tabs.some((entry) => entry.id === id) ? current.tabs : [...current.tabs, { ...input, id }],
      activeId: id, visible: true,
    }));
  }, []);
  const selectFilePreview = useCallback((id: string) => {
    setState((current) => current.tabs.some((tab) => tab.id === id) ? { ...current, activeId: id, visible: true } : current);
  }, []);
  const updateFilePreview = useCallback((id: string, metadata: Pick<FilePreviewTab, "name" | "size">) => {
    setState((current) => {
      if (!current.tabs.some((tab) => tab.id === id && (tab.name !== metadata.name || tab.size !== metadata.size))) return current;
      return { ...current, tabs: current.tabs.map((tab) => tab.id === id ? { ...tab, ...metadata } : tab) };
    });
  }, []);
  const hideFilePreview = useCallback(() => setState((current) => current.visible ? { ...current, visible: false } : current), []);
  const closeFilePreview = useCallback((id: string) => {
    setState((current) => {
      const index = current.tabs.findIndex((entry) => entry.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((entry) => entry.id !== id);
      const activeId = current.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : current.activeId;
      return { tabs, activeId, visible: tabs.length > 0 && current.visible };
    });
  }, []);
  const closeWorkspacePreviews = useCallback((conversationId?: string) => {
    setState((current) => {
      const tabs = conversationId ? current.tabs.filter((entry) => entry.conversationId !== conversationId) : [];
      if (tabs.length === current.tabs.length) return current;
      const activeId = tabs.some((entry) => entry.id === current.activeId) ? current.activeId : tabs.at(-1)?.id ?? null;
      return { tabs, activeId, visible: tabs.length > 0 && current.visible };
    });
  }, []);
  const registerFilePreviewCloseHandler = useCallback((handler: CloseHandler) => {
    closeHandler.current = handler;
    return () => { if (closeHandler.current === handler) closeHandler.current = null; };
  }, []);
  const requestCloseFilePreviews = useCallback((conversationId?: string, afterClose?: () => void) => {
    if (closeHandler.current) closeHandler.current(conversationId, afterClose);
    else { closeWorkspacePreviews(conversationId); afterClose?.(); }
  }, [closeWorkspacePreviews]);
  const openWorkspacePreview = useCallback((input: Omit<WorkspacePreviewTab, "id">) => {
    openFilePreview({
      conversationId: input.conversationId, name: input.name, size: input.size,
      source: { kind: "remote", serverId: input.serverId, workspaceId: input.workspaceId, relativePath: input.relativePath },
    });
  }, [openFilePreview]);
  const workspacePreviewTabs = useMemo(() => filePreviewTabs.flatMap((tab): WorkspacePreviewTab[] => tab.source.kind === "remote" && tab.conversationId
    ? [{ id: tab.id, conversationId: tab.conversationId, name: tab.name, size: tab.size, ...tab.source }]
    : []), [filePreviewTabs]);

  return useMemo(() => ({
    filePreviewTabs, activeFilePreviewTabId, filePreviewVisible,
    openFilePreview, selectFilePreview, closeFilePreview, hideFilePreview, updateFilePreview,
    registerFilePreviewCloseHandler, requestCloseFilePreviews,
    workspacePreviewTabs, activeWorkspacePreviewTabId: activeFilePreviewTabId,
    openWorkspacePreview, selectWorkspacePreview: selectFilePreview, closeWorkspacePreview: closeFilePreview, closeWorkspacePreviews,
  }), [activeFilePreviewTabId, closeFilePreview, closeWorkspacePreviews, filePreviewTabs, filePreviewVisible, hideFilePreview, openFilePreview, openWorkspacePreview, registerFilePreviewCloseHandler, requestCloseFilePreviews, selectFilePreview, updateFilePreview, workspacePreviewTabs]);
}
