# EasyWork 远端文件版本与 Agent 机制

本文描述当前代码中 EasyWork 与远端 Agent、原生会话、网页对话上下文及远端文件版本账本之间的协作方式。它只说明 EasyWork 提供和依赖的能力、状态边界与故障原则；三种 Agent 的具体命令、接口和事件映射分别见 [OpenCode](agent/OpenCode.md)、[Codex](agent/Codex.md) 与 [Claude Code](agent/Claude-Code.md)。网页 Agent 如何选择文件、记忆和 Skill，见 [网页 Agent 机制](网页Agent机制.md)。

文档以当前工作树源码为准。托管安装基线由 `agent-app/manifest.json` 唯一确定：OpenCode `1.18.23`、Codex `0.149.1`、Claude Code `2.1.245`。Manifest 同时记录平台制品、大小和 SHA-256；文档中的版本号不是另一份部署配置。

## 1. 三层相互独立的“版本”

EasyWork 同时面对三类历史，不能混为一谈：

| 层次 | 保存什么 | 由谁维护 | 主要用途 |
| --- | --- | --- | --- |
| Agent 原生会话历史 | 原生用户消息、助手消息、工具与回合边界 | 远端 Agent | 连续对话、原生压缩、分支、回退与运行中修正 |
| EasyWork 文件版本账本 | Agent 写文件前后的受影响路径快照与 checkpoint DAG | EasyWork | 网页分支、回溯、重新生成时恢复远端文件 |
| 工作区 Git 仓库 | 用户自行建立的 Git refs、index 和 work tree 状态 | 用户与 Git | 文件栏中的 Git 版本查看及用户自己的版本工作流 |

EasyWork 文件账本不是 Git，不会自动执行 `git init`、提交或切换分支；Git 仓库也不替代 EasyWork 的写前快照。工作区没有 Git 仓库时，界面只表达“尚未建立 Git 仓库”。Agent 原生会话回退同样不等于文件已经恢复，因此显式回溯需要同时协调原生历史与 EasyWork 文件账本。

## 2. 核心对象与身份

| 对象 | 身份和职责 |
| --- | --- |
| 网页对话 | 用户可见的消息历史、当前服务器路由和对话级状态。分支会创建新的网页对话。 |
| 工作区 | 远端真实目录或 EasyWork 虚拟目录。指向同一真实目录的 Agent 能看到同一批文件。 |
| Route | 网页对话当前选择的服务器、工作区、Agent 与上下文代次。 |
| Binding | 一条网页对话在特定 route 上与某个原生 Agent 会话的绑定，也是配置、Skill 视图、上下文回执和运行时隔离的边界。 |
| Native session | Agent 自己持久化的 thread/session；其 ID、回合边界和存储位置只由对应适配器解释。 |
| Task | 一次远端 Agent 执行。一个 Task 可以因运行中追问包含多个前端 Agent 调用分段，但只有一个权威终态。 |
| Context receipt | 记录某个 binding 的同一原生会话已收到哪些消息、记忆、文件片段与 Skill 版本。 |
| Version domain | 一台服务器上某个网页对话的 EasyWork 文件账本；工作区和 Agent 不是其身份组成。 |

Binding 身份包含 Actor、服务器、网页对话、网页分支、工作区、Agent 与 `contextEpoch`。版本域身份则是：

```text
Actor + 服务器指纹 + 网页对话
```

因此，同一网页对话切换 Agent 或工作区后仍属于同一本 EasyWork 文件账本；网页分支拥有自己的账本，但可以导入分叉点之前的祖先 checkpoint。不同 binding 的原生配置、Skill 可见集合和会话回执彼此隔离。

## 3. 工作区与绑定切换

用户工作区是服务器上的真实目录，EasyWork 不为每个 Agent 创建文件副本。两个 Agent 只要运行在同一路径，就能看到该路径的全部当前文件；所谓“对话版本”只是回溯账本的归属，不是文件可见性隔离。

