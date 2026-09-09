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

同一远端原生 session 连续提问不补发网页对话正文；原生历史与压缩由远端 Agent 自己维护。切回曾用过的 Agent binding 时，若其原生 session 仍存在，就继续该 session，由后端只补交离开期间新增且目标尚未收到的网页提问和正文回答。切到从未使用或原生 session 已被确认删除的 binding 时，由后端补齐当前分支此前的有效问答。历史以独立的“历史记录”段标识，不混入当前请求，也不包含网页思考、背景查阅或远端调用活动。A 完成 1、2、3 后切到 B，补 1、2、3；B 完成 4、5 后切回 A，只补 4、5。

切换时的正文增量按原生 session 交付收据计算；同一会话不因本地收据暂缺或用户说“继续”而重放。用户连续发问之间的 `replyToMessageId` 仅表示网页消息关系，不能单独证明旧请求曾交付远端：启动前就失败、停止或取消的 Task 所属提问不参与历史补交；真正进入原生执行的初始提问及运行中追加仍保留。计算结果只在后端进入 ContextHub 的原生交付，不交给网页 Agent 判断，不进入其候选或观测，也不显示在前端交接详情。网页 Agent 自身仍保留正常网页问答上下文以理解追问，其提示词无需包含这些内部同步机制。

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

配置文件使用 revision、原子替换和 `0600` 权限。某个网页对话第一次读取 Agent 配置且自身 scope 尚无值时，以该账号在当前服务器上的全局缺省配置初始化当前对话配置；此后两者独立，普通消息只复用当前对话配置和指纹。用户实际选择模型、思考强度或权限时才更新当前 scope；仅浏览模型供应商或模型列表不会改变选择。分支可在目标 scope 尚无配置时物化来源值，不会覆盖用户已经配置的目标 scope。

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

前端按统一 `reasoning` 和 `message` 类型区分思考与中间总结，三种 Agent 共用规范事件；连续执行内容按中间消息边界分组。历史使用摘要回放、当前对话详情预取和缓存复用，完整正文保存在事件日志中。

调度器提交统计在实际工具执行边界独立完成：适配器提供可关联的 shell 命令输入、稳定调用身份和完成结果，主机仅在真实提交命令及同次成功回执吻合时登记作业。所有 Agent 与控制台提交共用提交账本和独立状态跟踪器，不按 Agent 维护多套作业历史逻辑。真实回执落盘后即由后台按 JobID 查询调度器并跟踪到终态，不要求用户打开历史面板；已确认终态持久化，断线暂停、重连恢复未确认记录。该能力不要求模型记账，也不扫描 Agent 查询到的历史作业或报告；具体查询频率、范围和失败边界见《SSH机制》。登记或状态跟踪故障不能触发远端命令重跑或把已经成功的 Agent 回合改成失败。

未知的交互请求不能自动同意；未知事件会形成可见兼容性信息或明确错误，不会被静默解释成成功。事件进入浏览器前还要经过敏感字段检查。

## 6. Task 生命周期

一次新 Task 的主流程是：

1. 固化网页对话当前 route，校验 workspace、binding 与 version domain 一致；
2. 并行准备 Agent runtime、Skill 视图、上下文交付与文件版本后端；
3. Context Hub 根据原生 session 和 receipt 选择初始化内容或未确认增量；
4. 将用户原始提问作为任务目标，把选中的记忆、文件、显式 `@` 对话片段和其他知识作为结构化补充单元交给远端 Agent；记忆或引用可由网页 Agent 仅为本轮临时整理正文，但稳定来源身份与原标题不变；
5. 在原生调用前暂存本轮实际交付的知识身份；
6. 原生 session/turn 已被证明接收后，才持久确认 receipt；失败时丢弃暂存，不制造“已经发送”的假记录；
7. 持续归一化并写入事件日志，直到 `final`、失败或原生中断；
8. 收取本轮写前 manifest，完成文件版本边界，再发布可复用的终态。

命令具有稳定 ID 和请求指纹。重复 HTTP、断线重连或页面重放会复用已存在的命令结果，不会重复启动同一回合。新 Work 首轮先持久化网页对话和原始用户消息，再让服务器绑定、文件上传、用户工作区登记与其他无依赖准备并行；其中一条失败会写入该对话的启动失败事件，不要求用户重新创建对话。相邻高频文本/工具增量在进入有界队列前合并，防止 SSH 单个数据块产生大量微小帧而造成虚假背压。

远端 Agent 已成功完成但文件版本收尾失败时，最终回答仍保留；页面另行显示版本记录失败。这样辅助账本故障不会抹掉真实 Agent 结果，也不会谎称文件可以完整回溯。

