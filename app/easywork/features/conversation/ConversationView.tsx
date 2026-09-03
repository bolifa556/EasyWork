"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  Circle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  History,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Minimize2,
  RotateCcw,
  RefreshCw,
  Send,
  Server,
  Square,
  SquareTerminal,
  Terminal,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type { AgentSummary, ArtifactSummary, ConversationDetail, ConversationMessage, ConversationSummary, RealtimeEnvelope, ServerCapabilityProfile, TaskSummary, WorkDraftSelection, WorkDraftSnapshot, WorkspaceSummary } from "@/app/core/contracts";
import { GatewayError } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { uploadResource } from "@/app/core/gateway/resource-upload";
import { useAppRuntime, type ConversationPanel } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import { WebContextRing } from "../../ui/ProgressRing";
import { WebContextDialog } from "./WebContextDialog";
import { AgentConfigDialog } from "./AgentConfigDialog";
import { copyAgentConfigurationCache, mergeCachedAgentConfigurations, writeAgentConfigurationCache, type AgentConfiguration } from "./agent-configuration-cache";
import { ConversationObjectPanel } from "./ConversationObjectPanel";
import { AgentControl } from "./AgentControl";
import { ConversationConnectionDialog } from "./ConversationConnectionDialog";
import { ComposerResourceChips, ComposerResources, emptyComposerResources, type ComposerResourceSelection } from "./ComposerResources";
import { classifyConversationOutput, ConversationArtifactCards, ConversationTimeline, isDirectRemoteAppendTimeline, splitRemoteFinalPresentation } from "./ConversationTimeline";
import { referencedArtifactsForDownloadReply, stripArtifactPlaceholderLines } from "./artifact-presentation.mjs";
import { mergeConversationEvents, retainConversationEvents } from "./conversation-event-retention.mjs";
import { followConversationScroll, type ConversationScrollPosition } from "./conversation-scroll";
import { MarkdownContent } from "./MarkdownContent";
import { PENDING_USER_WORKSPACE_SELECTION, WorkspaceDialog } from "./WorkspaceDialog";
import { ConversationWorkspacePreview, type WorkspacePreviewHandle } from "../workspace/ConversationWorkspacePreview";
import styles from "./ConversationView.module.css";

type Props = { conversationId?: string; initialProjectId?: string; initialMode?: Mode; initialPanel?: ConversationPanel };
type Mode = "chat" | "work";
type ResponseDescriptor = { providerId: string; modelId: string; scope: Record<string, unknown> };
type WebContextUsage = { usedTokens: number; limitTokens: number; ratio: number };
type BranchedConversationResult = {
  conversation: ConversationSummary;
  branch: { id: string };
  workspaceRoute?: { binding: { agentId: string; workspaceId: string }; workspace?: { canonicalPath?: string } };
  nativeConversation?: { applied: boolean; reason?: string; detail?: string; nativeSessionId?: string };
};
type WebModelSelection = { providerId: string; modelId: string };
type ConversationRoute = { serverId: string; agentId: string; workspaceId: string; workspacePath?: string };
type ConversationServerBinding = { conversationId: string; serverId: string | null; connectionEnabled?: boolean };
type WorkspaceRouteSnapshot = {
  route: { revision: number };
  binding: { id: string; bindingKey: string; agentId: string; workspaceId: string; nativeSessionId: string | null };
  workspace: WorkspaceSummary;
};
type WorkspaceSwitchDescriptor = {
  id: string;
  routeRevision: number;
  requiresConfirmation: boolean;
  effects: { switchesNativeAgentSession: boolean; preservesWebConversationMemory: boolean; reusesNativeAgentSession: boolean; contextDelivery: string };
};
type RemoteDirectorySnapshot = { home: string; path: string; parent: string | null; directories: Array<{ name: string; path: string }> };
type ApprovalDecision = "approve" | "approve_session" | "reject";
type ApprovalResponder = (taskId: string, requestId: string, decision: ApprovalDecision) => Promise<void>;
type InputResponder = (taskId: string, requestId: string, answers: Record<string, string | string[]>) => Promise<void>;

function agentEventPayload(event: RealtimeEnvelope) {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {} as Record<string, unknown>;
  const nested = (payload as Record<string, unknown>).event;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : payload as Record<string, unknown>;
}

function latestWebRunEvents(events: RealtimeEnvelope[]) {
  const ordered = events
    .filter((event) => event.producer === "web-agent")
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
  let startedIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].kind === "run.started") startedIndex = index;
  }
  if (startedIndex < 0) return ordered;
  const runId = ordered[startedIndex].ids.runId;
  return ordered.slice(startedIndex).filter((event) => !runId || event.ids.runId === runId);
}

function planStepIcon(status: TaskSummary["plan"][number]["status"], size = 12) {
  if (status === "completed") return <Check size={size} />;
  if (status === "running") return <LoaderCircle className={styles.spin} size={size} />;
  if (status === "failed") return <X size={size} />;
  return <Circle size={Math.max(7, size - 3)} />;
}

function TaskPlanList({ task, className = "" }: { task: TaskSummary; className?: string }) {
  return <div className={`${styles.taskPlanList} ${className}`}>{task.plan.map((step) => {
    return <div className={styles.taskPlanStep} data-status={step.status} key={step.id}>
      <span className={styles.taskPlanStatus}>{planStepIcon(step.status)}</span><span>{step.text}</span>
    </div>;
  })}</div>;
}

function ComposerTaskPlan({ task }: { task?: TaskSummary }) {
  const [open, setOpen] = useState(false);
  if (!task?.plan?.length) return null;
  const current = task.plan.find((step) => step.status === "running")
    ?? task.plan.find((step) => step.status === "pending")
    ?? [...task.plan].reverse().find((step) => step.status === "completed")
    ?? task.plan[0];
  const currentIndex = Math.max(0, task.plan.findIndex((step) => step.id === current.id));
  return <section className={`${styles.composerPlan} ${open ? styles.composerPlanOpen : ""}`} aria-label="当前执行计划">
    <div className={styles.composerPlanExpanded}><TaskPlanList task={task} /></div>
    <button type="button" className={styles.composerPlanCurrent} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span className={styles.taskPlanStatus}>{planStepIcon(current.status, 13)}</span>
      <span className={styles.composerPlanText}>{current.text}</span>
      <small>{currentIndex + 1}/{task.plan.length}</small>
      <ChevronDown size={13} />
    </button>
  </section>;
}
type CachedConversationView = {
  messages: ConversationMessage[];
  detail: ConversationDetail;
  events: RealtimeEnvelope[];
  artifacts: ArtifactSummary[];
  tasks: Record<string, TaskSummary>;
  eventsHydrated: boolean;
  cachedAt: number;
};
type CachedServerSetup = {
  capabilities: ServerCapabilityProfile;
  agents: AgentSummary[];
  workspaces: WorkspaceSummary[];
  cachedAt: number;
  connectionGeneration?: number;
};
const VIRTUAL_WORKSPACE = "__virtual__";
const AUTOMATIC_WORKSPACE_LABEL = "由 EasyWork 自动分配";
const CONVERSATION_ROUTE_CHANGED_EVENT = "easywork:conversation-route-changed";
const WorkbenchDrawer = lazy(() => import("../workbench/WorkbenchDrawer"));
const conversationScrollPositions = new Map<string, ConversationScrollPosition>();
const conversationViewCache = new Map<string, CachedConversationView>();
const serverSetupCache = new Map<string, CachedServerSetup>();
const CONVERSATION_CACHE_TTL_MS = 30 * 60_000;
const SERVER_SETUP_PERSISTED_TTL_MS = 30 * 24 * 60 * 60_000;
const SERVER_SETUP_STORAGE_PREFIX = "easywork.server-setup:";
const WORK_DRAFT_STORAGE_PREFIX = "easywork.work-draft:";
const PENDING_SERVER_BINDING_PREFIX = "easywork.pending-server-binding:";
const AGENT_LABELS: Record<string, string> = { opencode: "OpenCode", codex: "Codex", "claude-code": "Claude Code" };

function initialWorkbenchHeight() {
  if (typeof window === "undefined") return 520;
  const stored = Number(window.localStorage.getItem("easywork.workbench-height"));
  return Math.max(260, Math.min(stored || window.innerHeight * .54, window.innerHeight - 72, 620));
}

function conversationCacheKey(actorId: string | undefined, conversationId: string | undefined) {
  return actorId && conversationId ? `${actorId}:${conversationId}` : null;
}

function serverCacheKey(actorId: string | undefined, serverId: string | undefined | null, configScope: string, server?: { serverIdentity?: string | null } | null) {
  return actorId && serverId ? `${actorId}:${serverId}:${server?.serverIdentity || "unidentified"}:${configScope}` : null;
}

function workDraftStorageKey(actorId: string | undefined, projectId: string | undefined) {
  return actorId ? `${WORK_DRAFT_STORAGE_PREFIX}${actorId}:${projectId || "standalone"}` : null;
}

function readCachedWorkDraft(actorId: string | undefined, projectId: string | undefined) {
  const key = workDraftStorageKey(actorId, projectId);
  if (!key || typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null") as { selection?: WorkDraftSelection; savedAt?: number } | null;
    if (!parsed?.selection || !Number.isFinite(parsed.savedAt) || Date.now() - Number(parsed.savedAt) > SERVER_SETUP_PERSISTED_TTL_MS) return null;
    const { serverId, agentId, workspaceId, workspacePath } = parsed.selection;
    if (![serverId, agentId, workspaceId, workspacePath].every((value) => value === null || typeof value === "string")) return null;
    return parsed.selection;
  } catch { return null; }
}

function writeCachedWorkDraft(actorId: string | undefined, projectId: string | undefined, selection: WorkDraftSelection) {
  const key = workDraftStorageKey(actorId, projectId);
  if (!key || typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify({ selection, savedAt: Date.now() })); } catch { /* the server-side draft remains authoritative */ }
}

function removeCachedWorkDraft(actorId: string | undefined, projectId: string | undefined) {
  const key = workDraftStorageKey(actorId, projectId);
  if (key && typeof window !== "undefined") localStorage.removeItem(key);
}

function readPersistedServerSetup(key: string | null) {
  if (!key || typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(`${SERVER_SETUP_STORAGE_PREFIX}${key}`) || "null") as CachedServerSetup | null;
    if (!parsed
      || !Number.isFinite(parsed.cachedAt)
      || Date.now() - parsed.cachedAt > SERVER_SETUP_PERSISTED_TTL_MS
      || !parsed.capabilities
      || !Array.isArray(parsed.agents)
      || !Array.isArray(parsed.workspaces)) return null;
    return parsed;
  } catch { return null; }
}

function rememberServerSetup(key: string | null, value: CachedServerSetup) {
  if (!key) return;
  rememberBounded(serverSetupCache, key, value, 20);
  if (typeof window === "undefined") return;
  try { localStorage.setItem(`${SERVER_SETUP_STORAGE_PREFIX}${key}`, JSON.stringify(value)); } catch { /* in-memory setup remains usable */ }
}

function workDraftConfigScope() {
  // New-work setup edits the actor's server-wide template.  Each created web
  // conversation still receives its own cloned configuration under its
  // conversation ID, so native Agent sessions remain isolated without asking
  // the user to configure the same server on every new chat.
  return "default";
}

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V, maximum: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximum) cache.delete(cache.keys().next().value as K);
}

function storedRoute(conversationId?: string): Partial<ConversationRoute> {
  if (typeof window === "undefined" || !conversationId) return {};
  const key = `easywork.conversation-route:${conversationId}`;
  try { return JSON.parse(localStorage.getItem(key) || "{}") as Partial<ConversationRoute>; }
  catch { return {}; }
}

function writeStoredRoute(conversationId: string, route: ConversationRoute) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`easywork.conversation-route:${conversationId}`, JSON.stringify(route));
  window.dispatchEvent(new CustomEvent(CONVERSATION_ROUTE_CHANGED_EVENT, {
    detail: { conversationId, route },
  }));
}

function pendingServerBinding(conversationId: string) {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(`${PENDING_SERVER_BINDING_PREFIX}${conversationId}`);
}

function markPendingServerBinding(conversationId: string, serverId: string) {
  if (typeof window !== "undefined") window.sessionStorage.setItem(`${PENDING_SERVER_BINDING_PREFIX}${conversationId}`, serverId);
}

function clearPendingServerBinding(conversationId: string, serverId: string) {
  if (typeof window === "undefined") return;
  const key = `${PENDING_SERVER_BINDING_PREFIX}${conversationId}`;
  if (window.sessionStorage.getItem(key) === serverId) window.sessionStorage.removeItem(key);
}

function agentOperationAvailable(agent: AgentSummary | undefined, operation: "append" | "interrupt" | "resume") {
  return agent?.runtimeCapabilities?.[operation]?.availability === "available";
}

