# EasyWork 远端文件版本与 Agent 机制

本文定义 EasyWork 如何绑定 Codex、Claude Code、OpenCode 和 Qoder CN 的原生会话，隔离运行数据，安装 Skill，投递用户文件，并维护工作区版本边界。网页 Agent 的上下文与检索原则见《网页Agent机制》。

## 1. 三类独立版本

EasyWork 同时管理三类不能互相替代的版本：

1. 原生 Agent 版本：可执行程序、协议和配置能力；
2. 远端会话版本：原生 session、turn、压缩状态以及 EasyWork Binding；
3. 工作区文件版本：远端 Agent 写入前后的可恢复内容。

升级 Agent 不会自动改写既有会话；恢复文件也不会自动回退原生对话。网页分支、回溯和重新生成必须明确协调三类状态。

### 1.1 Agent 更新器边界

`agent-app/update-agent-app.ps1` 只调用同目录更新器维护本机 Agent 制品目录：`-Latest` 查询四项官方最新版本并更新 Manifest，`-Locked` 下载或修复清单固定版本，`-Check` 离线核对大小与 SHA-256；`-Agent` 和 `-Platform` 可缩小范围。脚本不连接 EasyWork、SSH 或远端服务器，也不触发部署。未显式传 `-Platform` 时保留并处理清单中已有的全部平台，不会因本机架构丢掉其他服务器制品。Qoder CN 的更新标识为 `qodercncli`。

当前制品矩阵覆盖 `linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl`，分别对应 x86-64/ARM64 上常见的 Ubuntu、Debian、RHEL 系发行版以及 Alpine 等 musl 系统。Codex 官方只发布对应架构的 musl Linux 包，glibc 标签复用同一份已校验包；OpenCode、Claude Code 和 Qoder CN 使用各自原生 glibc/musl 制品。Qoder CN 的 x64 glibc 主包要求现代 CPU 指令集；部署器从 `/proc/cpuinfo` 检测 `sse4_2`、`popcnt`、`avx`、`avx2`、`bmi1`、`bmi2`、`fma`，缺少任一项时选择同版本官方 baseline 包。Manifest 固定的主机兼容版本也参与下载、校验和 `-Latest` 保留流程。

## 2. Route、Binding 与原生会话

一次 Work 运行的 Route 由服务器、绝对工作区、Agent 类型和网页对话分支共同确定。工作区是每轮可变的执行位置；Agent Binding 的稳定身份由 Actor、服务器身份、Agent 类型、网页对话、网页分支和上下文代次确定，不把工作区 ID 编进 identity。Binding 拥有自己的原生会话、运行目录、配置视图、Skill 视图、用户文件视图和知识收据。

同一服务器、网页对话分支和上下文代次中，每种 Agent 各有一个稳定 Binding。切换工作区会更新 Route，并让当前 Agent 原生会话在目标工作目录继续；切换 Agent 会选中该 Agent 自己的 Binding，首次使用时创建，切回时恢复它原来的原生会话。Agent 之间不复制原生历史。

切换服务器、网页分支或上下文代次会选择新的 Binding。原生会话和 store 位于具体远端主机，跨服务器不能原地迁移；目标 Binding 由 Context Hub 只补发它尚未收到的网页正文和语义资料。旧服务器上的 Binding 保留到用户切回或对话删除。

Binding 隔离 Agent 上下文和 EasyWork 管理数据。工作区登记与文件版本域仍按真实绝对路径区分；同一 Binding 先后访问多个工作区时，每轮工具只以当前 Route 的工作区为 cwd。若多个 Binding 指向同一用户工作区，它们仍通过真实文件系统看到相同工作区文件。

从旧版升级时，EasyWork 会在该 Agent 首次运行前发现旧的“含工作区”Binding，把可验证的 native session、native store 所有权和 Context 收据迁移到稳定 Binding。旧收据仍保留用于回收与审计，已交付正文不会因 identity 变化而重复发送。

网页先完成路由确认，再开始远端切换。已有 Work 对话选择另一个 Agent 时，先显示“切换 Agent”确认框；用户确认后才设置加载状态并执行后端切换，取消时不发请求。点击当前正在使用的 Agent 只关闭菜单。活动 Task 或待完成的 Work 交接会禁用切换。工作区切换同样先取得后端变更说明；需要确认时先停止选择器的加载状态，再显示确认框，确认后继续原请求。

