export type ActorSummary = {
  id: string;
  type: "user" | "guest";
  username: string;
  displayName: string;
  avatar?: AvatarDescriptor | null;
  roles: string[];
};

export type AvatarDescriptor = {
  mime: string;
  size: number;
  sha256: string;
  url: string;
  updatedAt: string;
};

export type SessionResponse = {
  token: string;
  expiresAt: string;
  firstVisit: boolean;
  profile: { userId: string; username: string; avatar?: AvatarDescriptor | null; admin: boolean } | { guestId: string };
};

export type DeviceSummary = {
  id: string;
  firstVisit: boolean;
  lastSeenAt: string;
};

export type EntityRevision = {
  revision: number;
  updatedAt: string;
};

export type Mode = "chat" | "work";

export type ProjectSummary = EntityRevision & {
  id: string;
  name: string;
  memoryMode: "project-only" | "global";
  conversationCount: number;
  resourceCount: number;
};

export type ConversationSummary = EntityRevision & {
  id: string;
  title: string;
  mode: Mode;
  projectId: string | null;
  pinned: boolean;
  lastMessageAt: string;
  runningTaskId: string | null;
};

export type MessageAttachment = {
  resourceVersionId: string;
  name: string;
  mime: string;
  size: number;
};

export type ConversationMessage = {
  id: string;
  conversationId: string;
  branchId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  taskId: string | null;
  replyToMessageId?: string | null;
  attachments?: MessageAttachment[];
};

export type ArtifactSummary = EntityRevision & {
  id: string;
  taskId: string;
  conversationId: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  source: "host" | "remote";
  contentLocation: "host-small-file" | "remote-reference" | string;
  lifecycle: "active" | "pinned" | "deleted" | "expired";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationBranch = {
  id: string;
  parentBranchId: string | null;
  forkMessageId: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationDetail = {
  summary: Omit<ConversationSummary, "runningTaskId"> & {
    activeBranchId: string;
    rootBranchId: string;
    branchCount: number;
    messageCount: number;
  };
  branches: ConversationBranch[];
};

export type ModelProviderSummary = {
  id: string;
  name: string;
  baseUrl?: string;
  audience: "web" | "agent" | "both";
  source: "platform" | "user";
  configured: boolean;
  models?: string[];
};

export type ServerSummary = EntityRevision & {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  serverIdentity?: string | null;
  status: "connected" | "connecting" | "disconnected";
  connectionGeneration?: number;
  activeConversationCount: number;
  capabilityStatus: "unknown" | "detecting" | "ready" | "partial" | "error";
};

export type TaskStatus =
  | "queued"
  | "preparing"
  | "delivering_context"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "waiting_append"
  | "interrupting"
  | "interrupted"
  | "recovering"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskSummary = EntityRevision & {
  id: string;
  conversationId: string;
  branchId: string;
  sourceMessageId: string;
  conversationRunId: string;
  goal: string;
  route: {
    serverId: string;
    serverIdentity: string;
    workspaceId: string;
    agentId: string;
  };
  agentBindingId: string;
  status: TaskStatus;
  taskEventSequence: number;
  plan: Array<{ id: string; text: string; status: "pending" | "running" | "completed" | "failed" | "skipped" }>;
  failure: { code: string; message: string; retryable: boolean } | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type CollectionSummary = EntityRevision & {
  id: string;
  name: string;
  fileCount: number;
  readyCount: number;
  failedCount: number;
};

export type ResourceStatus = "pending" | "extracting" | "embedding" | "readable" | "ready" | "error";

export type ResourceFile = EntityRevision & {
  id: string;
  versionId: string;
  bindingId: string;
  ownerType: "collection" | "project" | "conversation";
  ownerId: string;
  name: string;
  relativePath: string;
  mime: string;
  size: number;
  status: ResourceStatus;
  error?: string;
};

export type AgentSummary = {
  agentId: "opencode" | "codex" | "claude-code" | string;
  displayName: string;
  installed: boolean;
  managed: boolean;
  source?: "managed" | "user";
  version?: string | null;
  configured?: boolean;
  model?: string | null;
  configuration?: {
    agentId: string;
    configScope?: string;
    source: "managed" | "user";
    managed: boolean;
    writable: boolean;
    inherited?: boolean;
    path?: string;
    revision: number | null;
    updatedAt?: string | null;
    fields: Array<{ key: string; label: string; type: "string" | "enum" | "number"; nativeKey: string; min?: number; max?: number; step?: number; options?: Array<{ value: string; label: string }> }>;
    values: Record<string, string>;
    reason?: string;
  } | null;
  status: "not-installed" | "ready" | "broken";
  capabilities: {
    install: "available" | "unavailable";
    update: "available" | "unavailable";
    uninstall: "available" | "unavailable";
  };
  runtimeCapabilities?: Record<"start" | "append" | "interrupt" | "resume" | "respondApproval" | "respondInput" | "compact" | "contextUsage" | "fork" | "revert", {
    availability: "available" | "unavailable";
    mode: string;
    reason?: string;
  }> | null;
};

export type WorkspaceSummary = EntityRevision & {
  id: string;
  actorId: string;
  serverIdentity: string;
  kind: "virtual" | "user";
  canonicalPath: string;
  remoteRef: string;
};

export type WorkDraftSelection = {
  serverId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  workspacePath: string | null;
};

export type WorkDraftSnapshot = {
  selection: WorkDraftSelection;
  revision: number;
  updatedAt: string | null;
  replayed?: boolean;
};

export type BootstrapResponse = {
  actor: ActorSummary;
  device: DeviceSummary;
  featureFlags: Record<string, boolean>;
  providers: ModelProviderSummary[];
  projects: ProjectSummary[];
  recentConversations: ConversationSummary[];
  conversationCursor?: string;
  servers: ServerSummary[];
  runningTasks: TaskSummary[];
};

export type Page<T> = {
  items: T[];
  nextCursor?: string;
};
