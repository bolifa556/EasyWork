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
  startedAt?: string | null;
  submittedAt?: string | null;
  endedAt?: string | null;
  expectedEndAt?: string | null;
};

export type SchedulerResourceSnapshot = {
  scheduler: string;
  partitions: SchedulerPartition[];
  summary: SchedulerSummary | null;
  sampledAt: string;
};

export type SchedulerDashboard = {
  scheduler: string;
  partitions: SchedulerPartition[];
  summary: SchedulerSummary | null;
  jobs: SchedulerJob[];
  history: SchedulerJob[];
  sampledAt: string;
};

export type SystemMonitorSnapshot = {
  kind: "standard";
  cpu: { usagePercent: number; cores: number };
  memory: { usedBytes: number; availableBytes: number; totalBytes: number; usagePercent: number };
  gpus: Array<{ index: number; name: string; utilizationPercent: number; memoryUsedBytes: number; memoryTotalBytes: number }>;
  processes: Array<{ pid: number; user: string; cpuPercent: number; memoryPercent: number; state: string; command: string }>;
  sampledAt: string;
};
