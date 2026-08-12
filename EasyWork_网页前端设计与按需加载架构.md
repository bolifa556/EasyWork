# EasyWork 网页前端设计与按需加载架构

> 本文是 EasyWork Web 的实施规范。文中的“必须”“不得”“仅当”均为验收要求。
> 本规范覆盖最终可交付范围，不按“近期 / 中期 / 远期”删减能力；末尾施工顺序只表示依赖关系。

---

## 1. 目标与边界

EasyWork 是以对话为主界面、以远端 Agent 为执行核心的多用户工作平台。功能增加后，普通 Chat 首屏仍必须保持：

```text
左侧导航 + 中央对话 + 可收起右栏
```

Work 能力按照当前服务器、Agent、工作区和任务上下文按需出现。Terminal、Git、任务、产物、文件预览、HPC 资源等不得在普通 Chat 首屏下载、初始化或请求数据。

统一原则：

1. **Progressive Disclosure**：用户未进入的能力不占界面。
2. **Lazy Code**：未进入的能力不进入首屏 JS/CSS。
3. **Lazy Data**：未打开的面板不请求对应数据。
4. **Capability Gate**：服务器或 Agent 不具备能力时不显示入口。
5. **Server Authority**：账号、对话、任务、服务器、记忆和产物由 Gateway 作为事实源；浏览器只保存设备级临时 UI 状态。
6. **Conversation First**：Agent 的计划、思考、命令、文件变化、审批、错误和最终回答以聊天正文中的时间线为唯一权威展示。
7. **No Duplicate Activity**：不得再在 Bottom Drawer、Right Sidebar 或 Task 面板维护第二套 Agent Activity 流；它们只能显示摘要和跳转。
8. **No Hidden Initialization**：不得通过 `display:none` 隐藏已静态 import、已初始化、已拉取数据的复杂功能。

---

## 2. 当前实现基线

EasyWork 当前只保留模块化实现：

- `app/page.tsx` 与深链入口只挂载 `app/easywork/EasyWorkApp.tsx`；根组件仅组合 Runtime 与 Shell。
- `app/easywork/features/` 按功能拆分页面、弹窗、工作台和 Viewer，并通过动态 import 按需加载。
- `app/easywork/styles/base.css` 只承载基础 token 与 Shell 关键样式；功能样式位于各自 CSS Module。
- `app/core/` 统一维护 HTTP、Realtime、实体、能力和 Viewer 注册合同。
- `/api/bootstrap` 只返回 Actor、设备、导航和连接摘要；对话、消息、项目、资源和任务分别分页读取。
- 所有写入使用领域 mutation、revision 与 commandId，不存在整包状态回写接口。
- Realtime 按 topic 鉴权订阅、回放和取消订阅；未进入 Work 时不扫描服务器 Agent。
- 远端目录逐级读取，文件上传下载使用原始字节流、Range、哈希和路径授权，不使用 base64 消息。
- Gateway 提供统一的 ServerCapabilityProfile，前端只显示且只加载真实可用能力。

后续功能增加不得破坏这些边界；禁止重新引入单体页面、全量 bootstrap、整包状态写入或双协议兼容层。

---

## 3. 最终目录结构

目录名称可以在实现时微调，但边界不得重新合并回单文件。

```text
app/
├── layout.tsx
├── page.tsx
├── [...path]/page.tsx             # /c、/p 与功能深链入口
├── core/                           # 合同、Gateway client、Realtime、Registry
└── easywork/
    ├── EasyWorkApp.tsx             # Runtime + Shell 挂载点
    ├── runtime/
    ├── shell/
    ├── ui/
    ├── styles/
    └── features/
        ├── conversation/
        ├── projects/
        ├── library/
        ├── skills/
        ├── help/
        ├── admin/
        ├── servers/
        ├── tasks/
        ├── artifacts/
        ├── workbench/
        └── viewers/

gateway/core/
├── server.mjs                     # HTTP、流式文件与 Realtime 入口
├── runtime/                       # Actor 容器与服务组合
├── http/                          # 领域路由和统一响应
├── auth/                          # 用户、设备、管理员与 Session
├── conversations/                # 摘要、消息、分支和消息动作
├── context-hub/                   # Scope、Delivery 与 Agent 水位
├── memory/                        # 五级记忆和失效边界
├── resources/                     # Blob、Version、Binding 与 Embedding
├── skills/                        # Actor Registry 与远端部署描述符
├── ssh/                           # Worker 池、网络策略、凭据与转发
├── agents/                        # 三种 Agent 事件适配
├── agent-runtime/                 # 部署、原生会话与运行控制
├── workspaces/                    # 虚拟、用户与动态工作区
├── versioning/                    # 隔离影子版本
├── orchestrator/                  # Task、事件、恢复与报告
├── artifacts/                     # 产物登记、Range 与资源转换
├── previews/                      # 授权预览与生命周期
├── scheduler/                     # Slurm、PBS 能力合同
└── audit/                         # 审计记录
```

每个 feature 至少包含：

```text
index.ts                 # 只导出公开 API
FeatureView.tsx          # lazy 入口
feature.module.css       # 随 feature chunk 加载
state.ts                 # 本 feature reducer / selector
api.ts                   # 领域 API
contracts.ts             # feature 内部类型
*.test.ts(x)
```

禁止 feature 直接读取另一个 feature 的内部 state。跨功能依赖只能通过 `core/contracts`、Shell command 或公开 selector。

---

## 4. 路由与 Shell 生命周期

### 4.1 URL 是可恢复页面状态

必须支持以下可分享、可前进后退的路由：

```text
/                              新对话
/c/:conversationId             对话
/p/:projectId                  项目主页
/library                       文件库
/library/:collectionId         文件集
/skills                        技能
/help                          帮助
/admin                         管理员面板
```

Main Workspace 中的临时对象使用 query 表达：

```text
/c/:id?view=file&preview=:previewId
/c/:id?view=task&task=:taskId
/c/:id?view=artifact&artifact=:artifactId
/c/:id?view=diff&change=:changeId
```

持久 Shell 放在共享 layout 中，路由切换不得重建：

- 账号和设备会话；
- WebSocket client；
- 正在运行任务的订阅；
- 左右栏动画状态；
- 未刷新的输入草稿；
- 当前浏览器会话中的对话滚动位置。

刷新或关闭浏览器后不恢复历史滚动位置；同一浏览器会话内返回对话时恢复离开位置。