新建 Work 对话的 Agent 菜单始终从一级清单打开，即使服务器已经选好，也不会直接跳入某个 Agent 的二级配置。用户可以进入二级菜单修改配置，点击“完成”后选中该 Agent 和当前配置并关闭菜单；该入口不显示卸载动作。

## 3. 原生上下文边界

远端 Agent 自己维护本地会话历史、工具结果、推理状态和压缩。EasyWork 不把这些内容重新拼成第二份模型历史，也不在同一原生会话每轮补发网页对话。

Codex 的原生 thread/turn、Claude Code 和 Qoder CN 的 session 与 stream-json 回合、OpenCode 的 session/message 是各自协议的权威边界。EasyWork 保存可验证的 session、turn、协议和运行身份，并通过原生接口继续、终止、分支或回退，不能只凭回答文本猜测会话状态。

网页对话切换 Agent、服务器或上下文代次而进入不同原生会话时，EasyWork 只补发目标尚未收到的网页正文增量。增量只含用户提问和正式助手回答，并标为历史记录；思考、工具调用、日志、Todo、作业过程和前端状态不进入。切回旧会话时只补发离开期间新增部分。普通工作区切换保持同一原生会话，因此不触发整段网页历史重放。

远端模型的原生压缩仍由原生协议维护。EasyWork 记录原生用量和压缩事件，但不以网页摘要覆盖原生会话。只有原生会话被协议证明不存在，或用户进行分支、回溯等显式操作时，才建立新上下文代次并重建允许交付的语义资料。

四种 Agent 的压缩完成条件不同，统一接口不抹平这些差异：

| Agent | 原生压缩入口 | EasyWork 确认成功的边界 |
| --- | --- | --- |
| OpenCode | V1 `POST /session/:id/summarize`；V2 `POST /api/session/:id/compact` | 原生 HTTP 请求成功；压缩事件继续写入 journal |
| Codex | `thread/compact/start {threadId}` | app-server 对 JSON-RPC 请求成功响应；`thread/compacted` 另作生命周期事件 |
| Claude Code | stream-json user `/compact` | 必须收到 `system/compact_boundary` |
| Qoder CN | stream-json user `/compact` | 必须收到 `system/compact_boundary` |

Claude Code 和 Qoder CN 在活动进程及恢复的一次性进程上使用同一等待器。命令发送前已排队回合的 `result` 不作为压缩结果；轮到压缩后，无 `compact_boundary` 的终态立即返回原生失败或未执行原因，流提前关闭返回不完整，只有既无边界又无终态时才在 90 秒后超时。压缩完成后页面强制刷新上下文用量，不清空模型/provider 目录。

上下文用量只读原生事件：OpenCode 使用当前 session 已归一化的 usage，Codex 使用 `thread/tokenUsage/updated`，Claude Code 使用当前请求的 streaming usage 或 assistant `context_usage`，Qoder CN 还可用 `context_usage_ratio` 与 `modelUsage.contextWindow` 还原当前窗口。终态累计 billing 不覆盖窗口占用，也不会为了取得数字向原生会话注入测试 prompt。页面显示的上限优先使用该对话配置的 `contextLimit`，代表自动压缩计算窗口；最近一次可验证值按 Actor、服务器、配置域、Binding 和 Agent 缓存，并在原生 revision 前进、菜单打开或压缩完成后刷新。

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

共享文件系统上的持久会话与本机临时状态分开处理。Codex 的 thread、rollout 和配置仍保存在 Binding 原生 store；若家目录是共享或未知文件系统，EasyWork 使用 Codex 原生 `CODEX_SQLITE_HOME` 把 SQLite WAL 数据放到登录节点的用户私有临时目录，并把 `$CODEX_HOME/tmp/arg0` 指向同类本机目录。OpenCode 的持久 store 仍属于 Binding，但首次启动允许最多 120 秒等待 provider/model 目录实际就绪，不能只凭 health 判断可用。临时目录只承载可重建的进程状态，不能成为会话身份或备份来源。

