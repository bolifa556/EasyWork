"use client";

import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Brain,
  Cable,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Edit3,
  FolderOpen,
  GitBranch,
  KeyRound,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Plus,
  RotateCcw,
  Send,
  Server,
  Square,
  TerminalSquare,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type { AgentSummary, ConversationDetail, ConversationMessage, ConversationSummary, RealtimeEnvelope, ServerCapabilityProfile, ServerSummary, TaskSummary, WorkDraftSelection, WorkDraftSnapshot, WorkspaceSummary } from "@/app/core/contracts";
import { GatewayError } from "@/app/core/contracts";
import { commandId } from "@/app/core/gateway/client";
import { uploadResource } from "@/app/core/gateway/resource-upload";
import { useAppRuntime, type ConversationPanel } from "../../runtime/AppRuntime";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import { ProgressRing } from "../../ui/ProgressRing";
import { WebContextDialog } from "./WebContextDialog";
import { AgentConfigDialog } from "./AgentConfigDialog";
import { ConversationObjectPanel } from "./ConversationObjectPanel";
import { AgentControl, AgentSelectionList } from "./AgentControl";
import { ComposerResourceChips, ComposerResources, emptyComposerResources, type ComposerResourceSelection } from "./ComposerResources";
import { classifyConversationOutput, ConversationTimeline, TaskPlanSummary } from "./ConversationTimeline";
import { MarkdownContent } from "./MarkdownContent";
import { ServerEditor } from "../servers/ServerManager";
import styles from "./ConversationView.module.css";

type Props = { conversationId?: string; initialProjectId?: string; initialMode?: Mode; initialPanel?: ConversationPanel };
type Mode = "chat" | "work";
type ResponseDescriptor = { providerId: string; modelId: string; scope: Record<string, unknown> };
type WebModelSelection = { providerId: string; modelId: string };
type ConversationRoute = { serverId: string; agentId: string; workspaceId: string; workspacePath?: string };
type ConversationServerBinding = { conversationId: string; serverId: string | null };
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
const VIRTUAL_WORKSPACE = "__virtual__";
const WorkbenchDrawer = lazy(() => import("../workbench/WorkbenchDrawer"));
const conversationScrollPositions = new Map<string, number>();

function storedRoute(conversationId?: string): Partial<ConversationRoute> {
  if (typeof window === "undefined" || !conversationId) return {};
  const key = `easywork.conversation-route:${conversationId}`;
  try { return JSON.parse(localStorage.getItem(key) || "{}") as Partial<ConversationRoute>; }
  catch { return {}; }
}

function agentOperationAvailable(agent: AgentSummary | undefined, operation: "append" | "interrupt" | "resume") {
  return agent?.runtimeCapabilities?.[operation]?.availability === "available";
}

function Message({ message, latestUser, latestAssistant, revision, workMode, response, onBranchCreated, onChanged }: { message: ConversationMessage; latestUser: boolean; latestAssistant: boolean; revision: number; workMode: boolean; response: () => ResponseDescriptor; onBranchCreated?: (branchId: string) => Promise<void>; onChanged: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const user = message.role === "user";
  const workMutationUnavailable = "工作区文件版本回退不可用，不能安全执行此操作";
  const copy = () => void navigator.clipboard.writeText(message.content).then(() => runtime.notify("已复制", "success"));
  const action = async (name: "edit-latest" | "retry" | "branch" | "rewind") => {
    if ((name === "branch" || name === "rewind") && !window.confirm(name === "branch" ? "从这里建立一个新分支？" : "清除这条回复之后的对话记忆与工作区修改？")) return;
    const actionBody = name === "branch"
      ? { action: name, sourceBranchId: message.branchId, atMessageId: message.id }
      : name === "rewind"
        ? { action: name, branchId: message.branchId, toMessageId: message.id }
        : { action: name, branchId: message.branchId, messageId: message.id, response: response(), ...(name === "edit-latest" ? { content: draft } : {}) };
    try {
      const idempotencyKey = commandId(name);
      const submit = (expectedRevision: number) => runtime.api.post<{ branch?: { id: string } }>(
        `/api/conversations/${message.conversationId}/actions`,
        actionBody,
        { expectedRevision, idempotencyKey },
      );
      let result;
      try {
        result = await submit(revision);
      } catch (reason) {
        if (!(reason instanceof GatewayError) || reason.code !== "REVISION_CONFLICT") throw reason;
        const latest = await runtime.api.get<ConversationDetail>(`/api/conversations/${encodeURIComponent(message.conversationId)}`);
        result = await submit(latest.data.summary.revision);
      }
      if (name === "branch" && result.data.branch?.id && onBranchCreated) await onBranchCreated(result.data.branch.id);
      setEditing(false);
      await onChanged();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "操作失败", "error");
    }
  };
  return <article className={`${styles.message} ${user ? styles.user : styles.assistant}`} id={`message-${message.id}`}>
    <div className={styles.messageHead}>{user ? <>你 <span className={styles.dot} /></> : <><span className={styles.dot} /> EasyWork</>}</div>
    {editing ? <div className={styles.editBox}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} /><div className={styles.editActions}><Button compact variant="ghost" onClick={() => setEditing(false)}>取消</Button><Button compact variant="primary" onClick={() => void action("edit-latest")}>发送</Button></div></div> : user ? <div className={styles.userBubble}>{message.content}</div> : <div className={styles.assistantBody}><MarkdownContent content={message.content} /></div>}
    {!editing ? <div className={styles.messageActions}>
      <Button compact iconOnly variant="ghost" aria-label="复制" icon={<Copy size={15} />} onClick={copy} />
      {user && latestUser ? <Button compact iconOnly variant="ghost" disabled={workMode} title={workMode ? workMutationUnavailable : undefined} aria-label="编辑" icon={<Edit3 size={15} />} onClick={() => setEditing(true)} /> : null}
      {!user ? <>{latestAssistant ? <Button compact iconOnly variant="ghost" disabled={workMode} title={workMode ? workMutationUnavailable : undefined} aria-label="重试" icon={<RotateCcw size={15} />} onClick={() => void action("retry")} /> : null}<Button compact iconOnly variant="ghost" aria-label="分支" icon={<GitBranch size={15} />} onClick={() => void action("branch")} /><Button compact iconOnly variant="ghost" disabled={workMode} title={workMode ? workMutationUnavailable : undefined} aria-label="回溯" icon={<ChevronLeft size={15} />} onClick={() => void action("rewind")} /></> : null}
    </div> : null}
  </article>;
}