### 4.2 默认布局

```text
Desktop
┌─────────────┬───────────────────────────┬───────────────┐
│ Navigation  │ Main Workspace            │ Right Sidebar │
│ Sidebar     │ Conversation by default   │ collapsible   │
└─────────────┴───────────────────────────┴───────────────┘
                         Bottom Drawer（默认关闭）
                         Top Overlay（默认关闭）
```

- 普通 Chat：Main 仅显示 Conversation；不显示空 Tab Bar。
- 打开文件、任务、产物或 Diff 后：显示 Main Tab Bar。
- 关闭所有额外 Tab 后：Tab Bar 自动隐藏。
- 左侧默认始终是 Navigation。Work 用户主动打开“工作区”后，可原位切换为 Workspace Sidebar；返回即恢复 Navigation。
- Right Sidebar 默认维持现有“远程连接 / 当前工作区 / 对话记录”结构。Inspector 是右栏的临时 view，不得永久覆盖这些入口。
- Bottom Drawer 只容纳 Terminal、Logs 和 Job Output。Agent Activity 只允许显示摘要与“回到聊天时间线”。

### 4.3 Main View

```ts
type MainView =
  | { kind: "conversation"; conversationId: string }
  | { kind: "file"; previewId: string }
  | { kind: "diff"; changeId: string }
  | { kind: "task"; taskId: string }
  | { kind: "artifact"; artifactId: string };
```

EasyWork 只允许一个活动 Main View 和多个可关闭 Tab。不得先引入通用 docking 框架。分屏能力必须建立在同一 `MainView` 合同上，不能另造 Viewer 状态树。

---

## 5. 状态模型

### 5.1 状态分层

```text
Server State
  actor / projects / conversation / messages / servers / agents
  workspaces / tasks / artifacts / library / memories

Realtime State
  connection snapshots / task progress / terminal stream
  agent events / scheduler jobs / file change invalidations

Route State
  current page / selected entity / active Main View

Layout State
  left mode / right view / drawers / sizes / mobile overlays

Ephemeral State
  open menu / unsent draft / local selection / hover / focus
```

Server State 不得以一个全局 `EasyWorkState` 整包保存。每个实体必须有独立 key、版本和 mutation。

### 5.2 根状态只保留

```ts
type ShellState = {
  actor: ActorSummary | null;
  device: DeviceSummary;
  bootstrapStatus: "loading" | "ready" | "error";
  featureFlags: Record<string, boolean>;
  navigation: {
    projects: ProjectSummary[];
    recentConversations: ConversationSummary[];
    nextCursor?: string;
  };
  layout: LayoutState;
};
```

Admin、文件库、技能、服务器管理、Agent 配置、Task、Artifact 和 HPC 数据不得挂在根组件的 `useState` 集合中。它们由 feature cache / reducer 管理，组件卸载后只保留明确允许缓存的 metadata。

### 5.3 并发与一致性

所有可持久实体包含：

```ts
type EntityVersion = {
  revision: number;
  updatedAt: string;
};
```

mutation 使用 `If-Match` 或请求体 `expectedRevision`。冲突返回 `409` 和最新实体，不允许浏览器用旧整包覆盖新数据。

对话消息、任务事件和 Terminal 输出使用只追加序列；编辑、重试、重置、回溯和分支通过显式 action 完成，不通过替换整个 conversation 数组完成。

---

## 6. HTTP API EasyWork

### 6.1 通用响应

成功：

```json
{
  "data": {},
  "meta": { "requestId": "req_...", "nextCursor": null }
}
```

失败：

```json
{
  "error": {
    "code": "SSH_NOT_CONNECTED",
    "message": "SSH 尚未连接",
    "retryable": true,
    "details": {}
  },
  "meta": { "requestId": "req_..." }
}
```

前端不得根据中文 message 判断错误类型。

### 6.2 Bootstrap

```http
GET /api/bootstrap
```

只返回：

```ts
type BootstrapResponse = {
  actor: ActorSummary;
  device: DeviceSummary;
  featureFlags: Record<string, boolean>;
  providers: ModelProviderSummary[];
  projects: ProjectSummary[];
  recentConversations: ConversationSummary[]; // 默认 20
  conversationCursor?: string;
  servers: ServerSummary[];
  runningTasks: TaskSummary[];                // 只含正在运行
};
```

不得包含完整 messages、全部任务历史、Artifact 历史、远端目录、Git 状态、Scheduler 节点、文件向量、全部记忆正文或 Agent 扫描结果。

### 6.3 对话与项目

```http
GET    /api/conversations?cursor=&limit=20&projectId=
POST   /api/conversations
GET    /api/conversations/:id
PATCH  /api/conversations/:id
DELETE /api/conversations/:id
GET    /api/conversations/:id/messages?before=&limit=50
POST   /api/conversations/:id/messages
POST   /api/conversations/:id/actions

GET    /api/projects?cursor=&limit=
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
```

`actions` 支持：

```text
branch / edit-latest / retry / reset / rewind
move-project / remove-project / pin / unpin
```

每个 action 必须返回受影响的 message、memory version、Agent binding、checkpoint 和 workspace change 摘要。

### 6.4 服务器与 Capability

```http
GET    /api/servers
POST   /api/servers
GET    /api/servers/:id
PATCH  /api/servers/:id
DELETE /api/servers/:id
POST   /api/servers/:id/connect
POST   /api/servers/:id/disconnect
GET    /api/servers/:id/capabilities
POST   /api/servers/:id/capabilities/refresh
```

```ts
type ServerCapabilityProfile = {
  schemaVersion: 1;
  serverId: string;
  detectedAt: string;
  expiresAt: string;
  status: "detecting" | "ready" | "partial" | "error";
  features: {
    remoteFiles: Capability;
    preview: Capability & { types: string[] };
    terminal: Capability & { pty: boolean; resume: boolean };
    git: Capability & { repository?: GitRepositorySummary };
    scheduler: Capability & {
      type: "slurm" | "pbs" | "none";
      resourceSummary: boolean;
      partitions: boolean;
      userJobs: boolean;
      jobHistory: boolean;
      cancelJob: boolean;
      jobOutput: boolean;
    };
    artifacts: Capability;
  };
  diagnostics: CapabilityDiagnostic[];
};
```

Capability 检测失败不等于 SSH 断开。前端显示可用能力，失败能力显示可重试原因。

### 6.5 Agent 与工作区

