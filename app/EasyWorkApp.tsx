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
  Copy,
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
  GitBranch,
  HardDrive,
  History,
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
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Mode = "chat" | "work";
type ViewName = "chat" | "project" | "library" | "skills" | "memory";
type StepStatus = "pending" | "running" | "done" | "error" | "cancelled";
type EventStatus = "pending" | "running" | "done" | "error" | "cancelled";
type WorkEventKind =
  | "message"
  | "agent_message"
  | "agent_reasoning"
  | "plan"
  | "tool_call"
  | "approval_request"
  | "file_change"
  | "job_status"
  | "artifact"
  | "error"
  | "reasoning"
  | "workspace_scope"
  | "connection"
  | "tool"
  | "terminal"
  | "result";

type WorkflowStep = {
  id: string;
  title: string;
  status: StepStatus;
};

type WorkEvent = {
  id: string;
  kind: WorkEventKind;
  title: string;
  detail?: string;
  output?: string;
  diff?: string;
  command?: string;
  path?: string;
  language?: string;
  approvalId?: string;
  approvalType?: "permission" | "question";
  retractFinal?: boolean;
  status: EventStatus;
  timestamp: string;
};

type RunTrace = {
  runId: string;
  status: "queued" | "running" | "done" | "error" | "aborted";
  steps: WorkflowStep[];
  result?: string;
  startedAt: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceKind?: "physical" | "virtual";
  dynamicWorkspace?: boolean;
  versionDomainId?: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  reasoningStatus?: "running" | "done" | "error";
  createdAt: string;
  mode: Mode;
  selectedSkills?: string[];
  trace?: RunTrace;
  events?: WorkEvent[];
  runId?: string;
  agentId?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceKind?: "physical" | "virtual";
  dynamicWorkspace?: boolean;
  appendedToRunId?: string;
};

type WorkspaceItem = {
  id: string;
  serverId: string;
  name: string;
  path: string;
  mode: "managed" | "attached" | "unmanaged";
  kind: "physical" | "virtual";
  virtualConversationId?: string;
  versionRoot?: string;
  versionDomainId?: string;
  writable: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
};

type Conversation = {
  id: string;
  title: string;
  mode: Mode;
  projectId?: string;
  pinned?: boolean;
  messages: Message[];
  updatedAt: string;
  branch?: {
    parentConversationId: string;
    parentMessageId: string;
    action: "branch";
    memorySnapshotSequence?: number;
    memorySnapshotVersionIds?: string[];
    createdAt: string;
  };
  work?: {
    agentId?: string;
    workspaceId?: string;
    workspaceName?: string;
    workspace?: string;
    workspaceMode?: "managed" | "attached" | "unmanaged";
    workspaceKind?: "physical" | "virtual";
    versionDomainId?: string;
    sourceCheckpointId?: string;
    serverId?: string;
    connectionEnabled?: boolean;
    workspaceHistory?: Array<{
      workspaceId: string;
      serverId: string;
      name: string;
      path: string;
      kind?: "physical" | "virtual";
      versionDomainId?: string;
      activatedAt: string;
    }>;
  };
};

type PendingVirtualWrite = {
  content: string;
  conversationId?: string;
  projectId?: string;
  requestedMode: "work";
  openChat?: boolean;
  target?: WorkspaceItem;
  suggestedPaths: string[];
};

function appearsToModifyRemoteState(content: string) {
  return /(?:创建|新建|写入|修改|编辑|替换|删除|移除|重命名|移动|复制|保存|生成|下载|上传|解压|安装|部署|配置|提交|回滚|清理|初始化|mkdir|touch|write|edit|patch|replace|delete|remove|rename|move|copy|save|generate|download|upload|extract|install|deploy|configure|commit|reset)/i.test(
    content,
  );
}

function remotePathSuggestions(content: string) {
  const matches = String(content || "").match(/(?:~\/|\/)[^\s，。；、,;：:）)\]}>"'`]+/g) || [];
  return [
    ...new Set(
      matches
        .map((value) => value.replace(/[。.,;；]+$/, ""))
        .filter((value) => !value.startsWith("//") && !value.includes("://")),
    ),
  ].slice(0, 4);
}

type Project = {
  id: string;
  name: string;
  icon: string;
  memoryMode: "project-and-global" | "project-only";
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
  scope: "user" | "project" | "conversation" | "workspace" | "task";
  scopeId?: string;
  projectId?: string;
  kind: "preference" | "profile" | "goal" | "workflow" | "fact" | "decision" | "constraint";
  source: string;
  confidence: number;
  enabled: boolean;
  portability?: string;
  authority?: string;
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
    modelContextLimit?: number;
    modelOutputLimit?: number;
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
  conversationCount?: number;
  activeTaskCount?: number;
};

type AgentItem = {
  id: string;
  name: string;
  folder?: string;
  path: string;
  version?: string;
  status: "ready" | "missing" | "installing";
  adapter: "opencode" | "codex" | "claude" | "plain";
  managed?: boolean;
  deployment?: "easywork" | "user";
  configured?: boolean;
  configPath?: string;
  dataPath?: string;
  model?: string;
  providerId?: string;
  contextLimit?: number;
  outputLimit?: number;
  hostVersion?: string;
  updateAvailable?: boolean;
  reasoningEffort?: string;
  permissionMode?: string;
  sandboxMode?: string;
  configurationSchema?: {
    reasoning?: { label: string; value: string; options: string[] };
    permission?: { label: string; value: string; options: string[] };
    sandbox?: { label: string; value: string; options: string[] };
  };
  detail?: string;
  capabilities?: {
    liveInput?: boolean;
    nativeAbort?: boolean;
    resumeSession?: boolean;
    nativePlanning?: boolean;
    workspaceCheckpoint?: boolean;
    contextReadable?: boolean;
    permissions?: boolean;
  };
};

type ContextUsage = {
  web: {
    used: number;
    limit: number;
    ratio: number;
    automaticCompressionThreshold: number;
    modifiable: boolean;
    compressible: boolean;
    breakdown: {
      messages: number;
      summary: number;
      memory: number;
      system: number;
      skills: number;
      knowledge: number;
      outputReserve: number;
    };
  };
  agent: {
    bound: boolean;
    readable: boolean;
    available: boolean;
    used: number | null;
    limit: number | null;
    ratio: number | null;
    modifiable: boolean;
    compressible: boolean;
    compressionSupported?: boolean;
    status: string;
    diagnostic?: string;
    model?: string;
    limitSource?: string;
    binding?: {
      serverId: string;
      agentId: string;
      agentSessionId: string;
      workspaceId?: string;
      workspaceName?: string;
      workspace: string;
      updatedAt: string;
    } | null;
  };
};

type ContextBusyAction =
  | "web-save"
  | "web-compress"
  | "agent-save"
  | "agent-compress"
  | null;

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
  agentId?: string;
  label?: string;
  error?: string;
};