function Composer({ conversationId, draftKey, disabled, placeholder, activeTask, canInterrupt, onInterrupt, onSend }: { conversationId?: string; draftKey: string; disabled?: boolean; placeholder: string; activeTask?: TaskSummary; canInterrupt?: boolean; onInterrupt?: () => Promise<void>; onSend: (value: string, resources: ComposerResourceSelection, selection: WebModelSelection) => Promise<void> }) {
  const runtime = useAppRuntime();
  const storageKey = `easywork.composer-draft:${runtime.bootstrap?.actor.id ?? "unresolved"}:${draftKey}`;
  const [value, setValue] = useState(() => typeof window === "undefined" ? "" : sessionStorage.getItem(storageKey) || "");
  const [busy, setBusy] = useState(false);
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
  const [contextRatio, setContextRatio] = useState<number | null>(null);
  const [resources, setResources] = useState<ComposerResourceSelection>(emptyComposerResources);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const provider = runtime.bootstrap?.providers.find((item) => item.id === providerId) ?? runtime.bootstrap?.providers[0];
  const model = modelId || "选择模型";
  const inspectProvider = async (id: string) => {
    setProviderId(id); setModelId(""); setProviderPage(true); setModels([]);
    setModelsLoading(true); setModelError(null);
    localStorage.setItem("easywork.web-provider", id);
    localStorage.removeItem("easywork.web-model");
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
    if (chosenProviderId) localStorage.setItem("easywork.web-provider", chosenProviderId);
    setModelOpen(false); setProviderPage(false);
  };
  const refreshContextRatio = useCallback(async () => {
    if (!conversationId) { setContextRatio(null); return; }
    try {
      const result = await runtime.api.get<{ usage: { usedTokens: number; limitTokens: number; ratio?: number } }>(`/api/conversations/${encodeURIComponent(conversationId)}/context`);
      const ratio = result.data.usage.ratio ?? (result.data.usage.limitTokens > 0 ? result.data.usage.usedTokens / result.data.usage.limitTokens : 0);
      setContextRatio(Math.max(0, Math.min(1, ratio)));
    } catch { setContextRatio(null); }
  }, [conversationId, runtime.api]);
  const send = async () => {
    if (!value.trim() || busy || disabled) return;
    const prompt = value.trim();
    setBusy(true);
    try {
      const chosenProviderId = providerId ?? provider?.id;
      if (!chosenProviderId) throw new Error("请先配置网页模型 API");
      if (!modelId) throw new Error("请先选择网页对话模型");
      await onSend(prompt, resources, { providerId: chosenProviderId, modelId });
      setValue("");
      setResources(emptyComposerResources);
      sessionStorage.removeItem(storageKey);
      setExpanded(false);
      setMultiline(false);
      await refreshContextRatio();
    } catch (reason) {
      runtime.notify(reason instanceof Error ? reason.message : "消息发送失败", "error");
    } finally { setBusy(false); }
  };
  useEffect(() => {
    const handle = window.setTimeout(() => void refreshContextRatio(), 0);
    return () => window.clearTimeout(handle);
  }, [refreshContextRatio]);
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
  return <div className={styles.composer}>
    <div className={`${styles.box} ${multiline ? styles.boxMultiline : ""} ${expanded ? styles.boxExpanded : ""} ${hasResources ? styles.boxWithResources : ""}`}>
      {hasResources ? <div className={styles.resourceChips}><ComposerResourceChips value={resources} onChange={setResources} /></div> : null}
      <div className={styles.composerAdd}><ComposerResources value={resources} disabled={disabled || busy} onChange={setResources} /></div>
      <textarea ref={textarea} className={styles.textarea} value={value} disabled={disabled || busy} placeholder={placeholder} rows={1} onChange={(event) => {
        const next = event.target.value;
        setValue(next);
        if (!next) { setMultiline(false); setExpanded(false); }
        else if (event.target.scrollHeight > 32) setMultiline(true);
      }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
      <button className={styles.model} onClick={() => { setModelOpen((open) => !open); setProviderPage(false); }}><span className={styles.modelName}>{model}</span>{contextRatio == null ? null : <ProgressRing size={16} value={contextRatio} color="purple" />}<ChevronDown size={14} /></button>
      <div className={styles.composerSendSlot}>
        {activeTask && ["running", "waiting_approval", "waiting_append"].includes(activeTask.status) && onInterrupt ? <button className={styles.stop} disabled={!canInterrupt} title={canInterrupt ? undefined : "当前 Agent 不支持中断"} aria-label="中断当前任务" onClick={() => void onInterrupt()}><Square size={14} fill="currentColor" /></button> : null}
        <button className={styles.send} disabled={!value.trim() || disabled || busy} aria-label={busy ? "停止" : "发送"} onClick={() => void send()}>{busy ? <Square size={16} fill="currentColor" /> : <Send size={17} />}</button>
      </div>
      {value && (expanded || canExpand) ? <Button className={styles.expand} compact iconOnly variant="ghost" aria-label={expanded ? "收回编辑器" : "展开编辑器"} icon={expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />} onClick={() => setExpanded((state) => !state)} /> : null}
      {modelOpen ? <div className={styles.modelMenu}>
        <div className={styles.modelMenuHead}>{providerPage ? <Button compact iconOnly variant="ghost" aria-label="返回 API" icon={<ChevronLeft size={15} />} onClick={() => setProviderPage(false)} /> : null}<span>{providerPage ? provider?.name || "模型" : "选择 API"}</span></div>
        <div className={styles.modelList}>{providerPage ? modelsLoading ? <div className={styles.modelState}><LoaderCircle className={styles.spin} size={15} />正在读取模型</div> : modelError ? <div className={styles.modelState}><span>{modelError}</span><button onClick={() => provider && void inspectProvider(provider.id)}>重新检测</button></div> : models.length ? models.map((item) => <button key={item.id} className={`${styles.modelOption} ${modelId === item.id ? styles.selected : ""}`} onClick={() => chooseModel(item.id)}><span>{item.name}</span>{modelId === item.id ? <Check size={15} /> : null}</button>) : <div className={styles.modelState}>没有检测到可用模型</div> : runtime.bootstrap?.providers.map((item) => <button key={item.id} className={`${styles.modelOption} ${styles.providerOption}`} onClick={() => void inspectProvider(item.id)}><span className={styles.providerCopy}><strong>{item.name}</strong><small>{item.baseUrl || (item.source === "platform" ? "管理员提供" : "个人 API")}</small></span><ChevronRight size={15} /></button>)}</div>
        <div className={styles.modelManage}><Button compact variant="ghost" icon={<Brain size={15} />} onClick={() => { setModelOpen(false); setContextOpen(true); }}>管理网页对话上下文</Button></div>
      </div> : null}
    </div>
    {contextOpen ? <WebContextDialog conversationId={conversationId} onClose={() => setContextOpen(false)} /> : null}
  </div>;
}

function DraftConnectDialog({ server, onClose, onConnected }: { server: ServerSummary; onClose: () => void; onConnected: () => Promise<void> }) {
  const runtime = useAppRuntime();
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    try {
      await runtime.api.post(`/api/servers/${encodeURIComponent(server.id)}/connect`, {
        twoFactorCode: twoFactorCode.trim() || null,
        ...(fingerprint ? { acceptedFingerprint: fingerprint } : {}),
      });
      await onConnected();
      runtime.notify("SSH 已连接", "success");
      onClose();
    } catch (reason) {
      if (reason instanceof GatewayError && reason.code === "SSH_HOST_KEY_CONFIRMATION_REQUIRED") {
        const next = reason.details as { fingerprint?: string } | null;
        if (next?.fingerprint) setFingerprint(next.fingerprint);
      } else if (reason instanceof GatewayError && reason.code === "SSH_AUTH_FAILED") {
        runtime.notify("SSH 认证失败，请检查用户名、登录凭据和动态验证码", "error");
      } else runtime.notify(reason instanceof Error ? reason.message : "连接失败", "error");
    } finally { setBusy(false); }
  };
  return <Modal title="连接 SSH" subtitle={`${server.username}@${server.host}:${server.port}`} size="compact" onClose={onClose}><div className={styles.draftConnect}>{fingerprint ? <div className={styles.draftFingerprint}><KeyRound size={21} /><div><strong>确认主机指纹</strong><code>{fingerprint}</code></div></div> : null}<label><span>动态验证码</span><input autoFocus={!fingerprint} inputMode="numeric" value={twoFactorCode} placeholder="可选" onChange={(event) => setTwoFactorCode(event.target.value)} /></label><footer><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} icon={busy ? <LoaderCircle className={styles.spin} size={16} /> : <Cable size={16} />} onClick={() => void connect()}>{busy ? "连接中" : fingerprint ? "确认并连接" : "连接"}</Button></footer></div></Modal>;
}

