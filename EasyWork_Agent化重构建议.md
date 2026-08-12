# EasyWork Agent 化后端实施规范

> 文档性质：规范性实施文档。文中的“必须”“不得”“仅”均为发布门槛。
>
> 适用范围：EasyWork 网关、网页 Agent、上下文、任务、SSH、远端 Agent、记忆、文件库、Skill、工作区、版本、Artifact 与调度器。
>
> 最终状态：EasyWork 仅运行本文定义的数据模型和协议；旧字段、旧提示词、旧接口与双格式兼容代码在一次性迁移验收后删除。

---

## 1. 目标与边界

EasyWork 的职责是把正确的用户目标、有效上下文、资源、记忆和 Skill 交给正确的远端 Agent，并以可审计、可恢复、可回放的方式管理整个任务生命周期。

系统必须同时提供四个协作层：

1. **Web Agent**：查询授权上下文；Chat 时直接回答，Work 时只执行只读查询，交接证据由运行时从成功的工具结果确定性构造；
2. **Context Hub**：按服务端计算出的 Scope 读取上下文，生成不可变的 ContextSession 和 ContextDelivery；
3. **Task Orchestrator**：作为确定性基础设施负责任务状态机、后台执行、中断、追加、恢复、报告和事件持久化，不生成执行计划；
4. **Remote Agent Adapter**：把统一任务协议映射到 OpenCode、Codex、Claude Code 的原生接口。

系统必须保持以下权威边界：

- 网页对话和网页模型上下文由 EasyWork 管理；
- 长期记忆、对话状态、任务状态由 EasyWork 分层管理；
- Agent 原生会话由对应 Agent 管理，EasyWork 仅通过适配器绑定和控制；
- 服务器真实文件由远端文件系统管理；
- 用户自己的 Git 仓库由用户管理；
- EasyWork 回溯使用隔离的影子版本库，不修改用户 `.git`；
- Scheduler 作业由 Slurm、PBS 或通用进程系统管理，EasyWork 只保存映射、状态和证据；
- EasyWork 自己在远端产生的一切数据必须位于 `~/.easywork`。

Web Agent 不得替代远端 Agent 制定远端计划、执行 SSH 命令、扫描源码、直接修改远端工作区或二次改写远端 final。远端 Agent 独占远端任务的规划与执行，但不得自行扩大可见的用户、项目、资源和记忆范围。

---

## 2. 当前实现基线

当前代码已具备可复用基础：

- `gateway/core/ssh/`、`agent-runtime/` 与 `agents/` 中的用户 SSH Worker 池、三种 Agent 原生适配和原生会话控制；
- `gateway/core/memory/` 与 `context-hub/` 中的五级记忆作用域、版本链、sequence、authority、confidence、sensitivity 与失效账本；
- `gateway/core/workspaces/`、`versioning/`、`runtime/` 与 `orchestrator/` 中的工作区、影子版本、后台任务、报告和实时事件；
- `prompts/` 中的 Chat 回答、Work 上下文装配、Agent 原生规则和对话压缩提示词；
- `tests/` 中现有的接口、状态和前端行为测试。

EasyWork 不把这些代码拆成独立微服务，而是将其整理为模块化单体。以下旧机制必须被目标机制替换：

| 旧机制 | EasyWork 机制 |
| --- | --- |
| 请求内临时拼接完整上下文 | Context Hub + ContextSession + ContextDelivery |
| `agentMemoryDelta` 与松散 cursor | 有版本的 Delivery、接收回执与 adapter session watermark |
| 不含服务器身份的 Agent binding key | 完整 BindingKey，必须包含 `serverIdentity` |
| WorkerTask 与对话消息混合持久化 | TaskState、ConversationState、EventLog 分离 |
| 仅作为前端事件的 artifact | 可鉴权、可下载、可转资源的 Artifact Service |
| 仅靠命令文本判断 Slurm/PBS | ServerCapabilityProfile + SchedulerAdapter |
| 资源文件与绑定关系耦合 | ResourceBlob、ResourceVersion、ResourceBinding 分离 |
| 分散在单文件中的路由与状态变更 | 明确模块 API、Actor 写队列和状态机 |

现有原生 Agent 接入、SSH Worker、严格 Embedding、影子 Git 隔离原则必须保留，但必须改为本文的数据契约。

---

## 3. 架构原则

### 3.1 模块化单体

EasyWork 以一个网关进程部署。模块之间通过显式函数接口和领域事件协作，不允许通过读取其他模块内部 JSON 文件耦合。

模块清单：

```text
gateway/core/
  identity/          用户、设备、管理员、鉴权、ActorContext
  persistence/       原子写、schema、Actor 写队列、迁移
  web-agent/         网页模型能力协商与工具循环
  context-hub/       Scope、ContextSession、Delivery、Usage
  memory/            PersistentMemory、ConversationState、TaskState
  resources/         Blob、Version、Collection、Binding、Embedding
  skills/            主机 Registry、版本固定、远端 ensure
  tasks/             Orchestrator、状态机、事件和报告
  agents/            OpenCode、Codex、Claude Code adapter
  ssh/               Worker 池、Session、目标策略、SFTP、转发
  workspaces/        工作区、动态写入、Binding
  versioning/        影子版本、checkpoint、分支、选择性回溯
  artifacts/         结果登记、下载、转 Resource
  scheduler/         generic、Slurm、PBS
  transport/         REST、WebSocket、Agent Bridge
  audit/             审计、配额、用量
```

所有模块位于 `gateway/core/`，具备独立导出接口、独立状态模型和对应测试；禁止通过重新引入单体兼容入口绕过领域边界。

### 3.2 Actor 串行写与原子持久化

所有写操作必须归属于一个 Actor：已登录用户使用 `user:<userId>`，访客使用 `guest:<deviceId>`。同一 Actor 的状态变更进入串行 mutation queue；跨 Actor 请求不得共用可变对象。

所有 JSON 持久化必须采用“临时文件写入、flush、原子 rename”流程。任务事件先追加日志，再更新物化视图。进程重启时以事件日志和最新有效快照恢复，不以浏览器内存为准。

---

## 4. 主机与远端目录规范

### 4.1 主机每用户数据目录

所有登录用户数据必须位于：

```text
data/users/<userId>/
  profile/
  state/
  credentials/
  projects/
  conversations/
  memory/
  resources/
    blobs/
    versions/
    collections/
    bindings/
    indexes/
  skills/
    registry/
    packages/
  workspaces/
  tasks/
  artifacts/
  scheduler/
  runtime/
  audit/
```

访客数据必须位于 `data/guests/<deviceId>/`，使用同一 schema，但退出清理策略独立。不得在项目源码目录、全局临时目录或其他用户目录保存用户资源、向量、SSH 凭据、Agent 绑定和任务日志。

`credentials/` 中的 API Key、SSH 私钥和密码必须加密保存；解密后的值只存在于请求或 Worker 的短生命周期内存中，不得进入 prompt、事件 payload、日志、错误堆栈或 Artifact。