Claude Code 托管进程关闭非必要网络流量和自身更新入口。版本升级只由本地 Agent 更新器下载、校验并登记，远端执行不能在回合启动时把受管二进制替换成 Manifest 之外的版本；这也避免受限登录节点在第一条 stream-json 事件前等待遥测或更新服务器。清单主版本是 `2.1.269`，同时固定官方 `2.1.170` 作为 Linux x64、glibc 不高于 2.17 的兼容制品，以规避上游 `2.1.176` 起在 RHEL/CentOS 7 上的启动回归。部署前探测 OS、架构和 libc；匹配旧主机时选择兼容制品并保存选择收据，主机升级后自动恢复主版本。更新器在更新主版本时保留、下载并校验兼容制品，远端不会任意选择未登记旧版。

Skill 快照在每个 Task 终态固定该 Binding 当时的技能文件。远端快照器优先使用 `python3`，只有 Python 2 的旧 HPC 系统则使用兼容脚本通过 `python` 执行；两条路径生成相同的 UTF-8 描述符、内容哈希、数量与总大小边界。文件修改前 Hook 仍要求可用的 Python 3，并会继续探测系统、Conda 和常见公共软件目录，缺少时明确阻止写操作。

## 5. 统一 Agent 能力

四种 Agent 通过统一合同向上层暴露：创建或恢复原生会话；开始一轮、追加输入和终止；流式文本、思考、工具活动、Todo、文件变化、审批、错误与终态；原生分支、回退或新上下文代次；Skill 发现与本轮调用；文件写前边界。

适配器必须把协议确认的终态映射为完成、失败或取消。流已经结束但状态仍为运行，或者任务实际不存在却无法终止，属于状态收敛错误，不能长期保留“进行中”。

运行中追问只在原生协议支持且当前回合可接收输入时追加，否则排队到下一轮。终止先调用原生取消，再核对进程和会话状态；即使原生返回“没有正在运行的任务”，EasyWork 也要依据已知终态收敛本地 Task。

### 5.1 控制链路的实现边界

网页请求不会直接启动 CLI。后端先把网页对话分支解析为确定的 Route 和 Binding，固定本轮文件、Skill、模型配置与上下文代次，再创建持久 Task。`TaskOrchestrator` 负责 Task 生命周期，`AgentRuntimeTransport` 负责准备隔离目录、解析托管或用户二进制、写入进程级配置、恢复原生会话并执行适配器操作；`SshAgentExecutor` 只提供受该服务器连接约束的进程、HTTP/SSE、JSON-RPC、SFTP 和信号通道。三者的状态都写入 Task、Binding 和事件日志，因此浏览器断开后不需要靠页面内存判断远端是否仍在运行。

一次新回合按以下顺序进入远端：

1. 校验服务器身份、当前工作区绝对路径、Agent 类型、稳定 Binding 和上下文代次；
2. 准备 Binding 私有 HOME、配置、data、state、logs、skills 和 files，并校验目录没有越出受管根；
3. 固定并部署本轮 Skill，把手动文件物化到当前 Binding，再生成只含必要资料与原始用户请求的交接输入；
4. 根据 Binding 中已验证的原生 session 身份选择新建或恢复，不从回答文本推测 session；
5. 启动或复用原生控制通道，把原生事件连续归一化写入 Task journal；
6. 只有协议终态、受管进程状态和文件版本收尾一致时，才把 Task 收敛为完成、失败或取消。

运行中追加、审批、用户输入和终止必须命中当前 Task 保存的原生 session、turn/run 和进程身份。若身份已经变化，控制请求明确失败，不能新启一个进程后把请求发到不确定的会话。事件流意外断开时，恢复逻辑先读取 Binding 的原生身份和可验证状态，再决定重连、收敛或报错；它不会重复提交可能已经产生副作用的用户请求。

### 5.2 Codex 控制