所有模型可见的固定提示词和结构模板集中在仓库 `prompts/`，由 `gateway/core/prompts/repository.mjs` 校验变量后渲染。Agent adapter 和 runtime 只装配原生协议参数、用户原文及已选择的语义单元，不在代码中散落另一套提示词，也不用防御性措辞修补状态机缺口。

### 6.1 运行中追问

同一网页对话有活动 Task 时，用户的新消息不再经过网页 Agent，也不重新检索记忆、文件或 Skill；它通过统一 `append` 能力直接进入当前原生会话。前端把原来的 Agent 调用活动截成上下两个视觉分段，但这些分段仍属于同一 Task，最终一起进入完成、停止或失败状态。

若原生协议的“当前回合 steer 窗口”刚好关闭，适配器只能在已证明安全的情况下于同一原生会话开始下一回合；不能换一个 session 后假装这是中途修正。不同 Agent 的准确策略见各自文档。

### 6.2 终止

终止先调用对应 Agent 的原生 interrupt/abort/control 能力，并验证原生执行确实停止。只有验证完成后，EasyWork 才收尾已经发生的文件变更并把 Task 标记为 `interrupted`。若原生协议无法确认停止，系统报告失败或对同一个受管进程做有界升级；中断失败时恢复此前活动状态并继续接收原生事件，不提前显示“已终止”。当前已经没有活动任务时，停止接口幂等返回，不把旧页面上的停止请求变成额外任务。

用户之后显式继续被中断的任务时，`resume` 复用原 binding 与可证明存在的 native session；Gateway 重启不会自行重放上一条用户请求。无法证明 session 仍可恢复时保持稳定失败，避免重复执行工具副作用。

### 6.3 审批与用户输入

原生 Agent 的审批和问答请求先以稳定 request ID 写入 Task 状态，再使 Task 进入等待状态。用户回应通过 `respondApproval` 或 `respondInput` 回到原进程/原生 session；多个并行请求逐项结算，不能因为其中一项完成就提前把 Task 改回运行或完成。页面刷新和断线只重放持久请求，不重新触发原生工具。

已存在的 `waiting_approval` / `waiting_input` 请求优先于页面中的旧能力缓存。刷新或重连后，即使 Agent 配置缓存尚未恢复，页面仍允许回应真实待处理请求；后端继续校验当前账号、Task、精确 binding 和 request ID，不能把缓存缺失误报为“不支持审批”或跳过原生请求校验。

### 6.4 思考强度适配

EasyWork 以用户保存的思考强度为准，不在每个回合试探或重写配置。只有原生接口明确拒绝本次强度时，且尚未产生实质正文、工具副作用或运行中追加，适配器才选择最接近的受支持档位；距离相同时偏向更高档位，至多重试一次。

适配成功后通过 compare-and-set 修改对话自己的配置：只有配置仍等于本次被拒绝的旧值才落盘，避免迟到响应覆盖用户更晚的选择。统一事件向聊天区说明原档位和实际档位，配置面板同步显示实际值。

### 6.5 原生压缩与用量

`compact` 始终调用对应 Agent 的原生会话压缩能力，不由 EasyWork 自行改写 Agent transcript。压缩只改变原生 Agent 如何维护自己的窗口，不清空 Context receipt；已交付知识仍按同一 session 去重。`contextUsage` 表达当前请求或当前窗口的占用，累计计费用量单独保留，不能拿累计 billing 伪装成当前上下文大小。

## 7. Context Hub、记忆与 Skill

Context Hub 按来源顺序和 token 预算组装网页历史、对话/项目记忆、显式引用片段、资源片段和文件内容等交付单元。EasyWork 的语义记忆范围只有账号级对话间记忆、项目记忆和当前网页对话记忆；服务器、工作区与远端 Task 只提供路由和来源身份，不形成可跨项目命中的记忆层。项目“仅项目内”时不会读取账号级或其他项目记忆；“全局记忆”项目与无项目 Chat 才进入同一账号级共享边界。每个单元有稳定 key、版本和内容 digest；消息按消息身份区分，所以两个不同回合即使文字相同也不会被误认为同一条消息。显式 `@` 引用绑定发送时冻结的来源快照，只能由当前消息授权读取，不会被当作长期记忆自动提取。

`deliveryForBinding` 只在 receipt 指向同一个仍存在的原生 session 时做增量交付。session 缺失、被确认删除或 binding 换绑到另一原生 session 时，receipt 不能跨 session 复用。此时 `deliveryForRebinding` 从已知历史交付中按来源版本重建语义上下文，再叠加当前选择并重新执行预算，而不是把旧 Agent 的工具日志或思考过程拼进 prompt。