```http
GET   /api/servers/:id/agents
POST  /api/servers/:id/agents/scan
POST  /api/servers/:id/agents/install
POST  /api/servers/:id/agents/manual
PATCH /api/servers/:id/agents/:agentId/config
POST  /api/servers/:id/agents/:agentId/compact

GET   /api/servers/:id/workspaces?conversationId=
POST  /api/servers/:id/workspaces
POST  /api/servers/:id/workspaces/virtual
PATCH /api/conversations/:id/workspace
```

Agent 扫描只在以下情况触发：

- 用户打开 Agent 选择；
- Work 对话恢复且当前 Agent 摘要过期；
- 安装、卸载或手动添加后；
- 用户主动刷新。

普通 Chat 登录不得扫描 Agent。

### 6.6 Remote File 与 Preview

```http
GET  /api/servers/:id/fs?path=&cursor=&limit=
POST /api/servers/:id/fs/folders
POST /api/servers/:id/uploads
PUT  /api/uploads/:uploadId/parts/:part
POST /api/uploads/:uploadId/complete
POST /api/previews
GET  /api/previews/:previewId
GET  /api/previews/:previewId/content?range=
GET  /api/previews/:previewId/table?page=&sort=&filter=
GET  /api/remote-downloads/:downloadToken
```

浏览器可以提交当前已授权 workspace 内的 path 来创建 Preview，但后续只使用短期、用户绑定、服务器绑定的 opaque `previewId` / `downloadToken`。下载支持 HTTP Range、Content-Length、Content-Disposition、背压和断点续传。

目录列表只读取当前目录；不得递归扫描工作区。

### 6.7 Task 与 Artifact

```http
GET  /api/tasks?status=&cursor=&projectId=&serverId=&agentId=
GET  /api/tasks/:id
POST /api/tasks/:id/cancel
GET  /api/tasks/:id/events?afterSeq=
GET  /api/tasks/:id/jobs

GET  /api/artifacts?taskId=&conversationId=&projectId=&cursor=
GET  /api/artifacts/:id
GET  /api/artifacts/:id/download
POST /api/artifacts/:id/save-to-project
DELETE /api/artifacts/:id/cache
```

Artifact 下载 API 只接受 artifact id，不接受远端绝对路径。

### 6.8 Terminal、Git、Scheduler

```http
POST /api/servers/:id/terminals
GET  /api/terminals/:id
POST /api/terminals/:id/close

GET  /api/workspaces/:id/git/status
GET  /api/workspaces/:id/git/diff?path=&staged=
POST /api/workspaces/:id/git/stage
POST /api/workspaces/:id/git/unstage
POST /api/workspaces/:id/git/commit

GET  /api/servers/:id/scheduler/summary?partition=
GET  /api/servers/:id/scheduler/partitions
GET  /api/servers/:id/scheduler/jobs?scope=current-user&cursor=
GET  /api/servers/:id/scheduler/jobs/:jobId/output?stream=
POST /api/servers/:id/scheduler/jobs/:jobId/cancel
```

前端不得解析 `sinfo`、`squeue`、`pbsnodes` 文本；统一由 Scheduler Adapter 输出结构化数据。

---

## 7. WebSocket 契约

### 7.1 连接与订阅

使用单一 `/easywork-ws`，但数据通过 topic 按需订阅：

```json
{
  "type": "subscribe",
  "requestId": "req_1",
  "topics": [
    "conversation:conv_1",
    "task:task_1",
    "server:server_1"
  ],
  "resume": {
    "task:task_1": 184
  }
}
```

离开页面时发送 `unsubscribe`。浏览器断线重连后以每个 topic 的最后 `sequence` 请求 replay。

### 7.2 统一事件信封

```ts
type RealtimeEnvelope<T> = {
  schemaVersion: 1;
  eventId: string;
  topic: string;
  sequence: number;
  occurredAt: string;
  actorType: 'user' | 'guest';
  actorId: string;
  producer: 'web-agent' | 'orchestrator' | 'remote-agent' | 'ssh' | 'scheduler' | 'resource-indexer';
  kind: string;
  status: string | null;
  ids: Record<`${string}Id`, string | null>;
  payload: T;
};
```

要求：

- 同一 topic 的 `sequence` 严格递增；
- 重复 `eventId` 幂等忽略；
- sequence 缺口触发 replay，不允许静默丢事件；
- Event 不携带 API Key、密码、私钥、远端凭据或完整 Agent 配置；
- 大文件、Terminal backlog 和 Job output 不放进普通 JSON event；
- 未订阅 topic 不推送明细。

### 7.3 Work 事件

```text
run.started
run.reasoning.delta
run.reasoning.completed
run.plan.updated
run.agent-call.started
run.agent-message.delta
run.tool.started
run.tool.output
run.tool.completed
run.file.changed
run.approval.requested
run.job.updated
run.artifact.created
run.final.delta
run.completed
run.failed
run.aborted
```

事件顺序按 Agent 实际产生顺序保留，不得把相隔的命令、文件修改或 Agent 消息事后合并。

聊天正文中的 `ConversationTimeline` 是唯一 canonical renderer：

- 计划、思考、Agent 调用、命令、文件变化、审批、Job、Artifact 与 final 都在这里出现；
- Right Sidebar 只显示提问索引和步骤摘要；
- Task Detail 只引用同一 task event store；
- Bottom Drawer 不建立第二份 Agent Activity feed；
- 任意视图点击摘要均跳转 canonical event 或打开其对象详情。

### 7.4 Work 控制命令

```text
run.start
run.append
run.abort
approval.respond
terminal.input
terminal.resize
terminal.ack
```

每个命令包含 `requestId` 和 idempotency key。Agent 运行在浏览器关闭后继续；浏览器重连后通过 task subscription 恢复。

### 7.5 Terminal 流

Terminal 使用独立 binary frame 或专用 WS subprotocol。必须支持：

- PTY cols/rows resize；
- stdin/stdout/stderr；
- server-side flow control 与客户端 ack；
- detach/resume；
- idle timeout；
- 每用户、每服务器并发限制；
- close/revoke；
- 不把 Agent 命令伪装成用户 Terminal。

---

## 8. Feature Registry

Registry 是静态、可类型检查的映射，不是运行时插件市场。