Codex 由每个 Binding 独立的 `codex app-server` 进程控制。后端建立 JSON-RPC 通道后执行 `initialize` 与 `initialized`，新会话调用 `thread/start`，已有会话在进程重建后先调用 `thread/resume`；每一轮使用 `turn/start`，并在 resume/turn 参数中传当前工作区 `cwd`，所以切换工作区仍延续同一 thread。运行中追加使用携带 `expectedTurnId` 的 `turn/steer`，终止使用 `turn/interrupt {threadId, turnId}`。当前进程维护已装载 thread 集合，磁盘中存在 rollout 不等于该进程已经装载 thread。正文、思考、工具、计划、交互请求、用量和 `turn/completed` 都从 app-server 通知归一化，只有原生 final 阶段成为正式回答。

### 5.3 Claude Code 控制

Claude Code 以 `--input-format stream-json --output-format stream-json` 的长 stdin/stdout 进程运行，工作区作为 cwd，HOME、settings 和环境来自当前 Binding。新 session 写入第一条 user frame；继续会话以 `--resume <session-id>` 启动进程后写入新 frame。工作区改变时，在目标 cwd 启动新进程并 resume 同一个 session；旧 cwd 的空闲预热进程不复用。运行中追加先向同一进程写原生 control interrupt，再写下一条 user frame，并用排队回合计数确保中间 `result` 不会提前结束整个 Task。终止先发送 control interrupt，失败时只对保存的受管 PID 依次使用有界的 `SIGINT`、`SIGTERM` 和 `SIGKILL`，每一步都确认进程是否退出。stream event、assistant 快照、tool result、control request 和 terminal result 共同决定事件及终态。若进程在 terminal result 前退出，运行层返回带退出码、信号和已脱敏 stderr 的 `AGENT_PROCESS_EXITED_WITHOUT_RESULT`，不再用无诊断的通用流结束错误代替原生失败原因。

### 5.4 OpenCode 控制

OpenCode 为每个 Binding 启动只监听远端 loopback 的 detached `opencode serve`，并把 PID、确定端口、协议版本、运行指纹和 session ID 写入 `state/active.json`。SSH exec 通道释放后，后端通过 HTTP 提交 session 操作，通过 SSE 接收事件；复用服务前同时检查进程、health、模型目录和运行指纹。当前新 Binding 使用 V1：新建为 `POST /session`，普通输入为 `prompt_async`，Skill 调用走 session command，终止为 `abort`，完成以目标 session 的 idle 及消息终态共同确认。已有 V2 Binding 固定使用自己的 `/api/session` 协议，不在运行中跨协议解释 session。切换工作区先调用 `/experimental/control-plane/move-session` 把同一 session 指向目标目录，再订阅事件和提交 prompt；原生拒绝移动时才建立新 session 并由 Context Hub 补齐正文。V1 活动 run 不支持真正 steer，因此追加时先 abort 并确认 idle，再在同一 session 提交下一轮；新的 EasyWork run ID 隔离旧事件的迟到终态。

### 5.5 Qoder CN 控制与登录

Qoder CN 使用官方 `qoderclicn` 可执行文件和 `QODERCN_CONFIG_DIR`。它不读取 EasyWork 模型 API 路由；登录后，网页通过 Qoder Agent SDK 原生 control protocol 读取当前账号的模型目录、Credits 倍率、原生上下文档位和积分配额。所选模型、上下文容量、思考强度和权限模式写入 Binding 隔离的原生 settings，并传给 CLI；压缩调用原生 `/compact`。服务器级账号凭据固定在 `~/.easywork/accounts/qodercncli/.auth/`，每个 Binding 的 `data/qoder-cn/.auth` 只链接到该凭据目录；settings、session project store、Skill 和其他运行数据仍按 Binding 隔离。卸载或升级托管二进制不删除账号凭据。

部署完成后，后端用 `qoderclicn status -o json` 读取 `logged_in`。未登录时 Agent 仍可被选中和配置，但输入框禁用，Agent 一级菜单原部署位置显示“登录”；已登录时按钮消失。用户点击登录后，浏览器先同步建立空白新标签页，后端在该服务器的账号目录执行原生 `qoderclicn login`，禁止远端自行打开浏览器，捕获 CLI 输出的官方 HTTP(S) 授权地址并把新标签页导航过去。页面轮询原生 status；授权完成后刷新 Agent 状态。EasyWork 不接收账号密码、令牌或 API Key，也不代理 Qoder 登录表单。