function DraftServerPicker({ servers, onClose, onSelect, onAdd }: { servers: ServerSummary[]; onClose: () => void; onSelect: (server: ServerSummary) => void; onAdd: () => void }) {
  return <Modal title="连接远程服务器" size="normal" onClose={onClose}>
    <div className={styles.serverPicker}>
      <div className={styles.serverPickerList}>{servers.map((server) => <button key={server.id} type="button" onClick={() => onSelect(server)}>
        <span className={styles.serverPickerIcon}><Server size={18} /></span>
        <span><strong>{server.name}</strong><small>{server.username}@{server.host}:{server.port}</small></span>
        <i className={server.status === "connected" ? styles.serverOnline : undefined}>{server.status === "connected" ? "使用" : server.status === "connecting" ? "连接中" : "连接"}</i>
      </button>)}</div>
      <button type="button" className={styles.serverPickerAdd} onClick={onAdd}><Plus size={17} />添加服务器</button>
    </div>
  </Modal>;
}

function AgentSetupDialog({ agents, selectedAgentId, loading, installingAgentId, onClose, onSelect, onInstall, onManualAdd }: { agents: AgentSummary[]; selectedAgentId: string | null; loading: boolean; installingAgentId: string | null; onClose: () => void; onSelect: (agentId: string) => Promise<void>; onInstall: (agentId: string) => Promise<void>; onManualAdd: () => void }) {
  return <Modal title="配置 Agent" size="compact" panelClassName={styles.setupDialogPanel} onClose={onClose}>
    {loading ? <div className={styles.setupDialogLoading}><LoaderCircle className={styles.spin} size={17} />正在读取远端 Agent</div> : <AgentSelectionList agents={agents} selectedAgentId={selectedAgentId} installingAgentId={installingAgentId} onSelect={async (agentId) => { await onSelect(agentId); onClose(); }} onInstall={onInstall} onManualAdd={onManualAdd} />}
  </Modal>;
}