```ts
type FeatureDefinition = {
  id: FeatureId;
  surface: "left" | "main" | "right" | "bottom" | "top" | "modal";
  route?: string;
  capability?: (profile: ServerCapabilityProfile, ctx: FeatureContext) => boolean;
  hasData?: (ctx: FeatureContext) => boolean;
  load: () => Promise<{ default: React.ComponentType<FeatureProps> }>;
  prefetch?: "never" | "hover-code-only";
};
```

```ts
const features: Record<FeatureId, FeatureDefinition> = {
  "remote-files": {
    id: "remote-files",
    surface: "left",
    capability: (profile) => profile.features.remoteFiles.available,
    load: () => import("../../features/remote-files/RemoteExplorer"),
    prefetch: "hover-code-only",
  },
  terminal: {
    id: "terminal",
    surface: "bottom",
    capability: (profile) => profile.features.terminal.pty,
    load: () => import("../../features/terminal/TerminalPanel"),
    prefetch: "never",
  },
};
```

Registry 决定：

1. 入口是否出现；
2. 点击后加载哪个 chunk；
3. surface 在哪里挂载。

Registry 不负责领域数据、权限判断或组件内部导航。最终权限仍由 Gateway 校验。

---

## 9. Viewer Registry 与 Preview

### 9.1 FileDescriptor

```ts
type FileDescriptor = {
  previewId: string;
  serverId: string;
  workspaceId: string;
  name: string;
  extension: string;
  mimeType: string;
  size: number;
  mtime: string;
  hash?: string;
  safety: "text" | "image" | "document" | "archive" | "binary" | "unknown";
  preview: {
    mode: "browser" | "gateway" | "remote-helper" | "metadata-only";
    ranges: boolean;
    editable: boolean;
  };
  downloadToken?: string;
};
```

浏览器不持有远端绝对路径作为后续授权依据。

### 9.2 Viewer Definition

```ts
type ViewerDefinition = {
  id: ViewerId;
  supports: (file: FileDescriptor) => number; // 0 不支持，数字越大越优先
  maxBrowserBytes?: number;
  load: () => Promise<{ default: React.ComponentType<ViewerProps> }>;
  fallback: "text" | "download" | "metadata";
};
```

Viewer 选择同时依据 MIME、扩展名、magic/sniff、size 和 Gateway safety；不得只依据扩展名。

### 9.3 Viewer 能力

| Viewer | 必须能力 | 数据策略 |
|---|---|---|
| Text / Code | 只读、行号、搜索、复制、跳转；编辑需显式进入 Edit | 小文件 range；大文件分页；Monaco lazy |
| Markdown | 预览 / 源码，HTML sanitize | 文本 range |
| JSON / YAML | 树 / 源码、搜索、虚拟化 | 大对象 Gateway 分段 |
| CSV / TSV | 分页、虚拟滚动、排序、过滤、冻结列、类型、统计 | 小文件浏览器；大文件 Gateway 查询 |
| Parquet | schema、row groups、sample、分页 | Gateway / helper 查询 |
| HDF5 / NetCDF | dataset tree、shape、dtype、attributes、slice、plot | remote helper 按 dataset/slice |
| Image | fit、zoom、pan、1:1、下载 | range / thumbnail |
| PDF | 分页、搜索、目录、缩放、下载 | PDF.js lazy + range |
| Notebook | Markdown、Code、文本/图/表输出；只读 | Gateway sanitize |
| Log | tail、follow、pause、搜索、过滤 | 流式 tail，不全量加载 |
| Archive | 目录、大小、下载；默认不解压 | Gateway/helper list |
| Binary / Model | size、hash、mtime、producedBy、下载 | 禁止反序列化 |
| Diff | 文件列表、逐文件 diff、折叠、搜索 | Monaco Diff lazy |

CSV 的 DuckDB、Chart 和高级统计只有用户点击“高级分析”后加载。Viewer 关闭时必须终止 Worker、释放 object URL、大 buffer 和 WASM instance。

### 9.4 用户编辑

任何 Web Editor 写入必须执行：

```text
校验 workspace 权限
→ EasyWork before checkpoint
→ 乐观锁检查 mtime/hash
→ 写文件
→ EasyWork after checkpoint
→ 发布 file.changed
```

冲突不得静默覆盖；显示服务器版本、本地编辑版本和 Diff。

---

## 10. Workspace

### 10.1 Work 准备流程

新建 Work 对话按固定顺序：

```text
选择 / 复用服务器
→ 选择 / 配置 Agent
→ 选择工作区（默认虚拟工作区）
→ 允许发送
```

设置完成后离开再返回，浏览器会话内保留草稿；服务器、Agent 和 workspace 选择由 Gateway 保存后可跨设备恢复。

### 10.2 工作区模型

```ts
type Workspace = {
  id: string;
  serverId: string;
  path: string;
  kind: "virtual" | "user" | "dynamic";
  writable: boolean;
  repository?: GitRepositorySummary;
  versionDomainId: string;
};
```

- 一个网页对话可绑定多个 Agent。
- 每个 Agent 在每个工作区拥有独立 Agent session。
- 从工作区 A 切到 B 时切换 Agent session；切回 A 时复用 A session，并只补齐缺失的网页记忆增量。
- 虚拟工作区允许 Agent 只读查询；发生动态写入时，对实际目录建立或复用该对话 + Agent + 目录的 session。
- 多对话共用工作区时，checkpoint 按实际时间顺序形成 version domain；回溯只撤销目标时间之后属于该分支的改动。

### 10.3 Workspace Sidebar

Work + SSH connected + 用户主动打开“工作区”后显示：

```text
[文件] [Git] [任务] [产物]
```

Tab 按 capability 和数据存在性出现：

- 文件：remoteFiles available；
- Git：当前 workspace 检测到用户 Git repository；
- 任务：存在当前任务、运行中任务或可访问历史；
- 产物：存在当前 Task / Conversation / Project Artifact。

关闭工作区后恢复 Navigation，不得让 Workbench 状态污染普通 Chat。

---

## 11. Task 与 Agent 时间线

```ts
type Task = {
  id: string;
  conversationId: string;
  runId: string;
  projectId?: string;
  serverId: string;
  agentId: string;
  agentSessionId: string;
  workspaceId: string;
  status:
    | "queued"
    | "preparing"
    | "delivering_context"
    | "running"
    | "waiting_approval"
    | "waiting_append"
    | "interrupting"
    | "interrupted"
    | "recovering"
    | "finalizing"
    | "completed"
    | "failed"
    | "cancelled";
  title: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  successCriteria?: string[];
  jobs: SchedulerJobRef[];
  artifactIds: string[];
  checkpointBeforeId?: string;
  checkpointAfterId?: string;
};
```

