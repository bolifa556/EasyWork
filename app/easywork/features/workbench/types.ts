import type { ComponentType } from "react";
import type { FileDescriptor, ViewerProps } from "@/app/core/registry/viewers";

export type RemoteEntry = {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  modifiedAt?: string | null;
  mode?: number;
};

export type PreviewDescriptor = {
  previewId: string;
  revision: number;
  kind: FileDescriptor["kind"];
  name: string;
  mime: string;
  size: number;
  metadata?: Record<string, unknown>;
  delivery?: { acceptsRange?: boolean; maxBytes?: number };
};

export type OpenPreview = {
  descriptor: FileDescriptor;
  previewId: string;
  revision: number;
  Viewer: ComponentType<ViewerProps>;
};

export type PreviewSource =
  | { kind: "remote"; serverId: string; workspaceId: string; relativePath: string }
  | { kind: "artifact"; artifactId: string };

export type OpenPreviewRequest = {
  source: PreviewSource;
  fallbackName: string;
  fallbackMime?: string;
  fallbackSize?: number;
};

export type VersionSnapshot = { exists: boolean; sha256: string | null; size: number };
export type VersionChange = { path: string; before: VersionSnapshot; after: VersionSnapshot };
export type VersionCheckpoint = {
  id: string;
  sequence: number;
  conversationId: string;
  logicalBranchId: string;
  parentCheckpointId: string | null;
  status: "retained" | "rewound";
  message: string;
  createdAt: string;
};
export type VersionBranch = {
  id: string;
  conversationId: string;
  fromCheckpointId: string | null;
  headCheckpointId: string | null;
  createdAt: string;
};
export type VersionStatus = {
  workspace: { id: string; canonicalPath: string; kind: string };
  versioned: boolean;
  versionDomainId?: string;
  revision?: number;
  headCheckpointId: string | null;
  counts: { added: number; modified: number; deleted: number };
  changes: VersionChange[];
  branches?: VersionBranch[];
  checkpoints?: VersionCheckpoint[];
};

export type ResourceBreakdown = {
  idle: number;
  allocated: number;
  mixed: number;
  unavailable: number;
  total: number;
};

export type SchedulerSummary = {
  scope: { partitionIds: string[]; label: string };
  nodes: ResourceBreakdown;
  cpuCores: ResourceBreakdown;
  accelerators: ResourceBreakdown & { unit: "device" };
  currentUserJobs: { running: number; pending: number };
  sampledAt: string;
};

export type SchedulerPartition = {
  id: string;
  name: string;
  isDefault?: boolean;
  availability?: string;
  timeLimit?: string;
  nodes?: number;
  states?: string[];
  gres?: string[];
};

export type SchedulerJob = {
  id: string;
  scheduler: string;
  owner: string;
  name: string;
  partition: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout" | "unknown";
  elapsed?: string;
  timeLeft?: string;
  nodes?: number;
  cpuCores?: number;
  locationOrReason?: string;
};

export type ArtifactSummary = {
  id: string;
  name: string;
  kind: string;
  mime?: string;
  size: number | null;
  createdAt: string;
  lifecycle: string;
  pinned?: boolean;
  taskId?: string;
  conversationId?: string;
};
