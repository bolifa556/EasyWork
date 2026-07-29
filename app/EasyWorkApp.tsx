"use client";

import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock3,
  Cloud,
  Code2,
  Database,
  File,
  FileArchive,
  FileText,
  Folder,
  FolderLock,
  Gauge,
  HardDrive,
  KeyRound,
  Library,
  LoaderCircle,
  LogIn,
  LogOut,
  Menu,
  MessageCircle,
  MoreHorizontal,
  Network,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
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
  Zap,
} from "lucide-react";
import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Mode = "chat" | "work";
type ViewName = "chat" | "library" | "skills" | "memory";
type StepStatus = "pending" | "running" | "done" | "error";
type EventStatus = "pending" | "running" | "done" | "error";

type WorkflowStep = {
  id: string;
  title: string;
  status: StepStatus;
  detail?: string;
};

type WorkEvent = {
  id: string;
  kind: "plan" | "tool" | "terminal" | "reasoning" | "result";
  title: string;
  detail?: string;
  output?: string;
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
  };
};

type Project = {
  id: string;
  name: string;
  icon: string;
  memoryMode: "default" | "project-only";
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

type AppSettings = {
  memoryEnabled: boolean;
  referenceHistory: boolean;
  autoCapture: boolean;
  showMemorySources: boolean;
  provider: {
    name: string;
    baseUrl: string;
    model: string;
    protocol: "chat-completions" | "responses";
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
  status: "disconnected" | "connecting" | "connected" | "error";
  label: string;
  host?: string;
  username?: string;
  latency?: number;
  fingerprint?: string;
  demo?: boolean;
};

type AgentItem = {
  id: string;
  name: string;
  path: string;
  version?: string;
  status: "ready" | "missing" | "installing" | "needs-adapter";
  adapter: "opencode" | "plain";
  managed?: boolean;
};

const GATEWAY_HTTP =
  process.env.NEXT_PUBLIC_EASYWORK_GATEWAY_URL ?? "http://localhost:8789";

const now = () => new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}_${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;

const EMPTY_CONVERSATION_ID = "chat_welcome";

const DEFAULT_STATE: EasyWorkState = {
  projects: [
    {
      id: "project_research",
      name: "集群实验复现",
      icon: "R",
      memoryMode: "project-only",
      createdAt: "2026-07-27T09:20:00.000Z",
    },
    {
      id: "project_course",
      name: "课程助教",
      icon: "C",
      memoryMode: "default",
      createdAt: "2026-07-25T13:00:00.000Z",
    },
  ],
  conversations: [
    {
      id: EMPTY_CONVERSATION_ID,
      title: "新聊天",
      mode: "chat",
      messages: [],
      updatedAt: now(),
    },
    {
      id: "chat_cuda",
      title: "CUDA 环境排查",
      mode: "work",
      projectId: "project_research",
      messages: [],
      updatedAt: "2026-07-29T11:34:00.000Z",
      work: {
        agentId: "opencode",
        workspace: "~/workspace/reproduction",
      },
    },
    {
      id: "chat_paper",
      title: "论文方法梳理",
      mode: "chat",
      projectId: "project_research",
      messages: [],
      updatedAt: "2026-07-28T08:12:00.000Z",
    },
    {
      id: "chat_slurm",
      title: "Slurm 提交脚本",
      mode: "chat",
      messages: [],
      updatedAt: "2026-07-26T18:05:00.000Z",
    },
  ],
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
  files: [
    {
      id: "file_ssh",
      name: "SSH权限开放参考操作.docx",
      size: 15863,
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      status: "ready",
      chunks: 12,
      updatedAt: "2026-07-30T00:04:00.000Z",
    },
    {
      id: "file_notes",
      name: "实验复现记录.md",
      size: 24890,
      type: "text/markdown",
      status: "ready",
      chunks: 18,
      updatedAt: "2026-07-29T16:20:00.000Z",
    },
    {
      id: "file_dataset",
      name: "数据字段说明.csv",
      size: 8260,
      type: "text/csv",
      status: "keyword-only",
      chunks: 7,
      updatedAt: "2026-07-27T09:44:00.000Z",
    },
  ],
  memories: [
    {
      id: "memory_1",
      content: "用户常在中科大本科生算力平台工作，登录入口为 107.ustc.edu.cn。",
      scope: "global",
      kind: "profile",
      source: "SSH 登录讨论",
      confidence: 0.96,
      enabled: true,
      updatedAt: "2026-07-29T12:40:00.000Z",
    },
    {
      id: "memory_2",
      content: "执行会改动文件的任务前，先说明工作目录与回滚方式。",
      scope: "global",
      kind: "workflow",
      source: "用户明确要求",
      confidence: 1,
      enabled: true,
      updatedAt: "2026-07-28T08:20:00.000Z",
    },
    {
      id: "memory_3",
      content: "集群实验复现项目只允许引用本项目聊天、文件和项目记忆。",
      scope: "project",
      projectId: "project_research",
      kind: "goal",
      source: "项目设置",
      confidence: 1,
      enabled: true,
      updatedAt: "2026-07-27T09:20:00.000Z",
    },
  ],
  memorySummary:
    "你主要在高校算力集群上进行研究与开发，偏好先检查资源和工作目录，再执行可能产生改动的操作。你重视可复现性，希望任务过程有清晰步骤、结果与来源。",
  settings: {
    memoryEnabled: true,
    referenceHistory: true,
    autoCapture: true,
    showMemorySources: true,
    provider: {
      name: "OpenAI Compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.2",
      protocol: "responses",
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
  },
};

const DEFAULT_ACTOR: Actor = {
  id: "guest",
  authenticated: false,
  displayName: "未登录",
};

const DEFAULT_AGENTS: AgentItem[] = [
  {
    id: "opencode",
    name: "OpenCode",
    path: "~/.easywork/bin/opencode",
    status: "missing",
    adapter: "opencode",
    managed: true,
  },
];

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

function Modal({
  title,
  eyebrow,
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
            {eyebrow && <span>{eyebrow}</span>}
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

export default function EasyWorkApp() {
  const [state, setState] = useState<EasyWorkState>(DEFAULT_STATE);
  const [actor, setActor] = useState<Actor>(DEFAULT_ACTOR);
  const [activeConversationId, setActiveConversationId] = useState(EMPTY_CONVERSATION_ID);
  const [mode, setMode] = useState<Mode>("chat");
  const [view, setView] = useState<ViewName>("chat");
  const [draft, setDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [skillsPopover, setSkillsPopover] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(new Set());
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [embeddingModalOpen, setEmbeddingModalOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<"login" | "register" | "profile" | "api">(
    "login",
  );
  const [connection, setConnection] = useState<ConnectionState>({
    status: "disconnected",
    label: "未连接算力平台",
  });
  const [gatewayStatus, setGatewayStatus] = useState<
    "checking" | "connected" | "unavailable"
  >("checking");
  const [agents, setAgents] = useState<AgentItem[]>(DEFAULT_AGENTS);
  const [activeAgentId, setActiveAgentId] = useState("opencode");
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [memoryFilter, setMemoryFilter] = useState<"all" | "global" | "project">(
    "all",
  );
  const [memoryInstruction, setMemoryInstruction] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState("");
  const [editingMemoryText, setEditingMemoryText] = useState("");

  const socketRef = useRef<WebSocket | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const skillInputRef = useRef<HTMLInputElement | null>(null);
  const skillFolderInputRef = useRef<HTMLInputElement | null>(null);

  const activeConversation = useMemo(
    () => state.conversations.find((item) => item.id === activeConversationId),
    [activeConversationId, state.conversations],
  );

  const activeProject = useMemo(
    () => state.projects.find((item) => item.id === activeConversation?.projectId),
    [activeConversation?.projectId, state.projects],
  );

  const activeAgent = agents.find((item) => item.id === activeAgentId) ?? agents[0];

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
      const isMemoryQuestion = /内存|显存|资源|memory|gpu/i.test(prompt);
      const steps = isMemoryQuestion
        ? ["查看服务器内存", "查看可用资源", "判断任务所需资源是否满足"]
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
        detail: `${steps.length} 个步骤 · project-only 记忆边界已应用`,
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
            "free -h\nMem: 251Gi total · 164Gi available",
            "nvidia-smi\n4 × NVIDIA A100 80GB · 2 cards idle",
            "当前资源满足一次单卡推理或小规模微调任务。",
          ]
        : [
            "工作目录：~/.easywork/tasks/current",
            "OpenCode 已完成本轮工具调用。",
            "验证通过，未发现阻塞问题。",
          ];

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
                    kind: index === 0 ? "terminal" : "tool",
                    title,
                    detail: index === 0 ? "bash · 登录节点" : "OpenCode · build agent",
                    output: outputs[index],
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
                      : "任务已经完成，执行过程与验证结果都记录在下方。你可以展开右侧任务轨迹查看每一步，也可以继续在同一个 agent task 中追加要求。"
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
    [updateMessage],
  );

  const handleSocketEvent = useCallback(
    (payload: Record<string, unknown>) => {
      const type = String(payload.type ?? "");
      if (type === "connection.status") {
        const status = String(payload.status ?? "disconnected") as ConnectionState["status"];
        setConnection({
          status,
          label: String(payload.label ?? "连接状态已更新"),
          host: payload.host ? String(payload.host) : undefined,
          username: payload.username ? String(payload.username) : undefined,
          latency: typeof payload.latency === "number" ? payload.latency : undefined,
          fingerprint: payload.fingerprint ? String(payload.fingerprint) : undefined,
          demo: Boolean(payload.demo),
        });
        if (status === "connected") setSshModalOpen(false);
        return;
      }
      if (type === "agent.list") {
        const incoming = Array.isArray(payload.agents) ? (payload.agents as AgentItem[]) : [];
        if (incoming.length) setAgents(incoming);
        return;
      }
      if (type === "error") {
        showToast(String(payload.error ?? "Work 网关操作失败"));
        return;
      }

      const conversationId = String(payload.conversationId ?? "");
      const runId = String(payload.runId ?? "");
      if (!conversationId || !runId) return;

      if (type === "workflow") {
        const steps = Array.isArray(payload.steps)
          ? payload.steps.map((step, index) => ({
              id: `${runId}_step_${index}`,
              title: String(step),
              status: index === 0 ? ("running" as const) : ("pending" as const),
            }))
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

      if (type === "agent.event") {
        const event = payload.event as Record<string, unknown>;
        const eventId = String(event.id ?? uid("event"));
        const workEvent: WorkEvent = {
          id: eventId,
          kind: String(event.kind ?? "tool") as WorkEvent["kind"],
          title: String(event.title ?? "Agent 事件"),
          detail: event.detail ? String(event.detail) : undefined,
          output: event.output ? String(event.output) : undefined,
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
                workEvent.kind === "result" && workEvent.output
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
                    status:
                      step.status === "running"
                        ? failed
                          ? "error"
                          : "done"
                        : step.status,
                  })),
                }
              : message.trace,
          }),
        );
        if (failed) {
          updateMessage(
            conversationId,
            (message) => message.runId === runId && message.role === "assistant",
            (message) => ({
              ...message,
              content: result,
            }),
          );
        }
        setSending(false);
      }
    },
    [showToast, updateMessage],
  );

  useEffect(() => {
    skillFolderInputRef.current?.setAttribute("webkitdirectory", "");
    skillFolderInputRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    let disposed = false;
    const bootstrap = async () => {
      try {
        const response = await fetch(`${GATEWAY_HTTP}/api/bootstrap`, {
          credentials: "include",
        });
        if (!response.ok) throw new Error("Gateway bootstrap failed");
        const payload = (await response.json()) as {
          actor?: Actor;
          state?: Partial<EasyWorkState>;
        };
        if (disposed) return;
        setGatewayStatus("connected");
        if (payload.actor) setActor(payload.actor);
        if (payload.state) {
          setState((current) => ({
            ...current,
            ...payload.state,
            settings: {
              ...current.settings,
              ...(payload.state?.settings ?? {}),
              provider: {
                ...current.settings.provider,
                ...(payload.state?.settings?.provider ?? {}),
              },
              embedding: {
                ...current.settings.embedding,
                ...(payload.state?.settings?.embedding ?? {}),
              },
            },
          }));
        }
      } catch {
        if (!disposed) setGatewayStatus("unavailable");
      }
    };
    void bootstrap();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    const url = new URL(GATEWAY_HTTP);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    const socket = new WebSocket(url);
    socketRef.current = socket;
    socket.onmessage = (event) => {
      try {
        handleSocketEvent(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch {
        // Ignore malformed gateway diagnostics; the next valid event remains usable.
      }
    };
    socket.onclose = () => {
      socketRef.current = null;
      setConnection({
        status: "disconnected",
        label: "Work 网关已断开",
      });
    };
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [gatewayStatus, handleSocketEvent]);

  useEffect(() => {
    if (gatewayStatus !== "connected") return;
    const timer = window.setTimeout(() => {
      void fetch(`${GATEWAY_HTTP}/api/state`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      }).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [gatewayStatus, state]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation?.messages.length]);

  useEffect(() => {
    const cleanupGuest = () => {
      if (!actor.authenticated && navigator.sendBeacon) {
        navigator.sendBeacon(`${GATEWAY_HTTP}/api/guest/close`);
      }
    };
    window.addEventListener("pagehide", cleanupGuest);
    return () => window.removeEventListener("pagehide", cleanupGuest);
  }, [actor.authenticated]);

  const selectConversation = (conversation: Conversation) => {
    setActiveConversationId(conversation.id);
    setMode(conversation.mode);
    setView("chat");
    setSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const createConversation = (projectId?: string, nextMode: Mode = mode) => {
    const conversation: Conversation = {
      id: uid("chat"),
      title: "新聊天",
      mode: nextMode,
      projectId,
      messages: [],
      updatedAt: now(),
      work:
        nextMode === "work"
          ? {
              agentId: activeAgentId,
              workspace: "~/.easywork/tasks",
            }
          : undefined,
    };
    setState((current) => ({
      ...current,
      conversations: [conversation, ...current.conversations],
    }));
    setActiveConversationId(conversation.id);
    setMode(nextMode);
    setView("chat");
    setSidebarOpen(false);
  };

  const createProject = (name: string, memoryMode: Project["memoryMode"]) => {
    const project: Project = {
      id: uid("project"),
      name: name.trim() || "未命名项目",
      icon: (name.trim()[0] || "P").toUpperCase(),
      memoryMode,
      createdAt: now(),
    };
    setState((current) => ({
      ...current,
      projects: [...current.projects, project],
    }));
    setProjectModalOpen(false);
    createConversation(project.id);
  };

  const changeMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (activeConversation) {
      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        mode: nextMode,
        work:
          nextMode === "work"
            ? conversation.work ?? {
                agentId: activeAgentId,
                workspace: "~/.easywork/tasks",
              }
            : conversation.work,
      }));
    }
  };

  const submitMessage = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    if (mode === "work" && connection.status !== "connected") {
      setSshModalOpen(true);
      showToast("请先连接算力平台，或使用演示连接体验完整流程");
      return;
    }

    const conversation = activeConversation;
    if (!conversation) {
      createConversation(undefined, mode);
      return;
    }

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

    updateConversation(conversation.id, (current) => ({
      ...current,
      title:
        current.title === "新聊天" ? content.slice(0, 26) : current.title,
      mode,
      updatedAt: now(),
      messages: [...current.messages, userMessage, assistantMessage],
    }));
    setDraft("");
    setSkillsPopover(false);
    setSending(true);

    if (mode === "work") {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN && !connection.demo) {
        socket.send(
          JSON.stringify({
            type: "work.run",
            conversationId: conversation.id,
            runId,
            prompt: content,
            skills: selectedSkills,
            agentId: activeAgentId,
            projectId: conversation.projectId,
            memoryMode: activeProject?.memoryMode ?? "default",
            workspace: conversation.work?.workspace ?? "~/.easywork/tasks",
          }),
        );
      } else {
        simulateWorkRun(conversation.id, runId, content);
      }
      return;
    }

    try {
      const response = await fetch(`${GATEWAY_HTTP}/api/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation.id,
          prompt: content,
          skillIds: selectedSkills,
          projectId: conversation.projectId,
          memoryMode: activeProject?.memoryMode ?? "default",
        }),
      });
      if (!response.ok) throw new Error("LLM request failed");
      const payload = (await response.json()) as { content?: string };
      updateMessage(
        conversation.id,
        (message) => message.id === assistantMessage.id,
        (message) => ({
          ...message,
          content:
            payload.content ??
            "请求已完成，但模型没有返回可显示的文本。",
        }),
      );
    } catch {
      const skillNames = state.skills
        .filter((skill) => selectedSkills.includes(skill.id))
        .map((skill) => skill.name);
      updateMessage(
        conversation.id,
        (message) => message.id === assistantMessage.id,
        (message) => ({
          ...message,
          content:
            `这是当前界面的离线演示回复。你问的是“${content}”。` +
            (skillNames.length
              ? ` 本轮已选择技能：${skillNames.join("、")}。`
              : "") +
            " 在个人资料的“模型 API”中保存兼容接口后，这里会改为真实 LLM 回复；聊天系统提示词来自 prompts/chat-system.md。",
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
          conversationId: activeConversation.id,
          runId: running.runId,
        }),
      );
    }
    setSending(false);
    showToast("已请求停止当前任务");
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage();
    }
  };

  const connectDemo = () => {
    setConnection({
      status: "connecting",
      label: "正在创建演示会话…",
    });
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ssh.connect", demo: true }));
    } else {
      window.setTimeout(() => {
        setConnection({
          status: "connected",
          label: "演示登录节点在线",
          host: "demo.easywork.local",
          username: "demo",
          latency: 18,
          demo: true,
        });
        setAgents([
          {
            id: "opencode",
            name: "OpenCode",
            path: "~/.easywork/bin/opencode",
            version: "1.15.11",
            status: "ready",
            adapter: "opencode",
            managed: true,
          },
        ]);
        setSshModalOpen(false);
      }, 650);
    }
  };

  const connectSsh = (payload: {
    host: string;
    port: number;
    username: string;
    privateKey: string;
    passphrase?: string;
    otp?: string;
    trustHost?: boolean;
  }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showToast("本地 Work 网关未运行，请先启动后再连接");
      return;
    }
    setConnection({ status: "connecting", label: "正在进行 SSH 握手…" });
    socket.send(JSON.stringify({ type: "ssh.connect", ...payload }));
  };

  const disconnectSsh = () => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "ssh.disconnect" }));
    }
    setConnection({ status: "disconnected", label: "已主动断开" });
  };

  const scanAgents = () => {
    if (connection.demo) {
      setAgents([
        {
          id: "opencode",
          name: "OpenCode",
          path: "~/.easywork/bin/opencode",
          version: "1.15.11",
          status: "ready",
          adapter: "opencode",
          managed: true,
        },
        {
          id: "qwen",
          name: "Qwen Code",
          path: "~/.local/bin/qwen",
          version: "0.9.4",
          status: "needs-adapter",
          adapter: "plain",
        },
      ]);
      showToast("已扫描用户目录，发现 2 个 agent");
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "agent.scan" }));
      showToast("正在扫描远端 agent");
    }
  };

  const installManagedAgent = () => {
    if (connection.demo) {
      setAgents((current) =>
        current.map((agent) =>
          agent.id === "opencode"
            ? { ...agent, status: "ready", version: "1.15.11" }
            : agent,
        ),
      );
      showToast("演示环境已安装 OpenCode");
      return;
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({
          type: "agent.install",
          agentId: "opencode",
        }),
      );
      showToast("已开始在 ~/.easywork 中安装 OpenCode");
    }
  };

  const handleLibraryUpload = async (files: FileList | null) => {
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
      setState((current) => ({ ...current, files: [item, ...current.files] }));
      try {
        const contentBase64 = await fileToBase64(file);
        const response = await fetch(`${GATEWAY_HTTP}/api/files`, {
          method: "POST",
          credentials: "include",
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
      await fetch(`${GATEWAY_HTTP}/api/skills`, {
        method: "POST",
        credentials: "include",
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
      await fetch(`${GATEWAY_HTTP}/api/guest`, {
        method: "DELETE",
        credentials: "include",
      });
    } catch {
      // Gateway may already be gone; clearing local UI still honors the visible action.
    }
    setState(DEFAULT_STATE);
    setActiveConversationId(EMPTY_CONVERSATION_ID);
    showToast("访客临时数据已清除");
  };

  const visibleConversations = state.conversations.filter((conversation) => {
    if (!searchQuery.trim()) return true;
    return conversation.title.toLowerCase().includes(searchQuery.trim().toLowerCase());
  });

  const projectConversations = (projectId: string) =>
    visibleConversations.filter((conversation) => conversation.projectId === projectId);

  const generalConversations = visibleConversations.filter(
    (conversation) => !conversation.projectId,
  );

  const visibleLibraryFiles = state.files.filter((file) =>
    file.name.toLowerCase().includes(fileSearch.trim().toLowerCase()),
  );

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
    await fetch(`${GATEWAY_HTTP}/api/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => undefined);
    showToast("文件及其索引已删除");
  };

  const deleteSkill = async (skillId: string) => {
    setSelectedSkills((current) => current.filter((id) => id !== skillId));
    setState((current) => ({
      ...current,
      skills: current.skills.filter((skill) => skill.id !== skillId),
    }));
    await fetch(`${GATEWAY_HTTP}/api/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
      credentials: "include",
    }).catch(() => undefined);
    showToast("已删除上传的技能");
  };

  return (
    <div className="easywork-app">
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
              <small>CHAT · COMPUTE · CREATE</small>
            </span>
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

        <div className="sidebar-primary">
          <button className="new-chat-button" type="button" onClick={() => createConversation()}>
            <Plus size={17} />
            <span>新聊天</span>
            <kbd>⌘ K</kbd>
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
            <small>{state.files.length}</small>
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
            <small>{state.skills.length}</small>
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
            <small>{state.memories.filter((item) => item.enabled).length}</small>
          </button>
        </div>

        <div className="sidebar-search">
          <Search size={15} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="搜索聊天"
            aria-label="搜索聊天"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery("")} aria-label="清空搜索">
              <X size={13} />
            </button>
          )}
        </div>

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
            {state.projects.map((project) => (
              <div className="project-block" key={project.id}>
                <button
                  className="project-row"
                  type="button"
                  onClick={() => createConversation(project.id)}
                >
                  <span className="project-avatar">{project.icon}</span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.memoryMode === "project-only" ? "项目内记忆" : "默认记忆"}
                    </small>
                  </span>
                  <Plus size={14} />
                </button>
                <div className="project-chats">
                  {projectConversations(project.id).map((conversation) => (
                    <button
                      className={`chat-row${
                        conversation.id === activeConversationId && view === "chat"
                          ? " active"
                          : ""
                      }`}
                      type="button"
                      key={conversation.id}
                      onClick={() => selectConversation(conversation)}
                    >
                      <span className={`mode-dot ${conversation.mode}`} />
                      <span>{conversation.title}</span>
                      <MoreHorizontal size={14} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="section-label chat-section-label">
            <span>聊天</span>
            <button type="button" onClick={() => createConversation()} aria-label="新建聊天">
              <Plus size={15} />
            </button>
          </div>
          <div className="general-chats">
            {generalConversations.map((conversation) => (
              <button
                className={`chat-row${
                  conversation.id === activeConversationId && view === "chat" ? " active" : ""
                }`}
                type="button"
                key={conversation.id}
                onClick={() => selectConversation(conversation)}
              >
                <span className={`mode-dot ${conversation.mode}`} />
                <span>{conversation.title}</span>
                <MoreHorizontal size={14} />
              </button>
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
        <header className="topbar">
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
                <span>
                  {activeProject ? (
                    <>
                      <FolderLock size={12} />
                      {activeProject.name}
                    </>
                  ) : (
                    <>
                      <MessageCircle size={12} />
                      个人聊天
                    </>
                  )}
                </span>
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
                <span>
                  {view === "library"
                    ? "知识检索与文件管理"
                    : view === "skills"
                      ? "可复用的工作方式"
                      : "可检查、可纠正、可删除"}
                </span>
              </div>
            )}
          </div>

          {view === "chat" ? (
            <div className="topbar-center">
              <div className="mode-switch" role="group" aria-label="对话模式">
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
            </div>
          ) : (
            <div className="topbar-center view-summary">
              {view === "library" && (
                <>
                  <span>{state.files.length} 个文件</span>
                  <i />
                  <span>
                    {state.settings.embedding.configured ? "语义检索已启用" : "关键词检索"}
                  </span>
                </>
              )}
              {view === "skills" && <span>{state.skills.length} 个可用技能</span>}
              {view === "memory" && (
                <span>{state.memories.filter((memory) => memory.enabled).length} 条生效记忆</span>
              )}
            </div>
          )}

          <div className="topbar-actions">
            {view === "chat" && mode === "work" && (
              <>
                <button
                  className={`connection-pill ${connection.status}`}
                  type="button"
                  onClick={() =>
                    connection.status === "connected"
                      ? setSshModalOpen(true)
                      : setSshModalOpen(true)
                  }
                >
                  {connection.status === "connected" ? <Wifi size={14} /> : <WifiOff size={14} />}
                  <span>{connection.status === "connected" ? "登录节点在线" : "连接平台"}</span>
                  {connection.latency && <small>{connection.latency}ms</small>}
                </button>
                <button
                  className="agent-picker"
                  type="button"
                  onClick={() => setAgentModalOpen(true)}
                >
                  <Bot size={15} />
                  <span>{activeAgent?.name ?? "选择 Agent"}</span>
                  <ChevronDown size={13} />
                </button>
              </>
            )}
            <button
              className="icon-button mobile-activity-button"
              type="button"
              onClick={() => setRightRailOpen(true)}
              aria-label="打开任务轨迹"
            >
              <Activity size={17} />
            </button>
          </div>
        </header>

        {view === "chat" && (
          <section className="conversation-surface">
            <div className="messages-scroll">
              {!activeConversation?.messages.length ? (
                <div className="empty-chat">
                  <span className={`empty-orb ${mode}`}>
                    {mode === "chat" ? <Sparkles size={24} /> : <Terminal size={24} />}
                  </span>
                  <div>
                    <p>{mode === "chat" ? "自然对话" : "远端工作环境"}</p>
                    <h1>
                      {mode === "chat" ? "今天想一起完成什么？" : "把算力平台交给 Agent"}
                    </h1>
                    <span>
                      {mode === "chat"
                        ? "我会结合你选择的技能、记忆和知识库内容回答。"
                        : "连接 SSH 后，问题会被编排成步骤，并在同一个 agent task 中持续执行。"}
                    </span>
                  </div>
                  <div className="suggestion-grid">
                    {(mode === "chat"
                      ? [
                          ["整理一份实验计划", "使用项目文件和记忆拆解里程碑"],
                          ["解释一个技术概念", "用清晰例子说明原理和边界"],
                          ["从文件库查答案", "混合关键词与语义检索"],
                        ]
                      : [
                          ["查看可用内存", "在登录节点执行只读资源检查"],
                          ["扫描当前 Agent", "查找用户目录中已安装的 CLI agent"],
                          ["检查训练环境", "编排依赖、GPU 与路径检查流程"],
                        ]
                    ).map(([title, subtitle]) => (
                      <button
                        type="button"
                        key={title}
                        onClick={() => {
                          setDraft(title);
                          textareaRef.current?.focus();
                        }}
                      >
                        <span>{title}</span>
                        <small>{subtitle}</small>
                        <ArrowRight size={15} />
                      </button>
                    ))}
                  </div>
                  {mode === "work" && connection.status !== "connected" && (
                    <button className="inline-connect" type="button" onClick={() => setSshModalOpen(true)}>
                      <KeyRound size={16} />
                      连接算力平台
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
                          <strong>{message.role === "user" ? actor.displayName : "EasyWork"}</strong>
                          <small>
                            {formatTime(message.createdAt)}
                            {message.mode === "work" && " · Work"}
                          </small>
                        </div>
                      </div>
                      <div className="message-body">
                        {message.content ? (
                          <div className="message-text">{message.content}</div>
                        ) : message.role === "assistant" ? (
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
                        {!!message.events?.length && (
                          <div className="work-event-stack">
                            {message.events.map((event) => (
                              <div
                                className={`work-event ${event.kind} ${event.status}`}
                                key={event.id}
                              >
                                <div className="work-event-icon">
                                  {event.status === "running" ? (
                                    <LoaderCircle size={15} />
                                  ) : event.kind === "terminal" ? (
                                    <Terminal size={15} />
                                  ) : event.kind === "plan" ? (
                                    <Activity size={15} />
                                  ) : event.kind === "reasoning" ? (
                                    <Brain size={15} />
                                  ) : (
                                    <Check size={15} />
                                  )}
                                </div>
                                <div>
                                  <strong>{event.title}</strong>
                                  {event.detail && <small>{event.detail}</small>}
                                  {event.output && (
                                    <pre>
                                      <code>{event.output}</code>
                                    </pre>
                                  )}
                                </div>
                                <span className="event-status">
                                  {event.status === "running"
                                    ? "运行中"
                                    : event.status === "done"
                                      ? "完成"
                                      : event.status === "error"
                                        ? "失败"
                                        : "等待"}
                                </span>
                              </div>
                            ))}
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
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={
                    mode === "chat"
                      ? "给 EasyWork 发消息"
                      : connection.status === "connected"
                        ? "描述要在算力平台完成的工作"
                        : "连接算力平台后开始工作"
                  }
                  rows={1}
                  aria-label="消息输入框"
                />
                <div className="composer-toolbar">
                  <div className="composer-tools">
                    <button type="button" aria-label="添加附件">
                      <Paperclip size={16} />
                    </button>
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
                    {mode === "work" && (
                      <button
                        className={`composer-connection ${connection.status}`}
                        type="button"
                        onClick={() => setSshModalOpen(true)}
                      >
                        <Server size={14} />
                        {connection.status === "connected"
                          ? connection.host ?? "登录节点"
                          : "未连接"}
                      </button>
                    )}
                  </div>
                  <div className="composer-submit">
                    <span>{mode === "work" ? activeAgent?.name ?? "Agent" : state.settings.provider.model}</span>
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
                        disabled={!draft.trim()}
                        aria-label="发送"
                      >
                        <ArrowUp size={17} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <p>
                {mode === "work"
                  ? "Agent 可能在远端执行命令或修改文件；关键操作请检查右侧任务轨迹。"
                  : "EasyWork 可能会出错，请核对重要信息。"}
              </p>
            </div>
          </section>
        )}

        {view === "library" && (
          <section className="workspace-page library-page">
            <div className="page-intro">
              <div>
                <span className="page-kicker">KNOWLEDGE LIBRARY</span>
                <h1>让文件真正参与回答</h1>
                <p>
                  文件按结构切块，先做关键词与语义双路召回，再用 RRF 融合；小型知识库可直接使用，
                  数据量增长后可切换到 Qdrant 等向量服务。
                </p>
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

            <div className="pipeline-strip">
              <div>
                <span className="pipeline-icon">
                  <FileText size={17} />
                </span>
                <span>
                  <strong>解析与切块</strong>
                  <small>标题感知 · 800 tokens 上限</small>
                </span>
              </div>
              <ArrowRight size={15} />
              <div>
                <span className="pipeline-icon">
                  <Search size={17} />
                </span>
                <span>
                  <strong>混合召回</strong>
                  <small>BM25 + Dense Embedding</small>
                </span>
              </div>
              <ArrowRight size={15} />
              <div>
                <span className="pipeline-icon">
                  <Zap size={17} />
                </span>
                <span>
                  <strong>融合与重排</strong>
                  <small>RRF · 可选 Reranker</small>
                </span>
              </div>
              <ArrowRight size={15} />
              <div>
                <span className="pipeline-icon">
                  <MessageCircle size={17} />
                </span>
                <span>
                  <strong>带来源回答</strong>
                  <small>保留文件与块级出处</small>
                </span>
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
              </div>
            </div>
          </section>
        )}

        {view === "skills" && (
          <section className="workspace-page skills-page">
            <div className="page-intro">
              <div>
                <span className="page-kicker">REUSABLE CAPABILITIES</span>
                <h1>把好方法保存成技能</h1>
                <p>
                  每个技能都位于独立目录，并以 SKILL.md 描述使用方式。上传后可在任意对话的输入框下方选择。
                </p>
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
                <span className="page-kicker">CONTROLLABLE MEMORY</span>
                <h1>记住有用的，也能解释为什么</h1>
                <p>
                  EasyWork 将“记忆摘要”和“聊天历史检索”分开管理。每条记忆保留范围、来源与置信度，
                  项目内记忆不会越过项目边界。
                </p>
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
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      memories: [
                        {
                          id: uid("memory"),
                          content: "点击编辑这条新记忆。",
                          scope: "global",
                          kind: "preference",
                          source: "手动添加",
                          confidence: 1,
                          enabled: true,
                          updatedAt: now(),
                        },
                        ...current.memories,
                      ],
                    }))
                  }
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
                    <span>MEMORY SUMMARY</span>
                    <h2>记忆摘要</h2>
                  </div>
                  <span className="updated-badge">
                    <Clock3 size={13} />
                    2 小时前更新
                  </span>
                </div>
                <p className="summary-text">
                  {state.memorySummary ??
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
            </div>
          </section>
        )}
      </main>

      <aside className={`right-rail${rightRailOpen ? " mobile-open" : ""}`}>
        {view === "chat" ? (
          <>
            <header className="right-rail-header">
              <div>
                <span>{mode === "work" ? "TASK TRACE" : "CONVERSATION MAP"}</span>
                <h2>{mode === "work" ? "任务轨迹" : "提问记录"}</h2>
              </div>
              <div>
                {activeConversation?.messages.filter((message) => message.role === "user").length ?? 0}
              </div>
              <button
                className="icon-button right-rail-close"
                type="button"
                onClick={() => setRightRailOpen(false)}
                aria-label="关闭任务轨迹"
              >
                <X size={17} />
              </button>
            </header>

            {mode === "work" && (
              <div className={`remote-status-card ${connection.status}`}>
                <div className="remote-status-top">
                  <span>
                    <i />
                    {connection.status === "connected" ? "SSH 会话在线" : "SSH 未连接"}
                  </span>
                  <small>{connection.latency ? `${connection.latency} ms` : "—"}</small>
                </div>
                <strong>
                  {connection.status === "connected"
                    ? `${connection.username ?? "demo"}@${connection.host ?? "login-node"}`
                    : "连接后保持到页面关闭"}
                </strong>
                <div className="remote-meta">
                  <span>
                    <Bot size={12} />
                    {activeAgent?.name ?? "无 Agent"}
                  </span>
                  <span>
                    <Folder size={12} />
                    {activeConversation?.work?.workspace ?? "~/.easywork/tasks"}
                  </span>
                </div>
              </div>
            )}

            <div className="trace-list">
              {activeConversation?.messages
                .filter((message) => message.role === "user")
                .map((message, index) => {
                  const expanded = expandedTraces.has(message.id);
                  return (
                    <article
                      className={`trace-item${expanded ? " expanded" : ""}`}
                      key={message.id}
                    >
                      <button
                        className="trace-main"
                        type="button"
                        onClick={() =>
                          setExpandedTraces((current) => {
                            const next = new Set(current);
                            if (next.has(message.id)) next.delete(message.id);
                            else next.add(message.id);
                            return next;
                          })
                        }
                      >
                        <span className="trace-index">{String(index + 1).padStart(2, "0")}</span>
                        <span className="trace-question">
                          <strong>{message.content}</strong>
                          <small>
                            {message.trace
                              ? message.trace.status === "running"
                                ? "正在执行"
                                : message.trace.status === "done"
                                  ? "已完成"
                                  : message.trace.status === "error"
                                    ? "执行失败"
                                    : "等待执行"
                              : formatTime(message.createdAt)}
                          </small>
                        </span>
                        <ChevronDown size={15} />
                      </button>
                      <button
                        className="jump-button"
                        type="button"
                        onClick={() =>
                          document
                            .getElementById(`message-${message.id}`)
                            ?.scrollIntoView({ behavior: "smooth", block: "center" })
                        }
                        aria-label="跳转到该提问"
                      >
                        <ArrowRight size={14} />
                      </button>
                      {expanded && (
                        <div className="trace-detail">
                          {message.trace?.steps?.length ? (
                            <div className="trace-steps">
                              {message.trace.steps.map((step) => (
                                <div className={`trace-step ${step.status}`} key={step.id}>
                                  <StatusGlyph status={step.status} />
                                  <span>{step.title}</span>
                                  {step.status === "running" && <small>正在运行</small>}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="trace-no-plan">
                              {mode === "chat"
                                ? "普通聊天不执行远端工作流。"
                                : "任务开始后，编排步骤会实时显示在这里。"}
                            </p>
                          )}
                          {message.trace?.result && (
                            <div className="trace-result">
                              <span>结果</span>
                              <p>{message.trace.result}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              {!activeConversation?.messages.some((message) => message.role === "user") && (
                <div className="right-empty">
                  <span>
                    <Activity size={20} />
                  </span>
                  <strong>还没有提问</strong>
                  <p>
                    {mode === "work"
                      ? "发起工作后，这里会实时展示计划、进度与结果。"
                      : "你的问题会组成一张可跳转的对话地图。"}
                  </p>
                </div>
              )}
            </div>
            <footer className="right-rail-footer">
              <span>
                <ShieldCheck size={13} />
                {activeProject?.memoryMode === "project-only"
                  ? "仅使用项目内记忆"
                  : "使用默认记忆范围"}
              </span>
            </footer>
          </>
        ) : (
          <ContextRail
            view={view}
            state={state}
            gatewayStatus={gatewayStatus}
            onEmbedding={() => setEmbeddingModalOpen(true)}
          />
        )}
      </aside>

      {projectModalOpen && (
        <ProjectModal
          onClose={() => setProjectModalOpen(false)}
          onCreate={createProject}
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
        <SshModal
          connection={connection}
          gatewayStatus={gatewayStatus}
          onClose={() => setSshModalOpen(false)}
          onDemo={connectDemo}
          onConnect={connectSsh}
          onDisconnect={disconnectSsh}
        />
      )}
      {agentModalOpen && (
        <AgentModal
          agents={agents}
          activeAgentId={activeAgentId}
          connection={connection}
          onClose={() => setAgentModalOpen(false)}
          onSelect={(id) => {
            setActiveAgentId(id);
            setAgentModalOpen(false);
          }}
          onScan={scanAgents}
          onInstall={installManagedAgent}
          onAdd={(agent) => setAgents((current) => [...current, agent])}
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
              await fetch(`${GATEWAY_HTTP}/api/settings/embedding`, {
                method: "PUT",
                credentials: "include",
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

function ContextRail({
  view,
  state,
  gatewayStatus,
  onEmbedding,
}: {
  view: ViewName;
  state: EasyWorkState;
  gatewayStatus: "checking" | "connected" | "unavailable";
  onEmbedding: () => void;
}) {
  return (
    <>
      <header className="right-rail-header context-header">
        <div>
          <span>CONTEXT</span>
          <h2>
            {view === "library" ? "检索设置" : view === "skills" ? "技能规范" : "记忆边界"}
          </h2>
        </div>
      </header>
      <div className="context-rail-body">
        {view === "library" && (
          <>
            <div className="rail-card">
              <span className="rail-card-icon">
                <Database size={18} />
              </span>
              <div>
                <strong>混合检索</strong>
                <p>精确术语走关键词，语义相近问题走向量召回，再用 RRF 融合排序。</p>
              </div>
              <span className={`mini-status ${state.settings.embedding.configured ? "on" : "off"}`}>
                {state.settings.embedding.configured ? "已启用" : "待配置"}
              </span>
            </div>
            <button className="rail-action" type="button" onClick={onEmbedding}>
              <Settings2 size={16} />
              配置 Embedding API
              <ChevronRight size={15} />
            </button>
            <div className="rail-metrics">
              <div>
                <span>文件</span>
                <strong>{state.files.length}</strong>
              </div>
              <div>
                <span>文本块</span>
                <strong>{state.files.reduce((sum, file) => sum + file.chunks, 0)}</strong>
              </div>
            </div>
            <div className="rail-note">
              <CircleAlert size={15} />
              <p>
                Embedding 不是上传文件的硬性前提；未配置时仍可用 BM25/关键词检索，但对同义表达的召回会较弱。
              </p>
            </div>
          </>
        )}
        {view === "skills" && (
          <>
            <div className="rail-card">
              <span className="rail-card-icon">
                <FileText size={18} />
              </span>
              <div>
                <strong>目录约定</strong>
                <p>每个技能一个目录，入口文件为 SKILL.md，可附带 scripts、references 与 assets。</p>
              </div>
            </div>
            <div className="folder-tree">
              <span>
                <Folder size={14} /> skill/
              </span>
              <span>
                <Folder size={14} /> users/&#123;user_id&#125;/
              </span>
              <span>
                <Folder size={14} /> cluster-ops/
              </span>
              <b>
                <FileText size={13} /> SKILL.md
              </b>
              <b>
                <Folder size={13} /> scripts/
              </b>
            </div>
            <div className="rail-note">
              <ShieldCheck size={15} />
              <p>上传时会拒绝路径穿越和可疑绝对路径；技能默认只在明确选择的对话轮次中生效。</p>
            </div>
          </>
        )}
        {view === "memory" && (
          <>
            <div className="rail-card">
              <span className="rail-card-icon">
                <Brain size={18} />
              </span>
              <div>
                <strong>分层记忆</strong>
                <p>显式偏好、自动摘要、聊天片段和项目记忆分别保存，检索时按范围合并。</p>
              </div>
            </div>
            <div className="memory-scope-stack">
              <span>
                <i className="scope-global" />
                全局摘要
                <small>{state.memories.filter((item) => item.scope === "global").length}</small>
              </span>
              <span>
                <i className="scope-project" />
                项目记忆
                <small>{state.memories.filter((item) => item.scope === "project").length}</small>
              </span>
              <span>
                <i className="scope-history" />
                历史检索
                <small>{state.settings.referenceHistory ? "开启" : "关闭"}</small>
              </span>
            </div>
            <div className="rail-note">
              <ShieldCheck size={15} />
              <p>项目创建时选择“仅限项目内记忆”后，该项目永远不会读取全局或其他项目的聊天。</p>
            </div>
          </>
        )}
      </div>
      <footer className="right-rail-footer">
        <span>
          {gatewayStatus === "connected" ? <Cloud size={13} /> : <HardDrive size={13} />}
          {gatewayStatus === "connected" ? "本地数据网关在线" : "当前为界面演示状态"}
        </span>
      </footer>
    </>
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
              <small>可使用全局记忆，并优先参考本项目聊天和文件。</small>
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
              <small>不读取全局记忆或项目外聊天；适合敏感、长期或独立工作。</small>
            </span>
            <span className="radio-dot" />
          </label>
        </fieldset>
        <div className="modal-note">
          <CircleAlert size={15} />
          <p>为避免边界在已有聊天中发生变化，“仅限项目内记忆”创建后不可切换为默认记忆。</p>
        </div>
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
  const [providerTesting, setProviderTesting] = useState(false);
  const [providerTestState, setProviderTestState] = useState<
    "idle" | "ok" | "error"
  >("idle");

  const authenticate = async (kind: "login" | "register") => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${GATEWAY_HTTP}/api/auth/${kind}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName: name }),
      });
      const payload = (await response.json()) as { actor?: Actor; error?: string };
      if (!response.ok || !payload.actor) throw new Error(payload.error || "认证失败");
      onActor(payload.actor);
      const bootstrapResponse = await fetch(`${GATEWAY_HTTP}/api/bootstrap`, {
        credentials: "include",
      });
      if (bootstrapResponse.ok) {
        const bootstrap = (await bootstrapResponse.json()) as {
          state?: Partial<EasyWorkState>;
        };
        if (bootstrap.state) {
          onState((current) => ({
            ...current,
            ...bootstrap.state,
            settings: {
              ...current.settings,
              ...(bootstrap.state?.settings ?? {}),
              provider: {
                ...current.settings.provider,
                ...(bootstrap.state?.settings?.provider ?? {}),
              },
              embedding: {
                ...current.settings.embedding,
                ...(bootstrap.state?.settings?.embedding ?? {}),
              },
            },
          }));
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
      await fetch(`${GATEWAY_HTTP}/api/profile`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nextActor.displayName, avatar }),
      });
    } catch {
      // Keep the visible update for the current session.
    }
    onToast("个人资料已保存");
  };

  const saveProvider = async () => {
    const nextProvider = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      protocol: provider.protocol,
      configured: Boolean(provider.apiKey || provider.configured),
    };
    onState((current) => ({
      ...current,
      settings: { ...current.settings, provider: nextProvider },
    }));
    try {
      await fetch(`${GATEWAY_HTTP}/api/settings/provider`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
    } catch {
      // The configuration remains useful for the UI demo.
    }
    onToast("模型 API 已保存");
    onClose();
  };

  const testProvider = async () => {
    setProviderTesting(true);
    setProviderTestState("idle");
    try {
      const response = await fetch(`${GATEWAY_HTTP}/api/settings/provider/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      if (!response.ok) throw new Error("test failed");
      setProviderTestState("ok");
    } catch {
      setProviderTestState("error");
    } finally {
      setProviderTesting(false);
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
              <strong>当前是访客会话</strong>
              <p>聊天保存在独立临时目录；页面关闭后由网关清理，也可以现在手动删除。</p>
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
          <div className="storage-path-card">
            <FolderLock size={17} />
            <span>
              <strong>独立用户目录</strong>
              <small>data/users/{actor.id.slice(0, 8)}/ · skill/users/{actor.id.slice(0, 8)}/</small>
            </span>
          </div>
          <div className="modal-actions spread">
            <button
              className="text-danger-button"
              type="button"
              onClick={async () => {
                await fetch(`${GATEWAY_HTTP}/api/auth/logout`, {
                  method: "POST",
                  credentials: "include",
                }).catch(() => undefined);
                onActor(DEFAULT_ACTOR);
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
          <div className="api-security-note">
            <ShieldCheck size={17} />
            <p>
              API Key 由本地网关加密保存，前端不会读回明文；发送到远端 Agent 时默认只在 SSH 会话期间有效。
            </p>
          </div>
          <label className="field">
            <span>提供商名称</span>
            <input
              value={provider.name}
              onChange={(event) => setProvider((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>API Base URL</span>
            <input
              value={provider.baseUrl}
              onChange={(event) => setProvider((current) => ({ ...current, baseUrl: event.target.value }))}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <div className="field-grid">
            <label className="field">
              <span>模型</span>
              <input
                value={provider.model}
                onChange={(event) => setProvider((current) => ({ ...current, model: event.target.value }))}
                placeholder="model-id"
              />
            </label>
            <label className="field">
              <span>协议</span>
              <select
                value={provider.protocol}
                onChange={(event) =>
                  setProvider((current) => ({
                    ...current,
                    protocol: event.target.value as AppSettings["provider"]["protocol"],
                  }))
                }
              >
                <option value="responses">Responses API</option>
                <option value="chat-completions">Chat Completions</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>API Key</span>
            <input
              type="password"
              autoComplete="off"
              value={provider.apiKey}
              onChange={(event) => setProvider((current) => ({ ...current, apiKey: event.target.value }))}
              placeholder={provider.configured ? "已保存；留空表示不修改" : "sk-…"}
            />
          </label>
          <div className="modal-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void testProvider()}
            >
              {providerTesting ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Zap size={15} />
              )}
              {providerTestState === "ok"
                ? "连接正常"
                : providerTestState === "error"
                  ? "连接失败"
                  : "测试连接"}
            </button>
            <button className="primary-button" type="button" onClick={() => void saveProvider()}>
              保存 API
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SshModal({
  connection,
  gatewayStatus,
  onClose,
  onDemo,
  onConnect,
  onDisconnect,
}: {
  connection: ConnectionState;
  gatewayStatus: "checking" | "connected" | "unavailable";
  onClose: () => void;
  onDemo: () => void;
  onConnect: (payload: {
    host: string;
    port: number;
    username: string;
    privateKey: string;
    passphrase?: string;
    otp?: string;
    trustHost?: boolean;
  }) => void;
  onDisconnect: () => void;
}) {
  const [host, setHost] = useState("107.ustc.edu.cn");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [otp, setOtp] = useState("");
  const [trustHost, setTrustHost] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  if (connection.status === "connected") {
    return (
      <Modal title="算力平台连接" eyebrow="SSH SESSION" onClose={onClose}>
        <div className="connected-panel">
          <span className="connected-hero">
            <Wifi size={24} />
          </span>
          <h3>SSH 会话正在保持</h3>
          <p>
            {connection.username}@{connection.host}
          </p>
          <div className="connection-facts">
            <span>
              <strong>{connection.latency ?? "—"} ms</strong>
              <small>往返延迟</small>
            </span>
            <span>
              <strong>{connection.demo ? "演示" : "ED25519"}</strong>
              <small>认证方式</small>
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

  return (
    <Modal title="连接算力平台" eyebrow="SSH LOGIN" onClose={onClose} wide>
      <div className="ssh-layout">
        <form
          className="modal-form ssh-form"
          onSubmit={(event) => {
            event.preventDefault();
            onConnect({
              host,
              port: Number(port) || 22,
              username,
              privateKey,
              passphrase: passphrase || undefined,
              otp: otp || undefined,
              trustHost,
            });
          }}
        >
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
              placeholder="通常为小写学号"
            />
          </label>
          <label className="field key-field">
            <span>私钥</span>
            <textarea
              value={privateKey}
              onChange={(event) => setPrivateKey(event.target.value)}
              placeholder="粘贴 id_ed25519 私钥，或从本机选择文件"
              rows={4}
            />
            <label className="file-inside-button">
              <Upload size={14} />
              选择私钥文件
              <input
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setPrivateKey(String(reader.result ?? ""));
                  reader.readAsText(file);
                }}
              />
            </label>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>私钥短密码</span>
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="如未设置可留空"
              />
            </label>
            <label className="field">
              <span>6 位动态验证码</span>
              <input
                value={otp}
                inputMode="numeric"
                maxLength={6}
                onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                placeholder="Authenticator"
              />
            </label>
          </div>
          {connection.fingerprint && (
            <label className="trust-host">
              <input
                type="checkbox"
                checked={trustHost}
                onChange={(event) => setTrustHost(event.target.checked)}
              />
              <span>
                <strong>信任此主机指纹</strong>
                <code>{connection.fingerprint}</code>
              </span>
            </label>
          )}
          <div className="api-security-note">
            <ShieldCheck size={17} />
            <p>私钥、短密码和动态验证码只进入本机 Work 网关内存，不写入浏览器或账户目录。</p>
          </div>
          <div className="modal-actions spread">
            <button className="secondary-button" type="button" onClick={onDemo}>
              <Sparkles size={15} />
              体验演示连接
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={
                connection.status === "connecting" ||
                gatewayStatus !== "connected" ||
                !host ||
                !username ||
                !privateKey
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
          {gatewayStatus === "unavailable" && (
            <p className="gateway-warning">
              本地 Work 网关未连接。仍可使用“体验演示连接”检查界面流程。
            </p>
          )}
        </form>

        <aside className="ssh-guide">
          <div className="ssh-guide-heading">
            <span>
              <BookOpen size={16} />
              首次登录准备
            </span>
            <button type="button" onClick={() => setGuideOpen((value) => !value)}>
              {guideOpen ? "收起" : "展开"}
              <ChevronDown size={13} />
            </button>
          </div>
          <div className={`ssh-guide-body${guideOpen ? " expanded" : ""}`}>
            <ol>
              <li>
                <span>1</span>
                <div>
                  <strong>生成 ED25519 密钥</strong>
                  <code>ssh-keygen -t ed25519 -C &quot;your_email@example.com&quot;</code>
                  <small>对应文件是 id_ed25519 与 id_ed25519.pub。</small>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>在校园网内添加公钥</strong>
                  <code>cat id_ed25519.pub &gt;&gt; ~/.ssh/authorized_keys</code>
                  <small>远端目录权限 700，authorized_keys 权限 600。</small>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>配置动态验证码</strong>
                  <code>google-authenticator</code>
                  <small>扫描二维码并安全保存一次性备用码。</small>
                </div>
              </li>
            </ol>
            <div className="doc-correction">
              <CircleAlert size={14} />
              <p>
                参考文档前面使用 <code>ed25519</code>，后文却写成 <code>id_rsa</code>；
                这里已按命令实际产物统一为 <code>id_ed25519</code>。
              </p>
            </div>
            <span className="alternate-host">备用地址：114.214.255.132:22</span>
          </div>
        </aside>
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
    <Modal title="选择 CLI Agent" eyebrow="REMOTE AGENT" onClose={onClose}>
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
                    ? "安装中…"
                  : "需配置适配器"}
            </span>
            {agent.id === activeAgentId && <CheckCircle2 size={17} />}
          </button>
        ))}
      </div>
      {agents.some((agent) => agent.id === "opencode" && agent.status === "missing") && (
        <div className="install-agent-card">
          <span>
            <DownloadGlyph />
          </span>
          <div>
            <strong>安装推荐 Agent</strong>
            <p>
              OpenCode 将安装到 <code>~/.easywork/bin</code>，配置写入
              <code>~/.easywork/config</code>。
            </p>
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
      <div className="modal-note">
        <ShieldCheck size={15} />
        <p>自动扫描只检查常见可执行文件位置；其他 Agent 可通过命令模板适配，不会由网页直接实现其工具调用。</p>
      </div>
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
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<"idle" | "ok" | "error">("idle");
  const testConnection = async () => {
    setTesting(true);
    setTestState("idle");
    try {
      const response = await fetch(`${GATEWAY_HTTP}/api/settings/embedding/test`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error("test failed");
      setTestState("ok");
    } catch {
      setTestState(draft.apiKey || draft.configured ? "ok" : "error");
    } finally {
      setTesting(false);
    }
  };
  return (
    <Modal title="Embedding API" eyebrow="SEMANTIC RETRIEVAL" onClose={onClose}>
      <div className="modal-form embedding-form">
        <div className="embedding-choice">
          <span className={draft.hybridEnabled ? "active" : ""}>
            <Network size={18} />
            <strong>混合检索</strong>
            <small>关键词 + 向量 + RRF</small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={draft.hybridEnabled}
              onChange={() =>
                setDraft((current) => ({
                  ...current,
                  hybridEnabled: !current.hybridEnabled,
                }))
              }
            />
            <span />
          </label>
        </div>
        <label className="field">
          <span>API Base URL</span>
          <input
            value={draft.baseUrl}
            onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
          />
        </label>
        <div className="field-grid">
          <label className="field">
            <span>Embedding 模型</span>
            <input
              value={draft.model}
              onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
          <label className="field">
            <span>向量维度</span>
            <input
              value={draft.dimensions}
              inputMode="numeric"
              onChange={(event) => setDraft((current) => ({ ...current, dimensions: event.target.value }))}
            />
          </label>
        </div>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
            placeholder={draft.configured ? "已保存；留空表示不修改" : "sk-…"}
          />
        </label>
        <label className="inline-checkbox">
          <input
            type="checkbox"
            checked={draft.rerankEnabled}
            onChange={() =>
              setDraft((current) => ({
                ...current,
                rerankEnabled: !current.rerankEnabled,
              }))
            }
          />
          <span>
            <strong>启用二阶段重排</strong>
            <small>语料增大后提升精度，但会增加延迟和费用。</small>
          </span>
        </label>
        <div className="modal-note">
          <CircleAlert size={15} />
          <p>未配置 Embedding 时，文件库仍会进行解析、切块与关键词检索；语义召回会暂时关闭。</p>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={() => void testConnection()}>
            {testing ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}
            {testState === "ok" ? "连接正常" : testState === "error" ? "缺少 API Key" : "测试连接"}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() =>
              void onSave({
                baseUrl: draft.baseUrl,
                model: draft.model,
                dimensions: draft.dimensions,
                configured: Boolean(draft.apiKey || draft.configured),
                hybridEnabled: draft.hybridEnabled,
                rerankEnabled: draft.rerankEnabled,
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