### 7.1 Skill 库、远端安装与原生调用

服务器级 `~/.easywork/skills` 是按用户与包摘要隔离的不可变缓存，不代表每个 Agent 都能看到全部 Skill。部署先校验完整包摘要，再原子发布缓存；每个 binding 复制出自己的可写文件代次，`skills/` 中的指针仅指向自有副本，不能指向共享缓存。交付来源包括网页 Agent 选中、用户本轮显式选择及符合范围的 Work 强制 Skill。同版复用当前副本，不覆盖其中的改动。上传时统一校验原生入口元数据，旧包只在受控副本中补齐入口，不改写已发布版本。

用户安装库是独立副本：正文、附件、名称、描述与个人适用范围都不随市场编辑、发布或删除而变化。重复安装已存在的 Skill 在用户写队列内返回当前版本，不覆盖个人内容；卸载后重新安装才取得当时市场版本。网页缓存候选按其原始知识身份解析到确切版本并校验摘要，不擅自替换为个人库的最新版。

Skill 内容不复制到普通补充 prompt。网页 Agent 读取入口判断相关性，远端 runtime 使用原生 Skill input 或原生命令实际调用所选副本。Skill pin 是该绑定技能视图的部署收据：强制项据此补齐缺少的版本；用户显式或网页按需选中的 Skill 仍进行本轮原生调用。记忆与文件正文继续按原生会话收据去重。Codex 登记独立发现根并刷新技能目录；Claude Code 和当前 OpenCode V1 使用 binding 内生成的原生选中命令，具体协议见各自文档。

适用模式和服务器范围由主机在工具组装前过滤，用户本轮点选也不能突破模式或服务器边界。强制 Skill 由后端在切换远端 Agent 绑定后的第一次提问检查 `native.skillPins`，仅把该绑定缺少的 `skillId + version + sha256` 加入必需交付集合。连续提问复用检查结果，不每轮检查或发送；切换绑定后下一问再检查。分支继承的独立技能副本直接复用，同一绑定的底层原生会话重建不会把仍在目录中的技能视为缺失。补发成功后更新检查结果，启动失败或中断则保留重新检查机会。强制技能不向网页模型暴露名称、正文、列表或候选，不要求模型读取或提交；与其他 Skill 共用部署及原生使用通道，只有本次实际补发项出现在“发给远端 Agent”中。已加载到原生会话中的既有内容不会因后续范围变更而被假装从原生记忆中删除。

一份 EasyWork 技能从个人库到远端执行，按以下顺序处理：

1. **固定个人版本。** 用户上传或安装后的个人包保存正文、附件及适用范围。网页已读候选必须解析到实际读到的 `skillId + version + sha256`；显式选择和强制项直接固定版本。Task 不因市场或个人库随后变化而改用其他包；同一 Task 选中冲突版本时明确失败。
2. **上传不可变包。** `SshSkillDeployment` 校验本地文件大小与摘要，经 SSH 上传到临时目录，逐文件回读校验后原子发布到用户隔离缓存。重复部署同摘要包先校验再复用；已发布文件被修改时报错，不把损坏缓存当成新版本。市场条目和技能名称都不是远端目录授权依据。
3. **建立对话自有副本。** runtime 将包复制到当前 binding 的新文件代次，确保存在可供原生发现的 `SKILL.md`，再原子切换 `skills/<skill-id>` 指针。入口保留合法的原生名称和说明；缺少兼容入口时在受控副本中生成，同一视图的原生名称冲突或占用 `easywork-selected` 保留名会失败。同版包复用该 binding 已有副本及其中的修改；本轮选中不同摘要时才建立新副本并切换。
4. **调用本轮选择。** 目录可保留当前 binding 以前持有的技能，但本轮显式 Skill input 或组合命令只包含这次选中的技能。下表中的原生调用把正文真正送入本轮，不以“文件已经上传”代替调用。技能附件留在自有目录中，原生 Agent 按技能内容中的相对路径读取或运行。
5. **记录结果与继承边界。** `state/skill-view.json` 记录自有目录、原生名称与内容身份，binding pin 记录部署版本；运行指纹包含技能视图，本轮组合命令的内容摘要也参与进程复用判断。Task 收尾保存实际技能文件快照，网页分支从所选边界恢复独立副本，详见第 9.1 节。技能目录变更不能让旧预热进程继续承接新内容，旧进程退出也不能关闭替代进程使用的 binding relay。

目录关系如下，路径中的占位符由主机按账号、binding 和固定内容计算：