### 4.2 远端 `~/.easywork`

EasyWork 在服务器上创建的所有运行与控制数据必须位于：

```text
~/.easywork/
  agents/                       EasyWork 部署的 Agent 应用
  skills/                       EasyWork Skill 远端缓存
  runtime/
    agents/<agentId>/<runtimeId>/
    context/<taskId>/
    releases/
  runs/<runId>/
  services/
  bindings/
  virtual/
  worktrees/
  versioning/
  artifacts/
  tmp/
```

除用户明确选择的工作区输出外，EasyWork 不得在 `~/.easywork` 外创建控制文件、会话映射、脚本、缓存或配置。用户工作区内只允许出现用户任务实际要求的产物。

EasyWork 部署的 Agent 必须使用 `~/.easywork/runtime/agents/...` 下的隔离 HOME、配置和数据目录。用户部署的 Agent 必须使用其原生配置；EasyWork 不得写入或迁移 `~/.codex`、`~/.claude`、`~/.config/opencode` 等原生目录。

---

## 5. 身份、Scope 与服务端权威路由

### 5.1 ActorContext

REST、WebSocket 和 Agent Bridge 的每次调用都必须由服务端建立：

```ts
type ActorContext = {
  actorType: 'user' | 'guest';
  actorId: string;
  userId?: string;
  deviceId: string;
  sessionId: string;
  roles: string[];
};
```

客户端提交的 `userId`、项目 ID、资源路径和 Scope 只作为请求参数，不能成为鉴权依据。服务端必须从登录 Session 解析 Actor，再逐项验证所有实体归属。

### 5.2 EffectiveContextScope

Context Hub 必须由服务端计算唯一的有效 Scope：

```ts
type EffectiveContextScope = {
  actorType: 'user' | 'guest';
  actorId: string;
  userId: string | null;
  projectId: string | null;
  conversationId: string;
  workspaceId: string | null;
  taskId: string | null;
  serverId: string | null;
  serverIdentity: string | null;
  versionDomainId: string | null;
  memoryMode: 'project-only' | 'global';
  branchId: string;
  memorySnapshotSequence: number;
  memorySnapshotVersionIds: string[];
  resourceBindingSnapshotId: string;
  selectedCollectionIds: string[];
  selectedSkillVersions: Array<{ skillId: string; version: string }>;
  capabilities: string[];
  contextEpoch: number;
};
```

`serverIdentity` 必须由主机公钥指纹、规范化地址和端口生成，不能只使用可改名的 `serverId`。Agent 会话绑定键必须为：

```text
actorType + actorId + serverIdentity + workspaceId + agentId + conversationId + branchId + contextEpoch
```

Scope 的身份来自服务端 ActorContext。访客在 `data/guests/<deviceId>` 中使用同一套 Chat、资源和上下文实体；需要登录的 SSH、管理员或持久协作能力由对应 Service 单独要求已登录用户，Context Hub 本身不以 `userId` 是否存在决定可用性。

同一网页对话可以绑定多个 Agent；每个 Agent 在每个工作区拥有独立的原生会话。切回已使用的 Agent/工作区时复用该原生会话，并只投递其 watermark 之后的新 Delivery。

### 5.3 路由权威

Work 对话首次绑定服务器后，Conversation Route 成为权威路由。后续任务不得直接采用浏览器临时传入的 `serverId`。服务端必须从 ConversationBinding 解析服务器、工作区、Agent 和版本域，再验证浏览器请求是否与绑定一致。

---

## 6. 核心领域模型

EasyWork 必须至少持久化以下实体，并为每个实体定义 `schemaVersion`、`createdAt`、`updatedAt`：

```text
User / Device / AuthSession
ServerProfile / SshSession / UserSshWorker
Project / Conversation / Branch
ConversationState / PersistentMemory / TaskState
Workspace / WorkspaceBinding / VersionDomain / VersionEvent / Checkpoint
AgentInstallation / AgentBinding / AgentSessionWatermark
SkillPackage / SkillVersion / TaskSkillPin
ResourceBlob / ResourceVersion / Collection / ResourceBinding / EmbeddingIndex
ContextSession / ContextDelivery / ContextUsage
Task / TaskEvent / TaskReport
Artifact
ServerCapabilityProfile / SchedulerJob
AuditEvent / UsageRecord
```

所有外键必须在写入前验证归属。删除采用 tombstone 与引用检查；Blob、Skill 包和 Artifact 的物理清理由 GC 在无引用且超过保留期后执行。

---

## 7. Web Agent

### 7.1 只读工具循环

Chat 与 Work 的 Web Agent 都只能使用同一组只读上下文工具：记忆查询、资源查询、历史对话查询、Skill 查询和当前结构化状态读取。

- Chat：查询后直接生成回答；
- Work：只执行上下文查询；运行时保留用户原始问题并从成功查询结果构造证据，不采纳模型自由文本，不生成执行计划或最终结论；
- Web Agent 永远不得获得 Task create/observe/append/interrupt/resume、裸 SSH、任意文件路径、任意数据库写入和 Secret 读取工具。

每次运行必须设置最大迭代数、最大输入/输出 token、最大墙钟时间、单工具超时和总工具调用数。Work 模型结束后，由主机根据持久 Task 状态确定 create、append 或 resume；这些生命周期操作使用服务端生成的 `idempotencyKey`，不由模型调用。

### 7.2 模型能力协商

Web Agent Provider 必须探测并记录模型是否支持：

- 原生 tool calling；
- reasoning/think 流；
- JSON schema 输出；
- 多模态输入；
- 流式输出；
- token usage。

不支持原生 tool calling 时，使用受 JSON Schema 校验的结构化输出回退；解析失败只允许在预算内重试，不得把未校验文本当工具参数执行。

### 7.3 Prompt 管理

所有影响模型行为的文本必须位于 `prompts/`，按角色拆分：

```text
prompts/web/chat-system.md
prompts/web/work-system.md
prompts/memory/conversation-compact.md
prompts/memory/persistent-memory-extract.md
prompts/agents/common.md
prompts/agents/opencode.md
prompts/agents/codex.md
prompts/agents/claude-code.md
```

协议校验、鉴权、Scope、状态机和路由不得依赖 prompt。Work 网页提示词只描述如何选择并压缩上下文；远端 Agent 提示词描述用户原始目标、可见上下文、工作区和可用 Skill，并明确由远端 Agent 自主规划和执行。提示词不包含“为了配合网页架构”等对执行无用的实现说明。

---

## 8. Context Hub

### 8.1 职责

Context Hub 是确定性基础设施，不是第二个记忆数据库。它只能从权威实体读取数据，按 EffectiveContextScope 过滤、排序、裁剪并生成 Delivery。

输入来源：

- 当前网页消息窗口和 ConversationState；
- PersistentMemory；
- 当前 TaskState；
- ResourceBinding 和检索结果；
- 固定版本的 Skill；
- Workspace/Server/Agent 能力摘要；
- 上一次被确认有效的 Agent 上下文状态。