虚拟工作区位于 EasyWork 控制目录中，身份还包含网页对话和分支。删除对话时，只有不再被任何存活对话引用的虚拟工作区才会被删除；用户工作区永远不会随对话删除。

切换工作区或 Agent 时，工作区服务先生成带 revision 的切换描述，说明是否需要用户确认、是否会更换原生会话、是否可以复用旧会话，以及下一次上下文交付是初始化还是增量。提交切换时再次核对 revision，避免用过期对话框覆盖更晚的选择。

切回曾用过的 Agent binding 时，若其原生 session 仍存在，就继续该 session，只补交离开期间新增的网页对话正文。切到从未使用或原生 session 已被确认删除的 binding 时，重新评估当前网页历史和知识来源并做完整交付。网页历史的交付只包含用户提问和面向用户的正文回复，不把网页 Agent 思考、背景查阅活动或远端 Agent 调用活动伪装成对话消息。

## 4. 远端运行时与部署

### 4.1 托管安装和用户安装

托管 Agent 仅支持 Linux `x64`、`arm64` 及对应 musl 变体。部署服务读取 Manifest，校验制品路径、大小和 SHA-256，在远端 staging 目录完成校验和解包，然后原子替换：

```text
~/.easywork/agents/<package>/current
```

旧 release 在新 `current` 生效后清理。托管运行始终对齐 Manifest 指定的版本和制品哈希。用户安装则由用户显式登记根目录或二进制，EasyWork 读取真实 `--version`；不会在每条消息前扫描服务器文件系统。

### 4.2 Binding 级隔离

每个精确 binding 使用独立运行目录：

```text
~/.easywork/runtime/agents/<agent>/<binding>/
  home/
  config/
  data/
  cache/
  state/
  logs/
  skills/
```

启动环境把 `HOME`、XDG 目录以及 Agent 自己的配置根定向到该隔离目录。运行状态写入 `state/active.json`，包含当前二进制、配置指纹、进程、协议、session、turn 和 run 等恢复所需身份。路径和标识符在本地与远端都重新验证，禁止把根目录、`.git` 或 EasyWork 控制目录当作任意文件目标。

网页对话的 Agent 配置另存于：

```text
~/.easywork/runtime/conversations/<scope>/agents/<package>/config.json
```

配置文件使用 revision、原子替换和 `0600` 权限。用户更改模型、思考强度或权限后才更新配置；普通消息只复用当前配置和指纹。分支可在目标 scope 尚无配置时物化来源值，不会覆盖用户已经配置的目标 scope。

### 4.3 模型代理与凭据

模型 API 默认通过 SSH 上的回环或反向代理提供给远端 Agent。真实凭据保留在 EasyWork 主机侧；远端 binding 只收到受限的 provider 路由和环境文件。只有服务器路由明确标记为可直接访问时才使用远端直连。

准备阶段按 binding 单飞并缓存：创建隔离目录、写入必要配置、部署 Skill 视图、解析模型路由和启动可预热的服务可以并行，但不会创建占位 session、占位用户消息或占位回合。正式执行仍比较完整运行指纹；配置、原生 store 或模型路由改变时，下一次可安全启动的回合才替换旧进程。运行中的 append 与 interrupt 始终命中原进程，不会因配置刷新误投到新实例。

## 5. 统一 Agent 能力合同

适配器把不同原生协议统一为十项操作：

```text
start, append, interrupt, resume,
respondApproval, respondInput,
compact, contextUsage, fork, revert
```

代码中的适配边界自然分为三层：`gateway/core/agents/<agent>.mjs` 声明 capability、把统一操作构造成无凭据的 transport descriptor，并用 reducer 将原生 frame 归一化；`gateway/core/agent-runtime/transport.mjs` 负责实际进程、HTTP/JSON-RPC/JSONL、隔离配置与原生 store；orchestrator 只依赖统一操作和事件，不认识某个 Agent 的私有消息格式。`defineAgentAdapter` 会校验 capability、descriptor、reducer 返回值及敏感字段。新增或升级适配只要保持这一分层，现有 Task、前端、Context Hub 和版本账本就继续使用同一合同。

