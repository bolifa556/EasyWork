# EasyWork 远端文件版本与 Agent 机制

本文定义 EasyWork 如何绑定 Codex、Claude Code 和 OpenCode 的原生会话，隔离运行数据，安装 Skill，投递用户文件，并维护工作区版本边界。网页 Agent 的上下文与检索原则见《网页Agent机制》。

## 1. 三类独立版本

EasyWork 同时管理三类不能互相替代的版本：

1. 原生 Agent 版本：可执行程序、协议和配置能力；
2. 远端会话版本：原生 session、turn、压缩状态以及 EasyWork Binding；
3. 工作区文件版本：远端 Agent 写入前后的可恢复内容。

升级 Agent 不会自动改写既有会话；恢复文件也不会自动回退原生对话。网页分支、回溯和重新生成必须明确协调三类状态。

## 2. Route、Binding 与原生会话

一次 Work 运行由服务器、绝对工作区、Agent 类型和网页对话分支确定路由。Binding 是该路由的持久身份，拥有自己的原生会话、运行目录、配置视图、Skill 视图、用户文件视图和知识收据。

同一网页对话连续使用同一 Binding 时复用原生会话。切换 Agent、服务器、工作区或网页分支会选择另一个 Binding；切回时优先恢复原 Binding，而不是复制其他 Agent 的原生历史。

Binding 隔离 Agent 上下文和 EasyWork 管理数据。若多个 Binding 指向同一用户工作区，它们仍通过真实文件系统看到相同工作区文件。

## 3. 原生上下文边界

远端 Agent 自己维护本地会话历史、工具结果、推理状态和压缩。EasyWork 不把这些内容重新拼成第二份模型历史，也不在同一原生会话每轮补发网页对话。

Codex 的原生 thread/turn、Claude Code 的 session 与 stream-json 回合、OpenCode 的 session/message 是各自协议的权威边界。EasyWork 保存可验证的 session、turn、协议和运行身份，并通过原生接口继续、终止、分支或回退，不能只凭回答文本猜测会话状态。

网页对话切换到不同原生会话时，EasyWork 只补发目标尚未收到的网页正文增量。增量只含用户提问和正式助手回答，并标为历史记录；思考、工具调用、日志、Todo、作业过程和前端状态不进入。切回旧会话时只补发离开期间新增部分。

远端模型的原生压缩仍由原生协议维护。EasyWork 记录原生用量和压缩事件，但不以网页摘要覆盖原生会话。只有原生会话被协议证明不存在，或用户进行分支、回溯等显式操作时，才建立新上下文代次并重建允许交付的语义资料。

## 4. Binding 私有运行目录

每个 Binding 使用独立的 EasyWork 运行根：

~~~text
~/.easywork/runtime/agents/<agent>/<binding>/
  home/
  config/
  data/
  cache/
  state/
  logs/
  skills/
  skill-generations/
  files/
~~~

`skills/` 与 `files/` 处于同一级。目录权限属于当前远端账号，其他网页对话不能通过 EasyWork 路由取得该 Binding 的内容。

用户真实工作区不位于这棵私有目录中。删除 Binding 可以回收运行数据、Skill 和投递文件，但不会删除工作区中的用户文件。

## 5. 统一 Agent 能力

三种 Agent 通过统一合同向上层暴露：创建或恢复原生会话；开始一轮、追加输入和终止；流式文本、思考、工具活动、Todo、文件变化、审批、错误与终态；原生分支、回退或新上下文代次；Skill 发现与本轮调用；文件写前边界。

适配器必须把协议确认的终态映射为完成、失败或取消。流已经结束但状态仍为运行，或者任务实际不存在却无法终止，属于状态收敛错误，不能长期保留“进行中”。

运行中追问只在原生协议支持且当前回合可接收输入时追加，否则排队到下一轮。终止先调用原生取消，再核对进程和会话状态；即使原生返回“没有正在运行的任务”，EasyWork 也要依据已知终态收敛本地 Task。

### 5.1 控制链路的实现边界

网页请求不会直接启动 CLI。后端先把网页对话分支解析为确定的 Route 和 Binding，固定本轮文件、Skill、模型配置与上下文代次，再创建持久 Task。`TaskOrchestrator` 负责 Task 生命周期，`AgentRuntimeTransport` 负责准备隔离目录、解析托管或用户二进制、写入进程级配置、恢复原生会话并执行适配器操作；`SshAgentExecutor` 只提供受该服务器连接约束的进程、HTTP/SSE、JSON-RPC、SFTP 和信号通道。三者的状态都写入 Task、Binding 和事件日志，因此浏览器断开后不需要靠页面内存判断远端是否仍在运行。

一次新回合按以下顺序进入远端：