```text
~/.easywork/skills/packages/<actor-hash>/<package-sha256>/
  package.json                         # 固定包及逐文件校验清单
  SKILL.md、其他入口或附件               # 不可变缓存内容

~/.easywork/runtime/agents/<agent>/<binding>/
  skill-generations/<generation>/<skill-id>/  # 当前对话自有文件
  skills/<skill-id> -> ../skill-generations/<generation>/<skill-id>
  skills/easywork-selected/SKILL.md      # Claude / OpenCode 本轮调用包装
  state/skill-view.json
  skill-snapshots/<task-id>/snapshot.json
  skill-snapshots/<task-id>/files/<skill-id>/...
```

| Agent | 如何发现当前 binding 的技能 | 如何在本轮使用 |
| --- | --- | --- |
| Codex | app-server 初始化后用 `skills/extraRoots/set` 注册 `skills` 根；选用前按当前 cwd 执行 `skills/list`，设置 `forceReload: true`，校验名称和返回路径属于本 binding | 将发现返回的名称和路径作为 `type: "skill"` 的 input 加入 `turn/start`，同一 input 内按路径去重；找不到所选技能即报错 |
| Claude Code | `<runtime-data>/claude/skills` 指向当前 binding 的 `skills`；从本轮自有副本正文生成 `easywork-selected/SKILL.md`，同时保留各技能的资源基准目录 | 在 stream-json 的本轮 user frame 中调用 `/easywork-selected <本轮交接正文>`，由原生命令展开技能；不只等待模型自行匹配 |
| 当前托管 OpenCode V1 | `<runtime-config>/opencode/skills` 指向当前 binding 的 `skills`；同样生成本轮选中命令，并通过 `/command?directory=<cwd>` 确认可发现 | 调用 `/session/:id/command?directory=<cwd>`，传入 `command: "easywork-selected"`、本轮交接正文 `arguments`、model 与 variant；提交响应可持续到回合结束，与原生事件流一起处理 |

既有 OpenCode V2 会话仍按已固定的 V2 协议运行，不宣称已执行上述 V1 command。运行中的纯文字追加不重新评估或部署技能。上述安装过程不会向用户工作区全局的 `.claude`、`.codex` 或 `.opencode` 技能库复制一套共享安装；EasyWork 管理的技能视图始终属于精确 binding。

因此，“个人库已安装”“远端包已部署”和“本轮原生已调用”是三个不同边界。网页显示 Skill 引用用于核对交付选择，实际执行效果还应对照原生事件、工具结果与文件 Artifact，不能仅凭一条引用认定任务已经执行。

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
- 复制配置 scope 的缺省值，从分叉 Task 的技能快照恢复独立文件及对应 pins；
- 有精确边界时调用 Agent 原生 fork；缺少能力、边界或验证失败时改用新的上下文代次。

原生 fork 成功时，远端 Agent 已经保有分叉前历史，因此不再重发该前缀。父子网页对话之后各自维护 binding、receipt 和 ledger，但如果仍指向同一工作区，它们看到的物理文件仍然共享。

技能快照在 Task 收尾捕获实际自有文件，记录路径、内容摘要、大小、权限及 pins；生成的调用包装不纳入历史。快照不可变，恢复校验整体清单与每个文件，并原子切换目标目录。较早边界没有的技能不能从来源 binding 当前状态补入；父子之后新增、删除或修改技能互不影响。新机制启用后的边界缺失快照时明确拒绝分支，不能伪造继承。旧历史只能按边界内已完成 Task 恢复当时的包版本，启用快照之前未记录的人工修改无法事后还原。

复制网页消息保留原始消息身份，以便关联边界内的网页和原生事件；旧分支仅对可唯一匹配的祖先消息做只读投影。下载卡片按已授权的继承 Task 显示，不能因复制后的消息 ID 改变而消失。

### 9.2 回溯、重试与重新生成

回溯先定位目标消息对应的 before/after checkpoint，并恢复 Context receipt。若旧指令已经进入原生 Agent，则在精确边界上调用原生 revert 或建立原生 deferred fork；同时把 EasyWork 文件账本物化到对应位置。某些协议支持“暂存原生回退—恢复文件—提交原生回退”，文件恢复失败时会撤销暂存，以避免原生历史与文件现场一半成功。

原生回退失败不会伪造旧历史，而是递增 `contextEpoch`。下一条请求换到新的原生会话并完整重评语义上下文。重新生成使用原始用户消息创建新 Task；即使上一轮只有失败 Task、尚无助手 final，也能先回到该轮之前再执行。

回溯只改写账本记录过且位于目标边界之后的路径，不扫描或覆盖其他文件。因为物理工作区共享，恢复结果会立刻被该路径上的其他 Agent 看见。

