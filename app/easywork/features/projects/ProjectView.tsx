"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CollectionSummary, ConversationSummary, ProjectSummary, ResourceStatus } from "@/app/core/contracts";
import { uploadResource } from "@/app/core/gateway/resource-upload";
import { useAppRuntime } from "@/app/easywork/runtime/AppRuntime";
import ProjectPage from "./ProjectPage";
import type { ProjectFile } from "./types";

type ProjectRecord = {
  id: string;
  name: string;
  revision: number;
  memoryMode: "project-only" | "global";
  collectionIds: string[];
  updatedAt: string;
};

type CollectionRecord = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
};

type ConversationRecord = {
  id: string;
  revision: number;
  mode: "chat" | "work";
  title: string;
  projectId: string | null;
  pinned: boolean;
  lastMessageAt: string;
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
  binding: { path: string | null };
};

type ResourceListItem = {
  binding: { id: string; ownerType: "collection" | "project" | "conversation"; ownerId: string; path: string | null };
  version: ResourceVersionRecord;
  blob: { size: number };
  size: number;
};

type ResourceListResult = { items: ResourceListItem[]; revision: number; nextCursor: string | null };

function statusOf(version: ResourceVersionRecord): ResourceStatus {
  if (version.parseStatus === "failed" || version.embeddingStatus === "failed") return "error";
  if (version.parseStatus === "ready" && version.embeddingStatus === "ready") return "ready";
  if (version.parseStatus === "ready") return "embedding";
  return "extracting";
}

function projectSummary(record: ProjectRecord, conversationCount: number, resourceCount: number): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    revision: record.revision,
    updatedAt: record.updatedAt,
    memoryMode: record.memoryMode,
    conversationCount,
    resourceCount,
  };
}

function collectionSummary(record: CollectionRecord): CollectionSummary {
  return { ...record, fileCount: 0, readyCount: 0, failedCount: 0 };
}

function conversationSummary(record: ConversationRecord): ConversationSummary {
  return { ...record, runningTaskId: null };
}

function fileFrom(result: ResourceWriteResult): ProjectFile {
  return {
    id: result.version.id,
    name: result.version.filename,
    relativePath: result.binding.path || result.version.filename,
    size: result.blob.size,
    updatedAt: result.version.updatedAt,
    status: statusOf(result.version),
    error: result.version.parseError || result.version.embeddingError || undefined,
  };
}

function fileFromList(item: ResourceListItem): ProjectFile {
  return {
    id: item.version.id,
    name: item.version.filename,
    relativePath: item.binding.path || item.version.filename,
    size: item.size,
    updatedAt: item.version.updatedAt,
    status: statusOf(item.version),
    error: item.version.parseError || item.version.embeddingError || undefined,
  };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未完成";
}

export type ProjectViewProps = { projectId: string };

export default function ProjectView({ projectId }: ProjectViewProps) {
  const { api, bootstrap, navigate, notify } = useAppRuntime();
  const [record, setRecord] = useState<ProjectRecord | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const resourceRevision = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [projectResult, conversationResult, collectionResult, resourceResult] = await Promise.all([
        api.get<ProjectRecord>(`/api/projects/${encodeURIComponent(projectId)}`, signal),
        api.get<{ items: ConversationRecord[] }>(`/api/conversations?projectId=${encodeURIComponent(projectId)}&limit=100`, signal),
        api.get<CollectionRecord[]>("/api/collections", signal),
        api.get<ResourceListResult>(`/api/resources?ownerType=project&ownerId=${encodeURIComponent(projectId)}&limit=1000`, signal),
      ]);
      setRecord(projectResult.data);
      setConversations(conversationResult.data.items.map(conversationSummary));
      setCollections(collectionResult.data.map(collectionSummary));
      resourceRevision.current = resourceResult.data.revision;
      setFiles(resourceResult.data.items.map(fileFromList));
    } catch (reason) {
      if (!signal?.aborted) notify(errorMessage(reason), "error");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, notify, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal);
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  const bootstrapProject = bootstrap?.projects.find((project) => project.id === projectId);
  const project = record
    ? projectSummary(record, conversations.length, files.length)
    : bootstrapProject ?? {
      id: projectId,
      name: "正在读取项目",
      revision: 0,
      updatedAt: new Date(0).toISOString(),
      memoryMode: "project-only" as const,
      conversationCount: 0,
      resourceCount: 0,
    };

  const changeMemory = async (memoryMode: ProjectSummary["memoryMode"]) => {
    if (!record) return;
    setBusyAction("memory");
    try {
      const result = await api.patch<ProjectRecord>(`/api/projects/${encodeURIComponent(projectId)}`, { memoryMode }, { expectedRevision: record.revision });
      setRecord(result.data);
      notify("记忆范围已更新", "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
    } finally {
      setBusyAction(null);
    }
  };

  const toggleCollection = async (collectionId: string, linked: boolean) => {
    if (!record) return;
    setBusyAction(`collection:${collectionId}`);
    try {
      const path = `/api/projects/${encodeURIComponent(projectId)}/collections${linked ? `/${encodeURIComponent(collectionId)}` : ""}`;
      const result = linked
        ? await api.delete<ProjectRecord>(path, { expectedRevision: record.revision })
        : await api.post<ProjectRecord>(path, { collectionId }, { expectedRevision: record.revision });
      setRecord(result.data);
      notify(linked ? "已取消关联" : "文件集已关联", "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
    } finally {
      setBusyAction(null);
    }
  };

  const upload = async (selected: File[]) => {
    setBusyAction("upload");
    try {
      for (const file of selected) {
        const relativePath = file.webkitRelativePath || file.name;
        const result = await uploadResource<ResourceWriteResult>(api, file, {
          ownerType: "project",
          ownerId: projectId,
          path: relativePath,
          createdSequence: 0,
        }, resourceRevision.current);
        resourceRevision.current = result.data.revision;
        setFiles((current) => [...current, fileFrom(result.data)]);
      }
      notify(selected.length === 1 ? "文件已上传" : `${selected.length} 个文件已上传`, "success");
    } catch (reason) {
      notify(errorMessage(reason), "error");
    } finally {
      setBusyAction(null);
    }
  };

  const retry = async (fileId: string) => {
    setBusyAction(`retry:${fileId}`);
    try {
      const result = await api.post<{ revision: number; version: ResourceVersionRecord }>(`/api/resources/${encodeURIComponent(fileId)}/reindex`, undefined, { expectedRevision: resourceRevision.current });
      resourceRevision.current = result.data.revision;
      setFiles((current) => current.map((file) => file.id === fileId ? {
        ...file,
        updatedAt: result.data.version.updatedAt,
        status: statusOf(result.data.version),
        error: result.data.version.parseError || result.data.version.embeddingError || undefined,
      } : file));
    } catch (reason) {
      notify(errorMessage(reason), "error");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <ProjectPage
      project={project}
      conversations={conversations}
      files={files}
      collections={collections}
      linkedCollectionIds={record?.collectionIds ?? []}
      loading={loading}
      busyAction={busyAction}
      onOpenConversation={(conversationId) => navigate({ kind: "conversation", conversationId })}
      onCreateConversation={(mode) => navigate({ kind: "home", projectId, mode })}
      onMemoryModeChange={changeMemory}
      onUploadFiles={upload}
      onRetryFile={retry}
      onLinkCollection={(collectionId) => toggleCollection(collectionId, false)}
      onUnlinkCollection={(collectionId) => toggleCollection(collectionId, true)}
    />
  );
}