输出必须记录每一片上下文的来源、版本、可见范围、token 估算、敏感等级和 hash。

### 8.2 ContextSession

每次 Web Agent 或 Remote Agent 开始工作时创建 ContextSession：

```ts
type ContextSession = {
  id: string;
  actorId: string;
  consumer: 'web-agent' | 'remote-agent';
  consumerId: string;
  scope: EffectiveContextScope;
  budget: { maxTokens: number; reservedOutputTokens: number };
  status: 'open' | 'sealed' | 'stale' | 'closed';
  createdAt: string;
  sealedAt: string | null;
};
```

Session 创建后 Scope 不可修改。Scope 改变必须新建 Session。

### 8.3 ContextDelivery

Delivery 是不可变的有序投递单元：

```ts
type ContextDelivery = {
  id: string;
  sessionId: string;
  sequence: number;
  mode: 'bootstrap' | 'delta' | 'refresh' | 'invalidate';
  entries: ContextEntry[];
  supersedes: string[];
  digest: string;
  createdAt: string;
};
```

Adapter 必须在成功交给同一原生 Agent 会话后写入 receipt 和 watermark。切换 Agent 后只发送该 Binding 未确认的新内容；不得重复发送其已经确认的历史。Delivery 必须可幂等重放。

### 8.4 `contextEpoch`

以下操作必须递增 `contextEpoch`，旧 Agent Session 标记为 stale，下一任务创建新原生 Session：

- 用户撤回敏感信息或降低权限；
- 项目记忆从全局收紧为仅项目；
- 分支、回溯、编辑提问、重置回复导致可见历史失效；
- 关键事实被纠正且旧事实不得继续可见；
- ResourceBinding 或 Skill 权限被撤销。

普通新增消息、记忆和文件不递增 epoch，只生成 delta Delivery。

### 8.5 Agent 上下文读取与压缩

Adapter 只能读取 Agent 原生接口明确提供的上下文用量和上限。读取不到时状态必须为 `unavailable`，前端显示无法读取；不得根据消息长度伪造。

Agent 上下文压缩必须调用 Agent 自身原生压缩能力或向同一原生会话发送其支持的 compact 指令。EasyWork 不得改写 Agent 原生历史冒充压缩。压缩完成后更新 watermark 和可读取用量；失败必须保留原会话并返回原因。

---

## 9. 记忆与状态分层

### 9.1 PersistentMemory

长期记忆分为用户、项目、工作区三类，必须保留：

- `memoryId` 与不可变 version；
- scope、sequence、authority、confidence、sensitivity；
- provenance：来源消息、任务、资源和操作者；
- supersedes、invalidates 与撤回账本；
- 结构化正文和用于检索的摘要。

项目默认 `project-only`。只有用户明确选择全局记忆时，项目外用户记忆才进入 Scope。不同项目之间不得隐式共享项目记忆。

### 9.2 ConversationState

ConversationState 是网页对话的结构化物化状态，不等同于消息全文。必须包含：

- currentGoal；
- confirmedFacts；
- constraints；
- decisions；
- openQuestions；
- completedWork；
- pendingWork；
- referencedResources；
- workspace/agent/server bindings；
- summaryVersion、sourceMessageRange、contextEpoch。

自动压缩生成新版本，不覆盖旧版本。默认阈值为上下文上限的 `0.95`，用户可修改；保存阈值本身不得伪装成正在压缩。只有超过新阈值或用户明确点击压缩时才启动压缩任务。

### 9.3 TaskState

TaskState 只保存本次任务状态：目标、计划、当前步骤、追加指令、approval、Agent 原生会话、运行证据、Artifact、错误和恢复游标。任务完成后可提取候选长期记忆，但写入 PersistentMemory 必须经过规则校验和来源记录。

### 9.4 分支、编辑、重试、重置与回溯

- 分支：复制目标点的 ConversationState、记忆版本快照、ResourceBinding 快照和版本 checkpoint 引用；不撤销当前工作区之后发生的其他操作；
- 编辑最新用户提问：在同一 Conversation 内截断该消息之后的消息、任务、记忆和绑定派生物，递增 epoch，再重新执行；
- 重试回复：替换同一用户提问对应的回复和任务派生物，不创建新对话；
- 重置回复：行为与重试相同，后续分支、记忆和文件派生关系一并失效；
- 回溯：用户确认后使目标点之后的对话、记忆、任务、ResourceBinding 派生版本和 EasyWork 版本事件失效，并执行选择性文件回溯。

所有操作必须生成 AuditEvent，且不得直接删除用于审计的旧 version。

---

## 10. Resource、Binding 与严格 Embedding

### 10.1 数据模型

```ts
type ResourceBlob = {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  storagePath: string;
};

type ResourceVersion = {
  id: string;
  resourceId: string;
  blobId: string;
  filename: string;
  parseStatus: 'pending' | 'ready' | 'failed';
  embeddingStatus: 'pending' | 'ready' | 'failed';
  parserVersion: string;
  embeddingProfileId: string | null;
};

type ResourceBinding = {
  id: string;
  resourceVersionId: string;
  ownerType: 'collection' | 'project' | 'conversation' | 'task';
  ownerId: string;
  path: string | null;
  createdSequence: number;
  invalidatedSequence: number | null;
};
```

同一文件内容只保存一个 Blob；文件集、项目、对话和任务通过 Binding 复用 ResourceVersion。分支复制的是截至分支点的 Binding 引用快照，不复制 Blob。

### 10.2 上传与目录

必须支持单文件、批量文件和文件夹上传。文件夹上传保留相对路径并验证：

- 路径必须相对、规范化且不能逃逸；
- 禁止绝对路径、`..`、设备名和非法分隔符；
- 单文件大小、总大小、数量和解压后大小受配额限制；
- 大文件使用分片/流式上传，不允许把完整文件读入网关内存。

上传完成先形成 Blob/Version，再异步解析和 Embedding。错误状态持久化，前端可重新索引并查看完整失败原因，错误不得一秒后消失且无处追溯。

### 10.3 严格 Embedding

文件库知识检索必须以管理员已配置且健康的 Embedding Profile 为前提。未配置、模型不可用、维度不一致或向量生成失败时：

- 文件仍可下载、删除和查看解析状态；
- 资源不得标记为知识可用；
- 对话和项目不得通过关键词兼容路径假装完成知识检索；
- 前端必须显示明确索引失败原因和重试入口。

向量、chunk、parser 元数据全部位于当前 Actor 的 `data/users/<userId>/resources/indexes/` 或 `data/guests/<deviceId>/resources/indexes/`。Embedding Profile 记录 URL 引用、模型、维度、分块策略、parser 版本和 index version；API Key 不进入该目录的普通元数据。

### 10.4 检索与直接附件

知识检索按 Binding 可见范围过滤后再向量搜索，结果必须记录 ResourceVersion、chunk locator、score、retrieval type 和 ContextUsage。

对话直接附件采用两条明确路径：