当前适配状态如下。`native-deferred` 表示 EasyWork 已保存原生边界和参数，但 Agent 要到下一条真实用户消息启动时才完成原生会话分叉；`derived` 表示结果从原生事件缓存推导，而不是单独调用接口。

| 能力 | OpenCode | Codex | Claude Code |
| --- | --- | --- | --- |
| 启动/继续 | native | native | native |
| 运行中追加 | native | native | native |
| 终止 | native | native | native |
| 审批/用户输入 | native | native | native |
| 上下文压缩 | native | native | native |
| 上下文用量 | derived | native | native |
| 原生分支 | native；既有 V2 session 无 fork 时回退换绑 | native | native-deferred |
| 原生回退 | native | native | native-deferred |

具体接口不进入本总览，以免 EasyWork 的能力边界与某个版本的协议细节耦合；对应关系由三份 Agent 文档记录。

### 5.1 统一事件

所有原生流被归一为以下事件种类：

```text
message, reasoning, plan, tool_call, tool_result,
approval_request, approval_response,
input_request, input_response,
file_change, job_status, artifact, usage,
status, error, final
```

事件阶段为 `started`、`updated`、`completed`、`failed`、`cancelled` 或 `waiting`。每条事件带单调序号以及原生 session、turn、item 或 request 身份；适配器 reducer 将增量合并为稳定 item，同时保留向前端重放所需的规范事件。

只有原生 `plan`/Todo 事件更新 Task 计划和右侧进度。EasyWork 不根据提示词自行生成 Todo，也不替 Agent 推进状态。原生计划工具若已经投影为计划，不再重复显示成普通工具行。

事件流必须出现明确 `final` 才能完成 Task。流关闭但没有 final 会失败；中间 assistant 文本、reasoning 或工具摘要不会被擅自提升为最终回答。Task 报告是持久事件日志的派生投影，丢失或损坏时可从日志重建。

调度器提交统计在实际工具执行边界独立完成：适配器提供可关联的 shell 命令输入、稳定调用身份和完成结果，主机仅在真实提交命令及同次成功回执吻合时登记作业。所有 Agent 与控制台提交共用提交账本和独立状态跟踪器，不按 Agent 维护多套作业历史逻辑。真实回执落盘后即由后台按 JobID 查询调度器并跟踪到终态，不要求用户打开历史面板；已确认终态持久化，断线暂停、重连恢复未确认记录。该能力不要求模型记账，也不扫描 Agent 查询到的历史作业或报告；具体查询频率、范围和失败边界见《SSH机制》。登记或状态跟踪故障不能触发远端命令重跑或把已经成功的 Agent 回合改成失败。

未知的交互请求不能自动同意；未知事件会形成可见兼容性信息或明确错误，不会被静默解释成成功。事件进入浏览器前还要经过敏感字段检查。

## 6. Task 生命周期

一次新 Task 的主流程是：

1. 固化网页对话当前 route，校验 workspace、binding 与 version domain 一致；
2. 并行准备 Agent runtime、Skill 视图、上下文交付与文件版本后端；
3. Context Hub 根据原生 session 和 receipt 选择初始化内容或未确认增量；
4. 将用户原始提问作为任务目标，把选中的记忆、文件和其他知识作为结构化补充单元交给远端 Agent；
5. 在原生调用前暂存本轮实际交付的知识身份；
6. 原生 session/turn 已被证明接收后，才持久确认 receipt；失败时丢弃暂存，不制造“已经发送”的假记录；
7. 持续归一化并写入事件日志，直到 `final`、失败或原生中断；
8. 收取本轮写前 manifest，完成文件版本边界，再发布可复用的终态。