1. 校验服务器身份、工作区绝对路径、Agent 类型、Binding 和上下文代次；
2. 准备 Binding 私有 HOME、配置、data、state、logs、skills 和 files，并校验目录没有越出受管根；
3. 固定并部署本轮 Skill，把手动文件物化到当前 Binding，再生成只含必要资料与原始用户请求的交接输入；
4. 根据 Binding 中已验证的原生 session 身份选择新建或恢复，不从回答文本推测 session；
5. 启动或复用原生控制通道，把原生事件连续归一化写入 Task journal；
6. 只有协议终态、受管进程状态和文件版本收尾一致时，才把 Task 收敛为完成、失败或取消。

运行中追加、审批、用户输入和终止必须命中当前 Task 保存的原生 session、turn/run 和进程身份。若身份已经变化，控制请求明确失败，不能新启一个进程后把请求发到不确定的会话。事件流意外断开时，恢复逻辑先读取 Binding 的原生身份和可验证状态，再决定重连、收敛或报错；它不会重复提交可能已经产生副作用的用户请求。

### 5.2 Codex 控制

Codex 由每个 Binding 独立的 `codex app-server` 进程控制。后端建立 JSON-RPC 通道后执行 `initialize` 与 `initialized`，新会话调用 `thread/start`，已有会话在进程重建后先调用 `thread/resume`；每一轮使用 `turn/start`，运行中追加使用携带 `expectedTurnId` 的 `turn/steer`，终止使用 `turn/interrupt {threadId, turnId}`。当前进程维护已装载 thread 集合，磁盘中存在 rollout 不等于该进程已经装载 thread。正文、思考、工具、计划、交互请求、用量和 `turn/completed` 都从 app-server 通知归一化，只有原生 final 阶段成为正式回答。

### 5.3 Claude Code 控制

Claude Code 以 `--input-format stream-json --output-format stream-json` 的长 stdin/stdout 进程运行，工作区作为 cwd，HOME、settings 和环境来自当前 Binding。新 session 写入第一条 user frame；继续会话以 `--resume <session-id>` 启动进程后写入新 frame。运行中追加先向同一进程写原生 control interrupt，再写下一条 user frame，并用排队回合计数确保中间 `result` 不会提前结束整个 Task。终止先发送 control interrupt，失败时只对保存的受管 PID 依次使用有界的 `SIGINT`、`SIGTERM` 和 `SIGKILL`，每一步都确认进程是否退出。stream event、assistant 快照、tool result、control request 和 terminal result 共同决定事件及终态。

### 5.4 OpenCode 控制

OpenCode 为每个 Binding 启动只监听远端 loopback 的 detached `opencode serve`，并把 PID、确定端口、协议版本、运行指纹和 session ID 写入 `state/active.json`。SSH exec 通道释放后，后端通过 HTTP 提交 session 操作，通过 SSE 接收事件；复用服务前同时检查进程、health、模型目录和运行指纹。当前新 Binding 使用 V1：新建为 `POST /session`，普通输入为 `prompt_async`，Skill 调用走 session command，终止为 `abort`，完成以目标 session 的 idle 及消息终态共同确认。已有 V2 Binding 固定使用自己的 `/api/session` 协议，不在运行中跨协议解释 session。V1 活动 run 不支持真正 steer，因此追加时先 abort 并确认 idle，再在同一 session 提交下一轮；新的 EasyWork run ID 隔离旧事件的迟到终态。

## 6. Context、收据与增量交付

Context Hub 保存准备交给某个精确原生会话的语义资料和交付收据。语义键与内容版本共同判断“该会话是否已经知道”；session 缺失、换绑或新上下文代次不能沿用旧收据。

交付内容包括网页 Agent 选择的记忆、文件正文和对话引用资料，用户显式选择的 Skill 和文件，后端强制启用且当前 Binding 缺少的 Skill，切换原生会话时缺少的网页正文历史，以及当前用户原始请求。对话引用资料由冻结来源中的相关记忆、最近完整回合或语义命中的较早完整回合组成；它们以历史资料交付，不能改变当前请求和远端执行边界。

收据只避免重复交付同一版本，不表示内容永远正确。资料版本变化、用户明确要求重新读取或原生会话改变时应重新交付。推理和工具日志不进入收据。

## 7. Skill 安装与原生使用

用户技能库保存用户安装时取得的独立副本。市场条目后续编辑、更新或删除不会改变已安装的正文、附件、发现简介和个人适用范围；只有用户明确更新或卸载后重新安装才取得新版本。

远端服务器级包缓存按账号和内容摘要保存不可变包。每个 Binding 从固定包建立自己的可写文件代次，`skills/` 只指向该 Binding 的副本。分支在明确边界继承自己的 Skill 快照，分支之后的修改互不影响。

“用户库已安装”“远端包已部署”和“本轮已经调用”是三个不同事实。把文件放入 `skills/` 只完成发现准备，不能替代原生调用。