- 模型原生支持且文件大小符合限制的图片/文本，可作为 `direct` Delivery 投递；
- 需要跨轮、项目或文件集检索的内容，必须完成解析和 Embedding 后作为 `retrieval` Delivery 投递。

压缩 ConversationState 时只保存 ResourceBinding 与 ResourceVersion 引用，不把完整文件内容写入摘要。

---

## 11. Skill Registry 与远端 Skill

### 11.1 主机权威 Registry

每个用户的 Skill 必须在主机 Registry 中登记：

```ts
type SkillVersion = {
  skillId: string;
  version: string;
  sha256: string;
  packagePath: string;
  manifest: SkillManifest;
  installedAt: string;
};
```

上传时校验 manifest、文件数量、大小、路径和 hash。任务只能引用当前用户 Registry 中已安装的固定版本，禁止远端按模型文本从互联网任意下载 Skill。

### 11.2 选择与发现

用户在对话中选择的 Skill 是本任务的固定/强制 Skill，必须由主机在 Task 启动前写入 Scope 和 TaskSkillPin。Web Agent 可以只读查询当前用户 Registry，用于补充 Skill 说明，但不能自行改变 TaskSkillPin；未经用户选择或其他明确授权的 Skill 不会因为模型文本而部署到远端。

### 11.3 远端 ensure

Remote Adapter 在启动任务前调用 `skills.ensure(skillId, version, sha256)`：

1. 检查 `~/.easywork/skills/<skillId>/<version>/manifest.json`；
2. hash 匹配则复用；
3. 缺失时通过 SSH/SFTP 从主机包上传到临时目录；
4. 校验 hash 后原子 rename；
5. 以只读路径或 adapter 支持的临时注入方式提供给 Agent。

不得把 EasyWork Skill 写入用户原生 Agent 的全局 Skill 目录。任务完成后可保留校验过的远端缓存，GC 按版本引用和最后使用时间清理。

---

## 12. Task Orchestrator

Task Orchestrator 是基础设施状态机，不是模型规划器。它只根据 ConversationRoute、绑定身份和持久 Task 状态执行确定性生命周期操作：无活动 Task 时 create/start，运行中 append，中断后且能力允许时 resume，其他状态返回明确冲突。任务内容如何分解、先后执行哪些步骤，完全由远端 Agent 的原生计划机制决定。

### 12.1 TaskEnvelope

```ts
type TaskEnvelope = {
  taskId: string;
  actorId: string;
  conversationId: string;
  branchId: string;
  goal: string;
  route: ConversationRoute;
  contextSessionId: string;
  agentBindingId: string;
  skillPins: Array<{ skillId: string; version: string }>;
  resourceBindingSnapshotId: string;
  versionCheckpointId: string | null;
  budgets: TaskBudgets;
  idempotencyKey: string;
};
```

TaskEnvelope 创建后不可修改；追加内容进入 TaskCommand/EventLog，不覆盖原目标。

### 12.2 状态机

```text
queued
  -> preparing
  -> delivering_context
  -> running
  -> waiting_approval | waiting_append
  -> interrupting
  -> interrupted
  -> recovering
  -> running
  -> finalizing
  -> completed | failed | cancelled
```

每次状态迁移必须验证允许的前序状态，写 TaskEvent，再更新 TaskState。浏览器关闭、WebSocket 断开或用户切换设备不得终止任务。

### 12.3 执行计划

“执行计划”只来自远端 Agent 的原生 todo/plan/goal 事件。Agent 没有输出计划时不显示该栏目。进度随原生事件更新，不允许网页模型事后编造或在任务完成时突然把全部步骤打勾。

---

## 13. Context Bridge 与 Delivery

### 13.1 Managed Agent

EasyWork 部署的 Agent 必须优先使用短生命周期 Task Token 与本地 Bridge：

- 网关生成只绑定 `taskId + agentBindingId + contextSessionId` 的 token；
- 通过 SSH reverse forwarding 将远端 `127.0.0.1:<ephemeral>` 映射到主机 Bridge；
- Bridge 只接受该 token 对应的 `context.read/search/resource.read/skill.read`；
- token 过期、任务结束、中断或 epoch 变化后立即失效；
- Agent 无法通过参数指定其他 user/project/scope。

若服务器禁止端口转发，则将本次 Delivery 物化到 `~/.easywork/runtime/context/<taskId>/`，包含 manifest、内容分片和 hash。任务结束后清理；敏感内容不得写入可被其他用户读取的权限位。

### 13.2 User-deployed Agent

用户部署的 Agent 不允许 EasyWork 修改原生配置。Adapter 必须根据能力矩阵选择：

1. 原生命令参数或环境变量支持临时 Bridge：按任务注入；
2. 支持 MCP/RPC 且可临时传入：按任务注入；
3. 都不支持：把必要的 Bootstrap/Delta 作为当前原生会话消息投递。

能力不足必须显示为明确的 capability，不得静默写用户配置。

### 13.3 Delivery 回执

Bridge 或 Adapter 每次接受 Delivery 后必须记录：

- deliveryId、digest、sequence；
- nativeSessionId；
- acceptedAt；
- rejected entries 与原因；
- token usage（可读时）；
- watermark。

未收到回执的 Delivery 在恢复时幂等重放；digest 相同的已确认 Delivery 不重复进入 Agent。

---

## 14. 三种 Agent Adapter

### 14.1 统一接口

```ts
interface RemoteAgentAdapter {
  detect(): Promise<AgentDetection>;
  inspectCapabilities(): Promise<AgentCapabilities>;
  installOrUpdate?(source: ManagedAgentPackage): Promise<InstallResult>;
  openSession(binding: AgentBinding, delivery: ContextDelivery): Promise<NativeSession>;
  start(task: TaskEnvelope, session: NativeSession): AsyncIterable<NativeAgentEvent>;
  append(taskId: string, text: string): Promise<CommandReceipt>;
  interrupt(taskId: string): Promise<CommandReceipt>;
  resume(taskId: string): AsyncIterable<NativeAgentEvent>;
  compact(sessionId: string): Promise<CompactResult>;
  inspectContext(sessionId: string): Promise<ContextStatus>;
  close(sessionId: string): Promise<void>;
}
```

所有 Adapter 对外必须提供相同的任务语义。原生能力差异只能体现在 capability 和内部映射中。

### 14.2 OpenCode

- 使用 EasyWork 管理的 loopback service 与 HTTP/SSE；
- 原生 session 对应 AgentBinding；
- start 使用 `prompt_async`，事件通过 SSE 归一化；
- interrupt 使用原生 abort；
- context 使用原生 session/message/token 数据；
- service、PID、日志和端口状态位于 `~/.easywork/services` 与 runtime 目录。

### 14.3 Codex

- 使用 `codex app-server` stdio JSON-RPC；
- binding 对应 thread；首次 `thread/start`，复用时 `thread/resume`；
-任务使用 `turn/start`；
- 运行中追加使用 `turn/steer`；
- 中断使用 `turn/interrupt`；
- 事件按 JSON-RPC method 映射为 plan、message、tool_call、file_change、approval、artifact、error、usage。