type AgentRuntimeConfigState = {
  agentId: string;
  status: "idle" | "configuring";
  label?: string;
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

function conversationTitleNeedsRepair(title: string) {
  const value = String(title || "").trim();
  return (
    !value ||
    value === "新对话" ||
    /(?:生成|拟定|概括|总结).{0,8}(?:标题|题目)|(?:标题|题目).{0,6}(?:是|为)|根据.{0,16}(?:对话|请求|回答)|[。！？!?；;]/.test(
      value,
    )
  );
}

function repairConversationTitle(conversation: Conversation) {
  const firstPrompt = conversation.messages?.find(
    (message) => message.role === "user",
  )?.content;
  return firstPrompt && conversationTitleNeedsRepair(conversation.title)
    ? { ...conversation, title: fallbackConversationTitle(firstPrompt) }
    : conversation;
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

function mergeStoredState(
  current: EasyWorkState,
  incoming: Partial<EasyWorkState>,
): EasyWorkState {
  const incomingSettings = incoming.settings as Partial<AppSettings> | undefined;
  const servers = Array.isArray(incomingSettings?.servers)
    ? incomingSettings.servers
    : current.settings.servers;
  const conversations = Array.isArray(incoming.conversations)
    ? incoming.conversations
        .filter((conversation) => (conversation.messages?.length ?? 0) > 0)
        .map(repairConversationTitle)
    : current.conversations;
  const projects = Array.isArray(incoming.projects)
    ? incoming.projects
    : current.projects;
  const files = Array.isArray(incoming.files)
    ? incoming.files
    : current.files;
  const memories = Array.isArray(incoming.memories)
    ? incoming.memories
    : current.memories;

  return {
    ...current,
    ...incoming,
    projects,
    conversations,
    files,
    memories,
    memorySummary: incoming.memorySummary ?? current.memorySummary,
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
  {
    id: "codex",
    name: "Codex",
    folder: "~/.easywork/agents/codex",
    path: "~/.easywork/agents/codex/bin/codex",
    status: "missing",
    adapter: "codex",
    managed: true,
    configured: false,
  },
  {
    id: "claudecode",
    name: "Claude Code",
    folder: "~/.easywork/agents/claudecode",
    path: "~/.easywork/agents/claudecode/bin/claude",
    status: "missing",
    adapter: "claude",
    managed: true,
    configured: false,
  },
];

function dedupeAgents(items: AgentItem[]) {
  const result = new Map<string, AgentItem>();
  for (const item of items) {
    const key = item.id;
    const normalized = item;
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

function memoryItemFromApi(record: Record<string, unknown>): MemoryItem {
  const scope = ["user", "project", "conversation", "workspace", "task"].includes(
    String(record.scope || ""),
  )
    ? (String(record.scope) as MemoryItem["scope"])
    : "user";
  const scopeId = String(record.scopeId || "") || undefined;
  return {
    id: String(record.id || uid("memory")),
    content: String(record.content || ""),
    scope,
    scopeId,
    projectId: scope === "project" ? scopeId : undefined,
    kind: String(record.kind || "preference") as MemoryItem["kind"],
    source: String(record.source || "用户手动添加"),
    confidence: Number(record.confidence || 0),
    enabled: String(record.status || "active") !== "disabled",
    portability: String(record.portability || "") || undefined,
    authority: String(record.authority || "") || undefined,
    updatedAt: String(record.updatedAt || now()),
  };
}

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

const stripEasyWorkProtocolText = (value: string) => {
  let output = String(value || "").replace(
    /\[\[\s*EASYWORK_(?:FINAL|PROGRESS)\s*\]\]/gi,
    "",
  );
  const trimmed = output.trimEnd();
  for (const marker of ["[[EASYWORK_FINAL]]", "[[EASYWORK_PROGRESS]]"]) {
    for (let length = marker.length - 1; length >= 2; length -= 1) {
      const prefix = marker.slice(0, length);
      if (trimmed.endsWith(prefix)) {
        output = trimmed.slice(0, -prefix.length);
        return output.trimStart();
      }
    }
  }
  return output.trimStart();
};

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

function reactNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (isValidElement<{ children?: React.ReactNode }>(node)) {
    return reactNodeText(node.props.children);
  }
  return "";
}

async function copyPlainText(content: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = content;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function BlockCopyButton({
  content,
  label = "复制内容",
}: {
  content: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!String(content || "").trim()) return null;
  return (
    <button
      className={`block-copy-button${copied ? " copied" : ""}`}
      type="button"
      aria-label={copied ? "已复制" : label}
      title={copied ? "已复制" : label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyPlainText(content).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_400);
        });
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function MarkdownContent({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const normalizedContent = String(content || "").replace(
    /^(\s*(?:#{1,6}\s+.+|\*\*[^*\n]+\*\*|__[^_\n]+__))\r?\n(?=\s*\d+[.)]\s+)/gm,
    "$1\n\n",
  );
  const inlineTone = (value: string) => {
    let hash = 0;
    for (const character of value) {
      hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
    }
    return hash % 5;
  };
  const fencedCodeLanguage = (children: React.ReactNode) => {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string }>(child)) return "";
    return String(child.props.className || "")
      .match(/(?:^|\s)language-([^\s]+)/i)?.[1]
      ?.toLowerCase() || "";
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
          pre: ({ children }) => {
            const language = fencedCodeLanguage(children);
            const terminal = /^(?:bash|sh|shell|console|terminal|zsh|fish|powershell|pwsh|cmd)$/.test(
              language,
            );
            const languageLabel: Record<string, string> = {
              javascript: "JavaScript",
              js: "JavaScript",
              typescript: "TypeScript",
              ts: "TypeScript",
              python: "Python",
              py: "Python",
              json: "JSON",
              yaml: "YAML",
              yml: "YAML",
              toml: "TOML",
              css: "CSS",
              html: "HTML",
              jsx: "JSX",
              tsx: "TSX",
            };
            const source = reactNodeText(children).replace(/\n$/, "");
            return (
              <div className="copyable-code-block">
                <BlockCopyButton content={source} label="复制代码" />
                <pre
                  className={`remote-terminal markdown-terminal${
                    terminal ? " terminal-fence" : " code-fence"
                  }`}
                >
                  <span className="terminal-caption">
                    <i />
                    {terminal ? "终端" : languageLabel[language] || language || "代码"}
                  </span>
                  {children}
                </pre>
              </div>
            );
          },
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
              <BlockCopyButton
                content={reactNodeText(children)}
                label="复制表格内容"
              />
              <table>{children}</table>
            </div>
          ),
          blockquote: ({ children }) => (
            <blockquote className="copyable-quote-block">
              <BlockCopyButton
                content={reactNodeText(children)}
                label="复制引用内容"
              />
              {children}
            </blockquote>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

const formatContextTokens = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
};

const positiveContextLimit = (value: string | number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 8_000 && parsed <= 4_000_000;
};

const agentVersionText = (value?: string) => {
  const source = String(value || "").trim();
  const numeric = source.match(/(?:^|\s|v)(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)/i);
  return numeric?.[1] ? `v${numeric[1]}` : source;
};

const agentSettingOptionLabel = (value: string) =>
  (({
    default: "手动确认",
    minimal: "最低",
    low: "低",
    medium: "中等",
    high: "高",
    xhigh: "极高",
    max: "最大（本次会话）",
    ultracode: "深度编排（本次会话）",
    untrusted: "仅可信命令免确认",
    "on-request": "Agent 按需请求",
    never: "不请求确认",
    acceptEdits: "自动接受文件编辑",
    plan: "仅规划（只读）",
    auto: "自动模式（安全审查）",
    dontAsk: "仅使用预先批准的工具",
    bypassPermissions: "跳过权限检查（危险）",
    ask: "每次询问",
    allow: "全部允许",
    deny: "全部禁止",
    "read-only": "只读沙箱",
    "workspace-write": "工作区可写",
    "danger-full-access": "完全访问（无沙箱）",
  } as Record<string, string>)[value] || value);

const agentContextCacheKey = (
  conversationId: string,
  serverId: string,
  workspaceId: string,
  agentId: string,
) => `${conversationId}:${serverId}:${workspaceId}:${agentId}`;

function AgentContextRing({ usage }: { usage: ContextUsage["agent"] | null }) {
  const ratio = Math.max(0, Math.min(1, Number(usage?.ratio || 0)));
  return (
    <span
      className={`agent-context-ring${usage?.readable ? " readable" : " unreadable"}`}
      style={{ "--context-ratio": `${ratio * 100}%` } as React.CSSProperties}
      title={
        usage?.readable
          ? `Agent 上下文 ${Math.round(ratio * 100)}%`
          : "Agent 上下文无法读取"
      }
      aria-label={
        usage?.readable
          ? `Agent 上下文已使用 ${Math.round(ratio * 100)}%`
          : "Agent 上下文无法读取"
      }
    />
  );
}

function AgentContextControls({
  agent,
  usage,
  busyAction,
  onSave,
  onCompress,
}: {
  agent: AgentItem;
  usage: ContextUsage["agent"] | null;
  busyAction: ContextBusyAction;
  onSave: (limit: number) => Promise<void>;
  onCompress: () => Promise<void>;
}) {
  const [limit, setLimit] = useState(
    usage?.limit ? String(usage.limit) : agent.contextLimit ? String(agent.contextLimit) : "",
  );
  const modifiable = Boolean(agent.managed && (usage?.modifiable ?? true));
  const readable = Boolean(usage?.readable);
  const ratio = Math.max(0, Math.min(1, Number(usage?.ratio || 0)));
  const canSave =
    modifiable && positiveContextLimit(limit) && !Boolean(busyAction);
  const canCompress = Boolean(
    modifiable &&
      usage?.compressionSupported &&
      usage.compressible &&
      !busyAction,
  );
  return (
    <div className="agent-context-controls">
      <div className="agent-context-usage-row">
        <i aria-hidden="true">
          <b style={{ width: `${ratio * 100}%` }} />
        </i>
        <strong>
          {readable
            ? `${formatContextTokens(usage?.used)} / ${formatContextTokens(usage?.limit)}`
            : "无法读取"}
        </strong>
      </div>
      <div className="agent-context-action-row">
        <div className="agent-context-limit-control">
          <input
            type="number"
            min={8_000}
            max={4_000_000}
            step={1_000}
            disabled={!modifiable || Boolean(busyAction)}
            value={modifiable ? limit : ""}
            placeholder={
              modifiable
                ? "上下文上限"
                : "该 Agent 不支持修改上下文限制"
            }
            onChange={(event) => setLimit(event.target.value)}
          />
          <button
            type="button"
            title="保存上下文上限"
            aria-label="保存上下文上限"
            disabled={!canSave}
            onClick={() => void onSave(Number(limit))}
          >
            {busyAction === "agent-save" ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <Save size={13} />
            )}
          </button>
        </div>
        <button
          className="agent-context-compress"
          type="button"
          disabled={!canCompress}
          title={
            usage?.compressionSupported
              ? "压缩 Agent 原生上下文"
              : "该 Agent 不支持原生压缩"
          }
          onClick={() => void onCompress()}
        >
          {busyAction === "agent-compress" ? (
            <LoaderCircle className="spin" size={13} />
          ) : (
            <Database size={13} />
          )}
          压缩
        </button>
      </div>
    </div>
  );
}

function WebContextMeter({
  usage,
  loading,
  onOpen,
}: {
  usage: ContextUsage | null;
  loading: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={`context-meters single${loading ? " loading" : ""}`}
      aria-label="网页对话上下文占用"
    >
      <button
        className="context-meter-row web"
        type="button"
        onClick={onOpen}
        aria-label="查看网页对话上下文"
      >
        <span>网页对话</span>
        <i aria-hidden="true">
          <b
            style={{
              width: `${Math.max(
                0,
                Math.min(100, (usage?.web.ratio ?? 0) * 100),
              )}%`,
            }}
          />
        </i>
        <strong>
          {loading && !usage
            ? "读取中"
            : `${formatContextTokens(usage?.web.used ?? 0)} / ${formatContextTokens(
                usage?.web.limit ?? 200_000,
              )}`}
        </strong>
      </button>
    </div>
  );
}

function ContextDetailModal({
  usage,
  busyAction,
  onClose,
  onSaveWeb,
  onCompressWeb,
}: {
  usage: ContextUsage | null;
  busyAction: ContextBusyAction;
  onClose: () => void;
  onSaveWeb: (limit: number, threshold: number) => Promise<void>;
  onCompressWeb: () => Promise<void>;
}) {
  const [limit, setLimit] = useState(usage?.web.limit ?? 200_000);
  const [threshold, setThreshold] = useState(
    usage?.web.automaticCompressionThreshold ?? 0.95,
  );
  return (
    <Modal title="网页对话上下文" onClose={onClose} wide>
      <div className="context-dialog web-context-dialog">
        <section className="context-usage-hero web">
          <div className="context-usage-heading">
            <span className="context-usage-icon"><MessageCircle size={19} /></span>
            <div>
              <small>当前网页对话</small>
              <strong>{formatContextTokens(usage?.web.used)} / {formatContextTokens(usage?.web.limit)}</strong>
            </div>
            <em>{Math.round((usage?.web.ratio ?? 0) * 100)}%</em>
          </div>
          <div className="context-dialog-progress web" aria-hidden="true">
            <i style={{ width: `${Math.min(100, (usage?.web.ratio ?? 0) * 100)}%` }} />
          </div>
        </section>

        <section className="context-dialog-section">
          <header><strong>占用组成</strong></header>
          <dl className="context-breakdown context-breakdown-grid">
            <div><dt>消息</dt><dd>{formatContextTokens(usage?.web.breakdown.messages)}</dd></div>
            <div><dt>摘要</dt><dd>{formatContextTokens(usage?.web.breakdown.summary)}</dd></div>
            <div><dt>记忆</dt><dd>{formatContextTokens(usage?.web.breakdown.memory)}</dd></div>
            <div><dt>系统提示</dt><dd>{formatContextTokens(usage?.web.breakdown.system)}</dd></div>
            <div><dt>技能</dt><dd>{formatContextTokens(usage?.web.breakdown.skills)}</dd></div>
            <div><dt>知识片段</dt><dd>{formatContextTokens(usage?.web.breakdown.knowledge)}</dd></div>
            <div><dt>回复预留</dt><dd>{formatContextTokens(usage?.web.breakdown.outputReserve)}</dd></div>
          </dl>
        </section>

        <section className="context-dialog-section context-settings-section">
          <header>
            <div>
              <strong>压缩设置</strong>
              <small>只调整网页对话，不改动 Agent 原生会话。</small>
            </div>
          </header>
          <div className="context-settings-grid">
            <label className="context-setting-field">
              <span>上下文上限</span>
              <input
                type="number"
                min={8_000}
                max={2_000_000}
                step={1_000}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              />
            </label>
            <label className="context-setting-field">
              <span>自动压缩阈值</span>
              <input
                type="number"
                min={0.5}
                max={1}
                step={0.01}
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
            </label>
          </div>
        </section>
        <div className="context-dialog-actions">
          <button
            type="button"
            disabled={Boolean(busyAction)}
            onClick={() => void onSaveWeb(limit, threshold)}
          >
            {busyAction === "web-save" ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Save size={14} />
            )}
            {busyAction === "web-save" ? "配置中" : "保存设置"}
          </button>
          <button
            className="primary"
            type="button"
            disabled={Boolean(busyAction) || !usage?.web.compressible}
            onClick={() => void onCompressWeb()}
          >
            {busyAction === "web-compress" ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Database size={14} />
            )}
            {busyAction === "web-compress" ? "压缩中" : "压缩对话"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  titleNote,
  headerAction,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  titleNote?: string;
  headerAction?: React.ReactNode;
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
          <div className={`modal-title-copy${titleNote ? " with-note" : ""}`}>
            <h2>{title}</h2>
            {titleNote && <small>{titleNote}</small>}
          </div>
          <div className="modal-header-actions">
            {headerAction}
            <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
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
  if (status === "cancelled") {
    return (
      <span className="step-glyph cancelled">
        <Square size={8} />
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
  if (kind === "result") return "agent_message";
  return kind;
}

function eventStatusLabel(status: EventStatus | StepStatus) {
  if (status === "running") return "正在进行";
  if (status === "done") return "已完成";
  if (status === "error") return "失败";
  if (status === "cancelled") return "已取消";
  return "等待";
}

function EventGlyph({ event }: { event: WorkEvent }) {
  const kind = normalizedEventKind(event.kind);
  if (event.status === "running") return <LoaderCircle size={14} />;
  if (event.status === "error" || kind === "error") return <X size={13} />;
  if (event.status === "cancelled") return <Square size={9} />;
  if (kind === "plan") return <Activity size={14} />;
  if (kind === "approval_request") return <ShieldCheck size={14} />;
  if (kind === "file_change") return <FileText size={14} />;
  if (kind === "job_status") return <Gauge size={14} />;
  if (kind === "artifact") return <FileArchive size={14} />;
  if (kind === "reasoning") return <Brain size={14} />;
  if (kind === "agent_reasoning") return <Brain size={14} />;
  if (kind === "connection") return <Network size={14} />;
  if (kind === "workspace_scope") return <GitBranch size={14} />;
  if (kind === "message" || kind === "agent_message") {
    return <MessageCircle size={14} />;
  }
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
        <ChevronRight className="reasoning-chevron" size={13} />
      </button>
      <div className="reasoning-motion">
        <div>
          <div className="reasoning-content">
            {content ? (
              <>
                <BlockCopyButton content={content} label="复制思考内容" />
                <MarkdownContent content={content} compact />
              </>
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
  const [expanded, setExpanded] = useState(false);
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
          ) : event.status === "cancelled" ? (
            <Square size={8} />
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
          <div className="copyable-terminal-block">
            <BlockCopyButton
              content={`$ ${command}${event.output ? `\n${event.output}` : ""}`}
              label="复制命令和输出"
            />
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
      </div>
    </article>
  );
}

function CommandEventGroup({ events }: { events: WorkEvent[] }) {
  const running = events.some((event) => event.status === "running");
  const failed = events.some((event) => event.status === "error");
  const [groupExpanded, setGroupExpanded] = useState(false);
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

function diffLineTone(line: string) {
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

function DiffView({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  return (
    <div className="file-diff" aria-label="文件修改差异">
      <BlockCopyButton content={content} label="复制 Diff" />
      <div className="file-diff-caption">
        <Code2 size={13} />
        <span>Diff</span>
      </div>
      <div className="file-diff-lines">
        {lines.map((line, index) => (
          <div className={`file-diff-line ${diffLineTone(line)}`} key={`${index}-${line}`}>
            <span className="file-diff-number">{index + 1}</span>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function mergeAdjacentFileEvents(events: WorkEvent[]) {
  const merged = new Map<string, WorkEvent>();
  for (const event of events) {
    const key = event.path || event.title || event.id;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, event);
      continue;
    }
    merged.set(key, {
      ...previous,
      ...event,
      id: previous.id,
      diff:
        previous.diff && event.diff && previous.diff !== event.diff
          ? `${previous.diff}\n\n${event.diff}`
          : event.diff || previous.diff,
      output: event.output || previous.output,
      status:
        previous.status === "error" || event.status === "error"
          ? "error"
          : previous.status === "running" || event.status === "running"
            ? "running"
            : "done",
    });
  }
  return [...merged.values()];
}

function FileChangeItem({ event }: { event: WorkEvent }) {
  const [expanded, setExpanded] = useState(false);
  const fileName = event.path?.split(/[\\/]/).filter(Boolean).at(-1) || event.title;
  const panelId = `file-change-${event.id}`;
  return (
    <article className={`file-change-item ${event.status}${expanded ? " expanded" : ""}`}>
      <button
        className="file-change-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="file-change-status">
          {event.status === "running" ? (
            <LoaderCircle size={13} />
          ) : event.status === "error" ? (
            <X size={12} />
          ) : event.status === "cancelled" ? (
            <Square size={8} />
          ) : (
            <FileText size={13} />
          )}
        </span>
        <span className="file-change-copy">
          <strong title={fileName}>{fileName}</strong>
          {event.path && <small title={event.path}>{event.path}</small>}
        </span>
        <ChevronRight className="file-change-chevron" size={13} />
      </button>
      <div className="file-change-detail-motion" id={panelId}>
        <div>
          <div className="file-change-detail">
            {!event.diff && event.output && (
              <BlockCopyButton content={event.output} label="复制文件修改内容" />
            )}
            {event.diff ? (
              <DiffView content={event.diff} />
            ) : event.output ? (
              <pre className="file-change-raw">{event.output}</pre>
            ) : (
              <p className="file-change-empty">Agent 未返回可显示的差异内容。</p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function FileChangeGroup({ events }: { events: WorkEvent[] }) {
  const files = mergeAdjacentFileEvents(events);
  const running = files.some((event) => event.status === "running");
  const failed = files.some((event) => event.status === "error");
  const [expanded, setExpanded] = useState(false);
  const label = running
    ? `正在编辑 ${files.length} 个文件`
    : `已编辑 ${files.length} 个文件`;
  return (
    <section
      className={`file-change-group${running ? " running" : ""}${
        failed ? " error" : ""
      }${expanded ? " expanded" : ""}`}
    >
      <button
        className="file-change-group-heading"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="file-change-group-glyph">
          {running ? <LoaderCircle size={14} /> : failed ? <X size={13} /> : <FileText size={14} />}
        </span>
        <strong>{label}</strong>
        <span>{failed ? "部分编辑失败" : "远程文件"}</span>
        <ChevronRight className="file-change-group-chevron" size={13} />
      </button>
      <div className="file-change-list-motion">
        <div className="file-change-list">
          {files.map((event) => (
            <FileChangeItem event={event} key={event.id} />
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentEventRow({
  event,
  onApproval,
  workflowSteps,
}: {
  event: WorkEvent;
  onApproval?: (
    event: WorkEvent,
    approved: boolean,
    answers?: string[][],
  ) => void;
  workflowSteps?: WorkflowStep[];
}) {
  const kind = normalizedEventKind(event.kind);
  const autoOpen = kind === "approval_request" && event.status === "pending";
  const [expanded, setExpanded] = useAutoDisclosure(autoOpen);
  const questionItems = useMemo(() => {
    if (event.approvalType !== "question") return [];
    try {
      const parsed = JSON.parse(String(event.output || "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [event.approvalType, event.output]);
  const [questionAnswers, setQuestionAnswers] = useState<string[]>(() =>
    questionItems.map(() => ""),
  );
  const disclosable = Boolean(
    event.detail ||
      event.path ||
      event.output ||
      (kind === "plan" && workflowSteps?.length) ||
      (kind === "approval_request" && event.status === "pending"),
  );
  const completedPlanSteps =
    kind === "plan"
      ? (workflowSteps ?? []).filter((step) =>
          ["done", "cancelled"].includes(step.status),
        ).length
      : 0;
  const planStatusLabel =
    event.status === "error"
      ? "执行失败"
      : workflowSteps?.length && completedPlanSteps === workflowSteps.length
        ? "已完成"
        : workflowSteps?.length
          ? `${completedPlanSteps} / ${workflowSteps.length}`
          : "";
  const detailCopyContent =
    kind === "plan" && workflowSteps?.length
      ? workflowSteps
          .map((step) => `${eventStatusLabel(step.status)} · ${step.title}`)
          .join("\n")
      : [event.path, event.output].filter(Boolean).join("\n\n");
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
        <span className="agent-event-status">
          {kind === "plan"
            ? planStatusLabel
            : eventStatusLabel(event.status)}
        </span>
        {disclosable && <ChevronRight className="agent-event-chevron" size={13} />}
      </button>
      {disclosable && (
        <div className="agent-event-detail-motion">
          <div>
            <div className="agent-event-detail">
              {detailCopyContent && (
                <BlockCopyButton
                  content={detailCopyContent}
                  label="复制事件内容"
                />
              )}
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
                      </span>
                    </div>
                  ))}
                </div>
              ) : event.output && event.approvalType !== "question" ? (
                <div className="agent-event-output">
                  <MarkdownContent content={event.output} compact />
                </div>
              ) : null}
              {kind === "approval_request" &&
                event.status === "pending" &&
                onApproval && (
                  event.approvalType === "question" ? (
                    <div className="approval-question-form">
                      {questionItems.map((question, index) => (
                        <label key={String(question?.header || index)}>
                          <span>
                            {String(
                              question?.question ||
                                question?.header ||
                                `问题 ${index + 1}`,
                            )}
                          </span>
                          <input
                            value={questionAnswers[index] || ""}
                            placeholder="输入回答"
                            onChange={(changeEvent) =>
                              setQuestionAnswers((current) => {
                                const next = [...current];
                                next[index] = changeEvent.target.value;
                                return next;
                              })
                            }
                          />
                        </label>
                      ))}
                      {!questionItems.length && (
                        <label>
                          <span>{event.title}</span>
                          <input
                            value={questionAnswers[0] || ""}
                            placeholder="输入回答"
                            onChange={(changeEvent) =>
                              setQuestionAnswers([changeEvent.target.value])
                            }
                          />
                        </label>
                      )}
                      <div className="approval-actions">
                        <button type="button" onClick={() => onApproval(event, false)}>
                          跳过
                        </button>
                        <button
                          type="button"
                          disabled={!questionAnswers.some((answer) => answer.trim())}
                          onClick={() =>
                            onApproval(
                              event,
                              true,
                              questionAnswers.map((answer) => [answer.trim()]),
                            )
                          }
                        >
                          回答
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="approval-actions">
                      <button type="button" onClick={() => onApproval(event, false)}>
                        拒绝
                      </button>
                      <button type="button" onClick={() => onApproval(event, true)}>
                        允许
                      </button>
                    </div>
                  )
                )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function AgentThoughtEvent({ event }: { event: WorkEvent }) {
  const content = stripEasyWorkProtocolText(
    String(event.output || event.detail || ""),
  ).trim();
  if (!content) return null;
  return (
    <section
      className={`agent-thought-event ${event.status}`}
      aria-label="Agent 中间输出"
    >
      <div className="agent-thought-content">
        <BlockCopyButton content={content} label="复制 Agent 输出" />
        <MarkdownContent content={content} compact />
      </div>
    </section>
  );
}

function WorkEventFeed({
  events,
  onApproval,
  runStatus,
  workflowSteps,
  finalAnswerStarted = false,
}: {
  events: WorkEvent[];
  onApproval?: (
    event: WorkEvent,
    approved: boolean,
    answers?: string[][],
  ) => void;
  runStatus?: RunTrace["status"];
  workflowSteps?: WorkflowStep[];
  finalAnswerStarted?: boolean;
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
    .filter((event) => {
      const kind = normalizedEventKind(event.kind);
      if (kind === "plan") return Boolean(workflowSteps?.length);
      if (!["agent_message", "agent_reasoning"].includes(kind)) return true;
      return Boolean(String(event.output || event.detail || "").trim());
    })
    .map((event) =>
      event.status === "running" &&
      (runStatus === "done" ||
        runStatus === "error" ||
        runStatus === "aborted")
        ? {
            ...event,
            status:
              runStatus === "done"
                ? ("done" as const)
                : runStatus === "aborted"
                  ? ("cancelled" as const)
                  : ("error" as const),
          }
        : event,
    );
  const segments: Array<
    | { type: "commands"; id: string; events: WorkEvent[] }
    | { type: "files"; id: string; events: WorkEvent[] }
    | { type: "event"; id: string; event: WorkEvent }
  > = [];

  for (const event of visibleEvents) {
    if (normalizedEventKind(event.kind) === "file_change") {
      const previous = segments.at(-1);
      if (previous?.type === "files") {
        previous.events.push(event);
      } else {
        segments.push({ type: "files", id: event.id, events: [event] });
      }
    } else if (normalizedEventKind(event.kind) === "tool_call" || event.command) {
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

  const callRunning =
    runStatus === "running" ||
    visibleEvents.some((event) => event.status === "running");
  const callFailed =
    runStatus === "error" ||
    (!runStatus && visibleEvents.some((event) => event.status === "error"));
  const callAborted = runStatus === "aborted";
  const [expanded, setExpanded] = useAutoDisclosure(
    Boolean(segments.length) && callRunning && !finalAnswerStarted,
  );
  const hasDetails = segments.length > 0;

  return (
    <section
      className={`agent-call ${expanded ? "expanded" : ""}${
        callRunning ? " running" : ""
      }${callFailed ? " error" : ""}${callAborted ? " aborted" : ""}${hasDetails ? " has-details" : " no-details"}`}
    >
      <button
        className="agent-call-heading"
        type="button"
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={() => hasDetails && setExpanded((current) => !current)}
      >
        <span className="agent-call-glyph">
          {callRunning ? (
            <LoaderCircle size={14} />
          ) : callFailed ? (
            <X size={13} />
          ) : (
            <Bot size={14} />
          )}
        </span>
        <strong>
          {callRunning
            ? "Agent调用中"
            : callAborted
              ? "Agent调用已停止"
            : callFailed
              ? "Agent调用失败"
              : "Agent调用完成"}
        </strong>
        {hasDetails && <ChevronRight className="agent-call-chevron" size={13} />}
      </button>
      {hasDetails && (
        <div className="agent-call-motion">
          <div>
            <div className="agent-activity" aria-label="Agent 调用过程">
              {segments.map((segment) =>
                segment.type === "commands" ? (
                  <CommandEventGroup events={segment.events} key={segment.id} />
                ) : segment.type === "files" ? (
                  <FileChangeGroup events={segment.events} key={segment.id} />
                ) : ["agent_message", "agent_reasoning"].includes(
                    normalizedEventKind(segment.event.kind),
                  ) ? (
                  <AgentThoughtEvent event={segment.event} key={segment.id} />
                ) : (
                  <AgentEventRow
                    event={segment.event}
                    key={segment.id}
                    onApproval={onApproval}
                    workflowSteps={workflowSteps}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </section>
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

function useAnchoredMenuPosition(
  open: boolean,
  estimatedWidth = 214,
  estimatedHeight = 220,
) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    ready: false,
  });

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const menuWidth = menuRef.current?.offsetWidth || estimatedWidth;
      const menuHeight = menuRef.current?.offsetHeight || estimatedHeight;
      const below = rect.bottom + 4;
      const top =
        below + menuHeight <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - menuHeight - 4);
      const left = Math.max(
        8,
        Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8),
      );
      setPosition({ left, top, ready: true });
    };
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [estimatedHeight, estimatedWidth, open]);

  return { anchorRef, menuRef, position };
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
  const {
    anchorRef: menuButtonRef,
    menuRef,
    position: menuPosition,
  } = useAnchoredMenuPosition(menuOpen);

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
      <span className={`conversation-work-mark ${conversation.mode}`}>
        {conversation.mode === "work" ? "工作" : "聊天"}
      </span>
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

function ProjectOptionsMenu({
  project,
  menuOpen,
  onToggleMenu,
  onRename,
  onSettings,
  onOpenHome,
  onTogglePin,
  onDelete,
}: {
  project: Project;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onRename: () => void;
  onSettings: () => void;
  onOpenHome: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const {
    anchorRef: menuButtonRef,
    menuRef,
    position: menuPosition,
  } = useAnchoredMenuPosition(menuOpen, 204, 214);

  return (
    <>
      <button
        ref={menuButtonRef}
        className="project-more-button"
        type="button"
        aria-label={`打开“${project.name}”的项目选项`}
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
            className="conversation-menu conversation-menu-portal project-menu project-menu-portal"
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
              重命名项目
            </button>
            <button type="button" role="menuitem" onClick={onSettings}>
              <Settings2 size={15} />
              项目设置
            </button>
            <button type="button" role="menuitem" onClick={onOpenHome}>
              <Home size={15} />
              项目主页
            </button>
            <button type="button" role="menuitem" onClick={onTogglePin}>
              {project.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              {project.pinned ? "取消置顶" : "置顶项目"}
            </button>
            <button
              className="danger"
              type="button"
              role="menuitem"
              onClick={onDelete}
            >
              <Trash2 size={15} />
              删除项目
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

function UnifiedComposer({
  value,
  placeholder,
  disabled = false,
  sending = false,
  allowSubmitWhileSending = false,
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
  allowSubmitWhileSending?: boolean;
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
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeTextareaRef = textareaRef ?? localTextareaRef;
  const [multiline, setMultiline] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPage, setMenuPage] = useState<"root" | "skills">("root");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const enabledSkills = skills.filter((skill) => skill.enabled);
  const skillMenuHeight = Math.min(54 + Math.max(enabledSkills.length, 1) * 52, 314);

  useLayoutEffect(() => {
    const textarea = activeTextareaRef.current;
    if (!textarea) return;
    const minimumHeight = 30;
    const maximumHeight = 140;
    textarea.style.height = "0px";
    const nextHeight = Math.min(
      maximumHeight,
      Math.max(minimumHeight, textarea.scrollHeight),
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maximumHeight ? "auto" : "hidden";
    setMultiline((current) => {
      const next = nextHeight > minimumHeight;
      return current === next ? current : next;
    });
  }, [activeTextareaRef, value]);

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
    <div
      className={`unified-composer${sending ? " busy" : ""}${
        multiline ? " multiline" : ""
      }`}
    >
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
        ref={activeTextareaRef}
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
      {sending && allowSubmitWhileSending ? (
        <div className="composer-running-actions">
          <button
            className="unified-stop-button"
            type="button"
            onClick={onStop}
            aria-label="停止"
            title="停止当前任务"
          >
            <Square size={11} fill="currentColor" />
          </button>
          <button
            className="unified-send-button"
            type="button"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            aria-label="追加指令"
            title="追加到当前任务"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      ) : sending ? (
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
  const [manualAgentPickerOpen, setManualAgentPickerOpen] = useState(false);
  const [manualAgentBrowsePath, setManualAgentBrowsePath] = useState("~");
  const [manualAgentBrowseHome, setManualAgentBrowseHome] = useState("");
  const [manualAgentBrowseParent, setManualAgentBrowseParent] = useState<
    string | null
  >(null);
  const [manualAgentBrowseEntries, setManualAgentBrowseEntries] = useState<
    RemoteFileEntry[]
  >([]);
  const [manualAgentBrowseLoading, setManualAgentBrowseLoading] =
    useState(false);
  const [uninstallingAgentId, setUninstallingAgentId] = useState("");
  const [agentPendingUninstall, setAgentPendingUninstall] =
    useState<AgentItem | null>(null);
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
  const [agentRuntimeConfig, setAgentRuntimeConfig] =
    useState<AgentRuntimeConfigState>({ agentId: "", status: "idle" });
  const [agentUpdateModalOpen, setAgentUpdateModalOpen] = useState(false);
  const [fileManagerOpen, setFileManagerOpen] = useState(false);
  const [remoteFilePath, setRemoteFilePath] = useState("~");
  const [remoteFileHome, setRemoteFileHome] = useState("");
  const [remoteFileParent, setRemoteFileParent] = useState<string | null>(null);
  const [remoteFiles, setRemoteFiles] = useState<RemoteFileEntry[]>([]);
  const [remoteFilesLoading, setRemoteFilesLoading] = useState(false);
  const [draftWorkspace, setDraftWorkspace] = useState<WorkspaceItem | null>(
    null,
  );
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspacePickerPurpose, setWorkspacePickerPurpose] = useState<
    "conversation" | "dynamic"
  >("conversation");
  const [workspacePickerLoading, setWorkspacePickerLoading] = useState(false);
  const [workspaceBrowsePath, setWorkspaceBrowsePath] = useState("~");
  const [workspaceBrowseHome, setWorkspaceBrowseHome] = useState("");
  const [workspaceBrowseParent, setWorkspaceBrowseParent] = useState<
    string | null
  >(null);
  const [workspaceBrowseEntries, setWorkspaceBrowseEntries] = useState<
    RemoteFileEntry[]
  >([]);
  const [workspaceSwitchPending, setWorkspaceSwitchPending] =
    useState<WorkspaceItem | null>(null);
  const [workspaceSwitchBusy, setWorkspaceSwitchBusy] = useState(false);
  const [pendingVirtualWrite, setPendingVirtualWrite] =
    useState<PendingVirtualWrite | null>(null);
  const [dynamicWorkspaceBusy, setDynamicWorkspaceBusy] = useState(false);
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
  const [appLoading, setAppLoading] = useState(true);
  const [gatewayProbe, setGatewayProbe] = useState(0);
  const [deviceToken, setDeviceToken] = useState("");
  const [agentsByServer, setAgentsByServer] = useState<Record<string, AgentItem[]>>({});
  const [agentScanningByServer, setAgentScanningByServer] = useState<
    Record<string, boolean>
  >({});
  const [activeAgentByServer, setActiveAgentByServer] = useState<
    Record<string, string>
  >({});
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [memoryFilter, setMemoryFilter] = useState<
    "all" | MemoryItem["scope"]
  >("all");
  const [memoryInstruction, setMemoryInstruction] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState("");
  const [editingMemoryText, setEditingMemoryText] = useState("");
  const [conversationMenuId, setConversationMenuId] = useState("");
  const [projectMenuId, setProjectMenuId] = useState("");
  const [conversationPendingDelete, setConversationPendingDelete] =
    useState<Conversation | null>(null);
  const [conversationEditor, setConversationEditor] =
    useState<Conversation | null>(null);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingMessageText, setEditingMessageText] = useState("");
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [providerModelsError, setProviderModelsError] = useState("");
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [agentContextById, setAgentContextById] = useState<
    Record<string, ContextUsage["agent"]>
  >({});
  const [contextLoading, setContextLoading] = useState(false);
  const [contextBusyAction, setContextBusyAction] =
    useState<ContextBusyAction>(null);
  const [contextModalOpen, setContextModalOpen] = useState(false);

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
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesPinnedToBottomRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const projectFileInputRef = useRef<HTMLInputElement | null>(null);
  const skillInputRef = useRef<HTMLInputElement | null>(null);
  const skillFolderInputRef = useRef<HTMLInputElement | null>(null);
  const remoteUploadInputRef = useRef<HTMLInputElement | null>(null);
  const contextRequestSerialRef = useRef(0);
  const pendingServerBindingRef = useRef<{
    conversationId: string;
    serverId: string;
  } | null>(null);
  const draftConversationIdRef = useRef("");

  const activeConversation = useMemo(
    () => state.conversations.find((item) => item.id === activeConversationId),
    [activeConversationId, state.conversations],
  );
  const lastUserMessageId = useMemo(
    () =>
      [...(activeConversation?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.id || "",
    [activeConversation?.messages],
  );
  const lastAssistantMessageId = useMemo(
    () =>
      [...(activeConversation?.messages ?? [])]
        .reverse()
        .find((message) => message.role === "assistant")?.id || "",
    [activeConversation?.messages],
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
  const pooledConnection: ConnectionState = connections[effectiveServerId] ?? {
    serverId: effectiveServerId,
    status: "disconnected",
    label: "尚未连接远程服务器",
    host: state.settings.servers.find((profile) => profile.id === effectiveServerId)?.host,
    username: state.settings.servers.find(
      (profile) => profile.id === effectiveServerId,
    )?.username,
  };
  const conversationConnectionEnabled =
    activeConversation?.work?.connectionEnabled !== false;
  const connection: ConnectionState =
    mode === "work" &&
    activeConversation?.work?.serverId &&
    !conversationConnectionEnabled
      ? {
          ...pooledConnection,
          status: "disconnected",
          label: "此对话已断开远程服务器",
        }
      : pooledConnection;
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
  const activeAgentScanning = Boolean(
    effectiveServerId && agentScanningByServer[effectiveServerId],
  );
  const activeAgentUpdate = agentUpdatesByServer[effectiveServerId] ?? {
    status: "idle",
  };
  const activeAgentModelConfig = agentModelsByServer[effectiveServerId] ?? {
    status: "idle",
  };
  const configAgent =
    agents.find((item) => item.id === agentConfigAgentId) || activeAgent;
  const agentNativeSettingCount = Object.values(
    configAgent?.configurationSchema || {},
  ).filter((descriptor) => descriptor?.options?.length).length;
  const agentConfigMenuHeight =
    18 +
    43 +
    (configAgent?.managed ? 108 : 0) +
    agentNativeSettingCount * 48 +
    (configAgent?.status === "ready" ? 82 : 0) +
    (configAgent?.managed && configAgent.status === "ready" ? 34 : 0);
  const activeServerProfile = state.settings.servers.find(
    (profile) => profile.id === effectiveServerId,
  );
  const activeWorkspace = useMemo<WorkspaceItem | null>(() => {
    if (
      activeConversation?.work?.workspaceId &&
      activeConversation.work.workspace &&
      activeConversation.work.serverId
    ) {
      return {
        id: activeConversation.work.workspaceId,
        serverId: activeConversation.work.serverId,
        name:
          activeConversation.work.workspaceName ||
          activeConversation.work.workspace.split("/").filter(Boolean).at(-1) ||
          "工作区",
        path: activeConversation.work.workspace,
        mode: activeConversation.work.workspaceMode || "unmanaged",
        kind: activeConversation.work.workspaceKind || "physical",
        versionDomainId: activeConversation.work.versionDomainId,
        writable: true,
        createdAt: "",
        updatedAt: activeConversation.updatedAt,
        lastUsedAt: activeConversation.updatedAt,
      };
    }
    if (draftWorkspace?.serverId === effectiveServerId) return draftWorkspace;
    if (mode !== "work") return null;
    return {
      id: "",
      serverId: effectiveServerId,
      name: "虚拟工作区",
      path: "",
      mode: "managed",
      kind: "virtual",
      writable: true,
      createdAt: "",
      updatedAt: "",
      lastUsedAt: "",
    };
  }, [activeConversation, draftWorkspace, effectiveServerId, mode]);
  const workReady =
    mode !== "work" ||
    (connection.status === "connected" &&
      Boolean(activeWorkspace?.id || activeWorkspace?.kind === "virtual") &&
      activeAgent?.status === "ready" &&
      Boolean(activeAgent.configured));
  const activeRunningUserMessage = useMemo(
    () =>
      [...(activeConversation?.messages ?? [])]
        .reverse()
        .find(
          (message) =>
            message.role === "user" && message.trace?.status === "running",
        ),
    [activeConversation?.messages],
  );
  const activeRunningAssistant = useMemo(
    () =>
      activeRunningUserMessage?.runId
        ? activeConversation?.messages.find(
            (message) =>
              message.role === "assistant" &&
              message.runId === activeRunningUserMessage.runId,
          )
        : undefined,
    [activeConversation?.messages, activeRunningUserMessage],
  );
  const activeRunningAgent =
    agents.find((agent) => agent.id === activeRunningAssistant?.agentId) ||
    activeAgent;
  const activeWorkSending =
    mode === "work" && Boolean(activeRunningUserMessage?.runId);
  const canAppendToActiveRun = Boolean(
    activeWorkSending && activeRunningAgent?.capabilities?.liveInput,
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const loadContextUsage = useCallback(async (
    conversationId: string,
    serverId: string,
    agentId: string,
    workspaceId: string,
    agentAdapter = "",
  ) => {
    const requestSerial = ++contextRequestSerialRef.current;
    if (!conversationId) {
      setContextUsage(null);
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    try {
      const query = new URLSearchParams({
        conversationId,
      });
      if (serverId) query.set("serverId", serverId);
      if (agentId) query.set("agentId", agentId);
      if (workspaceId) query.set("workspaceId", workspaceId);
      if (agentAdapter) query.set("agentAdapter", agentAdapter);
      const response = await gatewayFetch(`/api/context?${query.toString()}`);
      const payload = (await response.json().catch(() => ({}))) as
        | ContextUsage
        | { error?: string };
      if (!response.ok || !("web" in payload)) {
        throw new Error("error" in payload ? payload.error : "读取上下文失败");
      }
      if (contextRequestSerialRef.current === requestSerial) {
        setContextUsage(payload);
        if (agentId) {
          setAgentContextById((current) => ({
            ...current,
            [agentContextCacheKey(
              conversationId,
              serverId,
              workspaceId,
              agentId,
            )]: payload.agent,
          }));
        }
      }
    } catch {
      if (contextRequestSerialRef.current === requestSerial) {
        setContextUsage(null);
      }
    } finally {
      if (contextRequestSerialRef.current === requestSerial) {
        setContextLoading(false);
      }
    }
  }, []);

  const loadAgentContextForMenu = useCallback(
    async (agent: AgentItem) => {
      if (!activeConversationId || !effectiveServerId) return;
      try {
        const query = new URLSearchParams({
          conversationId: activeConversationId,
          serverId: effectiveServerId,
          agentId: agent.id,
          agentAdapter: agent.adapter,
        });
        if (activeWorkspace?.id) query.set("workspaceId", activeWorkspace.id);
        const response = await gatewayFetch(`/api/context?${query.toString()}`);
        const payload = (await response.json().catch(() => ({}))) as
          | ContextUsage
          | { error?: string };
        if (!response.ok || !("agent" in payload)) return;
        setAgentContextById((current) => ({
          ...current,
          [agentContextCacheKey(
            activeConversationId,
            effectiveServerId,
            activeWorkspace?.id || "",
            agent.id,
          )]: payload.agent,
        }));
      } catch {
        // The menu keeps the last measured value when a refresh is unavailable.
      }
    }, [activeConversationId, activeWorkspace, effectiveServerId],
  );

  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    const refresh = () =>
      void loadContextUsage(
        activeConversationId,
        effectiveServerId,
        activeAgentId,
        activeWorkspace?.id || "",
        activeAgent?.adapter || "",
      );
    const initialTimer = window.setTimeout(refresh, 0);
    const pollingTimer = sending
      ? window.setInterval(refresh, 3_000)
      : undefined;
    return () => {
      window.clearTimeout(initialTimer);
      if (pollingTimer !== undefined) window.clearInterval(pollingTimer);
    };
  }, [
    activeAgentId,
    activeAgent?.adapter,
    activeConversationId,
    activeWorkspace?.id,
    effectiveServerId,
    gatewayStatus,
    loadContextUsage,
    sending,
  ]);

  const saveContextSettings = async (limit: number, threshold: number) => {
      setContextBusyAction("web-save");
      try {
        const response = await gatewayFetch("/api/context/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: activeConversationId,
            conversationLimit: limit,
            automaticCompressionThreshold: threshold,
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          autoCompression?: {
            triggered?: boolean;
            compressed?: boolean;
            error?: string;
          };
        };
        if (!response.ok) throw new Error(payload.error || "保存上下文设置失败");
        await loadContextUsage(
          activeConversationId,
          effectiveServerId,
          activeAgentId,
          activeWorkspace?.id || "",
          activeAgent?.adapter || "",
        );
        showToast(
          payload.autoCompression?.error
            ? `设置已保存；自动压缩失败：${payload.autoCompression.error}`
            : payload.autoCompression?.compressed
              ? "设置已保存，并已按新阈值压缩网页对话"
              : "上下文设置已保存",
        );
      } catch (caught) {
        showToast(caught instanceof Error ? caught.message : "保存上下文设置失败");
      } finally {
        setContextBusyAction(null);
      }
  };

  const saveAgentContextSettings = async (
    contextLimit: number,
    agent: AgentItem | undefined = activeAgent,
  ) => {
    if (!effectiveServerId || !agent) return;
    setContextBusyAction("agent-save");
    try {
      const response = await gatewayFetch("/api/context/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: effectiveServerId,
          agentId: agent.id,
          agentAdapter: agent.adapter,
          conversationId: activeConversationId,
          workspaceId: activeWorkspace?.id || "",
          contextLimit,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || "保存 Agent 上下文上限失败");
      }
      setAgentsByServer((current) => ({
        ...current,
        [effectiveServerId]: (current[effectiveServerId] || []).map((item) =>
          item.id === agent.id ? { ...item, contextLimit } : item,
        ),
      }));
      if (agent.id === activeAgentId) {
        await loadContextUsage(
          activeConversationId,
          effectiveServerId,
          agent.id,
          activeWorkspace?.id || "",
          agent.adapter,
        );
      } else {
        await loadAgentContextForMenu(agent);
      }
      showToast("已写入 Agent 原生模型配置");
    } catch (caught) {
      showToast(
        caught instanceof Error
          ? caught.message
          : "保存 Agent 上下文上限失败",
      );
    } finally {
      setContextBusyAction(null);
    }
  };

  const compressCurrentContext = async () => {
    if (!activeConversationId) return;
    setContextBusyAction("web-compress");
    try {
      const response = await gatewayFetch("/api/context/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeConversationId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        compressed?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "压缩上下文失败");
      await loadContextUsage(
        activeConversationId,
        effectiveServerId,
        activeAgentId,
        activeWorkspace?.id || "",
        activeAgent?.adapter || "",
      );
      showToast(payload.compressed ? "对话上下文已压缩" : "当前没有需要压缩的旧消息");
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "压缩上下文失败");
    } finally {
      setContextBusyAction(null);
    }
  };

  const compressAgentContext = async (
    agent: AgentItem | undefined = activeAgent,
  ) => {
    if (!activeConversationId || !effectiveServerId || !agent) return;
    setContextBusyAction("agent-compress");
    try {
      const response = await gatewayFetch("/api/context/agent/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: activeConversationId,
          serverId: effectiveServerId,
          agentId: agent.id,
          workspaceId: activeWorkspace?.id || "",
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        accepted?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.accepted) {
        throw new Error(payload.error || "Agent 原生压缩失败");
      }
      showToast("Agent 已接受原生压缩请求");
      if (agent.id === activeAgentId) {
        window.setTimeout(
          () =>
            void loadContextUsage(
              activeConversationId,
              effectiveServerId,
              agent.id,
              activeWorkspace?.id || "",
              agent.adapter,
            ),
          1_200,
        );
      } else {
        window.setTimeout(() => void loadAgentContextForMenu(agent), 1_200);
      }
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Agent 原生压缩失败");
    } finally {
      setContextBusyAction(null);
    }
  };

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

  const browseWorkspaceDirectory = useCallback(
    async (serverId: string, requestedPath: string) => {
      setWorkspacePickerLoading(true);
      try {
        const query = new URLSearchParams({
          serverId,
          path: requestedPath || "~",
        });
        const response = await gatewayFetch(
          `/api/workspaces/browse?${query.toString()}`,
        );
        const payload = (await response.json().catch(() => ({}))) as {
          path?: string;
          home?: string;
          parent?: string | null;
          entries?: RemoteFileEntry[];
          error?: string;
        };
        if (!response.ok || !payload.path) {
          throw new Error(payload.error || "读取远端目录失败");
        }
        setWorkspaceBrowsePath(payload.path);
        setWorkspaceBrowseHome(payload.home || "");
        setWorkspaceBrowseParent(payload.parent ?? null);
        setWorkspaceBrowseEntries(
          (payload.entries || []).filter((entry) => entry.type === "directory"),
        );
      } catch (caught) {
        showToast(caught instanceof Error ? caught.message : "读取远端目录失败");
      } finally {
        setWorkspacePickerLoading(false);
      }
    },
    [showToast],
  );

  const openWorkspacePicker = useCallback(async (
    purpose: "conversation" | "dynamic" = "conversation",
  ) => {
    const serverId =
      activeConversation?.work?.serverId || effectiveServerId || draftServerId;
    if (!serverId || connections[serverId]?.status !== "connected") {
      setSshModalContext(
        activeConversation?.work?.serverId ? "bound" : "new-work",
      );
      setSshModalOpen(true);
      showToast("请先连接远程服务器");
      return;
    }
    setWorkspacePickerPurpose(purpose);
    setWorkspacePickerOpen(true);
    setWorkspacePickerLoading(true);
    try {
      const initialBrowseResponse = await gatewayFetch(
        `/api/workspaces/browse?${new URLSearchParams({
          serverId,
          path: activeWorkspace?.path || "~",
        }).toString()}`,
      );
      let browseResponse = initialBrowseResponse;
      if (!browseResponse.ok && activeWorkspace?.path) {
        browseResponse = await gatewayFetch(
          `/api/workspaces/browse?${new URLSearchParams({
            serverId,
            path: "~",
          }).toString()}`,
        );
      }
      const browsePayload = (await browseResponse.json().catch(() => ({}))) as {
        path?: string;
        home?: string;
        parent?: string | null;
        entries?: RemoteFileEntry[];
        error?: string;
      };
      if (!browseResponse.ok || !browsePayload.path) {
        throw new Error(browsePayload.error || "读取远端目录失败");
      }
      setWorkspaceBrowsePath(browsePayload.path);
      setWorkspaceBrowseHome(browsePayload.home || "");
      setWorkspaceBrowseParent(browsePayload.parent ?? null);
      setWorkspaceBrowseEntries(
        (browsePayload.entries || []).filter(
          (entry) => entry.type === "directory",
        ),
      );
    } catch (caught) {
      setWorkspacePickerOpen(false);
      showToast(caught instanceof Error ? caught.message : "读取工作区失败");
    } finally {
      setWorkspacePickerLoading(false);
    }
  }, [
    activeConversation,
    activeWorkspace,
    connections,
    draftServerId,
    effectiveServerId,
    showToast,
  ]);

  const applyWorkspaceToConversation = useCallback(
    async (conversationId: string, workspace: WorkspaceItem) => {
      setWorkspaceSwitchBusy(true);
      try {
        const response = await gatewayFetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/workspace`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workspaceId: workspace.id }),
          },
        );
        const payload = (await response.json().catch(() => ({}))) as {
          conversation?: Conversation;
          workspace?: WorkspaceItem;
          error?: string;
        };
        if (!response.ok || !payload.conversation) {
          throw new Error(payload.error || "切换工作区失败");
        }
        setState((current) => ({
          ...current,
          conversations: current.conversations.map((conversation) =>
            conversation.id === conversationId
              ? payload.conversation!
              : conversation,
          ),
        }));
        setWorkspaceItems((current) => [
          payload.workspace || workspace,
          ...current.filter((item) => item.id !== workspace.id),
        ]);
        setContextUsage(null);
        showToast(`已切换到 ${workspace.name}`);
      } catch (caught) {
        showToast(caught instanceof Error ? caught.message : "切换工作区失败");
      } finally {
        setWorkspaceSwitchBusy(false);
        setWorkspaceSwitchPending(null);
      }
    },
    [showToast],
  );

  const chooseWorkspace = useCallback(
    (workspace: WorkspaceItem) => {
      setWorkspacePickerOpen(false);
      if (workspacePickerPurpose === "dynamic") {
        setPendingVirtualWrite((current) =>
          current ? { ...current, target: workspace } : current,
        );
        return;
      }
      if (!activeConversation) {
        setDraftWorkspace(workspace);
        showToast(`已选择 ${workspace.name}`);
        return;
      }
      if (activeConversation.work?.workspaceId === workspace.id) return;
      if (activeConversation.work?.workspaceId) {
        setWorkspaceSwitchPending(workspace);
        return;
      }
      void applyWorkspaceToConversation(activeConversation.id, workspace);
    },
    [
      activeConversation,
      applyWorkspaceToConversation,
      showToast,
      workspacePickerPurpose,
    ],
  );

  const ensureConversationVirtualWorkspace = useCallback(
    async (serverId: string, conversationId: string) => {
      const response = await gatewayFetch("/api/workspaces/virtual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, conversationId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        workspace?: WorkspaceItem;
        error?: string;
      };
      if (!response.ok || !payload.workspace) {
        throw new Error(payload.error || "创建虚拟工作区失败");
      }
      return payload.workspace;
    },
    [],
  );

  const chooseVirtualWorkspace = useCallback(async () => {
    const serverId =
      activeConversation?.work?.serverId || effectiveServerId || draftServerId;
    if (!serverId) {
      showToast("请先连接远程服务器");
      return;
    }
    setWorkspacePickerLoading(true);
    try {
      if (!activeConversation) {
        setDraftWorkspace(null);
        setWorkspacePickerOpen(false);
        showToast("新对话将使用虚拟工作区");
        return;
      }
      const workspace = await ensureConversationVirtualWorkspace(
        serverId,
        activeConversation.id,
      );
      setWorkspacePickerOpen(false);
      if (activeConversation.work?.workspaceId === workspace.id) return;
      if (activeConversation.work?.workspaceId) {
        setWorkspaceSwitchPending(workspace);
      } else {
        await applyWorkspaceToConversation(activeConversation.id, workspace);
      }
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "创建虚拟工作区失败");
    } finally {
      setWorkspacePickerLoading(false);
    }
  }, [
    activeConversation,
    applyWorkspaceToConversation,
    draftServerId,
    effectiveServerId,
    ensureConversationVirtualWorkspace,
    showToast,
  ]);

  const registerCurrentWorkspace = useCallback(async () => {
    const serverId =
      activeConversation?.work?.serverId || effectiveServerId || draftServerId;
    if (!serverId || !workspaceBrowsePath) return;
    setWorkspacePickerLoading(true);
    try {
      const response = await gatewayFetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId, path: workspaceBrowsePath }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        workspace?: WorkspaceItem;
        error?: string;
      };
      if (!response.ok || !payload.workspace) {
        throw new Error(payload.error || "登记工作区失败");
      }
      chooseWorkspace(payload.workspace);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "登记工作区失败");
    } finally {
      setWorkspacePickerLoading(false);
    }
  }, [
    activeConversation?.work?.serverId,
    chooseWorkspace,
    draftServerId,
    effectiveServerId,
    showToast,
    workspaceBrowsePath,
  ]);

  const chooseSuggestedDynamicWorkspace = useCallback(
    async (requestedPath: string) => {
      const serverId =
        activeConversation?.work?.serverId || effectiveServerId || draftServerId;
      if (!serverId) return;
      setDynamicWorkspaceBusy(true);
      try {
        const response = await gatewayFetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId, path: requestedPath }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          workspace?: WorkspaceItem;
          error?: string;
        };
        if (!response.ok || !payload.workspace) {
          throw new Error(
            payload.error || "该路径不能直接作为工作区，请通过目录浏览器选择",
          );
        }
        setPendingVirtualWrite((current) =>
          current ? { ...current, target: payload.workspace } : current,
        );
      } catch (caught) {
        showToast(caught instanceof Error ? caught.message : "验证动态工作区失败");
      } finally {
        setDynamicWorkspaceBusy(false);
      }
    },
    [activeConversation?.work?.serverId, draftServerId, effectiveServerId, showToast],
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
      const exposesAgentPlan = isMemoryQuestion || isFileTask;
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
            ...(message.trace ?? { runId, startedAt: now() }),
            status: "running",
            steps: exposesAgentPlan
              ? steps.map((title, index) => ({
                  id: `${runId}_step_${index}`,
                  title,
                  status: index === 0 ? "running" : "pending",
                }))
              : [],
          },
        }),
      );

      const eventPlan: WorkEvent = {
        id: `${runId}_plan`,
        kind: "plan",
        title: "执行计划",
        status: "running",
        timestamp: now(),
      };
      updateMessage(
        conversationId,
        (message) => message.runId === runId && message.role === "assistant",
        (message) => ({
          ...message,
          reasoningStatus: "done",
          events: exposesAgentPlan ? [eventPlan] : [],
        }),
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
                    (event) =>
                      event.id !== `${runId}_thought_${index}` &&
                      event.id !== `${runId}_tool_${index}`,
                  ),
                  {
                    id: `${runId}_thought_${index}`,
                    kind: "agent_message",
                    title: "Agent思考中",
                    output:
                      index === 0
                        ? "先核对当前环境，再开始执行。"
                        : `已取得上一项结果，继续处理“${title}”。`,
                    status: "running",
                    timestamp: now(),
                  },
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
                    diff:
                      isFileTask && index === 2
                        ? "--- a/train.py\n+++ b/train.py\n@@ -1,2 +1,4 @@\n def run(config):\n+    if not config:\n+        raise ValueError(\"config is required\")\n     return train(config)"
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
              (message) => {
                const finalContent = isMemoryQuestion
                  ? "检查完成。登录节点共有 251 GiB 内存，目前约 164 GiB 可用；GPU 队列中有 2 张 A100 处于空闲状态。按当前资源，轻量推理可以直接进行。"
                  : "任务已完成，并通过验证。";
                const completedEvents = (message.events ?? []).map((event) =>
                  event.id === `${runId}_tool_${index}` ||
                  event.id === `${runId}_thought_${index}`
                    ? { ...event, status: "done" as const }
                    : event,
                );
                return {
                  ...message,
                  content:
                    index === steps.length - 1 ? finalContent : message.content,
                  events: completedEvents,
                };
              },
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
                  conversationCount:
                    typeof item.conversationCount === "number"
                      ? item.conversationCount
                      : undefined,
                  activeTaskCount:
                    typeof item.activeTaskCount === "number"
                      ? item.activeTaskCount
                      : undefined,
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
          conversationCount:
            typeof payload.conversationCount === "number"
              ? payload.conversationCount
              : undefined,
          activeTaskCount:
            typeof payload.activeTaskCount === "number"
              ? payload.activeTaskCount
              : undefined,
        };
        setConnections((current) => ({
          ...current,
          [serverId]:
            status === "disconnected" && current[serverId]?.status === "error"
              ? current[serverId]
              : nextConnection,
        }));
        if (status === "connected") {
          if (!payload.reused && !payload.demo) {
            setAgentScanningByServer((current) => ({
              ...current,
              [serverId]: true,
            }));
          }
          setSelectedServerId(serverId);
          setSshModalOpen(false);
          const pendingBinding = pendingServerBindingRef.current;
          if (pendingBinding?.serverId === serverId) {
            updateConversation(pendingBinding.conversationId, (conversation) => ({
              ...conversation,
              work: {
                ...(conversation.work ?? {}),
                serverId,
                connectionEnabled: true,
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
      if (type === "agent.scan.status") {
        const serverId = String(payload.serverId || "");
        if (!serverId) return;
        const scanning = String(payload.status || "") === "scanning";
        setAgentScanningByServer((current) => ({
          ...current,
          [serverId]: scanning,
        }));
        if (scanning) setAgentMenuOpen(false);
        return;
      }
      if (type === "agent.list") {
        const serverId = String(payload.serverId || "");
        if (!serverId) return;
        const incoming = dedupeAgents(
          Array.isArray(payload.agents) ? (payload.agents as AgentItem[]) : [],
        );
        setAgentsByServer((current) => ({ ...current, [serverId]: incoming }));
        setAgentScanningByServer((current) => ({
          ...current,
          [serverId]: false,
        }));
        const firstReady = incoming.find((agent) => agent.status === "ready");
        if (firstReady) {
          setActiveAgentByServer((current) => ({
            ...current,
            [serverId]:
              current[serverId] &&
              incoming.some(
                (agent) =>
                  agent.id === current[serverId] && agent.status === "ready",
              )
                ? current[serverId]
                : firstReady.id,
          }));
        }
        return;
      }
      if (type === "agent.install.progress") {
        const serverId = String(payload.serverId || "");
        const agentId = String(payload.agentId || "opencode");
        const detail = String(payload.label ?? "正在安装");
        const failed = String(payload.stage || "") === "error";
        setAgentsByServer((current) => ({
          ...current,
          [serverId]: (current[serverId] ?? DEFAULT_AGENTS).map((agent) =>
            agent.id === agentId
              ? {
                  ...agent,
                  status: failed ? "missing" : "installing",
                  detail: failed ? "未安装" : detail,
                }
              : agent,
          ),
        }));
        if (failed) showToast(detail || "Agent 安装失败");
        return;
      }
      if (type === "agent.uninstall.status") {
        const agentId = String(payload.agentId || "");
        const status = String(payload.status || "");
        if (status === "running") {
          setUninstallingAgentId(agentId);
        } else {
          setUninstallingAgentId("");
          if (status === "done") {
            setAgentMenuPage("root");
            showToast(String(payload.label || "Agent 已卸载"));
          } else if (status === "error") {
            showToast(String(payload.error || payload.label || "Agent 卸载失败"));
          }
        }
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
          agentId: payload.agentId ? String(payload.agentId) : undefined,
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
          showToast(nextUpdate.label || "Agent 已与主机版本一致");
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
          showToast(nextModelState.label || "Agent 模型配置完成");
        }
        return;
      }
      if (type === "agent.runtime.status") {
        const status = String(payload.status || "");
        const agentId = String(payload.agentId || "");
        if (status === "configuring") {
          setAgentRuntimeConfig({
            agentId,
            status: "configuring",
            label: String(payload.label || "配置中"),
          });
        } else if (status === "done") {
          setAgentRuntimeConfig({ agentId: "", status: "idle" });
          showToast("Agent 运行配置已保存");
        } else if (status === "error") {
          setAgentRuntimeConfig({ agentId: "", status: "idle" });
          showToast(String(payload.error || payload.label || "Agent 运行配置失败"));
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
      if (type === "work.append.accepted" && payload.message) {
        const conversationId = String(payload.conversationId || "");
        const runId = String(payload.runId || "");
        const incoming = payload.message as Message;
        if (conversationId && incoming.id) {
          updateConversation(conversationId, (conversation) => {
            if (conversation.messages.some((message) => message.id === incoming.id)) {
              return conversation;
            }
            const messages = [...conversation.messages];
            const assistantIndex = messages.findIndex(
              (message) =>
                message.role === "assistant" && message.runId === runId,
            );
            if (assistantIndex >= 0) messages.splice(assistantIndex, 0, incoming);
            else messages.push(incoming);
            return { ...conversation, messages, updatedAt: now() };
          });
          showToast("指令已追加到当前任务");
        }
        return;
      }
      if (type === "work.append.delivered") return;
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
                status: String(incomingStep?.status ?? "pending") as StepStatus,
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
              ...(message.trace ?? {}),
              runId,
              status: "running",
              steps,
              startedAt: message.trace?.startedAt ?? now(),
            },
          }),
        );
        if (steps.length) setExpandedTraces(new Set([runId]));
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
          output: event.output
            ? stripEasyWorkProtocolText(String(event.output))
            : undefined,
          diff: event.diff ? String(event.diff) : undefined,
          command: event.command ? String(event.command) : undefined,
          path: event.path ? String(event.path) : undefined,
          language: event.language ? String(event.language) : undefined,
          approvalId: event.approvalId ? String(event.approvalId) : undefined,
          approvalType:
            event.approvalType === "question" ? "question" : "permission",
          retractFinal: Boolean(event.retractFinal),
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
            const eventsWithoutCurrent = previous.filter(
              (item) => item.id !== eventId,
            );
            return {
              ...message,
              content:
                workEvent.retractFinal
                  ? ""
                  : isMessage && workEvent.output
                  ? workEvent.output
                  : message.content,
              reasoning:
                isReasoning && (workEvent.output || workEvent.detail)
                  ? workEvent.output || workEvent.detail
                  : message.reasoning,
              reasoningStatus: isReasoning
                ? workEvent.status === "error"
                  ? "error"
                  : workEvent.status === "running"
                    ? "running"
                    : "done"
                : message.reasoningStatus,
              events:
                isMessage || isReasoning
                  ? eventsWithoutCurrent
                  : exists
                    ? previous.map((item) =>
                        item.id === eventId ? workEvent : item,
                      )
                    : [...previous, workEvent],
            };
          },
        );
        return;
      }

      if (
        type === "task.complete" ||
        type === "task.error" ||
        type === "task.aborted"
      ) {
        const failed = type === "task.error";
        const aborted = type === "task.aborted";
        const result = stripEasyWorkProtocolText(
          String(
            payload.result ??
              (aborted ? "任务已停止" : failed ? "任务执行失败" : "任务已完成"),
          ),
        );
        updateMessage(
          conversationId,
          (message) => message.runId === runId && message.role === "user",
          (message) => ({
            ...message,
            trace: message.trace
              ? {
                  ...message.trace,
                  status: aborted ? "aborted" : failed ? "error" : "done",
                  result,
                  steps: message.trace.steps.map((step) => ({
                     ...step,
                    status:
                      step.status !== "running"
                        ? step.status
                        : aborted
                          ? "cancelled"
                          : failed
                            ? "error"
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
            content: failed || aborted ? message.content || result : message.content,
            reasoningStatus:
              message.reasoningStatus === "running"
                ? failed
                  ? "error"
                  : "done"
                : message.reasoningStatus,
            events: (message.events ?? []).map((event) =>
              event.status === "running"
                ? {
                    ...event,
                    status: aborted
                      ? ("cancelled" as const)
                      : failed
                        ? ("error" as const)
                        : ("done" as const),
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
          } else if (!shouldHydrate) {
            setState((current) => {
              let changed = false;
              const conversations = current.conversations.map((conversation) => {
                const repaired = repairConversationTitle(conversation);
                if (repaired !== conversation) changed = true;
                return repaired;
              });
              return changed ? { ...current, conversations } : current;
            });
          }
          setAppLoading(false);
          return;
        } catch {
          // Continue with the next reachable EasyWork service candidate.
        }
      }
      if (!disposed) {
        setGatewayStatus("unavailable");
        setAppLoading(false);
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

  const trackMessageScrollPosition = useCallback(() => {
    const scroller = messagesScrollRef.current;
    if (!scroller) return;
    const distanceToBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    messagesPinnedToBottomRef.current = distanceToBottom <= 72;
  }, []);

  useEffect(() => {
    const scroller = messagesScrollRef.current;
    if (!scroller || !messagesPinnedToBottomRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMessageCount, activeStreamProgress, sending]);

  const selectConversation = (conversation: Conversation) => {
    draftConversationIdRef.current = "";
    setActiveConversationId(conversation.id);
    setDraftProjectId(undefined);
    setDraftServerId("");
    setDraftWorkspace(null);
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
    draftConversationIdRef.current = "";
    setActiveConversationId("");
    setDraftProjectId(projectId);
    setDraftServerId("");
    setDraftWorkspace(null);
    setPendingVirtualWrite(null);
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
    draftConversationIdRef.current = "";
    setActiveProjectId(projectId);
    setActiveConversationId("");
    setDraftProjectId(undefined);
    setDraftServerId("");
    setDraftWorkspace(null);
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
      setDraftWorkspace(null);
    }
    if (activeConversation) {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        mode: nextMode,
        work:
          nextMode === "work"
            ? conversation.work ?? {
                agentId: activeAgentId,
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
          ...(conversation.work ?? {}),
          serverId,
          connectionEnabled: true,
        },
      }));
      setDraftServerId("");
      return;
    }
    if (draftServerId !== serverId) setDraftWorkspace(null);
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

  const setConversationConnection = (
    conversationId: string,
    enabled: boolean,
  ) => {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: now(),
      work: {
        ...(conversation.work ?? {}),
        connectionEnabled: enabled,
      },
    }));
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

  const deleteConversation = async (conversationId: string) => {
    const deleted = state.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    try {
      const response = await gatewayFetch(
        `/api/conversations/${encodeURIComponent(conversationId)}`,
        { method: "DELETE" },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "删除对话失败");
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
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "删除对话失败");
    }
  };

  const submitMessage = async (
    options: {
      projectId?: string;
      requestedMode?: Mode;
      openChat?: boolean;
      content?: string;
      conversation?: Conversation;
      conversationId?: string;
      executionWorkspace?: WorkspaceItem;
      skipVirtualWriteCheck?: boolean;
    } = {},
  ) => {
    const content = String(options.content ?? draft).trim();
    if (!content) return;
    const submissionMode = options.requestedMode ?? mode;
    const conversation =
      options.conversation ??
      (options.projectId ? undefined : activeConversation);
    const conversationId =
      conversation?.id ||
      options.conversationId ||
      draftConversationIdRef.current ||
      uid("chat");
    if (!conversation?.id) draftConversationIdRef.current = conversationId;
    const prospectiveProjectId =
      options.projectId ?? conversation?.projectId ?? draftProjectId;
    const targetServerId =
      conversation?.work?.serverId || effectiveServerId;
    const targetConnection = connections[targetServerId] ?? connection;
    const submissionAgentId =
      conversation?.work?.agentId ||
      activeAgentByServer[targetServerId] ||
      activeAgentId;
    const submissionAgent = (agentsByServer[targetServerId] ?? []).find(
      (agent) => agent.id === submissionAgentId,
    );
    const runningUserMessage = [...(conversation?.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === "user" && message.trace?.status === "running",
      );
    if (submissionMode === "work" && runningUserMessage?.runId) {
      const runningAssistant = conversation?.messages.find(
        (message) =>
          message.role === "assistant" &&
          message.runId === runningUserMessage.runId,
      );
      const runningAgent =
        (agentsByServer[targetServerId] ?? []).find(
          (agent) => agent.id === runningAssistant?.agentId,
        ) || submissionAgent;
      if (!runningAgent?.capabilities?.liveInput) return;
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN || targetConnection.demo) {
        showToast("当前 Agent 会话暂时无法接收追加指令");
        return;
      }
      setAgentMenuOpen(false);
      setAgentMenuPage("root");
      socket.send(
        JSON.stringify({
          type: "work.append",
          requestId: uid("append"),
          serverId: targetServerId,
          conversationId: conversation?.id,
          runId: runningUserMessage.runId,
          messageId: uid("message"),
          content,
          createdAt: now(),
        }),
      );
      setDraft("");
      return;
    }
    if (sending) return;
    if (submissionMode === "work" && targetConnection.status !== "connected") {
      openConversationServerManager();
      showToast("请先连接一台远程服务器");
      return;
    }
    let submissionWorkspace: WorkspaceItem | null = conversation?.work?.workspaceId
      ? {
          id: conversation.work.workspaceId,
          serverId: conversation.work.serverId || targetServerId,
          name: conversation.work.workspaceName || "工作区",
          path: conversation.work.workspace || "",
          mode: conversation.work.workspaceMode || "unmanaged",
          kind: conversation.work.workspaceKind || "physical",
          versionDomainId: conversation.work.versionDomainId,
          writable: true,
          createdAt: "",
          updatedAt: conversation.updatedAt,
          lastUsedAt: conversation.updatedAt,
        }
      : draftWorkspace?.serverId === targetServerId
        ? draftWorkspace
        : null;
    if (
      submissionMode === "work" &&
      (!submissionWorkspace || submissionWorkspace.kind === "virtual") &&
      !options.skipVirtualWriteCheck &&
      appearsToModifyRemoteState(content)
    ) {
      setPendingVirtualWrite({
        content,
        conversationId,
        projectId: prospectiveProjectId,
        requestedMode: "work",
        openChat: options.openChat,
        suggestedPaths: remotePathSuggestions(content),
      });
      return;
    }
    if (
      submissionMode === "work" &&
      (submissionAgent?.status !== "ready" || !submissionAgent.configured)
    ) {
      if (submissionAgent?.status === "ready") {
        setAgentConfigAgentId(submissionAgent.id);
        setAgentMenuPage("config");
      } else {
        setAgentMenuPage("root");
      }
      setAgentMenuOpen(true);
      showToast(
        submissionAgent?.status === "missing"
          ? "请先安装或选择 Agent"
          : "请先完成 Agent 模型配置",
      );
      return;
    }

    if (submissionMode === "work" && !submissionWorkspace?.id) {
      try {
        submissionWorkspace = await ensureConversationVirtualWorkspace(
          targetServerId,
          conversationId,
        );
      } catch (caught) {
        showToast(caught instanceof Error ? caught.message : "创建虚拟工作区失败");
        return;
      }
    }
    const executionWorkspace =
      submissionMode === "work"
        ? options.executionWorkspace || submissionWorkspace
        : null;
    if (submissionMode === "work" && !executionWorkspace?.id) {
      showToast("无法确定本轮执行工作区");
      return;
    }
    const dynamicWorkspace = Boolean(
      submissionMode === "work" &&
        submissionWorkspace?.kind === "virtual" &&
        executionWorkspace?.id !== submissionWorkspace.id,
    );

    setAgentMenuOpen(false);
    setAgentMenuPage("root");

    const firstTurn = !conversation?.messages.length;
    const projectId =
      prospectiveProjectId;
    const conversationProject = state.projects.find((project) => project.id === projectId);
    const work =
      submissionMode === "work"
        ? {
            ...(conversation?.work ?? {}),
            agentId: submissionAgentId,
            serverId: targetServerId,
            connectionEnabled: true,
            workspaceId: submissionWorkspace!.id,
            workspaceName: submissionWorkspace!.name,
            workspace: submissionWorkspace!.path,
            workspaceMode: submissionWorkspace!.mode,
            workspaceKind: submissionWorkspace!.kind,
            versionDomainId: submissionWorkspace!.versionDomainId,
            workspaceHistory:
              conversation?.work?.workspaceHistory || [
                {
                  workspaceId: submissionWorkspace!.id,
                  serverId: submissionWorkspace!.serverId,
                  name: submissionWorkspace!.name,
                  path: submissionWorkspace!.path,
                  kind: submissionWorkspace!.kind,
                  versionDomainId: submissionWorkspace!.versionDomainId,
                  activatedAt: now(),
                },
              ],
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
      workspaceId:
        submissionMode === "work" ? executionWorkspace!.id : undefined,
      workspaceName:
        submissionMode === "work" ? executionWorkspace!.name : undefined,
      workspaceKind:
        submissionMode === "work" ? executionWorkspace!.kind : undefined,
      dynamicWorkspace,
      trace:
        submissionMode === "work"
          ? {
              runId,
              status: "running",
              steps: [],
              startedAt: now(),
              workspaceId: executionWorkspace!.id,
              workspaceName: executionWorkspace!.name,
              workspaceKind: executionWorkspace!.kind,
              dynamicWorkspace,
              versionDomainId: executionWorkspace!.versionDomainId,
            }
          : undefined,
    };
    const assistantMessage: Message = {
      id: uid("message"),
      role: "assistant",
      content: "",
      createdAt: now(),
      mode: submissionMode,
      events: submissionMode === "work" ? [] : undefined,
      reasoningStatus: submissionMode === "work" ? "running" : undefined,
      runId: submissionMode === "work" ? runId : undefined,
      agentId: submissionMode === "work" ? submissionAgentId : undefined,
      workspaceId:
        submissionMode === "work" ? executionWorkspace!.id : undefined,
      workspaceName:
        submissionMode === "work" ? executionWorkspace!.name : undefined,
      workspaceKind:
        submissionMode === "work" ? executionWorkspace!.kind : undefined,
      dynamicWorkspace,
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
    setDraftWorkspace(null);
    draftConversationIdRef.current = "";
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
      if (socket?.readyState === WebSocket.OPEN && !targetConnection.demo) {
        socket.send(
          JSON.stringify({
            type: "work.run",
            serverId: work?.serverId,
            conversationId,
            runId,
            userMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
            firstTurn,
            prompt: content,
            skills: selectedSkills,
            agentId: submissionAgentId,
            projectId,
            memoryMode: conversationProject?.memoryMode ?? "project-and-global",
            workspaceId: executionWorkspace?.id,
            workspaceName: executionWorkspace?.name,
            workspace: executionWorkspace?.path,
            workspaceMode: executionWorkspace?.mode,
            workspaceKind: executionWorkspace?.kind,
            versionRoot: executionWorkspace?.versionRoot,
            versionDomainId: executionWorkspace?.versionDomainId,
            conversationWorkspaceId: work?.workspaceId,
            conversationWorkspaceName: work?.workspaceName,
            conversationWorkspace: work?.workspace,
            conversationWorkspaceMode: work?.workspaceMode,
            conversationWorkspaceKind: work?.workspaceKind,
            dynamicWorkspace,
            branchId: conversation?.branch
              ? conversation.id
              : conversationId,
          }),
        );
      } else {
        simulateWorkRun(conversationId, runId, content);
      }
      return;
    }

    const requestBody = JSON.stringify({
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      prompt: content,
      firstTurn,
      skillIds: selectedSkills,
      projectId,
      memoryMode: conversationProject?.memoryMode ?? "project-and-global",
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
                reasoningStatus: "running",
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
                reasoningStatus: "done",
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
          reasoningStatus:
            message.reasoningStatus === "running"
              ? "error"
              : message.reasoningStatus,
        }),
      );
    } finally {
      if (chatAbortRef.current === abortController) {
        chatAbortRef.current = null;
      }
      setSending(false);
    }
  };

  const continuePendingVirtualWrite = async (useVirtualDirectory = false) => {
    const pending = pendingVirtualWrite;
    if (!pending) return;
    const pendingConversation = pending.conversationId
      ? state.conversations.find(
          (conversation) => conversation.id === pending.conversationId,
        )
      : undefined;
    setPendingVirtualWrite(null);
    await submitMessage({
      projectId: pending.projectId,
      requestedMode: "work",
      openChat: pending.openChat,
      content: pending.content,
      conversation: pendingConversation,
      conversationId: pending.conversationId,
      executionWorkspace: useVirtualDirectory ? undefined : pending.target,
      skipVirtualWriteCheck: true,
    });
  };

  const actOnConversationMessage = async (
    action: "branch" | "edit" | "reset" | "rewind",
    message: Message,
    content?: string,
  ) => {
    if (!activeConversation || sending) return;
    if (action === "branch" && !window.confirm("要从这条回复创建新的对话分支吗？")) {
      return;
    }
    if (
      action === "reset" &&
      !window.confirm(
        "重置会在当前对话中替换最新回复，并清除该轮产生的记忆与后续分支。继续吗？",
      )
    ) {
      return;
    }
    if (
      action === "rewind" &&
      !window.confirm(
        "回溯会保留这条回复，删除它之后的对话、记忆、任务和分支，并撤销可恢复的文件修改。工作区外的作业、服务等副作用无法自动撤销。确认继续吗？",
      )
    ) {
      return;
    }
    try {
      if (stateSaveTimerRef.current !== null) {
        window.clearTimeout(stateSaveTimerRef.current);
        stateSaveTimerRef.current = null;
      }
      pendingStateSaveRef.current = null;
      await stateSaveQueueRef.current.catch(() => undefined);
      const stateResponse = await gatewayFetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (!stateResponse.ok) throw new Error("同步当前对话失败");
      const response = await gatewayFetch("/api/conversations/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          conversationId: activeConversation.id,
          messageId: message.id,
          content,
          newConversationId: uid("chat"),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        conversation?: Conversation;
        seedPrompt?: string;
        removedConversationIds?: string[];
        error?: string;
        capability?: {
          workspace?: string;
          workspaceMessage?: string;
          agentMemoryMessage?: string;
        };
      };
      if (!response.ok || !payload.conversation) {
        throw new Error(payload.error || "对话操作失败");
      }
      const nextConversation = payload.conversation;
      const removedConversationIds = new Set(
        payload.removedConversationIds ?? [],
      );
      setState((current) => ({
        ...current,
        conversations: [
          nextConversation,
          ...current.conversations.filter(
            (item) =>
              item.id !== nextConversation.id &&
              !removedConversationIds.has(item.id),
          ),
        ],
      }));
      selectConversation(nextConversation);
      setEditingMessageId("");
      setEditingMessageText("");
      const capabilityMessage = [
        payload.capability?.workspaceMessage,
        payload.capability?.agentMemoryMessage,
      ]
        .filter(Boolean)
        .join(" ");
      if (capabilityMessage) {
        showToast(capabilityMessage);
      } else {
        showToast(
          action === "branch"
            ? "已创建对话分支"
            : action === "edit"
              ? "已按修改后的提问重新生成"
              : action === "reset"
                ? "已重置最新回复"
                : "已回溯到所选回复",
        );
      }
      if (payload.seedPrompt) {
        await submitMessage({
          content: payload.seedPrompt,
          conversation: nextConversation,
          requestedMode: nextConversation.mode,
          openChat: true,
        });
      }
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "对话操作失败");
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
      showToast("正在停止远端任务");
      return;
    }
    showToast("没有找到正在运行的远端任务");
  };

  const respondToApproval = useCallback(
    (
      conversationId: string,
      runId: string,
      event: WorkEvent,
      approved: boolean,
      answers?: string[][],
    ) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
          JSON.stringify({
            type: "work.approval",
            serverId: activeConversation?.work?.serverId || effectiveServerId,
            conversationId,
            runId,
            eventId: event.id,
            approvalId: event.approvalId,
            approvalType: event.approvalType,
            approved,
            answers,
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
                  detail:
                    event.approvalType === "question"
                      ? approved
                        ? "用户已回答"
                        : "用户已跳过"
                      : approved
                        ? "用户已允许继续"
                        : "用户已拒绝本次操作",
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
      if (draftWorkspace?.serverId !== serverId) setDraftWorkspace(null);
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
              ...(conversation.work ?? {}),
              serverId,
              connectionEnabled: true,
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
    keyName?: string;
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
      if (draftWorkspace?.serverId !== payload.serverId) {
        setDraftWorkspace(null);
      }
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
        keyName: payload.keyName || existing?.keyName || "",
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

  const installManagedAgent = (agentId: string) => {
    if (connection.demo) {
      showToast("演示环境无需安装 Agent");
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "agent.install",
          serverId: effectiveServerId,
          agentId,
        }),
      );
      showToast(`正在安装到 ~/.easywork/agents/${agentId}`);
    }
  };

  const uninstallManagedAgent = (agent: AgentItem) => {
    if (
      !agent.managed ||
      connection.demo ||
      socketRef.current?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    setAgentPendingUninstall(null);
    setUninstallingAgentId(agent.id);
    socketRef.current.send(
      JSON.stringify({
        type: "agent.uninstall",
        serverId: effectiveServerId,
        agentId: agent.id,
      }),
    );
    showToast(`正在卸载 ${agent.name}`);
  };

  const checkAgentUpdate = (agent = activeAgent) => {
    if (
      !effectiveServerId ||
      connection.status !== "connected" ||
      !agent.managed
    ) {
      return;
    }
    if (
      activeAgentUpdate.status === "available" &&
      activeAgentUpdate.agentId === agent.id
    ) {
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
        agentId: agent.id,
        currentVersion: agent.version,
        label: `正在检测 ${agent.name} 更新`,
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
        label: "正在部署主机安装包",
      },
    }));
    socketRef.current.send(
      JSON.stringify({
        type: "agent.update.apply",
        serverId: effectiveServerId,
        agentId:
          activeAgentUpdate.agentId || configAgent?.id || activeAgent?.id,
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
          ...(conversation.work ?? {}),
          serverId: conversation.work?.serverId || effectiveServerId,
          agentId,
        },
      }));
    }
    setAgentMenuOpen(false);
    setAgentMenuPage("root");
  };

  const browseManualAgentDirectory = async (requestedPath: string) => {
    if (!effectiveServerId) return;
    setManualAgentBrowseLoading(true);
    try {
      const query = new URLSearchParams({
        serverId: effectiveServerId,
        path: requestedPath || "~",
      });
      const response = await gatewayFetch(
        `/api/workspaces/browse?${query.toString()}`,
      );
      const payload = (await response.json().catch(() => ({}))) as {
        path?: string;
        home?: string;
        parent?: string | null;
        entries?: RemoteFileEntry[];
        error?: string;
      };
      if (!response.ok || !payload.path) {
        throw new Error(payload.error || "读取远端目录失败");
      }
      setManualAgentBrowsePath(payload.path);
      setManualAgentBrowseHome(payload.home || "");
      setManualAgentBrowseParent(payload.parent ?? null);
      setManualAgentBrowseEntries(
        (payload.entries || []).filter((entry) => entry.type === "directory"),
      );
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "读取远端目录失败");
    } finally {
      setManualAgentBrowseLoading(false);
    }
  };

  const openManualAgentPicker = () => {
    if (connection.status !== "connected" || !effectiveServerId) return;
    setAgentMenuOpen(false);
    setAgentMenuPage("root");
    setManualAgentPickerOpen(true);
    void browseManualAgentDirectory("~");
  };

  const addManualAgent = () => {
    if (
      !manualAgentBrowsePath ||
      socketRef.current?.readyState !== WebSocket.OPEN
    ) return;
    socketRef.current.send(
      JSON.stringify({
        type: "agent.add",
        serverId: effectiveServerId,
        folder: manualAgentBrowsePath,
      }),
    );
    setManualAgentPickerOpen(false);
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
        conversationId: activeConversationId,
        workspaceId: activeWorkspace?.id || "",
        requestId: uid("config"),
      }),
    );
  };

  const openAgentSettings = (agent: AgentItem) => {
    setAgentConfigAgentId(agent.id);
    setAgentMenuPage("config");
    void loadAgentContextForMenu(agent);
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
        label: `正在准备 ${configAgent.name} 配置`,
      },
    }));
    if (connection.demo) {
      window.setTimeout(() => {
        setAgentModelsByServer((current) => ({
          ...current,
          [effectiveServerId]: {
            status: "done",
            model: modelId,
            label: `${configAgent.name} 已切换到 ${modelId}`,
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
        conversationId: activeConversationId,
        workspaceId: activeWorkspace?.id || "",
      }),
    );
  };

  const handleAgentRuntimeSettingChange = (
    event: React.ChangeEvent<HTMLSelectElement>,
  ) => {
    const socket = socketRef.current;
    if (
      !configAgent?.managed ||
      !effectiveServerId ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    setAgentRuntimeConfig({
      agentId: configAgent.id,
      status: "configuring",
      label: "配置中",
    });
    socket.send(
      JSON.stringify({
        type: "agent.runtime.configure",
        serverId: effectiveServerId,
        agentId: configAgent.id,
        conversationId: activeConversationId,
        workspaceId: activeWorkspace?.id || "",
        field: event.currentTarget.dataset.field || "",
        value: event.currentTarget.value,
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
        conversationId: activeConversationId,
        workspaceId: activeWorkspace?.id || "",
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

  const refreshMemorySummary = async () => {
    const response = await gatewayFetch("/api/memories/overview", {
      method: "POST",
    });
    if (!response.ok) throw new Error("记忆摘要刷新失败");
    const payload = (await response.json()) as { overview?: string };
    setState((current) => ({
      ...current,
      memorySummary: payload.overview || "当前没有启用的长期记忆。",
    }));
    showToast("记忆摘要已刷新");
  };

  const addMemory = () => {
    const id = uid("memory-draft");
    setState((current) => ({
      ...current,
      memories: [
        {
          id,
          content: "",
          scope: "user",
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

  const saveMemoryItem = async (memory: MemoryItem, content: string) => {
    const normalized = content.trim();
    if (!normalized) return;
    const creating = memory.id.startsWith("memory-draft");
    const response = await gatewayFetch(
      creating ? "/api/memories" : `/api/memories/${encodeURIComponent(memory.id)}`,
      {
        method: creating ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          creating
            ? {
                content: normalized,
                scope: memory.scope,
                scopeId: memory.scopeId,
                kind: memory.kind,
              }
            : { content: normalized },
        ),
      },
    );
    if (!response.ok) throw new Error("记忆保存失败");
    const payload = (await response.json()) as {
      record?: Record<string, unknown>;
    };
    if (!payload.record) return;
    const saved = memoryItemFromApi(payload.record);
    setState((current) => ({
      ...current,
      memories: [
        saved,
        ...current.memories.filter((item) => item.id !== memory.id && item.id !== saved.id),
      ],
      memorySummary: "",
    }));
    setEditingMemoryId("");
  };

  const toggleMemory = async (memory: MemoryItem) => {
    const response = await gatewayFetch(
      `/api/memories/${encodeURIComponent(memory.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !memory.enabled }),
      },
    );
    if (!response.ok) throw new Error("记忆状态更新失败");
    const payload = (await response.json()) as {
      record?: Record<string, unknown>;
    };
    if (!payload.record) return;
    const saved = memoryItemFromApi(payload.record);
    setState((current) => ({
      ...current,
      memories: current.memories.map((item) =>
        item.id === memory.id ? saved : item,
      ),
      memorySummary: "",
    }));
  };

  const deleteMemory = async (memoryId: string) => {
    const response = await gatewayFetch(
      `/api/memories/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error("记忆删除失败");
    setState((current) => ({
      ...current,
      memories: current.memories.filter((item) => item.id !== memoryId),
      memorySummary: "",
    }));
  };

  const applyMemoryInstruction = async () => {
    const instruction = memoryInstruction.trim();
    if (!instruction) return;
    const response = await gatewayFetch("/api/memories/instruction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction }),
    });
    if (!response.ok) throw new Error("记忆更新失败");
    const payload = (await response.json()) as {
      records?: Record<string, unknown>[];
      overview?: string;
    };
    setState((current) => ({
      ...current,
      memories: (payload.records ?? []).map(memoryItemFromApi),
      memorySummary: payload.overview || "",
    }));
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
                            <ProjectOptionsMenu
                              project={project}
                              menuOpen={projectMenuId === project.id}
                              onToggleMenu={() =>
                                setProjectMenuId((current) =>
                                  current === project.id ? "" : project.id,
                                )
                              }
                              onRename={() => {
                                setProjectEditor({ project, mode: "rename" });
                                setProjectMenuId("");
                              }}
                              onSettings={() => {
                                setProjectEditor({ project, mode: "settings" });
                                setProjectMenuId("");
                              }}
                              onOpenHome={() => {
                                openProject(project.id);
                                setProjectMenuId("");
                              }}
                              onTogglePin={() => {
                                toggleProjectPin(project.id);
                                setProjectMenuId("");
                              }}
                              onDelete={() => {
                                setProjectPendingDelete(project);
                                setProjectMenuId("");
                              }}
                            />
                          </div>
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

          <div className="topbar-actions" />
        </header>

        {view === "chat" && (
          <section
            className={`conversation-surface${
              mode === "work" && connection.status === "connected"
                ? " workspace-toolbar"
                : ""
            }`}
          >
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
                <div className={`conversation-mode-stack ${mode}`}>
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
              </div>

              <div className="conversation-toolbar-right">
                {mode === "work" && connection.status === "connected" && (
                  <div className="agent-selector">
                    <button
                      className={`agent-picker${activeAgentScanning ? " scanning" : ""}`}
                      type="button"
                      aria-expanded={agentMenuOpen}
                      disabled={activeAgentScanning}
                      onClick={() =>
                        setAgentMenuOpen((current) => {
                          if (!current) setAgentMenuPage("root");
                          return !current;
                        })
                      }
                    >
                      {activeAgentScanning ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <Bot size={15} />
                      )}
                      <span>
                        {activeAgentScanning
                          ? "扫描中"
                          : activeAgent?.status === "ready"
                          ? activeAgent.name
                          : "选择 Agent"}
                      </span>
                      {!activeAgentScanning &&
                        activeAgent?.status === "ready" && (
                          <AgentContextRing usage={contextUsage?.agent ?? null} />
                        )}
                      {!activeAgentScanning && <ChevronDown size={13} />}
                    </button>
                    {agentMenuOpen && (
                      <div
                        className={`agent-dropdown show-${agentMenuPage}`}
                        style={
                          {
                            "--agent-menu-height":
                              agentMenuPage === "config"
                                ? `${agentConfigMenuHeight}px`
                                : agentMenuPage === "models"
                                  ? `${Math.min(
                                      350,
                                      112 + Math.max(providerModels.length, 1) * 40,
                                    )}px`
                                  : `${Math.min(
                                      390,
                                      54 + Math.max(agents.length, 1) * 58,
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
                                      <strong>
                                        <span>{agent.name}</span>
                                        {agent.status === "ready" && agent.version && (
                                          <em className="agent-version">
                                            {agentVersionText(agent.version)}
                                          </em>
                                        )}
                                      </strong>
                                      <small className="agent-deployment-label">
                                        {agent.status === "missing"
                                          ? "未安装"
                                          : agent.status === "installing"
                                            ? agent.detail || "安装中"
                                            : `${
                                                agent.managed
                                                  ? "easywork部署"
                                                  : "用户部署"
                                              }${
                                                agent.configured
                                                  ? ""
                                                  : " · 需要配置"
                                              }`}
                                      </small>
                                    </span>
                                    {agent.id === activeAgentId &&
                                      agent.status === "ready" && (
                                        <Check size={14} />
                                      )}
                                  </button>
                                  {agent.status === "missing" ? (
                                    <button
                                      className="agent-inline-install"
                                      type="button"
                                      onClick={() => installManagedAgent(agent.id)}
                                      disabled={connection.status !== "connected"}
                                    >
                                      <Download size={13} />
                                      安装
                                    </button>
                                  ) : agent.status === "installing" ? (
                                    <button
                                      className="agent-inline-install installing"
                                      type="button"
                                      disabled
                                    >
                                      <LoaderCircle className="spin" size={13} />
                                    </button>
                                  ) : agent.managed ? (
                                    <span className="agent-row-actions">
                                      <button
                                        className={`agent-update-shortcut ${
                                          activeAgentUpdate.agentId === agent.id
                                            ? activeAgentUpdate.status
                                            : "idle"
                                        }`}
                                        type="button"
                                        onClick={() => checkAgentUpdate(agent)}
                                        disabled={
                                          activeAgentUpdate.agentId === agent.id &&
                                          [
                                            "checking",
                                            "downloading",
                                            "updating",
                                            "configuring",
                                          ].includes(activeAgentUpdate.status)
                                        }
                                        aria-label={`检测 ${agent.name} 更新`}
                                        title="与主机版本对比"
                                      >
                                        <RefreshCw
                                          className={
                                            [
                                              "checking",
                                              "downloading",
                                              "updating",
                                              "configuring",
                                            ].includes(activeAgentUpdate.status) &&
                                            activeAgentUpdate.agentId === agent.id
                                              ? "spin"
                                              : undefined
                                          }
                                          size={14}
                                        />
                                      </button>
                                      <button
                                        className="agent-config-shortcut"
                                        type="button"
                                        onClick={() => openAgentSettings(agent)}
                                        aria-label={`配置 ${agent.name}`}
                                      >
                                        <ChevronRight size={15} />
                                      </button>
                                    </span>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                            <div className="agent-dropdown-actions">
                              <button
                                type="button"
                                onClick={openManualAgentPicker}
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
                            {configAgent?.managed && (
                              <button
                                className="agent-menu-option"
                                type="button"
                                onClick={() => openAgentConfig(configAgent)}
                              >
                                <FileText size={16} />
                                <span>打开配置</span>
                              </button>
                            )}
                            {configAgent?.managed &&
                              ["opencode", "codex", "claude"].includes(
                                configAgent.adapter,
                              ) && (
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
                            {configAgent?.managed && (
                              <small
                                className="agent-current-model"
                                title={
                                  activeAgentModelConfig.model ||
                                  configAgent.model ||
                                  ""
                                }
                              >
                                当前模型 · {activeAgentModelConfig.model ||
                                  configAgent.model ||
                                  "尚未选择"}
                              </small>
                            )}
                            {configAgent?.managed &&
                              (["reasoning", "permission", "sandbox"] as const).map(
                                (field) => {
                                  const descriptor =
                                    configAgent.configurationSchema?.[field];
                                  if (!descriptor?.options?.length) return null;
                                  return (
                                    <label
                                      className="agent-native-setting"
                                      key={field}
                                    >
                                      <span>{descriptor.label}</span>
                                      <select
                                        data-field={field}
                                        value={descriptor.value}
                                        disabled={
                                          agentRuntimeConfig.status === "configuring" &&
                                          agentRuntimeConfig.agentId === configAgent.id
                                        }
                                        onChange={handleAgentRuntimeSettingChange}
                                      >
                                        {descriptor.options.map((option) => (
                                          <option value={option} key={option}>
                                            {agentSettingOptionLabel(option)}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                  );
                                },
                              )}
                            {configAgent?.status === "ready" && (
                              <AgentContextControls
                                key={`${configAgent.id}:${
                                  (
                                    agentContextById[
                                      agentContextCacheKey(
                                        activeConversationId,
                                        effectiveServerId,
                                        activeWorkspace?.id || "",
                                        configAgent.id,
                                      )
                                    ] ||
                                    (configAgent.id === activeAgentId
                                      ? contextUsage?.agent
                                      : null)
                                  )?.limit ?? configAgent.contextLimit ?? ""
                                }`}
                                agent={configAgent}
                                usage={
                                  agentContextById[
                                    agentContextCacheKey(
                                      activeConversationId,
                                      effectiveServerId,
                                      activeWorkspace?.id || "",
                                      configAgent.id,
                                    )
                                  ] ||
                                  (configAgent.id === activeAgentId
                                    ? contextUsage?.agent ?? null
                                    : null)
                                }
                                busyAction={contextBusyAction}
                                onSave={(limit) =>
                                  saveAgentContextSettings(limit, configAgent)
                                }
                                onCompress={() =>
                                  compressAgentContext(configAgent)
                                }
                              />
                            )}
                            {configAgent?.managed &&
                              configAgent.status === "ready" && (
                                <div className="agent-config-footer">
                                  {agentRuntimeConfig.status === "configuring" &&
                                  agentRuntimeConfig.agentId === configAgent.id ? (
                                    <span className="agent-runtime-configuring">
                                      <LoaderCircle className="spin" size={14} />
                                      配置中
                                    </span>
                                  ) : (
                                    <span aria-hidden="true" />
                                  )}
                                  <button
                                    className="agent-menu-option danger agent-uninstall-option"
                                    type="button"
                                    disabled={uninstallingAgentId === configAgent.id}
                                    onClick={() =>
                                      setAgentPendingUninstall(configAgent)
                                    }
                                  >
                                    {uninstallingAgentId === configAgent.id ? (
                                      <LoaderCircle className="spin" size={16} />
                                    ) : (
                                      <Trash2 size={16} />
                                    )}
                                    <span>
                                      {uninstallingAgentId === configAgent.id
                                        ? "卸载中"
                                        : "卸载 Agent"}
                                    </span>
                                  </button>
                                </div>
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
                    <span className="work-connection-copy">
                      <span className="work-connection-status-line">
                        {connection.status === "connecting" ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : connection.status === "connected" ? (
                          <Wifi size={14} />
                        ) : (
                          <WifiOff size={14} />
                        )}
                        <strong>
                          {connection.status === "connected"
                            ? "已连接"
                            : connection.status === "connecting"
                              ? "连接中"
                              : "未连接"}
                        </strong>
                      </span>
                    </span>
                  </button>
                )}
              </div>
            </div>
            <div
              className="messages-scroll"
              ref={messagesScrollRef}
              onScroll={trackMessageScrollPosition}
            >
              {!activeConversation?.messages.length ? (
                <div
                  className={`empty-chat${appLoading ? " loading" : ""}`}
                  aria-busy={appLoading}
                  aria-live="polite"
                >
                  {appLoading ? (
                    <div className="workspace-loading-indicator">
                      <LoaderCircle className="spin" size={23} />
                      <span>正在加载</span>
                    </div>
                  ) : (
                    <>
                      <div>
                        <h1>
                          {mode === "chat"
                            ? "有什么可以帮你？"
                            : "在算力平台上开始工作"}
                        </h1>
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
                        !activeWorkspace && (
                          <button
                            className="inline-connect workspace"
                            type="button"
                            onClick={() => void openWorkspacePicker()}
                          >
                            <FolderOpen size={16} />
                            选择工作区
                          </button>
                        )}
                      {mode === "work" &&
                        connection.status === "connected" &&
                        Boolean(activeWorkspace) &&
                        !activeAgentScanning &&
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
                    </>
                  )}
                </div>
              ) : (
                <div className="message-list">
                  {activeConversation.messages.map((message, messageIndex) => (
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
                              message.mode === "work"
                                ? message.reasoningStatus === "running"
                                : sending &&
                                  message.id ===
                                    activeConversation.messages.at(-1)?.id &&
                                  !message.content
                            }
                          />
                        )}
                        {message.role === "assistant" &&
                          message.mode === "work" &&
                          message.reasoningStatus !== "running" && (
                            <WorkEventFeed
                              events={message.events ?? []}
                              finalAnswerStarted={Boolean(message.content)}
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
                                  ? (event, approved, answers) =>
                                      respondToApproval(
                                        activeConversation.id,
                                        message.runId!,
                                        event,
                                        approved,
                                        answers,
                                      )
                                  : undefined
                              }
                            />
                          )}
                        {message.content ? (
                          <div className="message-text">
                            {message.role === "user" &&
                            editingMessageId === message.id ? (
                              <div className="message-inline-editor">
                                <textarea
                                  value={editingMessageText}
                                  rows={3}
                                  autoFocus
                                  aria-label="编辑用户消息"
                                  onChange={(event) =>
                                    setEditingMessageText(event.target.value)
                                  }
                                />
                                <div className="message-inline-editor-actions">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingMessageId("");
                                      setEditingMessageText("");
                                    }}
                                  >
                                    取消
                                  </button>
                                  <button
                                    className="primary"
                                    type="button"
                                    disabled={!editingMessageText.trim()}
                                    onClick={() =>
                                      void actOnConversationMessage(
                                        "edit",
                                        message,
                                        editingMessageText,
                                      )
                                    }
                                  >
                                    发送
                                  </button>
                                </div>
                              </div>
                            ) : message.role === "assistant" ? (
                              <>
                                <MarkdownContent
                                  content={stripEasyWorkProtocolText(message.content)}
                                />
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
                        {message.content && editingMessageId !== message.id && (
                          <div className="message-actions" aria-label="消息操作">
                            <button
                              type="button"
                              title="复制"
                              aria-label="复制消息"
                              onClick={() => {
                                void copyPlainText(message.content).then(() =>
                                  showToast("已复制"),
                                );
                              }}
                            >
                              <Copy size={14} />
                            </button>
                            {message.role === "user" &&
                              message.id === lastUserMessageId &&
                              !sending && (
                                <button
                                  type="button"
                                  title="编辑"
                                  aria-label="编辑消息"
                                  onClick={() => {
                                    setEditingMessageId(message.id);
                                    setEditingMessageText(message.content);
                                  }}
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                            {message.role === "assistant" && !sending && (
                              <>
                                {message.id === lastAssistantMessageId && (
                                  <button
                                    type="button"
                                    title="重置"
                                    aria-label="重置最新回复"
                                    onClick={() =>
                                      void actOnConversationMessage(
                                        "reset",
                                        message,
                                      )
                                    }
                                  >
                                    <RefreshCw size={14} />
                                  </button>
                                )}
                                {messageIndex <
                                  activeConversation.messages.length - 1 && (
                                  <button
                                    type="button"
                                    title="回溯"
                                    aria-label="回溯到这条回复"
                                    onClick={() =>
                                      void actOnConversationMessage(
                                        "rewind",
                                        message,
                                      )
                                    }
                                  >
                                    <History size={14} />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  title="分支"
                                  aria-label="创建对话分支"
                                  onClick={() =>
                                    void actOnConversationMessage(
                                      "branch",
                                      message,
                                    )
                                  }
                                >
                                  <GitBranch size={14} />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="composer-zone">
              <div className="composer-with-context">
                <UnifiedComposer
                  value={draft}
                  textareaRef={textareaRef}
                  disabled={appLoading || (mode === "work" && !workReady)}
                  sending={mode === "work" ? activeWorkSending : sending}
                  allowSubmitWhileSending={canAppendToActiveRun}
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
                    appLoading
                      ? "正在加载 EasyWork"
                      : canAppendToActiveRun
                        ? "追加对当前任务的要求"
                      : mode === "chat"
                      ? "给 EasyWork 发消息"
                      : connection.status !== "connected"
                        ? "请先连接远程服务器"
                        : !activeWorkspace
                          ? "请先选择工作区"
                        : !activeAgent || activeAgent.status === "missing"
                          ? "请先安装或选择 Agent"
                          : !activeAgent.configured
                            ? "请先完成 Agent 模型配置"
                            : "描述要在远程服务器完成的工作"
                  }
                />
                {activeConversation && (
                  <WebContextMeter
                    usage={contextUsage}
                    loading={contextLoading}
                    onOpen={() => setContextModalOpen(true)}
                  />
                )}
              </div>
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
                disabled={appLoading}
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
                  onClick={() =>
                    void refreshMemorySummary().catch(() =>
                      showToast("记忆摘要刷新失败"),
                    )
                  }
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
                      if (event.key === "Enter") {
                        void applyMemoryInstruction().catch(() =>
                          showToast("记忆更新失败"),
                        );
                      }
                    }}
                    placeholder="告诉 EasyWork 要修改、补充或忘记什么"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void applyMemoryInstruction().catch(() =>
                        showToast("记忆更新失败"),
                      )
                    }
                  >
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
                    <strong>自动记录</strong>
                    <small>从明确要求和已完成结果中提取可复用记忆</small>
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
                {([
                  ["all", "全部"],
                  ["user", "全局"],
                  ["project", "项目"],
                  ["conversation", "对话"],
                  ["workspace", "工作区"],
                  ["task", "任务"],
                ] as const).map(([scope, label]) => (
                  <button
                    className={memoryFilter === scope ? "active" : ""}
                    type="button"
                    key={scope}
                    onClick={() => setMemoryFilter(scope)}
                  >
                    {label}
                  </button>
                ))}
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
                          void saveMemoryItem(memory, editingMemoryText).catch(() =>
                            showToast("记忆保存失败"),
                          );
                        }}
                        autoFocus
                      />
                    ) : (
                      <p>{memory.content}</p>
                    )}
                    <span>
                      <b className={memory.scope}>
                        {memory.scope === "user"
                          ? "全局"
                          : memory.scope === "project"
                            ? state.projects.find((project) => project.id === memory.scopeId)?.name ??
                              "项目"
                            : memory.scope === "workspace"
                              ? "工作区"
                              : memory.scope === "conversation"
                                ? "对话"
                                : "任务"}
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
                        void toggleMemory(memory).catch(() =>
                          showToast("记忆状态更新失败"),
                        )
                      }
                    />
                    <span />
                  </label>
                  <button
                    type="button"
                    aria-label={editingMemoryId === memory.id ? "保存记忆" : "编辑记忆"}
                    onClick={() => {
                      if (editingMemoryId === memory.id) {
                        void saveMemoryItem(memory, editingMemoryText).catch(() =>
                          showToast("记忆保存失败"),
                        );
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
                      void deleteMemory(memory.id).catch(() =>
                        showToast("记忆删除失败"),
                      )
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
            <>
            <section className={`remote-connection-panel ${connection.status}`}>
            <div className="remote-connection-heading">
              <span>远程连接</span>
              <span className="remote-connection-state">
                <i />
                {connection.status === "connected"
                  ? "已连接"
                  : connection.status === "connecting"
                    ? "连接中"
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
          <section className="workspace-rail-panel">
            <div className="workspace-rail-heading">
              <span>当前工作区</span>
              <button
                type="button"
                disabled={activeWorkSending || workspaceSwitchBusy}
                onClick={() => void openWorkspacePicker()}
              >
                {workspacePickerLoading ? (
                  <LoaderCircle className="spin" size={13} />
                ) : null}
                更改
              </button>
            </div>
            <code title={activeWorkspace?.path || undefined}>
              {activeWorkspace?.path ||
                (connection.status === "connected"
                  ? "虚拟工作区将在首次执行时分配"
                  : "连接服务器后可选择工作区")}
            </code>
          </section>
          </>
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
                onClick={() => void deleteConversation(conversationPendingDelete.id)}
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
          conversations={state.conversations.filter(
            (conversation) => conversation.mode === "work",
          )}
          context={sshModalContext}
          conversationEnabled={conversationConnectionEnabled}
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
          onSetConversationConnection={setConversationConnection}
          onSetCurrentConversationConnection={(enabled) => {
            if (activeConversation) {
              setConversationConnection(activeConversation.id, enabled);
            }
          }}
          onRetry={() => setGatewayProbe((current) => current + 1)}
        />
      )}
      {workspacePickerOpen && (
        <WorkspacePickerModal
          serverName={
            activeServerProfile?.name || connection.host || "远程服务器"
          }
          activeWorkspaceKind={activeWorkspace?.kind || "virtual"}
          activeWorkspacePath={activeWorkspace?.path || ""}
          conversationId={activeConversation?.id || ""}
          purpose={workspacePickerPurpose}
          path={workspaceBrowsePath}
          home={workspaceBrowseHome}
          parent={workspaceBrowseParent}
          entries={workspaceBrowseEntries}
          loading={workspacePickerLoading}
          onBrowse={(path) =>
            void browseWorkspaceDirectory(effectiveServerId, path)
          }
          onChooseVirtual={() => void chooseVirtualWorkspace()}
          onChooseCurrent={() => void registerCurrentWorkspace()}
          onClose={() => setWorkspacePickerOpen(false)}
        />
      )}
      {pendingVirtualWrite && !workspacePickerOpen && (
        <Modal
          title="确认本轮写入范围"
          onClose={() =>
            !dynamicWorkspaceBusy && setPendingVirtualWrite(null)
          }
          wide
        >
          <div className="dynamic-workspace-confirm">
            <div className="dynamic-workspace-intro">
              <span><Sparkles size={16} /></span>
              <div>
                <strong>当前对话使用虚拟工作区</strong>
                <p>
                  EasyWork 检测到这条指令可能修改远端状态。选择真实目录后，本轮会使用该目录对应的 Agent 会话；任务结束后仍返回虚拟工作区。
                  同一对话再次以同一 Agent 写入同一目录时，会继续复用这条 Agent 会话。
                </p>
              </div>
            </div>

            {pendingVirtualWrite.suggestedPaths.length > 0 && (
              <section className="dynamic-workspace-suggestions">
                <strong>指令中识别到的路径</strong>
                <div>
                  {pendingVirtualWrite.suggestedPaths.map((path) => (
                    <button
                      type="button"
                      key={path}
                      disabled={dynamicWorkspaceBusy}
                      onClick={() => void chooseSuggestedDynamicWorkspace(path)}
                    >
                      <Folder size={14} />
                      <code>{path}</code>
                    </button>
                  ))}
                </div>
                <small>如果识别到的是文件而不是文件夹，请改用目录浏览器选择其上级目录。</small>
              </section>
            )}

            <section className={`dynamic-workspace-target${pendingVirtualWrite.target ? " selected" : ""}`}>
              {pendingVirtualWrite.target ? (
                <>
                  <span className="dynamic-workspace-target-icon"><FolderOpen size={18} /></span>
                  <div>
                    <strong>{pendingVirtualWrite.target.name}</strong>
                    <code>{pendingVirtualWrite.target.path}</code>
                    <small>
                      {!pendingVirtualWrite.target.writable
                        ? "该目录只读，不能作为写入目标"
                        : pendingVirtualWrite.target.mode === "unmanaged"
                          ? "可以执行，但没有 Git 检查点，文件修改不能自动重置"
                          : "将创建运行前后检查点；同一 Git 仓库共享版本顺序"}
                    </small>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openWorkspacePicker("dynamic")}
                  >
                    更换
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={dynamicWorkspaceBusy}
                  onClick={() => void openWorkspacePicker("dynamic")}
                >
                  <FolderPlus size={17} />
                  选择真实写入目录
                </button>
              )}
            </section>

            <div className="dynamic-workspace-outcomes">
              <p><ShieldCheck size={14} />只读查询不会修改真实项目。</p>
              <p><GitBranch size={14} />同一 Git 仓库或路径重叠的目录不会并发运行。</p>
              <p><HardDrive size={14} />软件安装、作业、服务和范围外文件不属于可回退的文件版本。</p>
            </div>

            <div className="modal-actions dynamic-workspace-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={dynamicWorkspaceBusy}
                onClick={() => setPendingVirtualWrite(null)}
              >
                取消
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={dynamicWorkspaceBusy}
                onClick={() => void continuePendingVirtualWrite(true)}
                title="真实目录之外的修改不会纳入版本管理"
              >
                仅在虚拟目录执行
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  dynamicWorkspaceBusy ||
                  !pendingVirtualWrite.target ||
                  !pendingVirtualWrite.target.writable
                }
                onClick={() => void continuePendingVirtualWrite(false)}
              >
                {dynamicWorkspaceBusy && <LoaderCircle className="spin" size={14} />}
                确认目标并执行
              </button>
            </div>
          </div>
        </Modal>
      )}
      {workspaceSwitchPending && activeConversation && (
        <Modal
          title="切换工作区？"
          onClose={() =>
            !workspaceSwitchBusy && setWorkspaceSwitchPending(null)
          }
        >
          <div className="workspace-switch-confirm">
            <div className="workspace-switch-route" aria-hidden="true">
              <span>{activeWorkspace?.name || "当前工作区"}</span>
              <ChevronRight size={16} />
              <strong>{workspaceSwitchPending.name}</strong>
            </div>
            <p>
              {workspaceSwitchPending.kind === "virtual"
                ? "切换后不再固定真实项目目录。查询和临时文件在对话专属目录中完成；需要写入真实目录时，EasyWork 会逐次确认目标，并复用该目录与 Agent 对应的原生会话。网页对话、项目上下文和整体记忆保持不变。"
                : "切换后会使用该工作区对应的 Agent 会话。网页对话、项目上下文和整体记忆会继续保留；再次切回时会恢复原 Agent 会话，并补齐期间新增的记忆。"}
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={workspaceSwitchBusy}
                onClick={() => setWorkspaceSwitchPending(null)}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={workspaceSwitchBusy}
                onClick={() =>
                  void applyWorkspaceToConversation(
                    activeConversation.id,
                    workspaceSwitchPending,
                  )
                }
              >
                {workspaceSwitchBusy && (
                  <LoaderCircle className="spin" size={14} />
                )}
                确认切换
              </button>
            </div>
          </div>
        </Modal>
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
          agentName={
            agents.find((agent) => agent.id === activeAgentUpdate.agentId)?.name ||
            "Agent"
          }
          onUpdate={applyAgentUpdate}
          onRetry={() =>
            checkAgentUpdate(
              agents.find(
                (agent) => agent.id === activeAgentUpdate.agentId,
              ) || activeAgent,
            )
          }
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
      {manualAgentPickerOpen && (
        <AgentDirectoryPickerModal
          path={manualAgentBrowsePath}
          home={manualAgentBrowseHome}
          parent={manualAgentBrowseParent}
          entries={manualAgentBrowseEntries}
          loading={manualAgentBrowseLoading}
          onBrowse={(path) => void browseManualAgentDirectory(path)}
          onChoose={addManualAgent}
          onClose={() => setManualAgentPickerOpen(false)}
        />
      )}
      {agentPendingUninstall && (
        <Modal
          title={`卸载 ${agentPendingUninstall.name}`}
          onClose={() => setAgentPendingUninstall(null)}
        >
          <div className="confirmation-dialog agent-uninstall-dialog">
            <p>
              将从当前服务器删除 EasyWork 部署的 Agent 应用。已有网页对话与配置会保留，重新安装后仍可继续使用。
            </p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setAgentPendingUninstall(null)}
              >
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => uninstallManagedAgent(agentPendingUninstall)}
              >
                <Trash2 size={15} />
                确认卸载
              </button>
            </div>
          </div>
        </Modal>
      )}
      {contextModalOpen && (
        <ContextDetailModal
          key={`${contextUsage?.web.limit ?? 0}:${contextUsage?.web.automaticCompressionThreshold ?? 0}`}
          usage={contextUsage}
          busyAction={contextBusyAction}
          onClose={() => setContextModalOpen(false)}
          onSaveWeb={saveContextSettings}
          onCompressWeb={compressCurrentContext}
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
          <label className={memoryMode === "project-and-global" ? "selected" : ""}>
            <input
              type="radio"
              name="memory-mode"
              checked={memoryMode === "project-and-global"}
              onChange={() => setMemoryMode("project-and-global")}
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
            <label className={memoryMode === "project-and-global" ? "selected" : ""}>
              <input
                type="radio"
                name="edit-memory-mode"
                checked={memoryMode === "project-and-global"}
                onChange={() => setMemoryMode("project-and-global")}
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
  conversations,
  context,
  conversationEnabled,
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
  onSetConversationConnection,
  onSetCurrentConversationConnection,
  onRetry,
}: {
  profiles: ServerProfile[];
  connections: Record<string, ConnectionState>;
  conversations: Conversation[];
  context: "manage" | "new-work" | "bound";
  conversationEnabled: boolean;
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
    keyName?: string;
    password?: string;
    useSavedCredential?: boolean;
    rememberCredential?: boolean;
    passphrase?: string;
    otp?: string;
    trustHost?: boolean;
  }) => void;
  onDisconnect: (serverId: string) => void;
  onSetConversationConnection: (
    conversationId: string,
    enabled: boolean,
  ) => void;
  onSetCurrentConversationConnection: (enabled: boolean) => void;
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
  const [activeTab, setActiveTab] = useState<"configuration" | "conversations">(
    "configuration",
  );
  const connection = connections[serverId] ?? {
    serverId,
    status: "disconnected",
    label: "尚未连接",
  };
  const selectedProfile = profiles.find((profile) => profile.id === serverId);
  const serverConversations = conversations.filter(
    (conversation) => conversation.work?.serverId === serverId,
  );
  const boundConversations = serverConversations.filter(
    (conversation) => conversation.work?.connectionEnabled !== false,
  );
  const displayedConnectionStatus =
    context === "bound" && !conversationEnabled
      ? "disconnected"
      : connection.status;
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
    setActiveTab("configuration");
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
    setActiveTab("configuration");
    setTrustHost(false);
    onSelect(nextId);
  };

  const connectSavedProfile = () => {
    if (!selectedProfile?.configured) {
      setConfigurationOpen(true);
      return;
    }
    if (context === "bound") onSetCurrentConversationConnection(true);
    onConnect({
      serverId: selectedProfile.id,
      name: selectedProfile.name,
      host: selectedProfile.host,
      port: selectedProfile.port || 22,
      username: selectedProfile.username,
      authMethod: selectedProfile.authMethod || "key",
      useSavedCredential: true,
      otp: otp.trim() || undefined,
      trustHost: Boolean(connection.fingerprint && trustHost),
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
          {context === "manage" && selectedProfile && (
            <div className="server-detail-tabs" role="tablist" aria-label="服务器管理">
              <button
                className={activeTab === "configuration" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={activeTab === "configuration"}
                onClick={() => {
                  setActiveTab("configuration");
                  if (connection.status === "connected") {
                    setConfigurationOpen(false);
                  }
                }}
              >
                服务器配置
              </button>
              <button
                className={activeTab === "conversations" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={activeTab === "conversations"}
                onClick={() => setActiveTab("conversations")}
              >
                管理连接对话
                <span>{boundConversations.length}</span>
              </button>
            </div>
          )}
          {context === "manage" &&
          activeTab === "conversations" &&
          selectedProfile ? (
            <div className="server-conversation-panel">
              <div className="server-conversation-summary">
                <div>
                  <strong>{selectedProfile.name || selectedProfile.host}</strong>
                  <span>
                    {connection.status === "connected"
                      ? `已连接 ${boundConversations.length} 个对话`
                      : `${boundConversations.length} 个对话`}
                  </span>
                </div>
                <span className={`server-conversation-live ${connection.status}`}>
                  {connection.status === "connected" ? "SSH 在线" : "SSH 未连接"}
                </span>
              </div>
              <div className="server-conversation-table" role="table">
                <div className="server-conversation-table-head" role="row">
                  <span role="columnheader">对话</span>
                  <span role="columnheader">状态</span>
                  <span role="columnheader">操作</span>
                </div>
                {serverConversations.map((conversation) => {
                  const enabled = conversation.work?.connectionEnabled !== false;
                  const running = conversation.messages.some(
                    (message) => message.trace?.status === "running",
                  );
                  const status = running
                    ? "执行中"
                    : enabled
                      ? connection.status === "connected"
                        ? "已连接"
                        : "服务器离线"
                      : "已断开";
                  return (
                    <div
                      className={`server-conversation-row${enabled ? " bound" : ""}`}
                      role="row"
                      key={conversation.id}
                    >
                      <span className="server-conversation-title" role="cell">
                        <strong>{conversation.title || "未命名对话"}</strong>
                        <small>工作</small>
                      </span>
                      <span
                        className={`server-conversation-status ${
                          running
                            ? "running"
                            : enabled
                              ? connection.status
                              : "idle"
                        }`}
                        role="cell"
                      >
                        <i />
                        {status}
                      </span>
                      <button
                        className={`server-conversation-action ${
                          enabled ? "disconnect" : "connect"
                        }`}
                        type="button"
                        disabled={running || connection.status !== "connected"}
                        title={
                          connection.status !== "connected"
                            ? "SSH 未连接"
                            : running
                              ? "对话正在执行任务"
                              : enabled
                                ? "断开这个对话"
                                : "连接这个对话"
                        }
                        onClick={() =>
                          onSetConversationConnection(
                            conversation.id,
                            !enabled,
                          )
                        }
                      >
                        {enabled ? "断开" : "连接"}
                      </button>
                    </div>
                  );
                })}
                {!serverConversations.length && (
                  <div className="server-conversation-empty">
                    还没有对话绑定到这台服务器
                  </div>
                )}
              </div>
            </div>
          ) : gatewayStatus !== "connected" ? (
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
          ) : ((context !== "manage" && selectedProfile) ||
              (context === "manage" && connection.status === "connected")) &&
            !configurationOpen &&
            selectedProfile ? (
            <div
              className={`connected-panel server-connected-panel quick-connection-panel ${displayedConnectionStatus}`}
            >
              <span className="connected-hero">
                {displayedConnectionStatus === "connecting" ? (
                  <LoaderCircle className="spin" size={24} />
                ) : displayedConnectionStatus === "connected" ? (
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
                    {displayedConnectionStatus === "connected"
                      ? `已连接 ${boundConversations.length} 个对话`
                      : displayedConnectionStatus === "connecting"
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
              {displayedConnectionStatus === "error" && !connection.fingerprint && (
                <div className="form-error" role="alert">
                  {connection.label}
                </div>
              )}
              {displayedConnectionStatus === "error" && connection.fingerprint && (
                <div className="host-key-confirm quick-host-key-confirm">
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
              <div className="quick-connection-actions">
                <button
                  className="secondary-button quick-config-button"
                  type="button"
                  onClick={() => setConfigurationOpen(true)}
                >
                  <Settings2 size={15} />
                  配置
                </button>
                {displayedConnectionStatus === "connected" ? (
                  context === "new-work" ? (
                    <button
                      className="primary-button quick-use-button"
                      type="button"
                      onClick={() => {
                        onSelect(serverId);
                        onClose();
                      }}
                    >
                      <Check size={15} />
                      使用此连接
                    </button>
                  ) : (
                    <button
                      className="secondary-button quick-disconnect-button"
                      type="button"
                      onClick={() => {
                        if (context === "bound") {
                          onSetCurrentConversationConnection(false);
                        } else {
                          onDisconnect(serverId);
                        }
                      }}
                    >
                      <WifiOff size={15} />
                      断开连接
                    </button>
                  )
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
                      disabled={
                        displayedConnectionStatus === "connecting" ||
                        Boolean(connection.fingerprint && !trustHost)
                      }
                    >
                      {displayedConnectionStatus === "connecting" ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <KeyRound size={15} />
                      )}
                      {displayedConnectionStatus === "connecting" ? "连接中" : "连接"}
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
                if (context === "bound") {
                  onSetCurrentConversationConnection(true);
                }
                onConnect({
                  serverId,
                  name: name.trim() || host,
                  host,
                  port: Number(port) || 22,
                  username,
                  authMethod,
                  privateKey: privateKey || undefined,
                  keyName:
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
              <label className="field">
                <span>服务器名称</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="您可以自定义对该服务器的称呼"
                />
              </label>
              <div className="ssh-target-grid">
                <label className="field host-field">
                  <span>服务器地址</span>
                  <input
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
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
                  placeholder="请输入您在服务器上的用户名"
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
                      conversationScoped ||
                      showFormConnect ||
                      connection.status === "connected"
                    ) {
                      setConfigurationOpen(false);
                    }
                  }}
                  disabled={!host.trim() || !port || !username.trim()}
                >
                  <Save size={15} />
                  保存
                </button>
                {connection.status === "connected" ? (
                  <button
                    className="secondary-button form-disconnect-button"
                    type="button"
                    onClick={() => onDisconnect(serverId)}
                  >
                    <WifiOff size={16} />
                    断开 SSH
                  </button>
                ) : (showFormConnect || conversationScoped) ? (
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
                ) : null}
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
  agentName,
  onUpdate,
  onRetry,
  onClose,
}: {
  state: AgentUpdateState;
  agentName: string;
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
    <Modal title={`${agentName} 更新`} onClose={onClose}>
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
                : `正在检查 ${agentName}`}
        </h3>
        <p>
          {state.error ||
            state.label ||
            (busy ? "正在连接远端服务器…" : `${agentName} 已与主机版本一致`)}
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

function WorkspacePickerModal({
  serverName,
  activeWorkspaceKind,
  activeWorkspacePath,
  conversationId,
  purpose,
  path,
  home,
  parent,
  entries,
  loading,
  onBrowse,
  onChooseVirtual,
  onChooseCurrent,
  onClose,
}: {
  serverName: string;
  activeWorkspaceKind: "physical" | "virtual";
  activeWorkspacePath: string;
  conversationId: string;
  purpose: "conversation" | "dynamic";
  path: string;
  home: string;
  parent: string | null;
  entries: RemoteFileEntry[];
  loading: boolean;
  onBrowse: (path: string) => void;
  onChooseVirtual: () => void;
  onChooseCurrent: () => void;
  onClose: () => void;
}) {
  const [selectionMode, setSelectionMode] = useState<"virtual" | "user">(
    purpose === "dynamic" ? "user" : "virtual",
  );
  const [filter, setFilter] = useState("");
  const filteredEntries = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  const virtualPath =
    activeWorkspaceKind === "virtual" && activeWorkspacePath
      ? activeWorkspacePath
      : home && conversationId
        ? `${home}/.easywork/virtual/${conversationId}`
        : "将在对话首次执行时分配";
  return (
    <Modal
      title={purpose === "dynamic" ? "选择动态写入目录" : "选择工作区"}
      onClose={onClose}
      wide
      headerAction={
        purpose === "conversation" ? (
          <label className="workspace-kind-selector">
            <select
              aria-label="工作区类型"
              value={selectionMode}
              onChange={(event) =>
                setSelectionMode(event.target.value as "virtual" | "user")
              }
            >
              <option value="virtual">虚拟工作区</option>
              <option value="user">用户工作区</option>
            </select>
            <ChevronDown size={13} aria-hidden="true" />
          </label>
        ) : undefined
      }
    >
      {selectionMode === "virtual" && purpose === "conversation" ? (
        <div className="workspace-virtual-picker">
          <div className="workspace-virtual-address">
            <span><Sparkles size={18} /></span>
            <div>
              <small>{serverName}</small>
              <code title={virtualPath}>{virtualPath}</code>
            </div>
          </div>
          <p>
            虚拟工作区属于当前对话，适合查询、临时文件和不固定目录的任务。需要修改真实目录时，EasyWork 会在执行前让你确认目标目录，并复用该目录对应的 Agent 会话。
          </p>
          <footer>
            <button
              className="primary-button"
              type="button"
              disabled={loading}
              onClick={onChooseVirtual}
            >
              {loading && <LoaderCircle className="spin" size={14} />}
              选择当前文件夹
            </button>
          </footer>
        </div>
      ) : (
        <div className="remote-directory-picker">
          <header>
            <div className="remote-directory-location">
              <FolderOpen size={17} />
              <code title={path}>{path}</code>
            </div>
            <div className="remote-directory-actions">
              <label className="remote-directory-filter">
                <Search size={14} />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="筛选文件夹"
                  aria-label="筛选文件夹"
                />
              </label>
              <button
                type="button"
                title="主目录"
                aria-label="打开主目录"
                disabled={loading || !home || path === home}
                onClick={() => onBrowse(home)}
              >
                <Home size={15} />
              </button>
              <button
                type="button"
                title="上一级"
                aria-label="打开上一级目录"
                disabled={loading || !parent}
                onClick={() => parent && onBrowse(parent)}
              >
                <ChevronLeft size={15} />
              </button>
            </div>
          </header>
          <div className="remote-directory-list" aria-busy={loading}>
            {loading ? (
              <div className="remote-directory-state">
                <LoaderCircle className="spin" size={18} />
                <span>正在读取目录</span>
              </div>
            ) : filteredEntries.length ? (
              filteredEntries.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  title={entry.path}
                  onClick={() => onBrowse(entry.path)}
                >
                  <Folder size={17} />
                  <span>{entry.name}</span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <div className="remote-directory-state">
                {filter.trim() ? "没有匹配的文件夹" : "当前目录没有子文件夹"}
              </div>
            )}
          </div>
          <footer>
            <button
              className="primary-button"
              type="button"
              disabled={loading || !path}
              onClick={onChooseCurrent}
            >
              选择当前文件夹
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}

function AgentDirectoryPickerModal({
  path,
  home,
  parent,
  entries,
  loading,
  onBrowse,
  onChoose,
  onClose,
}: {
  path: string;
  home: string;
  parent: string | null;
  entries: RemoteFileEntry[];
  loading: boolean;
  onBrowse: (path: string) => void;
  onChoose: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const filteredEntries = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()),
  );
  return (
    <Modal
      title="手动添加 Agent"
      titleNote="请选择包含 Agent 可执行文件或 bin 目录的应用主目录"
      onClose={onClose}
      wide
    >
      <div className="remote-directory-picker">
        <header>
          <div className="remote-directory-location">
            <FolderOpen size={17} />
            <code title={path}>{path}</code>
          </div>
          <div className="remote-directory-actions">
            <label className="remote-directory-filter">
              <Search size={14} />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选文件夹"
                aria-label="筛选文件夹"
              />
            </label>
            <button
              type="button"
              title="主目录"
              aria-label="打开主目录"
              disabled={loading || !home || path === home}
              onClick={() => onBrowse(home)}
            >
              <Home size={15} />
            </button>
            <button
              type="button"
              title="上一级"
              aria-label="打开上一级目录"
              disabled={loading || !parent}
              onClick={() => parent && onBrowse(parent)}
            >
              <ChevronLeft size={15} />
            </button>
          </div>
        </header>
        <div className="remote-directory-list" aria-busy={loading}>
          {loading ? (
            <div className="remote-directory-state">
              <LoaderCircle className="spin" size={18} />
              <span>正在读取目录</span>
            </div>
          ) : filteredEntries.length ? (
            filteredEntries.map((entry) => (
              <button
                type="button"
                key={entry.path}
                title={entry.path}
                onClick={() => onBrowse(entry.path)}
              >
                <Folder size={17} />
                <span>{entry.name}</span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <div className="remote-directory-state">
              {filter.trim() ? "没有匹配的文件夹" : "当前目录没有子文件夹"}
            </div>
          )}
        </div>
        <footer>
          <button
            className="primary-button"
            type="button"
            disabled={loading || !path}
            onClick={onChoose}
          >
            选择当前文件夹
          </button>
        </footer>
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