function MessageAction({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return <span className={styles.messageAction} data-tooltip={label}>
    <Button compact iconOnly variant="ghost" aria-label={label} icon={icon} onClick={onClick} />
  </span>;
}

function Message({ message, latestAssistant, retryableUser = false, revision, timelineEvents, artifacts, timelineLoading = false, timelineMode, taskById, settledTaskIds, response, onApproval, onInput, onBranchCreated, onChanged }: { message: ConversationMessage; latestAssistant: boolean; retryableUser?: boolean; revision: number; timelineEvents?: RealtimeEnvelope[]; artifacts?: ArtifactSummary[]; timelineLoading?: boolean; timelineMode: Mode; taskById: Readonly<Record<string, TaskSummary>>; settledTaskIds: ReadonlySet<string>; response: () => ResponseDescriptor; onApproval?: ApprovalResponder; onInput?: InputResponder; onBranchCreated?: (result: BranchedConversationResult) => Promise<void>; onChanged: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [pendingAction, setPendingAction] = useState<"branch" | "rewind" | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionInFlight = useRef(false);
  const user = message.role === "user";
  const directRemoteAppend = !user && isDirectRemoteAppendTimeline(timelineEvents || []);
  const rawDisplayedContent = !user && timelineMode === "work" && message.taskId
    ? splitRemoteFinalPresentation(message.content).body
    : message.content;
  const displayedContent = user ? rawDisplayedContent : stripArtifactPlaceholderLines(rawDisplayedContent, artifacts || []);
  const copy = () => void navigator.clipboard.writeText(displayedContent).then(() => runtime.notify("已复制", "success"));
  const action = async (name: "retry" | "branch" | "rewind", confirmed = false) => {
    if ((name === "branch" || name === "rewind") && !confirmed) {
      setPendingAction(name);
      return;
    }
    // A destructive conversation action must have exactly one in-flight
    // command. React state is not a synchronous click lock, so use a ref to
    // prevent rapid duplicate branch, retry or rewind requests.
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionBusy(true);
    const actionBody = name === "branch"
      ? { action: name, sourceBranchId: message.branchId, atMessageId: message.id }
      : name === "rewind"
        ? { action: name, branchId: message.branchId, toMessageId: message.id }
        : { action: name, branchId: message.branchId, messageId: message.id, response: response() };
    try {
      const idempotencyKey = commandId(name);
      const submit = (expectedRevision: number) => runtime.api.post<BranchedConversationResult>(
        `/api/conversations/${message.conversationId}/actions`,
        actionBody,
        { expectedRevision, idempotencyKey },
      );
      let result;
      try {
        result = await submit(revision);
      } catch (reason) {
        if (!(reason instanceof GatewayError) || reason.code !== "REVISION_CONFLICT") throw reason;
        // Never replay a destructive action against a newer conversation
        // revision. Its target may already have changed on this or another
        // device, and replaying it could repeat destructive work.
        await onChanged();
        throw new Error("对话已在其他请求或设备中更新，已刷新到最新状态，请重新操作");
      }
      if (name === "branch" && result.data.conversation?.id && onBranchCreated) {
        const native = result.data.nativeConversation;
        if (timelineMode === "chat") runtime.notify("网页分支已创建", "success");
        else if (native?.applied) runtime.notify("网页分支与远端 Agent 原生上下文已同步分叉", "success");
        else if (native?.reason) runtime.notify("网页分支已创建；远端 Agent 将在下一轮重新建立上下文");
        else runtime.notify("网页分支已创建", "success");
        setPendingAction(null);
        await onBranchCreated(result.data);
        return;
      }
      setPendingAction(null);
      await onChanged();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "操作失败", "error");
    } finally {
      actionInFlight.current = false;
      setActionBusy(false);
    }
  };
  return <><article className={`${styles.message} ${user ? styles.user : styles.assistant}`} id={`message-${message.id}`}>
    {user ? <div className={styles.messageHead}>你 <span className={styles.dot} /></div> : directRemoteAppend ? null : <div className={styles.messageHead}><span className={styles.dot} /> EasyWork</div>}
    {!user && (timelineEvents?.length || timelineLoading) ? <ConversationTimeline events={timelineEvents || []} mode={timelineMode} taskIdHint={message.taskId || undefined} finalTextHint={displayedContent} loading={timelineLoading} taskById={taskById} settledTaskIds={settledTaskIds} onApproval={onApproval} onInput={onInput} /> : null}
    {user ? <div className={styles.userBubble}>{message.content}</div> : <><div className={styles.assistantBody}><MarkdownContent content={displayedContent} /></div><ConversationArtifactCards events={timelineEvents || []} artifacts={artifacts} /></>}
    <div className={styles.messageActions}>
      <MessageAction label={user ? "复制消息" : "复制回复"} icon={<Copy size={15} />} onClick={copy} />
      {user && retryableUser ? <MessageAction label="重新生成本轮回复" icon={<RotateCcw size={15} />} onClick={() => void action("retry")} /> : null}
      {!user ? <>{latestAssistant ? <MessageAction label="重新生成" icon={<RotateCcw size={15} />} onClick={() => void action("retry")} /> : null}<MessageAction label="从这里创建分支对话" icon={<GitBranch size={15} />} onClick={() => void action("branch")} /><MessageAction label="回溯到这里" icon={<History size={16} />} onClick={() => void action("rewind")} /></> : null}
    </div>
  </article>{pendingAction ? <Modal title={pendingAction === "branch" ? "创建分支对话？" : "回溯到这里？"} size="compact" onClose={() => { if (!actionBusy) setPendingAction(null); }}><div className={styles.modeConfirm}><p>{pendingAction === "branch"
    ? timelineMode === "chat"
      ? "会把这里之前的网页对话与记忆带到一个新的对话；两个对话之后各自记录历史。"
      : "会把这里之前的对话、记忆和已记录文件版本带到一个新的网页对话；两个对话之后各自记录历史。若需要恢复文件到分叉点，改动会作用于共享工作区，同目录下的其他 Agent 也会看到。"
    : timelineMode === "chat"
      ? "会清除这条回复之后的网页对话以及由这些消息形成的对话记忆；不会操作远端 Agent 或工作区文件。"
      : "会清除这条回复之后的对话记忆，并恢复该对话在后续回合实际修改过的文件；恢复会作用于共享工作区，未被该对话记录的文件不会扫描或改写。"}</p><footer><Button disabled={actionBusy} onClick={() => setPendingAction(null)}>取消</Button><Button variant="primary" disabled={actionBusy} icon={actionBusy ? <LoaderCircle className={styles.spin} size={14} /> : pendingAction === "branch" ? <GitBranch size={14} /> : <History size={14} />} onClick={() => void action(pendingAction, true)}>{actionBusy ? "处理中" : pendingAction === "branch" ? "创建分支" : "确认回溯"}</Button></footer></div></Modal> : null}</>;
}

function Composer({ conversationId, draftKey, disabled, placeholder, activeTask, pendingWebRun = false, canInterrupt, onInterrupt, onSend }: { conversationId?: string; draftKey: string; disabled?: boolean; placeholder: string; activeTask?: TaskSummary; pendingWebRun?: boolean; canInterrupt?: boolean; onInterrupt?: () => Promise<void>; onSend: (value: string, resources: ComposerResourceSelection, selection: WebModelSelection) => Promise<void> }) {
  const runtime = useAppRuntime();
  const storageKey = `easywork.composer-draft:${runtime.bootstrap?.actor.id ?? "unresolved"}:${draftKey}`;
  const [value, setValue] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem(storageKey) || "");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [multiline, setMultiline] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(() => typeof window === "undefined" ? null : localStorage.getItem("easywork.web-provider"));
  const [modelId, setModelId] = useState<string>(() => typeof window === "undefined" ? "" : localStorage.getItem("easywork.web-model") || "");
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [providerPage, setProviderPage] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextUsage, setContextUsage] = useState<WebContextUsage | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [resources, setResources] = useState<ComposerResourceSelection>(emptyComposerResources);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const contextRequestSerial = useRef(0);
  const provider = runtime.bootstrap?.providers.find((item) => item.id === providerId) ?? runtime.bootstrap?.providers[0];
  const model = modelId || "选择模型";
  useEffect(() => {
    if (typeof window === "undefined" || !providerId || !modelId) return;
    // Migrate the former single-value preference into a per-Provider entry.
    // This preserves the selection across bootstrap refreshes and when users
    // briefly inspect a different API before returning to the original one.
    localStorage.setItem(`easywork.web-model:${providerId}`, modelId);
  }, [modelId, providerId]);
  const inspectProvider = async (id: string) => {
    const previousProviderId = providerId ?? provider?.id ?? null;
    const switchedProvider = Boolean(previousProviderId && previousProviderId !== id);
    const cachedModel = typeof window === "undefined" ? "" : localStorage.getItem(`easywork.web-model:${id}`) || "";
    const nextModel = switchedProvider ? cachedModel : modelId;
    setProviderId(id); setModelId(nextModel); setProviderPage(true); setModels([]);
    setModelsLoading(true); setModelError(null);
    localStorage.setItem("easywork.web-provider", id);
    // Merely reopening/refreshing the selected Provider must not clear the
    // webpage Agent model. This used to look like a server connection reset
    // because the connection flow refreshes bootstrap data and users commonly
    // reopen this menu immediately afterwards.
    if (switchedProvider) {
      if (nextModel) localStorage.setItem("easywork.web-model", nextModel);
      else localStorage.removeItem("easywork.web-model");
    }
    try {
      const result = await runtime.api.post<{ models: Array<{ id: string; name: string }> }>(`/api/providers/${id}/models`, { purpose: "web" });
      setModels(result.data.models);
    } catch (reason) {
      setModelError(reason instanceof Error ? reason.message : "模型读取失败");
    } finally {
      setModelsLoading(false);
    }
  };
  const chooseModel = (id: string) => {
    setModelId(id); localStorage.setItem("easywork.web-model", id);
    const chosenProviderId = providerId ?? provider?.id;
    if (chosenProviderId) {
      localStorage.setItem("easywork.web-provider", chosenProviderId);
      localStorage.setItem(`easywork.web-model:${chosenProviderId}`, id);
    }
    setModelOpen(false); setProviderPage(false);
  };
  const refreshContextUsage = useCallback(async () => {
    const requestSerial = ++contextRequestSerial.current;
    if (!conversationId) { setContextUsage(null); setContextLoading(false); return; }
    setContextLoading(true);
    try {
      const result = await runtime.api.get<{ usage: { usedTokens: number; limitTokens: number; ratio?: number } }>(`/api/conversations/${encodeURIComponent(conversationId)}/context`);
      if (contextRequestSerial.current !== requestSerial) return;
      const usedTokens = Math.max(0, Number(result.data.usage.usedTokens) || 0);
      const limitTokens = Math.max(0, Number(result.data.usage.limitTokens) || 0);
      const receivedRatio = Number(result.data.usage.ratio);
      const ratio = Number.isFinite(receivedRatio) ? receivedRatio : limitTokens > 0 ? usedTokens / limitTokens : 0;
      setContextUsage({ usedTokens, limitTokens, ratio: Math.max(0, Math.min(1, ratio)) });
    } catch {
      if (contextRequestSerial.current === requestSerial) setContextUsage(null);
    } finally {
      if (contextRequestSerial.current === requestSerial) setContextLoading(false);
    }
  }, [conversationId, runtime.api]);
  const send = async () => {
    if (!value.trim() || busy || disabled) return;
    const prompt = value.trim();
    const pendingResources = resources;
    const previousExpanded = expanded;
    const previousMultiline = multiline;
    let cleared = false;
    setBusy(true);
    try {
      const chosenProviderId = providerId ?? provider?.id;
      if (!chosenProviderId) throw new Error("请先配置网页模型 API");
      if (!modelId) throw new Error("请先选择网页对话模型");
      setValue("");
      setResources(emptyComposerResources);
      sessionStorage.removeItem(storageKey);
      setExpanded(false);
      setMultiline(false);
      cleared = true;
      await onSend(prompt, pendingResources, { providerId: chosenProviderId, modelId });
      await refreshContextUsage();
    } catch (reason) {
      if (cleared) {
        setValue(prompt);
        setResources(pendingResources);
        setExpanded(previousExpanded);
        setMultiline(previousMultiline);
      }
      runtime.notify(reason instanceof Error ? reason.message : "消息发送失败", "error");
    } finally { setBusy(false); }
  };
  useEffect(() => {
    const handle = window.setTimeout(() => void refreshContextUsage(), 0);
    return () => window.clearTimeout(handle);
  }, [refreshContextUsage]);
  useEffect(() => {
    if (value) sessionStorage.setItem(storageKey, value);
    else sessionStorage.removeItem(storageKey);
  }, [storageKey, value]);
  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    if (expanded) {
      node.style.height = "100%";
      node.style.overflowY = "auto";
      return;
    }
    node.style.height = "30px";
    const required = node.scrollHeight;
    if (value && required > 32 && !multiline) setMultiline(true);
    node.style.height = `${multiline ? Math.min(96, Math.max(30, required)) : 30}px`;
    node.style.overflowY = required > 96 ? "auto" : "hidden";
  }, [expanded, multiline, value]);
  const hasResources = resources.files.length + resources.collections.length + resources.skills.length > 0;
  const canExpand = multiline;
  const taskRunning = Boolean(activeTask && ["queued", "preparing", "delivering_context", "running", "waiting_approval", "waiting_input", "waiting_append", "interrupting"].includes(activeTask.status));
  const hasPendingPrompt = Boolean(value.trim());
  const showStopAction = (taskRunning || pendingWebRun) && Boolean(onInterrupt) && !hasPendingPrompt;
  const stop = async () => {
    if (!onInterrupt || !canInterrupt || stopping || activeTask?.status === "interrupting") return;
    setStopping(true);
    try { await onInterrupt(); }
    finally { setStopping(false); }
  };
  return <div className={styles.composer}>
    <ComposerTaskPlan task={activeTask} />
    <div data-composer-box className={`${styles.box} ${multiline ? styles.boxMultiline : ""} ${expanded ? styles.boxExpanded : ""} ${hasResources ? styles.boxWithResources : ""} ${taskRunning ? styles.boxTaskRunning : ""}`}>
      {hasResources ? <div className={styles.resourceChips}><ComposerResourceChips value={resources} onChange={setResources} /></div> : null}
      <div className={styles.composerAdd}><ComposerResources value={resources} disabled={disabled || busy || taskRunning} onChange={setResources} /></div>
      <textarea ref={textarea} className={styles.textarea} value={value} disabled={disabled || busy} placeholder={placeholder} rows={1} onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        if (!next) { setMultiline(false); setExpanded(false); }
        else if (event.target.scrollHeight > 32) setMultiline(true);
      }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
      <button className={styles.model} aria-label="选择模型" aria-expanded={modelOpen} title={model} onClick={() => { setModelOpen((open) => !open); setProviderPage(false); }}><span className={styles.modelName}>{model}</span><WebContextRing value={contextUsage?.ratio ?? 0} used={contextUsage?.usedTokens} limit={contextUsage?.limitTokens} loading={contextLoading} /><ChevronDown size={14} /></button>
      <div className={styles.composerSendSlot}>
        {showStopAction ? <span className={styles.composerAction} data-tooltip={canInterrupt ? "终止任务" : "当前 Agent 不支持终止"}>
          <button className={`${styles.send} ${styles.stop}`} disabled={!canInterrupt || stopping || activeTask?.status === "interrupting"} aria-label="终止任务" onClick={() => void stop()}><Square size={14} fill="currentColor" /></button>
        </span> : <span className={styles.composerAction} data-tooltip={busy ? "正在发送" : "发送消息"}>
          <button className={styles.send} disabled={!value.trim() || disabled || busy} aria-label={busy ? "正在发送" : "发送消息"} onClick={() => void send()}>{busy ? <LoaderCircle className={styles.spin} size={17} /> : <Send size={17} />}</button>
        </span>}
      </div>
      {value && (expanded || canExpand) ? <Button className={styles.expand} compact iconOnly variant="ghost" aria-label={expanded ? "收回编辑器" : "展开编辑器"} icon={expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={() => setExpanded((state) => !state)} /> : null}
      {modelOpen ? <div className={styles.modelMenu}>
        <div className={styles.modelMenuHead}>{providerPage ? <Button compact iconOnly variant="ghost" aria-label="返回模型 API" icon={<ChevronLeft size={15} />} onClick={() => setProviderPage(false)} /> : null}<span>{providerPage ? provider?.name || "模型" : "选择模型"}</span>{providerPage ? <button className={styles.modelRefresh} type="button" aria-label="重新检测模型" disabled={modelsLoading || !provider} onClick={() => provider && void inspectProvider(provider.id)}><RefreshCw className={modelsLoading ? styles.spin : ""} size={14} /></button> : null}</div>
        <div className={styles.modelList}>{providerPage ? modelsLoading ? <div className={styles.modelState}><LoaderCircle className={styles.spin} size={15} />正在读取模型</div> : modelError ? <div className={styles.modelState}><span>{modelError}</span><button onClick={() => provider && void inspectProvider(provider.id)}>重新检测</button></div> : models.length ? models.map((item) => <button key={item.id} className={`${styles.modelOption} ${modelId === item.id ? styles.selected : ""}`} onClick={() => chooseModel(item.id)}><span>{item.name}</span>{modelId === item.id ? <Check size={15} /> : null}</button>) : <div className={styles.modelState}>暂无可用模型</div> : runtime.bootstrap?.providers.length ? runtime.bootstrap.providers.map((item) => <button key={item.id} disabled={!item.configured} className={`${styles.modelOption} ${styles.providerOption}`} onClick={() => void inspectProvider(item.id)}><span className={styles.providerCopy}><strong>{item.name}</strong><small>{item.configured ? item.baseUrl || "已配置" : "未配置"}</small></span><ChevronRight size={15} /></button>) : <div className={styles.modelState}>请先配置模型 API</div>}</div>
        <div className={styles.modelManage}><Button compact variant="ghost" icon={<Brain size={15} />} onClick={() => { setModelOpen(false); setContextOpen(true); }}>管理网页对话上下文配置</Button></div>
      </div> : null}
    </div>
    {contextOpen ? <WebContextDialog conversationId={conversationId} onClose={() => setContextOpen(false)} /> : null}
  </div>;
}