### 14.4 Claude Code

- 使用 `stream-json` JSONL；
- 原生 sessionId 持久化，后续通过 `--resume` 复用同一会话；
- 运行时支持的 input stream/FIFO 用于追加；
- 中断停止当前原生进程但保留 sessionId；
- 若当前版本不能在同一 turn 消费追加，Adapter 必须在安全边界中断当前 turn，并立即以相同 sessionId 和追加内容恢复，不能创建新会话；
- 事件从 system/assistant/content block/result 映射为统一事件。

### 14.5 能力矩阵

必须按检测到的 Agent 版本生成真实能力矩阵，不得在前端臆造选项：

```ts
type AgentCapabilities = {
  appendWhileRunning: boolean;
  nativeInterrupt: boolean;
  resumableSession: boolean;
  contextReadable: boolean;
  contextLimitWritable: boolean;
  compact: boolean;
  planEvents: boolean;
  approvals: string[];
  permissionModes: Array<{ nativeValue: string; label: string }>;
  effortModes: Array<{ nativeValue: string; label: string }>;
};
```

权限、思考强度和模型配置只能显示该版本真实支持的原生值，提交时保留 nativeValue。

---

## 15. 中断、运行中追加与恢复

### 15.1 统一外部语义

- 中断必须作用于远端 Agent 当前原生 turn/process，不能只停止前端流；
- 运行中追加必须进入同一个网页任务、同一个 AgentBinding 和同一个原生 session；
- 中断后发送新内容必须在同一原生 session 上继续；
- 网络中断只影响事件传输，不改变任务状态；
- 不为“继续”设置关键词检测，任何后续用户消息都按状态和绑定判断是追加还是新任务。

### 15.2 命令收件箱

Task Orchestrator 必须为每个 active task 保存有序 Command Inbox：

```ts
type TaskCommand = {
  id: string;
  taskId: string;
  sequence: number;
  kind: 'append' | 'interrupt' | 'approval_response';
  payload: unknown;
  status: 'queued' | 'delivered' | 'acknowledged' | 'failed';
  idempotencyKey: string;
};
```

Adapter 确认原生接口接收后才标记 acknowledged。不能原生 steer 的 Agent 采用“同 session 安全中断并恢复”实现，不得把追加排成任务完成后的新对话。

### 15.3 重启恢复

网关启动时必须：

1. 读取未终态 TaskState；
2. 重建对应 UserSshWorker；
3. 读取 `~/.easywork/runs/<runId>/status.json`、PID、日志和 adapter session；
4. 判断远端进程存活、已结束或失联；
5. 从最后持久化 event sequence 继续收集；
6. 重放未确认 TaskCommand 和 ContextDelivery；
7. 向重新连接的浏览器发送 replay 后进入 live 流。

无法恢复时进入 `failed`，保留远端日志和明确原因，不得假装 cancelled 或 completed。

---

## 16. SSH Worker 与远端运行

每个登录用户拥有一个 UserSshWorker；主机 Worker Pool 管理所有用户。一个 Worker 可维护该用户的多个服务器 Session。登录凭据、主机指纹和连接状态只保存在该用户目录。

用户关闭网页后 SSH 不主动断开，Worker 以低频 keepalive 维护。连接自然失败时标记 disconnected，由用户下次任务重新认证。连续一个月无主动请求的服务器 Session 由 GC 断开并清理运行缓存映射，但不删除服务器配置。

`RemoteRuntimeRun` 必须包含 runId、taskId、serverIdentity、远端目录、PID、exitCode、日志游标和 adapter session。远端脚本按 release hash 部署到 `~/.easywork/runtime/releases/`；上传临时文件后校验 hash 并原子切换，不依赖远端联网。

Agent API 在远端不可达而主机可达时，必须支持通过现有 SSH 通道建立反向代理/relay；代理仅绑定远端 loopback，凭据只进入隔离 Agent runtime 环境。代理建立失败时返回准确网络阶段和错误原因。

---

## 17. 工作区、Binding 与动态写入

### 17.1 工作区定义

工作区是一个网页对话在某服务器上允许 Agent 作为默认当前目录使用的规范化文件夹。必须记录：

```ts
type WorkspaceBinding = {
  id: string;
  conversationId: string;
  serverIdentity: string;
  mode: 'virtual' | 'user';
  canonicalPath: string;
  workspaceId: string;
  versionDomainId: string;
};
```

新 Work 对话默认使用虚拟工作区，路径位于 `~/.easywork/virtual/<conversationId>/`。用户工作区由 SFTP 目录选择器确定。切换工作区时必须提示会切换 Agent 原生会话；网页记忆保留，目标 Agent/工作区 session 只补齐缺失 Delivery。

### 17.2 动态写入

虚拟工作区中的 Agent 可以按用户任务写入其他明确指定目录。每个目标目录形成 DynamicWorkspaceBinding；同一网页对话、Agent 和 canonical target path 再次写入时复用此前原生会话、watermark 和版本域。

首次写入前必须做路径和权限确认，显示目标目录、是否与其他工作区重叠、版本边界和可能影响。不得把一次口头路径自动扩大为父目录权限。

### 17.3 重叠工作区

若 A 是 C 的祖先目录，A/C 两个 VersionDomain 会观察到同一文件变更。系统必须在绑定时检测 canonical path overlap，并要求用户选择：

- 共享同一个 VersionDomain；或
- 取消绑定并选择不重叠目录。

不得同时建立互不知情的嵌套影子版本库。多个对话共享同一工作区时共享 VersionDomain 和全局有序 VersionEvent，但保持各自 Agent 原生会话。

---

## 18. 版本、分支与回溯

### 18.1 与用户 Git 隔离

EasyWork 必须使用 `~/.easywork/versioning/<versionDomainId>/repo.git` 作为 bare shadow repository，并为每次操作设置独立 `GIT_DIR`、`GIT_INDEX_FILE`、author 和 exclude。不得：

- 执行会修改用户 `.git` 的命令；
- 修改用户 local/global git config；
- 创建用户可见 commit、branch、tag、stash；
- 接管 Agent 自带的 Git/checkpoint。

若 Agent 自身会使用 Git，EasyWork 只观察工作树前后 diff，不依赖或改写 Agent 的 Git 历史。

### 18.2 VersionEvent

每个文件变更批次生成：

```ts
type VersionEvent = {
  id: string;
  versionDomainId: string;
  globalSequence: number;
  conversationId: string;
  branchId: string;
  taskId: string;
  parentCheckpointId: string;
  checkpointId: string;
  changedPaths: string[];
  patchArtifactId: string;
  status: 'active' | 'invalidated' | 'conflict';
};
```

### 18.3 选择性回溯

共享工作区不能用简单 `git reset --hard` 回溯单个对话。若时间顺序为 A1、B2、A3、B4、A5，A 回溯到 A3 时必须保留 A1、B2、A3、B4，只反向应用 A5 的 patch。

