"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Bot,
  Brain,
  Check,
  CheckCircle2,
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
import {
  KeyboardEvent,
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
  detail?: string;
};

type RemoteFileEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modifiedAt?: string;
};

let GATEWAY_HTTP =
  process.env.NEXT_PUBLIC_EASYWORK_GATEWAY_URL ??
  (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");

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
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
}

const gatewayCandidates = () => {
  const configured = process.env.NEXT_PUBLIC_EASYWORK_GATEWAY_URL;
  const candidates = [
    configured,
    "http://127.0.0.1:8789",
    "http://localhost:8789",
    typeof window !== "undefined" ? window.location.origin : undefined,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates.map((value) => value.replace(/\/+$/, "")))];
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

function renderInlineMarkdown(value: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) nodes.push(value.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${nodes.length}`;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      nodes.push(
        link ? (
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        ) : (
          token
        ),
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line: string) {
  const cells = tableCells(line);
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")))
  );
}

function MarkdownContent({
  content,
  compact = false,
}: {
  content: string;
  compact?: boolean;
}) {
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  const beginsBlock = (line: string, next = "") =>
    /^\s*```/.test(line) ||
    /^#{1,3}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*---+\s*$/.test(line) ||
    (line.includes("|") && isTableDivider(next));

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([\w-]+)?\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre className="markdown-code-block" key={`code-${index}`}>
          <code data-language={fence[1] || undefined}>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      isTableDivider(lines[index + 1])
    ) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={`head-${cellIndex}`}>
                    {renderInlineMarkdown(cell, `head-${index}-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`}>
                  {header.map((_, cellIndex) => (
                    <td key={`cell-${cellIndex}`}>
                      {renderInlineMarkdown(
                        row[cellIndex] ?? "",
                        `cell-${index}-${rowIndex}-${cellIndex}`,
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const children = renderInlineMarkdown(heading[2], `heading-${index}`);
      blocks.push(
        level === 1 ? (
          <h2 key={`heading-${index}`}>{children}</h2>
        ) : level === 2 ? (
          <h3 key={`heading-${index}`}>{children}</h3>
        ) : (
          <h4 key={`heading-${index}`}>{children}</h4>
        ),
      );
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item, `ul-${index}-${itemIndex}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+\.\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item, `ol-${index}-${itemIndex}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {renderInlineMarkdown(quote.join("\n"), `quote-${index}`)}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !beginsBlock(lines[index], lines[index + 1] ?? "")
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {renderInlineMarkdown(paragraph.join("\n"), `paragraph-${index}`)}
      </p>,
    );
  }

  return (
    <div className={`markdown-content${compact ? " compact" : ""}`}>
      {blocks}
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

function CommandEventGroup({ events }: { events: WorkEvent[] }) {
  const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
  const running = events.some((event) => event.status === "running");
  const failed = events.some((event) => event.status === "error");
  const groupLabel = running
    ? `正在运行 ${events.length} 个命令`
    : `运行了 ${events.length} 个命令`;

  return (
    <section className={`command-group${running ? " running" : ""}${failed ? " error" : ""}`}>
      <header className="command-group-heading">
        <span className="command-group-glyph">
          {running ? <LoaderCircle size={14} /> : failed ? <X size={13} /> : <Terminal size={14} />}
        </span>
        <strong>{groupLabel}</strong>
        <span>{running ? "远程终端活动中" : failed ? "部分命令失败" : "远程终端"}</span>
      </header>
      <div className="command-list">
        {events.map((event) => {
          const expanded = event.status === "running" || expandedCommands.has(event.id);
          const command = event.command || event.title;
          const panelId = `command-output-${event.id}`;
          return (
            <article
              className={`command-event ${event.status}${expanded ? " expanded" : ""}`}
              key={event.id}
            >
              <button
                className="command-summary"
                type="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() =>
                  setExpandedCommands((current) => {
                    const next = new Set(current);
                    if (next.has(event.id)) next.delete(event.id);
                    else next.add(event.id);
                    return next;
                  })
                }
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
                <ChevronDown size={13} />
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
                      {event.output ? `\n${event.output}` : event.status === "running" ? "\n等待远端输出…" : ""}
                    </code>
                  </pre>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function AgentEventRow({
  event,
  onApproval,
}: {
  event: WorkEvent;
  onApproval?: (event: WorkEvent, approved: boolean) => void;
}) {
  const kind = normalizedEventKind(event.kind);
  return (
    <article className={`agent-event ${kind} ${event.status}`}>
      <span className="agent-event-glyph">
        <EventGlyph event={event} />
      </span>
      <div className="agent-event-copy">
        <strong>{event.title}</strong>
        {event.detail && <small>{event.detail}</small>}
        {event.path && <code className="agent-event-path">{event.path}</code>}
        {event.output && kind !== "plan" && (
          <div className="agent-event-output">
            <MarkdownContent content={event.output} compact />
          </div>
        )}
        {kind === "approval_request" && event.status === "pending" && onApproval && (
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
      <span className="agent-event-status">{eventStatusLabel(event.status)}</span>
    </article>
  );
}

function WorkEventFeed({
  events,
  onApproval,
  runStatus,
}: {
  events: WorkEvent[];
  onApproval?: (event: WorkEvent, approved: boolean) => void;
  runStatus?: RunTrace["status"];
}) {
  const visibleEvents = events
    .filter((event) => normalizedEventKind(event.kind) !== "message")
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
    if (normalizedEventKind(event.kind) === "tool_call") {
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
          <AgentEventRow event={segment.event} key={segment.id} onApproval={onApproval} />
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
          ? Math.max(0, Math.ceil(text.scrollWidth - viewport.clientWidth))
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
  onDelete: () => void;
}) {
  const destinations = projects.filter((project) => project.id !== conversation.projectId);
  return (
    <div
      className={`chat-row${nested ? " project-chat-row" : ""}${
        active ? " active" : ""
      }`}
    >
      <button className="chat-row-main" type="button" onClick={onSelect}>
        <ScrollingTitle title={conversation.title} />
      </button>
      <button
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
      {menuOpen && (
        <div className="conversation-menu" role="menu">
          {!!destinations.length && (
            <>
              <span className="conversation-menu-label">移动到项目</span>
              {destinations.map((project) => (
                <button
                  type="button"
                  role="menuitem"
                  key={project.id}
                  onClick={() => onMove(project.id)}
                >
                  <span className="menu-project-avatar">{project.icon}</span>
                  {project.name}
                </button>
              ))}
            </>
          )}
          {conversation.projectId && (
            <button type="button" role="menuitem" onClick={() => onMove(undefined)}>
              <Folder size={15} />
              移出项目
            </button>
          )}
          {(destinations.length > 0 || conversation.projectId) && (
            <span className="conversation-menu-separator" />
          )}
          <button className="danger" type="button" role="menuitem" onClick={onDelete}>
            <Trash2 size={15} />
            删除
          </button>
        </div>
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
  const [skillsPopover, setSkillsPopover] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectLibraryModalOpen, setProjectLibraryModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const [sshModalContext, setSshModalContext] = useState<
    "conversation" | "manage"
  >("conversation");
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [manualAgentOpen, setManualAgentOpen] = useState(false);
  const [manualAgentName, setManualAgentName] = useState("");
  const [manualAgentFolder, setManualAgentFolder] = useState("");
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [agentConfigAgentId, setAgentConfigAgentId] = useState("");
  const [agentConfigPath, setAgentConfigPath] = useState("");
  const [agentConfigContent, setAgentConfigContent] = useState("");
  const [agentConfigLoading, setAgentConfigLoading] = useState(false);
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
  const [gatewayEndpoint, setGatewayEndpoint] = useState("");
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
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
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
        title: "任务已编排",
        detail: `${steps.length} 个步骤`,
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
            if (index === steps.length - 1) setSending(false);
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
                  fingerprint: item.fingerprint
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
          setSshModalOpen(false);
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
            return {
              ...message,
              content:
                normalizedEventKind(workEvent.kind) === "message" && workEvent.output
                  ? workEvent.output
                  : message.content,
              events: exists
                ? previous.map((item) => (item.id === eventId ? workEvent : item))
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
          ".chat-row, .conversation-mode-menu, .agent-selector",
        )
      ) {
        setConversationMenuId("");
        setModeMenuOpen(false);
        setAgentMenuOpen(false);
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
          setGatewayEndpoint(candidate);
          setGatewayStatus("connected");
          setActor(payload.actor);
          storeDeviceToken(payload.deviceToken);
          if (payload.state) {
            setState((current) => mergeStoredState(current, payload.state ?? {}));
          }
          return;
        } catch {
          // Try the same-origin gateway first, then the two loopback addresses.
        }
      }
      if (!disposed) {
        setGatewayEndpoint("");
        setGatewayStatus("unavailable");
      }
    };
    void bootstrap();
    return () => {
      disposed = true;
    };
  }, [gatewayProbe]);

  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    const url = new URL(GATEWAY_HTTP);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
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
              label: "本机网关已断开",
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

  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    const timer = window.setTimeout(() => {
      void gatewayFetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [gatewayStatus, state]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation?.messages.length]);

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
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const beginConversation = (projectId?: string, nextMode: Mode = "chat") => {
    setActiveConversationId("");
    setDraftProjectId(projectId);
    setDraftServerId("");
    setActiveProjectId(projectId ?? "");
    setMode(nextMode);
    setView("chat");
    setRightRailOpen(false);
    setConversationMenuId("");
    setProjectMenuId("");
    setModeMenuOpen(false);
    setSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const openProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setActiveConversationId("");
    setDraftProjectId(undefined);
    setDraftServerId("");
    setView("project");
    setRightRailOpen(false);
    setConversationMenuId("");
    setProjectMenuId("");
    setSidebarOpen(false);
  };

  const createProject = (name: string, memoryMode: Project["memoryMode"]) => {
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
    }));
    setProjectModalOpen(false);
    openProject(project.id);
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
    setSshModalContext("conversation");
    setSshModalOpen(true);
  };

  const openGlobalServerManager = () => {
    setSshModalContext("manage");
    setSshModalOpen(true);
    setSidebarOpen(false);
  };

  const selectServerForModal = (serverId: string) => {
    setSelectedServerId(serverId);
    if (sshModalContext !== "conversation") return;
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

  const saveServerProfile = (profile: ServerProfile) => {
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
    setSelectedServerId(profile.id);
    if (
      sshModalContext === "conversation" &&
      !activeConversation?.work?.serverId
    ) {
      setDraftServerId(profile.id);
    }
    showToast("服务器配置已保存");
  };

  const moveConversation = (conversationId: string, projectId?: string) => {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      projectId,
      updatedAt: now(),
    }));
    setConversationMenuId("");
    showToast(projectId ? "对话已移动到项目" : "对话已移出项目");
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

  const submitMessage = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    if (mode === "work" && connection.status !== "connected") {
      openConversationServerManager();
      showToast("请先连接一台远程服务器");
      return;
    }
    if (
      mode === "work" &&
      (activeAgent?.status !== "ready" || !activeAgent.configured)
    ) {
      setAgentMenuOpen(true);
      showToast(
        activeAgent?.status === "missing"
          ? "请先安装或选择 Agent"
          : "请先完成 Agent 模型配置",
      );
      return;
    }

    const conversation = activeConversation;
    const firstTurn = !conversation?.messages.length;
    const conversationId = conversation?.id ?? uid("chat");
    const projectId = conversation?.projectId ?? draftProjectId;
    const conversationProject = state.projects.find((project) => project.id === projectId);
    const work =
      mode === "work"
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
      mode,
      selectedSkills,
      runId: mode === "work" ? runId : undefined,
    };
    const assistantMessage: Message = {
      id: uid("message"),
      role: "assistant",
      content: "",
      createdAt: now(),
      mode,
      events: mode === "work" ? [] : undefined,
      runId: mode === "work" ? runId : undefined,
    };

    setState((current) => {
      const existing = current.conversations.find((item) => item.id === conversationId);
      if (!existing) {
        const created: Conversation = {
          id: conversationId,
          title: "新对话",
          mode,
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
                mode,
                updatedAt: now(),
                work:
                  mode === "work"
                    ? { ...(item.work ?? {}), ...(work ?? {}) }
                    : item.work,
                messages: [...item.messages, userMessage, assistantMessage],
              }
            : item,
        ),
      };
    });
    setActiveConversationId(conversationId);
    setDraftProjectId(undefined);
    setDraftServerId("");
    setDraft("");
    setSkillsPopover(false);
    setSending(true);

    if (mode === "work") {
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

    try {
      const response = await gatewayFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          prompt: content,
          firstTurn,
          skillIds: selectedSkills,
          projectId,
          memoryMode: conversationProject?.memoryMode ?? "default",
        }),
      });
      if (!response.ok) throw new Error("LLM request failed");
      const payload = (await response.json()) as { content?: string; title?: string };
      updateMessage(
        conversationId,
        (message) => message.id === assistantMessage.id,
        (message) => ({
          ...message,
          content:
            payload.content ??
            "请求已完成，但模型没有返回可显示的文本。",
        }),
      );
      if (firstTurn && payload.title) {
        updateConversation(conversationId, (item) => ({
          ...item,
          title: payload.title!,
        }));
      }
    } catch {
      updateMessage(
        conversationId,
        (message) => message.id === assistantMessage.id,
        (message) => ({
          ...message,
          content: "暂时无法连接模型服务，请检查本机网关与模型 API 设置。",
        }),
      );
    } finally {
      setSending(false);
    }
  };

  const stopCurrentRun = () => {
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

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  const connectDemo = () => {
    const serverId = "demo";
    setSelectedServerId(serverId);
    if (sshModalContext === "conversation") {
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
        setSshModalOpen(false);
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
      showToast("正在重新检测本机网关");
      return;
    }
    setSelectedServerId(payload.serverId);
    if (sshModalContext === "conversation") {
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
    socket.send(JSON.stringify({ type: "ssh.connect", ...payload }));
  };

  const disconnectSsh = (serverId = effectiveServerId) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "ssh.disconnect", serverId }));
    }
    setConnections((current) => ({
      ...current,
      [serverId]: {
        ...(current[serverId] ?? { serverId }),
        serverId,
        status: "disconnected",
        label: "已主动断开",
      },
    }));
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
    socketRef.current.send(
      JSON.stringify({
        type: "agent.config.read",
        serverId: effectiveServerId,
        agentId: agent.id,
        requestId: uid("config"),
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
    if (composerFileInputRef.current) composerFileInputRef.current.value = "";
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

  const projectConversations = (projectId: string) =>
    visibleConversations.filter(
      (conversation) =>
        conversation.projectId === projectId && conversation.messages.length > 0,
    );

  const generalConversations = visibleConversations.filter(
    (conversation) => !conversation.projectId && conversation.messages.length > 0,
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
          <button className="brand-button" type="button" onClick={() => setView("chat")}>
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
          <div className="section-label">
            <span>项目</span>
            <button
              type="button"
              onClick={() => setProjectModalOpen(true)}
              aria-label="新建项目"
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="project-list">
            {state.projects.map((project) => {
              const selected =
                project.id === activeProjectId &&
                (view === "project" ||
                  activeConversation?.projectId === project.id ||
                  (!activeConversation && draftProjectId === project.id));
              const conversations = projectConversations(project.id);
              return (
                <div
                  className={`project-nav-group${selected ? " selected" : ""}`}
                  key={project.id}
                >
                  <div
                    className={`project-list-item${selected ? " active" : ""}`}
                  >
                    <button
                      className="project-row"
                      type="button"
                      onClick={() => openProject(project.id)}
                    >
                      <Folder size={17} />
                      <span className="project-title" title={project.name}>
                        {project.name}
                      </span>
                    </button>
                    <div className="project-row-actions">
                      <button
                        className="project-new-chat"
                        type="button"
                        aria-label={`在“${project.name}”中新建聊天`}
                        onClick={(event) => {
                          event.stopPropagation();
                          beginConversation(project.id);
                        }}
                      >
                        <Pencil size={14} />
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
                            openProject(project.id);
                            setProjectMenuId("");
                          }}
                        >
                          <FolderOpen size={15} />
                          打开项目
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            beginConversation(project.id);
                            setProjectMenuId("");
                          }}
                        >
                          <Pencil size={15} />
                          新聊天
                        </button>
                      </div>
                    )}
                  </div>
                  {selected && conversations.length > 0 && (
                    <div className="project-sidebar-chats">
                      {conversations.map((conversation) => (
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
                              current === conversation.id ? "" : conversation.id,
                            )
                          }
                          onMove={(projectId) =>
                            moveConversation(conversation.id, projectId)
                          }
                          onDelete={() => {
                            setConversationPendingDelete(conversation);
                            setConversationMenuId("");
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="section-label chat-section-label">
            <span>聊天</span>
          </div>
          <div className="general-chats">
            {generalConversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeConversationId && view === "chat"}
                projects={state.projects}
                menuOpen={conversationMenuId === conversation.id}
                onSelect={() => selectConversation(conversation)}
                onToggleMenu={() =>
                  setConversationMenuId((current) =>
                    current === conversation.id ? "" : conversation.id,
                  )
                }
                onMove={(projectId) => moveConversation(conversation.id, projectId)}
                onDelete={() => {
                  setConversationPendingDelete(conversation);
                  setConversationMenuId("");
                }}
              />
            ))}
          </div>
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
                <button
                  className={`connection-pill ${connection.status}`}
                  type="button"
                  onClick={openConversationServerManager}
                >
                  {connection.status === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
                  <span>{connection.status === "connected" ? "登录节点在线" : "连接平台"}</span>
                  {connection.latency && <small>{connection.latency}ms</small>}
                </button>
                {connection.status === "connected" && (
                  <button
                    className="agent-picker"
                    type="button"
                    onClick={() => setAgentMenuOpen((current) => !current)}
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
                {mode === "work" && connection.status === "connected" && (
                  <div className="agent-selector">
                    <button
                      className="agent-picker"
                      type="button"
                      aria-expanded={agentMenuOpen}
                      onClick={() => setAgentMenuOpen((current) => !current)}
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
                      <div className="agent-dropdown">
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
                              {agent.status === "ready" && agent.configPath && (
                                <button
                                  className="agent-config-shortcut"
                                  type="button"
                                  onClick={() => openAgentConfig(agent)}
                                  aria-label={`打开 ${agent.name} 配置`}
                                >
                                  <Settings2 size={14} />
                                </button>
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
                            ? setAgentMenuOpen(true)
                            : openAgentConfig()
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
                              <MarkdownContent content={message.content} />
                            ) : (
                              message.content
                            )}
                          </div>
                        ) : message.role === "assistant" && !message.events?.length ? (
                          <div className="typing-row">
                            <span />
                            <span />
                            <span />
                            {message.mode === "work" ? "Agent 正在工作" : "正在生成回复"}
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
              <div className={`composer-shell${sending ? " busy" : ""}`}>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  disabled={mode === "work" && !workReady}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
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
                  rows={1}
                  aria-label="消息输入框"
                />
                <div className="composer-toolbar">
                  <div className="composer-tools">
                    <button
                      type="button"
                      aria-label="添加附件"
                      onClick={() => composerFileInputRef.current?.click()}
                    >
                      <Paperclip size={16} />
                    </button>
                    <input
                      ref={composerFileInputRef}
                      hidden
                      multiple
                      type="file"
                      onChange={(event) => void handleLibraryUpload(event.target.files)}
                    />
                    <div className="skills-trigger-wrap">
                      <button
                        className={selectedSkills.length ? "selected" : ""}
                        type="button"
                        onClick={() => setSkillsPopover((value) => !value)}
                      >
                        <Sparkles size={15} />
                        技能
                        {selectedSkills.length > 0 && <b>{selectedSkills.length}</b>}
                        <ChevronDown size={12} />
                      </button>
                      {skillsPopover && (
                        <div className="skills-popover">
                          <div className="popover-heading">
                            <span>本轮使用的技能</span>
                            <button
                              type="button"
                              onClick={() => {
                                setView("skills");
                                setSkillsPopover(false);
                              }}
                            >
                              管理
                            </button>
                          </div>
                          {state.skills
                            .filter((skill) => skill.enabled)
                            .map((skill) => {
                              const selected = selectedSkills.includes(skill.id);
                              return (
                                <button
                                  className={selected ? "active" : ""}
                                  type="button"
                                  key={skill.id}
                                  onClick={() =>
                                    setSelectedSkills((current) =>
                                      selected
                                        ? current.filter((id) => id !== skill.id)
                                        : [...current, skill.id],
                                    )
                                  }
                                >
                                  <span>{skillIcon(skill)}</span>
                                  <span>
                                    <strong>{skill.name}</strong>
                                    <small>{skill.description}</small>
                                  </span>
                                  <span className="skill-check">
                                    {selected && <Check size={13} />}
                                  </span>
                                </button>
                              );
                            })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="composer-submit">
                    {sending ? (
                      <button
                        className="send-button stop"
                        type="button"
                        onClick={stopCurrentRun}
                        aria-label="停止"
                      >
                        <Square size={13} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="send-button"
                        type="button"
                        onClick={() => void submitMessage()}
                        disabled={!draft.trim() || (mode === "work" && !workReady)}
                        aria-label="发送"
                      >
                        <ArrowUp size={17} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {mode === "chat" && <p>EasyWork 可能会出错，请核对重要信息。</p>}
            </div>
          </section>
        )}

        {view === "project" && projectPage && (
          <section className="workspace-page project-page">
            <div className="page-intro project-page-intro">
              <div className="project-page-title">
                <span className="project-page-avatar">{projectPage.icon}</span>
                <div>
                  <h1>{projectPage.name}</h1>
                  <p>
                    {projectPage.memoryMode === "project-only"
                      ? "仅使用本项目的聊天、文件和记忆"
                      : "使用默认记忆范围"}
                  </p>
                </div>
              </div>
              <button
                className="primary-button"
                type="button"
                onClick={() => beginConversation(projectPage.id)}
              >
                <Plus size={16} />
                新聊天
              </button>
            </div>
            <div className="project-content-grid">
              <div className="content-card project-conversations-card">
                <div className="card-toolbar">
                  <div className="project-section-heading">
                    <h2>对话</h2>
                    <span className="project-count">
                      {projectConversations(projectPage.id).length}
                    </span>
                  </div>
                </div>
                <div className="project-conversation-list">
                  {projectConversations(projectPage.id).map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      active={false}
                      projects={state.projects}
                      menuOpen={conversationMenuId === conversation.id}
                      onSelect={() => selectConversation(conversation)}
                      onToggleMenu={() =>
                        setConversationMenuId((current) =>
                          current === conversation.id ? "" : conversation.id,
                        )
                      }
                      onMove={(projectId) => moveConversation(conversation.id, projectId)}
                      onDelete={() => {
                        setConversationPendingDelete(conversation);
                        setConversationMenuId("");
                      }}
                    />
                  ))}
                  {!projectConversations(projectPage.id).length && (
                    <div className="project-empty-state">
                      <p>还没有对话</p>
                      <button type="button" onClick={() => beginConversation(projectPage.id)}>
                        开始新聊天
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="content-card project-files-card">
                <div className="card-toolbar project-files-toolbar">
                  <div className="project-section-heading">
                    <h2>文件</h2>
                    <span className="project-count">{projectFiles.length}</span>
                  </div>
                  <div className="project-file-actions">
                    <button
                      type="button"
                      onClick={() => setProjectLibraryModalOpen(true)}
                    >
                      <Library size={14} />
                      关联
                    </button>
                    <button
                      type="button"
                      onClick={() => projectFileInputRef.current?.click()}
                    >
                      <Upload size={14} />
                      上传
                    </button>
                    <input
                      ref={projectFileInputRef}
                      hidden
                      multiple
                      type="file"
                      onChange={(event) =>
                        void handleLibraryUpload(event.target.files, projectPage.id)
                      }
                    />
                  </div>
                </div>
                <div className="project-file-list">
                  {projectFiles.map((file) => (
                    <div className="project-file-row" key={file.id}>
                      <span className="project-file-icon">
                        <FileText size={16} />
                      </span>
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
                    <div className="project-files-empty">
                      <FolderOpen size={20} />
                      <p>还没有项目文件</p>
                    </div>
                  )}
                </div>
              </div>
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
      {projectModalOpen && (
        <ProjectModal
          onClose={() => setProjectModalOpen(false)}
          onCreate={createProject}
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
          onActor={setActor}
          onState={setState}
          onToast={showToast}
          onDeleteGuest={deleteGuestData}
        />
      )}
      {sshModalOpen && (
        <ServerManagerModal
          profiles={
            sshModalContext === "conversation" &&
            activeConversation?.work?.serverId
              ? state.settings.servers.filter(
                  (profile) =>
                    profile.id === activeConversation.work?.serverId,
                )
              : state.settings.servers
          }
          connections={connections}
          selectedServerId={
            sshModalContext === "conversation"
              ? effectiveServerId
              : globalServerId
          }
          locked={Boolean(
            sshModalContext === "conversation" &&
              activeConversation?.work?.serverId,
          )}
          gatewayStatus={gatewayStatus}
          gatewayEndpoint={gatewayEndpoint}
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

function ProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, mode: Project["memoryMode"]) => void;
}) {
  const [name, setName] = useState("");
  const [memoryMode, setMemoryMode] = useState<Project["memoryMode"]>("default");
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
              <strong>默认记忆</strong>
              <small>使用全局记忆和本项目内容。</small>
            </span>
            <span className="radio-dot" />
          </label>
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
  const [detectedModels, setDetectedModels] = useState<string[]>(
    state.settings.provider.model ? [state.settings.provider.model] : [],
  );
  const [modelDetecting, setModelDetecting] = useState(false);
  const [modelError, setModelError] = useState("");

  const authenticate = async (kind: "login" | "register") => {
    setBusy(true);
    setError("");
    try {
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
          onState((current) => mergeStoredState(current, bootstrap.state ?? {}));
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
    const nextProvider = {
      name: "OpenAI Compatible",
      baseUrl: provider.baseUrl,
      model: provider.model,
      protocol: "auto" as const,
      configured: Boolean(provider.apiKey || provider.configured),
    };
    setModelError("");
    try {
      const response = await gatewayFetch("/api/settings/provider", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "模型 API 保存失败");
      onState((current) => ({
        ...current,
        settings: { ...current.settings, provider: nextProvider },
      }));
      onToast("模型 API 已保存");
      onClose();
    } catch (caught) {
      setModelError(caught instanceof Error ? caught.message : "模型 API 保存失败");
    }
  };

  const detectProviderModels = async () => {
    if (/^https?:\/\//i.test(provider.apiKey.trim())) {
      setModelError("API Key 不能填写 API URL");
      return;
    }
    setModelDetecting(true);
    setModelError("");
    try {
      const response = await gatewayFetch("/api/settings/provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      const payload = (await response.json()) as { models?: string[]; error?: string };
      if (!response.ok || !payload.models?.length) {
        throw new Error(payload.error || "没有检测到可用模型");
      }
      setDetectedModels(payload.models);
      setProvider((current) => ({
        ...current,
        model: payload.models?.includes(current.model)
          ? current.model
          : payload.models?.[0] ?? "",
      }));
    } catch (caught) {
      setModelError(caught instanceof Error ? caught.message : "模型检测失败");
    } finally {
      setModelDetecting(false);
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
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
              value={provider.apiKey}
              onChange={(event) => setProvider((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder={provider.configured ? "已保存；留空表示不修改" : "sk-…"}
            />
          </label>
          <div className="model-picker">
            <label className="field">
              <span>模型</span>
              <select
                value={provider.model}
                onChange={(event) =>
                  setProvider((current) => ({ ...current, model: event.target.value }))
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
              onClick={() => void detectProviderModels()}
              disabled={modelDetecting || !provider.baseUrl || (!provider.apiKey && !provider.configured)}
            >
              {modelDetecting ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
              {modelDetecting ? "检测中" : "检测模型"}
            </button>
          </div>
          {modelError && <div className="form-error">{modelError}</div>}
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              disabled={!provider.baseUrl || !provider.model}
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
  locked,
  gatewayStatus,
  gatewayEndpoint,
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
  locked: boolean;
  gatewayStatus: "checking" | "connected" | "unavailable";
  gatewayEndpoint: string;
  canRemember: boolean;
  onSelect: (serverId: string) => void;
  onClose: () => void;
  onDemo: () => void;
  onSave: (profile: ServerProfile) => void;
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
  onDisconnect: (serverId?: string) => void;
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
  const profileDraft = (): ServerProfile => ({
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
    setTrustHost(false);
    onSelect(nextId);
  };

  return (
    <Modal title="远程连接" onClose={onClose} wide>
      <div className="server-manager">
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
          {!locked && (
            <button className="demo-server-button" type="button" onClick={onDemo}>
              演示连接
            </button>
          )}
        </aside>

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
                  ? "正在检测本机网关"
                  : "本机网关未连接"}
              </h3>
              <p>
                {gatewayStatus === "checking"
                  ? "请稍候。"
                  : "启动 frp 后重新检测。"}
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={onRetry}
                disabled={gatewayStatus === "checking"}
              >
                <RefreshCw size={15} />
                重新检测
              </button>
            </div>
          ) : connection.status === "connected" ? (
            <div className="connected-panel server-connected-panel">
              <span className="connected-hero">
                <Wifi size={24} />
              </span>
              <h3>{selectedProfile?.name || connection.host}</h3>
              <p>
                {connection.username}@{connection.host}
              </p>
              <div className="connection-facts">
                <span>
                  <strong>{connection.latency ?? "—"} ms</strong>
                  <small>连接延迟</small>
                </span>
                <span>
                  <strong>{connection.port || selectedProfile?.port || 22}</strong>
                  <small>SSH 端口</small>
                </span>
              </div>
              <div className="modal-actions">
                <button
                  className="text-danger-button"
                  type="button"
                  onClick={() => onDisconnect(serverId)}
                >
                  <WifiOff size={15} />
                  断开
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() =>
                    onSave({
                      id: serverId,
                      name:
                        selectedProfile?.name ||
                        connection.host ||
                        "远程服务器",
                      host: connection.host || selectedProfile?.host || "",
                      port:
                        connection.port || selectedProfile?.port || 22,
                      username:
                        connection.username || selectedProfile?.username || "",
                      keyName: selectedProfile?.keyName || "",
                      authMethod: selectedProfile?.authMethod || "key",
                      configured: Boolean(selectedProfile?.configured),
                      lastConnectedAt:
                        selectedProfile?.lastConnectedAt || now(),
                    })
                  }
                >
                  <Save size={15} />
                  保存
                </button>
                <button className="primary-button" type="button" onClick={onClose}>
                  完成
                </button>
              </div>
            </div>
          ) : (
            <form
              className="modal-form ssh-form server-form"
              onSubmit={(event) => {
                event.preventDefault();
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
              <div className="gateway-online-line">
                <CheckCircle2 size={15} />
                本机网关已连接
                {gatewayEndpoint && (
                  <span>
                    {gatewayEndpoint
                      .replace(/^https?:\/\//, "")
                      .replace(/\/+$/, "")}
                  </span>
                )}
              </div>
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
              {connection.fingerprint && (
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
              <p className="security-line">
                {canRemember
                  ? "保存服务器信息；登录凭据会在连接成功后加密保存。"
                  : "访客配置保存在临时数据中，登录后可跨设备使用。"}
              </p>
              <div className="modal-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onSave(profileDraft())}
                  disabled={!host.trim() || !port || !username.trim()}
                >
                  <Save size={15} />
                  保存
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    connection.status === "connecting" ||
                    !host ||
                    !port ||
                    !username ||
                    (authMethod === "key"
                      ? !privateKey && !useSavedCredential
                      : !password && !useSavedCredential) ||
                    Boolean(connection.fingerprint && !trustHost)
                  }
                >
                  {connection.status === "connecting" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <KeyRound size={16} />
                  )}
                  {connection.status === "connecting" ? "连接中" : "连接 SSH"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SshModal({
  connection,
  gatewayStatus,
  gatewayEndpoint,
  profile,
  canRemember,
  onClose,
  onDemo,
  onConnect,
  onDisconnect,
  onRetry,
}: {
  connection: ConnectionState;
  gatewayStatus: "checking" | "connected" | "unavailable";
  gatewayEndpoint: string;
  profile: NonNullable<AppSettings["ssh"]>;
  canRemember: boolean;
  onClose: () => void;
  onDemo: () => void;
  onConnect: (payload: {
    host: string;
    port: number;
    username: string;
    privateKey?: string;
    privateKeyName?: string;
    useSavedKey?: boolean;
    rememberKey?: boolean;
    passphrase?: string;
    otp?: string;
    trustHost?: boolean;
  }) => void;
  onDisconnect: () => void;
  onRetry: () => void;
}) {
  const [host, setHost] = useState(profile.host || "107.ustc.edu.cn");
  const [port, setPort] = useState(String(profile.port || 22));
  const [username, setUsername] = useState(profile.username || "");
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyName, setPrivateKeyName] = useState("");
  const [useSavedKey, setUseSavedKey] = useState(profile.configured);
  const [pasteKeyOpen, setPasteKeyOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [otp, setOtp] = useState("");
  const [trustHost, setTrustHost] = useState(false);

  if (connection.status === "connected") {
    return (
      <Modal title="算力平台连接" onClose={onClose}>
        <div className="connected-panel">
          <span className="connected-hero">
            <Wifi size={24} />
          </span>
          <h3>SSH 已连接</h3>
          <p>
            {connection.username}@{connection.host}
          </p>
          <div className="connection-facts">
            <span>
              <strong>{connection.latency ?? "—"} ms</strong>
              <small>往返延迟</small>
            </span>
            <span>
              <strong>15 s</strong>
              <small>Keepalive</small>
            </span>
          </div>
          {connection.fingerprint && (
            <div className="fingerprint-card">
              <ShieldCheck size={15} />
              <span>
                <strong>主机指纹</strong>
                <code>{connection.fingerprint}</code>
              </span>
            </div>
          )}
          <div className="modal-actions">
            <button className="text-danger-button" type="button" onClick={onDisconnect}>
              <WifiOff size={15} />
              断开连接
            </button>
            <button className="primary-button" type="button" onClick={onClose}>
              继续工作
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (gatewayStatus !== "connected") {
    return (
      <Modal title="连接算力平台" onClose={onClose}>
        <div className="gateway-unavailable-panel">
          <span className="gateway-state-icon">
            {gatewayStatus === "checking" ? (
              <LoaderCircle className="spin" size={22} />
            ) : (
              <WifiOff size={22} />
            )}
          </span>
          <h3>{gatewayStatus === "checking" ? "正在检测本机网关" : "本机网关未连接"}</h3>
          <p>
            {gatewayStatus === "checking"
              ? "请稍候。"
              : "请在项目目录运行 frp/start.ps1，启动后重新检测。"}
          </p>
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onDemo}>
              演示连接
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={onRetry}
              disabled={gatewayStatus === "checking"}
            >
              <RefreshCw size={15} />
              重新检测
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="连接算力平台" onClose={onClose}>
      <form
        className="modal-form ssh-form"
        onSubmit={(event) => {
          event.preventDefault();
          onConnect({
            host,
            port: Number(port) || 22,
            username,
            privateKey: privateKey || undefined,
            privateKeyName: privateKeyName || profile.keyName || undefined,
            useSavedKey,
            rememberKey: canRemember && Boolean(privateKey),
            passphrase: passphrase || undefined,
            otp: otp || undefined,
            trustHost,
          });
        }}
      >
        <div className="gateway-online-line">
          <CheckCircle2 size={15} />
          本机网关已连接
          {gatewayEndpoint && (
            <span>{gatewayEndpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "")}</span>
          )}
        </div>
        <div className="ssh-target-grid">
          <label className="field host-field">
            <span>登录节点</span>
            <input value={host} onChange={(event) => setHost(event.target.value)} />
          </label>
          <label className="field port-field">
            <span>端口</span>
            <input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="小写学号"
          />
        </label>
        <div className="field key-picker-field">
          <span>SSH 私钥</span>
          {profile.configured && (
            <button
              className={`saved-key-choice${useSavedKey ? " selected" : ""}`}
              type="button"
              onClick={() => {
                setUseSavedKey(true);
                setPrivateKey("");
                setPrivateKeyName("");
                setPasteKeyOpen(false);
              }}
            >
              <ShieldCheck size={16} />
              <span>
                <strong>{profile.keyName || "已保存的私钥"}</strong>
                <small>使用账号中保存的私钥</small>
              </span>
              {useSavedKey && <Check size={15} />}
            </button>
          )}
          <div className="key-picker-actions">
            <label className="secondary-button">
              <Upload size={15} />
              {profile.configured ? "更换文件" : "选择文件"}
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
                    setUseSavedKey(false);
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
                setPrivateKeyName("");
                if (!pasteKeyOpen) setUseSavedKey(false);
              }}
            >
              {pasteKeyOpen ? "收起" : profile.configured ? "粘贴新私钥" : "粘贴私钥"}
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
                setUseSavedKey(false);
              }}
              placeholder="粘贴 id_ed25519 私钥"
              rows={4}
              autoComplete="off"
            />
          )}
        </div>
        <div className="field-grid">
          <label className="field">
            <span>私钥密码</span>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="可选"
            />
          </label>
          <label className="field">
            <span>动态验证码</span>
            <input
              value={otp}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
              placeholder="6 位验证码"
            />
          </label>
        </div>
        {connection.status === "error" && !connection.fingerprint && (
          <div className="form-error" role="alert" aria-live="polite">
            <strong>连接失败</strong>
            <span>{connection.label}</span>
          </div>
        )}
        {connection.fingerprint && (
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
        <p className="security-line">
          {canRemember
            ? "连接成功后，用户名和私钥会加密保存到账号；私钥密码和验证码不会保存。"
            : "私钥、密码和验证码仅进入本机网关内存。登录后可保存连接信息。"}
        </p>
        <div className="modal-actions spread">
          <button className="secondary-button" type="button" onClick={onDemo}>
            演示连接
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={
              connection.status === "connecting" ||
              !host ||
              !username ||
              (!privateKey && !useSavedKey) ||
              Boolean(connection.fingerprint && !trustHost)
            }
          >
            {connection.status === "connecting" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <KeyRound size={16} />
            )}
            {connection.status === "connecting" ? connection.label : "连接 SSH"}
          </button>
        </div>
      </form>
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

function AgentModal({
  agents,
  activeAgentId,
  connection,
  onClose,
  onSelect,
  onScan,
  onInstall,
  onAdd,
}: {
  agents: AgentItem[];
  activeAgentId: string;
  connection: ConnectionState;
  onClose: () => void;
  onSelect: (id: string) => void;
  onScan: () => void;
  onInstall: () => void;
  onAdd: (agent: AgentItem) => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  return (
    <Modal title="选择 Agent" onClose={onClose}>
      <div className="agent-toolbar">
        <button className="secondary-button" type="button" onClick={onScan}>
          <RefreshCw size={15} />
          自动扫描
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setManualOpen((value) => !value)}
        >
          <Plus size={15} />
          手动添加
        </button>
      </div>
      {manualOpen && (
        <div className="manual-agent-form">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Agent 名称" />
          <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="可执行文件路径" />
          <button
            type="button"
            onClick={() => {
              if (!name || !path) return;
              onAdd({
                id: uid("agent"),
                name,
                path,
                status: "needs-adapter",
                adapter: "plain",
              });
              setName("");
              setPath("");
              setManualOpen(false);
            }}
          >
            添加
          </button>
        </div>
      )}
      <div className="agent-list">
        {agents.map((agent) => (
          <button
            className={`agent-row${agent.id === activeAgentId ? " active" : ""}`}
            type="button"
            key={agent.id}
            onClick={() => agent.status === "ready" && onSelect(agent.id)}
          >
            <span className="agent-logo">
              {agent.id === "opencode" ? <Code2 size={19} /> : <Bot size={19} />}
            </span>
            <span>
              <strong>
                {agent.name}
                {agent.managed && <b>EasyWork 管理</b>}
              </strong>
              <small>{agent.path}</small>
            </span>
            <span className={`agent-state ${agent.status}`}>
              {agent.status === "ready"
                ? agent.version ?? "可用"
                   : agent.status === "missing"
                   ? "未安装"
                   : agent.status === "installing"
                     ? agent.detail ?? "安装中…"
                   : "需配置适配器"}
            </span>
            {agent.id === activeAgentId && agent.status === "ready" && (
              <CheckCircle2 size={17} />
            )}
          </button>
        ))}
      </div>
      {agents.some((agent) => agent.id === "opencode" && agent.status === "missing") && (
        <div className="install-agent-card">
          <span>
            <DownloadGlyph />
          </span>
          <div>
            <strong>安装 OpenCode</strong>
            <p>安装位置：<code>~/.easywork/agents/opencode</code></p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={onInstall}
            disabled={connection.status !== "connected"}
          >
            安装
          </button>
        </div>
      )}
    </Modal>
  );
}

function DownloadGlyph() {
  return (
    <span className="download-glyph">
      <ArrowDown size={18} />
    </span>
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