命令具有稳定 ID 和请求指纹。重复 HTTP、断线重连或页面重放会复用已存在的命令结果，不会重复启动同一回合。相邻高频文本/工具增量在进入有界队列前合并，防止 SSH 单个数据块产生大量微小帧而造成虚假背压。

远端 Agent 已成功完成但文件版本收尾失败时，最终回答仍保留；页面另行显示版本记录失败。这样辅助账本故障不会抹掉真实 Agent 结果，也不会谎称文件可以完整回溯。

所有模型可见的固定提示词和结构模板集中在仓库 `prompts/`，由 `gateway/core/prompts/repository.mjs` 校验变量后渲染。Agent adapter 和 runtime 只装配原生协议参数、用户原文及已选择的语义单元，不在代码中散落另一套提示词，也不用防御性措辞修补状态机缺口。

### 6.1 运行中追问

同一网页对话有活动 Task 时，用户的新消息不再经过网页 Agent，也不重新检索记忆、文件或 Skill；它通过统一 `append` 能力直接进入当前原生会话。前端把原来的 Agent 调用活动截成上下两个视觉分段，但这些分段仍属于同一 Task，最终一起进入完成、停止或失败状态。

若原生协议的“当前回合 steer 窗口”刚好关闭，适配器只能在已证明安全的情况下于同一原生会话开始下一回合；不能换一个 session 后假装这是中途修正。不同 Agent 的准确策略见各自文档。

### 6.2 终止

终止先调用对应 Agent 的原生 interrupt/abort/control 能力，并验证原生执行确实停止。只有验证完成后，EasyWork 才收尾已经发生的文件变更并把 Task 标记为 `interrupted`。若原生协议无法确认停止，系统报告失败或对同一个受管进程做有界升级，不提前显示“已终止”。

用户之后显式继续被中断的任务时，`resume` 复用原 binding 与可证明存在的 native session；Gateway 重启不会自行重放上一条用户请求。无法证明 session 仍可恢复时保持稳定失败，避免重复执行工具副作用。

### 6.3 审批与用户输入

原生 Agent 的审批和问答请求先以稳定 request ID 写入 Task 状态，再使 Task 进入等待状态。用户回应通过 `respondApproval` 或 `respondInput` 回到原进程/原生 session；多个并行请求逐项结算，不能因为其中一项完成就提前把 Task 改回运行或完成。页面刷新和断线只重放持久请求，不重新触发原生工具。

### 6.4 思考强度适配

EasyWork 以用户保存的思考强度为准，不在每个回合试探或重写配置。只有原生接口明确拒绝本次强度时，且尚未产生实质正文、工具副作用或运行中追加，适配器才选择最接近的受支持档位；距离相同时偏向更高档位，至多重试一次。

适配成功后通过 compare-and-set 修改对话自己的配置：只有配置仍等于本次被拒绝的旧值才落盘，避免迟到响应覆盖用户更晚的选择。统一事件向聊天区说明原档位和实际档位，配置面板同步显示实际值。

### 6.5 原生压缩与用量

`compact` 始终调用对应 Agent 的原生会话压缩能力，不由 EasyWork 自行改写 Agent transcript。压缩只改变原生 Agent 如何维护自己的窗口，不清空 Context receipt；已交付知识仍按同一 session 去重。`contextUsage` 表达当前请求或当前窗口的占用，累计计费用量单独保留，不能拿累计 billing 伪装成当前上下文大小。

## 7. Context Hub、记忆与 Skill

Context Hub 按来源顺序和 token 预算组装网页历史、对话/项目记忆、资源片段、文件内容等交付单元。EasyWork 的语义记忆范围只有账号级对话间记忆、项目记忆和当前网页对话记忆；服务器、工作区与远端 Task 只提供路由和来源身份，不形成可跨项目命中的记忆层。每个单元有稳定 key、版本和内容 digest；消息按消息身份区分，所以两个不同回合即使文字相同也不会被误认为同一条消息。