实现步骤：

1. 计算目标对话需要失效的 VersionEvent；
2. 从最新 checkpoint 建临时 worktree；
3. 按反序应用待失效事件的 inverse patch；
4. 验证其他 active 事件效果仍存在；
5. 无冲突时原子同步到真实工作区并创建新 checkpoint；
6. 有冲突时停止，生成冲突 Artifact 和用户确认，不得覆盖猜测。

在历史点创建分支只复制记忆、ResourceBinding、Agent Delivery watermark 和 checkpoint 引用，不撤销真实工作区之后的事件。新分支第一次修改时基于当前真实工作区生成新事件，并记录其逻辑起点。

---

## 19. Artifact Service

Artifact 不是普通消息事件，必须是可鉴权实体：

```ts
type Artifact = {
  id: string;
  actorId: string;
  taskId: string;
  serverIdentity: string | null;
  kind: 'file' | 'patch' | 'report' | 'image' | 'log' | 'archive';
  source: 'remote' | 'host';
  remotePath: string | null;
  blobId: string | null;
  size: number;
  sha256: string | null;
  mime: string;
  createdAt: string;
};
```

远端 Artifact 登记时必须解析真实路径、拒绝越界和危险 symlink，并验证属于任务允许的工作区或 `~/.easywork/artifacts/<taskId>`。下载通过鉴权后的 SFTP/主机 Blob 流式传输，支持 HTTP Range，不把大文件载入内存。

用户可以“保存到文件库”，该操作生成 ResourceBlob/ResourceVersion/Binding，再按严格 Embedding 流程索引；不得直接把 Artifact 事件冒充知识资源。

---

## 20. Scheduler Adapter

服务器首次连接后必须生成 ServerCapabilityProfile：

```ts
type ServerCapabilityProfile = {
  serverIdentity: string;
  scheduler: 'slurm' | 'pbs' | 'generic';
  commands: Record<string, boolean>;
  partitionsOrQueues: SchedulerQueue[];
  detectedAt: string;
  expiresAt: string;
};
```

SchedulerAdapter 提供统一接口：

```text
inspectCapabilities
listQueues
listJobs
submit
inspectJob
streamJobOutput
cancelJob
```

Slurm 使用 `sinfo/squeue/sbatch/scancel/sacct`，PBS 使用 `qstat/qsub/qdel`，generic 仅追踪普通远端进程。所有命令必须以当前 SSH 用户执行，只展示其可访问分区/队列和作业。EasyWork Task 与 SchedulerJob 是不同实体，通过 taskId 关联。

命令文本中出现 `srun` 或 `sbatch` 不能作为唯一的作业状态依据；必须解析原生命令返回的 job ID 并持续查询。

---

## 21. Agent 事件、报告与证据

### 21.1 统一事件类型

Adapter 必须按原始顺序逐条映射，不得把不相邻的命令、思考或文件编辑事后合并：

```text
message
reasoning
plan
tool_call
tool_result
approval_request
approval_response
file_change
job_status
artifact
usage
status
error
final
```

`reasoning` 仅显示 Agent 明确输出的中间文本。最终总结只能进入 `final`。Web Agent 的 reasoning 与 Remote Agent reasoning 必须使用不同 producer 标识。

文件编辑事件按连续编辑批次聚合；中间出现命令或消息即结束该批次。每个文件项包含名称、完整路径、diff Artifact 和可展开内容。

### 21.2 TaskReport

```ts
type TaskReport = {
  taskId: string;
  remoteFinal: string | null;
  outcome: 'succeeded' | 'failed' | 'partial' | 'cancelled';
  claims: ReportClaim[];
  evidence: EvidenceRef[];
  changedFiles: ArtifactRef[];
  schedulerJobs: string[];
  warnings: string[];
};
```

每个 claim 标记 `agent-reported`、`runtime-observed` 或 `verified`。退出码 0 只能证明进程正常退出，不能自动证明任务目标完成。`remoteFinal` 经过协议边界校验后直接成为 Work 对话的助手正文，不再运行 Web Agent 二次复核，也不保存 `webFinal`。

---

## 22. REST API

所有接口使用 ActorContext 鉴权、统一错误结构、idempotency key 和 requestId。目标接口：

```text
POST   /api/context/sessions
GET    /api/context/sessions/:id
POST   /api/context/sessions/:id/deliveries
GET    /api/context/sessions/:id/usage

GET    /api/memories
POST   /api/memories/search
POST   /api/memories/:id/invalidate

POST   /api/resources/uploads
PUT    /api/resources/uploads/:id/parts/:part
POST   /api/resources/uploads/:id/complete
GET    /api/resources/:id/versions
POST   /api/resource-bindings
DELETE /api/resource-bindings/:id
POST   /api/resources/search
POST   /api/resources/:versionId/reindex

GET    /api/skills
POST   /api/skills
POST   /api/skills/:skillId/:version/ensure

POST   /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/append
POST   /api/tasks/:id/interrupt
POST   /api/tasks/:id/resume
GET    /api/tasks/:id/report

GET    /api/artifacts/:id
GET    /api/artifacts/:id/download
POST   /api/artifacts/:id/save-as-resource

GET    /api/servers/:id/capabilities
GET    /api/servers/:id/scheduler/jobs
POST   /api/servers/:id/scheduler/jobs
POST   /api/servers/:id/scheduler/jobs/:jobId/cancel

POST   /api/conversations/:id/branch
POST   /api/conversations/:id/rewind
POST   /api/conversations/:id/messages/:messageId/retry
PUT    /api/conversations/:id/messages/:messageId
```

Agent Bridge 使用独立前缀 `/api/agent-bridge/v1/`，只接受 Task Token，不接受浏览器 Session Cookie。

---

## 23. WebSocket 协议

每个事件必须有可重放 envelope：

```ts
type WsEvent = {
  schemaVersion: 1;
  eventId: string;
  topic: string;
  sequence: number;
  occurredAt: string;
  actorType: 'user' | 'guest';
  actorId: string;
  producer: 'web-agent' | 'orchestrator' | 'remote-agent' | 'ssh' | 'scheduler';
  kind: string;
  status: string | null;
  ids: Record<`${string}Id`, string | null>;
  payload: unknown;
};
```

客户端连接时提交最后确认的 sequence；服务端先 replay 缺失事件，再切换 live。浏览器端不得以接收时间重新排序。大块终端输出、diff 和 Artifact 内容不直接塞入 WS，事件只携带可分页/下载引用。

必须支持：

- task 状态、Context Delivery、Agent 事件、追加/中断回执；
- SSH 状态、scheduler 状态、索引状态；
- reconnect/resume；
- heartbeat 和慢消费者断开；
- 每 Actor 的事件授权过滤。

---

## 24. 安全、审计与配额

### 24.1 Secret 与不可信内容

