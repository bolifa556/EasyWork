"use client";

import {
  Activity,
  ArrowUp,
  BookOpen,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Code2,
  Database,
  Download,
  File,
  FileArchive,
  FileText,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderLock,
  Gauge,
  HardDrive,
  Home,
  KeyRound,
  Library,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  MessageCircle,
  Network,
  Paperclip,
  Pin,
  PinOff,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  User,
  UserRound,
  WandSparkles,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

type Mode = "chat" | "work";
type ViewName = "chat" | "project" | "library" | "skills" | "memory";
type StepStatus = "pending" | "running" | "done" | "error";
type EventStatus = "pending" | "running" | "done" | "error";
type WorkEventKind =
  | "message"
  | "plan"
  | "tool_call"
  | "approval_request"
  | "file_change"
  | "job_status"
  | "artifact"
  | "error"
  | "reasoning"
  | "connection"
  | "tool"
  | "terminal"
  | "result";

type WorkflowStep = {
  id: string;
  title: string;
  status: StepStatus;
  detail?: string;
};

type WorkEvent = {
  id: string;
  kind: WorkEventKind;
  title: string;
  detail?: string;
  output?: string;
  command?: string;
  path?: string;
  language?: string;
  status: EventStatus;
  timestamp: string;
};

type RunTrace = {
  runId: string;
  status: "queued" | "running" | "done" | "error";
  steps: WorkflowStep[];
  result?: string;
  startedAt: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  createdAt: string;
  mode: Mode;
  selectedSkills?: string[];
  trace?: RunTrace;
  events?: WorkEvent[];
  runId?: string;
};

type Conversation = {
  id: string;
  title: string;
  mode: Mode;
  projectId?: string;
  pinned?: boolean;
  messages: Message[];
  updatedAt: string;
  work?: {
    agentId?: string;
    agentSessionId?: string;
    workspace?: string;
    serverId?: string;
  };
};

type Project = {
  id: string;
  name: string;
  icon: string;
  memoryMode: "default" | "project-only";
  fileIds?: string[];
  pinned?: boolean;
  createdAt: string;
};

type SkillItem = {
  id: string;
  name: string;
  description: string;
  source: "built-in" | "uploaded";
  enabled: boolean;
  fileCount: number;
  updatedAt: string;
};

type LibraryFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  status: "ready" | "indexing" | "keyword-only" | "error";
  chunks: number;
  updatedAt: string;
};

type MemoryItem = {
  id: string;
  content: string;
  scope: "global" | "project";
  projectId?: string;
  kind: "preference" | "profile" | "goal" | "workflow";
  source: string;
  confidence: number;
  enabled: boolean;
  updatedAt: string;
};

type ServerProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  keyName: string;
  authMethod?: "key" | "password";
  configured: boolean;
  lastConnectedAt?: string;
};

type ServerProfileDraft = ServerProfile & {
  privateKey?: string;
  password?: string;
};

type AppSettings = {
  memoryEnabled: boolean;
  referenceHistory: boolean;
  autoCapture: boolean;
  showMemorySources: boolean;
  provider: {
    name: string;
    baseUrl: string;
    model: string;
    protocol: "auto" | "chat-completions" | "responses";
    configured: boolean;
  };
  embedding: {
    baseUrl: string;
    model: string;
    dimensions: string;
    configured: boolean;
    hybridEnabled: boolean;
    rerankEnabled: boolean;
  };
  servers: ServerProfile[];
  lastServerId?: string;
  ssh?: {
    host: string;
    port: number;
    username: string;
    keyName: string;
    configured: boolean;
  };
};

type EasyWorkState = {
  projects: Project[];
  conversations: Conversation[];
  skills: SkillItem[];
  files: LibraryFile[];
  memories: MemoryItem[];
  memorySummary?: string;
  settings: AppSettings;
};

type Actor = {
  id: string;
  authenticated: boolean;
  displayName: string;
  email?: string;
  avatar?: string;
};

type ConnectionState = {
  serverId: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  label: string;
  host?: string;
  username?: string;
  port?: number;
  latency?: number;
  fingerprint?: string;
  demo?: boolean;
};

type AgentItem = {
  id: string;
  name: string;
  folder?: string;
  path: string;
  version?: string;
  status: "ready" | "missing" | "installing" | "needs-adapter";
  adapter: "opencode" | "claude" | "qwen" | "plain";
  managed?: boolean;
  configured?: boolean;
  configPath?: string;
  dataPath?: string;
  model?: string;
  detail?: string;
};

type AgentModelConfigState = {
  status: "idle" | "configuring" | "done" | "error";
  model?: string;
  label?: string;
  error?: string;
};

type AgentUpdateState = {
  status:
    | "idle"
    | "checking"
    | "downloading"
    | "current"
    | "available"
    | "updating"
    | "configuring"
    | "done"
    | "error";
  currentVersion?: string;
  latestVersion?: string;
  label?: string;
  error?: string;
};

type RemoteFileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt?: string;
};

let GATEWAY_HTTP =
  typeof window !== "undefined"
    ? window.location.origin
    : process.env.NEXT_PUBLIC_EASYWORK_GATEWAY_URL ?? "http://localhost:3000";

const DEVICE_TOKEN_STORAGE_KEY = "easywork.device-token.v1";
const DEVICE_TOKEN_EVENT = "easywork:device-token";

function readDeviceToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(DEVICE_TOKEN_STORAGE_KEY) || "";
}

function storeDeviceToken(token?: string) {
  if (typeof window === "undefined" || !token) return;
  window.localStorage.setItem(DEVICE_TOKEN_STORAGE_KEY, token);
  window.dispatchEvent(new Event(DEVICE_TOKEN_EVENT));
}

function clearDeviceToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(DEVICE_TOKEN_STORAGE_KEY);
  window.dispatchEvent(new Event(DEVICE_TOKEN_EVENT));
}

function gatewayFetch(
  path: string,
  init: RequestInit = {},
  baseUrl = GATEWAY_HTTP,
) {
  const headers = new Headers(init.headers);
  const token = readDeviceToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
}

const gatewayCandidates = () => {
  const configured = process.env.NEXT_PUBLIC_EASYWORK_GATEWAY_URL;
  const currentOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  return [...new Set([currentOrigin, configured].filter(Boolean))] as string[];
};