Task 是持久实体，不等于前端某个展开栏。浏览器关闭后继续执行并持久化 event sequence。

### 11.1 Canonical Conversation Timeline

聊天正文按真实事件顺序渲染：

```text
网页 LLM 思考
记忆 / 文件 / 对话 / Skill 查询
Work 上下文交接概览
远端 Agent 调用
执行计划（仅 Agent 原生 plan/todo 存在时）
Agent 中间文本
工具 / 命令
文件修改
审批
Job
Artifact
最终正文
```

要求：

- 不生成虚假的“执行计划”；
- Work 的网页 LLM 内容只表现上下文查询与交接，不显示成远端计划；
- 不按类型重新分组；
- `run.final.delta` 出现时收起 Agent 调用容器，但不删除中间事件；
- Chat Final 来自网页 Agent；Work Final 直接来自远端 Agent，不再经过网页模型二次改写；两者都只展示回答正文，不混入控制协议标记；
- 当前回答默认不强制滚到底；用户仍 pinned to bottom 时自然跟随并保留底部间距；
- 默认折叠命令、文件 Diff 等详细内容，展开箭头收起向右、展开向下；
- 中断、追加、编辑最新问题、重试、分支、回溯共享同一 Task / checkpoint / memory 语义。

### 11.2 Task Center

Task Center 只消费同一 Task store：

```text
运行中
历史（项目 / 服务器 / Agent / 状态 / 时间筛选）
```

Task Detail 可打开为 Main View，展示 Overview、Plan、Jobs、Changes、Validation、Metrics、Artifacts、Logs。点击 event 跳回 Conversation Timeline 对应 eventId；不得复制生成一份不同顺序的 Agent 记录。

---

## 12. Artifact

Artifact 是 Task 输出，不是 Agent 安装包，也不自动等于文件库 Resource。

```ts
type Artifact = {
  id: string;
  ownerId: string;
  taskId: string;
  conversationId: string;
  projectId?: string;
  serverId: string;
  workspaceId: string;
  name: string;
  mimeType: string;
  size: number;
  hash?: string;
  lifecycle: "remote" | "cached" | "expired" | "missing";
  previewCapability: string[];
  createdAt: string;
};
```

入口：

1. Conversation Artifact Card；
2. Workspace Artifact List；
3. Task Detail；
4. Main Artifact Viewer。

Artifact 默认只存在远端；只有“保存到项目”才复制到 EasyWork 管理存储并成为 Project Resource。缓存必须有配额、LRU/过期清理和可见生命周期。

---

## 13. Terminal

Terminal 是用户 Shell，与 Agent tool command 完全分离：

- UI 使用 lazy-loaded xterm.js；
- Gateway 使用 SSH PTY；
- 支持 resize、复制、粘贴、搜索、detach/resume 和明确关闭；
- Terminal 打开后才创建 PTY；关闭 Drawer 不等于立即销毁，可按配置进入短期 detach；
- 超过 idle timeout 后 Gateway 关闭；
- 用户能看见会话状态和关闭原因；
- Terminal 输出不写入 Conversation Timeline，除非用户显式“引用到对话”。

Bottom Drawer 中 Terminal 高度可调；移动端以全屏 Sheet 打开，不与软键盘抢占聊天输入框。

---

## 14. Git 与版本管理

Git UI 只操作用户工作区的 `.git`：

```text
Changes / Staged / Commit Message / Commit / History
```

EasyWork 自己的版本管理继续使用：

```text
~/.easywork/versioning/<versionDomain>/repository.git
独立 HOME
独立 GIT_DIR
独立 GIT_INDEX_FILE
```

硬性要求：

1. EasyWork checkpoint 不修改用户 `.git/index`、HEAD、refs、config 或 working tree 状态。
2. Git UI 不显示或操作 `.easywork/versioning`。
3. Agent 自带 Git 操作发生后，EasyWork checkpoint 仍对文件树拍照，不假设用户仓库 clean。
4. Web Edit、Agent Run、回溯、重试均使用同一 before/after checkpoint 合同。
5. 同目录嵌套工作区按 version domain 和 relative scope 处理，禁止父子工作区互相恢复无关文件。
6. 回溯先生成受影响文件预览和冲突诊断；用户确认后再应用。

Diff Viewer 由 Git UI 和 Conversation file_change 共用，不维护两套 Diff 组件。

---

## 15. Scheduler 与 HPC

### 15.1 Adapter

```ts
interface SchedulerAdapter {
  detect(): Promise<SchedulerCapability>;
  accessiblePartitions(user: string): Promise<Partition[]>;
  resourceSummary(scope: SchedulerScope): Promise<ResourceSummary>;
  userJobs(query: JobQuery): Promise<Page<SchedulerJob>>;
  jobOutput(jobId: string, cursor?: string): Promise<JobOutputPage>;
  cancelJob(jobId: string): Promise<void>;
}
```

Slurm 与 PBS 输出统一实体。任何命令输出解析都在 Gateway adapter 内完成并测试，前端不感知命令文本。

### 15.2 显示条件

Top Resource Strip / Drawer 仅当：

```text
Work
+ SSH connected
+ scheduler.type != none
+ resourceSummary available
+ 至少一个当前用户可访问 partition / queue
```

普通服务器完全不显示 HPC UI，也不为了凑资源卡执行 `top` 或 `nvidia-smi`。

### 15.3 Resource Summary

显示“当前用户可见范围”，不是整个中心资源：

```ts
type ResourceSummary = {
  scope: { partitionIds: string[]; label: string };
  nodes: ResourceBreakdown;
  cpuCores: ResourceBreakdown;
  accelerators: ResourceBreakdown & { unit: "device" };
  currentUserJobs: { running: number; pending: number };
  sampledAt: string;
};
```

状态包含 idle / allocated / mixed / unavailable。GPU 统计设备数量，不统计 CUDA Core。文案使用“当前可见空闲”或“分区空闲”，不得暗示一定可立即申请。

Resource Strip 只请求 summary 和 current job count。展开 Drawer 后才请求 partitions、状态细分和当前任务。Job history 只有打开 Task Center 历史时请求。

---

## 16. 动态 import 与 CSS 分包

### 16.1 Critical Bundle

首屏允许进入 Critical：