- API Key、SSH 密码、私钥、2FA 只进入专用凭据通道；
- prompt、ContextDelivery、TaskEvent 和日志不得包含 Secret；
- Resource、网页消息、Skill 文本和远端输出均标记为不可信数据，不能覆盖系统策略；
- Skill manifest 中的命令和权限必须展示并审计。

### 24.2 SSH 与路径

- `permittedSshTarget` 必须校验管理员允许的 CIDR、域名、端口、DNS 解析结果和重绑定；
- 首次主机指纹必须确认，后续变更阻断连接；
- SFTP、Artifact、工作区和动态写入统一使用 canonical realpath 校验；
- 路径验证后到使用前必须防 symlink 替换，关键写操作在远端再次校验；
- 端口转发只绑定 loopback，禁止开放到公网。

### 24.3 Token、权限和审计

Task Token 必须短期、单任务、单 binding、单 Scope、可撤销。所有跨模块读取都验证 Actor 和 Scope；不得允许模型传任意 ownerId。

以下操作必须写 AuditEvent：登录、凭据更新、SSH 连接、Agent 安装/更新/卸载、权限配置、上下文投递、资源读取、Skill ensure、任务命令、文件变更、Artifact 下载、版本回溯和管理员配置变更。

### 24.4 配额

必须按用户设置并统计：

- Web Agent token/请求；
- Embedding token、文件数、Blob 总量、向量总量；
- 并发 SSH Session、并发任务、任务时长；
- Artifact 和日志容量；
- 上传大小、文件夹文件数、压缩包展开比；
- WebSocket 事件速率和回放窗口。

超限必须返回明确、稳定的错误码，不得部分写入后静默失败。

---

## 25. 持久化示例

### 25.1 ConversationRoute

```json
{
  "schemaVersion": 1,
  "conversationId": "conv_01",
  "serverId": "srv_01",
  "serverIdentity": "ssh-sha256:...",
  "workspaceId": "ws_01",
  "workspaceBindingId": "wsb_01",
  "agentId": "codex",
  "agentBindingId": "ab_01",
  "branchId": "main",
  "contextEpoch": 3,
  "updatedAt": "2026-08-10T00:00:00.000Z"
}
```

### 25.2 AgentBinding

```json
{
  "schemaVersion": 1,
  "id": "ab_01",
  "actorType": "user",
  "actorId": "user_01",
  "serverIdentity": "ssh-sha256:...",
  "conversationId": "conv_01",
  "branchId": "main",
  "workspaceId": "ws_01",
  "agentId": "codex",
  "contextEpoch": 3,
  "nativeSessionId": "thread_...",
  "lastDeliverySequence": 17,
  "status": "active"
}
```

### 25.3 TaskState

```json
{
  "schemaVersion": 1,
  "taskId": "task_01",
  "state": "running",
  "taskEventSequence": 42,
  "contextSessionId": "ctx_01",
  "agentBindingId": "ab_01",
  "remoteRunId": "run_01",
  "activeCommandId": null,
  "plan": [],
  "artifactIds": [],
  "startedAt": "2026-08-10T00:00:00.000Z",
  "completedAt": null
}
```

所有物化 JSON 必须通过 schema 校验；未知字段在迁移后不得继续作为运行时兼容入口。

---

## 26. 关键业务流程

### 26.1 Chat

1. 服务端解析 Actor、Conversation 与模型；
2. 计算 EffectiveContextScope；
3. 创建 Web Agent ContextSession；
4. Context Hub 读取 ConversationState、记忆、ResourceBinding 和 Skill；
5. Web Agent 在只读工具预算内运行；
6. 流式正文写入消息事件；
7. 完成后更新 ConversationState，提取带 provenance 的记忆候选。

### 26.2 Work

1. 从 ConversationRoute 解析服务器、工作区和 Agent；
2. Web Agent 使用只读工具查询最小必要上下文，运行时确定性整理查询证据，不生成远端计划；
3. 主机按当前绑定的持久状态确定 create、append 或 resume；
4. 验证 SSH、Agent 能力、工作区和版本域；
5. 新 Task 创建版本 checkpoint、ContextSession、Skill pins、Resource snapshot 和 TaskEnvelope；
6. ensure 远端 Agent/Skill/runtime；
7. 打开或复用完整 BindingKey 对应的 Agent 原生会话；
8. 投递用户原始问题、简报与 bootstrap/delta 并取得回执；
9. 远端 Agent 自主规划和执行，适配器按原始顺序保存事件；
10. 运行中接受 append、interrupt、approval；
11. 记录文件 diff、SchedulerJob、Artifact 和证据；
12. 生成 TaskReport、ConversationState 和记忆候选，并把 remoteFinal 直接写入对话；
13. 释放 Task Token，关闭 ContextSession，保留可恢复日志。

### 26.3 切换 Agent 或工作区

1. 用户确认切换；
2. 保存当前 Binding watermark；
3. 解析目标 Agent + 工作区 Binding；
4. 已存在则复用其 nativeSessionId，缺失则创建；
5. Context Hub 计算自其 watermark 以来的新消息、记忆、资源和 Skill；
6. 投递 delta，避免重复发送目标 Agent 已知内容；
7. 页面保持同一网页对话和整体记忆。

---

## 27. 一次性迁移与旧机制删除

EasyWork 发布采用停写窗口内的一次性迁移，不保留运行时双格式。

### 27.1 迁移前置

1. 阻止新任务和写请求；
2. 等待或安全中断 active task；
3. 为每个 Actor 获取 mutation lock；
4. 生成旧数据文件、大小、hash、记录数和 schema 的 backup manifest；
5. 备份主机用户数据；远端只读取 EasyWork 目录，不修改用户原生 Agent 配置。

### 27.2 转换

必须转换：

- 旧 `state`、用户配置、服务器配置和设备登录状态；
- memory 记录、版本链、失效和 scope；
- conversations、messages、summary/checkpoint；
- 文件、文件集、项目/对话附件、vector JSON；
- 旧 WorkerTask、远端 run、事件和报告；
- Agent 安装、binding、native session 与 sync cursor；
- 工作区、动态目标目录、checkpoint 和影子版本；
- Skill 元数据和对话选择。

转换规则：

- 旧文件按 hash 生成 ResourceBlob/Version，再建立 ResourceBinding；
- 旧 summary 映射为带来源范围的 ConversationState；
- WorkerTask 映射为 TaskState/TaskEvent；
- Agent binding 补入 `serverIdentity`、branch 和 epoch；无法确定身份的 binding 标为 stale，不得错误复用；
- 旧 cursor 只用于计算初始 Delivery watermark，迁移后删除；
- 选中的 Skill 解析成确切 SkillVersion；无法解析的任务 pin 标为 invalid，并提示重新选择；
- conversation attachment 在分支中的可见性转换成 BindingSnapshot；
- 已索引资源必须核验 embedding profile、维度和 chunk hash；不匹配则进入 `embeddingStatus=failed` 并要求重建，不能宣称 ready。

### 27.3 验证与切换

迁移器必须验证：