对话运行使用 `--print --input-format stream-json --output-format stream-json --include-partial-messages --permission-prompt-tool stdio`。新会话写入原生 user frame；已有会话以 `--resume <session-id>` 恢复。运行中追加向同一 stdin 发送带 `priority:"now"` 的 user frame，原生协议自行处理即时追问，不制造额外中断回合。工作区改变时，在目标 cwd 启动新进程并 resume 同一个 session；稳定 Binding 的 Qoder project store 继续指向原 native-store owner，因此会话身份和 transcript 连续，配置与 Skill 视图仍属于该 Binding。显式网页分支使用 `--fork-session --session-id --resume-session-at`；回溯和重新生成使用 `--resume <当前 session> --resume-session-at <保留边界>`，不创建新 Qoder session。该边界读取 Qoder transcript 的最新 `active-leaf.leafUuid`，并验证它对应同文件中的 assistant 记录；`last-prompt` 和 stream-json `assistant.uuid` 均不能替代。Qoder 进程在 terminal result 前退出时使用与 Claude Code 相同的带退出码、信号和脱敏 stderr 的明确诊断。

Qoder 原生模型目录使用 SDK `1.0.41` 的 `initialize`、`get_models` 和 `get_usage_info`。后端合并并发探测并缓存 30 秒；前端以 Actor、服务器和 Qoder 账号域为稳定键先显示最近目录，5 分钟内直接复用，超过后在打开菜单时刷新，缓存最长保留 30 天。旧版按 Qoder 安装版本保存的缓存会迁移到稳定键，因此 Agent 扫描或升级不会短暂退回 `qmodel_*` 内部 ID。目录项带模型 ID、显示名、Credits 倍率、上下文档位和可选促销信息；旧配置缺少 model 时统一解释为原生 `auto`。套餐、附加和组织资源配额分栏显示，不自行求和；组织资源包仅在 `available: true` 时显示，`cap: -1` 等负数哨兵不作为额度。

### 5.6 网页配置与作业提交

四种 Agent 都在二级菜单提供模型选择。OpenCode、Codex 和 Claude Code 从 EasyWork provider 目录选模型，并保留“打开配置”；Qoder CN 从登录账号的原生目录选模型，不显示“打开配置”。四者的模型、上下文容量、思考强度和权限配置都按 Actor、服务器、网页对话配置域和 Agent 缓存，最大年龄 30 天。服务器较高 revision 覆盖旧快照；保存时若遇到 revision 冲突，只重读权威配置并重放本次用户编辑，不能用旧快照覆盖其他标签页或原生 effort 自动调整。

四种适配器最终都把 shell 执行的结构化命令与对应工具结果交给统一提交检测器。只有直接执行 `sbatch` 且出现可验证成功回执才创建持久作业记录；`squeue`/`sacct` 查询、文件内容、历史消息和 Agent 的自然语言总结不能补录。提交后由后台跟踪器直接查询调度器并持久化终态，浏览器是否在线、用户是否再次打开算力面板都不影响跟踪。

## 6. Context、收据与增量交付

Context Hub 保存准备交给某个精确原生会话的语义资料和交付收据。语义键与内容版本共同判断“该会话是否已经知道”；session 缺失、换绑或新上下文代次不能沿用旧收据。

交付内容包括网页 Agent 选择的记忆、文件正文和对话引用资料，用户显式选择的 Skill 和文件，后端强制启用且当前 Binding 缺少的 Skill，切换原生会话时缺少的网页正文历史，以及当前用户原始请求。对话引用资料由冻结来源中的相关记忆、最近完整回合或语义命中的较早完整回合组成；它们以历史资料交付，不能改变当前请求和远端执行边界。

收据只避免重复交付同一版本，不表示内容永远正确。资料版本变化、用户明确要求重新读取或原生会话改变时应重新交付。推理和工具日志不进入收据。

## 7. Skill 安装与原生使用

用户技能库只保存当前安装的独立副本，不设技能版本选择、历史包或 Task 版本锁定。市场条目后续编辑、更新或删除不会改变已安装的正文、附件、发现简介和个人适用范围；用户编辑、更新或重新安装后，后续读取和部署直接使用当前内容。旧索引迁移只保留用户原先正在使用的内容，正文、附件及适用范围保持不变。