```text
Shell
Auth summary
Navigation summary
Conversation base UI
Input composer
Streaming text
基础 Markdown
Gateway HTTP / WS client
Common accessible primitives
```

不得进入普通 Chat initial bundle：

```text
Admin
Library management
Skill management
Server manager
Agent config editor
Remote Explorer
Monaco
xterm.js
PDF.js
DuckDB / WASM
Git UI
Diff Viewer
Task Detail
Artifact Viewer
HPC Charts
Parquet / HDF5 / NetCDF / Notebook Viewer
```

### 16.2 加载方式

Feature 和 Viewer 必须是独立文件，并使用：

```tsx
const TerminalPanel = lazy(() => import("./TerminalPanel"));
```

或经 Vinext 构建产物验证能拆 chunk 的等价方式。不得在同一 `EasyWorkApp.tsx` 中定义组件后仅条件渲染。

每次引入 lazy feature 后必须检查 `dist/client/assets`：

- 存在独立 feature chunk；
- initial entry 不包含 feature 的大型依赖；
- feature CSS 不进入 critical stylesheet；
- 未打开 feature 时 Network 中没有该 chunk 和数据请求。

### 16.3 CSS

全局 CSS 仅允许：

```text
tokens / reset / typography / shell geometry / chat critical
```

功能样式使用 CSS Module 或 feature-local stylesheet，随 feature chunk 加载。禁止继续在 `globals.css` 尾部叠加高特异性“最终覆盖”。公共 Button、Modal、Popover、Tabs、Field、EmptyState 由 primitives 提供，feature 只组合，不全局覆盖其他页面。

KaTeX CSS 与数学渲染只在消息检测到数学内容后加载；代码高亮、Diff、图表同理。

### 16.4 数据加载

```text
打开 Library      → 请求文件集摘要
进入文件集         → 请求该文件集分页文件
打开 Remote Files → 请求当前目录
展开目录           → 请求该子目录
打开 Git           → 请求 status
打开 Task          → 请求 detail 和当前页 events
打开 Artifact      → 请求 descriptor / preview
打开 HPC Drawer    → 请求 detail
打开 Job Output    → 订阅该 job output
```

### 16.5 Prefetch

只允许预取代码，不允许因为 hover 拉取 SSH、Git、Task、Artifact 或 Scheduler 数据。

代码预取条件：

- `navigator.connection.saveData !== true`；
- effectiveType 不是 2g / slow-2g；
- 主线程空闲；
- 不影响首屏交互。

---

## 17. 缓存与失效

```text
Metadata Cache   文件描述、目录页、capability、task summary
Preview Cache    已授权的小型 preview、thumbnail
Viewer State     滚动、列宽、过滤、展开节点
```

失效来源：

- mtime / hash 变化；
- `file.changed`；
- Task artifact event；
- workspace 切换；
- SSH reconnect；
- capability TTL 到期；
- 用户主动刷新。

目录 cache 必须以 userId + serverId + workspaceId + path 为 key。跨用户、跨服务器、跨 workspace 禁止复用。

敏感内容、API Key、SSH 凭据、Agent 配置正文不得进入 Service Worker、localStorage 或普通 query cache。

---

## 18. 桌面、平板与手机

统一断点：

```text
Phone       < 720px
Tablet      720px–1099px
Desktop     >= 1100px
```

断点依据容器可用宽度，而不是 UA。

### 18.1 Desktop

- Left Sidebar 常驻；可收窄但不消失。
- Right Sidebar 可收起，打开时不得把聊天压到不可读宽度。
- Workspace Sidebar 可原位替换 Navigation。
- Bottom Drawer 可调高度，最大不超过主区 60%。
- Top Resource Drawer 以 overlay 展开，不推挤对话。

### 18.2 Tablet

- Left Sidebar 默认可见；空间不足时变 overlay。
- Right Sidebar 默认关闭，以右侧 Sheet 打开。
- Main Tab 可横向滚动。
- Bottom Drawer 宽度覆盖 Main，不覆盖 Left；竖屏时可全宽。
- Modal 最大化利用宽度，保留 16px 安全边距。

### 18.3 Phone

- 输入框固定在底部安全区；新对话标题在可用区域居中。
- Left Sidebar、Right Sidebar、Workspace Sidebar 均为互斥全高 Sheet。
- 打开任一 Sheet 时锁定背景滚动并正确恢复焦点。
- Terminal、File Viewer、Task Detail 使用全屏页面 / Sheet，不把它们塞进窄对话列。
- Main Tab Bar 可滚动，只显示图标 + 截断标题。
- Resource Drawer 全宽从顶部覆盖。
- 触控目标至少 44×44 CSS px；紧凑行中的图标按钮视觉可小，但可点击区域不得小于 40×40。
- 软键盘打开时 Composer 功能行可见，Terminal 不自动抢焦点。

### 18.4 容器规则

- 对话正文使用可读最大宽度，不随超宽屏无限拉伸。
- Admin、Library、Task 列表可使用全 Main 宽度。
- 表格在 Phone 切为卡片或列选择，不依赖水平压缩文字。
- Popover 优先贴近触发器；空间不足转为 Bottom Sheet。
- 文件选择、账号、服务器、Agent、上下文配置在各断点保持同一信息层级，不因移动端删除关键操作。

---

## 19. 动画准则

动画只表达空间关系和状态变化，不作为装饰。

```text
Hover / press              90–140ms
Popover / tooltip          120–180ms
Accordion / event detail   160–220ms
Sidebar / drawer / sheet   220–280ms
Page content cross-fade    140–200ms
```

使用 `transform` 与 `opacity`；避免连续动画 width/height 导致主对话重排。确需高度动画的 accordion 使用测量高度并在结束后恢复 `height:auto`。

要求：

- 右栏收纳/展开平移，主区变化同步，不闪动；
- 项目列表展开显示真实上下关系；
- 菜单二级页使用同一容器内左右滑动；
- 正在运行使用克制的 spinner/progress，不同时出现多处动画；
- 新事件到达时不强制滚动；pinned 用户才自然跟随；
- `prefers-reduced-motion: reduce` 时禁用位移和持续旋转之外的非必要动画，spinner 改为低频状态指示；
- 动画不得阻塞点击、键盘焦点或屏幕阅读器状态更新。

---

## 20. 加载、空状态与错误

### 20.1 加载层级