function WorkspaceSetupDialog({ options, current, allowVirtual, busy, onClose, onSelect }: { options: WorkspaceSummary[]; current: string | null; allowVirtual: boolean; busy?: boolean; onClose: () => void; onSelect: (workspaceId: string) => Promise<void> }) {
  const choices = allowVirtual ? [{ id: VIRTUAL_WORKSPACE, kind: "virtual" as const, canonicalPath: "由 EasyWork 自动分配" }, ...options.filter((item) => item.kind === "user")] : options.filter((item) => item.kind === "user");
  return <Modal title="选择工作区" size="normal" panelClassName={styles.workspaceDialogPanel} onClose={onClose}>
    <div className={styles.workspaceDialogIntro}><FolderOpen size={18} /><span>切换工作区会更换 Agent 原生会话，网页对话记忆仍会保留。</span></div>
    <div className={styles.workspaceDialogList}>{choices.map((item) => <button key={item.id} className={item.id === current ? styles.workspaceCurrent : ""} disabled={busy || item.id === current} onClick={() => void onSelect(item.id)}>
      <FolderOpen size={17} /><span><strong>{item.id === VIRTUAL_WORKSPACE ? "虚拟工作区" : item.canonicalPath.split("/").filter(Boolean).at(-1) || item.canonicalPath}</strong><small>{item.canonicalPath}</small></span>{item.id === current ? <Check size={16} /> : <ChevronRight size={15} />}
    </button>)}</div>
  </Modal>;
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
  const [mode, setMode] = useState<Mode>(initialMode ?? "chat");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [events, setEvents] = useState<RealtimeEnvelope[]>([]);
  const [tasks, setTasks] = useState<Record<string, TaskSummary>>({});
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [setupLoading, setSetupLoading] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [initialRoute] = useState(() => storedRoute(conversationId));
  const [serverId, setServerId] = useState<string | null>(conversationId ? null : initialRoute.serverId ?? null);
  const [agentId, setAgentId] = useState<string | null>(initialRoute.agentId ?? null);
  const [workspace, setWorkspace] = useState<string | null>(initialRoute.workspaceId ?? null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(initialRoute.workspacePath ?? null);
  const [agentOptions, setAgentOptions] = useState<AgentSummary[]>([]);
  const [workspaceOptions, setWorkspaceOptions] = useState<WorkspaceSummary[]>([]);
  const [installingAgent, setInstallingAgent] = useState<string | null>(null);
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [manualAgentOpen, setManualAgentOpen] = useState(false);
  const [connectServerId, setConnectServerId] = useState<string | null>(null);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [boundServerId, setBoundServerId] = useState<string | null>(null);
  const [serverBindingLoading, setServerBindingLoading] = useState(Boolean(conversationId));
  const [disconnectingServer, setDisconnectingServer] = useState(false);
  const [serverCapabilities, setServerCapabilities] = useState<ServerCapabilityProfile | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [expandedRecordId, setExpandedRecordId] = useState<string | null>(null);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const workDraftRevision = useRef(0);
  const workDraftActor = useRef<string | null>(null);
  const workDraftTouched = useRef(false);
  const workDraftWrites = useRef<Promise<void>>(Promise.resolve());
  const scroll = useRef<HTMLDivElement>(null);
  const bootstrapSummary = runtime.bootstrap?.recentConversations.find((item) => item.id === conversationId);
  const summary = bootstrapSummary ?? (detail ? { ...detail.summary, runningTaskId: null } : undefined);
  const activeMode = detail?.summary.mode ?? summary?.mode ?? mode;
  const liveTask = runtime.bootstrap?.runningTasks.find((task) => task.conversationId === conversationId || task.id === summary?.runningTaskId);
  const latestConversationTask = Object.values(tasks)
    .filter((task) => task.conversationId === conversationId)
    .sort((left, right) => (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt))[0];
  const activeTask = liveTask ?? (latestConversationTask?.status === "interrupted" ? latestConversationTask : undefined);
  const isEmpty = !conversationId;
  const selectedServer = runtime.bootstrap?.servers.find((server) => server.id === serverId);
  const selectedAgent = agentOptions.find((agent) => agent.agentId === agentId);
  const selectedWorkspace = workspaceOptions.find((item) => item.id === workspace);
  const selectedBindingTask = useMemo(() => {
    if (activeTask?.route.agentId === agentId && activeTask.route.workspaceId === workspace) return activeTask;
    return Object.values(tasks)
      .filter((task) => task.route.agentId === agentId && task.route.workspaceId === workspace)
      .sort((left, right) => (right.startedAt || right.updatedAt).localeCompare(left.startedAt || left.updatedAt))[0] ?? null;
  }, [activeTask, agentId, tasks, workspace]);
  const selectedAgentBindingId = selectedBindingTask?.agentBindingId ?? null;
  const selectedAgentContextRevision = selectedBindingTask?.revision ?? 0;
  const agentsAvailable = Boolean(serverCapabilities?.features.agents.available && serverCapabilities.features.agents.inspect);
  const workspacesAvailable = Boolean(serverCapabilities?.features.workspaces.available);
  const workbenchAvailable = Boolean(serverCapabilities && [
    serverCapabilities.features.remoteFiles,
    serverCapabilities.features.terminal,
    serverCapabilities.features.versioning,
    serverCapabilities.features.scheduler,
  ].some((feature) => feature.available));
  const workReady = activeMode === "chat" || Boolean(
    serverId
      && selectedServer?.status === "connected"
      && agentId
      && selectedAgent?.installed
      && selectedAgent.status === "ready"
      && agentsAvailable
      && workspace
      && workspacesAvailable,
  );

  const mergeEvents = useCallback((incoming: RealtimeEnvelope[]) => {
    setEvents((current) => {
      const byId = new Map(current.map((event) => [event.eventId, event]));
      for (const event of incoming) byId.set(event.eventId, event);
      return [...byId.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
    });
  }, []);

  const hydrateTaskHistory = useCallback(async () => {
    if (!conversationId) return;
    const listed = await api.get<TaskSummary[]>(`/api/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=1000`);
    const known = [...listed.data];
    if (activeTask && !known.some((task) => task.id === activeTask.id)) known.push(activeTask);
    if (!known.length) return;
    const settled = await Promise.allSettled(known.map(async (task) => {
      const replay = await api.get<{ events: RealtimeEnvelope[] }>(`/api/tasks/${encodeURIComponent(task.id)}/events?limit=2000`);
      return { task, events: replay.data.events };
    }));
    const loadedTasks: Record<string, TaskSummary> = {};
    const history: RealtimeEnvelope[] = [];
    for (const result of settled) if (result.status === "fulfilled") {
      loadedTasks[result.value.task.id] = result.value.task;
      history.push(...result.value.events);
    }
    setTasks((current) => ({ ...current, ...loadedTasks }));
    mergeEvents(history);
  }, [activeTask, api, conversationId, mergeEvents]);

  const fetchConversation = useCallback(async () => {
    if (!conversationId) return { messages: [] as ConversationMessage[], detail: null as ConversationDetail | null };
    const items: ConversationMessage[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await api.get<{ items: ConversationMessage[]; nextCursor?: string | null }>(`/api/conversations/${conversationId}/messages?${query}`);
      items.push(...result.data.items);
      cursor = result.data.nextCursor ?? result.meta.nextCursor ?? null;
    } while (cursor);
    const conversation = await api.get<ConversationDetail>(`/api/conversations/${conversationId}`);
    return { messages: items, detail: conversation.data };
  }, [api, conversationId]);

  const reload = useCallback(async () => {
    const [next] = await Promise.all([fetchConversation(), refreshBootstrap()]);
    setMessages(next.messages);
    setDetail(next.detail);
    setLoading(false);
  }, [fetchConversation, refreshBootstrap]);

  useEffect(() => {
    let active = true;
    void fetchConversation().then(
      (next) => { if (active) { setMessages(next.messages); setDetail(next.detail); setLoading(false); } },
      (error: Error) => { if (active) { setLoading(false); notify(error.message, "error"); } },
    );
    return () => { active = false; };
  }, [fetchConversation, notify]);
  useEffect(() => {
    if (!conversationId) return;
    const controller = new AbortController();
    void api.get<{ events: RealtimeEnvelope[] }>(`/api/conversations/${encodeURIComponent(conversationId)}/events?limit=2000`, controller.signal)
      .then((result) => mergeEvents(result.data.events))
      .catch((reason) => { if (!controller.signal.aborted) notify(reason instanceof Error ? reason.message : "对话活动读取失败", "error"); });
    return () => controller.abort();
  }, [api, conversationId, mergeEvents, notify]);
  useEffect(() => {
    if (!conversationId) return;
    const handle = window.setTimeout(() => void hydrateTaskHistory(), 0);
    return () => window.clearTimeout(handle);
  }, [conversationId, hydrateTaskHistory, messages.length]);
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
        setServerId(null); setAgentId(null); setWorkspace(null); setWorkspacePath(null);
        return;
      }
      setServerId(selection.serverId);
      setAgentId(selection.agentId);
      setWorkspace(selection.workspaceId);
      setWorkspacePath(selection.workspacePath);
    }).catch((reason) => {
      if (active) notify(reason instanceof Error ? reason.message : "工作草稿读取失败", "error");
    });
    return () => { active = false; };
  }, [api, conversationId, mode, notify, runtime.bootstrap?.actor.id, runtime.bootstrap?.servers]);
  useEffect(() => {
    if (!conversationId || !realtime) return;
    return realtime.subscribe(`conversation:${conversationId}`, (event) => {
      mergeEvents([event]);
      if (event.kind === "run.persisted" || event.kind === "message.created") void reload();
      if (event.kind === "run.handoff.dispatched") void refreshBootstrap().catch(() => undefined);
    });
  }, [conversationId, mergeEvents, realtime, refreshBootstrap, reload]);
  useEffect(() => {
    if (!activeTask || !realtime) return;
    return realtime.subscribe(`task:${activeTask.id}`, (event) => {
      mergeEvents([event]);
      if (event.kind === "status" || event.kind === "command") {
        void refreshBootstrap().catch(() => undefined);
        void api.get<TaskSummary>(`/api/tasks/${encodeURIComponent(activeTask.id)}`).then((result) => setTasks((current) => ({ ...current, [result.data.id]: result.data })));
      }
    });
  }, [activeTask, api, mergeEvents, realtime, refreshBootstrap]);

  useEffect(() => {
    if (!serverId) return;
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setSetupLoading(true);
      setServerCapabilities(null);
      setCapabilityError(null);
      setAgentOptions([]);
      setWorkspaceOptions([]);
      try {
        const capabilityResult = await api.get<ServerCapabilityProfile>(`/api/servers/${encodeURIComponent(serverId)}/capabilities`);
        if (!active) return;
        const profile = capabilityResult.data;
        setServerCapabilities(profile);
        const requests: Array<Promise<void>> = [];
        if (profile.features.agents.available && profile.features.agents.inspect) requests.push(
          api.get<{ items: AgentSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/agents`).then((result) => {
            if (active) setAgentOptions(Array.isArray(result.data.items) ? result.data.items : []);
          }),
        );
        if (profile.features.workspaces.available) requests.push(
          api.get<{ revision: number; workspaces: WorkspaceSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/workspaces`).then((result) => {
            if (active) setWorkspaceOptions(Array.isArray(result.data.workspaces) ? result.data.workspaces : []);
          }),
        );
        await Promise.all(requests);
        if (active) await refreshBootstrap();
      } catch (reason) {
        if (active) setCapabilityError(reason instanceof Error ? reason.message : "服务器能力检测失败");
      } finally {
        if (active) setSetupLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, refreshBootstrap, serverId]);

  useEffect(() => {
    if (!conversationId || activeMode !== "work") return;
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (active) setServerBindingLoading(true);
      let binding = (await api.get<ConversationServerBinding>(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`)).data;
      if (!binding.serverId) {
        const history = await api.get<TaskSummary[]>(`/api/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=1`);
        const historicalServerId = history.data[0]?.route.serverId;
        if (historicalServerId && runtime.bootstrap?.servers.some((server) => server.id === historicalServerId)) {
          binding = (await api.post<ConversationServerBinding>(`/api/conversations/${encodeURIComponent(conversationId)}/server-binding`, { serverId: historicalServerId })).data;
        }
      }
      if (!active) return;
      setBoundServerId(binding.serverId);
      if (binding.serverId) {
        setServerId(binding.serverId);
        if (initialRoute.serverId === binding.serverId) {
          setAgentId(initialRoute.agentId ?? null);
          setWorkspace(initialRoute.workspaceId ?? null);
          setWorkspacePath(initialRoute.workspacePath ?? null);
        } else {
          setAgentId(null);
          setWorkspace(null);
          setWorkspacePath(null);
        }
      }
    })().catch((reason) => {
      if (active) notify(reason instanceof Error ? reason.message : "对话服务器绑定读取失败", "error");
    }).finally(() => {
      if (active) setServerBindingLoading(false);
    });
    return () => { active = false; };
  }, [activeMode, api, conversationId, initialRoute, notify, runtime.bootstrap?.servers]);

  useEffect(() => {
    const branchId = detail?.summary.activeBranchId;
    if (!conversationId || activeMode !== "work" || !branchId || !boundServerId) return;
    let active = true;
    void api.get<WorkspaceRouteSnapshot | null>(`/api/servers/${encodeURIComponent(boundServerId)}/workspace-route?conversationId=${encodeURIComponent(conversationId)}&branchId=${encodeURIComponent(branchId)}`)
      .then((result) => {
        if (!active || !result.data) return;
        const snapshot = result.data;
        setServerId(boundServerId);
        setAgentId(snapshot.binding.agentId);
        setWorkspace(snapshot.binding.workspaceId);
        setWorkspacePath(snapshot.workspace.canonicalPath);
        localStorage.setItem(`easywork.conversation-route:${conversationId}`, JSON.stringify({
          serverId: boundServerId,
          agentId: snapshot.binding.agentId,
          workspaceId: snapshot.binding.workspaceId,
          workspacePath: snapshot.workspace.canonicalPath,
        } satisfies ConversationRoute));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [activeMode, api, boundServerId, conversationId, detail?.summary.activeBranchId]);

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
      const agentProviderId = typeof window === "undefined" ? "" : localStorage.getItem(`easywork.agent-provider:${serverId}:${agentId}`) || "";
      const agentModelId = typeof window === "undefined" ? "" : localStorage.getItem(`easywork.agent-model:${serverId}:${agentId}`) || "";
      if (agentProviderId && agentModelId) scope = { ...scope, agentProviderId, agentModelId };
    }
    if (resources.collections.length) scope.selectedCollectionIds = resources.collections.map((collection) => collection.id);
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
      if (workspace === VIRTUAL_WORKSPACE) {
        const created = await api.post<{ workspace: WorkspaceSummary }>(`/api/servers/${encodeURIComponent(serverId)}/workspaces/virtual`, {
          conversationId: id,
          branchId,
          expectedRevision: 0,
        }, { expectedRevision: 0, idempotencyKey: commandId("workspace-virtual") });
        workspaceId = created.data.workspace.id;
        resolvedPath = created.data.workspace.canonicalPath;
      }
      await api.post(`/api/servers/${encodeURIComponent(serverId)}/workspace-bindings`, {
        conversationId: id,
        branchId,
        workspaceId,
        agentId,
        contextEpoch: 0,
        expectedRevision: 0,
      }, { expectedRevision: 0, idempotencyKey: commandId("workspace-binding") });
      try {
        await uploadConversationFiles(id, resources.files);
        await api.post(`/api/conversations/${encodeURIComponent(id)}/respond`, {
          messageId: result.data.messageId,
          ...responseDescriptor({ serverId, workspaceId, agentId }, resources, selection),
        }, { idempotencyKey: commandId("respond") });
      } catch (reason) {
        notify(reason instanceof Error ? reason.message : "工作任务启动失败", "error");
      }
      localStorage.setItem(`easywork.conversation-route:${id}`, JSON.stringify({ serverId, agentId, workspaceId, workspacePath: resolvedPath } satisfies ConversationRoute));
      await clearWorkDraft().catch(() => undefined);
      await refreshBootstrap();
      runtime.navigate({ kind: "conversation", conversationId: id }, { replace: true });
      return;
    }
    const current = summary;
    if (!current) throw new Error("对话状态尚未载入");
    if (activeMode === "work" && activeTask && ["running", "interrupted"].includes(activeTask.status)) {
      const operation = activeTask.status === "interrupted" ? "resume" : "append";
      const capability = selectedAgent?.runtimeCapabilities?.[operation];
      if (capability?.availability !== "available") throw new Error(capability?.reason || `当前 Agent 不支持${operation === "append" ? "运行中追加" : "原会话继续"}`);
      if (resources.files.length || resources.collections.length || resources.skills.length) throw new Error("运行中的原生 Agent 会话不能重新绑定文件、文件集或 Skill");
      const sent = await appendConversationMessage(content, commandId("message-append"));
      await runtime.api.post(`/api/conversations/${conversationId}/respond`, {
        messageId: sent.data.messageId,
        ...responseDescriptor(undefined, resources, selection),
      }, { idempotencyKey: commandId(`respond-${operation}`) });
      await reload();
      return;
    }
    const sent = await appendConversationMessage(content, commandId("message"));
    await uploadConversationFiles(conversationId, resources.files);
    await runtime.api.post(`/api/conversations/${conversationId}/respond`, { messageId: sent.data.messageId, ...responseDescriptor(undefined, resources, selection) }, { idempotencyKey: commandId("respond") });
    await reload();
  };

  const interrupt = async () => {
    if (!activeTask) return;
    if (!agentOperationAvailable(selectedAgent, "interrupt")) {
      notify(selectedAgent?.runtimeCapabilities?.interrupt?.reason || "当前 Agent 不支持中断", "error");
      return;
    }
    try {
      await runtime.api.post(`/api/tasks/${encodeURIComponent(activeTask.id)}/interrupt`, {}, { idempotencyKey: commandId("task-interrupt") });
      await refreshBootstrap();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "任务中断失败", "error");
    }
  };

  const convertMode = async (nextMode: Mode) => {
    if (!conversationId || !summary || nextMode === activeMode) return;
    if (activeTask && !["completed", "failed", "cancelled", "interrupted"].includes(activeTask.status)) {
      notify("请先结束或中断当前任务", "error");
      return;
    }
    if (!window.confirm(`将此对话转换为${nextMode === "work" ? "工作" : "聊天"}模式？对话内容会保留。`)) return;
    try {
      await api.patch(`/api/conversations/${encodeURIComponent(conversationId)}`, { mode: nextMode }, {
        expectedRevision: summary.revision,
        idempotencyKey: commandId("conversation-mode"),
      });
      if (nextMode === "chat") {
        setBoundServerId(null);
        setServerId(null);
        setAgentId(null);
        setWorkspace(null);
        setWorkspacePath(null);
        localStorage.removeItem(`easywork.conversation-route:${conversationId}`);
      }
      setModeMenuOpen(false);
      await reload();
      await refreshBootstrap();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "对话模式转换失败", "error");
    }
  };

  const saveWorkDraft = (selection: WorkDraftSelection) => {
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
    }
  };
  const choose = (kind: "server" | "agent" | "workspace", value: string) => {
    workDraftTouched.current = true;
    if (kind === "server") {
      setSetupLoading(true);
      setServerId(value); setAgentId(null); setWorkspace(null); setWorkspacePath(null);
      void saveWorkDraft({ serverId: value, agentId: null, workspaceId: null, workspacePath: null });
    }
    if (kind === "agent" && serverId) {
      const useVirtualWorkspace = Boolean(serverCapabilities?.features.workspaces.virtual);
      setAgentId(value);
      setWorkspace(useVirtualWorkspace ? VIRTUAL_WORKSPACE : null);
      setWorkspacePath(useVirtualWorkspace ? "由 EasyWork 自动分配" : null);
      void saveWorkDraft({ serverId, agentId: value, workspaceId: useVirtualWorkspace ? VIRTUAL_WORKSPACE : null, workspacePath: useVirtualWorkspace ? "由 EasyWork 自动分配" : null });
    }
    if (kind === "workspace" && serverId && agentId) {
      const path = workspaceOptions.find((item) => item.id === value)?.canonicalPath;
      setWorkspace(value); setWorkspacePath(path ?? (value === VIRTUAL_WORKSPACE ? "由 EasyWork 自动分配" : null));
      void saveWorkDraft({ serverId, agentId, workspaceId: value, workspacePath: path ?? (value === VIRTUAL_WORKSPACE ? "由 EasyWork 自动分配" : null) });
    }
  };

  const switchWorkspace = async (workspaceId: string) => {
    const branchId = detail?.summary.activeBranchId;
    if (!conversationId || !branchId || !serverId || !agentId) return;
    setSwitchingWorkspace(true);
    try {
      const body = { conversationId, branchId, workspaceId, agentId, contextEpoch: 0 };
      const described = await api.post<WorkspaceSwitchDescriptor>(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch/describe`, body);
      if (described.data.requiresConfirmation && !window.confirm("切换工作区会更换当前 Agent 会话，网页对话记忆仍会保留。继续吗？")) return;
      await api.post(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch`, {
        ...body,
        descriptorId: described.data.id,
        expectedRevision: described.data.routeRevision,
      }, { expectedRevision: described.data.routeRevision, idempotencyKey: commandId("workspace-switch") });
      const next = workspaceOptions.find((item) => item.id === workspaceId);
      setWorkspace(workspaceId);
      setWorkspacePath(next?.canonicalPath ?? null);
      setWorkspacePickerOpen(false);
      localStorage.setItem(`easywork.conversation-route:${conversationId}`, JSON.stringify({
        serverId,
        agentId,
        workspaceId,
        workspacePath: next?.canonicalPath,
      } satisfies ConversationRoute));
      notify("工作区已切换", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "工作区切换失败", "error");
    } finally { setSwitchingWorkspace(false); }
  };

  const bindWorkBranch = async (branchId: string) => {
    if (activeMode !== "work") return;
    if (!conversationId || !serverId || !agentId || !workspace || workspace === VIRTUAL_WORKSPACE) throw new Error("当前工作路由不完整，无法建立工作分支");
    await api.post(`/api/servers/${encodeURIComponent(serverId)}/workspace-bindings`, {
      conversationId,
      branchId,
      workspaceId: workspace,
      agentId,
      contextEpoch: 0,
      expectedRevision: 0,
    }, { expectedRevision: 0, idempotencyKey: commandId("workspace-branch-binding") });
    setBoundServerId(serverId);
  };

  const switchAgent = async (nextAgentId: string) => {
    const branchId = detail?.summary.activeBranchId;
    if (!conversationId || !branchId || !serverId || !workspace || workspace === VIRTUAL_WORKSPACE || nextAgentId === agentId) return;
    if (activeTask && !["completed", "failed", "cancelled", "interrupted"].includes(activeTask.status)) throw new Error("当前任务结束或中断后才能切换 Agent");
    const body = { conversationId, branchId, workspaceId: workspace, agentId: nextAgentId, contextEpoch: 0 };
    const described = await api.post<WorkspaceSwitchDescriptor>(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch/describe`, body);
    if (described.data.requiresConfirmation && !window.confirm("切换 Agent 会更换原生会话；网页对话记忆会保留，重新使用该 Agent 时仅补发它尚未收到的内容。继续吗？")) return;
    await api.post(`/api/servers/${encodeURIComponent(serverId)}/workspace-switch`, {
      ...body,
      descriptorId: described.data.id,
      expectedRevision: described.data.routeRevision,
    }, { expectedRevision: described.data.routeRevision, idempotencyKey: commandId("agent-switch") });
    setAgentId(nextAgentId);
    localStorage.setItem(`easywork.conversation-route:${conversationId}`, JSON.stringify({
      serverId,
      agentId: nextAgentId,
      workspaceId: workspace,
      workspacePath: workspacePath ?? undefined,
    } satisfies ConversationRoute));
    notify("Agent 已切换", "success");
  };

  const installAgent = async (targetAgentId: string) => {
    if (!serverId || installingAgent) return;
    setInstallingAgent(targetAgentId);
    try {
      await api.post(`/api/servers/${encodeURIComponent(serverId)}/agents/${encodeURIComponent(targetAgentId)}/install`, {}, { idempotencyKey: commandId("agent-install") });
      const result = await api.get<{ items: AgentSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/agents`);
      setAgentOptions(result.data.items);
      notify("Agent 已安装", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "Agent 安装失败", "error");
    } finally { setInstallingAgent(null); }
  };

  const refreshAgents = async () => {
    if (!serverId) return;
    const result = await api.get<{ items: AgentSummary[] }>(`/api/servers/${encodeURIComponent(serverId)}/agents`);
    setAgentOptions(result.data.items);
  };

  const latestUser = [...messages].reverse().find((message) => message.role === "user")?.id;
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.id;
  const classifiedOutput = classifyConversationOutput(events);
  const userMessages = messages.filter((message) => message.role === "user");
  const userRecords = userMessages.map((message, index) => {
    const nextCreatedAt = userMessages[index + 1]?.createdAt;
    const task = Object.values(tasks)
      .filter((entry) => (entry.startedAt || entry.updatedAt) >= message.createdAt && (!nextCreatedAt || (entry.startedAt || entry.updatedAt) < nextCreatedAt))
      .sort((left, right) => (left.startedAt || left.updatedAt).localeCompare(right.startedAt || right.updatedAt))[0]
      ?? (message.id === latestUser ? activeTask ?? null : null);
    return { message, task };
  });
  const timelineByUserMessage = new Map<string, RealtimeEnvelope[]>();
  for (let index = 0; index < userMessages.length; index += 1) {
    const message = userMessages[index];
    const nextCreatedAt = userMessages[index + 1]?.createdAt;
    const taskId = userRecords[index]?.task?.id;
    const scopedEvents = events.filter((event) => {
      if (taskId && event.ids.taskId === taskId) return true;
      if (event.ids.taskId && event.ids.taskId !== taskId) return false;
      return event.occurredAt >= message.createdAt && (!nextCreatedAt || event.occurredAt < nextCreatedAt);
    });
    if (scopedEvents.length) timelineByUserMessage.set(message.id, scopedEvents);
  }

  const visibleExpandedRecordId = activeTask && latestUser ? latestUser : expandedRecordId;

  useEffect(() => {
    const node = scroll.current;
    if (!node || !conversationId) return;
    node.scrollTop = conversationScrollPositions.get(conversationId) ?? node.scrollHeight;
    const remember = () => conversationScrollPositions.set(conversationId, node.scrollTop);
    node.addEventListener("scroll", remember, { passive: true });
    return () => { remember(); node.removeEventListener("scroll", remember); };
  }, [conversationId, messages.length]);

  if (loading) return <LoadingState label="正在载入对话" />;

  const panelLabel = initialPanel?.kind === "file" ? "文件" : initialPanel?.kind === "task" ? "任务" : initialPanel?.kind === "artifact" ? "产物" : "变更";
  const taskInputAvailable = !activeTask
    || (activeTask.status === "running" && agentOperationAvailable(selectedAgent, "append"))
    || (activeTask.status === "interrupted" && agentOperationAvailable(selectedAgent, "resume"));
  const taskPlaceholder = activeTask?.status === "running" && !agentOperationAvailable(selectedAgent, "append")
    ? "当前 Agent 不支持运行中追加"
    : activeTask?.status === "interrupted" && !agentOperationAvailable(selectedAgent, "resume")
      ? "当前 Agent 不能从原生会话继续"
      : "继续当前工作";
  const openConversationConnection = () => {
    if (selectedServer) {
      if (selectedServer.status === "connected") runtime.setRightRailOpen(true);
      else setConnectServerId(selectedServer.id);
      return;
    }
    if (!serverBindingLoading && !boundServerId) setServerPickerOpen(true);
  };
  const toggleBoundServerConnection = async () => {
    if (!selectedServer || disconnectingServer) return;
    if (selectedServer.status !== "connected") {
      setConnectServerId(selectedServer.id);
      return;
    }
    setDisconnectingServer(true);
    try {
      await api.post(`/api/servers/${encodeURIComponent(selectedServer.id)}/disconnect`, {});
      await refreshBootstrap();
      notify("SSH 已断开", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "SSH 断开失败", "error");
    } finally {
      setDisconnectingServer(false);
    }
  };

  return <div className={`${styles.view} ${runtime.rightRailOpen && conversationId ? styles.withRail : ""}`}>
    <section className={`${styles.stage} ${initialPanel ? styles.stageWithPanel : ""}`}>
      {isEmpty ? <div className={styles.modeSwitch}><button className={`${styles.modeButton} ${mode === "chat" ? styles.selected : ""}`} onClick={() => setMode("chat")}><MessageSquareText size={15} />聊天</button><button className={`${styles.modeButton} ${mode === "work" ? styles.selected : ""}`} onClick={() => setMode("work")}><Code2 size={15} />工作</button></div> : <header className={styles.header}>
        <span className={styles.modeMenu}><button className={styles.modePill} aria-expanded={modeMenuOpen} onClick={() => setModeMenuOpen((open) => !open)}>{activeMode === "work" ? <Code2 size={15} /> : <MessageSquareText size={15} />}{activeMode === "work" ? "工作" : "聊天"}<ChevronDown size={13} /></button>{modeMenuOpen ? <span className={styles.modePopover}><small>对话类型</small><button onClick={() => void convertMode(activeMode === "work" ? "chat" : "work")}>{activeMode === "work" ? <MessageSquareText size={15} /> : <Code2 size={15} />}转换为{activeMode === "work" ? "聊天" : "工作"}</button></span> : null}</span>
        <span className={styles.headerSpacer} />
        {activeMode === "work" ? <>
          {serverId && selectedServer?.status === "connected" ? <AgentControl
            serverId={serverId}
            agents={agentOptions}
            selectedAgentId={agentId}
            bindingId={selectedAgentBindingId}
            contextRevision={selectedAgentContextRevision}
            workspacePath={workspacePath ?? selectedWorkspace?.canonicalPath ?? null}
            disabled={Boolean(activeTask && !["interrupted", "completed", "failed", "cancelled"].includes(activeTask.status))}
            canConfigure={Boolean(serverCapabilities?.features.agents.configure)}
            installingAgentId={installingAgent}
            onSelect={switchAgent}
            onInstall={installAgent}
            onManualAdd={() => setManualAgentOpen(true)}
            onConfigure={() => setAgentConfigOpen(true)}
          /> : null}
          <button className={`${styles.connection} ${selectedServer?.status !== "connected" ? styles.off : ""}`} disabled={serverBindingLoading} onClick={openConversationConnection}>{serverBindingLoading ? <LoaderCircle className={styles.spin} size={14} /> : selectedServer?.status === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}{serverBindingLoading ? "读取中" : selectedServer?.status === "connected" ? "已连接" : "未连接"}</button>
          {selectedServer?.status === "connected" && workbenchAvailable ? <Button compact variant="ghost" icon={<TerminalSquare size={16} />} onClick={() => setWorkbenchOpen(true)}>工作台</Button> : null}
        </> : null}
      </header>}
      {conversationId && initialPanel ? <div className={styles.mainTabs}><button onClick={() => runtime.navigate({ kind: "conversation", conversationId })}>对话</button><span className={styles.activeMainTab}>{panelLabel}<button aria-label={`关闭${panelLabel}`} onClick={() => runtime.navigate({ kind: "conversation", conversationId })}><X size={13} /></button></span></div> : null}
      {conversationId && initialPanel ? <ConversationObjectPanel panel={initialPanel} /> : isEmpty ? <div className={styles.empty}><div className={styles.emptyInner}>
        <h1 className={styles.emptyTitle}>{mode === "work" ? "准备好后，开始工作" : "有什么可以帮你？"}</h1>
        <div className={styles.emptyComposer}><Composer key={`new:${initialProjectId ?? "standalone"}:${mode}`} conversationId={conversationId} draftKey={`new:${initialProjectId ?? "standalone"}:${mode}`} disabled={!workReady} placeholder={mode === "work" ? workReady ? "描述要在远端完成的工作" : "请先完成工作环境设置" : "给 EasyWork 发消息"} onSend={send} /></div>
        {mode === "work" ? <>
          <div className={styles.setup}>
            <button className={`${styles.setupStep} ${serverId ? styles.done : ""}`} onClick={() => runtime.bootstrap?.servers.length ? setServerPickerOpen(true) : setCreateServerOpen(true)}><Server size={16} />{selectedServer ? `${selectedServer.name} · ${selectedServer.host}` : "连接远程服务器"}</button>
            {serverId && (setupLoading || agentsAvailable) ? <button className={`${styles.setupStep} ${agentId ? styles.done : ""}`} onClick={() => setAgentPickerOpen(true)}><Bot size={16} />{agentId ? selectedAgent?.displayName ?? agentId : setupLoading ? "正在扫描 Agent" : "配置 Agent"}</button> : null}
            {agentId && workspacesAvailable ? <button className={`${styles.setupStep} ${workspace ? styles.done : ""}`} onClick={() => setWorkspacePickerOpen(true)}><FolderOpen size={16} />{workspace === VIRTUAL_WORKSPACE ? "虚拟工作区" : workspacePath ?? selectedWorkspace?.canonicalPath ?? "设置工作区"}</button> : null}
          </div>
          {serverId && !setupLoading && capabilityError ? <div className={styles.setupUnavailable}>{capabilityError}</div> : null}
          {serverId && !setupLoading && !capabilityError && !agentsAvailable ? <div className={styles.setupUnavailable}>当前服务器不支持 Agent 工作</div> : null}
        </> : null}
      </div><div className={styles.emptyDisclaimer}>EasyWork 可能会出错，请核对重要信息。</div></div> : <>
        <div className={styles.messages} ref={scroll}><div className={styles.messageList}>
          {messages.map((message) => <div className={styles.turn} key={message.id}><Message message={message} latestUser={message.id === latestUser} latestAssistant={message.id === latestAssistant} revision={summary?.revision ?? 0} workMode={activeMode === "work"} response={responseDescriptor} onBranchCreated={bindWorkBranch} onChanged={reload} />{message.role === "user" && timelineByUserMessage.has(message.id) ? <ConversationTimeline events={timelineByUserMessage.get(message.id) || []} mode={activeMode} /> : null}</div>)}
          {classifiedOutput.streamingFinal ? <article className={`${styles.message} ${styles.assistant} ${styles.streamingMessage}`}><div className={styles.messageHead}><span className={styles.dot} /> EasyWork</div><div className={styles.assistantBody}><MarkdownContent content={classifiedOutput.streamingFinal} /></div></article> : null}
        </div></div>
        <div className={styles.composerWrap}><Composer conversationId={conversationId} draftKey={`conversation:${conversationId}`} disabled={activeMode === "work" && !taskInputAvailable} activeTask={activeMode === "work" ? activeTask : undefined} canInterrupt={agentOperationAvailable(selectedAgent, "interrupt")} onInterrupt={interrupt} placeholder={activeMode === "work" ? taskPlaceholder : "继续对话"} onSend={send} /></div>
      </>}
      {conversationId && activeMode === "work" && workbenchOpen && workbenchAvailable && serverId && workspace && workspace !== VIRTUAL_WORKSPACE && (workspacePath || selectedWorkspace?.canonicalPath) ? <Suspense fallback={null}><WorkbenchDrawer serverId={serverId} workspaceId={workspace} workspacePath={workspacePath || selectedWorkspace?.canonicalPath || ""} conversationId={conversationId} branchId={detail?.summary.activeBranchId} onClose={() => setWorkbenchOpen(false)} /></Suspense> : null}
      {agentConfigOpen && serverId && selectedAgent && serverCapabilities?.features.agents.configure ? <AgentConfigDialog serverId={serverId} agent={selectedAgent} onClose={() => setAgentConfigOpen(false)} /> : null}
      {agentPickerOpen && serverId ? <AgentSetupDialog agents={agentOptions} selectedAgentId={agentId} loading={setupLoading} installingAgentId={installingAgent} onClose={() => setAgentPickerOpen(false)} onSelect={async (nextAgentId) => { if (conversationId) await switchAgent(nextAgentId); else choose("agent", nextAgentId); }} onInstall={installAgent} onManualAdd={() => { setAgentPickerOpen(false); setManualAgentOpen(true); }} /> : null}
      {workspacePickerOpen && serverId && agentId ? <WorkspaceSetupDialog options={workspaceOptions} current={workspace} allowVirtual={Boolean(serverCapabilities?.features.workspaces.virtual)} busy={switchingWorkspace} onClose={() => setWorkspacePickerOpen(false)} onSelect={async (nextWorkspaceId) => { if (conversationId) await switchWorkspace(nextWorkspaceId); else { choose("workspace", nextWorkspaceId); setWorkspacePickerOpen(false); } }} /> : null}
      {manualAgentOpen && serverId ? <ManualAgentDialog serverId={serverId} agents={agentOptions} onClose={() => setManualAgentOpen(false)} onAdded={async (nextAgentId) => { await refreshAgents(); if (!conversationId) choose("agent", nextAgentId); }} /> : null}
      {serverPickerOpen && !boundServerId && runtime.bootstrap?.servers.length ? <DraftServerPicker servers={runtime.bootstrap.servers} onClose={() => setServerPickerOpen(false)} onAdd={() => { setServerPickerOpen(false); setCreateServerOpen(true); }} onSelect={(server) => { setServerPickerOpen(false); if (server.status === "connected") choose("server", server.id); else { setServerId(server.id); setConnectServerId(server.id); } }} /> : null}
      {connectServerId && runtime.bootstrap?.servers.find((server) => server.id === connectServerId) ? <DraftConnectDialog server={runtime.bootstrap.servers.find((server) => server.id === connectServerId)!} onClose={() => setConnectServerId(null)} onConnected={async () => { const connectedId = connectServerId; await refreshBootstrap(); if (!conversationId || !boundServerId) choose("server", connectedId); }} /> : null}
      {createServerOpen ? <ServerEditor onClose={() => setCreateServerOpen(false)} onSaved={async (savedId) => { await refreshBootstrap(); if (savedId) setConnectServerId(savedId); }} /> : null}
    </section>
    {conversationId && runtime.rightRailOpen ? <aside className={styles.rail}>
      {activeMode === "work" ? <>
        <section className={`${styles.railCard} ${selectedServer?.status === "connected" ? styles.railConnected : styles.railDisconnected}`}>
          <div className={styles.railConnectionHeading}><span>远程连接</span><span className={styles.railConnectionState}><i />{selectedServer?.status === "connected" ? "已连接" : "未连接"}</span></div>
          <strong className={styles.railValue}>{selectedServer?.name || "未连接"}</strong>
          <span className={styles.railSub}>{selectedServer ? `${selectedServer.username}@${selectedServer.host}` : ""}</span>
          <div className={styles.railActions}>
            <button disabled={!selectedServer || serverBindingLoading || disconnectingServer} onClick={() => void toggleBoundServerConnection()}>{disconnectingServer ? <LoaderCircle className={styles.spin} size={14} /> : <Cable size={14} />}{disconnectingServer ? "断开中" : selectedServer?.status === "connected" ? "断开" : "连接"}</button>
            <button disabled={!workbenchAvailable} onClick={() => setWorkbenchOpen(true)}><FolderOpen size={14} />文件</button>
          </div>
        </section>
        <section className={styles.railCard}>
          <div className={styles.railTitle}><span>当前工作区</span><button className={styles.railAction} disabled={!serverId || !agentId || switchingWorkspace} onClick={() => setWorkspacePickerOpen(true)}>{switchingWorkspace ? "切换中" : "更改"}</button></div>
          <div className={styles.railValue} title={workspacePath ?? selectedWorkspace?.canonicalPath ?? undefined}>{workspacePath ?? selectedWorkspace?.canonicalPath ?? (workspace === VIRTUAL_WORKSPACE ? "虚拟工作区" : "未设置")}</div>
        </section>
      </> : null}
      <section className={`${styles.railCard} ${styles.recordList}`}><div className={styles.railTitle}>对话记录</div><div className={styles.records}>{userRecords.map(({ message, task }) => {
        const expanded = visibleExpandedRecordId === message.id;
        return <div className={styles.recordEntry} key={message.id}>
          <div className={styles.recordHead}>
            <button className={styles.record} onClick={() => document.getElementById(`message-${message.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>{message.content}</button>
            <button className={styles.recordExpand} aria-label={expanded ? "收起任务流程" : "展开任务流程"} aria-expanded={expanded} onClick={() => setExpandedRecordId(expanded ? null : message.id)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          </div>
          <div className={`${styles.recordPlan} ${expanded ? styles.recordPlanOpen : ""}`}><div><TaskPlanSummary task={task} /></div></div>
        </div>;
      })}</div></section>
    </aside> : null}
    {conversationId ? <button className={styles.railToggle} aria-label={runtime.rightRailOpen ? "收起详情" : "展开详情"} onClick={() => runtime.setRightRailOpen(!runtime.rightRailOpen)}>{runtime.rightRailOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</button> : null}
  </div>;
}

export default function ConversationView(props: Props) {
  const key = props.conversationId ?? `draft:${props.initialProjectId ?? "standalone"}:${props.initialMode ?? "chat"}`;
  return <ConversationScreen key={key} {...props} />;
}