远端服务器级包缓存按账号和内容摘要保存不可变包。每个 Binding 从固定包建立自己的可写文件代次，`skills/` 只指向该 Binding 的副本。分支在明确边界继承自己的 Skill 快照，分支之后的修改互不影响。

“用户库已安装”“远端包已部署”和“本轮已经调用”是三个不同事实。把文件放入 `skills/` 只完成发现准备，不能替代原生调用。

| Agent | 发现方式 | 本轮使用方式 |
| --- | --- | --- |
| Codex | 将当前 Binding 的 `skills/` 注册为额外技能根，并刷新原生技能目录 | 在原生 turn input 中加入选中 Skill 的 skill input |
| Claude Code | 将当前 Binding 的技能视图接入隔离配置，并生成只包含本轮选中项的原生命令入口 | 在本轮 stream-json 用户输入中调用该命令，展开真实 Skill 内容 |
| OpenCode | 将当前 Binding 的技能视图接入隔离配置，并由当前版本的命令目录确认可发现 | 通过原生 session command 调用本轮选中命令和参数 |
| Qoder CN | 将当前 Binding 的技能视图接入 `QODERCN_CONFIG_DIR/skills`，并启用 `.agents` 技能目录加载 | 在本轮 stream-json 用户输入中调用只包含本轮选中项的原生命令入口 |

用户手动选择的 Skill 使用技能库当前内容部署并执行原生调用。强制 Skill 和网页按需选择的 Skill 都按当前 Binding 已部署的技能 ID 判断是否需要补齐，已存在则保留该 Binding 的可写副本并直接复用。网页 Agent 的目录和工具结果会明确提示“之前已发送”，不会再将其作为新的交接材料；用户在输入栏明确重新附加技能时仍可重新部署和调用。普通工作区切换、网页刷新或网关重启不会丢失已发送状态；新 Binding 则依据自身已有文件判断。

## 8. 用户文件投递

Work 中用户手动添加的文件以真实文件交给远端 Agent，不先由网页 Agent 总结，也不把解析文本伪装成文件。

后端先固定当前消息所选择的文件版本并重新校验权限，再把内容写入当前 Binding 的 `files/`：

~~~text
~/.easywork/runtime/agents/<agent>/<binding>/files/
  objects/<sha256>/<filename>
  turns/<message-id>/<filename>
~~~

相同内容复用 `objects/` 中的只读对象；`turns/` 保留本轮消息和文件名边界，避免同名文件互相覆盖。远端交接向 Agent 给出本轮稳定路径和原始文件名。Agent 通过普通文件系统读取，因此四种 Agent 使用同一机制，不依赖互不一致的附件 API。

文件写入、内容校验或权限校验失败时，本轮 Task 在启动前明确失败，不能只发送简介继续执行。文件不复制到用户工作区；Agent 如需修改，应按任务目标写入工作区中的目标路径。

Binding 删除时一并回收 `files/`。网页分支、切换 Agent/服务器或进入新上下文代次后，不能假定旧提示词中的路径仍可用；本轮需要的显式文件必须在目标 Binding 中拥有自己的可读视图。普通工作区切换沿用同一 Binding，但每轮仍重新校验用户所选文件版本与权限。

### 8.1 图片成果与前端预览

用户上传图片供网页 Agent 直接识图，但远端接收原文件的机制不变。远端图片成果沿用 Artifact 登记及下载链接，前端把对应图片链接渲染为可放大的图片卡片；同一成果的重复图片引用不会再渲染多张卡片。

缩略图由 `POST /api/previews` 的 `variant: "thumbnail"` 请求按需生成，只支持图片 Artifact。首次需要读取并校验远端原图，原图上限 32 MiB、像素上限 8000 万；按方向旋转后等比例缩放到不超过 720 × 720，保存为 WebP。缩略图按当前成果版本及原图摘要校验，持久保存在主机的 Actor 隔离目录，同一图片的并发生成合并执行。

成功缓存后，刷新网页或 SSH 断开仍可读取该缩略图；未缓存过的图片仍需要连接远端才能生成。放大时先显示已有预览，再尝试读取原图，失败时保留预览并提供重试。下载原图仍走原有授权、完整性校验及远端读取流程。连接恢复、绑定变化、网络恢复或页面重新可见时，尚未成功加载的图片会自动重试；删除成果时一并清理缩略图缓存。