| Agent | 发现方式 | 本轮使用方式 |
| --- | --- | --- |
| Codex | 将当前 Binding 的 `skills/` 注册为额外技能根，并刷新原生技能目录 | 在原生 turn input 中加入选中 Skill 的 skill input |
| Claude Code | 将当前 Binding 的技能视图接入隔离配置，并生成只包含本轮选中项的原生命令入口 | 在本轮 stream-json 用户输入中调用该命令，展开真实 Skill 内容 |
| OpenCode | 将当前 Binding 的技能视图接入隔离配置，并由当前版本的命令目录确认可发现 | 通过原生 session command 调用本轮选中命令和参数 |

用户手动选择的 Skill 每轮执行原生调用。强制 Skill 只在切换到某个 Binding 后的下一次提问检查一次；已有相同内容版本时不重复安装，缺少时补齐并调用。网页 Agent 按需选择的 Skill 在读取并提交后进入相同的固定版本与原生调用链路。

## 8. 用户文件投递

Work 中用户手动添加的文件以真实文件交给远端 Agent，不先由网页 Agent 总结，也不把解析文本伪装成文件。

后端先固定当前消息所选择的文件版本并重新校验权限，再把内容写入当前 Binding 的 `files/`：

~~~text
~/.easywork/runtime/agents/<agent>/<binding>/files/
  objects/<sha256>/<filename>
  turns/<message-id>/<filename>
~~~

相同内容复用 `objects/` 中的只读对象；`turns/` 保留本轮消息和文件名边界，避免同名文件互相覆盖。远端交接向 Agent 给出本轮稳定路径和原始文件名。Agent 通过普通文件系统读取，因此三种 Agent 使用同一机制，不依赖互不一致的附件 API。

文件写入、内容校验或权限校验失败时，本轮 Task 在启动前明确失败，不能只发送简介继续执行。文件不复制到用户工作区；Agent 如需修改，应按任务目标写入工作区中的目标路径。

Binding 删除时一并回收 `files/`。网页分支或切换 Binding 后，不能假定旧提示词中的路径仍可用；本轮需要的显式文件必须在目标 Binding 中拥有自己的可读视图。

## 9. 工作区文件版本账本

EasyWork 的工作区版本账本保存远端 Agent 写入前后的路径状态，并使用内容寻址对象保存可恢复内容。它只覆盖实际命中的受管写操作，不在普通 Task 开始时扫描或复制整个工作区。

文件写前 Hook 根据原生工具的结构化输入、真实工作目录和可证明的路径捕获 before 状态。同一路径一轮采用最早的 before；Task 结束后捕获 after 并提交版本边界。无法证明目标路径时不猜测，运行事件也不能替代已经缺失的 before 内容。

多个网页对话可以指向同一真实工作区，因此会看到彼此已经落盘的文件。普通运行读取当前现场；只有用户显式执行分支、回溯、重新生成或版本恢复时才物化历史 checkpoint。

显式恢复先比较现场指纹。现场被用户或其他程序改动且无法证明等于已知边界时停止并报告冲突；多路径恢复先全量预检，再原子应用或补偿。

## 10. 分支、回溯与重新生成

网页分支同时建立新的网页消息分支、独立 Binding、Context 收据和文件版本域。分叉点以前的不可变对象可以共享，分叉后的原生会话、Skill 副本、用户文件视图和收据彼此独立。

若原生 Agent 提供可验证的 fork，EasyWork 在精确 turn 边界调用它；已由原生 fork 继承的消息不重复发送。缺少可靠边界时建立新上下文代次，并按允许范围重新交付网页正文和语义资料。

回溯和重新生成同时协调网页消息、原生会话、Context 收据与工作区版本。原生回退不可用或失败时不伪造旧会话，而是建立新代次。工作区只恢复账本记录且通过冲突检查的路径。

Skill 快照以实际 Binding 副本为准。分支继承分叉边界已有技能，之后双方修改互不影响。用户投递文件属于 Binding 私有数据；需要在新分支继续使用时，依据冻结文件版本在新 Binding 重建视图。

## 11. 删除、恢复与故障收敛

删除网页对话先解除所有服务器 Binding，再通过可恢复队列清理原生会话、运行目录、Skill、用户投递文件、Context 收据和版本引用。其他分支仍引用的不可变对象保留；用户真实工作区不属于删除目标。

Task、原生运行身份、事件、收据、写前 manifest 和删除计划必须持久化。浏览器刷新、关闭、换设备或网关重启只影响订阅，不应取消仍在运行的远端进程。

原生协议明确完成后立即收敛 Task；事件中断时依据可验证的进程和会话状态恢复。网络故障不能静默新建会话并重跑可能有副作用的请求。无法证明可安全继续时，保留现场并返回明确错误。