- 用户、对话、消息、记忆、文件、绑定、任务、Skill 和工作区数量；
- Blob/Skill/Artifact hash；
- 外键与 Actor 归属；
- 每个 active/stale Binding 的服务器身份；
- 每个 ResourceBinding 的 ResourceVersion；
- 每个任务的事件 sequence 连续性；
- 凭据文件未进入日志和 manifest 明文。

全部通过后写 `data/schema.json` 的 EasyWork schema marker，再开放写入。

### 27.4 必须删除的旧机制

切换前必须从源码和数据中删除：

- `agentMemoryDelta`、旧 sync cursor 字段和对应 prompt；
- 未包含 `serverIdentity` 的 binding key；
- WorkerTask 混入对话消息的持久化路径；
- 旧文件所属单一 owner 的兼容分支；
- 关键词检索作为 Embedding 失败回退；
- 旧 Context 拼接接口和重复 summary 字段；
- 旧 REST/WS 事件名、旧 schema fallback 和双写代码；
- 已迁移且验证成功的旧数据文件。

删除前保留离线备份；运行时不得再读取该备份。

---

## 28. 施工顺序

以下顺序是依赖约束，不是功能取舍；最终发布必须全部完成。

1. **Schema 与 Persistence**：Actor 目录、原子写、mutation queue、实体 schema、迁移框架；
2. **Scope 与 Context Hub**：EffectiveContextScope、ContextSession、Delivery、Usage、epoch；
3. **Resource 与 Skill**：Blob/Version/Binding、严格 Embedding、Registry、远端 ensure；
4. **Task Orchestrator**：TaskState、EventLog、命令收件箱、恢复；
5. **Agent Adapter**：三 Agent 统一接口、能力矩阵、事件归一化；
6. **Context Bridge**：Task Token、SSH reverse forwarding、staged fallback、回执；
7. **Workspace 与 Version**：Binding、动态写入、共享域、选择性回溯；
8. **Artifact 与 Scheduler**：实体、下载、Resource 转换、Slurm/PBS；
9. **Web Agent**：只读工具循环、预算、Chat 回答与 Work 确定性交接证据；
10. **API/WS 与前端接线**：replay、事件、错误码、能力显示；
11. **一次性迁移**：转换、校验、删除旧机制；
12. **全量验收**：故障注入、安全、真实 Agent 和真实服务器测试。

每阶段必须先建立契约测试，再替换调用方。迁移前允许测试环境中的 adapter 层对照验证，生产切换后不得保留旧路径。

---

## 29. 验收测试

### 29.1 单元测试

- Scope：项目内/全局、五级记忆、branch snapshot、epoch、跨用户拒绝；
- Memory：版本、supersede、invalidate、authority、sensitivity、压缩来源；
- Resource：hash 去重、Binding 可见性、文件夹路径、严格 Embedding、维度变化；
- Skill：manifest、hash、版本固定、越权 ensure；
- Task：所有状态迁移、幂等命令、sequence、重启物化；
- Version：共享工作区选择性回溯、嵌套路径检测、用户 Git 隔离；
- Security：CIDR、DNS 重绑定、realpath、symlink、Task Token、Secret 脱敏。

### 29.2 迁移测试

使用包含多用户、多项目、分支、旧 memory、旧 WorkerTask、文件集、附件、Skill、三个 Agent binding 和共享工作区的固定 fixture：

- 迁移前后记录数和 hash 对账；
- unresolved server identity 正确 stale；
- attachment 变为 BindingSnapshot；
- 不兼容向量正确进入待重建而非 ready；
- 二次运行迁移器不得重复生成实体；
- EasyWork 启动后证明不读取旧文件。

### 29.3 API 与 WebSocket 集成测试

- REST 鉴权、idempotency、分页、Range、稳定错误码；
- WS replay -> live 无缺失、无重复、顺序稳定；
- 慢消费者、断网、重连和跨设备；
- 浏览器关闭后任务继续，重新登录后恢复事件和报告。

### 29.4 三 Agent 真实测试

OpenCode、Codex、Claude Code 分别验证：

- 安装/扫描/版本检测、managed 与 user-deployed 配置隔离；
- 新建/复用 session、模型、权限和 effort 能力；
- reasoning、plan、message、tool、file、approval、artifact、error、usage、final；
- 运行中追加、中断、同 session 恢复；
- Agent 切换后只补发缺失 Delivery；
- context 可读/不可读、原生 compact；
- 网关重启和 SSH 断开恢复。

### 29.5 多维冲突场景

至少覆盖：

1. 同一用户、多设备、同一 active task；
2. 同一用户连接多个服务器；
3. 同一网页对话在三个 Agent 间切换；
4. 同一 Agent 在多个工作区拥有独立 session；
5. 多对话、不同 Agent 共用同一工作区；
6. 父子目录工作区重叠并被阻止或合并；
7. A1、B2、A3、B4、A5 后 A 回溯到 A3，仅撤销 A5；
8. 历史点分支不撤销真实工作区后续修改；
9. 虚拟工作区重复动态写同一目标并复用 session；
10. 编辑用户提问后旧任务、记忆、资源派生关系失效；
11. 文件索引中断、Embedding 配置变更和重试；
12. Skill 版本更新时 active task 仍使用 pinned version；
13. user-deployed Agent 原生配置和用户 Git 前后 hash 不变；
14. Artifact 大文件 Range 下载和保存到文件库；
15. Slurm/PBS 假服务器和至少一个真实 Slurm 链路。

### 29.6 故障注入

- SSH 在上传、Agent 启动、命令运行、文件写入和最终报告阶段断开；
- 网关在 TaskEvent 落盘前后崩溃；
- Agent 进程崩溃、服务端口被占用、原生 session 丢失；
- Context Delivery 已发送但回执丢失；
- Embedding API 超时、限流、返回维度错误；
- SFTP 中断、磁盘满、Artifact hash 不一致；
- Scheduler 提交成功但响应丢失。

每个故障必须得到唯一终态或可恢复状态，不允许任务永久卡在“运行中”。

---

## 30. 发布完成定义

只有同时满足以下条件，EasyWork 才可发布：

- 所有用户数据符合每 Actor 目录和 schema；
- 所有 EasyWork 远端数据均位于 `~/.easywork`；
- 三种 Agent 通过统一 adapter 的真实中断、追加、恢复和事件验收；
- Web Agent、Context Hub、Task Orchestrator、Remote Agent 权限边界可测试；
- ContextSession/Delivery/epoch 在切换、分支、编辑、回溯中一致；
- 严格 Embedding、ResourceBinding、Skill pin 和远端 ensure 无兼容回退；
- 共享工作区选择性回溯不影响用户 Git；
- Artifact、Scheduler、REST、WebSocket、审计和配额均可用；
- 一次性迁移完成并通过数据对账；
- 旧字段、旧 prompt、旧接口、旧数据读取和兼容代码已删除；
- 全量测试、故障注入和跨用户安全测试通过。

该完成定义是单一目标状态，不保留“旧版模式”开关。