`deliveryForBinding` 只在 receipt 指向同一个仍存在的原生 session 时做增量交付。session 缺失、被确认删除或 binding 换绑到另一原生 session 时，receipt 不能跨 session 复用。此时 `deliveryForRebinding` 从已知历史交付中按来源版本重建语义上下文，再叠加当前选择并重新执行预算，而不是把旧 Agent 的工具日志或思考过程拼进 prompt。

### 7.1 Skill 库

服务器级 `~/.easywork/skills` 是不可变 Skill 包缓存，不代表每个 Agent 都能看到全部 Skill。每个 binding 的 `skills/` 目录只链接已经交付给该原生会话的版本；交付来源包括网页 Agent 选中、用户本轮显式选择，以及适用范围配置为全部模式或工作模式并强制启用的 Skill。适用范围以当前用户该 Skill 的独立配置为准；市场范围只在首次安装时复制为默认值，后续市场修改不会同步覆盖个人范围。因此每个远端 Agent 对话有自己的 Skill 可见集合，其他对话不能因共用服务器而自动发现它。

Skill 内容不再重复塞入普通补充 prompt：网页 Agent 读取入口用于判断相关性，远端 runtime 将所选包作为该 Agent 的原生 Skill 输入或原生发现目录。Context receipt 记录 Skill pin；同一 session 已确认的版本不重发，换绑 session 后重新评估并建立完整 Skill 视图。服务器缓存可以复用包文件，但 binding 视图和收据不能共享。

适用模式和服务器范围由主机在工具组装前过滤，用户本轮点选也不能突破模式或服务器边界。强制 Skill 直接进入必需交付集合，不向网页模型暴露名称、正文或候选，不需要模型再次读取或提交；仍由同一原生部署通道和 `native.skillPins` 收据保证版本固定、会话隔离与去重，并在“发给远端 Agent”中显示实际交付引用。已加载到原生会话中的既有内容不会因后续范围变更而被假装从原生记忆中删除。

### 7.2 Checkpoint 与原生边界

Context checkpoint 同时保存 receipt 增量和原生边界：协议、session、turn 以及需要时的 rollout 路径。网页回溯会把 receipt 恢复到对应 checkpoint；网页分支会把来源 receipt 复制到目标 binding。

原生 fork 已经继承的网页消息会在目标 receipt 中成为别名，后续不重复发送。若某个 Agent 的原生 fork 重写消息 ID，适配器还要保存来源到目标的边界映射；保留 ID 的 Agent 则直接复用边界。缺少可证明边界时不猜测，改用新的 `contextEpoch`，让下一回合重新评估全部语义内容。

## 8. EasyWork 文件版本账本

### 8.1 存储结构与快照语义

每台服务器的主要布局为：

```text
~/.easywork/versioning/<actor>/<server>/
  ledgers.json
  path-heads.json
  conversations/<domain>/ledger.json
  objects/<sha256-prefix>/<sha256>
```

`ledger.json` 保存逻辑分支、checkpoint DAG、Task 前后边界和路径变化；`path-heads.json` 记录受管绝对路径的当前物理指纹及各对话域已知的逻辑 HEAD；`objects` 是服务器级不可变内容寻址对象库，父子对话可以共享相同对象。

快照只表达不存在、普通文件或目录，以及内容 SHA-256、大小、权限 mode 与 object ID。目录使用确定性归档，归一化归档内 mtime 和属主；恢复时保留内容、类型和权限模式，但不承诺恢复历史 mtime 或 owner/group。符号链接和其他不支持的文件类型不会被包装成可恢复对象。

新账本不扫描工作区、不复制目录、不为现有文件建立初始快照。只读 Task、没有命中文件写前 Hook 的 Task，以及写前写后完全相同的 Task，都不会留下空 checkpoint。

### 8.2 写前捕获