文件物化前持久保存真实现场、账本及索引的 undo journal。任一发布阶段失败时恢复全部状态，重启先恢复未完成事务；相同命令不能把未完成的结果冒充成功回执。

## 10. 删除与垃圾回收

删除网页对话前，EasyWork 先在本机持久登记远端清理计划，再提交网页对话墓碑。墓碑提交后、删除接口返回前，会同步从所有服务器配置中解除该网页对话的绑定；记忆、Task、工作区版本和远端原生会话等较重清理继续使用可恢复队列。这样即使进程在两步之间退出，也能根据对话是否仍存活决定撤销预登记或继续清理，而服务器管理页不会在后台清理期间继续显示已经删除的网页对话。

Actor 服务初始化时只把服务器配置中现有的绑定 ID 与当前存活对话摘要做一次对账，删除已经缺失或带删除墓碑的历史绑定以及相应禁用标记；不会遍历全部历史对话，也不会移除仍存活但在前端折叠或尚未分页加载的项目对话。在线时，用户点击删除后立即调度一次该对话在服务器上的全部 Agent binding 清理；离线时保留登记，并仅在下次成功连接该服务器时检查一次。连接存续期间没有周期轮询。清理成功后立即删除对应登记和空服务器键，不保留无意义记录；失败则保留原计划以便下一次连接重试。

远端垃圾回收会重新扫描所有存活 binding 和对话域，只删除目标对话独占的 runtime、配置 scope、原生 store 引用、ledger、path head 与未引用对象。由其他网页分支引用的祖先对象、原生 store 或虚拟工作区会保留；其他派生对话不受影响。用户真实工作区及其中 Git 仓库不属于删除目标。

版本发布与 GC 共用用户／服务器级互斥边界；存在原生 Hook 的 pending Task 或未完成 undo 时推迟对象清理，避免删除扫描之后才发布的新对象。

删除 binding runtime 前先按 `state/active.json` 中的受管 PID 停止进程。若 transport 释放或 Gateway 重启使活动记录先于后台服务消失，回收器还会扫描当前 SSH 用户的 `/proc`，只终止环境中 `HOME` 精确等于该 binding 隔离 HOME 的残留进程，然后再删除目录。这一补偿既不会按进程名误杀其他会话，也避免 NFS 把仍被打开的日志转为无法删除的 `.nfs*` 文件，导致同一清理登记永久重试。

## 11. 故障与恢复原则

- 原生 session 只有被协议明确证明不存在时，才允许一次换绑恢复并完整重建语义交付；普通网络错误不会静默另起 session 重跑可能有副作用的请求。
- 每个 binding 的 session、turn、run、协议和原生 store 身份必须一起校验，不能只凭一个 session ID 复用进程。
- Task、命令、事件日志、receipt、pending knowledge、版本 manifest 和删除队列都持久化；重启恢复以这些记录为准，不凭页面状态猜测。浏览器刷新、关闭、退出当前 Web 会话或换设备只改变订阅与登录状态，不取消 Task、PTY 或主机侧 SSH Worker；重新登录后按持久状态继续显示进度。
- 主机每两分钟检查一次超过两分钟没有新远端事件的活动 Task：若原生 transport 仍明确运行则保持原状；若已不在运行，读取可验证的退出/协议原因并把 Task 收敛为可见失败，不能让页面永久停在“Agent 调用中”。该检查不主动重跑用户请求。
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
| Skill 版本、上传与自有视图 | `gateway/core/skills/service.mjs`、`native-package.mjs`、`gateway/core/runtime/skill-deployment.mjs`、`gateway/core/agent-runtime/skill-views.mjs` |
| Task 生命周期与报告 | `gateway/core/orchestrator/service.mjs`、`persistence.mjs`、`report.mjs` |
| 模型可见提示词 | `prompts/`、`gateway/core/prompts/repository.mjs` |
| Route、binding 与工作区 | `gateway/core/workspaces/contract.mjs`、`service.mjs` |
| 上下文回执与 checkpoint | `gateway/core/context-hub/service.mjs` |
| Web/远端协作与删除 | `gateway/core/runtime/services.mjs`、`agent-conversation-gc.mjs` |
| 文件版本账本 | `gateway/core/versioning/contract.mjs`、`service.mjs`、`publication-gate.mjs`、`gateway/core/runtime/conversation-version-backend.mjs`、`version-pretool.mjs` |

这些模块共同定义 EasyWork 的 Agent 适配面。三份 Agent 专文只解释各自如何满足这组现有能力，不改变本文件中的通用状态模型。