function ManualAgentDialog({ serverId, agents, onClose, onAdded }: { serverId: string; agents: AgentSummary[]; onClose: () => void; onAdded: (agentId: string) => Promise<void> }) {
  const runtime = useAppRuntime();
  const [agentId, setAgentId] = useState(agents[0]?.agentId || "opencode");
  const [snapshot, setSnapshot] = useState<RemoteDirectorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async (path?: string | null) => {
    setLoading(true);
    try {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const result = await runtime.api.get<RemoteDirectorySnapshot>(`/api/servers/${encodeURIComponent(serverId)}/directories${query}`);
      setSnapshot(result.data);
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "目录读取失败", "error"); }
    finally { setLoading(false); }
  }, [runtime, serverId]);
  useEffect(() => {
    const handle = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(handle);
  }, [load]);
  const submit = async () => {
    if (!snapshot || !agentId || saving) return;
    setSaving(true);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(agentId)}/register`, { root: snapshot.path }, { idempotencyKey: commandId("agent-register") });
      await onAdded(agentId);
      runtime.notify("已添加用户部署的 Agent", "success");
      onClose();
    } catch (reason) { runtime.notify(reason instanceof Error ? reason.message : "Agent 添加失败", "error"); }
    finally { setSaving(false); }
  };
  return <Modal title="手动添加 Agent" subtitle="选择 Agent 应用主目录" size="normal" panelClassName={styles.directoryDialogPanel} onClose={onClose}>
    <div className={styles.directoryPicker}>
      <label className={styles.directoryAgent}><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}</select></label>
      <div className={styles.directoryPath}><button disabled={!snapshot?.parent || loading} onClick={() => void load(snapshot?.parent)}><ChevronLeft size={16} />上一级</button><code>{snapshot?.path || "正在读取…"}</code></div>
      <div className={styles.directoryList}>{loading ? <div className={styles.directoryLoading}><LoaderCircle className={styles.spin} size={17} />正在读取文件夹</div> : snapshot?.directories.length ? snapshot.directories.map((entry) => <button key={entry.path} onClick={() => void load(entry.path)}><FolderOpen size={17} /><span>{entry.name}</span><ChevronRight size={15} /></button>) : <div className={styles.directoryEmpty}>当前文件夹没有子文件夹</div>}</div>
      <footer><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!snapshot || loading || saving} icon={saving ? <LoaderCircle className={styles.spin} size={16} /> : <Check size={16} />} onClick={() => void submit()}>{saving ? "添加中" : "选择当前文件夹"}</Button></footer>
    </div>
  </Modal>;
}

function ConversationScreen({ conversationId, initialProjectId, initialMode, initialPanel }: Props) {
  const runtime = useAppRuntime();
  const { api, notify, realtime, refreshBootstrap } = runtime;
  const actorId = runtime.bootstrap?.actor.id;
  const [draftConfigScope] = useState(workDraftConfigScope);
  const configScope = conversationId || draftConfigScope;
  const [initialRoute] = useState(() => storedRoute(conversationId));
  const [initialWorkDraft] = useState(() => conversationId ? null : readCachedWorkDraft(actorId, initialProjectId));
  const initialSetupRoute = conversationId ? initialRoute : initialWorkDraft ?? {};
  const initialConversationCacheKey = conversationCacheKey(actorId, conversationId);
  const [initialConversationCache] = useState(() => {
    if (!initialConversationCacheKey) return null;
    const cached = conversationViewCache.get(initialConversationCacheKey) ?? null;
    if (!cached || !Number.isFinite(cached.cachedAt) || Date.now() - cached.cachedAt > CONVERSATION_CACHE_TTL_MS) {
      conversationViewCache.delete(initialConversationCacheKey);
      return null;
    }
    return cached;
  });
  const initialServer = runtime.bootstrap?.servers.find((server) => server.id === initialSetupRoute.serverId);
  const initialServerCacheKey = serverCacheKey(actorId, initialSetupRoute.serverId, configScope, initialServer);
  const [initialServerCache] = useState(() => initialServerCacheKey
    ? serverSetupCache.get(initialServerCacheKey)
      ?? readPersistedServerSetup(initialServerCacheKey)
    : null);
  const [mode, setMode] = useState<Mode>(initialMode ?? "chat");
  const [workspaceDirectoryLoading, setWorkspaceDirectoryLoading] = useState(false);
  const workspaceRouteSyncPending = useRef<Map<string, Promise<WorkspaceRouteSnapshot | null>>>(new Map());
  const [messages, setMessages] = useState<ConversationMessage[]>(initialConversationCache?.messages ?? []);
  const [detail, setDetail] = useState<ConversationDetail | null>(initialConversationCache?.detail ?? null);
  const [events, setEvents] = useState<RealtimeEnvelope[]>(initialConversationCache?.events ?? []);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>(initialConversationCache?.artifacts ?? []);
  const [eventsHydrated, setEventsHydrated] = useState(!conversationId || Boolean(initialConversationCache?.eventsHydrated));
  const [tasks, setTasks] = useState<Record<string, TaskSummary>>(initialConversationCache?.tasks ?? {});
  const [loading, setLoading] = useState(Boolean(conversationId && !initialConversationCache));
  const [setupLoading, setSetupLoading] = useState(Boolean(initialSetupRoute.serverId && !initialServerCache));
  const [setupRetryRevision, setSetupRetryRevision] = useState(0);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchHeight, setWorkbenchHeight] = useState(initialWorkbenchHeight);
  const [serverId, setServerId] = useState<string | null>(initialSetupRoute.serverId ?? null);
  const [agentId, setAgentId] = useState<string | null>(initialSetupRoute.agentId ?? null);
  const [workspace, setWorkspace] = useState<string | null>(initialSetupRoute.workspaceId ?? null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(initialSetupRoute.workspacePath ?? null);
  const [agentOptions, setAgentOptions] = useState<AgentSummary[]>(() => initialServerCache?.agents
    ? mergeCachedAgentConfigurations(initialServerCache.agents, actorId, initialSetupRoute.serverId || "", configScope)
    : []);
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceSummary[]>(initialServerCache?.workspaces ?? []);
  const [installingAgent, setInstallingAgent] = useState<string | null>(null);
  const [agentConfigAgentId, setAgentConfigAgentId] = useState<string | null>(null);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [manualAgentOpen, setManualAgentOpen] = useState(false);
  const [boundServerId, setBoundServerId] = useState<string | null>(conversationId ? initialRoute.serverId ?? null : null);
  const [conversationConnectionEnabled, setConversationConnectionEnabled] = useState(true);
  const [serverBindingLoading, setServerBindingLoading] = useState(Boolean(conversationId && !initialRoute.serverId));
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [serverCapabilities, setServerCapabilities] = useState<ServerCapabilityProfile | null>(initialServerCache?.capabilities ?? null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [routeSwitchConfirmation, setRouteSwitchConfirmation] = useState<"workspace" | "agent" | null>(null);
  const routeSwitchResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const workDraftRevision = useRef(0);
  const workDraftActor = useRef<string | null>(null);
  const workDraftTouched = useRef(false);
  const workDraftWrites = useRef<Promise<void>>(Promise.resolve());
  const scroll = useRef<HTMLDivElement>(null);
  const messageContent = useRef<HTMLDivElement>(null);
  const workspacePreviewRef = useRef<WorkspacePreviewHandle>(null);
  const conversationLoadRevision = useRef(0);
  const taskReplayCursors = useRef(new Map<string, number>());
  const taskReplayRequests = useRef(new Map<string, Promise<RealtimeEnvelope[]>>());
  const taskSummaryRequests = useRef(new Map<string, Promise<TaskSummary>>());
  const messagesRef = useRef(messages);
  const tasksRef = useRef(tasks);
  const missingConversationHandled = useRef<string | null>(null);

  const latestEffortConfigurationEvent = useMemo(() => [...events].reverse().find((event) => {
    const payload = agentEventPayload(event);
    return event.kind === "job_status" && payload.operation === "agent_effort_adjusted" && payload.configuration;
  }) ?? null, [events]);
  const latestEffortConfiguration = useMemo(() => {
    if (!latestEffortConfigurationEvent) return null;
    const payload = agentEventPayload(latestEffortConfigurationEvent);
    const configuration = payload.configuration as AgentConfiguration | undefined;
    if (!configuration || typeof configuration.agentId !== "string" || !Array.isArray(configuration.fields) || !configuration.values || typeof configuration.values !== "object") return null;
    if (configuration.configScope && configuration.configScope !== configScope) return null;
    return configuration;
  }, [configScope, latestEffortConfigurationEvent]);
  useEffect(() => {
    if (!latestEffortConfiguration || !actorId || !serverId) return;
    const currentRevision = Number(agentOptions.find((agent) => agent.agentId === latestEffortConfiguration.agentId)?.configuration?.revision);
    const eventRevision = Number(latestEffortConfiguration.revision);
    if (Number.isSafeInteger(currentRevision) && Number.isSafeInteger(eventRevision) && currentRevision > eventRevision) return;
    writeAgentConfigurationCache(actorId, serverId, configScope, latestEffortConfiguration);
  }, [actorId, agentOptions, configScope, latestEffortConfiguration, serverId]);
  const effectiveAgentOptions = useMemo(() => agentOptions.map((agent) => {
    const configuration = latestEffortConfiguration?.agentId === agent.agentId
      ? latestEffortConfiguration
      : null;
    if (!configuration) return agent;
    const currentRevision = Number(agent.configuration?.revision);
    const nextRevision = Number(configuration.revision);
    if (Number.isSafeInteger(currentRevision) && Number.isSafeInteger(nextRevision) && currentRevision > nextRevision) return agent;
    return {
      ...agent,
      configuration,
      model: String(configuration.values.model || "").trim() || agent.model || null,
      configured: Boolean(agent.installed && agent.status === "ready" && (String(configuration.values.model || "").trim() || agent.model)),
    };
  }), [agentOptions, latestEffortConfiguration]);

  const recoverMissingConversation = useCallback((reason: unknown) => {
    if (!conversationId || !(reason instanceof GatewayError) || reason.code !== "CONVERSATION_NOT_FOUND") return false;
    if (missingConversationHandled.current === conversationId) return true;
    missingConversationHandled.current = conversationId;
    conversationLoadRevision.current += 1;
    const cacheKey = conversationCacheKey(actorId, conversationId);
    if (cacheKey) conversationViewCache.delete(cacheKey);
    if (typeof window !== "undefined") {
      localStorage.removeItem(`easywork.conversation-route:${conversationId}`);
      sessionStorage.removeItem(`${PENDING_SERVER_BINDING_PREFIX}${conversationId}`);
    }
    runtime.closeWorkspacePreviews(conversationId);
    runtime.navigate({ kind: "home" }, { replace: true });
    return true;
  }, [actorId, conversationId, runtime]);

  useLayoutEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => () => {
    routeSwitchResolver.current?.(false);
    routeSwitchResolver.current = null;
  }, []);

  useEffect(() => {
    if (!conversationId || typeof window === "undefined") return;
    const applyRoute = (route: Partial<ConversationRoute>) => {
      if (typeof route.serverId === "string") {
        setServerId(route.serverId);
        setBoundServerId(route.serverId);
      }
      if (typeof route.agentId === "string") setAgentId(route.agentId);
      if (typeof route.workspaceId === "string") setWorkspace(route.workspaceId);
      setWorkspacePath(typeof route.workspacePath === "string" ? route.workspacePath : null);
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string; route?: Partial<ConversationRoute> }>).detail;
      if (detail?.conversationId === conversationId && detail.route) applyRoute(detail.route);
    };
    window.addEventListener(CONVERSATION_ROUTE_CHANGED_EVENT, changed);
    applyRoute(storedRoute(conversationId));
    return () => window.removeEventListener(CONVERSATION_ROUTE_CHANGED_EVENT, changed);
  }, [conversationId]);

  const bootstrapSummary = runtime.bootstrap?.recentConversations.find((item) => item.id === conversationId);
  const bootstrapServerIdKey = (runtime.bootstrap?.servers ?? []).map((server) => server.id).sort().join("\n");
  const summary = bootstrapSummary ?? (detail ? { ...detail.summary, runningTaskId: null } : undefined);
  const activeMode = detail?.summary.mode ?? summary?.mode ?? mode;
  const loadedConversationId = detail?.summary.id;
  const liveTask = runtime.bootstrap?.runningTasks.find((task) => task.conversationId === conversationId || task.id === summary?.runningTaskId);
  const latestConversationTask = Object.values(tasks)
    .filter((task) => task.conversationId === conversationId)
    .sort((left, right) => (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt))[0];
  const activeTask = [liveTask, latestConversationTask]
    .filter((task): task is TaskSummary => Boolean(task && !["completed", "failed", "cancelled", "interrupted"].includes(task.status)))
    .sort((left, right) => {
      if (left.id === right.id) return right.revision - left.revision || right.updatedAt.localeCompare(left.updatedAt);
      return (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt);
    })[0];
  const isEmpty = !conversationId;
  const projectContextName = initialProjectId
    ? runtime.bootstrap?.projects.find((project) => project.id === initialProjectId)?.name.trim() || null
    : null;
  const selectedServer = runtime.bootstrap?.servers.find((server) => server.id === serverId);
  const currentServerCacheKey = serverCacheKey(actorId, serverId, configScope, selectedServer);
  const taskRoutedAgentId = (liveTask && liveTask.conversationId === conversationId ? liveTask.route?.agentId : null)
    ?? latestConversationTask?.route?.agentId
    ?? null;
  const taskRoutedWorkspaceId = (liveTask && liveTask.conversationId === conversationId ? liveTask.route?.workspaceId : null)
    ?? latestConversationTask?.route?.workspaceId
    ?? null;
  const routedAgentId = agentId ?? taskRoutedAgentId;
  const routedWorkspaceId = workspace && workspace !== VIRTUAL_WORKSPACE
    ? workspace
    : taskRoutedWorkspaceId ?? workspace;
  const selectedAgent = effectiveAgentOptions.find((agent) => agent.agentId === routedAgentId);
  const selectedWorkspace = workspaceOptions.find((item) => item.id === routedWorkspaceId);
  const selectedBindingTask = useMemo(() => {
    if (activeTask?.route?.agentId === routedAgentId && activeTask?.route?.workspaceId === routedWorkspaceId) return activeTask;
    const candidates = Object.values(tasks)
      .filter((task) => task.route?.agentId === routedAgentId && task.route?.workspaceId === routedWorkspaceId)
      .sort((left, right) => (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt));
    // A Task that failed during version/workspace preparation has a calculated
    // binding ID but no native Agent session. Prefer the newest Task that
    // actually started so reopening the menu reads the durable prior session.
    return candidates.find((task) => task.startedAt && task.agentBindingId) ?? candidates[0] ?? null;
  }, [activeTask, routedAgentId, routedWorkspaceId, tasks]);
  const bindingIdsByAgent = useMemo(() => {
    const result: Record<string, string> = {};
    const ordered = Object.values(tasks)
      .filter((task) => task.agentBindingId && task.route?.agentId && task.route?.workspaceId === routedWorkspaceId)
      .sort((left, right) => {
        const leftRank = !["completed", "failed", "cancelled", "interrupted"].includes(left.status) ? 2 : left.startedAt ? 1 : 0;
        const rightRank = !["completed", "failed", "cancelled", "interrupted"].includes(right.status) ? 2 : right.startedAt ? 1 : 0;
        return rightRank - leftRank || (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt);
      });
    for (const task of ordered) {
      const taskAgentId = task.route?.agentId;
      if (taskAgentId && task.agentBindingId && !result[taskAgentId]) result[taskAgentId] = task.agentBindingId;
    }
    return result;
  }, [routedWorkspaceId, tasks]);
  const selectedAgentBindingId = selectedBindingTask?.agentBindingId ?? null;
  // Status/SSE revisions can change many times during one task. Context usage
  // only needs a refresh when a binding appears or the task reaches a terminal
  // state; otherwise the Agent button visibly reloads throughout every run.
  const selectedAgentContextRevision = selectedBindingTask
    ? selectedBindingTask.completedAt ? selectedBindingTask.revision : 1
    : 0;
  const agentsAvailable = Boolean(serverCapabilities?.features.agents.available && serverCapabilities.features.agents.inspect);
  const workspacesAvailable = Boolean(serverCapabilities?.features.workspaces.available);
  const workbenchAvailable = Boolean(serverCapabilities && [
    serverCapabilities.features.terminal,
    serverCapabilities.features.scheduler,
  ].some((feature) => feature.available));
  const explicitWorkspacePath = workspacePath && workspacePath !== AUTOMATIC_WORKSPACE_LABEL ? workspacePath : null;
  const workbenchWorkspacePath = explicitWorkspacePath ?? selectedWorkspace?.canonicalPath ?? null;
  const workbenchReady = Boolean(
    conversationId
      && serverId
      && selectedServer?.status === "connected"
      && conversationConnectionEnabled
      && routedWorkspaceId
      && routedWorkspaceId !== VIRTUAL_WORKSPACE
      && workbenchWorkspacePath
      && workbenchAvailable,
  );
  const workspaceDirectoryReady = Boolean(
    conversationId
      && serverId
      && selectedServer?.status === "connected"
      && conversationConnectionEnabled
      && routedWorkspaceId
      && routedWorkspaceId !== VIRTUAL_WORKSPACE
      && workbenchWorkspacePath
      && serverCapabilities?.features.remoteFiles.available
      && serverCapabilities.features.remoteFiles.list,
  );
  const workspaceDirectoryActive = Boolean(conversationId && runtime.workspaceSidebar?.conversationId === conversationId);
  const workReady = activeMode === "chat" || Boolean(
    serverId
      && selectedServer?.status === "connected"
      && (!conversationId || conversationConnectionEnabled)
      && routedAgentId
      && selectedAgent?.installed
      && selectedAgent.status === "ready"
      && (!selectedAgent.managed || selectedAgent.configured)
      && agentsAvailable
      && routedWorkspaceId
      && workspacesAvailable,
  );

  useEffect(() => {
    const current = runtime.workspaceSidebar;
    if (!conversationId || current?.conversationId !== conversationId) return;
    if (!workspaceDirectoryReady || !serverId || !routedWorkspaceId || !workbenchWorkspacePath || !serverCapabilities) {
      runtime.setWorkspaceSidebar(null);
      runtime.closeWorkspacePreviews(conversationId);
      return;
    }
    if (current.serverId === serverId
      && current.workspaceId === routedWorkspaceId
      && current.workspacePath === workbenchWorkspacePath
      && current.capabilities.detectedAt === serverCapabilities.detectedAt) return;
    runtime.setWorkspaceSidebar({
      conversationId,
      serverId,
      workspaceId: routedWorkspaceId,
      workspacePath: workbenchWorkspacePath,
      branchId: detail?.summary.activeBranchId,
      capabilities: serverCapabilities,
    });
    runtime.closeWorkspacePreviews(conversationId);
  }, [conversationId, detail?.summary.activeBranchId, routedWorkspaceId, runtime, serverCapabilities, serverId, workbenchWorkspacePath, workspaceDirectoryReady]);

  useEffect(() => {
    const key = conversationCacheKey(actorId, conversationId);
    if (!key || !detail) return;
    rememberBounded(conversationViewCache, key, {
      messages,
      detail,
      events,
      artifacts,
      tasks,
      eventsHydrated,
      cachedAt: Date.now(),
    }, 60);
  }, [actorId, artifacts, conversationId, detail, events, eventsHydrated, messages, tasks]);

  const mergeEvents = useCallback((incoming: RealtimeEnvelope[]) => {
    setEvents((current) => mergeConversationEvents(current, incoming));
  }, []);

  const fetchTaskSummary = useCallback(async (taskId: string) => {
    const cached = tasksRef.current[taskId];
    if (cached) return cached;
    const active = taskSummaryRequests.current.get(taskId);
    if (active) return active;
    const request = api.get<TaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}`)
      .then((result) => result.data)
      .finally(() => {
        if (taskSummaryRequests.current.get(taskId) === request) taskSummaryRequests.current.delete(taskId);
      });
    taskSummaryRequests.current.set(taskId, request);
    return request;
  }, [api]);

  const replayCompleteTaskHistory = useCallback(async (taskId: string) => {
    const active = taskReplayRequests.current.get(taskId);
    if (active) return active;
    const request = (async () => {
      const collected: RealtimeEnvelope[] = [];
      let after = taskReplayCursors.current.get(taskId) ?? 0;
      while (true) {
        const replay = await api.get<{ events: RealtimeEnvelope[] }>(`/api/tasks/${encodeURIComponent(taskId)}/events?after=${after}&limit=2000`);
        const page = replay.data.events;
        if (!page.length) break;
        collected.push(...page);
        const next = Math.max(after, ...page.map((event) => event.sequence));
        if (next <= after) break;
        after = next;
        if (page.length < 2000) break;
      }
      taskReplayCursors.current.set(taskId, after);
      return collected;
    })().finally(() => {
      if (taskReplayRequests.current.get(taskId) === request) taskReplayRequests.current.delete(taskId);
    });
    taskReplayRequests.current.set(taskId, request);
    return request;
  }, [api]);

  const retainEventsForMessages = useCallback((nextMessages: ConversationMessage[]) => {
    if (!conversationId) return;
    messagesRef.current = nextMessages;
    setEvents((current) => retainConversationEvents(current, nextMessages, conversationId, tasksRef.current));
  }, [conversationId]);

  const hydrateTaskHistory = useCallback(async (signal?: AbortSignal) => {
    if (!conversationId) return;
    const listed = await api.get<TaskSummary[]>(`/api/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=1000`, signal);
    const known = listed.data;
    if (!known.length) return;
    // Task summaries carry the per-Agent native binding. Publish them as soon
    // as the list arrives instead of making configuration/context controls
    // wait for every historical event stream to replay.
    const listedTasks = Object.fromEntries(known.map((task) => [task.id, task]));
    setTasks((current) => ({ ...current, ...listedTasks }));
  }, [api, conversationId]);
  const referencedTaskIdsKey = [...new Set(messages.map((message) => message.taskId).filter((value): value is string => Boolean(value)))].join("\n");

  const fetchConversation = useCallback(async (onFirstPage?: (snapshot: { messages: ConversationMessage[]; detail: ConversationDetail }) => void) => {
    if (!conversationId) return { messages: [] as ConversationMessage[], detail: null as ConversationDetail | null };
    const conversationRequest = api.get<ConversationDetail>(`/api/conversations/${conversationId}`);
    const items: ConversationMessage[] = [];
    let cursor: string | null = null;
    let first = true;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await api.get<{ items: ConversationMessage[]; nextCursor?: string | null }>(`/api/conversations/${conversationId}/messages?${query}`);
      items.push(...result.data.items);
      cursor = result.data.nextCursor ?? result.meta.nextCursor ?? null;
      if (first && onFirstPage) {
        const conversation = await conversationRequest;
        onFirstPage({ messages: [...items], detail: conversation.data });
      }
      first = false;
    } while (cursor);
    const conversation = await conversationRequest;
    return { messages: items, detail: conversation.data };
  }, [api, conversationId]);

  const fetchConversationArtifacts = useCallback(async (signal?: AbortSignal) => {
    if (!conversationId) return [] as ArtifactSummary[];
    const items: ArtifactSummary[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ conversationId, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await api.get<{ items: ArtifactSummary[]; nextCursor?: string | null }>(`/api/artifacts?${query}`, signal);
      items.push(...result.data.items);
      cursor = result.data.nextCursor ?? result.meta.nextCursor ?? null;
    } while (cursor && !signal?.aborted);
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }, [api, conversationId]);

  const reload = useCallback(async () => {
    const request = ++conversationLoadRevision.current;
    const [next, nextArtifacts] = await Promise.all([fetchConversation(), fetchConversationArtifacts()]);
    if (request !== conversationLoadRevision.current) return;
    retainEventsForMessages(next.messages);
    setMessages(next.messages);
    setDetail(next.detail);
    setArtifacts(nextArtifacts);
    setLoading(false);
    void refreshBootstrap().catch(() => undefined);
  }, [fetchConversation, fetchConversationArtifacts, refreshBootstrap, retainEventsForMessages]);

  useEffect(() => {
    const request = ++conversationLoadRevision.current;
    let active = true;
    void fetchConversation(initialConversationCache ? undefined : (first) => {
      if (!active || request !== conversationLoadRevision.current) return;
      retainEventsForMessages(first.messages);
      setMessages(first.messages);
      setDetail(first.detail);
      setLoading(false);
    }).then(
      (next) => { if (active && request === conversationLoadRevision.current) { retainEventsForMessages(next.messages); setMessages(next.messages); setDetail(next.detail); setLoading(false); } },
      (error: Error) => {
        if (!active || request !== conversationLoadRevision.current) return;
        setLoading(false);
        if (!recoverMissingConversation(error)) notify(error.message, "error");
      },
    );
    return () => { active = false; };
  }, [fetchConversation, initialConversationCache, notify, recoverMissingConversation, retainEventsForMessages]);
  useEffect(() => {
    if (!conversationId || loadedConversationId !== conversationId) return;
    const controller = new AbortController();
    void fetchConversationArtifacts(controller.signal).then(
      (items) => { if (!controller.signal.aborted) setArtifacts(items); },
      (reason) => {
        if (!controller.signal.aborted && !recoverMissingConversation(reason)) notify(reason instanceof Error ? reason.message : "下载卡片读取失败", "error");
      },
    );
    return () => controller.abort();
  }, [conversationId, fetchConversationArtifacts, loadedConversationId, notify, recoverMissingConversation]);
  useEffect(() => {
    if (!conversationId || loadedConversationId !== conversationId) return;
    const controller = new AbortController();
    void api.get<{ events: RealtimeEnvelope[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/events?limit=2000`, controller.signal)
      .then((result) => mergeEvents(result.data.events))
      .catch((reason) => {
        if (!controller.signal.aborted && !recoverMissingConversation(reason)) notify(reason instanceof Error ? reason.message : "对话活动读取失败", "error");
      })
      .finally(() => { if (!controller.signal.aborted) setEventsHydrated(true); });
    return () => controller.abort();
  }, [api, conversationId, loadedConversationId, mergeEvents, notify, recoverMissingConversation]);
  useEffect(() => {
    if (!conversationId || loadedConversationId !== conversationId || activeMode !== "work") return;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      void hydrateTaskHistory(controller.signal).catch((reason) => {
        if (!controller.signal.aborted && !recoverMissingConversation(reason)) notify(reason instanceof Error ? reason.message : "任务历史读取失败", "error");
      });
    }, 120);
    return () => { window.clearTimeout(handle); controller.abort(); };
  }, [activeMode, conversationId, hydrateTaskHistory, loadedConversationId, notify, recoverMissingConversation]);
  useEffect(() => {
    if (!referencedTaskIdsKey || activeMode !== "work") return;
    const controller = new AbortController();
    const taskIds = referencedTaskIdsKey.split("\n");
    void Promise.allSettled(taskIds.map(async (taskId) => {
      const task = await fetchTaskSummary(taskId);
      const taskEvents = await replayCompleteTaskHistory(taskId);
      return { task, events: taskEvents };
    })).then((settled) => {
      if (controller.signal.aborted) return;
      const referencedTasks: Record<string, TaskSummary> = {};
      const history: RealtimeEnvelope[] = [];
      for (const result of settled) if (result.status === "fulfilled") {
        referencedTasks[result.value.task.id] = result.value.task;
        history.push(...result.value.events);
      }
      if (Object.keys(referencedTasks).length) setTasks((current) => ({ ...current, ...referencedTasks }));
      if (history.length) mergeEvents(history);
    });
    return () => controller.abort();
  }, [activeMode, fetchTaskSummary, mergeEvents, referencedTaskIdsKey, replayCompleteTaskHistory]);
  const handedOffTaskIds = [...new Set(events
    .filter((event) => event.kind === "run.handoff.dispatched")
    .map((event) => String(event.ids.taskId || ""))
    .filter(Boolean))];
  const handedOffTaskIdsKey = handedOffTaskIds.join("\n");
  useEffect(() => {
    if (!handedOffTaskIdsKey) return;
    let active = true;
    void Promise.allSettled(handedOffTaskIdsKey.split("\n").map(async (taskId) => {
      const [task, replay] = await Promise.all([
        fetchTaskSummary(taskId),
        replayCompleteTaskHistory(taskId),
      ]);
      return { task, events: replay };
    }))
      .then((settled) => {
        if (!active) return;
        const discovered: Record<string, TaskSummary> = {};
        const replayed: RealtimeEnvelope[] = [];
        for (const result of settled) if (result.status === "fulfilled") {
          discovered[result.value.task.id] = result.value.task;
          replayed.push(...result.value.events);
        }
        if (Object.keys(discovered).length) setTasks((current) => ({ ...current, ...discovered }));
        if (replayed.length) mergeEvents(replayed);
      });
    return () => { active = false; };
  }, [fetchTaskSummary, handedOffTaskIdsKey, mergeEvents, replayCompleteTaskHistory]);
  // A fast remote run can finish after the initial event replay but before the
  // task-topic subscription is established.  Conversation terminal events are
  // durable, so use them to reconcile the Task snapshot even when the running
  // snapshot discovered at handoff is already present locally.
  const settledTaskIdsKey = [...new Set(events
    .filter((event) => ["run.persisted", "run.suspended", "run.failed", "run.superseded"].includes(event.kind))
    .map((event) => String(event.ids.taskId || ""))
    .filter(Boolean))].join("\n");
  useEffect(() => {
    if (!settledTaskIdsKey) return;
    let active = true;
    void Promise.allSettled(settledTaskIdsKey.split("\n").map(async (taskId) => {
      const [task, replay] = await Promise.all([
        fetchTaskSummary(taskId),
        replayCompleteTaskHistory(taskId),
      ]);
      return { task, events: replay };
    }))
      .then((settled) => {
        if (!active) return;
        const reconciled: Record<string, TaskSummary> = {};
        const replayed: RealtimeEnvelope[] = [];
        for (const result of settled) if (result.status === "fulfilled") {
          reconciled[result.value.task.id] = result.value.task;
          replayed.push(...result.value.events);
        }
        if (Object.keys(reconciled).length) setTasks((current) => ({ ...current, ...reconciled }));
        if (replayed.length) mergeEvents(replayed);
      });
    return () => { active = false; };
  }, [fetchTaskSummary, mergeEvents, replayCompleteTaskHistory, settledTaskIdsKey]);
  useEffect(() => {
    const actorId = runtime.bootstrap?.actor.id;
    if (conversationId || mode !== "work" || !actorId || workDraftActor.current === actorId) return;
    let active = true;
    workDraftActor.current = actorId;
    workDraftTouched.current = false;
    void api.get<WorkDraftSnapshot>("/api/drafts/work").then((result) => {
      if (!active) return;
      const selection = result.data.selection;
      workDraftRevision.current = result.data.revision;
      if (workDraftTouched.current) return;
      const knownServer = runtime.bootstrap?.servers.some((server) => server.id === selection.serverId);
      if (!selection.serverId || !knownServer) {
        removeCachedWorkDraft(actorId, initialProjectId);
        setServerId(null); setAgentId(null); setWorkspace(null); setWorkspacePath(null);
        return;
      }
      writeCachedWorkDraft(actorId, initialProjectId, selection);
      setServerId(selection.serverId);
      setAgentId(selection.agentId);
      setWorkspace(selection.workspaceId);
      setWorkspacePath(selection.workspacePath);
    }).catch((reason) => {
      if (active) notify(reason instanceof Error ? reason.message : "工作草稿读取失败", "error");
    });
    return () => { active = false; };
  }, [actorId, api, conversationId, initialProjectId, mode, notify, runtime.bootstrap?.actor.id, runtime.bootstrap?.servers]);
  useEffect(() => {
    if (!conversationId || !eventsHydrated || !realtime) return;
    return realtime.subscribe(`conversation:${conversationId}`, (event) => {
      mergeEvents([event]);
      if (event.kind === "run.handoff.dispatched") setAgentConfigAgentId(null);
      if (event.kind === "run.persisted" || event.kind === "message.created") void reload().catch((reason) => notify(reason instanceof Error ? reason.message : "对话刷新失败", "error"));
      if (event.kind === "conversation.title.updated") void refreshBootstrap().catch(() => undefined);
      if (["run.handoff.dispatched", "run.persisted", "run.suspended", "run.failed", "run.superseded"].includes(event.kind)) {
        const taskId = String(event.ids.taskId || "");
        if (taskId) {
          void api.get<TaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}`).then((result) => {
            setTasks((current) => ({ ...current, [result.data.id]: result.data }));
          }).catch(() => undefined);
        }
        void refreshBootstrap().catch(() => undefined);
      }
    });
  }, [api, conversationId, eventsHydrated, mergeEvents, notify, realtime, refreshBootstrap, reload]);
  const activeTaskId = activeTask?.id;
  const liveTaskIdsKey = [...new Set([...handedOffTaskIds, activeTaskId].filter((value): value is string => Boolean(value)))]
    .filter((taskId) => !["completed", "failed", "cancelled", "interrupted"].includes(tasks[taskId]?.status || ""))
    .join("\n");
  useEffect(() => {
    if (!liveTaskIdsKey || !realtime) return;
    const unsubscribes = liveTaskIdsKey.split("\n").map((taskId) => realtime.subscribe(`task:${taskId}`, (event) => {
      mergeEvents([event]);
      if (["status", "command", "plan_state"].includes(event.kind)) {
        void refreshBootstrap().catch(() => undefined);
        void api.get<TaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}`)
          .then((result) => setTasks((current) => ({ ...current, [result.data.id]: result.data })))
          .catch(() => undefined);
      }
    }));
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, [api, liveTaskIdsKey, mergeEvents, realtime, refreshBootstrap]);
  useEffect(() => {
    if (!liveTaskIdsKey) return;
    let active = true;
    let timer: number | null = null;
    const taskIds = liveTaskIdsKey.split("\n");
    const poll = async () => {
      const settled = await Promise.allSettled(taskIds.map(async (taskId) => {
        const after = taskReplayCursors.current.get(taskId) ?? 0;
        const [task, replay] = await Promise.all([
          api.get<TaskSummary>(`/api/tasks/${encodeURIComponent(taskId)}`),
          api.get<{ events: RealtimeEnvelope[] }>(`/api/tasks/${encodeURIComponent(taskId)}/events?after=${after}&limit=500`),
        ]);
        return { task: task.data, events: replay.data.events, after };
      }));
      if (!active) return;
      const snapshots: Record<string, TaskSummary> = {};
      const replayed: RealtimeEnvelope[] = [];
      for (const result of settled) if (result.status === "fulfilled") {
        snapshots[result.value.task.id] = result.value.task;
        replayed.push(...result.value.events);
        taskReplayCursors.current.set(result.value.task.id, Math.max(
          result.value.after,
          ...result.value.events.map((event) => event.sequence),
        ));
      }
      if (replayed.length) mergeEvents(replayed);
      if (Object.keys(snapshots).length) setTasks((current) => {
        let changed = false;
        const next = { ...current };
        for (const [taskId, task] of Object.entries(snapshots)) {
          if (current[taskId]?.revision === task.revision && current[taskId]?.status === task.status) continue;
          next[taskId] = task;
          changed = true;
        }
        return changed ? next : current;
      });
      if (active) timer = window.setTimeout(() => void poll(), 5_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, liveTaskIdsKey, mergeEvents]);

  useEffect(() => {
    if (!serverId) return;
    let active = true;
    const setupRequests = new Set<AbortController>();
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      const cached = currentServerCacheKey
        ? serverSetupCache.get(currentServerCacheKey)
          ?? readPersistedServerSetup(currentServerCacheKey)
        : null;
      const connectionGeneration = Number(selectedServer?.connectionGeneration || 0);
      const connected = selectedServer?.status === "connected";
      const cacheFresh = Boolean(cached && cached.connectionGeneration === connectionGeneration);
      if (cached) {
        setServerCapabilities(cached.capabilities);
        setAgentOptions(mergeCachedAgentConfigurations(cached.agents, actorId, serverId, configScope));
        setWorkspaceOptions(cached.workspaces);
        setSetupLoading(false);
      } else {
        setSetupLoading(connected);
        setServerCapabilities(null);
        setAgentOptions([]);
        setWorkspaceOptions([]);
      }
      setCapabilityError(null);
      setAgentLoadError(null);
      setWorkspaceLoadError(null);
      if (!connected) {
        setSetupLoading(false);
        return;
      }
      if (cacheFresh) return;
      const readSetup = async <T,>(path: string, label: string) => {
        const controller = new AbortController();
        setupRequests.add(controller);
        const timeout = window.setTimeout(() => controller.abort(), 6_000);
        try {
          return await api.get<T>(path, controller.signal);
        } catch (reason) {
          if (controller.signal.aborted && active) throw new Error(`${label}超时，请重试`);
          throw reason;
        } finally {
          window.clearTimeout(timeout);
          setupRequests.delete(controller);
        }
      };
      const loadRemote = async (): Promise<void> => {
        try {
          const capabilityResult = await readSetup<ServerCapabilityProfile>(`/api/servers/${encodeURIComponent(serverId)}/capabilities`, "服务器能力读取");
          if (!active) return;
          const profile = capabilityResult.data;
          setServerCapabilities(profile);
          const [agentResult, workspaceResult] = await Promise.allSettled([
            profile.features.agents.available && profile.features.agents.inspect
              ? readSetup<{ items: AgentSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/agents?configScope=${encodeURIComponent(configScope)}&cached=1`, "Agent 列表读取")
              : Promise.resolve(null),
            profile.features.workspaces.available
              ? readSetup<{ revision: number; workspaces: WorkspaceSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/workspaces`, "工作区列表读取")
              : Promise.resolve(null),
          ]);
          if (!active) return;
          const nextAgents = mergeCachedAgentConfigurations(
            agentResult.status === "fulfilled" && agentResult.value && Array.isArray(agentResult.value.data.items)
              ? agentResult.value.data.items
              : cached?.agents ?? [],
            actorId,
            serverId,
            configScope,
          );
          const nextWorkspaces = workspaceResult.status === "fulfilled" && workspaceResult.value && Array.isArray(workspaceResult.value.data.workspaces)
            ? workspaceResult.value.data.workspaces
            : cached?.workspaces ?? [];
          setAgentOptions(nextAgents);
          setWorkspaceOptions(nextWorkspaces);
          setCapabilityError(null);
          setAgentLoadError(agentResult.status === "rejected"
            ? agentResult.reason instanceof Error ? agentResult.reason.message : "Agent 列表读取失败"
            : null);
          setWorkspaceLoadError(workspaceResult.status === "rejected"
            ? workspaceResult.reason instanceof Error ? workspaceResult.reason.message : "工作区列表读取失败"
            : null);
          if (currentServerCacheKey) rememberServerSetup(currentServerCacheKey, {
            capabilities: profile,
            agents: nextAgents,
            workspaces: nextWorkspaces,
            cachedAt: Date.now(),
            connectionGeneration,
          });
          setSetupLoading(false);
        } catch (reason) {
          if (!active) return;
          setCapabilityError(reason instanceof Error ? reason.message : "服务器能力检测失败");
          setAgentLoadError(null);
          setWorkspaceLoadError(null);
          setSetupLoading(false);
        }
      };
      await loadRemote();
    })();
    return () => {
      active = false;
      for (const controller of setupRequests) controller.abort();
      setupRequests.clear();
    };
  }, [actorId, api, configScope, currentServerCacheKey, selectedServer?.connectionGeneration, selectedServer?.status, serverId, setupRetryRevision]);

  useEffect(() => {
    if (!conversationId || loadedConversationId !== conversationId || activeMode !== "work") return;
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (active && !initialRoute.serverId) setServerBindingLoading(true);
      let binding = (await api.get<ConversationServerBinding>(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`)).data;
      const pendingServerId = pendingServerBinding(conversationId);
      if (!binding.serverId && pendingServerId && bootstrapServerIdKey.split("\n").includes(pendingServerId)) {
        // The new-conversation view is allowed to render before the durable
        // binding POST completes. Coalesce that one known race by committing
        // the exact pending choice; ordinary cached routes never rebind an
        // intentionally disconnected conversation.
        binding = (await api.post<ConversationServerBinding>(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`, { serverId: pendingServerId })).data;
      }
      if (!binding.serverId) {
        const history = await api.get<TaskSummary[]>(`/api/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=1`);
        const historicalServerId = history.data[0]?.route.serverId;
        if (historicalServerId && bootstrapServerIdKey.split("\n").includes(historicalServerId)) {
          binding = (await api.post<ConversationServerBinding>(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`, { serverId: historicalServerId })).data;
        }
      }
      if (!active) return;
      if (binding.serverId) clearPendingServerBinding(conversationId, binding.serverId);
      setBoundServerId(binding.serverId);
      setConversationConnectionEnabled(binding.connectionEnabled !== false);
      if (binding.serverId) {
        const persistedRoute = storedRoute(conversationId);
        setServerId(binding.serverId);
        if (persistedRoute.serverId === binding.serverId) {
          setAgentId(persistedRoute.agentId ?? null);
          setWorkspace(persistedRoute.workspaceId ?? null);
          setWorkspacePath(persistedRoute.workspacePath ?? null);
        } else {
          setAgentId(null);
          setWorkspace(null);
          setWorkspacePath(null);
        }
      }
    })().catch((reason) => {
      if (active && !recoverMissingConversation(reason)) notify(reason instanceof Error ? reason.message : "对话服务器绑定读取失败", "error");
    }).finally(() => {
      if (active) setServerBindingLoading(false);
    });
    return () => { active = false; };
  }, [activeMode, api, bootstrapServerIdKey, conversationId, initialRoute, loadedConversationId, notify, recoverMissingConversation]);

  const syncConversationWorkspaceRoute = useCallback(({
    mode: routeMode,
    targetConversationId,
    branchId,
    targetServerId,
    connectionEnabled,
  }: {
    mode: Mode;
    targetConversationId?: string;
    branchId?: string;
    targetServerId: string | null;
    connectionEnabled: boolean;
  }) => {
    if (!targetConversationId || routeMode !== "work" || !branchId || !targetServerId || !connectionEnabled) return Promise.resolve(null);
    const syncKey = [targetConversationId, branchId, targetServerId].join("\n");
    const existing = workspaceRouteSyncPending.current.get(syncKey);
    if (existing) return existing;
    const pending = (async () => {
      const result = await api.get<WorkspaceRouteSnapshot | null>(`/api/servers/${encodeURIComponent(targetServerId)}/workspace-route?conversationId=${encodeURIComponent(targetConversationId)}&branchId=${encodeURIComponent(branchId)}`);
      const snapshot = result.data;
      if (!snapshot) return null;
      setServerId(targetServerId);
      setAgentId(snapshot.binding.agentId);
      setWorkspace(snapshot.binding.workspaceId);
      setWorkspacePath(snapshot.workspace.canonicalPath);
      setWorkspaceOptions((current) => {
        const found = current.find((item) => item.id === snapshot.workspace.id);
        if (!found) return [...current, snapshot.workspace];
        if (found.revision === snapshot.workspace.revision && found.canonicalPath === snapshot.workspace.canonicalPath) return current;
        return current.map((item) => item.id === snapshot.workspace.id ? snapshot.workspace : item);
      });
      writeStoredRoute(targetConversationId, {
        serverId: targetServerId,
        agentId: snapshot.binding.agentId,
        workspaceId: snapshot.binding.workspaceId,
        workspacePath: snapshot.workspace.canonicalPath,
      });
      return snapshot;
    })();
    const clearPending = () => {
      if (workspaceRouteSyncPending.current.get(syncKey) === pending) workspaceRouteSyncPending.current.delete(syncKey);
    };
    workspaceRouteSyncPending.current.set(syncKey, pending);
    pending.then(clearPending, clearPending);
    return pending;
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => void syncConversationWorkspaceRoute({
      mode: activeMode,
      targetConversationId: conversationId,
      branchId: detail?.summary.activeBranchId,
      targetServerId: boundServerId,
      connectionEnabled: conversationConnectionEnabled && selectedServer?.status === "connected",
    }).catch(() => undefined), 0);
    return () => window.clearTimeout(timer);
  }, [activeMode, boundServerId, conversationConnectionEnabled, conversationId, detail?.summary.activeBranchId, selectedServer?.status, syncConversationWorkspaceRoute, taskRoutedAgentId, taskRoutedWorkspaceId]);

  const responseDescriptor = (scopeOverride?: Record<string, unknown>, resources: ComposerResourceSelection = emptyComposerResources, selection?: WebModelSelection): ResponseDescriptor => {
    const selectedProvider = selection?.providerId ?? (typeof window === "undefined" ? null : localStorage.getItem("easywork.web-provider"));
    const selectedModel = selection?.modelId ?? (typeof window === "undefined" ? null : localStorage.getItem("easywork.web-model"));
    const providerId = runtime.bootstrap?.providers.some((provider) => provider.id === selectedProvider)
      ? selectedProvider
      : runtime.bootstrap?.providers[0]?.id;
    if (!providerId) throw new Error("请先配置网页模型 API");
    if (!selectedModel) throw new Error("请先选择网页对话模型");
    let scope: Record<string, unknown> = {};
    if (activeMode === "work") {
      if (scopeOverride) scope = scopeOverride;
      else {
        if (!serverId || !agentId || !workspace || workspace === VIRTUAL_WORKSPACE) throw new Error("工作环境尚未完成绑定");
        scope = { serverId, workspaceId: workspace, agentId };
      }
      const semanticWorkspacePath = String(scope.workspacePath || workspacePath || "").trim();
      if (semanticWorkspacePath && semanticWorkspacePath !== AUTOMATIC_WORKSPACE_LABEL) scope.workspacePath = semanticWorkspacePath;
      const scheduler = serverCapabilities?.features.scheduler.type;
      if (scheduler && ["slurm", "pbs", "generic", "none"].includes(scheduler)) scope.scheduler = scheduler;
      const agentProviderId = typeof window === "undefined" ? "" : localStorage.getItem(`easywork.agent-provider:${serverId}:${agentId}`) || "";
      const agentModelId = typeof window === "undefined" ? "" : localStorage.getItem(`easywork.agent-model:${serverId}:${agentId}`) || "";
      if (agentProviderId && agentModelId) scope = { ...scope, agentProviderId, agentModelId };
    }
    if (resources.collections.length) scope.selectedCollectionIds = resources.collections.map((collection) => collection.id);
    if (resources.files.length) scope.resourceSelectionRequested = true;
    if (resources.skills.length) {
      scope.selectedSkillVersions = resources.skills.map(({ skillId, version }) => ({ skillId, version }));
      scope.skillPins = resources.skills.map(({ skillId, version, sha256 }) => ({ skillId, version, sha256 }));
    }
    return { providerId, modelId: selectedModel, scope };
  };

  const uploadConversationFiles = async (targetConversationId: string, files: File[]) => {
    if (!files.length) return;
    const inspected = await api.get<{ revision: number }>(`/api/resources?ownerType=conversation&ownerId=${encodeURIComponent(targetConversationId)}&limit=1`);
    let expectedRevision = inspected.data.revision;
    for (const file of files) {
      const uploaded = await uploadResource(api, file, { ownerType: "conversation", ownerId: targetConversationId, path: file.name }, expectedRevision);
      expectedRevision = uploaded.data.revision;
    }
  };

  const appendConversationMessage = async (content: string, idempotencyKey: string) => {
    if (!conversationId) throw new Error("对话尚未创建");
    const append = (expectedRevision: number) => runtime.api.post<{ conversation: ConversationSummary; messageId: string }>(
      `/api/conversations/${conversationId}/messages`,
      { content, role: "user" },
      { expectedRevision, idempotencyKey },
    );
    const expectedRevision = summary?.revision;
    if (expectedRevision == null) throw new Error("对话状态尚未载入");
    try {
      return await append(expectedRevision);
    } catch (reason) {
      if (!(reason instanceof GatewayError) || reason.code !== "REVISION_CONFLICT") throw reason;
      const latest = await api.get<ConversationDetail>(`/api/conversations/${encodeURIComponent(conversationId)}`);
      return append(latest.data.summary.revision);
    }
  };

  const send = async (content: string, resources: ComposerResourceSelection, selection: WebModelSelection) => {
    if (!conversationId) {
      if (mode === "chat") {
        const result = await api.post<{ conversation: ConversationSummary; messageId: string }>("/api/conversations", {
          content,
          mode,
          projectId: initialProjectId ?? null,
        }, { expectedRevision: 0, idempotencyKey: commandId("conversation") });
        try {
          await uploadConversationFiles(result.data.conversation.id, resources.files);
          await api.post(`/api/conversations/${encodeURIComponent(result.data.conversation.id)}/respond`, {
            messageId: result.data.messageId,
            ...responseDescriptor(undefined, resources, selection),
          }, { idempotencyKey: commandId("respond") });
        } catch (reason) {
          notify(reason instanceof Error ? reason.message : "消息资源处理失败", "error");
        }
        await refreshBootstrap();
        runtime.navigate({ kind: "conversation", conversationId: result.data.conversation.id }, { replace: true });
        return;
      }
      if (!serverId || !agentId || !workspace || selectedServer?.status !== "connected") throw new Error("请先完成远程服务器、Agent 和工作区设置");
      const result = await api.post<{ conversation: ConversationSummary; messageId: string; branchId: string }>("/api/conversations", {
        content,
        mode,
        projectId: initialProjectId ?? null,
      }, { expectedRevision: 0, idempotencyKey: commandId("conversation") });
      const id = result.data.conversation.id;
      const branchId = result.data.branchId;
      let workspaceId = workspace;
      let resolvedPath = workspacePath ?? selectedWorkspace?.canonicalPath;
      let conversationOpened = false;
      try {
        // Enter the conversation as soon as the local conversation exists. The
        // cached route is sufficient for the first render while its durable
        // server association is committed immediately below.
        markPendingServerBinding(id, serverId);
        writeStoredRoute(id, { serverId, agentId, workspaceId, workspacePath: resolvedPath });
        runtime.navigate({ kind: "conversation", conversationId: id }, { replace: true });
        conversationOpened = true;
        await api.post(`/api/conversations/${encodeURIComponent(id)}/server-binding`, { serverId });
        // A native conversation only uses its selected Agent. Other Agent
        // configurations are materialized lazily when the user switches to
        // them, avoiding three sequential SSH configuration copies here.
        const configuredAgentIds = [agentId];
        copyAgentConfigurationCache(actorId, serverId, configScope, id, configuredAgentIds);
        let workspacePreparation: { kind: "virtual"; branchId: string } | null = null;
        if (workspace === VIRTUAL_WORKSPACE) {
          // The response worker owns deterministic virtual-workspace creation.
          // Supplying the preparation descriptor lets Web Agent reasoning start
          // immediately while the remote route is prepared in parallel.
          workspacePreparation = { kind: "virtual", branchId };
        } else if (workspace === PENDING_USER_WORKSPACE_SELECTION && workspacePath) {
          const registered = await api.post<{ workspace: WorkspaceSummary }>(`/api/servers/${encodeURIComponent(serverId)}/workspaces/user`, {
            conversationId: id,
            path: workspacePath,
            expectedRevision: 0,
          }, { expectedRevision: 0, idempotencyKey: commandId("workspace-user") });
          workspaceId = registered.data.workspace.id;
          resolvedPath = registered.data.workspace.canonicalPath;
        }
        await uploadConversationFiles(id, resources.files);
        writeStoredRoute(id, { serverId, agentId, workspaceId, workspacePath: resolvedPath });
        await api.post(`/api/conversations/${encodeURIComponent(id)}/respond`, {
          messageId: result.data.messageId,
          ...responseDescriptor({
            serverId,
            agentId,
            ...(workspacePreparation
              ? { workspacePreparation }
              : { workspaceId, ...(resolvedPath ? { workspacePath: resolvedPath } : {}) }),
            agentConfigSourceScope: configScope,
            agentConfigIds: configuredAgentIds,
          }, resources, selection),
        }, { idempotencyKey: commandId("respond") });
      } catch (reason) {
        notify(reason instanceof Error ? reason.message : "工作任务启动失败", "error");
      } finally {
        writeStoredRoute(id, { serverId, agentId, workspaceId, workspacePath: resolvedPath });
        await clearWorkDraft().catch(() => undefined);
        await refreshBootstrap();
        if (!conversationOpened) runtime.navigate({ kind: "conversation", conversationId: id }, { replace: true });
      }
      return;
    }
    const current = summary;
    if (!current) throw new Error("对话状态尚未载入");
    if (activeMode === "work" && activeTask?.status === "running") {
      const capability = selectedAgent?.runtimeCapabilities?.append;
      if (capability?.availability !== "available") throw new Error(capability?.reason || "当前 Agent 不支持运行中追加");
      if (resources.files.length || resources.collections.length || resources.skills.length) throw new Error("运行中的原生 Agent 会话不能重新绑定文件、文件集或 Skill");
      const sent = await appendConversationMessage(content, commandId("message-append"));
      await runtime.api.post(`/api/conversations/${conversationId}/respond`, {
        messageId: sent.data.messageId,
        ...responseDescriptor({
          serverId: activeTask.route.serverId,
          workspaceId: activeTask.route.workspaceId,
          agentId: activeTask.route.agentId,
          directRemoteTaskId: activeTask.id,
        }, resources, selection),
      }, { idempotencyKey: commandId("respond-append") });
      await reload();
      return;
    }
    const sent = await appendConversationMessage(content, commandId("message"));
    await uploadConversationFiles(conversationId, resources.files);
    await runtime.api.post(`/api/conversations/${conversationId}/respond`, { messageId: sent.data.messageId, ...responseDescriptor(undefined, resources, selection) }, { idempotencyKey: commandId("respond") });
    await reload();
  };

  const interrupt = async () => {
    if (!conversationId) return;
    if (activeTask && !agentOperationAvailable(selectedAgent, "interrupt")) {
      notify(selectedAgent?.runtimeCapabilities?.interrupt?.reason || "当前 Agent 不支持中断", "error");
      return;
    }
    const previous = activeTask;
    if (previous) setTasks((current) => ({ ...current, [previous.id]: { ...previous, status: "interrupting" } }));
    try {
      const result = await runtime.api.post<{ taskId?: string; runId?: string; status: string }>(`/api/conversations/${encodeURIComponent(conversationId)}/interrupt`, {}, { idempotencyKey: commandId("conversation-interrupt") });
      if (result.data.taskId) setTasks((current) => {
        const currentTask = current[result.data.taskId!] || previous;
        return currentTask ? { ...current, [result.data.taskId!]: { ...currentTask, status: result.data.status as TaskSummary["status"] } } : current;
      });
      void refreshBootstrap().catch(() => undefined);
    } catch (reason) {
      if (previous) setTasks((current) => ({ ...current, [previous.id]: previous }));
      notify(reason instanceof Error ? reason.message : "任务中断失败", "error");
    }
  };

  const respondApproval: ApprovalResponder = async (taskId, requestId, decision) => {
    const task = tasks[taskId];
    const approvalAgent = effectiveAgentOptions.find((item) => item.agentId === task?.route.agentId) ?? selectedAgent;
    if (approvalAgent?.runtimeCapabilities?.respondApproval?.availability !== "available") {
      throw new Error(approvalAgent?.runtimeCapabilities?.respondApproval?.reason || "当前 Agent 不支持网页审批响应");
    }
    await api.post(`/api/tasks/${encodeURIComponent(taskId)}/approval`, { requestId, decision }, { idempotencyKey: commandId("task-approval") });
    setTasks((current) => {
      const existing = current[taskId];
      return existing?.status === "waiting_approval" ? { ...current, [taskId]: { ...existing, status: "running" } } : current;
    });
    notify(decision === "reject" ? "已拒绝该操作" : decision === "approve_session" ? "已在本次 Agent 会话中允许" : "已允许该操作", "neutral");
  };

  const respondInput: InputResponder = async (taskId, requestId, answers) => {
    const task = tasks[taskId];
    const inputAgent = effectiveAgentOptions.find((item) => item.agentId === task?.route.agentId) ?? selectedAgent;
    if (inputAgent?.runtimeCapabilities?.respondInput?.availability !== "available") {
      throw new Error(inputAgent?.runtimeCapabilities?.respondInput?.reason || "当前 Agent 不支持网页回答原生问题");
    }
    await api.post(`/api/tasks/${encodeURIComponent(taskId)}/input`, { requestId, answers }, { idempotencyKey: commandId("task-input") });
    setTasks((current) => {
      const existing = current[taskId];
      return existing?.status === "waiting_input" ? { ...current, [taskId]: { ...existing, status: "running" } } : current;
    });
    notify("回答已提交，Agent 将继续当前会话", "neutral");
  };

  const saveWorkDraft = (selection: WorkDraftSelection) => {
    writeCachedWorkDraft(actorId, initialProjectId, selection);
    workDraftWrites.current = workDraftWrites.current.catch(() => undefined).then(async () => {
      const idempotencyKey = commandId("work-draft");
      try {
        const result = await api.patch<WorkDraftSnapshot>("/api/drafts/work", { selection }, {
          expectedRevision: workDraftRevision.current,
          idempotencyKey,
        });
        workDraftRevision.current = result.data.revision;
      } catch (reason) {
        if (reason instanceof GatewayError && reason.code === "REVISION_CONFLICT") {
          try {
            const current = await api.get<WorkDraftSnapshot>("/api/drafts/work");
            workDraftRevision.current = current.data.revision;
            const merged = await api.patch<WorkDraftSnapshot>("/api/drafts/work", { selection }, {
              expectedRevision: workDraftRevision.current,
              idempotencyKey,
            });
            workDraftRevision.current = merged.data.revision;
            notify("已同步另一设备的工作环境变更", "neutral");
          } catch (retryReason) {
            notify(retryReason instanceof Error ? retryReason.message : "工作草稿保存失败", "error");
          }
          return;
        }
        notify(reason instanceof Error ? reason.message : "工作草稿保存失败", "error");
      }
    });
    return workDraftWrites.current;
  };
  const clearWorkDraft = async () => {
    await workDraftWrites.current;
    const idempotencyKey = commandId("work-draft-clear");
    try {
      const result = await api.delete<WorkDraftSnapshot>("/api/drafts/work", {
        expectedRevision: workDraftRevision.current,
        idempotencyKey,
        body: {},
      });
      workDraftRevision.current = result.data.revision;
      removeCachedWorkDraft(actorId, initialProjectId);
    } catch (reason) {
      if (!(reason instanceof GatewayError) || reason.code !== "REVISION_CONFLICT") throw reason;
      const current = await api.get<WorkDraftSnapshot>("/api/drafts/work");
      workDraftRevision.current = current.data.revision;
      const result = await api.delete<WorkDraftSnapshot>("/api/drafts/work", {
        expectedRevision: workDraftRevision.current,
        idempotencyKey,
        body: {},
      });
      workDraftRevision.current = result.data.revision;
      removeCachedWorkDraft(actorId, initialProjectId);
    }
  };
  const choose = (kind: "server" | "agent" | "workspace", value: string, pathOverride?: string) => {
    workDraftTouched.current = true;
    if (kind === "server") {
      if (value === serverId) {
        // Reaffirming the connection from the server dialog must not put the
        // setup UI back into a loading state.  No dependency of the setup
        // effect changes in this case, so doing so would leave the spinner
        // running forever and would also discard the selected route.
        if (serverCapabilities) setSetupLoading(false);
        void saveWorkDraft({ serverId: value, agentId, workspaceId: workspace, workspacePath });
        return;
      }
      setSetupLoading(true);
      setServerId(value); setAgentId(null); setWorkspace(null); setWorkspacePath(null);
      void saveWorkDraft({ serverId: value, agentId: null, workspaceId: null, workspacePath: null });
    }
    if (kind === "agent" && serverId) {
      const useVirtualWorkspace = Boolean(serverCapabilities?.features.workspaces.virtual);
      setAgentId(value);
      setWorkspace(useVirtualWorkspace ? VIRTUAL_WORKSPACE : null);
      setWorkspacePath(useVirtualWorkspace ? AUTOMATIC_WORKSPACE_LABEL : null);
      void saveWorkDraft({ serverId, agentId: value, workspaceId: useVirtualWorkspace ? VIRTUAL_WORKSPACE : null, workspacePath: useVirtualWorkspace ? AUTOMATIC_WORKSPACE_LABEL : null });
    }
    if (kind === "workspace" && serverId && agentId) {
      const path = pathOverride ?? workspaceOptions.find((item) => item.id === value)?.canonicalPath;
      setWorkspace(value); setWorkspacePath(path ?? (value === VIRTUAL_WORKSPACE ? AUTOMATIC_WORKSPACE_LABEL : null));
      void saveWorkDraft({ serverId, agentId, workspaceId: value, workspacePath: path ?? (value === VIRTUAL_WORKSPACE ? AUTOMATIC_WORKSPACE_LABEL : null) });
    }
  };

  const requestRouteSwitchConfirmation = (kind: "workspace" | "agent") => new Promise<boolean>((resolve) => {
    routeSwitchResolver.current?.(false);
    routeSwitchResolver.current = resolve;
    setRouteSwitchConfirmation(kind);
  });

  const settleRouteSwitchConfirmation = (confirmed: boolean) => {
    const resolve = routeSwitchResolver.current;
    routeSwitchResolver.current = null;
    setRouteSwitchConfirmation(null);
    resolve?.(confirmed);
  };

  const switchWorkspace = async (workspaceId: string, workspaceOverride?: WorkspaceSummary) => {
    const branchId = detail?.summary.activeBranchId;
    if (!conversationId || !branchId || !serverId || !agentId) return;
    setSwitchingWorkspace(true);
    try {
      const body = { conversationId, branchId, workspaceId, agentId, contextEpoch: 0 };
      const described = await api.post<WorkspaceSwitchDescriptor>(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch/describe`, body);
      if (described.data.requiresConfirmation) {
        setSwitchingWorkspace(false);
        setWorkspacePickerOpen(false);
        const confirmed = await requestRouteSwitchConfirmation("workspace");
        if (!confirmed) { setWorkspacePickerOpen(true); return; }
        setSwitchingWorkspace(true);
      }
      await api.post(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch`, {
        ...body,
        descriptorId: described.data.id,
        expectedRevision: described.data.routeRevision,
      }, { expectedRevision: described.data.routeRevision, idempotencyKey: commandId("workspace-switch") });
      const next = workspaceOverride ?? workspaceOptions.find((item) => item.id === workspaceId);
      setWorkspace(workspaceId);
      setWorkspacePath(next?.canonicalPath ?? null);
      setWorkspacePickerOpen(false);
      writeStoredRoute(conversationId, {
        serverId,
        agentId,
        workspaceId,
        workspacePath: next?.canonicalPath,
      });
      notify("工作区已切换", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "工作区切换失败", "error");
    } finally { setSwitchingWorkspace(false); }
  };

  const openBranchedConversation = async (result: BranchedConversationResult) => {
    const targetConversationId = result.conversation.id;
    if (serverId) {
      copyAgentConfigurationCache(actorId, serverId, configScope, targetConversationId, effectiveAgentOptions.map((agent) => agent.agentId));
      const routed = result.workspaceRoute;
      if (routed?.binding) {
        writeStoredRoute(targetConversationId, {
          serverId,
          agentId: routed.binding.agentId,
          workspaceId: routed.binding.workspaceId,
          workspacePath: routed.workspace?.canonicalPath,
        });
      }
    }
    await refreshBootstrap();
    runtime.navigate({ kind: "conversation", conversationId: targetConversationId });
  };

  const switchAgent = async (nextAgentId: string) => {
    const branchId = detail?.summary.activeBranchId;
    const currentWorkspaceId = routedWorkspaceId;
    const currentWorkspacePath = workbenchWorkspacePath;
    if (!conversationId || !branchId || !serverId || !currentWorkspaceId || currentWorkspaceId === VIRTUAL_WORKSPACE || nextAgentId === routedAgentId) return;
    if (activeTask && !["completed", "failed", "cancelled", "interrupted"].includes(activeTask.status)) throw new Error("当前任务结束或中断后才能切换 Agent");
    setSwitchingWorkspace(true);
    try {
      // A freshly created automatic workspace can already be authoritative in
      // the Task route while the local setup state still contains __virtual__.
      // Switch against that resolved route so the newly configured Agent works
      // immediately instead of silently returning until a full page reload.
      const body = { conversationId, branchId, workspaceId: currentWorkspaceId, agentId: nextAgentId, contextEpoch: 0 };
      const described = await api.post<WorkspaceSwitchDescriptor>(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch/describe`, body);
      if (described.data.requiresConfirmation) {
        setSwitchingWorkspace(false);
        if (!await requestRouteSwitchConfirmation("agent")) return;
        setSwitchingWorkspace(true);
      }
      await api.post(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch`, {
        ...body,
        descriptorId: described.data.id,
        expectedRevision: described.data.routeRevision,
      }, { expectedRevision: described.data.routeRevision, idempotencyKey: commandId("agent-switch") });
      setAgentId(nextAgentId);
      setWorkspace(currentWorkspaceId);
      setWorkspacePath(currentWorkspacePath);
      writeStoredRoute(conversationId, {
        serverId,
        agentId: nextAgentId,
        workspaceId: currentWorkspaceId,
        workspacePath: currentWorkspacePath ?? undefined,
      });
      notify("Agent 已切换", "success");
    } finally { setSwitchingWorkspace(false); }
  };

  const storeAgentOptions = (items: AgentSummary[]) => {
    const next = serverId ? mergeCachedAgentConfigurations(items, actorId, serverId, configScope) : items;
    setAgentOptions(next);
    if (!currentServerCacheKey || !serverCapabilities) return next;
    rememberServerSetup(currentServerCacheKey, {
      capabilities: serverCapabilities,
      agents: next,
      workspaces: workspaceOptions,
      cachedAt: Date.now(),
      connectionGeneration: Number(selectedServer?.connectionGeneration || 0),
    });
    return next;
  };

  const installAgent = async (targetAgentId: string) => {
    if (!serverId || installingAgent) return;
    setInstallingAgent(targetAgentId);
    try {
      await api.post(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(targetAgentId)}/install`, {}, { idempotencyKey: commandId("agent-install") });
      const result = await api.get<{ items: AgentSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/agents?configScope=${encodeURIComponent(configScope)}&cached=1`);
      const next = storeAgentOptions(result.data.items);
      if (next.some((agent) => agent.agentId === targetAgentId && agent.installed && agent.status === "ready")) choose("agent", targetAgentId);
      notify("Agent 已安装", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Agent 安装失败", "error");
    } finally { setInstallingAgent(null); }
  };

  const refreshAgents = async () => {
    if (!serverId) return;
    const result = await api.get<{ items: AgentSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/agents?configScope=${encodeURIComponent(configScope)}&cached=1`);
    storeAgentOptions(result.data.items);
  };

  const latestUser = [...messages].reverse().find((message) => message.role === "user")?.id;
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.id;
  const classifiedOutput = classifyConversationOutput(events);
  const latestUserPosition = messages.findIndex((message) => message.id === latestUser);
  const latestAssistantPosition = messages.findIndex((message) => message.id === latestAssistant);
  const streamingMessagePersisted = classifiedOutput.streamingMessageId
    ? messages.some((message) => message.id === classifiedOutput.streamingMessageId)
    : latestAssistantPosition > latestUserPosition && messages[latestAssistantPosition]?.content === classifiedOutput.streamingFinal;
  const visibleStreamingFinal = streamingMessagePersisted ? "" : classifiedOutput.streamingFinal;
  const userMessages = messages.filter((message) => message.role === "user");
  const taskIdByUserMessage = new Map<string, string>();
  let taskOwnerUserId: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      taskOwnerUserId = message.id;
      continue;
    }
    if (taskOwnerUserId && message.taskId) taskIdByUserMessage.set(taskOwnerUserId, message.taskId);
    taskOwnerUserId = null;
  }
  const runStartByUserMessage = new Map<string, RealtimeEnvelope>();
  const userRecords = userMessages.map((message) => {
    const exactRuns = events
      .filter((event) => event.kind === "run.started" && event.ids.sourceMessageId === message.id)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence);
    const runStart = exactRuns.at(-1);
    if (runStart) runStartByUserMessage.set(message.id, runStart);
    const handoff = runStart?.ids.runId
      ? events.find((event) => event.kind === "run.handoff.dispatched" && event.ids.runId === runStart.ids.runId)
      : undefined;
    const exactTaskId = String(handoff?.ids.taskId || taskIdByUserMessage.get(message.id) || "");
    if (exactTaskId) taskIdByUserMessage.set(message.id, exactTaskId);
    const task = exactTaskId ? tasks[exactTaskId] ?? null : null;
    return { message, task };
  });
  const timelineByUserMessage = new Map<string, RealtimeEnvelope[]>();
  for (let index = 0; index < userMessages.length; index += 1) {
    const message = userMessages[index];
    const runStart = runStartByUserMessage.get(message.id);
    const runId = runStart?.ids.runId;
    const referencedTaskId = taskIdByUserMessage.get(message.id) || null;
    const scopedEvents = events.filter((event) => {
      if (referencedTaskId && event.ids.taskId) {
        if (event.ids.taskId !== referencedTaskId) return false;
        // Native append keeps one remote Task alive across several webpage
        // user turns. The orchestrator stamps every immutable Task event with
        // the webpage message/run that owned it at emission time; use that
        // identity to split continuations without replaying earlier events or
        // guessing boundaries from clocks and adjacency.
        if (event.ids.sourceMessageId !== message.id) return false;
        return !runId || !event.ids.runId || event.ids.runId === runId;
      }
      if (event.ids.sourceMessageId) {
        if (event.ids.sourceMessageId !== message.id) return false;
        if (runId && event.ids.runId) return event.ids.runId === runId;
        return !runId;
      }
      if (runId && event.ids.runId === runId) return true;
      const linkedTask = event.ids.taskId ? tasks[String(event.ids.taskId)] : null;
      if (linkedTask?.sourceMessageId) return linkedTask.sourceMessageId === message.id;
      if (runId && linkedTask?.conversationRunId === runId) return true;
      return false;
    });
    if (scopedEvents.length) timelineByUserMessage.set(message.id, scopedEvents);
  }
  const timelineByAssistantMessage = new Map<string, RealtimeEnvelope[]>();
  const artifactsByTaskId = new Map<string, ArtifactSummary[]>();
  for (const artifact of artifacts) {
    const current = artifactsByTaskId.get(artifact.taskId) || [];
    current.push(artifact);
    artifactsByTaskId.set(artifact.taskId, current);
  }
  const artifactsByAssistantMessage = new Map<string, ArtifactSummary[]>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const owned = message.taskId ? artifactsByTaskId.get(message.taskId) || [] : [];
    const referenced = owned.length ? owned : referencedArtifactsForDownloadReply(message.content, artifacts);
    if (referenced.length) artifactsByAssistantMessage.set(message.id, referenced);
  }
  const usersWithAssistant = new Set<string>();
  const latestResponseUserId = userMessages.at(-1)?.id ?? null;
  let responseUserId: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      responseUserId = message.id;
      continue;
    }
    if (!responseUserId) continue;
    usersWithAssistant.add(responseUserId);
    const timeline = timelineByUserMessage.get(responseUserId);
    if (timeline?.length) timelineByAssistantMessage.set(message.id, timeline);
    responseUserId = null;
  }
  const pendingTimelineEvents = latestResponseUserId && !usersWithAssistant.has(latestResponseUserId) ? timelineByUserMessage.get(latestResponseUserId) : undefined;
  const directRemoteAppendUserMessageIds = new Set([...timelineByUserMessage]
    .filter(([, ownedEvents]) => isDirectRemoteAppendTimeline(ownedEvents))
    .map(([userMessageId]) => userMessageId));
  const latestResponseTaskSettled = latestConversationTask?.sourceMessageId === latestResponseUserId
    && ["completed", "failed", "cancelled", "interrupted"].includes(latestConversationTask.status);
  const latestResponseWebRunEvents = latestWebRunEvents(pendingTimelineEvents || []);
  const latestResponseRunSettled = latestResponseWebRunEvents.some((event) =>
    ["run.persisted", "run.suspended", "run.failed", "run.aborted", "run.superseded"].includes(event.kind),
  );
  const pendingWorkHandoff = activeMode === "work"
    && Boolean(latestResponseUserId)
    && !usersWithAssistant.has(latestResponseUserId!)
    && !activeTask
    && !latestResponseTaskSettled
    && !latestResponseRunSettled;
  const orphanTimelineByUserMessage = new Map(
    [...timelineByUserMessage].filter(([userMessageId]) => userMessageId !== latestResponseUserId && !usersWithAssistant.has(userMessageId)),
  );
  const showPendingAssistant = Boolean(visibleStreamingFinal || pendingTimelineEvents?.length);
  const retryableAssistantMessageId = latestAssistantPosition > latestUserPosition ? latestAssistant : null;
  const retryableUserMessageId = latestResponseUserId
    && !usersWithAssistant.has(latestResponseUserId)
    && !activeTask
    && (latestResponseTaskSettled || latestResponseRunSettled)
    ? latestResponseUserId
    : null;
  // A persisted assistant message is written only after its remote Task has
  // reached a terminal state.  Use that durable relationship while the Task
  // list is still hydrating so a history reload never paints every finished
  // Agent call as running for several seconds.
  const settledTaskIds = new Set(messages
    .filter((message) => message.role === "assistant" && Boolean(message.taskId))
    .map((message) => String(message.taskId)));

  const visibleExpandedRecordId = expandedRecordId;

  useLayoutEffect(() => {
    const node = scroll.current;
    const content = messageContent.current;
    if (!node || !content || !conversationId || loading || initialPanel) return;
    return followConversationScroll(node, content, conversationScrollPositions.get(conversationId),
      (position) => conversationScrollPositions.set(conversationId, position));
  }, [conversationId, initialPanel, loading]);

  if (loading) return <LoadingState label="正在载入对话" />;

  const panelLabel = initialPanel?.kind === "file" ? "文件" : initialPanel?.kind === "task" ? "任务" : initialPanel?.kind === "artifact" ? "产物" : "变更";
  const taskInputAvailable = !pendingWorkHandoff && (!activeTask
    || (activeTask.status === "running" && agentOperationAvailable(selectedAgent, "append")));
  const taskPlaceholder = pendingWorkHandoff
    ? "正在思考…"
    : activeTask?.status === "running" && !agentOperationAvailable(selectedAgent, "append")
    ? "当前 Agent 不支持运行中追加"
    : "继续当前工作";
  const conversationWorkConnected = activeMode !== "work" || Boolean(selectedServer?.status === "connected" && conversationConnectionEnabled);
  const openConversationConnection = () => {
    if (!serverBindingLoading) setConnectionDialogOpen(true);
  };
  const toggleWorkspaceDirectory = async () => {
    if (!conversationId) return;
    if (workspaceDirectoryActive) {
      const returnToConversation = () => runtime.setWorkspaceSidebar(null);
      if (workspacePreviewRef.current) workspacePreviewRef.current.requestCloseAll(returnToConversation);
      else returnToConversation();
      return;
    }
    if (workspaceDirectoryLoading) return;
    setWorkspaceDirectoryLoading(true);
    let nextServerId = serverId;
    let nextWorkspaceId = routedWorkspaceId;
    let nextWorkspacePath = workbenchWorkspacePath;
    try {
      const snapshot = await syncConversationWorkspaceRoute({
        mode: activeMode,
        targetConversationId: conversationId,
        branchId: detail?.summary.activeBranchId,
        targetServerId: boundServerId,
        connectionEnabled: conversationConnectionEnabled && selectedServer?.status === "connected",
      });
      if (snapshot) {
        nextServerId = boundServerId;
        nextWorkspaceId = snapshot.binding.workspaceId;
        nextWorkspacePath = snapshot.workspace.canonicalPath;
      }
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "工作区读取失败", "error");
      return;
    } finally {
      setWorkspaceDirectoryLoading(false);
    }
    if (!nextServerId || !nextWorkspaceId || nextWorkspaceId === VIRTUAL_WORKSPACE || !nextWorkspacePath || !serverCapabilities?.features.remoteFiles.available || !serverCapabilities.features.remoteFiles.list) {
      notify("实际工作区尚未分配完成，请稍后重试", "error");
      return;
    }
    runtime.setWorkspaceSidebar({
      conversationId,
      serverId: nextServerId,
      workspaceId: nextWorkspaceId,
      workspacePath: nextWorkspacePath,
      branchId: detail?.summary.activeBranchId,
      capabilities: serverCapabilities,
    });
  };
  const expandedWorkHeader = Boolean(
    !isEmpty
      && activeMode === "work"
      && serverId
      && selectedServer?.status === "connected"
      && conversationConnectionEnabled,
  );
  return <div className={`${styles.view} ${runtime.rightRailOpen && conversationId ? styles.withRail : ""}`}>
    <section className={styles.stage}>
      <div className={`${styles.stageContent} ${initialPanel ? styles.stageWithPanel : ""} ${expandedWorkHeader ? styles.stageWithExpandedWorkHeader : ""}`}>
      {isEmpty ? <div className={styles.modeSwitch} role="group" aria-label="选择对话类型"><button className={`${styles.modeButton} ${mode === "chat" ? styles.selected : ""}`} onClick={() => setMode("chat")}><MessageCircle size={14} />聊天</button><button className={`${styles.modeButton} ${mode === "work" ? styles.selected : ""}`} onClick={() => setMode("work")}><Terminal size={14} />工作</button></div> : <header className={`${styles.header} ${expandedWorkHeader ? styles.expandedWorkHeader : ""}`}>
        <span className={styles.modeControl}>
          {activeMode === "work" ? <button type="button" className={styles.modePill} aria-pressed={workspaceDirectoryActive} aria-busy={workspaceDirectoryLoading} disabled={workspaceDirectoryLoading || (!workspaceDirectoryActive && (!boundServerId || !conversationConnectionEnabled || selectedServer?.status !== "connected"))} onClick={() => void toggleWorkspaceDirectory()}><Terminal size={15} />工作</button> : <span className={`${styles.modePill} ${styles.modePillStatic}`}><MessageCircle size={15} />聊天</span>}
        </span>
        <span className={styles.headerSpacer} />
        {activeMode === "work" ? <>
          {serverId && selectedServer?.status === "connected" && conversationConnectionEnabled && workbenchAvailable ? <button className={styles.workbenchButton} disabled={!workbenchReady} aria-expanded={workbenchOpen} onClick={() => setWorkbenchOpen(true)}><SquareTerminal size={15} />工作台</button> : null}
          {serverId && selectedServer?.status === "connected" && conversationConnectionEnabled ? <span className={styles.agentHeaderControl}><AgentControl
            serverId={serverId}
            agents={effectiveAgentOptions}
            selectedAgentId={routedAgentId}
            bindingId={selectedAgentBindingId}
            bindingIdsByAgent={bindingIdsByAgent}
            contextRevision={selectedAgentContextRevision}
            cacheScope={configScope}
            workspacePath={workbenchWorkspacePath}
            disabled={Boolean(activeTask) || pendingWorkHandoff}
            canConfigure={Boolean(serverCapabilities?.features.agents.configure)}
            installingAgentId={installingAgent}
            onSelect={switchAgent}
            onInstall={installAgent}
            onManualAdd={() => setManualAgentOpen(true)}
            onConfigure={(agent) => setAgentConfigAgentId(agent.agentId)}
            onAgentsChanged={refreshAgents}
            triggerLabel={!selectedAgent && routedAgentId ? AGENT_LABELS[routedAgentId] ?? routedAgentId : undefined}
            loading={setupLoading && !selectedAgent}
            loadError={agentLoadError || capabilityError}
            onRetry={() => setSetupRetryRevision((revision) => revision + 1)}
          /></span> : null}
          {!runtime.rightRailOpen ? <button className={`${styles.connection} ${selectedServer?.status !== "connected" || !conversationConnectionEnabled ? styles.off : ""}`} aria-label={selectedServer?.status === "connected" && conversationConnectionEnabled ? "远程服务器已连接，打开连接详情" : "远程服务器未连接，打开连接设置"} disabled={serverBindingLoading} onClick={openConversationConnection}>{serverBindingLoading ? <LoaderCircle className={styles.spin} size={14} /> : selectedServer?.status === "connected" && conversationConnectionEnabled ? <Wifi size={14} /> : <WifiOff size={14} />}{serverBindingLoading ? "读取中" : selectedServer?.status === "connected" && conversationConnectionEnabled ? "已连接" : "未连接"}</button> : null}
        </> : null}
      </header>}
      {conversationId && initialPanel ? <div className={styles.mainTabs}><button onClick={() => runtime.navigate({ kind: "conversation", conversationId })}>对话</button><span className={styles.activeMainTab}>{panelLabel}<button aria-label={`关闭${panelLabel}`} onClick={() => runtime.navigate({ kind: "conversation", conversationId })}><X size={13} /></button></span></div> : null}
      {conversationId && initialPanel ? <ConversationObjectPanel panel={initialPanel} /> : isEmpty ? <div className={styles.empty}><div className={styles.emptyInner}>
        <h1 className={styles.emptyTitle}>{projectContextName ? `我们应该在${projectContextName}中做些什么？` : mode === "work" ? "准备好后，开始工作" : "有什么可以帮你？"}</h1>
        <div className={styles.emptyComposer}><Composer key={`new:${initialProjectId ?? "standalone"}:${mode}`} conversationId={conversationId} draftKey={`new:${initialProjectId ?? "standalone"}:${mode}`} disabled={!workReady} placeholder={mode === "work" ? workReady ? "描述要在远端完成的工作" : "请先完成工作环境设置" : "给 EasyWork 发消息"} onSend={send} /></div>
        {mode === "work" ? <>
          <div className={styles.setup}>
            <button className={`${styles.setupStep} ${serverId ? styles.done : ""}`} onClick={() => setConnectionDialogOpen(true)}><Server size={16} />{selectedServer ? selectedServer.name : "连接远程服务器"}</button>
            {serverId && (setupLoading || agentsAvailable) ? setupLoading ? <button className={styles.setupStep} disabled><LoaderCircle className={styles.spin} size={16} />正在扫描 Agent</button> : <AgentControl
              serverId={serverId}
              agents={effectiveAgentOptions}
              selectedAgentId={agentId}
              bindingId={selectedAgentBindingId}
              bindingIdsByAgent={bindingIdsByAgent}
              contextRevision={selectedAgentContextRevision}
              cacheScope={configScope}
              workspacePath={workspacePath ?? selectedWorkspace?.canonicalPath ?? null}
              installingAgentId={installingAgent}
              canConfigure={Boolean(serverCapabilities?.features.agents.configure)}
              triggerVariant="setup"
              triggerLabel={selectedAgent?.installed && selectedAgent.status === "ready" && (!selectedAgent.managed || selectedAgent.configured) ? `${selectedAgent.displayName}${selectedAgent.model ? ` · ${selectedAgent.model}` : ""}` : "配置 Agent"}
              initialPage={selectedAgent?.installed && selectedAgent.status === "ready" ? "config" : "root"}
              onSelect={async (nextAgentId) => { choose("agent", nextAgentId); }}
              onInstall={installAgent}
              onManualAdd={() => setManualAgentOpen(true)}
              onConfigure={(agent) => setAgentConfigAgentId(agent.agentId)}
              onAgentsChanged={refreshAgents}
              loadError={agentLoadError || capabilityError}
              onRetry={() => setSetupRetryRevision((revision) => revision + 1)}
            /> : null}
            {agentId && selectedAgent?.installed && selectedAgent.status === "ready" && (!selectedAgent.managed || selectedAgent.configured) && workspacesAvailable ? <button className={`${styles.setupStep} ${workspace ? styles.done : ""}`} onClick={() => setWorkspacePickerOpen(true)}><FolderOpen size={16} />{workspace === VIRTUAL_WORKSPACE ? "虚拟工作区" : workspacePath ?? selectedWorkspace?.canonicalPath ?? "设置工作区"}</button> : null}
          </div>
          {serverId && !setupLoading && (capabilityError || agentLoadError || workspaceLoadError) ? <div className={styles.setupUnavailable}><span>{capabilityError || agentLoadError || workspaceLoadError}</span><button onClick={() => setSetupRetryRevision((revision) => revision + 1)}>重试</button></div> : null}
          {serverId && !setupLoading && !capabilityError && !agentLoadError && !workspaceLoadError && !agentsAvailable ? <div className={styles.setupUnavailable}>当前服务器不支持 Agent 工作</div> : null}
        </> : null}
      </div><div className={styles.emptyDisclaimer}>EasyWork 可能会出错，请核对重要信息。</div></div> : <>
        <div className={styles.messages} ref={scroll}><div className={styles.messageList} ref={messageContent}>
          {messages.map((message, messageIndex) => {
            const directRemoteAppendTurn = message.role === "user" && directRemoteAppendUserMessageIds.has(message.id);
            const nextMessage = messages[messageIndex + 1];
            const beforeDirectRemoteAppendTurn = nextMessage?.role === "user" && directRemoteAppendUserMessageIds.has(nextMessage.id);
            return <div className={`${styles.turn} ${directRemoteAppendTurn ? styles.directRemoteAppendTurn : ""} ${beforeDirectRemoteAppendTurn ? styles.beforeDirectRemoteAppendTurn : ""}`} key={message.id}>
              <Message message={message} latestAssistant={message.id === retryableAssistantMessageId} retryableUser={message.id === retryableUserMessageId} revision={summary?.revision ?? 0} timelineEvents={timelineByAssistantMessage.get(message.id)} artifacts={artifactsByAssistantMessage.get(message.id)} timelineLoading={activeMode === "work" && Boolean(message.taskId) && !eventsHydrated} timelineMode={activeMode} taskById={tasks} settledTaskIds={settledTaskIds} response={responseDescriptor} onApproval={respondApproval} onInput={respondInput} onBranchCreated={openBranchedConversation} onChanged={reload} />
              {message.role === "user" && orphanTimelineByUserMessage.has(message.id) ? <article className={`${styles.message} ${styles.assistant}`}>{isDirectRemoteAppendTimeline(orphanTimelineByUserMessage.get(message.id) || []) ? null : <div className={styles.messageHead}><span className={styles.dot} /> EasyWork</div>}<ConversationTimeline events={orphanTimelineByUserMessage.get(message.id) || []} mode={activeMode} taskById={tasks} settledTaskIds={settledTaskIds} onApproval={respondApproval} onInput={respondInput} /><ConversationArtifactCards events={orphanTimelineByUserMessage.get(message.id) || []} /></article> : null}
            </div>;
          })}
          {showPendingAssistant ? <article key={classifiedOutput.streamingKey || "streaming-response"} className={`${styles.message} ${styles.assistant} ${styles.streamingMessage}`}>{isDirectRemoteAppendTimeline(pendingTimelineEvents || []) ? null : <div className={styles.messageHead}><span className={styles.dot} /> EasyWork</div>}{pendingTimelineEvents?.length ? <ConversationTimeline events={pendingTimelineEvents} mode={activeMode} taskById={tasks} settledTaskIds={settledTaskIds} onApproval={respondApproval} onInput={respondInput} /> : null}{visibleStreamingFinal ? <div className={styles.assistantBody}><MarkdownContent content={visibleStreamingFinal} /></div> : null}<ConversationArtifactCards events={pendingTimelineEvents || []} /></article> : null}
        </div></div>
        <div className={styles.composerWrap}><Composer conversationId={conversationId} draftKey={`conversation:${conversationId}`} disabled={activeMode === "work" && (!taskInputAvailable || !conversationWorkConnected)} activeTask={activeMode === "work" ? activeTask : undefined} pendingWebRun={activeMode === "work" && pendingWorkHandoff} canInterrupt={pendingWorkHandoff || agentOperationAvailable(selectedAgent, "interrupt")} onInterrupt={interrupt} placeholder={activeMode === "work" ? conversationWorkConnected ? taskPlaceholder : "请先连接远程服务器" : "继续对话"} onSend={send} /></div>
      </>}
      {conversationId ? <ConversationWorkspacePreview ref={workspacePreviewRef} conversationId={conversationId} /> : null}
      </div>
      {workbenchOpen && workbenchReady && serverId && routedWorkspaceId && workbenchWorkspacePath ? <Suspense fallback={null}><WorkbenchDrawer serverId={serverId} workspaceId={routedWorkspaceId} workspacePath={workbenchWorkspacePath} conversationId={conversationId} height={workbenchHeight} onHeightChange={setWorkbenchHeight} onClose={() => setWorkbenchOpen(false)} /></Suspense> : null}
      {!activeTask && agentConfigAgentId && serverId && effectiveAgentOptions.find((agent) => agent.agentId === agentConfigAgentId) && serverCapabilities?.features.agents.configure ? <AgentConfigDialog serverId={serverId} configScope={configScope} agent={effectiveAgentOptions.find((agent) => agent.agentId === agentConfigAgentId)!} onChanged={refreshAgents} onClose={() => setAgentConfigAgentId(null)} /> : null}
      {workspacePickerOpen && serverId && agentId ? <WorkspaceDialog serverId={serverId} serverName={selectedServer?.name || "远程服务器"} conversationId={conversationId} branchId={detail?.summary.activeBranchId} options={workspaceOptions} current={workspace} allowVirtual={Boolean(serverCapabilities?.features.workspaces.virtual)} busy={switchingWorkspace} onClose={() => setWorkspacePickerOpen(false)} onSelect={async (nextWorkspaceId, nextWorkspace, nextWorkspacePath) => { if (nextWorkspace) setWorkspaceOptions((current) => current.some((item) => item.id === nextWorkspace.id) ? current : [...current, nextWorkspace]); if (conversationId) await switchWorkspace(nextWorkspaceId, nextWorkspace); else { choose("workspace", nextWorkspaceId, nextWorkspacePath); setWorkspacePickerOpen(false); } }} /> : null}
      {routeSwitchConfirmation ? <Modal title={routeSwitchConfirmation === "workspace" ? "切换工作区？" : "切换 Agent？"} size="compact" onClose={() => settleRouteSwitchConfirmation(false)}><div className={styles.modeConfirm}><p>{routeSwitchConfirmation === "workspace" ? "切换后会更换当前 Agent 会话，网页对话内容和记忆仍会完整保留。" : "切换后会更换原生 Agent 会话；网页对话记忆会保留，再次使用该 Agent 时仅补发它尚未收到的内容。"}</p><footer><Button onClick={() => settleRouteSwitchConfirmation(false)}>取消</Button><Button variant="primary" onClick={() => settleRouteSwitchConfirmation(true)}>确认切换</Button></footer></div></Modal> : null}
      {connectionDialogOpen ? <ConversationConnectionDialog selectedServerId={serverId} conversationId={conversationId} conversationEnabled={conversationConnectionEnabled} conversationScoped={Boolean(conversationId && boundServerId)} onClose={() => setConnectionDialogOpen(false)} onChanged={async () => { await refreshBootstrap(); }} onConversationConnectionChanged={async (enabled, connectedId) => { setConversationConnectionEnabled(enabled); if (connectedId) { setBoundServerId(connectedId); setServerId(connectedId); } }} onConnected={async (connectedId) => { await refreshBootstrap(); if (!conversationId) choose("server", connectedId); else setServerId(connectedId); }} /> : null}
      {manualAgentOpen && serverId ? <ManualAgentDialog serverId={serverId} agents={effectiveAgentOptions} onClose={() => setManualAgentOpen(false)} onAdded={async (nextAgentId) => { await refreshAgents(); if (!conversationId) choose("agent", nextAgentId); }} /> : null}
    </section>
    {conversationId && runtime.rightRailOpen ? <aside className={`${styles.rail} ${activeMode === "chat" ? styles.chatRail : ""}`}>
      {activeMode === "work" ? <>
        <section className={`${styles.railCard} ${selectedServer?.status === "connected" && conversationConnectionEnabled ? styles.railConnected : styles.railDisconnected}`}>
          <div className={styles.railConnectionHeading}><span>远程连接</span><span className={styles.railConnectionState}><i />{selectedServer?.status === "connected" && conversationConnectionEnabled ? "已连接" : "未连接"}</span></div>
          <strong className={styles.railValue}>{selectedServer?.name || "未连接"}</strong>
          <span className={styles.railSub}>{selectedServer ? selectedServer.status === "connected" && conversationConnectionEnabled ? `${selectedServer.username}@${selectedServer.host}` : selectedServer.host : ""}</span>
          <div className={styles.railActions}>
            <button disabled={serverBindingLoading} onClick={openConversationConnection}>{selectedServer?.status === "connected" && conversationConnectionEnabled ? <Wifi size={14} /> : <WifiOff size={14} />}连接</button>
          </div>
        </section>
        <section className={styles.railCard}>
          <div className={styles.railTitle}><span>当前工作区</span><button className={styles.railAction} disabled={!serverId || !agentId || switchingWorkspace} onClick={() => setWorkspacePickerOpen(true)}>{switchingWorkspace ? "切换中" : "更改"}</button></div>
          <div className={`${styles.railValue} ${styles.railWorkspaceValue}`} title={workbenchWorkspacePath ?? undefined}>{workbenchWorkspacePath ?? (workspace === VIRTUAL_WORKSPACE ? "正在分配工作区…" : "未设置")}</div>
        </section>
      </> : null}
      <section className={`${styles.railCard} ${styles.recordList}`}><div className={styles.railTitle}>对话记录</div><div className={styles.records}>{userRecords.map(({ message, task }) => {
        const hasPlan = Boolean(task && Array.isArray(task.plan) && task.plan.length > 0);
        const expanded = hasPlan && visibleExpandedRecordId === message.id;
        return <div className={styles.recordEntry} key={message.id}>
          <div className={`${styles.recordHead} ${hasPlan ? styles.recordHeadExpandable : ""}`}>
            <button className={styles.record} onClick={() => document.getElementById(`message-${message.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{message.content}</button>
            {hasPlan ? <button className={styles.recordExpand} aria-label={expanded ? "收起任务流程" : "展开任务流程"} aria-expanded={expanded} onClick={() => setExpandedRecordId(expanded ? null : message.id)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : null}
          </div>
          {hasPlan && task && expanded ? <div className={`${styles.recordPlan} ${styles.recordPlanOpen}`}><div><TaskPlanList task={task} /></div></div> : null}
        </div>;
      })}</div></section>
    </aside> : null}
    {conversationId ? <button className={styles.railToggle} aria-label={runtime.rightRailOpen ? "收起对话记录" : "展开对话记录"} onClick={() => runtime.setRightRailOpen(!runtime.rightRailOpen)}>{runtime.rightRailOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}</button> : null}
  </div>;
}

export default function ConversationView(props: Props) {
  const key = props.conversationId ?? `draft:${props.initialProjectId ?? "standalone"}:${props.initialMode ?? "chat"}`;
  return <ConversationScreen key={key} {...props} />;
}