文件回溯的权威依据是 Agent 工具执行前捕获的路径状态。受管 Agent 通过原生 pre-tool hook 或原生权限边界调用 EasyWork 写前程序。程序从结构化工具输入、真实 cwd、Shell 参数、重定向、补丁头和可静态证明的 Python 文件操作中推导目标；解析后的路径必须位于允许范围，且不能是根目录、`.git`、EasyWork 控制路径或符号链接。

写前 Hook 为每个 Task/operation 原子写入 manifest 和 before payload。第一份有效 manifest 到达时才惰性创建 pending 事务与 before checkpoint；同一路径一轮只采用最早 before。Task 收尾批量导入 before 对象并捕获所有触及路径的 after 状态，账本提交成功后才清理 manifest。崩溃恢复只补收该 Task 已持久化的 manifest，不扫描整个工作区，也不把旧操作归到下一条消息。

任意程序内部的动态副作用无法仅靠事后 diff 完整还原。解析器不能证明目标时就不猜；`file_change` 事件只负责展示和记账提示，不能替代已经丢失的 before 内容。用户自行选择的 Agent 版本若缺少所需 Hook 能力，可以在明确兼容性警告下继续运行，但 EasyWork 不声称这些修改可完整回溯。

### 8.3 共享工作区与冲突

同一网页对话同时只允许一个远端 Task，以保护其唯一可写账本。不同网页对话则可以在同一物理工作区并行运行，遵循真实文件系统竞争；EasyWork 不把它们伪装成隔离副本。

普通 Task 启动不会把该对话的旧逻辑 HEAD 自动物化回工作区。Agent 总是读取共享目录的当前现场，写前 Hook 捕获的现场才是本轮 before。只有用户显式执行分支、回溯、重新生成或版本恢复时，版本器才计算待改写路径并物化 checkpoint。

显式恢复先锁定全部路径并比较现场指纹：现场必须等于 EasyWork 记录的当前物理指纹，或已经等于目标指纹；否则视为用户或外部程序修改，整次操作停止并报告冲突路径。多路径恢复先全量预检，再按稳定顺序应用；中途失败使用已保存对象逆序补偿。任一受影响工作区仍有远端 Task 运行时，恢复直接拒绝。

## 9. 网页分支、回溯与重新生成

这些操作同时涉及四个状态面：网页消息、Context receipt、Agent 原生历史和 EasyWork 文件账本。任何实现都不能只处理其中一个面。

### 9.1 分支

分支先等待相关 Task 空闲，找到所选消息对应的 retained checkpoint 与原生 turn 边界，并对所有将被物化的文件路径做冲突预检。文件恢复成功后：

- 创建新的网页对话和独立 binding；
- 新版本域导入分叉点以前的 checkpoint 祖先并共享不可变对象；
- 复制边界内网页消息、有效记忆与 Context receipt；
- 复制配置 scope 的缺省值和 Skill pin 身份；
- 有精确边界时调用 Agent 原生 fork；缺少能力、边界或验证失败时改用新的上下文代次。

原生 fork 成功时，远端 Agent 已经保有分叉前历史，因此不再重发该前缀。父子网页对话之后各自维护 binding、receipt 和 ledger，但如果仍指向同一工作区，它们看到的物理文件仍然共享。

### 9.2 回溯、重试与重新生成

回溯先定位目标消息对应的 before/after checkpoint，并恢复 Context receipt。若旧指令已经进入原生 Agent，则在精确边界上调用原生 revert 或建立原生 deferred fork；同时把 EasyWork 文件账本物化到对应位置。某些协议支持“暂存原生回退—恢复文件—提交原生回退”，文件恢复失败时会撤销暂存，以避免原生历史与文件现场一半成功。

原生回退失败不会伪造旧历史，而是递增 `contextEpoch`。下一条请求换到新的原生会话并完整重评语义上下文。重新生成使用原始用户消息创建新 Task；即使上一轮只有失败 Task、尚无助手 final，也能先回到该轮之前再执行。

回溯只改写账本记录过且位于目标边界之后的路径，不扫描或覆盖其他文件。因为物理工作区共享，恢复结果会立刻被该路径上的其他 Agent 看见。