const now = () => new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}_${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;

function fallbackConversationTitle(prompt: string) {
  const compact = prompt
    .replace(/[`*_>#\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(请|帮我|麻烦|我想|能否|可以|一下)+/g, "")
    .trim();
  return [...(compact || "新对话")].slice(0, 14).join("");
}

const DEFAULT_STATE: EasyWorkState = {
  projects: [],
  conversations: [],
  skills: [
    {
      id: "skill_cluster",
      name: "集群资源管家",
      description: "理解 Slurm、GPU、内存与登录节点约束，优先做只读检查。",
      source: "built-in",
      enabled: true,
      fileCount: 3,
      updatedAt: "2026-07-29T10:00:00.000Z",
    },
    {
      id: "skill_paper",
      name: "论文精读",
      description: "按问题、方法、实验、局限与复现线索整理研究论文。",
      source: "built-in",
      enabled: true,
      fileCount: 2,
      updatedAt: "2026-07-28T10:00:00.000Z",
    },
    {
      id: "skill_debug",
      name: "训练故障诊断",
      description: "从日志、显存、依赖和数据管线逐层定位训练异常。",
      source: "built-in",
      enabled: true,
      fileCount: 4,
      updatedAt: "2026-07-27T10:00:00.000Z",
    },
  ],
  files: [],
  memories: [],
  memorySummary: "",
  settings: {
    memoryEnabled: true,
    referenceHistory: true,
    autoCapture: true,
    showMemorySources: true,
    provider: {
      name: "OpenAI Compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      protocol: "auto",
      configured: false,
    },
    embedding: {
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimensions: "1536",
      configured: false,
      hybridEnabled: true,
      rerankEnabled: false,
    },
    servers: [],
    lastServerId: "",
  },
};

const LEGACY_DEMO_PROJECT_IDS = new Set(["project_research", "project_course"]);
const LEGACY_DEMO_FILE_IDS = new Set(["file_ssh", "file_notes", "file_dataset"]);
const LEGACY_DEMO_MEMORY_IDS = new Set(["memory_1", "memory_2", "memory_3"]);

function mergeStoredState(
  current: EasyWorkState,
  incoming: Partial<EasyWorkState>,
): EasyWorkState {
  const incomingSettings = incoming.settings as
    | (Partial<AppSettings> & { ssh?: AppSettings["ssh"] })
    | undefined;
  const storedServers = Array.isArray(incomingSettings?.servers)
    ? incomingSettings.servers
    : [];
  const legacySsh = incomingSettings?.ssh;
  const servers =
    storedServers.length > 0
      ? storedServers
      : legacySsh?.host
        ? [
            {
              id: `server-${btoa(
                `${legacySsh.host}:${legacySsh.port || 22}:${legacySsh.username || ""}`,
              )
                .replace(/[^a-z0-9]/gi, "")
                .slice(0, 12)
                .toLowerCase()}`,
              name: legacySsh.host,
              host: legacySsh.host,
              port: Number(legacySsh.port || 22),
              username: legacySsh.username || "",
              keyName: legacySsh.keyName || "",
              configured: Boolean(legacySsh.configured),
            },
          ]
        : current.settings.servers;
  const conversations = Array.isArray(incoming.conversations)
    ? incoming.conversations.filter(
        (conversation) => (conversation.messages?.length ?? 0) > 0,
      )
    : current.conversations;
  const referencedProjects = new Set(
    conversations.map((conversation) => conversation.projectId).filter(Boolean),
  );
  const projects = Array.isArray(incoming.projects)
    ? incoming.projects.filter(
        (project) =>
          !LEGACY_DEMO_PROJECT_IDS.has(project.id) || referencedProjects.has(project.id),
      )
    : current.projects;
  const files = Array.isArray(incoming.files)
    ? incoming.files.filter((file) => !LEGACY_DEMO_FILE_IDS.has(file.id))
    : current.files;
  const memories = Array.isArray(incoming.memories)
    ? incoming.memories.filter((memory) => !LEGACY_DEMO_MEMORY_IDS.has(memory.id))
    : current.memories;

  return {
    ...current,
    ...incoming,
    projects,
    conversations,
    files,
    memories,
    memorySummary: memories.length ? incoming.memorySummary : "",
    settings: {
      ...current.settings,
      ...(incoming.settings ?? {}),
      provider: {
        ...current.settings.provider,
        ...(incoming.settings?.provider ?? {}),
      },
      embedding: {
        ...current.settings.embedding,
        ...(incoming.settings?.embedding ?? {}),
      },
      servers,
      lastServerId:
        incomingSettings?.lastServerId ||
        servers[0]?.id ||
        current.settings.lastServerId,
    },
  };
}

const DEFAULT_ACTOR: Actor = {
  id: "guest",
  authenticated: false,
  displayName: "未登录",
};

const DEFAULT_AGENTS: AgentItem[] = [
  {
    id: "opencode",
    name: "OpenCode",
    folder: "~/.easywork/agents/opencode",
    path: "~/.easywork/agents/opencode/bin/opencode",
    status: "missing",
    adapter: "opencode",
    managed: true,
    configured: false,
  },
];

function dedupeAgents(items: AgentItem[]) {
  const result = new Map<string, AgentItem>();
  for (const item of items) {
    const key = item.adapter === "opencode" ? "opencode" : item.id;
    const normalized =
      key === "opencode" ? { ...item, id: "opencode", name: "OpenCode" } : item;
    const existing = result.get(key);
    const shouldReplace =
      !existing ||
      (existing.status !== "ready" && normalized.status === "ready") ||
      (existing.status === normalized.status &&
        !existing.managed &&
        Boolean(normalized.managed));
    if (shouldReplace) result.set(key, normalized);
  }
  return [...result.values()];
}

const skillIcon = (skill: SkillItem) => {
  if (skill.id.includes("cluster")) return <Gauge size={18} />;
  if (skill.id.includes("paper")) return <BookOpen size={18} />;
  return <WandSparkles size={18} />;
};

const formatBytes = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const formatProjectDate = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));

const conversationPreview = (conversation: Conversation) =>
  conversation.messages.find((message) => message.role === "user")?.content ||
  "还没有内容";

const fileToBase64 = (file: globalThis.File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });

function MarkdownContent({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const inlineTone = (value: string) => {
    let hash = 0;
    for (const character of value) {
      hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
    }
    return hash % 5;
  };
  return (
    <div className={`markdown-content${compact ? " compact" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="markdown-code-block">{children}</pre>
          ),
          code: ({ children, className }) => {
            const value = String(children).replace(/\n$/, "");
            const block = Boolean(className) || value.includes("\n");
            return (
              <code
                className={
                  block || compact
                    ? className
                    : `inline-function-field tone-${inlineTone(value)}`
                }
              >
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="markdown-table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal-card${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="step-glyph done">
        <Check size={12} />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="step-glyph running">
        <LoaderCircle size={13} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="step-glyph error">
        <X size={12} />
      </span>
    );
  }
  return (
    <span className="step-glyph pending">
      <Circle size={8} />
    </span>
  );
}

function normalizedEventKind(kind: WorkEventKind): WorkEventKind {
  if (kind === "tool" || kind === "terminal") return "tool_call";
  if (kind === "result") return "message";
  return kind;
}

function eventStatusLabel(status: EventStatus) {
  if (status === "running") return "正在进行";
  if (status === "done") return "已完成";
  if (status === "error") return "失败";
  return "等待";
}

function EventGlyph({ event }: { event: WorkEvent }) {
  const kind = normalizedEventKind(event.kind);
  if (event.status === "running") return <LoaderCircle size={14} />;
  if (event.status === "error" || kind === "error") return <X size={13} />;
  if (kind === "plan") return <Activity size={14} />;
  if (kind === "approval_request") return <ShieldCheck size={14} />;
  if (kind === "file_change") return <FileText size={14} />;
  if (kind === "job_status") return <Gauge size={14} />;
  if (kind === "artifact") return <FileArchive size={14} />;
  if (kind === "reasoning") return <Brain size={14} />;
  if (kind === "connection") return <Network size={14} />;
  if (kind === "message") return <MessageCircle size={14} />;
  return <Check size={13} />;
}

function ReasoningDisclosure({
  content,
  running = false,
}: {
  content?: string;
  running?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const previousRunning = useRef(running);

  useEffect(() => {
    if (previousRunning.current && !running) setExpanded(false);
    previousRunning.current = running;
  }, [running]);

  if (!content && !running) return null;
  return (
    <section className={`reasoning-disclosure${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="reasoning-glyph">
          {running ? <LoaderCircle size={14} /> : <Brain size={14} />}
        </span>
        <strong>{running ? "思考中" : "思考完成"}</strong>
        <ChevronDown size={13} />
      </button>
      <div className="reasoning-motion">
        <div>
          <div className="reasoning-content">
            {content ? (
              <MarkdownContent content={content} compact />
            ) : (
              <span>正在生成思考内容…</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function useAutoDisclosure(autoOpen: boolean) {
  const [expanded, setExpanded] = useState(autoOpen);
  const previousAutoOpen = useRef(autoOpen);
  useEffect(() => {
    if (previousAutoOpen.current === autoOpen) return;
    previousAutoOpen.current = autoOpen;
    setExpanded(autoOpen);
  }, [autoOpen]);
  return [expanded, setExpanded] as const;
}

function CommandEventItem({ event }: { event: WorkEvent }) {
  const [expanded, setExpanded] = useAutoDisclosure(event.status === "running");
  const command = event.command || event.title;
  const panelId = `command-output-${event.id}`;
  return (
    <article
      className={`command-event ${event.status}${expanded ? " expanded" : ""}`}
    >
      <button
        className="command-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="command-status">
          {event.status === "running" ? (
            <LoaderCircle size={13} />
          ) : event.status === "error" ? (
            <X size={12} />
          ) : (
            <Terminal size={12} />
          )}
        </span>
        <code title={command}>{command}</code>
        <small>{eventStatusLabel(event.status)}</small>
        <ChevronRight className="command-event-chevron" size={13} />
      </button>
      <div className="command-output-motion" id={panelId}>
        <div>
          <pre className="remote-terminal">
            <span className="terminal-caption">
              <i />
              {event.detail || "登录节点"}
            </span>
            <code>
              <b>$</b> {command}
              {event.output
                ? `\n${event.output}`
                : event.status === "running"
                  ? "\n等待远端输出…"
                  : ""}
            </code>
          </pre>
        </div>
      </div>
    </article>
  );
}

function CommandEventGroup({ events }: { events: WorkEvent[] }) {
  const running = events.some((event) => event.status === "running");
  const failed = events.some((event) => event.status === "error");
  const [groupExpanded, setGroupExpanded] = useAutoDisclosure(running);
  const groupLabel = running
    ? `正在运行 ${events.length} 个命令`
    : `运行了 ${events.length} 个命令`;

  return (
    <section
      className={`command-group${running ? " running" : ""}${
        failed ? " error" : ""
      }${groupExpanded ? " expanded" : ""}`}
    >
      <button
        className="command-group-heading"
        type="button"
        aria-expanded={groupExpanded}
        onClick={() => setGroupExpanded((current) => !current)}
      >
        <span className="command-group-glyph">
          {running ? <LoaderCircle size={14} /> : failed ? <X size={13} /> : <Terminal size={14} />}
        </span>
        <strong>{groupLabel}</strong>
        <span>{running ? "远程终端活动中" : failed ? "部分命令失败" : "远程终端"}</span>
        <ChevronRight className="command-group-chevron" size={13} />
      </button>
      <div className="command-list-motion">
        <div className="command-list">
          {events.map((event) => (
            <CommandEventItem event={event} key={event.id} />
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentEventRow({
  event,
  onApproval,
  runStatus,
  workflowSteps,
}: {
  event: WorkEvent;
  onApproval?: (event: WorkEvent, approved: boolean) => void;
  runStatus?: RunTrace["status"];
  workflowSteps?: WorkflowStep[];
}) {
  const kind = normalizedEventKind(event.kind);
  const autoOpen =
    event.status === "running" ||
    (kind === "plan" && runStatus === "running");
  const [expanded, setExpanded] = useAutoDisclosure(autoOpen);
  const disclosable = Boolean(
    event.detail ||
      event.path ||
      event.output ||
      (kind === "plan" && workflowSteps?.length) ||
      (kind === "approval_request" && event.status === "pending"),
  );
  return (
    <article
      className={`agent-event ${kind} ${event.status}${expanded ? " expanded" : ""}`}
    >
      <button
        className="agent-event-summary"
        type="button"
        aria-expanded={disclosable ? expanded : undefined}
        onClick={() => disclosable && setExpanded((current) => !current)}
      >
        <span className="agent-event-glyph">
          <EventGlyph event={event} />
        </span>
        <span className="agent-event-copy">
          <strong>{event.title}</strong>
          {event.detail && <small>{event.detail}</small>}
        </span>
        <span className="agent-event-status">{eventStatusLabel(event.status)}</span>
        {disclosable && <ChevronRight className="agent-event-chevron" size={13} />}
      </button>
      {disclosable && (
        <div className="agent-event-detail-motion">
          <div>
            <div className="agent-event-detail">
              {event.path && <code className="agent-event-path">{event.path}</code>}
              {kind === "plan" && workflowSteps?.length ? (
                <div className="trace-steps plan-event-steps">
                  {workflowSteps.map((step) => (
                    <div
                      className={`trace-step ${step.status}`}
                      key={step.id}
                      aria-label={`${step.title}，${eventStatusLabel(step.status)}`}
                    >
                      <StatusGlyph status={step.status} />
                      <span className="trace-step-copy">
                        <strong>{step.title}</strong>
                        {step.detail && <small>{step.detail}</small>}
                      </span>
                    </div>
                  ))}
                </div>
              ) : event.output ? (
                <div className="agent-event-output">
                  <MarkdownContent content={event.output} compact />
                </div>
              ) : null}
              {kind === "approval_request" &&
                event.status === "pending" &&
                onApproval && (
                  <div className="approval-actions">
                    <button type="button" onClick={() => onApproval(event, false)}>
                      拒绝
                    </button>
                    <button type="button" onClick={() => onApproval(event, true)}>
                      允许
                    </button>
                  </div>
                )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function WorkEventFeed({
  events,
  onApproval,
  runStatus,
  workflowSteps,
}: {
  events: WorkEvent[];
  onApproval?: (event: WorkEvent, approved: boolean) => void;
  runStatus?: RunTrace["status"];
  workflowSteps?: WorkflowStep[];
}) {
  const visibleEvents = events
    .filter(
      (event) =>
        !["message", "reasoning"].includes(normalizedEventKind(event.kind)),
    )
    .filter(
      (event) =>
        !(
          normalizedEventKind(event.kind) === "plan" &&
          /开始新步骤|开始推进下一步/.test(event.title)
        ),
    )
    .map((event) =>
      event.status === "running" && (runStatus === "done" || runStatus === "error")
        ? {
            ...event,
            status: runStatus === "done" ? ("done" as const) : ("error" as const),
          }
        : event,
    );
  const segments: Array<
    | { type: "commands"; id: string; events: WorkEvent[] }
    | { type: "event"; id: string; event: WorkEvent }
  > = [];

  for (const event of visibleEvents) {
    if (normalizedEventKind(event.kind) === "tool_call" || event.command) {
      const previous = segments.at(-1);
      if (previous?.type === "commands") {
        previous.events.push(event);
      } else {
        segments.push({ type: "commands", id: event.id, events: [event] });
      }
    } else {
      segments.push({ type: "event", id: event.id, event });
    }
  }

  if (!segments.length) return null;
  return (
    <div className="agent-activity" aria-label="Agent 调用过程">
      {segments.map((segment) =>
        segment.type === "commands" ? (
          <CommandEventGroup events={segment.events} key={segment.id} />
        ) : (
          <AgentEventRow
            event={segment.event}
            key={segment.id}
            onApproval={onApproval}
            runStatus={runStatus}
            workflowSteps={workflowSteps}
          />
        ),
      )}
    </div>
  );
}

function ScrollingTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      const viewport = viewportRef.current;
      const text = textRef.current;
      setOffset(
        viewport && text
          ? Math.max(
              0,
              Math.ceil(text.scrollWidth - viewport.clientWidth + 14),
            )
          : 0,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (viewportRef.current) observer?.observe(viewportRef.current);
    if (textRef.current) observer?.observe(textRef.current);
    return () => observer?.disconnect();
  }, [title]);

  return (
    <span
      className={`chat-title-viewport${offset ? " scrollable" : ""}`}
      title={title}
      ref={viewportRef}
      style={{ "--title-offset": `${offset}px` } as React.CSSProperties}
    >
      <span ref={textRef}>{title}</span>
    </span>
  );
}

function ConversationRow({
  conversation,
  active,
  nested = false,
  projects,
  menuOpen,
  onSelect,
  onToggleMenu,
  onMove,
  onMoveToNewProject,
  onRename,
  onTogglePin,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  nested?: boolean;
  projects: Project[];
  menuOpen: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onMove: (projectId?: string) => void;
  onMoveToNewProject: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const destinations = projects.filter((project) => project.id !== conversation.projectId);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({
    left: 0,
    top: 0,
    ready: false,
  });

  useEffect(() => {
    if (!menuOpen) return;

    const updatePosition = () => {
      const anchor = menuButtonRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const menuWidth = menuRef.current?.offsetWidth || 214;
      const menuHeight = menuRef.current?.offsetHeight || 220;
      const below = rect.bottom + 4;
      const top =
        below + menuHeight <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - menuHeight - 4);
      const left = Math.max(
        8,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
      );
      setMenuPosition({ left, top, ready: true });
    };
    const frame = window.requestAnimationFrame(updatePosition);
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        menuRef.current?.contains(target) ||
        menuButtonRef.current?.contains(target)
      ) {
        return;
      }
      onToggleMenu();
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [menuOpen, onToggleMenu]);

  return (
    <div
      className={`chat-row${nested ? " project-chat-row" : ""}${
        conversation.mode === "work" ? " work" : ""
      }${
        active ? " active" : ""
      }`}
    >
      <button className="chat-row-main" type="button" onClick={onSelect}>
        <ScrollingTitle title={conversation.title} />
      </button>
      {conversation.mode === "work" && (
        <span className="conversation-work-mark">工作</span>
      )}
      <button
        ref={menuButtonRef}
        className="chat-row-menu-button"
        type="button"
        aria-label={`打开“${conversation.title}”的对话选项`}
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation();
          onToggleMenu();
        }}
      >
        <Ellipsis size={16} />
      </button>
      {menuOpen &&
        typeof document !== "undefined" &&
        createPortal(
        <div
          className="conversation-menu conversation-menu-portal"
          role="menu"
          ref={menuRef}
          style={{
            left: menuPosition.left,
            top: menuPosition.top,
            visibility: menuPosition.ready ? "visible" : "hidden",
          }}
        >
          <button type="button" role="menuitem" onClick={onRename}>
            <Pencil size={15} />
            重命名
          </button>
          <div className="conversation-menu-submenu">
            <button
              className="conversation-menu-submenu-trigger"
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onClick={(event) => event.stopPropagation()}
            >
              <FolderPlus size={15} />
              <span>移至项目</span>
              <ChevronRight className="conversation-menu-submenu-chevron" size={15} />
            </button>
            <div className="conversation-move-submenu" role="menu">
              <button type="button" role="menuitem" onClick={onMoveToNewProject}>
                <FolderPlus size={15} />
                新项目
              </button>
              {!!destinations.length && <span className="conversation-menu-separator" />}
              {destinations.map((project) => (
                <button
                  type="button"
                  role="menuitem"
                  key={project.id}
                  onClick={() => onMove(project.id)}
                >
                  <Folder size={15} />
                  {project.name}
                </button>
              ))}
            </div>
          </div>
          {conversation.projectId && (
            <button type="button" role="menuitem" onClick={() => onMove(undefined)}>
              <Folder size={15} />
              从项目中移出
            </button>
          )}
          <button type="button" role="menuitem" onClick={onTogglePin}>
            {conversation.pinned ? <PinOff size={15} /> : <Pin size={15} />}
            {conversation.pinned ? "取消置顶" : "置顶聊天"}
          </button>
          <span className="conversation-menu-separator" />
          <button className="danger" type="button" role="menuitem" onClick={onDelete}>
            <Trash2 size={15} />
            删除聊天
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function UnifiedComposer({
  value,
  placeholder,
  disabled = false,
  sending = false,
  skills,
  selectedSkills,
  model,
  models,
  modelsLoading = false,
  modelError = "",
  textareaRef,
  menuDirection = "up",
  onChange,
  onSubmit,
  onStop,
  onUpload,
  onToggleSkill,
  onDetectModels,
  onSelectModel,
}: {
  value: string;
  placeholder: string;
  disabled?: boolean;
  sending?: boolean;
  skills: SkillItem[];
  selectedSkills: string[];
  model: string;
  models: string[];
  modelsLoading?: boolean;
  modelError?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  menuDirection?: "up" | "down";
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onUpload: (files: FileList | null) => void;
  onToggleSkill: (skillId: string) => void;
  onDetectModels: () => void;
  onSelectModel: (model: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPage, setMenuPage] = useState<"root" | "skills">("root");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const skillMenuHeight = Math.min(54 + Math.max(enabledSkills.length, 1) * 52, 314);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!menuWrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        window.setTimeout(() => setMenuPage("root"), 220);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [menuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!modelWrapRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [modelMenuOpen]);

  const closeMenu = () => {
    setMenuOpen(false);
    window.setTimeout(() => setMenuPage("root"), 220);
  };

  return (
    <div className={`unified-composer${sending ? " busy" : ""}`}>
      <div className="composer-add-wrap" ref={menuWrapRef}>
        <button
          className={`composer-add-button${menuOpen ? " active" : ""}`}
          type="button"
          aria-label="添加内容"
          aria-expanded={menuOpen}
          onClick={() => {
            if (menuOpen) {
              closeMenu();
            } else {
              setMenuPage("root");
              setMenuOpen(true);
            }
          }}
        >
          <Plus size={19} />
        </button>
        <input
          ref={fileInputRef}
          hidden
          multiple
          type="file"
          onChange={(event) => {
            onUpload(event.currentTarget.files);
            event.currentTarget.value = "";
            closeMenu();
          }}
        />
        {menuOpen && (
          <div
            className={`composer-menu-popover ${menuDirection} ${
              menuPage === "skills" ? "show-skills" : ""
            }`}
            style={
              {
                "--composer-skill-height": `${skillMenuHeight}px`,
              } as React.CSSProperties
            }
          >
            <div className="composer-menu-track">
              <div className="composer-menu-panel root-panel">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="composer-menu-icon">
                    <Paperclip size={17} />
                  </span>
                  <span>上传文件</span>
                </button>
                <button type="button" onClick={() => setMenuPage("skills")}>
                  <span className="composer-menu-icon">
                    <Sparkles size={17} />
                  </span>
                  <span>选择技能</span>
                  <ChevronRight className="composer-menu-next" size={16} />
                </button>
              </div>
              <div className="composer-menu-panel skills-panel">
                <button
                  className="composer-menu-back"
                  type="button"
                  onClick={() => setMenuPage("root")}
                >
                  <ChevronLeft size={16} />
                  <span>返回</span>
                </button>
                <div className="composer-skill-list">
                  {enabledSkills.map((skill) => {
                    const selected = selectedSkills.includes(skill.id);
                    return (
                      <button
                        className={selected ? "selected" : ""}
                        type="button"
                        key={skill.id}
                        onClick={() => onToggleSkill(skill.id)}
                      >
                        <span className="composer-menu-icon">{skillIcon(skill)}</span>
                        <span className="composer-skill-copy">
                          <strong>{skill.name}</strong>
                          {skill.description && <small>{skill.description}</small>}
                        </span>
                        <span className="composer-skill-check">
                          {selected && <Check size={14} />}
                        </span>
                      </button>
                    );
                  })}
                  {!enabledSkills.length && (
                    <span className="composer-menu-empty">暂无已安装的技能</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        rows={1}
        aria-label="消息输入框"
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!disabled && value.trim()) onSubmit();
          }
        }}
      />
      <div className="composer-model-wrap" ref={modelWrapRef}>
        <button
          className={`composer-model-button${modelMenuOpen ? " active" : ""}`}
          type="button"
          aria-label="选择模型"
          aria-expanded={modelMenuOpen}
          disabled={sending}
          title={model || "选择模型"}
          onClick={() => {
            setModelMenuOpen((current) => {
              const next = !current;
              if (next) onDetectModels();
              return next;
            });
          }}
        >
          <span>{model || "选择模型"}</span>
          {modelsLoading ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <ChevronDown size={13} />
          )}
        </button>
        {modelMenuOpen && (
          <div className={`composer-model-popover ${menuDirection}`}>
            <div className="composer-model-heading">
              <strong>选择模型</strong>
              <button
                type="button"
                onClick={onDetectModels}
                disabled={modelsLoading}
                aria-label="重新检测模型"
              >
                <RefreshCw className={modelsLoading ? "spin" : undefined} size={14} />
              </button>
            </div>
            <div className="composer-model-list">
              {models.map((item) => (
                <button
                  className={item === model ? "selected" : ""}
                  type="button"
                  key={item}
                  onClick={() => {
                    onSelectModel(item);
                    setModelMenuOpen(false);
                  }}
                >
                  <span title={item}>{item}</span>
                  {item === model && <Check size={14} />}
                </button>
              ))}
              {modelsLoading && !models.length && (
                <span className="composer-model-state">
                  <LoaderCircle className="spin" size={15} />
                  正在检测模型
                </span>
              )}
              {!modelsLoading && modelError && (
                <span className="composer-model-state error">{modelError}</span>
              )}
              {!modelsLoading && !modelError && !models.length && (
                <span className="composer-model-state">暂无可用模型</span>
              )}
            </div>
          </div>
        )}
      </div>
      {sending ? (
        <button
          className="unified-send-button stop"
          type="button"
          onClick={onStop}
          aria-label="停止"
        >
          <Square size={13} fill="currentColor" />
        </button>
      ) : (
        <button
          className="unified-send-button"
          type="button"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          aria-label="发送"
        >
          <ArrowUp size={18} />
        </button>
      )}
    </div>
  );
}

export default function EasyWorkApp() {
  const [state, setState] = useState<EasyWorkState>(DEFAULT_STATE);
  const [actor, setActor] = useState<Actor>(DEFAULT_ACTOR);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [activeProjectId, setActiveProjectId] = useState("");
  const [draftProjectId, setDraftProjectId] = useState<string | undefined>();
  const [mode, setMode] = useState<Mode>("chat");
  const [view, setView] = useState<ViewName>("chat");
  const [draft, setDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    new Set(),
  );
  const [projectSectionOpen, setProjectSectionOpen] = useState(true);
  const [chatSectionOpen, setChatSectionOpen] = useState(true);
  const [expandedProjectConversationIds, setExpandedProjectConversationIds] =
    useState<Set<string>>(new Set());
  const [projectPageTab, setProjectPageTab] = useState<"chats" | "files">(
    "chats",
  );
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectModalConversationId, setProjectModalConversationId] =
    useState("");
  const [projectEditor, setProjectEditor] = useState<{
    project: Project;
    mode: "rename" | "settings";
  } | null>(null);
  const [projectPendingDelete, setProjectPendingDelete] =
    useState<Project | null>(null);
  const [projectLibraryModalOpen, setProjectLibraryModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const [sshModalContext, setSshModalContext] = useState<
    "bound" | "new-work" | "manage"
  >("new-work");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [agentMenuPage, setAgentMenuPage] = useState<
    "root" | "config" | "models"
  >("root");
  const [manualAgentOpen, setManualAgentOpen] = useState(false);
  const [manualAgentName, setManualAgentName] = useState("");
  const [manualAgentFolder, setManualAgentFolder] = useState("");
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [agentConfigAgentId, setAgentConfigAgentId] = useState("");
  const [agentConfigPath, setAgentConfigPath] = useState("");
  const [agentConfigContent, setAgentConfigContent] = useState("");
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
  const [agentUpdatesByServer, setAgentUpdatesByServer] = useState<
    Record<string, AgentUpdateState>
  >({});
  const [agentModelsByServer, setAgentModelsByServer] = useState<
    Record<string, AgentModelConfigState>
  >({});
  const [agentUpdateModalOpen, setAgentUpdateModalOpen] = useState(false);
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [remoteFilePath, setRemoteFilePath] = useState("~");
  const [remoteFileHome, setRemoteFileHome] = useState("");
  const [remoteFileParent, setRemoteFileParent] = useState<string | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileEntry[]>([]);
  const [remoteFilesLoading, setRemoteFilesLoading] = useState(false);
  const [embeddingModalOpen, setEmbeddingModalOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<"login" | "register" | "profile" | "api">(
    "login",
  );
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [selectedServerId, setSelectedServerId] = useState("");
  const [draftServerId, setDraftServerId] = useState("");
  const [gatewayStatus, setGatewayStatus] = useState<
    "checking" | "connected" | "unavailable"
  >("checking");
  const [gatewayProbe, setGatewayProbe] = useState(0);
  const [deviceToken, setDeviceToken] = useState("");
  const [agentsByServer, setAgentsByServer] = useState<Record<string, AgentItem[]>>({});
  const [activeAgentByServer, setActiveAgentByServer] = useState<
    Record<string, string>
  >({});
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [memoryFilter, setMemoryFilter] = useState<"all" | "global" | "project">(
    "all",
  );
  const [memoryInstruction, setMemoryInstruction] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState("");
  const [editingMemoryText, setEditingMemoryText] = useState("");
  const [conversationMenuId, setConversationMenuId] = useState("");
  const [projectMenuId, setProjectMenuId] = useState("");
  const [conversationPendingDelete, setConversationPendingDelete] =
    useState<Conversation | null>(null);
  const [conversationEditor, setConversationEditor] =
    useState<Conversation | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [providerModelsError, setProviderModelsError] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const hydratedActorIdRef = useRef("");
  const stateSaveTimerRef = useRef<number | null>(null);
  const stateSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingStateSaveRef = useRef<{
    snapshot: EasyWorkState;
    deviceToken: string;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const skillInputRef = useRef<HTMLInputElement | null>(null);
  const skillFolderInputRef = useRef<HTMLInputElement | null>(null);
  const remoteUploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingServerBindingRef = useRef<{
    conversationId: string;
    serverId: string;
  } | null>(null);

  const activeConversation = useMemo(
    () => state.conversations.find((item) => item.id === activeConversationId),
    [activeConversationId, state.conversations],
  );

  const activeProject = useMemo(
    () =>
      state.projects.find(
        (item) => item.id === (activeConversation?.projectId ?? draftProjectId),
      ),
    [activeConversation?.projectId, draftProjectId, state.projects],
  );

  const projectPage = useMemo(
    () => state.projects.find((item) => item.id === activeProjectId),
    [activeProjectId, state.projects],
  );
  const activeLastMessage = activeConversation?.messages.at(-1);
  const activeMessageCount = activeConversation?.messages.length ?? 0;
  const activeStreamProgress = [
    activeLastMessage?.content.length ?? 0,
    activeLastMessage?.reasoning?.length ?? 0,
    activeLastMessage?.events?.length ?? 0,
  ].join(":");

  const globalServerId =
    selectedServerId ||
    state.settings.lastServerId ||
    state.settings.servers.find((profile) => connections[profile.id]?.status === "connected")
      ?.id ||
    state.settings.servers[0]?.id ||
    "";
  const effectiveServerId =
    mode === "work"
      ? activeConversation?.work?.serverId || draftServerId || ""
      : "";
  const connection: ConnectionState = connections[effectiveServerId] ?? {
    serverId: effectiveServerId,
    status: "disconnected",
    label: "尚未连接远程服务器",
    host: state.settings.servers.find((profile) => profile.id === effectiveServerId)?.host,
    username: state.settings.servers.find(
      (profile) => profile.id === effectiveServerId,
    )?.username,
  };
  const agents = dedupeAgents(
    effectiveServerId
      ? agentsByServer[effectiveServerId] ?? DEFAULT_AGENTS
      : DEFAULT_AGENTS,
  );
  const activeAgentId =
    activeConversation?.work?.agentId ||
    activeAgentByServer[effectiveServerId] ||
    agents.find((item) => item.status === "ready")?.id ||
    "opencode";
  const activeAgent =
    agents.find((item) => item.id === activeAgentId) ??
    agents.find((item) => item.status === "ready") ??
    agents[0];
  const activeAgentUpdate = agentUpdatesByServer[effectiveServerId] ?? {
    status: "idle",
  };
  const activeAgentModelConfig = agentModelsByServer[effectiveServerId] ?? {
    status: "idle",
  };
  const configAgent =
    agents.find((item) => item.id === agentConfigAgentId) || activeAgent;
  const activeServerProfile = state.settings.servers.find(
    (profile) => profile.id === effectiveServerId,
  );
  const workReady =
    mode !== "work" ||
    (connection.status === "connected" &&
      activeAgent?.status === "ready" &&
      Boolean(activeAgent.configured));

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const detectProviderModels = useCallback(async () => {
    const provider = state.settings.provider;
    if (!provider.baseUrl || !provider.configured) {
      setProviderModels([]);
      setProviderModelsError("请先在个人资料中配置模型 API");
      return;
    }
    setProviderModelsLoading(true);
    setProviderModels([]);
    setProviderModelsError("");
    try {
      const response = await gatewayFetch("/api/settings/provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: provider.baseUrl }),
      });
      const payload = (await response.json()) as {
        models?: string[];
        error?: string;
      };
      if (!response.ok || !payload.models?.length) {
        throw new Error(payload.error || "没有检测到可用模型");
      }
      setProviderModels(payload.models);
    } catch (caught) {
      setProviderModels([]);
      setProviderModelsError(
        caught instanceof Error ? caught.message : "模型检测失败",
      );
    } finally {
      setProviderModelsLoading(false);
    }
  }, [state.settings.provider]);

  const selectProviderModel = useCallback(
    async (modelId: string) => {
      const previousModel = state.settings.provider.model;
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          provider: { ...current.settings.provider, model: modelId },
        },
      }));
      try {
        const response = await gatewayFetch("/api/settings/provider", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: state.settings.provider.baseUrl,
            model: modelId,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          provider?: AppSettings["provider"];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "模型保存失败");
        if (payload.provider) {
          setState((current) => ({
            ...current,
            settings: { ...current.settings, provider: payload.provider! },
          }));
        }
        showToast(`已选择 ${modelId}`);
      } catch (caught) {
        setState((current) => ({
          ...current,
          settings: {
            ...current.settings,
            provider: { ...current.settings.provider, model: previousModel },
          },
        }));
        showToast(caught instanceof Error ? caught.message : "模型保存失败");
      }
    },
    [showToast, state.settings.provider],
  );

  const updateConversation = useCallback(
    (conversationId: string, updater: (conversation: Conversation) => Conversation) => {
      setState((current) => ({
        ...current,
        conversations: current.conversations.map((conversation) =>
          conversation.id === conversationId ? updater(conversation) : conversation,
        ),
      }));
    },
    [],
  );

  const updateMessage = useCallback(
    (
      conversationId: string,
      matcher: (message: Message) => boolean,
      updater: (message: Message) => Message,
    ) => {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        updatedAt: now(),
        messages: conversation.messages.map((message) =>
          matcher(message) ? updater(message) : message,
        ),
      }));
    },
    [updateConversation],
  );

  const simulateWorkRun = useCallback(
    (conversationId: string, runId: string, prompt: string) => {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        title:
          conversation.title === "新对话"
            ? fallbackConversationTitle(prompt)
            : conversation.title,
      }));
      const isMemoryQuestion = /内存|显存|资源|memory|gpu/i.test(prompt);
      const isFileTask = /文件|代码|修改|编辑|脚本|报告/i.test(prompt);
      const steps = isMemoryQuestion
        ? ["查看服务器内存", "查看可用资源", "判断任务所需资源是否满足"]
        : isFileTask
          ? ["确认工作目录与约束", "检查相关文件", "执行修改", "验证并整理结果"]
          : ["理解请求并确认工作目录", "执行任务", "检查结果并整理回复"];
      updateMessage(
        conversationId,
        (message) => message.runId === runId && message.role === "user",
        (message) => ({
          ...message,
          trace: {
            runId,
            status: "running",
            startedAt: now(),
            steps: steps.map((title, index) => ({
              id: `${runId}_step_${index}`,
              title,
              status: index === 0 ? "running" : "pending",
            })),
          },
        }),
      );

      const eventPlan: WorkEvent = {
        id: `${runId}_plan`,
        kind: "plan",
        title: `已编排 ${steps.length} 个步骤`,
        detail: "流程已发送给 Agent",
        output: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
        status: "done",
        timestamp: now(),
      };
      updateMessage(
        conversationId,
        (message) => message.runId === runId && message.role === "assistant",
        (message) => ({ ...message, events: [eventPlan] }),
      );

      const outputs = isMemoryQuestion
        ? [
            "Mem: 251Gi total · 164Gi available",
            "4 × NVIDIA A100 80GB · 2 cards idle",
            "当前资源满足一次单卡推理或小规模微调任务。",
          ]
        : isFileTask
          ? [
              "~",
              "train.py\nconfig.yaml\nREADME.md",
              "已更新参数检查与错误提示。",
              "验证通过，结果文件已生成。",
            ]
        : [
            "~",
            "OpenCode 已完成本轮工具调用。",
            "验证通过，未发现阻塞问题。",
          ];
      const commands = isMemoryQuestion
        ? ["free -h", "nvidia-smi", "评估任务资源条件"]
        : isFileTask
          ? ["pwd", "rg --files", "apply_patch train.py", "python -m pytest"]
        : ["pwd", "opencode run", "检查执行结果"];

      steps.forEach((title, index) => {
        window.setTimeout(
          () => {
            updateMessage(
              conversationId,
              (message) => message.runId === runId && message.role === "user",
              (message) => ({
                ...message,
                trace: message.trace
                  ? {
                      ...message.trace,
                      steps: message.trace.steps.map((step, stepIndex) => ({
                        ...step,
                        status:
                          stepIndex < index
                            ? "done"
                            : stepIndex === index
                              ? "running"
                              : "pending",
                      })),
                    }
                  : message.trace,
              }),
            );
            updateMessage(
              conversationId,
              (message) => message.runId === runId && message.role === "assistant",
              (message) => ({
                ...message,
                events: [
                  ...(message.events ?? []).filter(
                    (event) => event.id !== `${runId}_tool_${index}`,
                  ),
                  {
                    id: `${runId}_tool_${index}`,
                    kind:
                      isFileTask && index === 2
                        ? "file_change"
                        : isFileTask &&
                            index === steps.length - 1 &&
                            /报告|结果文件|导出/i.test(prompt)
                          ? "artifact"
                          : index === steps.length - 1
                            ? "job_status"
                            : "tool_call",
                    title,
                    detail: index === 0 ? "bash · 登录节点" : "OpenCode · 算力平台",
                    output: outputs[index],
                    command:
                      index === steps.length - 1 || (isFileTask && index === 2)
                        ? undefined
                        : commands[index],
                    path:
                      isFileTask && index === 2
                        ? "~/train.py"
                        : isFileTask &&
                            index === steps.length - 1 &&
                            /报告|结果文件|导出/i.test(prompt)
                          ? "~/report.md"
                          : undefined,
                    status: "running",
                    timestamp: now(),
                  },
                ],
              }),
            );
          },
          550 + index * 850,
        );

        window.setTimeout(
          () => {
            updateMessage(
              conversationId,
              (message) => message.runId === runId && message.role === "user",
              (message) => ({
                ...message,
                trace: message.trace
                  ? {
                      ...message.trace,
                      status: index === steps.length - 1 ? "done" : "running",
                      result:
                        index === steps.length - 1
                          ? isMemoryQuestion
                            ? "可用内存 164 GiB，当前有 2 张 A100 空闲。"
                            : "任务已执行并完成验证。"
                          : message.trace.result,
                      steps: message.trace.steps.map((step, stepIndex) => ({
                        ...step,
                        status:
                          stepIndex <= index
                            ? "done"
                            : stepIndex === index + 1
                              ? "running"
                              : "pending",
                      })),
                    }
                  : message.trace,
              }),
            );
            updateMessage(
              conversationId,
              (message) => message.runId === runId && message.role === "assistant",
              (message) => ({
                ...message,
                content:
                  index === steps.length - 1
                    ? isMemoryQuestion
                      ? "检查完成。登录节点共有 251 GiB 内存，目前约 164 GiB 可用；GPU 队列中有 2 张 A100 处于空闲状态。按当前资源，轻量推理可以直接进行；如果是训练任务，我建议先提交一个小规模试跑并限制峰值内存。"
                      : "任务已经完成。你可以在右侧展开执行流程，也可以继续在同一个 Agent 任务中追加要求。"
                    : message.content,
                events: (message.events ?? []).map((event) =>
                  event.id === `${runId}_tool_${index}`
                    ? { ...event, status: "done" }
                    : event,
                ),
              }),
            );
            if (index === steps.length - 1) {
              setExpandedTraces((current) => {
                const next = new Set(current);
                next.delete(runId);
                return next;
              });
              setSending(false);
            }
          },
          1150 + index * 850,
        );
      });
    },
    [updateConversation, updateMessage],
  );

  const handleSocketEvent = useCallback(
    (payload: Record<string, unknown>) => {
      const type = String(payload.type ?? "");
      if (type === "connections.snapshot") {
        const incoming = Array.isArray(payload.connections)
          ? (payload.connections as Array<Record<string, unknown>>)
          : [];
        setConnections(
          Object.fromEntries(
            incoming.map((item) => {
              const serverId = String(item.serverId || "");
              return [
                serverId,
                {
                  serverId,
                  status: String(item.status || "connected") as ConnectionState["status"],
                  label: String(item.label || "远程服务器在线"),
                  host: item.host ? String(item.host) : undefined,
                  username: item.username ? String(item.username) : undefined,
                  port: typeof item.port === "number" ? item.port : undefined,
                  latency:
                    typeof item.latency === "number" ? item.latency : undefined,
                  fingerprint:
                    String(item.status || "connected") === "error" &&
                    item.fingerprint
                      ? String(item.fingerprint)
                      : undefined,
                  demo: Boolean(item.demo),
                } satisfies ConnectionState,
              ];
            }),
          ),
        );
        return;
      }
      if (type === "connection.status") {
        const serverId = String(payload.serverId || "");
        if (!serverId) return;
        const status = String(payload.status ?? "disconnected") as ConnectionState["status"];
        const nextConnection: ConnectionState = {
          serverId,
          status,
          label: String(payload.label ?? "连接状态已更新"),
          host: payload.host ? String(payload.host) : undefined,
          username: payload.username ? String(payload.username) : undefined,
          port: typeof payload.port === "number" ? payload.port : undefined,
          latency: typeof payload.latency === "number" ? payload.latency : undefined,
          fingerprint: payload.fingerprint ? String(payload.fingerprint) : undefined,
          demo: Boolean(payload.demo),
        };
        setConnections((current) => ({
          ...current,
          [serverId]:
            status === "disconnected" && current[serverId]?.status === "error"
              ? current[serverId]
              : nextConnection,
        }));
        if (status === "connected") {
          setSelectedServerId(serverId);
          setSshModalOpen(false);
          const pendingBinding = pendingServerBindingRef.current;
          if (pendingBinding?.serverId === serverId) {
            updateConversation(pendingBinding.conversationId, (conversation) => ({
              ...conversation,
              work: {
                ...(conversation.work ?? { workspace: "~" }),
                serverId,
              },
            }));
            pendingServerBindingRef.current = null;
            setDraftServerId("");
          }
        }
        return;
      }
      if (type === "server.profile" && payload.profile) {
        const profile = payload.profile as ServerProfile;
        setState((current) => ({
          ...current,
          settings: {
            ...current.settings,
            servers: [
              profile,
              ...current.settings.servers.filter((item) => item.id !== profile.id),
            ],
            lastServerId: profile.id,
          },
        }));
        return;
      }
      if (type === "agent.list") {
        const serverId = String(payload.serverId || "");
        if (!serverId) return;
        const incoming = dedupeAgents(
          Array.isArray(payload.agents) ? (payload.agents as AgentItem[]) : [],
        );
        setAgentsByServer((current) => ({ ...current, [serverId]: incoming }));
        const firstReady = incoming.find((agent) => agent.status === "ready");
        if (firstReady) {
          setActiveAgentByServer((current) => ({
            ...current,
            [serverId]:
              current[serverId] &&
              incoming.some((agent) => agent.id === current[serverId])
                ? current[serverId]
                : firstReady.id,
          }));
        }
        return;
      }
      if (type === "agent.install.progress") {
        const serverId = String(payload.serverId || "");
        const detail = String(payload.label ?? "正在安装");
        setAgentsByServer((current) => ({
          ...current,
          [serverId]: (current[serverId] ?? DEFAULT_AGENTS).map((agent) =>
            agent.id === "opencode"
              ? { ...agent, status: "installing", detail }
              : agent,
          ),
        }));
        return;
      }
      if (type === "agent.update.status") {
        const serverId = String(payload.serverId || "");
        if (!serverId) return;
        const nextUpdate: AgentUpdateState = {
          status: String(payload.status || "idle") as AgentUpdateState["status"],
          currentVersion: payload.currentVersion
            ? String(payload.currentVersion)
            : undefined,
          latestVersion: payload.latestVersion
            ? String(payload.latestVersion)
            : undefined,
          label: payload.label ? String(payload.label) : undefined,
          error: payload.error ? String(payload.error) : undefined,
        };
        setAgentUpdatesByServer((current) => ({
          ...current,
          [serverId]: {
            ...(current[serverId] ?? { status: "idle" }),
            ...nextUpdate,
          },
        }));
        if (nextUpdate.status === "current") {
          setAgentUpdateModalOpen(false);
          showToast(nextUpdate.label || "OpenCode 已是最新版");
        } else if (
          ["available", "updating", "configuring", "done", "error"].includes(
            nextUpdate.status,
          )
        ) {
          setAgentUpdateModalOpen(true);
        }
        return;
      }
      if (type === "agent.model.status") {
        const serverId = String(payload.serverId || "");
        if (!serverId) return;
        const nextModelState: AgentModelConfigState = {
          status: String(payload.status || "idle") as AgentModelConfigState["status"],
          model: payload.model ? String(payload.model) : undefined,
          label: payload.label ? String(payload.label) : undefined,
          error: payload.error ? String(payload.error) : undefined,
        };
        setAgentModelsByServer((current) => ({
          ...current,
          [serverId]: nextModelState,
        }));
        if (nextModelState.status === "done") {
          showToast(nextModelState.label || "OpenCode 模型配置完成");
        }
        return;
      }
      if (type === "conversation.title") {
        const conversationId = String(payload.conversationId || "");
        const title = String(payload.title || "").trim();
        if (conversationId && title) {
          updateConversation(conversationId, (conversation) => ({
            ...conversation,
            title,
          }));
        }
        return;
      }
      if (type === "agent.config") {
        setAgentConfigPath(String(payload.path || ""));
        setAgentConfigContent(String(payload.content || ""));
        setAgentConfigLoading(false);
        setAgentConfigOpen(true);
        return;
      }
      if (type === "agent.config.saved") {
        setAgentConfigLoading(false);
        showToast("Agent 配置已保存");
        return;
      }
      if (type === "remote.fs.list") {
        setRemoteFilePath(String(payload.path || "~"));
        setRemoteFileHome(String(payload.home || ""));
        setRemoteFileParent(
          payload.parent === null || payload.parent === undefined
            ? null
            : String(payload.parent),
        );
        setRemoteFiles(
          Array.isArray(payload.entries)
            ? (payload.entries as RemoteFileEntry[])
            : [],
        );
        setRemoteFilesLoading(false);
        setFileManagerOpen(true);
        return;
      }
      if (type === "remote.fs.download") {
        const encoded = String(payload.contentBase64 || "");
        const bytes = Uint8Array.from(atob(encoded), (character) =>
          character.charCodeAt(0),
        );
        const url = URL.createObjectURL(new Blob([bytes]));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = String(payload.name || "download");
        anchor.click();
        URL.revokeObjectURL(url);
        showToast("文件下载已开始");
        return;
      }
      if (type === "error") {
        setAgentConfigLoading(false);
        setRemoteFilesLoading(false);
        showToast(String(payload.error ?? "Work 网关操作失败"));
        return;
      }

      const conversationId = String(payload.conversationId ?? "");
      const runId = String(payload.runId ?? "");
      if (!conversationId || !runId) return;

      if (type === "workflow") {
        const steps = Array.isArray(payload.steps)
          ? payload.steps.map((step, index) => {
              const incomingStep =
                typeof step === "object" && step
                  ? (step as Record<string, unknown>)
                  : undefined;
              return {
                id: String(incomingStep?.id ?? `${runId}_step_${index}`),
                title: String(incomingStep?.title ?? step),
                status: String(
                  incomingStep?.status ?? (index === 0 ? "running" : "pending"),
                ) as StepStatus,
                detail: incomingStep?.detail ? String(incomingStep.detail) : undefined,
              };
            })
          : [];
        updateMessage(
          conversationId,
          (message) => message.runId === runId && message.role === "user",
          (message) => ({
            ...message,
            trace: {
              runId,
              status: "running",
              steps,
              startedAt: now(),
            },
          }),
        );
        setExpandedTraces(new Set([runId]));
        return;
      }

      if (type === "workflow.step") {
        const stepIndex = Number(payload.stepIndex);
        const status = String(payload.status ?? "running") as StepStatus;
        if (!Number.isInteger(stepIndex) || stepIndex < 0) return;
        updateMessage(
          conversationId,
          (message) => message.runId === runId && message.role === "user",
          (message) => ({
            ...message,
            trace: message.trace
              ? {
                  ...message.trace,
                  status: status === "error" ? "error" : "running",
                  steps: message.trace.steps.map((step, index) => ({
                    ...step,
                    status:
                      index < stepIndex
                        ? "done"
                        : index === stepIndex
                          ? status
                          : step.status,
                    detail:
                      index === stepIndex && payload.detail
                        ? String(payload.detail)
                        : step.detail,
                  })),
                }
              : message.trace,
          }),
        );
        return;
      }

      if (type === "agent.event") {
        const event = payload.event as Record<string, unknown>;
        const eventId = String(event.id ?? uid("event"));
        const rawKind = String(event.kind ?? "tool_call") as WorkEventKind;
        const workEvent: WorkEvent = {
          id: eventId,
          kind: normalizedEventKind(rawKind),
          title: String(event.title ?? "Agent 事件"),
          detail: event.detail ? String(event.detail) : undefined,
          output: event.output ? String(event.output) : undefined,
          command: event.command ? String(event.command) : undefined,
          path: event.path ? String(event.path) : undefined,
          language: event.language ? String(event.language) : undefined,
          status: String(event.status ?? "done") as EventStatus,
          timestamp: String(event.timestamp ?? now()),
        };
        updateMessage(
          conversationId,
          (message) => message.runId === runId && message.role === "assistant",
          (message) => {
            const previous = message.events ?? [];
            const exists = previous.some((item) => item.id === eventId);
            const eventKind = normalizedEventKind(workEvent.kind);
            const isMessage = eventKind === "message";
            const isReasoning = eventKind === "reasoning";
            return {
              ...message,
              content:
                isMessage && workEvent.output
                  ? workEvent.output
                  : message.content,
              reasoning:
                isReasoning && (workEvent.output || workEvent.detail)
                  ? workEvent.output || workEvent.detail
                  : message.reasoning,
              events:
                isMessage || isReasoning
                  ? previous.filter((item) => item.id !== eventId)
                  : exists
                    ? previous.map((item) =>
                        item.id === eventId ? workEvent : item,
                      )
                    : [...previous, workEvent],
            };
          },
        );
        const stepIndex =
          typeof payload.stepIndex === "number" ? Number(payload.stepIndex) : undefined;
        if (stepIndex !== undefined) {
          updateMessage(
            conversationId,
            (message) => message.runId === runId && message.role === "user",
            (message) => ({
              ...message,
              trace: message.trace
                ? {
                    ...message.trace,
                    steps: message.trace.steps.map((step, index) => ({
                      ...step,
                      status:
                        index < stepIndex
                          ? "done"
                          : index === stepIndex
                            ? workEvent.status === "error"
                              ? "error"
                              : workEvent.status === "done"
                                ? "done"
                                : "running"
                            : index === stepIndex + 1 && workEvent.status === "done"
                              ? "running"
                              : step.status,
                    })),
                  }
                : message.trace,
            }),
          );
        }
        return;
      }

      if (type === "task.complete" || type === "task.error") {
        const failed = type === "task.error";
        const result = String(payload.result ?? (failed ? "任务执行失败" : "任务已完成"));
        updateMessage(
          conversationId,
          (message) => message.runId === runId && message.role === "user",
          (message) => ({
            ...message,
            trace: message.trace
              ? {
                  ...message.trace,
                  status: failed ? "error" : "done",
                  result,
                  steps: message.trace.steps.map((step) => ({
                    ...step,
                    status: failed
                      ? step.status === "running"
                        ? "error"
                        : step.status
                      : "done",
                  })),
                }
              : message.trace,
          }),
        );
        updateMessage(
          conversationId,
          (message) => message.runId === runId && message.role === "assistant",
          (message) => ({
            ...message,
            content: failed ? result : message.content,
            events: (message.events ?? []).map((event) =>
              event.status === "running"
                ? {
                    ...event,
                    status: failed ? ("error" as const) : ("done" as const),
                  }
                : event,
            ),
          }),
        );
        setExpandedTraces((current) => {
          if (!current.has(runId)) return current;
          const next = new Set(current);
          next.delete(runId);
          return next;
        });
        setSending(false);
      }
    },
    [showToast, updateConversation, updateMessage],
  );

  useEffect(() => {
    skillFolderInputRef.current?.setAttribute("webkitdirectory", "");
    skillFolderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    const syncDeviceToken = () => setDeviceToken(readDeviceToken());
    syncDeviceToken();
    window.addEventListener(DEVICE_TOKEN_EVENT, syncDeviceToken);
    return () => window.removeEventListener(DEVICE_TOKEN_EVENT, syncDeviceToken);
  }, []);

  useEffect(() => {
    const closeFloatingMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        !target.closest(
          ".chat-row, .project-list-item, .conversation-menu, .conversation-mode-menu, .agent-selector",
        )
      ) {
        setConversationMenuId("");
        setProjectMenuId("");
        setModeMenuOpen(false);
        setAgentMenuOpen(false);
        setAgentMenuPage("root");
      }
    };
    document.addEventListener("pointerdown", closeFloatingMenus);
    return () => document.removeEventListener("pointerdown", closeFloatingMenus);
  }, []);

  useEffect(() => {
    let disposed = false;
    const bootstrap = async () => {
      setGatewayStatus("checking");
      for (const candidate of gatewayCandidates()) {
        try {
          const response = await gatewayFetch("/api/bootstrap", {
            signal: AbortSignal.timeout(2_500),
          }, candidate);
          if (!response.ok) continue;
          const payload = (await response.json()) as {
            actor?: Actor;
            deviceToken?: string;
            state?: Partial<EasyWorkState>;
          };
          if (!payload.actor) continue;
          if (disposed) return;
          GATEWAY_HTTP = candidate;
          const shouldHydrate =
            hydratedActorIdRef.current !== payload.actor.id;
          hydratedActorIdRef.current = payload.actor.id;
          setGatewayStatus("connected");
          setActor(payload.actor);
          storeDeviceToken(payload.deviceToken);
          if (payload.state && shouldHydrate) {
            setState(mergeStoredState(DEFAULT_STATE, payload.state ?? {}));
          }
          return;
        } catch {
          // Continue with the next reachable EasyWork service candidate.
        }
      }
      if (!disposed) {
        setGatewayStatus("unavailable");
      }
    };
    void bootstrap();
    return () => {
      disposed = true;
    };
  }, [gatewayProbe]);

  useEffect(() => {
    if (gatewayStatus !== "unavailable") return;
    const timer = window.setTimeout(
      () => setGatewayProbe((current) => current + 1),
      4_000,
    );
    return () => window.clearTimeout(timer);
  }, [gatewayProbe, gatewayStatus]);

  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    const url = new URL(GATEWAY_HTTP);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/easywork-ws";
    if (deviceToken) url.searchParams.set("deviceToken", deviceToken);
    const socket = new WebSocket(url);
    let disposed = false;
    socketRef.current = socket;
    socket.onopen = () => undefined;
    socket.onmessage = (event) => {
      try {
        handleSocketEvent(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        // Ignore malformed gateway diagnostics; the next valid event remains usable.
      }
    };
    socket.onclose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (disposed) return;
      setConnections((current) =>
        Object.fromEntries(
          Object.entries(current).map(([serverId, item]) => [
            serverId,
            {
              ...item,
              status: "disconnected",
              label: "EasyWork 服务连接已断开",
            },
          ]),
        ),
      );
      setGatewayStatus("unavailable");
    };
    return () => {
      disposed = true;
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [deviceToken, gatewayStatus, handleSocketEvent]);

  const queueStateSave = useCallback((snapshot: EasyWorkState, ownerToken: string) => {
    stateSaveQueueRef.current = stateSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ownerToken) headers.Authorization = `Bearer ${ownerToken}`;
        const response = await gatewayFetch("/api/state", {
          method: "PUT",
          headers,
          body: JSON.stringify({ state: snapshot }),
        });
        if (!response.ok) throw new Error("state save failed");
      });
  }, []);

  useEffect(() => {
    pendingStateSaveRef.current = {
      snapshot: state,
      deviceToken: readDeviceToken(),
    };
    if (gatewayStatus !== "connected" || stateSaveTimerRef.current !== null) {
      return;
    }
    stateSaveTimerRef.current = window.setTimeout(() => {
      stateSaveTimerRef.current = null;
      const pending = pendingStateSaveRef.current;
      if (pending) queueStateSave(pending.snapshot, pending.deviceToken);
    }, 320);
  }, [gatewayStatus, queueStateSave, state]);

  useEffect(
    () => () => {
      if (stateSaveTimerRef.current !== null) {
        window.clearTimeout(stateSaveTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: sending ? "auto" : "smooth",
      block: "end",
    });
  }, [
    activeMessageCount,
    activeStreamProgress,
    sending,
  ]);

  const selectConversation = (conversation: Conversation) => {
    setActiveConversationId(conversation.id);
    setDraftProjectId(undefined);
    setDraftServerId("");
    setActiveProjectId(conversation.projectId ?? "");
    setMode(conversation.mode);
    setView("chat");
    setRightRailOpen(false);
    setConversationMenuId("");
    setProjectMenuId("");
    setModeMenuOpen(false);
    setSidebarOpen(false);
    if (conversation.projectId) {
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        next.add(conversation.projectId!);
        return next;
      });
    }
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const beginConversation = (projectId?: string, nextMode: Mode = "chat") => {
    setActiveConversationId("");
    setDraftProjectId(projectId);
    setDraftServerId("");
    setActiveProjectId(projectId ?? "");
    setMode(nextMode);
    setDraft("");
    setSelectedSkills([]);
    setView("chat");
    setRightRailOpen(false);
    setConversationMenuId("");
    setProjectMenuId("");
    setModeMenuOpen(false);
    setSidebarOpen(false);
    if (projectId) {
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        next.add(projectId);
        return next;
      });
    }
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const openProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setActiveConversationId("");
    setDraftProjectId(undefined);
    setDraftServerId("");
    setMode("chat");
    setDraft("");
    setSelectedSkills([]);
    setView("project");
    setRightRailOpen(false);
    setConversationMenuId("");
    setProjectMenuId("");
    setSidebarOpen(false);
    setProjectPageTab("chats");
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  };

  const toggleProjectExpansion = (projectId: string) => {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    setProjectMenuId("");
  };

  const createProject = (name: string, memoryMode: Project["memoryMode"]) => {
    const conversationId = projectModalConversationId;
    const project: Project = {
      id: uid("project"),
      name: name.trim() || "未命名项目",
      icon: (name.trim()[0] || "P").toUpperCase(),
      memoryMode,
      fileIds: [],
      createdAt: now(),
    };
    setState((current) => ({
      ...current,
      projects: [...current.projects, project],
      conversations: conversationId
        ? current.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  projectId: project.id,
                  updatedAt: now(),
                }
              : conversation,
          )
        : current.conversations,
    }));
    setProjectModalOpen(false);
    setProjectModalConversationId("");
    setExpandedProjectIds((current) => new Set(current).add(project.id));
    setProjectSectionOpen(true);
    if (conversationId) {
      setConversationMenuId("");
      showToast("项目已创建，对话已移入项目");
    } else {
      openProject(project.id);
    }
  };

  const updateProject = (
    projectId: string,
    updates: Pick<Project, "name" | "memoryMode">,
  ) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              name: updates.name.trim() || project.name,
              icon: (updates.name.trim()[0] || project.icon).toUpperCase(),
              memoryMode: updates.memoryMode,
            }
          : project,
      ),
    }));
    setProjectEditor(null);
    showToast("项目已更新");
  };

  const toggleProjectPin = (projectId: string) => {
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) =>
        project.id === projectId
          ? { ...project, pinned: !project.pinned }
          : project,
      ),
    }));
    setProjectMenuId("");
  };

  const deleteProject = (projectId: string) => {
    setState((current) => ({
      ...current,
      projects: current.projects.filter((project) => project.id !== projectId),
      conversations: current.conversations.filter(
        (conversation) => conversation.projectId !== projectId,
      ),
    }));
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    const activeBelongsToProject =
      activeConversation?.projectId === projectId ||
      draftProjectId === projectId ||
      (view === "project" && activeProjectId === projectId);
    if (activeBelongsToProject) beginConversation();
    setProjectPendingDelete(null);
    setProjectMenuId("");
    showToast("项目已删除");
  };

  const changeMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "chat" && !activeConversation) {
      setDraftServerId("");
    }
    if (activeConversation) {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        mode: nextMode,
        work:
          nextMode === "work"
            ? conversation.work ?? {
                agentId: activeAgentId,
                workspace: "~",
              }
            : conversation.work,
      }));
      showToast(`已转换为${nextMode === "work" ? "工作" : "聊天"}模式`);
    }
    setModeMenuOpen(false);
  };

  const openConversationServerManager = () => {
    setSshModalContext(
      activeConversation?.work?.serverId ? "bound" : "new-work",
    );
    setSshModalOpen(true);
  };

  const openGlobalServerManager = () => {
    setSshModalContext("manage");
    setSshModalOpen(true);
    setSidebarOpen(false);
  };

  const selectServerForModal = (serverId: string) => {
    setSelectedServerId(serverId);
    if (sshModalContext === "manage") return;
    if (activeConversation?.work?.serverId) return;
    if (activeConversation && connections[serverId]?.status === "connected") {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        work: {
          ...(conversation.work ?? { workspace: "~" }),
          serverId,
        },
      }));
      setDraftServerId("");
      return;
    }
    setDraftServerId(serverId);
  };

  const saveServerProfile = async (profile: ServerProfileDraft) => {
    try {
      const response = await gatewayFetch(
        `/api/settings/servers/${encodeURIComponent(profile.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(profile),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        profile?: ServerProfile;
        error?: string;
      };
      if (!response.ok || !payload.profile) {
        throw new Error(payload.error || "服务器配置保存失败");
      }
      const savedProfile = payload.profile;
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          servers: [
            savedProfile,
            ...current.settings.servers.filter(
              (item) => item.id !== savedProfile.id,
            ),
          ],
          lastServerId: savedProfile.id,
        },
      }));
      setSelectedServerId(savedProfile.id);
      if (
        sshModalContext !== "manage" &&
        !activeConversation?.work?.serverId
      ) {
        setDraftServerId(savedProfile.id);
      }
      showToast("服务器配置已保存");
    } catch (caught) {
      showToast(
        caught instanceof Error ? caught.message : "服务器配置保存失败",
      );
    }
  };

  const moveConversation = (conversationId: string, projectId?: string) => {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      projectId,
      updatedAt: now(),
    }));
    if (projectId) {
      setProjectSectionOpen(true);
      setExpandedProjectIds((current) => new Set(current).add(projectId));
    } else {
      setChatSectionOpen(true);
    }
    setConversationMenuId("");
    showToast(projectId ? "对话已移动到项目" : "对话已移出项目");
  };

  const renameConversation = (conversationId: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: nextTitle,
      updatedAt: now(),
    }));
    setConversationEditor(null);
    setConversationMenuId("");
    showToast("对话已重命名");
  };

  const toggleConversationPin = (conversationId: string) => {
    const conversation = state.conversations.find(
      (item) => item.id === conversationId,
    );
    updateConversation(conversationId, (item) => ({
      ...item,
      pinned: !item.pinned,
      updatedAt: now(),
    }));
    setConversationMenuId("");
    showToast(conversation?.pinned ? "已取消置顶" : "聊天已置顶");
  };

  const deleteConversation = (conversationId: string) => {
    const deleted = state.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    setState((current) => ({
      ...current,
      conversations: current.conversations.filter(
        (conversation) => conversation.id !== conversationId,
      ),
    }));
    if (activeConversationId === conversationId) {
      if (deleted?.projectId) openProject(deleted.projectId);
      else beginConversation();
    }
    setConversationPendingDelete(null);
    setConversationMenuId("");
    showToast("对话已删除");
  };

  const submitMessage = async (
    options: {
      projectId?: string;
      requestedMode?: Mode;
      openChat?: boolean;
    } = {},
  ) => {
    const content = draft.trim();
    if (!content || sending) return;
    const submissionMode = options.requestedMode ?? mode;
    if (submissionMode === "work" && connection.status !== "connected") {
      openConversationServerManager();
      showToast("请先连接一台远程服务器");
      return;
    }
    if (
      submissionMode === "work" &&
      (activeAgent?.status !== "ready" || !activeAgent.configured)
    ) {
      if (activeAgent?.status === "ready") {
        setAgentConfigAgentId(activeAgent.id);
        setAgentMenuPage("config");
      } else {
        setAgentMenuPage("root");
      }
      setAgentMenuOpen(true);
      showToast(
        activeAgent?.status === "missing"
          ? "请先安装或选择 Agent"
          : "请先完成 Agent 模型配置",
      );
      return;
    }

    const conversation = options.projectId ? undefined : activeConversation;
    const firstTurn = !conversation?.messages.length;
    const conversationId = conversation?.id ?? uid("chat");
    const projectId =
      options.projectId ?? conversation?.projectId ?? draftProjectId;
    const conversationProject = state.projects.find((project) => project.id === projectId);
    const work =
      submissionMode === "work"
        ? {
            ...(conversation?.work ?? {}),
            agentId: conversation?.work?.agentId || activeAgentId,
            serverId: conversation?.work?.serverId || effectiveServerId,
            workspace: conversation?.work?.workspace || "~",
          }
        : conversation?.work;

    const runId = uid("run");
    const userMessage: Message = {
      id: uid("message"),
      role: "user",
      content,
      createdAt: now(),
      mode: submissionMode,
      selectedSkills,
      runId: submissionMode === "work" ? runId : undefined,
    };
    const assistantMessage: Message = {
      id: uid("message"),
      role: "assistant",
      content: "",
      createdAt: now(),
      mode: submissionMode,
      events: submissionMode === "work" ? [] : undefined,
      runId: submissionMode === "work" ? runId : undefined,
    };

    setState((current) => {
      const existing = current.conversations.find((item) => item.id === conversationId);
      if (!existing) {
        const created: Conversation = {
          id: conversationId,
          title: "新对话",
          mode: submissionMode,
          projectId,
          messages: [userMessage, assistantMessage],
          updatedAt: now(),
          work,
        };
        return {
          ...current,
          conversations: [created, ...current.conversations],
        };
      }
      return {
        ...current,
        conversations: current.conversations.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                title: item.messages.length ? item.title : "新对话",
                mode: submissionMode,
                updatedAt: now(),
                work:
                  submissionMode === "work"
                    ? { ...(item.work ?? {}), ...(work ?? {}) }
                    : item.work,
                messages: [...item.messages, userMessage, assistantMessage],
              }
            : item,
        ),
      };
    });
    setActiveConversationId(conversationId);
    setActiveProjectId(projectId ?? "");
    setDraftProjectId(undefined);
    setDraftServerId("");
    setMode(submissionMode);
    if (options.openChat) {
      setView("chat");
      setRightRailOpen(false);
      setSidebarOpen(false);
    }
    if (submissionMode === "work") {
      setExpandedTraces(new Set([runId]));
      if (firstTurn) setRightRailOpen(true);
    }
    setDraft("");
    setSending(true);

    if (submissionMode === "work") {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && !connection.demo) {
        socket.send(
          JSON.stringify({
            type: "work.run",
            serverId: work?.serverId,
            conversationId,
            runId,
            firstTurn,
            prompt: content,
            skills: selectedSkills,
            agentId: activeAgentId,
            projectId,
            memoryMode: conversationProject?.memoryMode ?? "default",
            workspace: work?.workspace ?? "~",
          }),
        );
      } else {
        simulateWorkRun(conversationId, runId, content);
      }
      return;
    }

    const requestBody = JSON.stringify({
      conversationId,
      prompt: content,
      firstTurn,
      skillIds: selectedSkills,
      projectId,
      memoryMode: conversationProject?.memoryMode ?? "default",
    });
    const abortController = new AbortController();
    chatAbortRef.current = abortController;
    try {
      const response = await gatewayFetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        signal: abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("LLM stream unavailable");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let streamError = "";
      const consumeEvent = (line: string) => {
          if (!line.trim()) return;
          let event: {
            type?: string;
            delta?: string;
            title?: string;
            content?: string;
            reasoning?: string;
            error?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === "content_delta" && event.delta) {
            updateMessage(
              conversationId,
              (message) => message.id === assistantMessage.id,
              (message) => ({
                ...message,
                content: `${message.content}${event.delta}`,
              }),
            );
          } else if (event.type === "reasoning_delta" && event.delta) {
            updateMessage(
              conversationId,
              (message) => message.id === assistantMessage.id,
              (message) => ({
                ...message,
                reasoning: `${message.reasoning || ""}${event.delta}`,
              }),
            );
          } else if (event.type === "title" && event.title) {
            updateConversation(conversationId, (item) => ({
              ...item,
              title: event.title!,
            }));
          } else if (event.type === "done") {
            updateMessage(
              conversationId,
              (message) => message.id === assistantMessage.id,
              (message) => ({
                ...message,
                content:
                  event.content ||
                  message.content ||
                  "请求已完成，但模型没有返回可显示的文本。",
                reasoning: event.reasoning || message.reasoning,
              }),
            );
          } else if (event.type === "error") {
            streamError = event.error || "模型流式请求失败";
          }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) consumeEvent(line);
      }
      pending += decoder.decode();
      if (pending.trim()) consumeEvent(pending);
      if (streamError) throw new Error(streamError);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        showToast("已停止生成");
        return;
      }
      updateMessage(
        conversationId,
        (message) => message.id === assistantMessage.id,
        (message) => ({
          ...message,
          content:
            message.content ||
            "暂时无法连接模型服务，请检查 EasyWork 服务与模型 API 设置。",
        }),
      );
    } finally {
      if (chatAbortRef.current === abortController) {
        chatAbortRef.current = null;
      }
      setSending(false);
    }
  };

  const stopCurrentRun = () => {
    if (mode === "chat" && chatAbortRef.current) {
      chatAbortRef.current.abort();
      setSending(false);
      return;
    }
    if (!activeConversation) return;
    const running = [...activeConversation.messages]
      .reverse()
      .find((message) => message.trace?.status === "running");
    if (running?.runId && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "work.abort",
          serverId: activeConversation.work?.serverId,
          conversationId: activeConversation.id,
          runId: running.runId,
        }),
      );
    }
    setSending(false);
    showToast("已请求停止当前任务");
  };

  const respondToApproval = useCallback(
    (
      conversationId: string,
      runId: string,
      event: WorkEvent,
      approved: boolean,
    ) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "work.approval",
            serverId: activeConversation?.work?.serverId || effectiveServerId,
            conversationId,
            runId,
            eventId: event.id,
            approved,
          }),
        );
      }
      updateMessage(
        conversationId,
        (message) => message.runId === runId && message.role === "assistant",
        (message) => ({
          ...message,
          events: (message.events ?? []).map((item) =>
            item.id === event.id
              ? {
                  ...item,
                  detail: approved ? "用户已允许继续" : "用户已拒绝本次操作",
                  status: approved ? "done" : "error",
                }
              : item,
          ),
        }),
      );
    },
    [activeConversation?.work?.serverId, effectiveServerId, updateMessage],
  );

  const connectDemo = () => {
    const serverId = "demo";
    setSelectedServerId(serverId);
    if (sshModalContext !== "manage") {
      setDraftServerId(serverId);
      if (activeConversation && !activeConversation.work?.serverId) {
        pendingServerBindingRef.current = {
          conversationId: activeConversation.id,
          serverId,
        };
      }
    }
    setConnections((current) => ({
      ...current,
      [serverId]: {
        serverId,
        status: "connecting",
        label: "正在创建演示会话…",
      },
    }));
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        servers: current.settings.servers.some((item) => item.id === serverId)
          ? current.settings.servers
          : [
              {
                id: serverId,
                name: "演示服务器",
                host: "demo.easywork.local",
                port: 22,
                username: "demo",
                keyName: "",
                configured: false,
              },
              ...current.settings.servers,
            ],
        lastServerId: serverId,
      },
    }));
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ssh.connect", serverId, demo: true }));
    } else {
      window.setTimeout(() => {
        setConnections((current) => ({
          ...current,
          [serverId]: {
            serverId,
            status: "connected",
            label: "演示登录节点在线",
            host: "demo.easywork.local",
            username: "demo",
            latency: 18,
            demo: true,
          },
        }));
        setAgentsByServer((current) => ({
          ...current,
          [serverId]: [
            {
              id: "opencode",
              name: "OpenCode",
              folder: "~/.easywork/agents/opencode",
              path: "~/.easywork/agents/opencode/bin/opencode",
              version: "demo",
              status: "ready",
              adapter: "opencode",
              managed: true,
              configured: true,
            },
          ],
        }));
        const pendingBinding = pendingServerBindingRef.current;
        if (pendingBinding?.serverId === serverId) {
          updateConversation(pendingBinding.conversationId, (conversation) => ({
            ...conversation,
            work: {
              ...(conversation.work ?? { workspace: "~" }),
              serverId,
            },
          }));
          pendingServerBindingRef.current = null;
          setDraftServerId("");
        }
      }, 650);
    }
  };

  const connectSsh = (payload: {
    serverId: string;
    name?: string;
    host: string;
    port: number;
    username: string;
    authMethod: "key" | "password";
    privateKey?: string;
    privateKeyName?: string;
    password?: string;
    useSavedCredential?: boolean;
    rememberCredential?: boolean;
    passphrase?: string;
    otp?: string;
    trustHost?: boolean;
  }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setGatewayProbe((current) => current + 1);
      showToast("正在重新连接 EasyWork 服务");
      return;
    }
    setSelectedServerId(payload.serverId);
    if (sshModalContext !== "manage") {
      setDraftServerId(payload.serverId);
      if (activeConversation && !activeConversation.work?.serverId) {
        pendingServerBindingRef.current = {
          conversationId: activeConversation.id,
          serverId: payload.serverId,
        };
      }
    }
    setConnections((current) => ({
      ...current,
      [payload.serverId]: {
        ...(current[payload.serverId] ?? {
          serverId: payload.serverId,
        }),
        serverId: payload.serverId,
        status: "connecting",
        label: "正在进行 SSH 握手…",
        host: payload.host,
        username: payload.username,
        port: payload.port,
      },
    }));
    setState((current) => {
      const existing = current.settings.servers.find(
        (profile) => profile.id === payload.serverId,
      );
      const profile: ServerProfile = {
        id: payload.serverId,
        name: payload.name?.trim() || payload.host,
        host: payload.host,
        port: payload.port,
        username: payload.username,
        authMethod: payload.authMethod,
        keyName: payload.privateKeyName || existing?.keyName || "",
        configured: Boolean(
          payload.useSavedCredential || payload.rememberCredential,
        ),
        lastConnectedAt: existing?.lastConnectedAt,
      };
      return {
        ...current,
        settings: {
          ...current.settings,
          servers: [
            profile,
            ...current.settings.servers.filter(
              (item) => item.id !== payload.serverId,
            ),
          ],
          lastServerId: payload.serverId,
        },
      };
    });
    socket.send(JSON.stringify({ type: "ssh.connect", ...payload }));
  };

  const disconnectSsh = (serverId: string) => {
    const socket = socketRef.current;
    if (!serverId || !socket || socket.readyState !== WebSocket.OPEN) {
      showToast("EasyWork 服务未连接");
      return;
    }
    socket.send(JSON.stringify({ type: "ssh.disconnect", serverId }));
  };

  const scanAgents = () => {
    if (connection.demo) {
      setAgentsByServer((current) => ({
        ...current,
        [effectiveServerId]: [
        {
          id: "opencode",
          name: "OpenCode",
          folder: "~/.easywork/agents/opencode",
          path: "~/.easywork/agents/opencode/bin/opencode",
          version: "demo",
          status: "ready",
          adapter: "opencode",
          managed: true,
          configured: true,
        },
        {
          id: "qwen",
          name: "Qwen Code",
          path: "~/.local/bin/qwen",
          version: "0.9.4",
          status: "needs-adapter",
          adapter: "qwen",
        },
        ],
      }));
      showToast("已扫描用户目录，发现 2 个 agent");
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ type: "agent.scan", serverId: effectiveServerId }),
      );
      showToast("正在扫描远端 agent");
    }
  };

  const installManagedAgent = () => {
    if (connection.demo) {
      showToast("演示环境已安装 OpenCode");
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "agent.install",
          serverId: effectiveServerId,
          agentId: "opencode",
        }),
      );
      showToast("正在安装到 ~/.easywork/agents/opencode");
    }
  };

  const checkAgentUpdate = (agent = activeAgent) => {
    if (
      !effectiveServerId ||
      connection.status !== "connected" ||
      agent?.adapter !== "opencode" ||
      !agent.managed
    ) {
      return;
    }
    if (activeAgentUpdate.status === "available") {
      setAgentUpdateModalOpen(true);
      return;
    }
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      showToast("EasyWork 服务未连接");
      return;
    }
    setAgentUpdatesByServer((current) => ({
      ...current,
      [effectiveServerId]: {
        status: "checking",
        currentVersion: agent.version,
        label: "正在检测 OpenCode 更新",
      },
    }));
    setAgentMenuOpen(false);
    setAgentMenuPage("root");
    setAgentUpdateModalOpen(true);
    socketRef.current.send(
      JSON.stringify({
        type: "agent.update.check",
        serverId: effectiveServerId,
        agentId: agent.id,
      }),
    );
  };

  const applyAgentUpdate = () => {
    if (
      !effectiveServerId ||
      socketRef.current?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    setAgentUpdatesByServer((current) => ({
      ...current,
      [effectiveServerId]: {
        ...(current[effectiveServerId] ?? { status: "idle" }),
        status: "updating",
        label: "正在更新 OpenCode",
      },
    }));
    socketRef.current.send(
      JSON.stringify({
        type: "agent.update.apply",
        serverId: effectiveServerId,
        agentId: "opencode",
      }),
    );
  };

  const selectAgent = (agentId: string) => {
    if (!effectiveServerId) return;
    setActiveAgentByServer((current) => ({
      ...current,
      [effectiveServerId]: agentId,
    }));
    if (activeConversation?.mode === "work") {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        work: {
          ...(conversation.work ?? { workspace: "~" }),
          serverId: conversation.work?.serverId || effectiveServerId,
          agentId,
        },
      }));
    }
    setAgentMenuOpen(false);
    setAgentMenuPage("root");
  };

  const addManualAgent = () => {
    if (
      !manualAgentFolder.trim() ||
      socketRef.current?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    socketRef.current.send(
      JSON.stringify({
        type: "agent.add",
        serverId: effectiveServerId,
        name: manualAgentName.trim() || undefined,
        folder: manualAgentFolder.trim(),
      }),
    );
    setManualAgentName("");
    setManualAgentFolder("");
    setManualAgentOpen(false);
    showToast("正在检查 Agent 文件夹");
  };

  const openAgentConfig = (agent = activeAgent) => {
    if (!agent || socketRef.current?.readyState !== WebSocket.OPEN) return;
    setAgentConfigLoading(true);
    setAgentConfigAgentId(agent.id);
    setAgentConfigOpen(true);
    setAgentMenuOpen(false);
    setAgentMenuPage("root");
    socketRef.current.send(
      JSON.stringify({
        type: "agent.config.read",
        serverId: effectiveServerId,
        agentId: agent.id,
        requestId: uid("config"),
      }),
    );
  };

  const openAgentSettings = (agent: AgentItem) => {
    setAgentConfigAgentId(agent.id);
    setAgentMenuPage("config");
  };

  const openAgentModelPicker = () => {
    setAgentModelsByServer((current) => ({
      ...current,
      [effectiveServerId]:
        current[effectiveServerId]?.status === "configuring"
          ? current[effectiveServerId]
          : { status: "idle" },
    }));
    setAgentMenuPage("models");
    void detectProviderModels();
  };

  const configureAgentModel = (modelId: string) => {
    if (!configAgent || !effectiveServerId) return;
    setAgentModelsByServer((current) => ({
      ...current,
      [effectiveServerId]: {
        status: "configuring",
        model: modelId,
        label: "正在准备 OpenCode 配置",
      },
    }));
    if (connection.demo) {
      window.setTimeout(() => {
        setAgentModelsByServer((current) => ({
          ...current,
          [effectiveServerId]: {
            status: "done",
            model: modelId,
            label: `OpenCode 已切换到 ${modelId}`,
          },
        }));
        setAgentsByServer((current) => ({
          ...current,
          [effectiveServerId]: (current[effectiveServerId] ?? []).map((agent) =>
            agent.id === configAgent.id
              ? { ...agent, configured: true, model: modelId }
              : agent,
          ),
        }));
      }, 650);
      return;
    }
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setAgentModelsByServer((current) => ({
        ...current,
        [effectiveServerId]: {
          status: "error",
          model: modelId,
          error: "EasyWork 服务未连接",
        },
      }));
      return;
    }
    socketRef.current.send(
      JSON.stringify({
        type: "agent.model.configure",
        serverId: effectiveServerId,
        agentId: configAgent.id,
        model: modelId,
      }),
    );
  };

  const saveAgentConfig = () => {
    if (!configAgent || socketRef.current?.readyState !== WebSocket.OPEN) return;
    setAgentConfigLoading(true);
    socketRef.current.send(
      JSON.stringify({
        type: "agent.config.write",
        serverId: effectiveServerId,
        agentId: configAgent.id,
        requestId: uid("config"),
        content: agentConfigContent,
      }),
    );
  };

  const openRemoteFiles = (path = "~") => {
    if (!effectiveServerId || connection.status !== "connected") {
      openConversationServerManager();
      return;
    }
    setRemoteFilesLoading(true);
    setFileManagerOpen(true);
    socketRef.current?.send(
      JSON.stringify({
        type: "remote.fs.list",
        serverId: effectiveServerId,
        requestId: uid("files"),
        path,
      }),
    );
  };

  const downloadRemoteFile = (path: string) => {
    socketRef.current?.send(
      JSON.stringify({
        type: "remote.fs.download",
        serverId: effectiveServerId,
        requestId: uid("download"),
        path,
      }),
    );
  };

  const uploadRemoteFiles = async (files: FileList | null) => {
    if (!files?.length || socketRef.current?.readyState !== WebSocket.OPEN) return;
    for (const file of Array.from(files)) {
      if (file.size > 32 * 1024 * 1024) {
        showToast(`${file.name} 超过 32 MB，暂不支持网页上传`);
        continue;
      }
      setRemoteFilesLoading(true);
      socketRef.current.send(
        JSON.stringify({
          type: "remote.fs.upload",
          serverId: effectiveServerId,
          requestId: uid("upload"),
          path: remoteFilePath,
          name: file.name,
          contentBase64: await fileToBase64(file),
        }),
      );
    }
    if (remoteUploadInputRef.current) remoteUploadInputRef.current.value = "";
  };

  const createRemoteFolder = () => {
    const name = window.prompt("新文件夹名称");
    if (!name?.trim() || socketRef.current?.readyState !== WebSocket.OPEN) return;
    setRemoteFilesLoading(true);
    socketRef.current.send(
      JSON.stringify({
        type: "remote.fs.mkdir",
        serverId: effectiveServerId,
        requestId: uid("mkdir"),
        path: remoteFilePath,
        name: name.trim(),
      }),
    );
  };

  const handleLibraryUpload = async (
    files: FileList | null,
    projectId?: string,
  ) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const item: LibraryFile = {
        id: uid("file"),
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        status: state.settings.embedding.configured ? "indexing" : "keyword-only",
        chunks: 0,
        updatedAt: now(),
      };
      setState((current) => ({
        ...current,
        files: [item, ...current.files],
        projects: projectId
          ? current.projects.map((project) =>
              project.id === projectId
                ? {
                    ...project,
                    fileIds: [...new Set([...(project.fileIds ?? []), item.id])],
                  }
                : project,
            )
          : current.projects,
      }));
      try {
        const contentBase64 = await fileToBase64(file);
        const response = await gatewayFetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: item.id,
            name: file.name,
            type: item.type,
            size: item.size,
            contentBase64,
          }),
        });
        const payload = response.ok
          ? ((await response.json()) as { chunks?: number; status?: LibraryFile["status"] })
          : {};
        setState((current) => ({
          ...current,
          files: current.files.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  status:
                    payload.status ??
                    (current.settings.embedding.configured ? "ready" : "keyword-only"),
                  chunks: payload.chunks ?? Math.max(1, Math.ceil(file.size / 2200)),
                }
              : entry,
          ),
        }));
      } catch {
        setState((current) => ({
          ...current,
          files: current.files.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  status: current.settings.embedding.configured
                    ? "ready"
                    : "keyword-only",
                  chunks: Math.max(1, Math.ceil(file.size / 2200)),
                }
              : entry,
          ),
        }));
      }
    }
    showToast(`已接收 ${files.length} 个文件`);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (projectFileInputRef.current) projectFileInputRef.current.value = "";
  };

  const handleSkillUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    const rootName =
      selected[0]?.webkitRelativePath?.split("/")[0] ||
      selected[0]?.name.replace(/\.(zip|md)$/i, "") ||
      "uploaded-skill";
    const newSkill: SkillItem = {
      id: uid("skill"),
      name: rootName,
      description: "用户上传的技能。对话时可从输入框下方按需启用。",
      source: "uploaded",
      enabled: true,
      fileCount: selected.length,
      updatedAt: now(),
    };
    setState((current) => ({ ...current, skills: [newSkill, ...current.skills] }));
    try {
      const uploadFiles = await Promise.all(
        selected.map(async (file) => ({
          path: file.webkitRelativePath || file.name,
          contentBase64: await fileToBase64(file),
          type: file.type,
        })),
      );
      await gatewayFetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: newSkill.id,
          name: newSkill.name,
          files: uploadFiles,
        }),
      });
    } catch {
      // The UI keeps a session-only copy when the local gateway is unavailable.
    }
    showToast(`技能“${newSkill.name}”已加入技能库`);
    if (skillInputRef.current) skillInputRef.current.value = "";
    if (skillFolderInputRef.current) skillFolderInputRef.current.value = "";
  };

  const deleteGuestData = async () => {
    try {
      await gatewayFetch("/api/guest", {
        method: "DELETE",
      });
    } catch {
      // Gateway may already be gone; clearing local UI still honors the visible action.
    }
    setState(DEFAULT_STATE);
    setActiveConversationId("");
    setActiveProjectId("");
    setDraftProjectId(undefined);
    setView("chat");
    showToast("访客临时数据已清除");
  };

  const visibleConversations = state.conversations.filter((conversation) => {
    if (!searchQuery.trim()) return true;
    return conversation.title.toLowerCase().includes(searchQuery.trim().toLowerCase());
  });

  const orderConversations = (conversations: Conversation[]) =>
    [...conversations].sort(
      (left, right) =>
        Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );

  const projectConversations = (projectId: string) =>
    orderConversations(
      visibleConversations.filter(
        (conversation) =>
          conversation.projectId === projectId && conversation.messages.length > 0,
      ),
    );

  const orderedProjects = [...state.projects].sort(
    (left, right) =>
      Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );

  const generalConversations = orderConversations(
    visibleConversations.filter(
      (conversation) => !conversation.projectId && conversation.messages.length > 0,
    ),
  );

  const visibleLibraryFiles = state.files.filter((file) =>
    file.name.toLowerCase().includes(fileSearch.trim().toLowerCase()),
  );
  const projectFiles = projectPage
    ? state.files.filter((file) => (projectPage.fileIds ?? []).includes(file.id))
    : [];

  const visibleMemories = state.memories.filter((memory) => {
    if (memoryFilter === "all") return true;
    return memory.scope === memoryFilter;
  });

  const refreshMemorySummary = () => {
    const active = state.memories.filter((memory) => memory.enabled).slice(0, 4);
    const nextSummary = active.length
      ? active.map((memory) => memory.content).join("；")
      : "当前没有启用的长期记忆。EasyWork 仍可使用本轮消息和允许范围内的聊天历史。";
    setState((current) => ({ ...current, memorySummary: nextSummary }));
    showToast("记忆摘要已根据当前生效记忆刷新");
  };

  const addMemory = () => {
    const id = uid("memory");
    setState((current) => ({
      ...current,
      memories: [
        {
          id,
          content: "",
          scope: "global",
          kind: "preference",
          source: "手动添加",
          confidence: 1,
          enabled: true,
          updatedAt: now(),
        },
        ...current.memories,
      ],
    }));
    setEditingMemoryId(id);
    setEditingMemoryText("");
  };

  const applyMemoryInstruction = () => {
    const instruction = memoryInstruction.trim();
    if (!instruction) return;
    if (/^(忘记|删除)/.test(instruction)) {
      const target = instruction.replace(/^(忘记|删除)(关于|掉)?/, "").trim();
      setState((current) => ({
        ...current,
        memories: target
          ? current.memories.filter((memory) => !memory.content.includes(target))
          : current.memories,
        memorySummary: `已按要求处理：“${instruction}”。请刷新摘要以查看整合结果。`,
      }));
    } else {
      setState((current) => ({
        ...current,
        memories: [
          {
            id: uid("memory"),
            content: instruction,
            scope: "global",
            kind: "preference",
            source: "摘要纠正",
            confidence: 1,
            enabled: true,
            updatedAt: now(),
          },
          ...current.memories,
        ],
        memorySummary: instruction,
      }));
    }
    setMemoryInstruction("");
    showToast("记忆已更新");
  };

  const deleteLibraryFile = async (fileId: string) => {
    setState((current) => ({
      ...current,
      files: current.files.filter((file) => file.id !== fileId),
    }));
    await gatewayFetch(`/api/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    showToast("文件及其索引已删除");
  };

  const deleteSkill = async (skillId: string) => {
    setSelectedSkills((current) => current.filter((id) => id !== skillId));
    setState((current) => ({
      ...current,
      skills: current.skills.filter((skill) => skill.id !== skillId),
    }));
    await gatewayFetch(`/api/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    showToast("已删除上传的技能");
  };

  const toggleSelectedSkill = (skillId: string) => {
    setSelectedSkills((current) =>
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId],
    );
  };

  return (
    <div
      className={`easywork-app${
        view === "chat" && activeConversation && rightRailOpen
          ? " with-task-rail"
          : ""
      }`}
    >
      <button
        className={`mobile-scrim${sidebarOpen || rightRailOpen ? " visible" : ""}`}
        type="button"
        aria-label="关闭侧栏"
        onClick={() => {
          setSidebarOpen(false);
          setRightRailOpen(false);
        }}
      />

      <aside className={`left-sidebar${sidebarOpen ? " mobile-open" : ""}`}>
        <div className="brand-row">
          <button
            className="brand-button"
            type="button"
            onClick={() => beginConversation()}
            aria-label="返回新聊天"
          >
            <span className="brand-mark">E</span>
            <span className="brand-copy">
              <strong>EasyWork</strong>
            </span>
          </button>
          <div className="brand-row-actions">
            <button
              className={`icon-button sidebar-search-toggle${
                sidebarSearchOpen ? " active" : ""
              }`}
              type="button"
              onClick={() => setSidebarSearchOpen((current) => !current)}
              aria-label={sidebarSearchOpen ? "关闭搜索" : "搜索聊天"}
              aria-expanded={sidebarSearchOpen}
            >
              <Search size={17} />
            </button>
            <button
              className="icon-button sidebar-close"
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="关闭菜单"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        <div className="sidebar-primary">
          <button className="new-chat-button" type="button" onClick={() => beginConversation()}>
            <Plus size={17} />
            <span>新聊天</span>
          </button>
          <button
            className={`sidebar-nav-item${view === "library" ? " active" : ""}`}
            type="button"
            onClick={() => {
              setView("library");
              setSidebarOpen(false);
            }}
          >
            <Library size={17} />
            <span>文件库</span>
          </button>
          <button
            className={`sidebar-nav-item${view === "skills" ? " active" : ""}`}
            type="button"
            onClick={() => {
              setView("skills");
              setSidebarOpen(false);
            }}
          >
            <Sparkles size={17} />
            <span>技能</span>
          </button>
          <button
            className={`sidebar-nav-item${view === "memory" ? " active" : ""}`}
            type="button"
            onClick={() => {
              setView("memory");
              setSidebarOpen(false);
            }}
          >
            <Brain size={17} />
            <span>记忆</span>
          </button>
          <button
            className="sidebar-nav-item"
            type="button"
            onClick={openGlobalServerManager}
          >
            <Network size={17} />
            <span>远程服务器</span>
          </button>
        </div>

        {(sidebarSearchOpen || searchQuery) && (
          <div className="sidebar-search">
            <Search size={15} />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="搜索聊天"
              aria-label="搜索聊天"
              autoFocus={sidebarSearchOpen}
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery("")} aria-label="清空搜索">
                <X size={13} />
              </button>
            )}
          </div>
        )}

        <div className="sidebar-scroll">
          <section
            className={`sidebar-content-section project-sidebar-section${
              projectSectionOpen ? " expanded" : ""
            }`}
          >
            <div className="section-label sidebar-section-heading">
              <button
                className="sidebar-section-toggle"
                type="button"
                aria-expanded={projectSectionOpen}
                onClick={() => setProjectSectionOpen((current) => !current)}
              >
                <span>项目</span>
                <ChevronRight className="sidebar-section-chevron" size={14} />
              </button>
              <button
                className="sidebar-section-add"
                type="button"
                onClick={() => {
                  setProjectModalConversationId("");
                  setProjectModalOpen(true);
                }}
                aria-label="新建项目"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="sidebar-section-motion" aria-hidden={!projectSectionOpen}>
              <div>
                <div className="project-list">
                  {orderedProjects.map((project) => {
                    const expanded = expandedProjectIds.has(project.id);
                    const projectHomeActive =
                      view === "project" && project.id === activeProjectId;
                    const conversations = projectConversations(project.id);
                    const showingAllConversations =
                      expandedProjectConversationIds.has(project.id);
                    const displayedConversations = showingAllConversations
                      ? conversations
                      : conversations.slice(0, 4);
                    return (
                      <div
                        className={`project-nav-group${expanded ? " expanded" : ""}`}
                        key={project.id}
                      >
                        <div
                          className={`project-list-item${
                            projectHomeActive ? " active" : ""
                          }`}
                        >
                          <button
                            className="project-row"
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => toggleProjectExpansion(project.id)}
                          >
                            <span className="project-folder-icon">
                              {expanded ? (
                                <FolderOpen size={18} />
                              ) : (
                                <Folder size={18} />
                              )}
                            </span>
                            <span className="project-title" title={project.name}>
                              {project.name}
                            </span>
                            {project.pinned && (
                              <Pin className="project-pin-indicator" size={11} />
                            )}
                          </button>
                          <div className="project-row-actions">
                            <button
                              className="project-home-button"
                              type="button"
                              aria-label={`打开“${project.name}”项目主页`}
                              onClick={(event) => {
                                event.stopPropagation();
                                openProject(project.id);
                              }}
                            >
                              <Home size={14} />
                            </button>
                            <button
                              className="project-more-button"
                              type="button"
                              aria-label={`打开“${project.name}”的项目选项`}
                              aria-expanded={projectMenuId === project.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                setProjectMenuId((current) =>
                                  current === project.id ? "" : project.id,
                                );
                              }}
                            >
                              <Ellipsis size={16} />
                            </button>
                          </div>
                          {projectMenuId === project.id && (
                            <div className="conversation-menu project-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setProjectEditor({ project, mode: "rename" });
                                  setProjectMenuId("");
                                }}
                              >
                                <Pencil size={15} />
                                重命名项目
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setProjectEditor({ project, mode: "settings" });
                                  setProjectMenuId("");
                                }}
                              >
                                <Settings2 size={15} />
                                项目设置
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  openProject(project.id);
                                  setProjectMenuId("");
                                }}
                              >
                                <Home size={15} />
                                项目主页
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => toggleProjectPin(project.id)}
                              >
                                {project.pinned ? (
                                  <PinOff size={15} />
                                ) : (
                                  <Pin size={15} />
                                )}
                                {project.pinned ? "取消置顶" : "置顶项目"}
                              </button>
                              <button
                                className="danger"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setProjectPendingDelete(project);
                                  setProjectMenuId("");
                                }}
                              >
                                <Trash2 size={15} />
                                删除项目
                              </button>
                            </div>
                          )}
                        </div>
                        {conversations.length > 0 && (
                          <div
                            className={`project-sidebar-chats-motion${
                              expanded ? " expanded" : ""
                            }`}
                            aria-hidden={!expanded}
                          >
                            <div>
                              <div className="project-sidebar-chats">
                                {displayedConversations.map((conversation) => (
                                  <ConversationRow
                                    key={conversation.id}
                                    conversation={conversation}
                                    active={
                                      conversation.id === activeConversationId &&
                                      view === "chat"
                                    }
                                    nested
                                    projects={state.projects}
                                    menuOpen={conversationMenuId === conversation.id}
                                    onSelect={() => selectConversation(conversation)}
                                    onToggleMenu={() =>
                                      setConversationMenuId((current) =>
                                        current === conversation.id
                                          ? ""
                                          : conversation.id,
                                      )
                                    }
                                    onMove={(projectId) =>
                                      moveConversation(conversation.id, projectId)
                                    }
                                    onMoveToNewProject={() => {
                                      setProjectModalConversationId(conversation.id);
                                      setProjectModalOpen(true);
                                      setConversationMenuId("");
                                    }}
                                    onRename={() => {
                                      setConversationEditor(conversation);
                                      setConversationMenuId("");
                                    }}
                                    onTogglePin={() =>
                                      toggleConversationPin(conversation.id)
                                    }
                                    onDelete={() => {
                                      setConversationPendingDelete(conversation);
                                      setConversationMenuId("");
                                    }}
                                  />
                                ))}
                                {conversations.length > 4 && (
                                  <button
                                    className="project-conversations-more"
                                    type="button"
                                    onClick={() =>
                                      setExpandedProjectConversationIds((current) => {
                                        const next = new Set(current);
                                        if (next.has(project.id)) next.delete(project.id);
                                        else next.add(project.id);
                                        return next;
                                      })
                                    }
                                  >
                                    {showingAllConversations ? "收起" : "显示更多"}
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section
            className={`sidebar-content-section chat-sidebar-section${
              chatSectionOpen ? " expanded" : ""
            }`}
          >
            <div className="section-label chat-section-label sidebar-section-heading">
              <button
                className="sidebar-section-toggle"
                type="button"
                aria-expanded={chatSectionOpen}
                onClick={() => setChatSectionOpen((current) => !current)}
              >
                <span>聊天</span>
                <ChevronRight className="sidebar-section-chevron" size={14} />
              </button>
              <button
                className="sidebar-section-add"
                type="button"
                onClick={() => beginConversation()}
                aria-label="新建聊天"
              >
                <Plus size={15} />
              </button>
            </div>
            <div className="sidebar-section-motion" aria-hidden={!chatSectionOpen}>
              <div>
                <div className="general-chats">
                  {generalConversations.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      active={
                        conversation.id === activeConversationId && view === "chat"
                      }
                      projects={state.projects}
                      menuOpen={conversationMenuId === conversation.id}
                      onSelect={() => selectConversation(conversation)}
                      onToggleMenu={() =>
                        setConversationMenuId((current) =>
                          current === conversation.id ? "" : conversation.id,
                        )
                      }
                      onMove={(projectId) =>
                        moveConversation(conversation.id, projectId)
                      }
                      onMoveToNewProject={() => {
                        setProjectModalConversationId(conversation.id);
                        setProjectModalOpen(true);
                        setConversationMenuId("");
                      }}
                      onRename={() => {
                        setConversationEditor(conversation);
                        setConversationMenuId("");
                      }}
                      onTogglePin={() => toggleConversationPin(conversation.id)}
                      onDelete={() => {
                        setConversationPendingDelete(conversation);
                        setConversationMenuId("");
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="profile-wrap">
          <button
            className="profile-button"
            type="button"
            onClick={() => {
              setAccountTab(actor.authenticated ? "profile" : "login");
              setProfileModalOpen(true);
            }}
          >
            <span className="profile-avatar">
              {actor.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={actor.avatar} alt="" />
              ) : actor.authenticated ? (
                actor.displayName.slice(0, 1).toUpperCase()
              ) : (
                <UserRound size={17} />
              )}
            </span>
            <span>
              <strong>{actor.displayName}</strong>
              <small>
                {actor.authenticated
                  ? state.settings.provider.configured
                    ? "模型 API 已配置"
                    : "配置模型 API"
                  : "登录或注册"}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>

      <main className="main-column">
        <header className={`topbar${view === "chat" ? " chat-topbar" : ""}`}>
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu"
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="打开菜单"
            >
              <Menu size={18} />
            </button>
            {view === "chat" ? (
              <div className="conversation-heading">
                <strong>{activeConversation?.title ?? "新聊天"}</strong>
                {activeProject && (
                  <span>
                    <FolderLock size={13} />
                    {activeProject.name}
                  </span>
                )}
              </div>
            ) : view === "project" ? (
              <div className="conversation-heading">
                <strong>{projectPage?.name ?? "项目"}</strong>
              </div>
            ) : (
              <div className="conversation-heading">
                <strong>
                  {view === "library"
                    ? "文件库"
                    : view === "skills"
                      ? "技能"
                      : "记忆"}
                </strong>
              </div>
            )}
          </div>

          {view === "chat" ? (
            <div className="topbar-center">
              {activeConversation ? (
                <div className="conversation-mode-menu">
                  <button
                    className={`conversation-mode-badge ${mode}`}
                    type="button"
                    aria-expanded={modeMenuOpen}
                    onClick={() => setModeMenuOpen((current) => !current)}
                  >
                    {mode === "chat" ? <MessageCircle size={14} /> : <Terminal size={14} />}
                    {mode === "chat" ? "聊天" : "工作"}
                    <ChevronDown size={13} />
                  </button>
                  {modeMenuOpen && (
                    <div className="mode-convert-popover">
                      <span>对话类型</span>
                      <button
                        type="button"
                        onClick={() => changeMode(mode === "chat" ? "work" : "chat")}
                      >
                        {mode === "chat" ? <Terminal size={15} /> : <MessageCircle size={15} />}
                        转换为{mode === "chat" ? "工作" : "聊天"}模式
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="mode-switch" role="group" aria-label="选择新对话类型">
                  <button
                    className={mode === "chat" ? "active" : ""}
                    type="button"
                    onClick={() => changeMode("chat")}
                  >
                    <MessageCircle size={14} />
                    聊天
                  </button>
                  <button
                    className={mode === "work" ? "active" : ""}
                    type="button"
                    onClick={() => changeMode("work")}
                  >
                    <Terminal size={14} />
                    工作
                  </button>
                </div>
              )}
            </div>
          ) : <div className="topbar-center" />}

          <div className="topbar-actions">
            {view === "chat" && mode === "work" && (
              <>
                {!rightRailOpen && (
                  <button
                    className={`connection-pill ${connection.status}`}
                    type="button"
                    onClick={openConversationServerManager}
                  >
                    {connection.status === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
                    <span>{connection.status === "connected" ? "登录节点在线" : "连接平台"}</span>
                    {connection.latency && <small>{connection.latency}ms</small>}
                  </button>
                )}
                {connection.status === "connected" && (
                    <button
                      className="agent-picker"
                      type="button"
                      onClick={() =>
                        setAgentMenuOpen((current) => {
                          if (!current) setAgentMenuPage("root");
                          return !current;
                        })
                      }
                  >
                    <Bot size={15} />
                    <span>{activeAgent?.name ?? "选择 Agent"}</span>
                    <ChevronDown size={13} />
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        {view === "chat" && (
          <section className="conversation-surface">
            <div className="conversation-toolbar">
              <div className="conversation-toolbar-left">
                <button
                  className="icon-button mobile-menu"
                  type="button"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="打开菜单"
                >
                  <Menu size={18} />
                </button>
                {activeProject && (
                  <span className="conversation-project-label">
                    <Folder size={14} />
                    {activeProject.name}
                  </span>
                )}
                {activeConversation ? (
                  <div className="conversation-mode-menu">
                    <button
                      className={`conversation-mode-badge ${mode}`}
                      type="button"
                      aria-expanded={modeMenuOpen}
                      onClick={() => setModeMenuOpen((current) => !current)}
                    >
                      {mode === "chat" ? (
                        <MessageCircle size={14} />
                      ) : (
                        <Terminal size={14} />
                      )}
                      {mode === "chat" ? "聊天" : "工作"}
                      <ChevronDown size={13} />
                    </button>
                    {modeMenuOpen && (
                      <div className="mode-convert-popover">
                        <button
                          type="button"
                          onClick={() =>
                            changeMode(mode === "chat" ? "work" : "chat")
                          }
                        >
                          {mode === "chat" ? (
                            <Terminal size={15} />
                          ) : (
                            <MessageCircle size={15} />
                          )}
                          转换为{mode === "chat" ? "工作" : "聊天"}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mode-switch compact" role="group" aria-label="选择对话类型">
                    <button
                      className={mode === "chat" ? "active" : ""}
                      type="button"
                      onClick={() => changeMode("chat")}
                    >
                      聊天
                    </button>
                    <button
                      className={mode === "work" ? "active" : ""}
                      type="button"
                      onClick={() => changeMode("work")}
                    >
                      工作
                    </button>
                  </div>
                )}
              </div>

              <div className="conversation-toolbar-right">
                {mode === "work" && !rightRailOpen && (
                  <button
                    className={`work-connection-button ${connection.status}`}
                    type="button"
                    onClick={openConversationServerManager}
                    aria-label={
                      connection.status === "connected"
                        ? "远程服务器已连接，打开连接详情"
                        : "远程服务器未连接，打开连接窗口"
                    }
                  >
                    {connection.status === "connecting" ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : connection.status === "connected" ? (
                      <Wifi size={14} />
                    ) : (
                      <WifiOff size={14} />
                    )}
                    <span>
                      {connection.status === "connected" ? "已连接" : "未连接"}
                    </span>
                  </button>
                )}
                {mode === "work" && connection.status === "connected" && (
                  <div className="agent-selector">
                    <button
                      className="agent-picker"
                      type="button"
                      aria-expanded={agentMenuOpen}
                      onClick={() =>
                        setAgentMenuOpen((current) => {
                          if (!current) setAgentMenuPage("root");
                          return !current;
                        })
                      }
                    >
                      <Bot size={15} />
                      <span>
                        {activeAgent?.status === "ready"
                          ? activeAgent.name
                          : "选择 Agent"}
                      </span>
                      <ChevronDown size={13} />
                    </button>
                    {agentMenuOpen && (
                      <div
                        className={`agent-dropdown show-${agentMenuPage}`}
                        style={
                          {
                            "--agent-menu-height":
                              agentMenuPage === "config"
                                ? "145px"
                                : agentMenuPage === "models"
                                  ? `${Math.min(
                                      350,
                                      112 + Math.max(providerModels.length, 1) * 40,
                                    )}px`
                                  : `${Math.min(
                                      390,
                                      66 +
                                        Math.max(agents.length, 1) * 58 +
                                        (agents.some(
                                          (agent) =>
                                            agent.id === "opencode" &&
                                            agent.status === "missing",
                                        )
                                          ? 45
                                          : 0) +
                                        (manualAgentOpen ? 112 : 0),
                                    )}px`,
                          } as React.CSSProperties
                        }
                      >
                        <div className="agent-menu-track">
                          <div className="agent-menu-panel agent-root-panel">
                            <div className="agent-dropdown-list">
                              {agents.map((agent) => (
                                <div
                                  className={`agent-dropdown-row${
                                    agent.id === activeAgentId &&
                                    agent.status === "ready"
                                      ? " active"
                                      : ""
                                  }`}
                                  key={agent.id}
                                >
                                  <button
                                    type="button"
                                    disabled={agent.status !== "ready"}
                                    onClick={() => selectAgent(agent.id)}
                                  >
                                    <span>
                                      {agent.id === "opencode" ? (
                                        <Code2 size={16} />
                                      ) : (
                                        <Bot size={16} />
                                      )}
                                    </span>
                                    <span>
                                      <strong>{agent.name}</strong>
                                      <small>
                                        {agent.status === "missing"
                                          ? "未安装"
                                          : agent.status === "installing"
                                            ? agent.detail || "安装中"
                                            : agent.configured
                                              ? agent.version || "可用"
                                              : "需要配置"}
                                      </small>
                                    </span>
                                    {agent.id === activeAgentId &&
                                      agent.status === "ready" && (
                                        <Check size={14} />
                                      )}
                                  </button>
                                  {agent.status === "ready" &&
                                    (agent.configPath ||
                                      agent.adapter === "opencode") && (
                                    <span className="agent-row-actions">
                                      {agent.adapter === "opencode" &&
                                        agent.managed && (
                                          <button
                                            className={`agent-update-shortcut ${activeAgentUpdate.status}`}
                                            type="button"
                                            onClick={() => checkAgentUpdate(agent)}
                                            disabled={[
                                              "checking",
                                              "downloading",
                                              "updating",
                                              "configuring",
                                            ].includes(activeAgentUpdate.status)}
                                            aria-label="检测 OpenCode 更新"
                                            title="检测更新"
                                          >
                                            <RefreshCw
                                              className={
                                                [
                                                  "checking",
                                                  "downloading",
                                                  "updating",
                                                  "configuring",
                                                ].includes(activeAgentUpdate.status)
                                                  ? "spin"
                                                  : undefined
                                              }
                                              size={14}
                                            />
                                          </button>
                                        )}
                                      <button
                                        className="agent-config-shortcut"
                                        type="button"
                                        onClick={() => openAgentSettings(agent)}
                                        aria-label={`配置 ${agent.name}`}
                                      >
                                        <ChevronRight size={15} />
                                      </button>
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                            {agents.some(
                              (agent) =>
                                agent.id === "opencode" && agent.status === "missing",
                            ) && (
                              <button
                                className="agent-install-action"
                                type="button"
                                onClick={installManagedAgent}
                                disabled={connection.status !== "connected"}
                              >
                                <Download size={15} />
                                安装 OpenCode
                              </button>
                            )}
                            {manualAgentOpen && (
                              <div className="manual-agent-inline">
                                <input
                                  value={manualAgentName}
                                  onChange={(event) =>
                                    setManualAgentName(event.target.value)
                                  }
                                  placeholder="名称（可选）"
                                />
                                <input
                                  value={manualAgentFolder}
                                  onChange={(event) =>
                                    setManualAgentFolder(event.target.value)
                                  }
                                  placeholder="Agent 文件夹，如 ~/.local/opencode"
                                />
                                <button type="button" onClick={addManualAgent}>
                                  添加
                                </button>
                              </div>
                            )}
                            <div className="agent-dropdown-actions">
                              <button type="button" onClick={scanAgents}>
                                <RefreshCw size={14} />
                                自动扫描
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setManualAgentOpen((current) => !current)
                                }
                              >
                                <Plus size={14} />
                                手动添加
                              </button>
                            </div>
                          </div>

                          <div className="agent-menu-panel agent-config-panel">
                            <button
                              className="agent-menu-back"
                              type="button"
                              onClick={() => setAgentMenuPage("root")}
                            >
                              <ChevronLeft size={15} />
                              返回
                            </button>
                            <button
                              className="agent-menu-option"
                              type="button"
                              onClick={() => openAgentConfig(configAgent)}
                            >
                              <FileText size={16} />
                              <span>打开配置</span>
                            </button>
                            {configAgent?.adapter === "opencode" && (
                              <button
                                className="agent-menu-option"
                                type="button"
                                onClick={openAgentModelPicker}
                              >
                                <Bot size={16} />
                                <span>选择模型</span>
                                <ChevronRight size={15} />
                              </button>
                            )}
                          </div>

                          <div className="agent-menu-panel agent-model-panel">
                            <button
                              className="agent-menu-back"
                              type="button"
                              onClick={() => setAgentMenuPage("config")}
                            >
                              <ChevronLeft size={15} />
                              返回
                            </button>
                            <p>基于用户 API 进行配置</p>
                            {activeAgentModelConfig.status === "configuring" && (
                              <div className="agent-model-progress" role="status">
                                <LoaderCircle className="spin" size={15} />
                                <span>
                                  {activeAgentModelConfig.label || "正在配置"}
                                </span>
                              </div>
                            )}
                            {activeAgentModelConfig.status === "error" && (
                              <div className="agent-model-progress error" role="alert">
                                <X size={14} />
                                <span>
                                  {activeAgentModelConfig.error ||
                                    activeAgentModelConfig.label ||
                                    "配置失败"}
                                </span>
                              </div>
                            )}
                            <div className="agent-model-list">
                              {providerModels.map((modelId) => {
                                const selectedModel =
                                  activeAgentModelConfig.status === "done"
                                    ? activeAgentModelConfig.model
                                    : configAgent?.model;
                                return (
                                  <button
                                    className={
                                      selectedModel === modelId ? "selected" : ""
                                    }
                                    type="button"
                                    key={modelId}
                                    disabled={
                                      activeAgentModelConfig.status === "configuring"
                                    }
                                    onClick={() => configureAgentModel(modelId)}
                                  >
                                    <span title={modelId}>{modelId}</span>
                                    {activeAgentModelConfig.status === "configuring" &&
                                    activeAgentModelConfig.model === modelId ? (
                                      <LoaderCircle className="spin" size={14} />
                                    ) : selectedModel === modelId ? (
                                      <Check size={14} />
                                    ) : null}
                                  </button>
                                );
                              })}
                              {providerModelsLoading && !providerModels.length && (
                                <span className="agent-model-empty">
                                  <LoaderCircle className="spin" size={15} />
                                  正在检测模型
                                </span>
                              )}
                              {!providerModelsLoading && providerModelsError && (
                                <span className="agent-model-empty error">
                                  {providerModelsError}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="messages-scroll">
              {!activeConversation?.messages.length ? (
                <div className="empty-chat">
                  <div>
                    <h1>{mode === "chat" ? "有什么可以帮你？" : "在算力平台上开始工作"}</h1>
                  </div>
                  {mode === "work" && connection.status !== "connected" && (
                    <button
                      className="inline-connect"
                      type="button"
                      onClick={openConversationServerManager}
                    >
                      <KeyRound size={16} />
                      连接远程服务器
                    </button>
                  )}
                  {mode === "work" &&
                    connection.status === "connected" &&
                    (!activeAgent || !activeAgent.configured) && (
                      <button
                        className="inline-connect"
                        type="button"
                        onClick={() =>
                          activeAgent?.status === "missing"
                            ? (() => {
                                setAgentMenuPage("root");
                                setAgentMenuOpen(true);
                              })()
                            : (() => {
                                if (activeAgent) {
                                  setAgentConfigAgentId(activeAgent.id);
                                }
                                setAgentMenuPage("config");
                                setAgentMenuOpen(true);
                              })()
                        }
                      >
                        <Settings2 size={16} />
                        {activeAgent?.status === "missing"
                          ? "安装或选择 Agent"
                          : "配置 Agent"}
                      </button>
                    )}
                </div>
              ) : (
                <div className="message-list">
                  {activeConversation.messages.map((message) => (
                    <article
                      className={`message ${message.role} ${message.mode}`}
                      key={message.id}
                      id={`message-${message.id}`}
                    >
                      <div className="message-meta">
                        <span className="message-avatar">
                          {message.role === "user" ? (
                            actor.authenticated ? (
                              actor.displayName.slice(0, 1).toUpperCase()
                            ) : (
                              <User size={15} />
                            )
                          ) : (
                            <span className="assistant-mark">E</span>
                          )}
                        </span>
                        <div>
                          <strong>{message.role === "user" ? "你" : "EasyWork"}</strong>
                          <small>
                            {formatTime(message.createdAt)}
                            {message.mode === "work" && " · Work"}
                          </small>
                        </div>
                      </div>
                      <div className="message-body">
                        {message.role === "assistant" && (
                          <ReasoningDisclosure
                            content={message.reasoning}
                            running={
                              sending &&
                              message.id ===
                                activeConversation.messages.at(-1)?.id &&
                              !message.content
                            }
                          />
                        )}
                        {message.role === "assistant" &&
                          message.mode === "work" &&
                          !!message.events?.length && (
                            <WorkEventFeed
                              events={message.events}
                              runStatus={
                                activeConversation.messages.find(
                                  (item) =>
                                    item.role === "user" &&
                                    item.runId &&
                                    item.runId === message.runId,
                                  )?.trace?.status
                              }
                              workflowSteps={
                                activeConversation.messages.find(
                                  (item) =>
                                    item.role === "user" &&
                                    item.runId &&
                                    item.runId === message.runId,
                                )?.trace?.steps
                              }
                              onApproval={
                                message.runId
                                  ? (event, approved) =>
                                      respondToApproval(
                                        activeConversation.id,
                                        message.runId!,
                                        event,
                                        approved,
                                      )
                                  : undefined
                              }
                            />
                          )}
                        {message.content ? (
                          <div className="message-text">
                            {message.role === "assistant" ? (
                              <>
                                <MarkdownContent content={message.content} />
                                {sending &&
                                  message.id ===
                                    activeConversation.messages.at(-1)?.id && (
                                    <span
                                      className="streaming-caret"
                                      aria-hidden="true"
                                    />
                                  )}
                              </>
                            ) : (
                              message.content
                            )}
                          </div>
                        ) : null}
                        {!!message.selectedSkills?.length && (
                          <div className="message-skill-row">
                            {message.selectedSkills.map((skillId) => {
                              const skill = state.skills.find((item) => item.id === skillId);
                              return skill ? (
                                <span key={skillId}>
                                  <Sparkles size={12} />
                                  {skill.name}
                                </span>
                              ) : null;
                            })}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            <div className="composer-zone">
              <UnifiedComposer
                value={draft}
                textareaRef={textareaRef}
                disabled={mode === "work" && !workReady}
                sending={sending}
                skills={state.skills}
                selectedSkills={selectedSkills}
                model={state.settings.provider.model}
                models={providerModels}
                modelsLoading={providerModelsLoading}
                modelError={providerModelsError}
                menuDirection="up"
                onChange={setDraft}
                onSubmit={() => void submitMessage()}
                onStop={stopCurrentRun}
                onUpload={(files) =>
                  void handleLibraryUpload(files, activeProject?.id)
                }
                onToggleSkill={toggleSelectedSkill}
                onDetectModels={() => void detectProviderModels()}
                onSelectModel={(modelId) => void selectProviderModel(modelId)}
                placeholder={
                  mode === "chat"
                    ? "给 EasyWork 发消息"
                    : connection.status !== "connected"
                      ? "请先连接远程服务器"
                      : !activeAgent || activeAgent.status === "missing"
                        ? "请先安装或选择 Agent"
                        : !activeAgent.configured
                          ? "请先完成 Agent 模型配置"
                          : "描述要在远程服务器完成的工作"
                }
              />
              {mode === "chat" && <p>EasyWork 可能会出错，请核对重要信息。</p>}
            </div>
          </section>
        )}

        {view === "project" && projectPage && (
          <section className="workspace-page project-page">
            <header className="project-home-header">
              <span className="project-home-folder">
                <FolderOpen size={34} />
              </span>
              <div>
                <h1>{projectPage.name}</h1>
              </div>
            </header>

            <div className="project-composer-area">
              <div
                className="project-launch-mode"
                role="group"
                aria-label="选择新对话类型"
              >
                <button
                  className={mode === "chat" ? "active" : ""}
                  type="button"
                  onClick={() => setMode("chat")}
                >
                  聊天
                </button>
                <button
                  className={mode === "work" ? "active" : ""}
                  type="button"
                  onClick={() => setMode("work")}
                >
                  工作
                </button>
              </div>
              <UnifiedComposer
                value={draft}
                disabled={
                  mode === "work" &&
                  connection.status === "connected" &&
                  !workReady
                }
                sending={sending}
                skills={state.skills}
                selectedSkills={selectedSkills}
                model={state.settings.provider.model}
                models={providerModels}
                modelsLoading={providerModelsLoading}
                modelError={providerModelsError}
                menuDirection="down"
                onChange={setDraft}
                onSubmit={() =>
                  void submitMessage({
                    projectId: projectPage.id,
                    requestedMode: mode,
                    openChat: true,
                  })
                }
                onStop={stopCurrentRun}
                onUpload={(files) =>
                  void handleLibraryUpload(files, projectPage.id)
                }
                onToggleSkill={toggleSelectedSkill}
                onDetectModels={() => void detectProviderModels()}
                onSelectModel={(modelId) => void selectProviderModel(modelId)}
                placeholder={`在 ${projectPage.name} 中发起${
                  mode === "work" ? "工作" : "聊天"
                }`}
              />
            </div>

            <nav className="project-home-tabs" aria-label="项目内容">
              <button
                className={projectPageTab === "chats" ? "active" : ""}
                type="button"
                onClick={() => setProjectPageTab("chats")}
              >
                对话
                <span>{projectConversations(projectPage.id).length}</span>
              </button>
              <button
                className={projectPageTab === "files" ? "active" : ""}
                type="button"
                onClick={() => setProjectPageTab("files")}
              >
                文件
                <span>{projectFiles.length}</span>
              </button>
            </nav>

            <div className="project-home-content">
              {projectPageTab === "chats" ? (
                <div className="project-home-conversations">
                  {projectConversations(projectPage.id).map((conversation) => (
                    <button
                      className="project-home-conversation"
                      type="button"
                      key={conversation.id}
                      onClick={() => selectConversation(conversation)}
                    >
                      <span>
                        <strong>{conversation.title}</strong>
                        <small>{conversationPreview(conversation)}</small>
                      </span>
                      <span className="project-conversation-meta">
                        <em className={`project-conversation-mode ${conversation.mode}`}>
                          {conversation.mode === "work" ? "工作" : "聊天"}
                        </em>
                        <time dateTime={conversation.updatedAt}>
                          {formatProjectDate(conversation.updatedAt)}
                        </time>
                      </span>
                    </button>
                  ))}
                  {!projectConversations(projectPage.id).length && (
                    <div className="project-home-empty">
                      <p>还没有对话</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="project-home-files">
                  <div className="project-home-file-actions">
                    <button
                      type="button"
                      onClick={() => setProjectLibraryModalOpen(true)}
                    >
                      <Library size={15} />
                      关联文件库
                    </button>
                    <button
                      type="button"
                      onClick={() => projectFileInputRef.current?.click()}
                    >
                      <Upload size={15} />
                      上传
                    </button>
                    <input
                      ref={projectFileInputRef}
                      hidden
                      multiple
                      type="file"
                      onChange={(event) =>
                        void handleLibraryUpload(
                          event.target.files,
                          projectPage.id,
                        )
                      }
                    />
                  </div>
                  <div className="project-home-file-list">
                    {projectFiles.map((file) => (
                      <div className="project-home-file" key={file.id}>
                        <FileText size={17} />
                        <span>
                          <strong>{file.name}</strong>
                          <small>{formatBytes(file.size)}</small>
                        </span>
                        <button
                          type="button"
                          aria-label={`从项目移除 ${file.name}`}
                          onClick={() =>
                            setState((current) => ({
                              ...current,
                              projects: current.projects.map((project) =>
                                project.id === projectPage.id
                                  ? {
                                      ...project,
                                      fileIds: (project.fileIds ?? []).filter(
                                        (fileId) => fileId !== file.id,
                                      ),
                                    }
                                  : project,
                              ),
                            }))
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    {!projectFiles.length && (
                      <div className="project-home-empty">
                        <p>还没有项目文件</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {view === "library" && (
          <section className="workspace-page library-page">
            <div className="page-intro">
              <div>
                <h1>文件库</h1>
                <p>上传资料，在聊天中检索并引用。</p>
              </div>
              <div className="page-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setEmbeddingModalOpen(true)}
                >
                  <Settings2 size={16} />
                  Embedding API
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} />
                  上传文件
                </button>
                <input
                  ref={fileInputRef}
                  hidden
                  multiple
                  type="file"
                  onChange={(event) => void handleLibraryUpload(event.target.files)}
                />
              </div>
            </div>

            <div className="content-card file-table-card">
              <div className="card-toolbar">
                <div>
                  <h2>全部文件</h2>
                  <span>{state.files.length} 个文件 · {state.files.reduce((sum, file) => sum + file.chunks, 0)} 个文本块</span>
                </div>
                <label className="table-search">
                  <Search size={14} />
                  <input
                    value={fileSearch}
                    onChange={(event) => setFileSearch(event.target.value)}
                    placeholder="搜索文件"
                  />
                </label>
              </div>
              <div className="file-table">
                <div className="file-table-head">
                  <span>名称</span>
                  <span>索引状态</span>
                  <span>切块</span>
                  <span>更新时间</span>
                  <span />
                </div>
                {visibleLibraryFiles.map((file) => (
                  <div className="file-table-row" key={file.id}>
                    <span className="file-name-cell">
                      <i>
                        {file.name.endsWith(".docx") ? (
                          <FileText size={17} />
                        ) : file.name.endsWith(".csv") ? (
                          <Database size={17} />
                        ) : (
                          <File size={17} />
                        )}
                      </i>
                      <span>
                        <strong>{file.name}</strong>
                        <small>{formatBytes(file.size)}</small>
                      </span>
                    </span>
                    <span>
                      <span className={`index-status ${file.status}`}>
                        {file.status === "ready"
                          ? "可检索"
                          : file.status === "indexing"
                            ? "索引中"
                            : file.status === "keyword-only"
                              ? "仅关键词"
                              : "失败"}
                      </span>
                    </span>
                    <span>{file.chunks || "—"}</span>
                    <span>{new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(file.updatedAt))}</span>
                    <span className="row-actions">
                      <button
                        type="button"
                        aria-label={`删除 ${file.name}`}
                        onClick={() => void deleteLibraryFile(file.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </span>
                  </div>
                ))}
                {!visibleLibraryFiles.length && (
                  <div className="data-empty-state">
                    <p>{fileSearch ? "没有匹配的文件" : "还没有文件"}</p>
                    {!fileSearch && (
                      <button type="button" onClick={() => fileInputRef.current?.click()}>
                        上传文件
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {view === "skills" && (
          <section className="workspace-page skills-page">
            <div className="page-intro">
              <div>
                <h1>技能</h1>
                <p>上传技能后，可在输入框下方按需选择。</p>
              </div>
              <div className="page-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => skillFolderInputRef.current?.click()}
                >
                  <Folder size={16} />
                  上传文件夹
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => skillInputRef.current?.click()}
                >
                  <Upload size={16} />
                  上传技能
                </button>
                <input
                  ref={skillInputRef}
                  hidden
                  multiple
                  accept=".md,.zip,.txt,.json,.yaml,.yml"
                  type="file"
                  onChange={(event) => void handleSkillUpload(event.target.files)}
                />
                <input
                  ref={skillFolderInputRef}
                  hidden
                  multiple
                  type="file"
                  onChange={(event) => void handleSkillUpload(event.target.files)}
                />
              </div>
            </div>

            <div className="skill-grid">
              {state.skills.map((skill) => (
                <article className="skill-card" key={skill.id}>
                  <div className="skill-card-top">
                    <span className="skill-card-icon">{skillIcon(skill)}</span>
                    <span className={`source-badge ${skill.source}`}>
                      {skill.source === "built-in" ? "内置" : "已上传"}
                    </span>
                    {skill.source === "uploaded" && (
                      <button
                        type="button"
                        aria-label={`删除技能 ${skill.name}`}
                        onClick={() => void deleteSkill(skill.id)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                  <h2>{skill.name}</h2>
                  <p>{skill.description}</p>
                  <div className="skill-card-foot">
                    <span>
                      <FileArchive size={14} />
                      {skill.fileCount} 个文件
                    </span>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={() =>
                          setState((current) => ({
                            ...current,
                            skills: current.skills.map((item) =>
                              item.id === skill.id
                                ? { ...item, enabled: !item.enabled }
                                : item,
                            ),
                          }))
                        }
                      />
                      <span />
                    </label>
                  </div>
                </article>
              ))}
              <button
                className="skill-upload-card"
                type="button"
                onClick={() => skillInputRef.current?.click()}
              >
                <span>
                  <Plus size={22} />
                </span>
                <strong>添加新技能</strong>
                <small>支持 ZIP、SKILL.md 或完整目录</small>
              </button>
            </div>
          </section>
        )}

        {view === "memory" && (
          <section className="workspace-page memory-page">
            <div className="page-intro">
              <div>
                <h1>记忆</h1>
                <p>查看、修改或删除 EasyWork 保存的信息。</p>
              </div>
              <div className="page-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={refreshMemorySummary}
                >
                  <RefreshCw size={16} />
                  刷新摘要
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={addMemory}
                >
                  <Plus size={16} />
                  添加记忆
                </button>
              </div>
            </div>

            <div className="memory-layout">
              <div className="content-card memory-summary-card">
                <div className="card-heading">
                  <div>
                    <h2>记忆摘要</h2>
                  </div>
                </div>
                <p className="summary-text">
                  {state.memorySummary ||
                    "当前还没有摘要。点击“刷新摘要”可根据生效记忆重新生成。"}
                </p>
                <div className="summary-edit">
                  <Pencil size={15} />
                  <input
                    value={memoryInstruction}
                    onChange={(event) => setMemoryInstruction(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyMemoryInstruction();
                    }}
                    placeholder="告诉 EasyWork 要修改、补充或忘记什么"
                  />
                  <button type="button" onClick={applyMemoryInstruction}>
                    更新
                  </button>
                </div>
              </div>

              <div className="memory-controls">
                <label>
                  <span>
                    <strong>启用记忆</strong>
                    <small>在回答前检索相关长期记忆</small>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={state.settings.memoryEnabled}
                      onChange={() =>
                        setState((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            memoryEnabled: !current.settings.memoryEnabled,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                </label>
                <label>
                  <span>
                    <strong>引用聊天历史</strong>
                    <small>从相关旧对话提取上下文</small>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={state.settings.referenceHistory}
                      onChange={() =>
                        setState((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            referenceHistory: !current.settings.referenceHistory,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                </label>
                <label>
                  <span>
                    <strong>自动整理</strong>
                    <small>合并过期或冲突的记忆</small>
                  </span>
                  <span className="switch">
                    <input
                      type="checkbox"
                      checked={state.settings.autoCapture}
                      onChange={() =>
                        setState((current) => ({
                          ...current,
                          settings: {
                            ...current.settings,
                            autoCapture: !current.settings.autoCapture,
                          },
                        }))
                      }
                    />
                    <span />
                  </span>
                </label>
              </div>
            </div>

            <div className="memory-list-heading">
              <div>
                <h2>可管理记忆</h2>
                <span>来源可以追溯，关闭后不会进入模型上下文</span>
              </div>
              <div className="filter-chips">
                <button
                  className={memoryFilter === "all" ? "active" : ""}
                  type="button"
                  onClick={() => setMemoryFilter("all")}
                >
                  全部
                </button>
                <button
                  className={memoryFilter === "global" ? "active" : ""}
                  type="button"
                  onClick={() => setMemoryFilter("global")}
                >
                  全局
                </button>
                <button
                  className={memoryFilter === "project" ? "active" : ""}
                  type="button"
                  onClick={() => setMemoryFilter("project")}
                >
                  项目
                </button>
              </div>
            </div>
            <div className="memory-list">
              {visibleMemories.map((memory) => (
                <article className={`memory-row${memory.enabled ? "" : " disabled"}`} key={memory.id}>
                  <span className="memory-kind-icon">
                    {memory.kind === "workflow" ? (
                      <Activity size={17} />
                    ) : memory.kind === "goal" ? (
                      <Gauge size={17} />
                    ) : (
                      <Brain size={17} />
                    )}
                  </span>
                  <div className="memory-copy">
                    {editingMemoryId === memory.id ? (
                      <input
                        className="memory-edit-input"
                        value={editingMemoryText}
                        onChange={(event) => setEditingMemoryText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          setState((current) => ({
                            ...current,
                            memories: current.memories.map((item) =>
                              item.id === memory.id
                                ? {
                                    ...item,
                                    content: editingMemoryText.trim() || item.content,
                                    source: "手动纠正",
                                    confidence: 1,
                                    updatedAt: now(),
                                  }
                                : item,
                            ),
                          }));
                          setEditingMemoryId("");
                        }}
                        autoFocus
                      />
                    ) : (
                      <p>{memory.content}</p>
                    )}
                    <span>
                      <b className={memory.scope}>
                        {memory.scope === "global"
                          ? "全局"
                          : state.projects.find((project) => project.id === memory.projectId)?.name ??
                            "项目"}
                      </b>
                      <small>来源：{memory.source}</small>
                      <small>置信度 {Math.round(memory.confidence * 100)}%</small>
                    </span>
                  </div>
                  <label className="switch compact">
                    <input
                      type="checkbox"
                      checked={memory.enabled}
                      onChange={() =>
                        setState((current) => ({
                          ...current,
                          memories: current.memories.map((item) =>
                            item.id === memory.id
                              ? { ...item, enabled: !item.enabled }
                              : item,
                          ),
                        }))
                      }
                    />
                    <span />
                  </label>
                  <button
                    type="button"
                    aria-label={editingMemoryId === memory.id ? "保存记忆" : "编辑记忆"}
                    onClick={() => {
                      if (editingMemoryId === memory.id) {
                        setState((current) => ({
                          ...current,
                          memories: current.memories.map((item) =>
                            item.id === memory.id
                              ? {
                                  ...item,
                                  content: editingMemoryText.trim() || item.content,
                                  source: "手动纠正",
                                  confidence: 1,
                                  updatedAt: now(),
                                }
                              : item,
                          ),
                        }));
                        setEditingMemoryId("");
                      } else {
                        setEditingMemoryId(memory.id);
                        setEditingMemoryText(memory.content);
                      }
                    }}
                  >
                    {editingMemoryId === memory.id ? (
                      <Check size={15} />
                    ) : (
                      <Pencil size={14} />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="删除记忆"
                    onClick={() =>
                      setState((current) => ({
                        ...current,
                        memories: current.memories.filter((item) => item.id !== memory.id),
                      }))
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </article>
              ))}
              {!visibleMemories.length && (
                <div className="data-empty-state memory-empty-state">
                  <p>{memoryFilter === "all" ? "还没有记忆" : "该范围内没有记忆"}</p>
                  <button type="button" onClick={addMemory}>
                    添加记忆
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {view === "chat" && activeConversation && (
        <>
          <button
            className={`rail-edge-toggle${rightRailOpen ? " open" : ""}`}
            type="button"
            onClick={() => setRightRailOpen((current) => !current)}
            aria-label={rightRailOpen ? "收起对话记录" : "展开对话记录"}
            aria-expanded={rightRailOpen}
          >
            {rightRailOpen ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
          <aside
            className={`right-rail${mode === "chat" ? " chat-rail" : ""}${
              rightRailOpen ? " mobile-open" : ""
            }`}
          >
          {mode === "work" && (
            <section className={`remote-connection-panel ${connection.status}`}>
            <div className="remote-connection-heading">
              <span>远程连接</span>
              <span className="remote-connection-state">
                <i />
                {connection.status === "connected"
                  ? "已连接"
                  : connection.status === "connecting"
                    ? "连接中"
                    : connection.status === "error"
                      ? "连接失败"
                      : "未连接"}
              </span>
            </div>
            <strong>
              {activeServerProfile?.name ||
                connection.host ||
                "连接服务器"}
            </strong>
            <span className="remote-connection-address">
              {connection.status === "connected"
                ? `${connection.username || activeServerProfile?.username || ""}@${
                    connection.host || activeServerProfile?.host || ""
                  }`
                : activeServerProfile?.host || "尚未连接"}
            </span>
            <div className="remote-connection-actions">
              <button type="button" onClick={openConversationServerManager}>
                {connection.status === "connected" ? (
                  <Wifi size={14} />
                ) : (
                  <WifiOff size={14} />
                )}
                连接
              </button>
              <button
                type="button"
                onClick={() => openRemoteFiles("~")}
                disabled={connection.status !== "connected"}
              >
                <FolderOpen size={14} />
                文件
              </button>
            </div>
          </section>
          )}

          <header className="right-rail-header">
            <h2>对话记录</h2>
          </header>

          <div className="trace-list">
            {activeConversation?.messages
              .filter((message) => message.role === "user")
              .map((message) => {
                const traceKey = message.runId ?? message.id;
                const expanded = expandedTraces.has(traceKey);
                const hasSteps = Boolean(message.trace?.steps?.length);
                return (
                  <article
                    className={`trace-item${expanded ? " expanded" : ""}`}
                    key={message.id}
                  >
                    <button
                      className="trace-jump"
                      type="button"
                      onClick={() =>
                        document
                          .getElementById(`message-${message.id}`)
                          ?.scrollIntoView({ behavior: "smooth", block: "center" })
                      }
                      title="跳转到这条提问"
                    >
                      <span className="trace-question">
                        <strong>{message.content}</strong>
                        {message.trace?.status === "running" && <small>正在执行</small>}
                        {message.trace?.status === "error" && <small>执行失败</small>}
                      </span>
                    </button>
                    {hasSteps && (
                      <button
                        className="trace-toggle"
                        type="button"
                        aria-label={expanded ? "收起任务流程" : "展开任务流程"}
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedTraces((current) => {
                            const next = new Set(current);
                            if (next.has(traceKey)) next.delete(traceKey);
                            else next.add(traceKey);
                            return next;
                          })
                        }
                      >
                        <ChevronDown size={15} />
                      </button>
                    )}
                    <div className="trace-detail-motion" aria-hidden={!expanded}>
                      <div>
                        <div className="trace-detail">
                          {hasSteps && (
                            <div className="trace-steps">
                              {message.trace!.steps.map((step) => (
                                <div
                                  className={`trace-step ${step.status}`}
                                  key={step.id}
                                  aria-label={`${step.title}，${eventStatusLabel(step.status)}`}
                                >
                                  <StatusGlyph status={step.status} />
                                  <span className="trace-step-copy">
                                    <strong>{step.title}</strong>
                                    {step.detail && <small>{step.detail}</small>}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
          </div>
          </aside>
        </>
      )}

      {conversationPendingDelete && (
        <Modal title="删除对话？" onClose={() => setConversationPendingDelete(null)}>
          <div className="delete-conversation-dialog">
            <p>“{conversationPendingDelete.title}”将从聊天记录中删除。</p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setConversationPendingDelete(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => deleteConversation(conversationPendingDelete.id)}
              >
                删除
              </button>
            </div>
          </div>
        </Modal>
      )}
      {conversationEditor && (
        <ConversationRenameModal
          conversation={conversationEditor}
          onClose={() => setConversationEditor(null)}
          onSave={(title) => renameConversation(conversationEditor.id, title)}
        />
      )}
      {projectPendingDelete && (
        <Modal title="删除项目？" onClose={() => setProjectPendingDelete(null)}>
          <div className="delete-conversation-dialog">
            <p>
              “{projectPendingDelete.name}”及其中的对话将被删除。文件库中的原文件会保留。
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setProjectPendingDelete(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => deleteProject(projectPendingDelete.id)}
              >
                删除项目
              </button>
            </div>
          </div>
        </Modal>
      )}
      {projectModalOpen && (
        <ProjectModal
          onClose={() => {
            setProjectModalOpen(false);
            setProjectModalConversationId("");
          }}
          onCreate={createProject}
        />
      )}
      {projectEditor && (
        <ProjectEditModal
          project={projectEditor.project}
          mode={projectEditor.mode}
          onClose={() => setProjectEditor(null)}
          onSave={(updates) =>
            updateProject(projectEditor.project.id, updates)
          }
        />
      )}
      {projectLibraryModalOpen && projectPage && (
        <ProjectLibraryModal
          files={state.files}
          selectedIds={projectPage.fileIds ?? []}
          onClose={() => setProjectLibraryModalOpen(false)}
          onSave={(fileIds) => {
            setState((current) => ({
              ...current,
              projects: current.projects.map((project) =>
                project.id === projectPage.id
                  ? { ...project, fileIds }
                  : project,
              ),
            }));
            setProjectLibraryModalOpen(false);
          }}
        />
      )}
      {profileModalOpen && (
        <ProfileModal
          actor={actor}
          state={state}
          tab={accountTab}
          setTab={setAccountTab}
          onClose={() => setProfileModalOpen(false)}
          onActor={(nextActor) => {
            hydratedActorIdRef.current = nextActor.id;
            setActor(nextActor);
          }}
          onState={setState}
          onToast={showToast}
          onDeleteGuest={deleteGuestData}
        />
      )}
      {sshModalOpen && (
        <ServerManagerModal
          profiles={
            sshModalContext === "bound" &&
            activeConversation?.work?.serverId
              ? state.settings.servers.filter(
                  (profile) =>
                    profile.id === activeConversation.work?.serverId,
                )
              : state.settings.servers
          }
          connections={connections}
          selectedServerId={
            sshModalContext === "bound"
              ? effectiveServerId
              : sshModalContext === "new-work"
                ? draftServerId || globalServerId
                : globalServerId
          }
          conversationScoped={sshModalContext === "bound"}
          showFormConnect={sshModalContext === "new-work"}
          showDemo={sshModalContext === "new-work"}
          locked={Boolean(
            sshModalContext === "bound" &&
              activeConversation?.work?.serverId,
          )}
          gatewayStatus={gatewayStatus}
          canRemember={actor.authenticated}
          onSelect={selectServerForModal}
          onClose={() => setSshModalOpen(false)}
          onDemo={connectDemo}
          onSave={saveServerProfile}
          onConnect={connectSsh}
          onDisconnect={disconnectSsh}
          onRetry={() => setGatewayProbe((current) => current + 1)}
        />
      )}
      {agentConfigOpen && (
        <AgentConfigModal
          agent={configAgent}
          path={agentConfigPath}
          content={agentConfigContent}
          loading={agentConfigLoading}
          onChange={setAgentConfigContent}
          onSave={saveAgentConfig}
          onClose={() => {
            setAgentConfigOpen(false);
            setAgentConfigLoading(false);
          }}
        />
      )}
      {agentUpdateModalOpen && (
        <AgentUpdateModal
          state={activeAgentUpdate}
          onUpdate={applyAgentUpdate}
          onRetry={checkAgentUpdate}
          onClose={() => setAgentUpdateModalOpen(false)}
        />
      )}
      {fileManagerOpen && (
        <RemoteFileManagerModal
          serverName={activeServerProfile?.name || connection.host || "远程服务器"}
          path={remoteFilePath}
          home={remoteFileHome}
          parent={remoteFileParent}
          entries={remoteFiles}
          loading={remoteFilesLoading}
          uploadInputRef={remoteUploadInputRef}
          onOpen={openRemoteFiles}
          onDownload={downloadRemoteFile}
          onUpload={uploadRemoteFiles}
          onCreateFolder={createRemoteFolder}
          onClose={() => setFileManagerOpen(false)}
        />
      )}
      {embeddingModalOpen && (
        <EmbeddingModal
          settings={state.settings}
          onClose={() => setEmbeddingModalOpen(false)}
          onSave={async (embedding) => {
            const publicEmbedding: AppSettings["embedding"] = {
              baseUrl: embedding.baseUrl,
              model: embedding.model,
              dimensions: embedding.dimensions,
              configured: embedding.configured,
              hybridEnabled: embedding.hybridEnabled,
              rerankEnabled: embedding.rerankEnabled,
            };
            setState((current) => ({
              ...current,
              settings: { ...current.settings, embedding: publicEmbedding },
            }));
            try {
              await gatewayFetch("/api/settings/embedding", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(embedding),
              });
            } catch {
              // Keep the visible configuration in this browser session.
            }
            setEmbeddingModalOpen(false);
            showToast("Embedding API 设置已保存");
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ConversationRenameModal({
  conversation,
  onClose,
  onSave,
}: {
  conversation: Conversation;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState(conversation.title);
  return (
    <Modal title="重命名对话" onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(title);
        }}
      >
        <label className="field">
          <span>对话名称</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
          />
        </label>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={!title.trim()}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, mode: Project["memoryMode"]) => void;
}) {
  const [name, setName] = useState("");
  const [memoryMode, setMemoryMode] =
    useState<Project["memoryMode"]>("project-only");
  return (
    <Modal title="新建项目" eyebrow="PROJECT" onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name, memoryMode);
        }}
      >
        <label className="field">
          <span>项目名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：集群实验复现"
          />
        </label>
        <fieldset className="memory-mode-choice">
          <legend>记忆范围</legend>
          <label className={memoryMode === "project-only" ? "selected" : ""}>
            <input
              type="radio"
              name="memory-mode"
              checked={memoryMode === "project-only"}
              onChange={() => setMemoryMode("project-only")}
            />
            <span className="choice-icon">
              <FolderLock size={18} />
            </span>
            <span>
              <strong>仅限项目内记忆</strong>
              <small>只使用本项目的聊天、文件和记忆。</small>
            </span>
            <span className="radio-dot" />
          </label>
          <label className={memoryMode === "default" ? "selected" : ""}>
            <input
              type="radio"
              name="memory-mode"
              checked={memoryMode === "default"}
              onChange={() => setMemoryMode("default")}
            />
            <span className="choice-icon">
              <Network size={18} />
            </span>
            <span>
              <strong>全局记忆</strong>
              <small>同时使用全局记忆和本项目内容。</small>
            </span>
            <span className="radio-dot" />
          </label>
        </fieldset>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={!name.trim()}>
            创建项目
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectEditModal({
  project,
  mode,
  onClose,
  onSave,
}: {
  project: Project;
  mode: "rename" | "settings";
  onClose: () => void;
  onSave: (updates: Pick<Project, "name" | "memoryMode">) => void;
}) {
  const [name, setName] = useState(project.name);
  const [memoryMode, setMemoryMode] = useState<Project["memoryMode"]>(
    project.memoryMode,
  );
  return (
    <Modal
      title={mode === "rename" ? "重命名项目" : "项目设置"}
      onClose={onClose}
    >
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, memoryMode });
        }}
      >
        <label className="field">
          <span>项目名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {mode === "settings" && (
          <fieldset className="memory-mode-choice">
            <legend>记忆范围</legend>
            <label
              className={memoryMode === "project-only" ? "selected" : ""}
            >
              <input
                type="radio"
                name="edit-memory-mode"
                checked={memoryMode === "project-only"}
                onChange={() => setMemoryMode("project-only")}
              />
              <span className="choice-icon">
                <FolderLock size={18} />
              </span>
              <span>
                <strong>仅限项目内记忆</strong>
                <small>只使用本项目的对话、文件和记忆。</small>
              </span>
              <span className="radio-dot" />
            </label>
            <label className={memoryMode === "default" ? "selected" : ""}>
              <input
                type="radio"
                name="edit-memory-mode"
                checked={memoryMode === "default"}
                onChange={() => setMemoryMode("default")}
              />
              <span className="choice-icon">
                <Network size={18} />
              </span>
              <span>
                <strong>全局记忆</strong>
                <small>同时使用全局记忆和本项目内容。</small>
              </span>
              <span className="radio-dot" />
            </label>
          </fieldset>
        )}
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={!name.trim()}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectLibraryModal({
  files,
  selectedIds,
  onClose,
  onSave,
}: {
  files: LibraryFile[];
  selectedIds: string[];
  onClose: () => void;
  onSave: (fileIds: string[]) => void;
}) {
  const [selected, setSelected] = useState(() => new Set(selectedIds));
  const [query, setQuery] = useState("");
  const visible = files.filter((file) =>
    file.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <Modal title="关联文件库" onClose={onClose}>
      <div className="project-library-dialog">
        <label className="project-library-search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件"
          />
        </label>
        <div className="project-library-options">
          {visible.map((file) => {
            const checked = selected.has(file.id);
            return (
              <button
                className={checked ? "selected" : ""}
                type="button"
                key={file.id}
                onClick={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(file.id)) next.delete(file.id);
                    else next.add(file.id);
                    return next;
                  })
                }
              >
                <span className="project-library-file-icon">
                  <FileText size={16} />
                </span>
                <span>
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                </span>
                <span className="project-library-check">
                  {checked && <Check size={14} />}
                </span>
              </button>
            );
          })}
          {!visible.length && (
            <div className="project-library-empty">
              {files.length ? "没有匹配的文件" : "文件库还没有文件"}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => onSave([...selected])}
          >
            保存关联
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProfileModal({
  actor,
  state,
  tab,
  setTab,
  onClose,
  onActor,
  onState,
  onToast,
  onDeleteGuest,
}: {
  actor: Actor;
  state: EasyWorkState;
  tab: "login" | "register" | "profile" | "api";
  setTab: (tab: "login" | "register" | "profile" | "api") => void;
  onClose: () => void;
  onActor: (actor: Actor) => void;
  onState: React.Dispatch<React.SetStateAction<EasyWorkState>>;
  onToast: (message: string) => void;
  onDeleteGuest: () => Promise<void>;
}) {
  const [email, setEmail] = useState(actor.email ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(actor.authenticated ? actor.displayName : "");
  const [avatar, setAvatar] = useState(actor.avatar ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState({
    ...state.settings.provider,
    apiKey: "",
  });
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiKeyLoading, setApiKeyLoading] = useState(
    tab === "api" && state.settings.provider.configured,
  );
  const [modelError, setModelError] = useState("");

  useEffect(() => {
    if (tab !== "api" || !provider.configured) return;
    let cancelled = false;
    void gatewayFetch("/api/settings/provider/key")
      .then(async (response) => {
        const payload = (await response.json()) as {
          apiKey?: string;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || "API Key 读取失败");
        if (!cancelled) {
          setProvider((current) => ({
            ...current,
            apiKey: String(payload.apiKey || ""),
          }));
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setModelError(
            caught instanceof Error ? caught.message : "API Key 读取失败",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setApiKeyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider.configured, tab]);

  const authenticate = async (kind: "login" | "register") => {
    setBusy(true);
    setError("");
    try {
      const currentToken = readDeviceToken();
      await gatewayFetch("/api/state", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(currentToken
            ? { Authorization: `Bearer ${currentToken}` }
            : {}),
        },
        body: JSON.stringify({ state }),
      }).catch(() => undefined);
      const response = await gatewayFetch(`/api/auth/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName: name }),
      });
      const payload = (await response.json()) as {
        actor?: Actor;
        deviceToken?: string;
        error?: string;
      };
      if (!response.ok || !payload.actor) throw new Error(payload.error || "认证失败");
      storeDeviceToken(payload.deviceToken);
      onActor(payload.actor);
      const bootstrapResponse = await gatewayFetch("/api/bootstrap");
      if (bootstrapResponse.ok) {
        const bootstrap = (await bootstrapResponse.json()) as {
          deviceToken?: string;
          state?: Partial<EasyWorkState>;
        };
        storeDeviceToken(bootstrap.deviceToken);
        if (bootstrap.state) {
          onState(mergeStoredState(DEFAULT_STATE, bootstrap.state ?? {}));
        }
      }
      setTab("profile");
      onToast(kind === "register" ? "账号已创建" : "登录成功");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法连接账户服务");
    } finally {
      setBusy(false);
    }
  };

  const saveProfile = async () => {
    const nextActor = { ...actor, displayName: name || actor.displayName, avatar };
    onActor(nextActor);
    try {
      await gatewayFetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nextActor.displayName, avatar }),
      });
    } catch {
      // Keep the visible update for the current session.
    }
    onToast("个人资料已保存");
  };

  const saveProvider = async () => {
    if (/^https?:\/\//i.test(provider.apiKey.trim())) {
      setModelError("API Key 不能填写 API URL");
      return;
    }
    setModelError("");
    try {
      const response = await gatewayFetch("/api/settings/provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "OpenAI Compatible",
          baseUrl: provider.baseUrl,
          ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        provider?: AppSettings["provider"];
      };
      if (!response.ok) throw new Error(payload.error || "模型 API 保存失败");
      onState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          provider: payload.provider ?? current.settings.provider,
        },
      }));
      onToast("模型 API 已保存");
      onClose();
    } catch (caught) {
      setModelError(caught instanceof Error ? caught.message : "模型 API 保存失败");
    }
  };

  return (
    <Modal
      title={
        tab === "api"
          ? "模型 API"
          : actor.authenticated
            ? "个人资料"
            : tab === "register"
              ? "创建账号"
              : "登录 EasyWork"
      }
      eyebrow="ACCOUNT"
      onClose={onClose}
    >
      <div className="account-tabs">
        {!actor.authenticated ? (
          <>
            <button
              className={tab === "login" ? "active" : ""}
              type="button"
              onClick={() => setTab("login")}
            >
              登录
            </button>
            <button
              className={tab === "register" ? "active" : ""}
              type="button"
              onClick={() => setTab("register")}
            >
              注册
            </button>
          </>
        ) : (
          <>
            <button
              className={tab === "profile" ? "active" : ""}
              type="button"
              onClick={() => setTab("profile")}
            >
              个人资料
            </button>
            <button
              className={tab === "api" ? "active" : ""}
              type="button"
              onClick={() => setTab("api")}
            >
              模型 API
            </button>
          </>
        )}
      </div>

      {!actor.authenticated && (tab === "login" || tab === "register") && (
        <form
          className="modal-form auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void authenticate(tab);
          }}
        >
          {tab === "register" && (
            <label className="field">
              <span>用户名</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="你的显示名称" />
            </label>
          )}
          <label className="field">
            <span>邮箱</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              autoComplete={tab === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={tab === "register" ? "至少 8 位" : "输入密码"}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button full" type="submit" disabled={busy || !email || !password}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
            {tab === "register" ? "创建账号" : "登录"}
          </button>
          <div className="guest-data-card">
            <HardDrive size={17} />
            <div>
              <strong>访客数据保存在临时目录</strong>
            </div>
            <button type="button" onClick={() => void onDeleteGuest()}>
              删除
            </button>
          </div>
        </form>
      )}

      {actor.authenticated && tab === "profile" && (
        <div className="modal-form profile-form">
          <div className="avatar-editor">
            <span className="large-avatar">
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatar} alt="" />
              ) : (
                actor.displayName.slice(0, 1).toUpperCase()
              )}
            </span>
            <label className="secondary-button">
              <Upload size={15} />
              更换头像
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setAvatar(String(reader.result ?? ""));
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          </div>
          <label className="field">
            <span>用户名</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>邮箱</span>
            <input value={actor.email ?? ""} disabled />
          </label>
          <div className="modal-actions spread">
            <button
              className="text-danger-button"
              type="button"
              onClick={async () => {
                const response = await gatewayFetch("/api/auth/logout", {
                  method: "POST",
                }).catch(() => undefined);
                const payload = response?.ok
                  ? ((await response.json()) as { actor?: Actor; deviceToken?: string })
                  : {};
                clearDeviceToken();
                storeDeviceToken(payload.deviceToken);
                onActor(payload.actor ?? DEFAULT_ACTOR);
                onState(DEFAULT_STATE);
                onClose();
              }}
            >
              <LogOut size={15} />
              退出登录
            </button>
            <button className="primary-button" type="button" onClick={() => void saveProfile()}>
              保存修改
            </button>
          </div>
        </div>
      )}

      {actor.authenticated && tab === "api" && (
        <div className="modal-form api-form">
          <label className="field">
            <span>API URL</span>
            <input
              value={provider.baseUrl}
              onChange={(event) =>
                setProvider((current) => ({ ...current, baseUrl: event.target.value }))
              }
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="field">
            <span>API Key</span>
            <span className="api-key-control">
              <input
                type={apiKeyVisible ? "text" : "password"}
                autoComplete="new-password"
                spellCheck={false}
                value={provider.apiKey}
                onChange={(event) =>
                  setProvider((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
                placeholder={
                  apiKeyLoading
                    ? "正在读取…"
                    : provider.configured
                      ? "••••••••••••••••"
                      : "sk-…"
                }
              />
              <button
                type="button"
                onClick={() => setApiKeyVisible((current) => !current)}
                disabled={apiKeyLoading || !provider.apiKey}
              >
                {apiKeyVisible ? "隐藏" : "显示"}
              </button>
            </span>
          </label>
          {modelError && <div className="form-error">{modelError}</div>}
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              disabled={
                !provider.baseUrl ||
                (!provider.apiKey && !provider.configured) ||
                apiKeyLoading
              }
              onClick={() => void saveProvider()}
            >
              保存 API
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ServerManagerModal({
  profiles,
  connections,
  selectedServerId,
  conversationScoped,
  showFormConnect,
  showDemo,
  locked,
  gatewayStatus,
  canRemember,
  onSelect,
  onClose,
  onDemo,
  onSave,
  onConnect,
  onDisconnect,
  onRetry,
}: {
  profiles: ServerProfile[];
  connections: Record<string, ConnectionState>;
  selectedServerId: string;
  conversationScoped: boolean;
  showFormConnect: boolean;
  showDemo: boolean;
  locked: boolean;
  gatewayStatus: "checking" | "connected" | "unavailable";
  canRemember: boolean;
  onSelect: (serverId: string) => void;
  onClose: () => void;
  onDemo: () => void;
  onSave: (profile: ServerProfileDraft) => void;
  onConnect: (payload: {
    serverId: string;
    name?: string;
    host: string;
    port: number;
    username: string;
    authMethod: "key" | "password";
    privateKey?: string;
    privateKeyName?: string;
    password?: string;
    useSavedCredential?: boolean;
    rememberCredential?: boolean;
    passphrase?: string;
    otp?: string;
    trustHost?: boolean;
  }) => void;
  onDisconnect: (serverId: string) => void;
  onRetry: () => void;
}) {
  const createId = () =>
    `server-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now()}`;
  const generatedId = useId().replace(/:/g, "");
  const initialProfile = profiles.find(
    (profile) => profile.id === selectedServerId,
  );
  const [serverId, setServerId] = useState(
    initialProfile?.id || `server-${generatedId}`,
  );
  const [name, setName] = useState(initialProfile?.name || "");
  const [host, setHost] = useState(initialProfile?.host || "");
  const [port, setPort] = useState(String(initialProfile?.port || 22));
  const [username, setUsername] = useState(initialProfile?.username || "");
  const [authMethod, setAuthMethod] = useState<"key" | "password">(
    initialProfile?.authMethod || "key",
  );
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyName, setPrivateKeyName] = useState("");
  const [useSavedCredential, setUseSavedCredential] = useState(
    Boolean(initialProfile?.configured),
  );
  const [pasteKeyOpen, setPasteKeyOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [otp, setOtp] = useState("");
  const [trustHost, setTrustHost] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const connection = connections[serverId] ?? {
    serverId,
    status: "disconnected",
    label: "尚未连接",
  };
  const selectedProfile = profiles.find((profile) => profile.id === serverId);
  const normalizedPort = Number(port) || 22;
  const keepsSavedCredential = Boolean(
    selectedProfile?.configured &&
      useSavedCredential &&
      selectedProfile.host === host.trim() &&
      selectedProfile.port === normalizedPort &&
      selectedProfile.username === username.trim() &&
      (selectedProfile.authMethod || "key") === authMethod,
  );
  const profileDraft = (): ServerProfileDraft => ({
    id: serverId,
    name: name.trim() || host.trim(),
    host: host.trim(),
    port: normalizedPort,
    username: username.trim(),
    keyName:
      authMethod === "key"
        ? privateKeyName || selectedProfile?.keyName || ""
        : "",
    authMethod,
    configured: keepsSavedCredential,
    privateKey:
      authMethod === "key" && !useSavedCredential && privateKey
        ? privateKey
        : undefined,
    password:
      authMethod === "password" && !useSavedCredential && password
        ? password
        : undefined,
    lastConnectedAt: selectedProfile?.lastConnectedAt,
  });

  const chooseProfile = (profile: ServerProfile) => {
    setServerId(profile.id);
    setName(profile.name);
    setHost(profile.host);
    setPort(String(profile.port || 22));
    setUsername(profile.username);
    setAuthMethod(profile.authMethod || "key");
    setPassword("");
    setPrivateKey("");
    setPrivateKeyName("");
    setUseSavedCredential(profile.configured);
    setPasteKeyOpen(false);
    setPassphrase("");
    setOtp("");
    setConfigurationOpen(false);
    setTrustHost(false);
    onSelect(profile.id);
  };

  const startNewProfile = () => {
    const nextId = createId();
    setServerId(nextId);
    setName("");
    setHost("");
    setPort("22");
    setUsername("");
    setAuthMethod("key");
    setPassword("");
    setPrivateKey("");
    setPrivateKeyName("");
    setUseSavedCredential(false);
    setPasteKeyOpen(false);
    setPassphrase("");
    setOtp("");
    setConfigurationOpen(true);
    setTrustHost(false);
    onSelect(nextId);
  };

  const connectSavedProfile = () => {
    if (!selectedProfile?.configured) {
      setConfigurationOpen(true);
      return;
    }
    onConnect({
      serverId: selectedProfile.id,
      name: selectedProfile.name,
      host: selectedProfile.host,
      port: selectedProfile.port || 22,
      username: selectedProfile.username,
      authMethod: selectedProfile.authMethod || "key",
      useSavedCredential: true,
      otp: otp.trim() || undefined,
    });
  };

  return (
    <Modal title="远程连接" onClose={onClose} wide>
      <div className={`server-manager${conversationScoped ? " compact" : ""}`}>
        {!conversationScoped && (
          <aside className="server-profile-list">
          <div className="server-profile-list-heading">
            <span>{locked ? "当前服务器" : "服务器"}</span>
            {!locked && (
              <button type="button" onClick={startNewProfile} aria-label="添加服务器">
                <Plus size={15} />
              </button>
            )}
          </div>
          {profiles.map((profile) => {
            const itemConnection = connections[profile.id];
            return (
              <button
                className={profile.id === serverId ? "active" : ""}
                type="button"
                key={profile.id}
                onClick={() => chooseProfile(profile)}
              >
                <span className={`server-state-dot ${itemConnection?.status || "disconnected"}`} />
                <span>
                  <strong>{profile.name || profile.host}</strong>
                  <small>{profile.username ? `${profile.username}@` : ""}{profile.host}</small>
                </span>
              </button>
            );
          })}
          {!profiles.length && (
            <span className="server-profile-empty">还没有保存的服务器</span>
          )}
          {showDemo && !locked && (
            <button className="demo-server-button" type="button" onClick={onDemo}>
              演示连接
            </button>
          )}
          </aside>
        )}

        <div className="server-connection-body">
          {gatewayStatus !== "connected" ? (
            <div className="gateway-unavailable-panel">
              <span className="gateway-state-icon">
                {gatewayStatus === "checking" ? (
                  <LoaderCircle className="spin" size={22} />
                ) : (
                  <WifiOff size={22} />
                )}
              </span>
              <h3>
                {gatewayStatus === "checking"
                  ? "正在连接"
                  : "连接失败"}
              </h3>
              {gatewayStatus === "unavailable" && (
                <button
                  className="secondary-button gateway-retry-button"
                  type="button"
                  onClick={onRetry}
                >
                  <RefreshCw size={15} />
                  重试
                </button>
              )}
            </div>
          ) : (conversationScoped ||
              (showFormConnect && connection.status === "connected")) &&
            !configurationOpen &&
            selectedProfile ? (
            <div
              className={`connected-panel server-connected-panel quick-connection-panel ${connection.status}`}
            >
              <span className="connected-hero">
                {connection.status === "connecting" ? (
                  <LoaderCircle className="spin" size={24} />
                ) : connection.status === "connected" ? (
                  <Wifi size={24} />
                ) : (
                  <WifiOff size={24} />
                )}
              </span>
              <h3>{selectedProfile.name || selectedProfile.host}</h3>
              <p>
                {selectedProfile.username}@{selectedProfile.host}
              </p>
              <div className="connection-facts">
                <span>
                  <strong>
                    {connection.status === "connected"
                      ? `${connection.latency ?? "—"} ms`
                      : connection.status === "connecting"
                        ? "连接中"
                        : "未连接"}
                  </strong>
                  <small>连接状态</small>
                </span>
                <span>
                  <strong>{connection.port || selectedProfile.port || 22}</strong>
                  <small>SSH 端口</small>
                </span>
              </div>
              {connection.status === "error" && (
                <div className="form-error" role="alert">
                  {connection.label}
                </div>
              )}
              <div className="quick-connection-actions">
                <button
                  className="secondary-button quick-config-button"
                  type="button"
                  onClick={() => setConfigurationOpen(true)}
                >
                  <Settings2 size={15} />
                  配置
                </button>
                {connection.status === "connected" ? (
                  <button
                    className="secondary-button quick-disconnect-button"
                    type="button"
                    onClick={() => onDisconnect(serverId)}
                  >
                    <WifiOff size={15} />
                    断开连接
                  </button>
                ) : (
                  <>
                    <input
                      className="quick-otp-input"
                      value={otp}
                      inputMode="numeric"
                      onChange={(event) =>
                        setOtp(event.target.value.replace(/\D/g, ""))
                      }
                      placeholder="请输入2FA验证码（可选）"
                      aria-label="2FA 验证码（可选）"
                      autoComplete="one-time-code"
                    />
                    <button
                      className="primary-button quick-connect-button"
                      type="button"
                      onClick={connectSavedProfile}
                      disabled={connection.status === "connecting"}
                    >
                      {connection.status === "connecting" ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <KeyRound size={15} />
                      )}
                      {connection.status === "connecting" ? "连接中" : "连接"}
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <form
              className="modal-form ssh-form server-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!showFormConnect && !conversationScoped) return;
                onConnect({
                  serverId,
                  name: name.trim() || host,
                  host,
                  port: Number(port) || 22,
                  username,
                  authMethod,
                  privateKey: privateKey || undefined,
                  privateKeyName:
                    privateKeyName || selectedProfile?.keyName || undefined,
                  password: password || undefined,
                  useSavedCredential,
                  rememberCredential:
                    canRemember && Boolean(authMethod === "key" ? privateKey : password),
                  passphrase: passphrase || undefined,
                  otp: otp || undefined,
                  trustHost,
                });
              }}
            >
              {conversationScoped && profiles.length > 0 && !locked && (
                <label className="field conversation-server-picker">
                  <span>服务器</span>
                  <select
                    value={selectedProfile ? serverId : ""}
                    onChange={(event) => {
                      const profile = profiles.find(
                        (item) => item.id === event.target.value,
                      );
                      if (profile) chooseProfile(profile);
                    }}
                  >
                    <option value="" disabled>
                      选择已保存的服务器
                    </option>
                    {profiles.map((profile) => (
                      <option value={profile.id} key={profile.id}>
                        {profile.name || profile.host}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(conversationScoped || showFormConnect) &&
                selectedProfile && (
                <button
                  className="server-config-back"
                  type="button"
                  onClick={() => setConfigurationOpen(false)}
                >
                  <ChevronLeft size={14} />
                  返回连接
                </button>
                )}
              <label className="field">
                <span>服务器名称</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={host || "如：学校集群"}
                />
              </label>
              <div className="ssh-target-grid">
                <label className="field host-field">
                  <span>登录节点</span>
                  <input
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="例如 login.example.edu"
                    required
                  />
                </label>
                <label className="field port-field">
                  <span>端口</span>
                  <input
                    value={port}
                    inputMode="numeric"
                    onChange={(event) => setPort(event.target.value)}
                    required
                  />
                </label>
              </div>
              <label className="field">
                <span>用户名</span>
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="远程账号"
                  required
                />
              </label>
              <div className="field auth-method-field">
                <span>登录方式</span>
                <div className="auth-method-switch" role="group" aria-label="选择登录方式">
                  <button
                    className={authMethod === "password" ? "active" : ""}
                    type="button"
                    onClick={() => {
                      setAuthMethod("password");
                      setUseSavedCredential(
                        Boolean(
                          selectedProfile?.configured &&
                            selectedProfile.authMethod === "password",
                        ),
                      );
                    }}
                  >
                    <KeyRound size={15} />
                    密码
                  </button>
                  <button
                    className={authMethod === "key" ? "active" : ""}
                    type="button"
                    onClick={() => {
                      setAuthMethod("key");
                      setUseSavedCredential(
                        Boolean(
                          selectedProfile?.configured &&
                            selectedProfile.authMethod !== "password",
                        ),
                      );
                    }}
                  >
                    <ShieldCheck size={15} />
                    私钥
                  </button>
                </div>
              </div>

              {authMethod === "password" ? (
                <div className="field credential-panel">
                  <span>登录密码</span>
                  {selectedProfile?.configured &&
                    selectedProfile.authMethod === "password" && (
                      <button
                        className={`saved-key-choice${
                          useSavedCredential ? " selected" : ""
                        }`}
                        type="button"
                        onClick={() => {
                          setUseSavedCredential(true);
                          setPassword("");
                        }}
                      >
                        <ShieldCheck size={16} />
                        <span>
                          <strong>已保存的密码</strong>
                          <small>使用账号中加密保存的凭据</small>
                        </span>
                        {useSavedCredential && <Check size={15} />}
                      </button>
                    )}
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setUseSavedCredential(false);
                    }}
                    placeholder={
                      selectedProfile?.configured ? "输入新密码" : "输入登录密码"
                    }
                    autoComplete="current-password"
                  />
                </div>
              ) : (
                <div className="field key-picker-field credential-panel">
                  <span>SSH 私钥</span>
                  {selectedProfile?.configured &&
                    selectedProfile.authMethod !== "password" && (
                      <button
                        className={`saved-key-choice${
                          useSavedCredential ? " selected" : ""
                        }`}
                        type="button"
                        onClick={() => {
                          setUseSavedCredential(true);
                          setPrivateKey("");
                          setPrivateKeyName("");
                          setPasteKeyOpen(false);
                        }}
                      >
                        <ShieldCheck size={16} />
                        <span>
                          <strong>{selectedProfile.keyName || "已保存的私钥"}</strong>
                          <small>使用账号中加密保存的私钥</small>
                        </span>
                        {useSavedCredential && <Check size={15} />}
                      </button>
                    )}
                  <div className="key-picker-actions">
                    <label className="secondary-button">
                      <Upload size={15} />
                      {selectedProfile?.configured ? "更换文件" : "选择文件"}
                      <input
                        type="file"
                        hidden
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            setPrivateKey(String(reader.result ?? ""));
                            setPrivateKeyName(file.name);
                            setUseSavedCredential(false);
                            setPasteKeyOpen(false);
                          };
                          reader.readAsText(file);
                        }}
                      />
                    </label>
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        setPasteKeyOpen((value) => !value);
                        if (!pasteKeyOpen) setUseSavedCredential(false);
                      }}
                    >
                      {pasteKeyOpen ? "收起" : "粘贴私钥"}
                    </button>
                  </div>
                  {privateKeyName && (
                    <div className="selected-key-file">
                      <Check size={14} />
                      {privateKeyName}
                    </div>
                  )}
                  {pasteKeyOpen && (
                    <textarea
                      className="private-key-paste"
                      value={privateKey}
                      onChange={(event) => {
                        setPrivateKey(event.target.value);
                        setUseSavedCredential(false);
                      }}
                      placeholder="粘贴 SSH 私钥"
                      rows={4}
                      autoComplete="off"
                    />
                  )}
                  <label className="nested-field">
                    <span>私钥密码（可选）</span>
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder="私钥未加密可留空"
                    />
                  </label>
                </div>
              )}

              <label className="field optional-otp-field">
                <span>2FA 验证码 <small>可选</small></span>
                <input
                  value={otp}
                  inputMode="numeric"
                  onChange={(event) =>
                    setOtp(event.target.value.replace(/\D/g, ""))
                  }
                  placeholder="服务器要求时填写"
                  autoComplete="one-time-code"
                />
              </label>
              {connection.status === "error" && !connection.fingerprint && (
                <div className="form-error" role="alert">
                  {connection.label}
                </div>
              )}
              {(showFormConnect || conversationScoped) &&
                connection.status === "error" &&
                connection.fingerprint && (
                <div className="host-key-confirm">
                  <span>
                    <ShieldCheck size={16} />
                    <strong>确认主机指纹</strong>
                  </span>
                  <code>{connection.fingerprint}</code>
                  <label>
                    <input
                      type="checkbox"
                      checked={trustHost}
                      onChange={(event) => setTrustHost(event.target.checked)}
                    />
                    我已核对并信任此主机
                  </label>
                </div>
                )}
              <div className="modal-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    onSave(profileDraft());
                    if (
                      conversationScoped || showFormConnect
                    ) {
                      setConfigurationOpen(false);
                    }
                  }}
                  disabled={!host.trim() || !port || !username.trim()}
                >
                  <Save size={15} />
                  保存
                </button>
                {(showFormConnect || conversationScoped) && (
                  <button
                    className="primary-button form-connect-button"
                    type="submit"
                    disabled={
                      connection.status === "connecting" ||
                      !host ||
                      !port ||
                      !username ||
                      (authMethod === "key"
                        ? !privateKey && !useSavedCredential
                        : !password && !useSavedCredential) ||
                      Boolean(
                        connection.status === "error" &&
                          connection.fingerprint &&
                          !trustHost,
                      )
                    }
                  >
                    {connection.status === "connecting" ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <KeyRound size={16} />
                    )}
                    {connection.status === "connecting" ? "连接中" : "连接 SSH"}
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AgentUpdateModal({
  state,
  onUpdate,
  onRetry,
  onClose,
}: {
  state: AgentUpdateState;
  onUpdate: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const busy = ["checking", "downloading", "updating", "configuring"].includes(
    state.status,
  );
  const available = state.status === "available";
  const failed = state.status === "error";
  const done = state.status === "done";
  return (
    <Modal title="OpenCode 更新" onClose={onClose}>
      <div className={`agent-update-dialog ${state.status}`}>
        <span className="agent-update-hero">
          {busy ? (
            <LoaderCircle className="spin" size={24} />
          ) : failed ? (
            <X size={22} />
          ) : (
            <Check size={22} />
          )}
        </span>
        <h3>
          {available
            ? "发现新版本"
            : failed
              ? "更新未完成"
              : done
                ? "更新完成"
                : "正在检查 OpenCode"}
        </h3>
        <p>
          {state.error ||
            state.label ||
            (busy ? "正在连接远端服务器…" : "OpenCode 已是最新版")}
        </p>
        {(state.currentVersion || state.latestVersion) && (
          <div className="agent-update-versions">
            <span>
              <small>当前版本</small>
              <strong>{state.currentVersion || "—"}</strong>
            </span>
            <ChevronRight size={16} />
            <span>
              <small>最新版本</small>
              <strong>{state.latestVersion || "—"}</strong>
            </span>
          </div>
        )}
        <div className="modal-actions">
          {available && (
            <>
              <button className="secondary-button" type="button" onClick={onClose}>
                稍后
              </button>
              <button className="primary-button" type="button" onClick={onUpdate}>
                <Download size={15} />
                更新
              </button>
            </>
          )}
          {failed && (
            <>
              <button className="secondary-button" type="button" onClick={onClose}>
                关闭
              </button>
              <button className="primary-button" type="button" onClick={onRetry}>
                <RefreshCw size={15} />
                重新检测
              </button>
            </>
          )}
          {done && (
            <button className="primary-button" type="button" onClick={onClose}>
              完成
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AgentConfigModal({
  agent,
  path,
  content,
  loading,
  onChange,
  onSave,
  onClose,
}: {
  agent?: AgentItem;
  path: string;
  content: string;
  loading: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`${agent?.name || "Agent"} 配置`} onClose={onClose} wide>
      <div className="agent-config-editor">
        <div className="agent-config-path">
          <FileText size={15} />
          <code>{path || "正在读取 Agent 原生配置…"}</code>
        </div>
        <textarea
          value={content}
          onChange={(event) => onChange(event.target.value)}
          disabled={loading || !path}
          spellCheck={false}
          aria-label="Agent 原生配置文件"
        />
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={onSave}
            disabled={loading || !path || !content.trim()}
          >
            {loading ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Save size={15} />
            )}
            保存配置
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RemoteFileManagerModal({
  serverName,
  path,
  home,
  parent,
  entries,
  loading,
  uploadInputRef,
  onOpen,
  onDownload,
  onUpload,
  onCreateFolder,
  onClose,
}: {
  serverName: string;
  path: string;
  home: string;
  parent: string | null;
  entries: RemoteFileEntry[];
  loading: boolean;
  uploadInputRef: React.RefObject<HTMLInputElement | null>;
  onOpen: (path: string) => void;
  onDownload: (path: string) => void;
  onUpload: (files: FileList | null) => void | Promise<void>;
  onCreateFolder: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={`${serverName} · 文件`} onClose={onClose} wide>
      <div className="remote-file-manager">
        <div className="remote-file-toolbar">
          <div className="remote-file-location">
            <button
              type="button"
              onClick={() => onOpen(home || "~")}
              aria-label="打开主目录"
            >
              <Home size={15} />
            </button>
            <button
              type="button"
              onClick={() => parent && onOpen(parent)}
              disabled={!parent}
              aria-label="返回上级目录"
            >
              <ArrowUp size={15} />
            </button>
            <code title={path}>{path}</code>
          </div>
          <div className="remote-file-actions">
            <button type="button" onClick={onCreateFolder}>
              <Folder size={15} />
              新建文件夹
            </button>
            <button type="button" onClick={() => uploadInputRef.current?.click()}>
              <Upload size={15} />
              上传
            </button>
            <input
              ref={uploadInputRef}
              hidden
              multiple
              type="file"
              onChange={(event) => void onUpload(event.target.files)}
            />
          </div>
        </div>
        <div className={`remote-file-list${loading ? " loading" : ""}`}>
          <div className="remote-file-list-head">
            <span>名称</span>
            <span>大小</span>
            <span>修改时间</span>
            <span />
          </div>
          {entries.map((entry) => (
            <div className="remote-file-row" key={entry.path}>
              <button
                className="remote-file-name"
                type="button"
                onClick={() =>
                  entry.type === "directory"
                    ? onOpen(entry.path)
                    : onDownload(entry.path)
                }
              >
                {entry.type === "directory" ? (
                  <Folder size={17} />
                ) : (
                  <File size={17} />
                )}
                <span>{entry.name}</span>
              </button>
              <span>{entry.type === "directory" ? "—" : formatBytes(entry.size)}</span>
              <span>
                {entry.modifiedAt
                  ? new Intl.DateTimeFormat("zh-CN", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(entry.modifiedAt))
                  : "—"}
              </span>
              <span>
                {entry.type === "file" && (
                  <button
                    type="button"
                    onClick={() => onDownload(entry.path)}
                    aria-label={`下载 ${entry.name}`}
                  >
                    <Download size={15} />
                  </button>
                )}
                {entry.type === "directory" && <ChevronRight size={15} />}
              </span>
            </div>
          ))}
          {!entries.length && !loading && (
            <div className="remote-file-empty">此文件夹为空</div>
          )}
          {loading && (
            <div className="remote-file-loading">
              <LoaderCircle className="spin" size={18} />
              正在读取
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function EmbeddingModal({
  settings,
  onClose,
  onSave,
}: {
  settings: AppSettings;
  onClose: () => void;
  onSave: (
    embedding: AppSettings["embedding"] & { apiKey?: string },
  ) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState({ ...settings.embedding, apiKey: "" });
  const [detectedModels, setDetectedModels] = useState<string[]>(
    settings.embedding.model ? [settings.embedding.model] : [],
  );
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState("");
  const detectModels = async () => {
    setDetecting(true);
    setDetectError("");
    try {
      const response = await gatewayFetch("/api/settings/embedding/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json()) as { models?: string[]; error?: string };
      if (!response.ok || !payload.models?.length) {
        throw new Error(payload.error || "没有检测到 Embedding 模型");
      }
      setDetectedModels(payload.models);
      setDraft((current) => ({
        ...current,
        model: payload.models?.includes(current.model)
          ? current.model
          : payload.models?.[0] ?? "",
        dimensions: "",
      }));
    } catch (caught) {
      setDetectError(caught instanceof Error ? caught.message : "模型检测失败");
    } finally {
      setDetecting(false);
    }
  };
  return (
    <Modal title="Embedding API" onClose={onClose}>
      <div className="modal-form embedding-form">
        <label className="field">
          <span>API URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
            placeholder={draft.configured ? "已保存；留空表示不修改" : "sk-…"}
          />
        </label>
        <div className="model-picker">
          <label className="field">
            <span>模型</span>
            <select
              value={draft.model}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  model: event.target.value,
                  dimensions: "",
                }))
              }
              disabled={!detectedModels.length}
            >
              {!detectedModels.length && <option value="">请先检测模型</option>}
              {detectedModels.map((model) => (
                <option value={model} key={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void detectModels()}
            disabled={detecting || !draft.baseUrl || (!draft.apiKey && !draft.configured)}
          >
            {detecting ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            {detecting ? "检测中" : "检测模型"}
          </button>
        </div>
        {detectError && <div className="form-error">{detectError}</div>}
        <div className="modal-actions">
          <button
            className="primary-button"
            type="button"
            disabled={!draft.baseUrl || !draft.model}
            onClick={() =>
              void onSave({
                baseUrl: draft.baseUrl,
                model: draft.model,
                dimensions: "",
                configured: Boolean(draft.apiKey || draft.configured),
                hybridEnabled: true,
                rerankEnabled: false,
                apiKey: draft.apiKey,
              })
            }
          >
            保存设置
          </button>
        </div>
      </div>
    </Modal>
  );
}
