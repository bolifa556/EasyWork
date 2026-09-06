"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileStack } from "lucide-react";
import { commandId } from "@/app/core/gateway/client";
import { uploadResource } from "@/app/core/gateway/resource-upload";
import { deleteResourceBindings } from "@/app/core/gateway/resource-delete";
import { useAppRuntime } from "@/app/easywork/runtime/AppRuntime";
import LibraryPage from "./LibraryPage";
import type { LibraryCollection, LibraryFile, LibraryUploadFile } from "./types";
import styles from "./LibraryView.module.css";

type CollectionRecord = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
};

type ResourceVersionRecord = {
  id: string;
  filename: string;
  parseStatus: "pending" | "ready" | "failed";
  embeddingStatus: "pending" | "ready" | "failed";
  parseError: string | null;
  embeddingError: string | null;
  updatedAt: string;
};

type ResourceWriteResult = {
  revision: number;
  blob: { size: number };
  version: ResourceVersionRecord;
  binding: { id: string; path: string | null };
};

type ResourceListItem = {
  binding: { id: string; ownerType: "collection" | "project" | "conversation"; ownerId: string; path: string | null };
  version: ResourceVersionRecord;
  blob: { size: number };
  size: number;
};

type ResourceListResult = { items: ResourceListItem[]; revision: number; nextCursor: string | null };

function collectionSummary(record: CollectionRecord, files: LibraryFile[]): LibraryCollection {
  return {
    id: record.id,
    name: record.name,
    revision: record.revision,
    updatedAt: record.updatedAt,
    fileCount: files.length,
    readyCount: files.filter((file) => ["ready", "readable"].includes(file.status)).length,
    failedCount: files.filter((file) => file.status === "error").length,
  };
}

function resourceStatus(version: ResourceVersionRecord): LibraryFile["status"] {
  if (version.parseStatus === "failed") return "error";
  if (version.parseStatus === "ready" && version.embeddingStatus === "ready") return "ready";
  if (version.parseStatus === "ready" && version.embeddingStatus === "failed") return "readable";
  if (version.parseStatus === "ready") return "embedding";
  return "extracting";
}

function resourceFile(result: ResourceWriteResult): LibraryFile {
  return {
    id: result.version.id,
    bindingId: result.binding.id,
    name: result.version.filename,
    relativePath: result.binding.path || result.version.filename,
    size: result.blob.size,
    updatedAt: result.version.updatedAt,
    status: resourceStatus(result.version),
    error: result.version.parseError || result.version.embeddingError || undefined,
  };
}

function listedResourceFile(item: ResourceListItem): LibraryFile {
  return {
    id: item.version.id,
    bindingId: item.binding.id,
    name: item.version.filename,
    relativePath: item.binding.path || item.version.filename,
    size: item.size,
    updatedAt: item.version.updatedAt,
    status: resourceStatus(item.version),
    error: item.version.parseError || item.version.embeddingError || undefined,
  };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未完成";
}

type LibraryPageCache = {
  records: CollectionRecord[];
  filesByCollection: Record<string, LibraryFile[]>;
  resourceRevision: number;
};
const libraryPageCache = new Map<string, LibraryPageCache>();

export type LibraryViewProps = { collectionId?: string };