## 9. 工作区文件版本账本

EasyWork 的工作区版本账本保存远端 Agent 写入前后的路径状态，并使用内容寻址对象保存可恢复内容。它只覆盖实际命中的受管写操作，不在普通 Task 开始时扫描或复制整个工作区。

文件写前 Hook 根据原生工具的结构化输入、真实工作目录和可证明的路径捕获 before 状态。同一路径一轮采用最早的 before；Task 结束后捕获 after 并提交版本边界。无法证明目标路径时不猜测，运行事件也不能替代已经缺失的 before 内容。

多个网页对话可以指向同一真实工作区，因此会看到彼此已经落盘的文件。普通运行读取当前现场；只有用户显式执行分支、回溯、重新生成或版本恢复时才物化历史 checkpoint。

显式恢复先比较现场指纹。现场被用户或其他程序改动且无法证明等于已知边界时停止并报告冲突；多路径恢复先全量预检，再原子应用或补偿。

## 10. 分支、回溯与重新生成

网页分支同时建立新的网页消息分支、独立 Binding、Context 收据和文件版本域。分叉点以前的不可变对象可以共享，分叉后的原生会话、Skill 副本、用户文件视图和收据彼此独立。

若原生 Agent 提供可验证的 fork，EasyWork 在精确 turn 边界调用它；已由原生 fork 继承的消息不重复发送。缺少可靠边界时建立新上下文代次，并按允许范围重新交付网页正文和语义资料。

回溯和重新生成同时协调网页消息、原生会话、Context 收据与工作区版本。重新生成不是分支：Codex/OpenCode 调用各自原地 revert；Claude Code/Qoder CN 在当前 session 上以精确 `resume-session-at` 边界继续，并重新提交原用户消息。原生操作成功时不会创建新的 thread/session；“创建分支”才调用原生 fork。恢复点必须属于最新保留的网页 Agent Task；若该 Task 没有可验证 checkpoint，不得向前寻找更老边界。若边界不可验证或原生回退失败，EasyWork 不把 fork 冒充重新生成，而是推进 `contextEpoch`，让下一轮在干净的新原生会话中按收据重建允许的上下文。工作区只恢复账本记录且通过冲突检查的路径。

若被重试或移除的消息尚未创建远端 Task，则没有需要回退的远端执行，后端直接跳过 SSH、工作区和原生会话回退，继续网页响应流程。

Skill 快照以实际 Binding 副本为准。分支继承分叉边界已有技能，之后双方修改互不影响。用户投递文件属于 Binding 私有数据；需要在新分支继续使用时，依据冻结文件版本在新 Binding 重建视图。

## 11. 删除、恢复与故障收敛

用户在确认框点击删除后，前端立即关闭弹窗，只从 bootstrap、侧栏和项目对话缓存移除该对话；如果当前正打开它，则返回首页。这个乐观事件不会触发整份前端状态重新加载。后台随后读取对话最新 revision 并提交持久删除；自动标题等并发更新不会让删除使用过期 revision。若后端已返回 `CONVERSATION_NOT_FOUND`，删除视为完成；其他错误会用最新可得摘要把同一对话恢复到列表并显示失败原因。

后端先提交对话 tombstone、登记可恢复清理事务并解除所有服务器 Binding，再让持久后台队列清理原生会话、运行目录、Task、Skill、用户投递文件、Context/记忆收据和版本引用。网关重启后会恢复未完成事务；尚未真正提交 tombstone 的预备记录不能删除任何状态。其他分支仍引用的不可变对象保留；用户真实工作区不属于删除目标。

Task、原生运行身份、事件、收据、写前 manifest 和删除计划必须持久化。浏览器刷新、关闭、换设备或网关重启只影响订阅，不应取消仍在运行的远端进程。

原生协议明确完成后立即收敛 Task；事件中断时依据可验证的进程和会话状态恢复。网络故障不能静默新建会话并重跑可能有副作用的请求。无法证明可安全继续时，保留现场并返回明确错误。