1. **App bootstrap**：主内容中心显示 spinner + 简短文字；不得显示未就绪 Composer。
2. **Route feature**：只在目标区域显示 skeleton；Shell 和导航保持可用。
3. **Panel data**：保留旧数据并显示局部刷新状态，不清空整页。
4. **Action**：操作按钮本身显示进行中，防止换行和布局跳动。
5. **Long task**：由 Task 状态和 canonical timeline 持续展示，不用无限 toast。

### 20.2 Empty State

空状态只说明事实并给一个主要动作，例如：

```text
还没有文件集    [新建文件集]
未连接服务器    [连接]
未安装 Agent    [安装]
```

不得重复页面标题，不添加解释产品显而易见行为的大段灰字。

### 20.3 Error

错误按范围展示：

- field error：字段旁；
- action error：操作区域内，持续到用户关闭/重试；
- file indexing error：文件行持久显示原因和重试；
- feature error：Error Boundary 只替换该 feature；
- gateway offline：Shell 顶层状态，但允许查看已缓存只读内容；
- SSH error：服务器区域显示，不把 Gateway 标为离线；
- capability error：只禁用对应 capability；
- run error：canonical timeline 中持久显示。

Toast 只用于短暂成功反馈，不承担唯一错误信息。错误信息包含可执行动作，不暴露命令、凭据或内部堆栈。

### 20.4 Error Boundary

每个 lazy feature、Viewer、Right View、Drawer 和 Modal Host 必须有独立 Error Boundary。任一 Viewer 崩溃不得中断聊天流式输出或关闭正在运行的 Task subscription。

---

## 21. 无障碍与输入方式

必须达到 WCAG 2.2 AA 的可操作范围：

- 所有交互使用 button/link/input 等原生语义；
- 图标按钮有可本地化 accessible name；
- 当前 Tab、展开、选中、运行状态使用 `aria-selected`、`aria-expanded`、`aria-current`、`aria-busy`；
- 状态不能只靠红绿颜色；
- 正文和主要控件对比度至少 4.5:1；大字与图形至少 3:1；
- Modal / Sheet focus trap，Escape 关闭可关闭层，关闭后焦点回触发器；
- Popover 支持方向键、Home/End、Enter/Space、Escape；
- 文件树使用 tree/treeitem 语义并支持键盘展开；
- streaming final 使用节流后的 live region，不逐 token 轰炸屏幕阅读器；
- `run.approval.requested` 使用 assertive announcement；
- Terminal 提供可访问模式、复制输出和跳出快捷键；
- Diff、图表和环形资源卡提供等价文本表格；
- 虚拟列表不得让键盘焦点元素被无提示卸载；
- 200% 缩放与 320 CSS px 宽度下无关键操作丢失。

---

## 22. 安全与权限

- 所有 capability 只是 UI 提示，Gateway 每次请求仍执行 authorization。
- previewId、artifactId、downloadToken 绑定 user、server、workspace、过期时间和允许操作。
- Remote path 必须 canonicalize，并限制在当前授权 scope；符号链接越界必须拒绝或明确只读。
- Markdown、Notebook、SVG、HTML preview 必须 sanitize；禁止脚本、外部自动请求和 iframe 任意 origin。
- Archive 默认只列目录；防 Zip Slip；不自动解压。
- Binary/Model/Pickle 不反序列化。
- CSV 公式注入在导出或复制到表格软件时转义。
- Terminal 输入和输出不得写入普通应用日志；审计只记 actor/session/time/action metadata。
- API Key、私钥、密码只由专用 secret endpoint 管理，响应默认不返回明文。
- 管理员只能看到允许的连接 metadata，不获得用户 SSH credential。

---

## 23. 性能验收指标

以 Chrome/Edge 最新稳定版、桌面 1440×900、平板 768×1024、手机 390×844 验收；同时覆盖普通局域网和经 FRP 的 150ms RTT 网络。

### 23.1 Bundle

- Critical application JS（不含 React/Vinext framework）gzip ≤ 220 KB。
- Critical CSS gzip ≤ 45 KB。
- 普通 Chat initial graph 中不存在 Monaco、xterm、PDF.js、DuckDB、HDF5、Notebook、HPC chart chunk。
- 单个 feature chunk gzip 原则上 ≤ 180 KB；大型第三方依赖独立 chunk。
- 路由或功能关闭后，不再保留无用途 Worker/WASM 实例。

### 23.2 网络与数据

- bootstrap 压缩后 ≤ 100 KB，最近会话默认 ≤ 20。
- 首屏除 bootstrap、基础静态资源和轻量 WS 外，不请求 Work feature 数据。
- 普通 Chat 登录不触发 Agent scan、remote fs、git、scheduler、artifact、task history。
- conversation/message/task/artifact 列表全部有游标和服务端 limit。
- 任一目录请求不得递归。
- 1 GB Artifact 下载不进入 JS heap，支持 Range 和恢复。

### 23.3 Web Vitals

在验收网络与中档设备上：

- LCP ≤ 2.5s；
- INP ≤ 200ms；
- CLS ≤ 0.05；
- route feature 首次打开在数据返回前 100ms 内给出局部 loading；
- 运行中流式事件持续 30 分钟，聊天滚动与输入 p95 frame task < 50ms；
- 打开并关闭 10 个大型 Viewer 后，Worker 数和大 buffer 回到基线容许范围。

### 23.4 视觉稳定

- 按钮进入 loading 不换行、不改变主要宽度；
- Modal 切换 tab 不改变外框尺寸；
- Composer 从一行到多行不遮挡模型、上下文环和发送按钮；
- 新事件不会把未 pinned 用户拉到底部；
- Sidebar、Rail、Drawer 动画期间 CLS 仍接近 0。

---

## 24. 测试矩阵

### 24.1 Unit

| 对象 | 覆盖 |
|---|---|
| Feature Registry | capability、hasData、loader、无入口条件 |
| Viewer Registry | MIME/ext/magic/size 优先级、fallback、安全类型 |
| Reducer / cache | 分页合并、revision conflict、失效、跨 scope 隔离 |
| WS store | sequence、重复 event、缺口、replay、unsubscribe |
| Responsive state | overlay 互斥、焦点恢复、scroll lock |
| Work timeline | 原始顺序、不跨事件合并、final 分离 |

### 24.2 Gateway Contract