export default function LibraryView({ collectionId }: LibraryViewProps) {
  const runtime = useAppRuntime();
  const { api, navigate, notify, openFilePreview, closeFilePreview, filePreviewTabs } = runtime;
  const enabled = runtime.bootstrap?.featureFlags.resources === true;
  const cacheKey = runtime.bootstrap?.actor.id || "unresolved";
  const initialCache = libraryPageCache.get(cacheKey);
  const [records, setRecords] = useState<CollectionRecord[]>(() => initialCache?.records || []);
  const [filesByCollection, setFilesByCollection] = useState<Record<string, LibraryFile[]>>(() => initialCache?.filesByCollection || {});
  const [loading, setLoading] = useState(() => !initialCache);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const resourceRevision = useRef(initialCache?.resourceRevision || 0);

  const loadCollections = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) { setLoading(false); return; }
    setLoading(true);
    try {
      const [collectionResult, resourceResult] = await Promise.all([
        api.get<CollectionRecord[]>("/api/collections", signal),
        api.get<ResourceListResult>("/api/resources?ownerType=collection&limit=1000", signal),
      ]);
      const grouped: Record<string, LibraryFile[]> = {};
      for (const item of resourceResult.data.items) {
        const file = listedResourceFile(item);
        if (item.binding.ownerType !== "collection") continue;
        grouped[item.binding.ownerId] = [...(grouped[item.binding.ownerId] ?? []), file];
      }
      resourceRevision.current = resourceResult.data.revision;
      setRecords(collectionResult.data);
      setFilesByCollection(grouped);
    } catch (reason) {
      if (!signal?.aborted) notify(errorMessage(reason), "error");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, enabled, notify]);

  useEffect(() => {
    if (libraryPageCache.has(cacheKey)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadCollections(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [cacheKey, loadCollections]);

  useEffect(() => {
    if (!loading && enabled) libraryPageCache.set(cacheKey, { records, filesByCollection, resourceRevision: resourceRevision.current });
  }, [cacheKey, enabled, filesByCollection, loading, records]);

  const collections = records.map((record) => collectionSummary(record, filesByCollection[record.id] ?? []));

  const createCollection = async (name: string) => {
    setBusyAction("collection");
    try {
      const result = await api.post<CollectionRecord>("/api/collections", { name });
      setRecords((current) => [result.data, ...current]);
      notify("文件集已创建", "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
      throw reason;
    } finally {
      setBusyAction(null);
    }
  };

  const renameCollection = async (id: string, name: string) => {
    const current = records.find((record) => record.id === id);
    if (!current) return;
    setBusyAction("collection");
    try {
      const result = await api.patch<CollectionRecord>(`/api/collections/${encodeURIComponent(id)}`, { name }, { expectedRevision: current.revision });
      setRecords((items) => items.map((item) => item.id === id ? result.data : item));
      notify("名称已更新", "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
      throw reason;
    } finally {
      setBusyAction(null);
    }
  };

  const deleteCollection = async (id: string) => {
    const current = records.find((record) => record.id === id);
    if (!current) return;
    setBusyAction("collection");
    try {
      await api.delete(`/api/collections/${encodeURIComponent(id)}`, {
        expectedRevision: current.revision,
        idempotencyKey: commandId("collection-delete"),
      });
      setRecords((items) => items.filter((item) => item.id !== id));
      setFilesByCollection((items) => { const next = { ...items }; delete next[id]; return next; });
      if (collectionId === id) navigate({ kind: "library" }, { replace: true });
      await loadCollections();
      notify("文件集已删除", "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
      throw reason;
    } finally {
      setBusyAction(null);
    }
  };

  const uploadFiles = async (id: string, directory: string, selected: LibraryUploadFile[]) => {
    setBusyAction("upload");
    try {
      for (const item of selected) {
        const relativePath = [directory, item.relativePath].filter(Boolean).join("/");
        const file = item.file;
        const result = await uploadResource<ResourceWriteResult>(api, file, {
          ownerType: "collection",
          ownerId: id,
          path: relativePath,
          createdSequence: 0,
        }, resourceRevision.current);
        resourceRevision.current = result.data.revision;
        const nextFile = resourceFile(result.data);
        setFilesByCollection((current) => ({ ...current, [id]: [...(current[id] ?? []), nextFile] }));
      }
      notify(selected.length === 1 ? "文件已上传" : `${selected.length} 个文件已上传`, "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
      await loadCollections();
    } finally {
      setBusyAction(null);
    }
  };

  const deleteFiles = async (id: string, selected: LibraryFile[]) => {
    if (busyAction || !selected.length) return;
    setBusyAction("delete");
    try {
      await deleteResourceBindings(api, { type: "collection", id }, selected.map((file) => file.bindingId), (bindingId, revision) => {
        resourceRevision.current = revision;
        setFilesByCollection((current) => ({ ...current, [id]: (current[id] ?? []).filter((file) => file.bindingId !== bindingId) }));
        const deletedId = selected.find((file) => file.bindingId === bindingId)?.id;
        filePreviewTabs.filter((tab) => tab.source.kind === "resource" && tab.source.resourceVersionId === deletedId).forEach((tab) => closeFilePreview(tab.id));
      });
      notify(selected.length === 1 ? "文件已删除" : `${selected.length} 个文件已删除`, "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
      throw reason;
    } finally {
      setBusyAction(null);
    }
  };

  const retryIndex = async (id: string, fileId: string) => {
    setBusyAction(`retry:${fileId}`);
    try {
      const result = await api.post<{ revision: number; version: ResourceVersionRecord }>(`/api/resources/${encodeURIComponent(fileId)}/reindex`, undefined, { expectedRevision: resourceRevision.current });
      resourceRevision.current = result.data.revision;
      setFilesByCollection((current) => ({
        ...current,
        [id]: (current[id] ?? []).map((file) => file.id === fileId ? {
          ...file,
          updatedAt: result.data.version.updatedAt,
          status: resourceStatus(result.data.version),
          error: result.data.version.parseError || result.data.version.embeddingError || undefined,
        } : file),
      }));
    } catch (reason) {
      notify(errorMessage(reason), "error");
    } finally {
      setBusyAction(null);
    }
  };

  if (!enabled) return <div className={styles.unavailable}><FileStack size={29} /><strong>文件库暂时不可用</strong></div>;

  return <>
    <LibraryPage
      collections={collections}
      selectedCollectionId={collectionId ?? null}
      files={collectionId ? filesByCollection[collectionId] ?? [] : []}
      loading={loading}
      busyAction={busyAction}
      onSelectCollection={(id) => navigate(id ? { kind: "library", collectionId: id } : { kind: "library" })}
      onCreateCollection={createCollection}
      onRenameCollection={renameCollection}
      onDeleteCollection={deleteCollection}
      onDeleteFiles={deleteFiles}
      onUploadFiles={uploadFiles}
      onUploadError={(message) => notify(message, "error")}
      onRetryIndex={retryIndex}
      onPreviewFile={(file) => openFilePreview({ name: file.name, size: file.size, source: { kind: "resource", resourceVersionId: file.id } })}
    />
  </>;
}