## 10. 删除与垃圾回收

删除网页对话前，EasyWork 先在本机持久登记远端清理计划，再提交网页对话墓碑。这样即使进程在两步之间退出，也能根据对话是否仍存活决定撤销预登记或继续清理。

在线时，用户点击删除后立即调度一次该对话在服务器上的全部 Agent binding 清理；离线时保留登记，并仅在下次成功连接该服务器时检查一次。连接存续期间没有周期轮询。清理成功后立即删除对应登记和空服务器键，不保留无意义记录；失败则保留原计划以便下一次连接重试。

远端垃圾回收会重新扫描所有存活 binding 和对话域，只删除目标对话独占的 runtime、配置 scope、原生 store 引用、ledger、path head 与未引用对象。由其他网页分支引用的祖先对象、原生 store 或虚拟工作区会保留；其他派生对话不受影响。用户真实工作区及其中 Git 仓库不属于删除目标。

删除 binding runtime 前先按 `state/active.json` 中的受管 PID 停止进程。若 transport 释放或 Gateway 重启使活动记录先于后台服务消失，回收器还会扫描当前 SSH 用户的 `/proc`，只终止环境中 `HOME` 精确等于该 binding 隔离 HOME 的残留进程，然后再删除目录。这一补偿既不会按进程名误杀其他会话，也避免 NFS 把仍被打开的日志转为无法删除的 `.nfs*` 文件，导致同一清理登记永久重试。

## 11. 故障与恢复原则

- 原生 session 只有被协议明确证明不存在时，才允许一次换绑恢复并完整重建语义交付；普通网络错误不会静默另起 session 重跑可能有副作用的请求。
- 每个 binding 的 session、turn、run、协议和原生 store 身份必须一起校验，不能只凭一个 session ID 复用进程。
- Task、命令、事件日志、receipt、pending knowledge、版本 manifest 和删除队列都持久化；重启恢复以这些记录为准，不凭页面状态猜测。
- 文件版本状态使用 revision、原子替换、不可变对象和稳定锁；无法证明安全时保留现场并返回可处理错误。
- 原生 Agent 的 final 是回答权威，EasyWork 的 report 是可重建投影；版本收尾、UI 连接或辅助索引失败不能改写真实 final。
- 配置与兼容性问题应暴露实际 Agent 版本和缺失能力，不用防御性 prompt 掩盖协议错误。

## 12. 源码索引

以下文件是本文的主要事实来源：

| 范围 | 源码 |
| --- | --- |
| 托管版本与制品 | `agent-app/manifest.json`、`gateway/core/agent-runtime/manifest.mjs`、`deployment.mjs` |
| 统一操作与事件 | `gateway/core/agents/contract.mjs`、`common.mjs` |
| 三种协议 reducer | `gateway/core/agents/opencode.mjs`、`codex.mjs`、`claude-code.mjs` |
| 隔离目录、配置与传输 | `gateway/core/agent-runtime/contract.mjs`、`configuration.mjs`、`transport.mjs` |
| Task 生命周期与报告 | `gateway/core/orchestrator/service.mjs`、`persistence.mjs`、`report.mjs` |
| 模型可见提示词 | `prompts/`、`gateway/core/prompts/repository.mjs` |
| Route、binding 与工作区 | `gateway/core/workspaces/contract.mjs`、`service.mjs` |
| 上下文回执与 checkpoint | `gateway/core/context-hub/service.mjs` |
| Web/远端协作与删除 | `gateway/core/runtime/services.mjs`、`agent-conversation-gc.mjs` |
| 文件版本账本 | `gateway/core/versioning/contract.mjs`、`service.mjs`、`gateway/core/runtime/conversation-version-backend.mjs`、`version-pretool.mjs` |

这些模块共同定义 EasyWork 的 Agent 适配面。三份 Agent 专文只解释各自如何满足这组现有能力，不改变本文件中的通用状态模型。