- bootstrap 不含禁止字段且有大小上限；
- 所有列表 cursor/limit 稳定；
- 409 revision conflict；
- Preview/Artifact token 越权、过期、跨用户、跨服务器拒绝；
- Range、断点、Content-Disposition、背压；
- remote path canonicalization 和 symlink 越界；
- upload 分片、重试、重复 complete；
- scheduler adapter fixture 覆盖 Slurm/PBS/none/部分权限/命令缺失；
- Terminal ownership、idle timeout、并发限额；
- 用户 Git 在 checkpoint 前后 refs/index/config 不变。

### 24.3 WebSocket

- 断线前后 sequence 连续；
- 重复 event 不重复渲染；
- 关闭浏览器后 Task 继续，重连恢复；
- 同用户多设备同时订阅；
- 未订阅服务器不发生 Agent scan；
- run.abort、运行中 append、approval、terminal flow control；
- 慢客户端不会拖垮 worker 或无限积压内存。

### 24.4 E2E 功能

```text
注册 / 登录 / 设备自动登录
Chat 流式输出 / Markdown / LaTeX / 代码块
项目 / 文件集 / 技能
Work 服务器 → Agent → Workspace 准备流程
Agent 安装 / 模型 / 权限 / 上下文 / 切换
中断 / 运行中追加 / 编辑最新提问 / 重试 / 分支 / 回溯
Remote Explorer / upload / download / preview / edit conflict
Terminal create / resize / detach / resume / close
Git status / stage / commit / Diff
Task 恢复 / 详情 / 历史
Artifact preview / range download / save-to-project / expired
Slurm/PBS resource / job / output / cancel
全部 Viewer 与 fallback
管理员页面与普通用户权限隔离
```

### 24.5 Capability 组合

至少覆盖：

1. 仅 SSH + Files；
2. Files + Git；
3. Files + Terminal；
4. Slurm；
5. PBS；
6. Scheduler 检测失败但 SSH 正常；
7. Agent 不支持 live input / context read / compact；
8. Preview helper 不可用；
9. Artifact 远端 missing；
10. 网络断开与恢复。

### 24.6 视口与输入

| 设备 | 视口 | 输入 |
|---|---:|---|
| Desktop | 1440×900、1920×1080 | mouse + keyboard |
| Small laptop | 1280×720 | mouse + keyboard |
| Tablet landscape | 1024×768 | touch + keyboard |
| Tablet portrait | 768×1024 | touch |
| Phone | 390×844、360×800 | touch + soft keyboard |
| Zoom | 200%、320 CSS px | keyboard |

浏览器覆盖 Edge、Chrome、Firefox 最新稳定版；Safari/iOS 覆盖无 `navigator.connection`、不同 safe-area 与文件上传行为。

### 24.7 Accessibility

- axe 无 critical/serious；
- 全站仅键盘完成主要任务；
- 屏幕阅读器完成登录、发送、审批、打开事件、切换 Tab、下载 Artifact；
- reduce motion；
- 高对比与色觉缺陷模拟；
- live region 不逐 token 重复朗读。

### 24.8 性能与泄漏

- bundle graph snapshot；
- 普通 Chat network allowlist；
- 10 万消息/事件的虚拟化与定位；
- 10 万文件目录使用服务端分页；
- 大 CSV 分页和 filter；
- 30 分钟 Terminal + Agent stream；
- Viewer/Worker/WASM open-close heap snapshot；
- 1 GB Artifact Range 下载；
- 150ms RTT、1% 丢包和弱网重连。

---

## 25. 施工依赖顺序

以下全部属于 EasyWork 完成范围。顺序只为避免在错误数据模型上构建 UI。

### Gate A：基线与合同

1. 固化桌面、平板、手机视觉回归。
2. 记录 bundle、bootstrap、首屏请求、Web Vitals 和内存基线。
3. 落地本规范中的 HTTP、WS、Capability、Task、Artifact、FileDescriptor 类型和 contract tests。

### Gate B：无视觉变化拆单体

1. 建立持久 Shell 和 route segments。
2. 拆出 Navigation、Conversation、RightRail。
3. lazy Admin、Library、Skills、Help 和所有配置 Modal。
4. 拆 critical CSS 与 feature CSS，并验证 Vinext chunk。

### Gate C：数据按需与实时订阅

1. 上线 summary bootstrap。
2. 对话、消息、项目、任务、Artifact 分页。
3. 用领域 mutation 取代整包 `/api/state`。
4. WS topic subscribe/replay，取消登录即 Agent scan 和全量 task replay。

### Gate D：Capability 与 Workspace Runtime

1. ServerCapabilityProfile 与 TTL/diagnostic。
2. Feature Registry gate。
3. Work 准备流程、Workspace Sidebar、Main TabHost、Right View、Drawer Host。

### Gate E：文件、Preview 与 Artifact 基础设施

1. Remote Explorer、opaque Preview、Range download、分片 upload。
2. 全部 Viewer Registry 能力与安全 fallback。
3. Artifact 实体、生命周期、保存到项目。

### Gate F：工程工作台

1. Diff 与用户 Git UI。
2. Web Edit + checkpoint。
3. Terminal PTY 与 Bottom Drawer。
4. Logs / Job Output。

### Gate G：Task 与 Scheduler

1. Durable Task/Artifact API 与 Task Center/Detail。
2. Slurm/PBS Adapter。
3. Resource Strip/Drawer、Partition、Jobs、History、Output、Cancel。

### Gate H：整体验收

1. 完成第 24 节全部矩阵。
2. 达到第 23 节指标。
3. 验证普通 Chat 不加载任何 Workbench 重依赖。
4. 验证 canonical Agent timeline 在 Chat、Task、Right Rail 间无重复、无顺序差异。

---

## 26. 完成定义

EasyWork Web EasyWork 只有同时满足以下条件才算完成：

- 普通 Chat 的视觉和交互复杂度不随 Workbench 功能数量增长；
- 代码、CSS、数据和 Runtime 均按能力、上下文和用户动作加载；
- 对话、任务、Agent、Workspace、Artifact、Scheduler 使用明确且可分页的 Gateway 合同；
- Agent 执行全过程只存在一条 canonical Conversation Timeline；
- Remote File、Terminal、Git、Task、Artifact、HPC 与全部 Viewer 均可在桌面、平板和手机完成核心操作；
- EasyWork 版本管理不影响用户 Git；
- 大文件不进入普通 WS JSON 和 JS heap；
- 任一 feature 失败不影响聊天和正在运行的远端任务；
- 构建产物、Network、内存、无障碍和 E2E 测试能够证明上述要求，而不是仅凭界面“看起来按需”。
