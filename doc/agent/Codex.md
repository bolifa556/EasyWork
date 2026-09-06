# Codex 适配说明

本文记录当前 Codex CLI/app-server 适配的实际协议面，供 Codex 升级后核对 EasyWork 行为。通用 binding、上下文、文件账本和删除机制见 [远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)。

## 1. 当前基线与源码

- EasyWork Agent ID：`codex`
- 托管包 ID：`codex`
- Manifest 基线：`0.149.1`
- 进程入口：`codex app-server`
- 统一协议名：`codex-app-server-jsonrpc`
- 适配器：`gateway/core/agents/codex.mjs`
- 运行传输：`gateway/core/agent-runtime/transport.mjs`
- 配置：`gateway/core/agent-runtime/configuration.mjs`
- 托管制品：`agent-app/manifest.json`

Manifest 是版本和制品校验的权威来源。当前 Linux glibc/musl 标签均使用对应架构的 musl release 制品，实际文件名与哈希以 Manifest 为准。

## 2. 进程、初始化与 thread 装载

每个逻辑 binding 使用自己的 app-server 进程。进程以 binding 的隔离环境启动：

```text
codex app-server -c <process-scoped configuration> ...
```

建立 JSON-RPC 通道后必须先完成：

```json
{"method":"initialize","params":{"clientInfo":{"name":"easywork","title":"EasyWork","version":"2"},"capabilities":{"experimentalApi":true}}}
```

随后发送 `initialized` notification。初始化失败被归类为当前实际版本不具备 EasyWork 所需 app-server 协议，不能退回文本 CLI 后假装拥有等价事件。

Codex thread 持久在 `CODEX_HOME` 原生 store 中，但“磁盘上有 thread”和“当前 app-server 已加载 thread”是两回事。每个进程维护自己的 `loadedThreadIds`：

- 新 thread 由 `thread/start` 装载；
- app-server 重启后，已有 thread 在下一次操作前先 `thread/resume`；
- 这个集合随进程销毁，不跨进程臆测；
- 只有 native store、运行指纹和 binding 都匹配时才复用进程。

网页分支可以让父子 binding 的 app-server 指向同一 Codex 原生 store，因为 thread 本身彼此独立。模型、权限、沙箱和 provider 路由通过进程级 `-c` 高优先级配置提供，避免两个网页分支竞争修改共享 `config.toml`。

## 3. 配置与运行参数

网页配置字段为：

| 字段 | 原生含义 | 缺省值 |
| --- | --- | --- |
| `model` | 当前 turn model | 由模型路由提供 |
| `contextLimit` | `model_auto_compact_token_limit` | `200000` |
| `reasoningEffort` | `model_reasoning_effort` | `medium` |
| `approvalPolicy` | `approval_policy` | `never` |
| `sandboxMode` | `sandbox_mode` | `auto` |

`sandboxMode=auto` 不只检查 `bwrap` 是否存在，而是在服务器上执行一个最小隔离进程。可用时选择 `workspace-write`；用户 namespace 或 bwrap 不可用时选择 `danger-full-access`，使 HPC/login 节点不会在 turn 开始前因无效沙箱配置失败。显式选择的 `read-only`、`workspace-write` 或 `danger-full-access` 保持用户设置。

Codex 会把上一个 model 和 reasoning effort 持久到 native thread。因此 EasyWork 不仅在 app-server 启动时传配置，还在每次新的 `turn/start` 明确发送当前 model/effort，使用户切换配置后可以继续同一 thread。活动 turn 中不会替换 app-server；配置指纹变化只让下一次 start/resume 重建进程。

思考强度遭原生模型明确拒绝时，统一适配器至多在无正文、无工具副作用、无 append 的前提下重试一次，并以 compare-and-set 更新该网页对话的 `reasoningEffort`。

## 4. 原生操作映射

| EasyWork 操作 | Codex app-server 调用 |
| --- | --- |
| 新建会话 | `thread/start {cwd, historyMode:"paginated"}`，随后 `turn/start` |
| 已有会话继续 | 必要时 `thread/resume`，随后 `turn/start` |
| 运行中追加 | `turn/steer {threadId, expectedTurnId, input}` |
| 终止 | `turn/interrupt {threadId, turnId}` |
| 压缩 | `thread/compact/start {threadId}` |
| 分支 | `thread/fork {threadId, path?, lastTurnId?\|beforeTurnId?, cwd?, excludeTurns:true}` |
| 回退 | `thread/revert {threadId, beforeTurnId}` |
| 上下文用量 | 原生 token usage 事件缓存 |
| 审批 | 对原生 server request 发送 JSON-RPC response |
| 用户输入 | 对 requestUserInput/MCP elicitation 发送 JSON-RPC response |

回退的线级请求是：

```json
{"method":"thread/revert","params":{"threadId":"...","beforeTurnId":"..."}}
```

新 thread 固定使用 `historyMode: "paginated"`，因为当前 app-server 只有这种历史模式可以支持后续 `thread/revert`。`thread/fork` 的 `lastTurnId` 与 `beforeTurnId` 互斥；`excludeTurns: true` 让边界由 EasyWork 明确提供，而不是让 Codex 自动附加来源尾部回合。

## 5. 运行中追问与终止

运行中追问使用原生 `turn/steer`，并携带当前 `expectedTurnId`，防止用户消息被送到已经结束或另一条 turn。追问直接进入 Codex，不经过网页 Agent。

存在一个正常竞态：页面仍在排空上一 turn 的终态事件时，Codex 已经关闭 steer 窗口。仅当 app-server 返回可识别的“steer window closed”错误时，EasyWork 才在同一 thread 上调用 `turn/start`，并复用/重定位当前 thread 事件作用域；不会创建新 thread，也不会重新组装网页上下文。其他 `turn/steer` 错误原样失败。

终止必须命中当前 app-server 进程、thread 和 turn。进程不存在时，append、interrupt、approval 和 input 都返回原生进程不可用，不能另起 app-server 后向不确定的活动 turn 发控制命令。

## 6. Skill 适配

Codex 不通过共享 `CODEX_HOME` 自动发现 EasyWork Skill。原因是网页父子分支可能共享原生 store，如果把 Skill 放入全局发现目录，会把一个 binding 的 Skill 泄漏给另一个 binding。

个人包固定、SSH 上传校验、远端缓存与对话自有副本的完整目录关系，见[远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)第 7.1 节。Codex 不生成 `easywork-selected` 组合命令，直接使用各技能的原生入口。

app-server 初始化后调用 `skills/extraRoots/set`，以 `extraRoots: [<binding-skills-root>]` 注册当前 binding 的 Skill 根。每次选用技能的 `turn/start` 前，调用 `skills/list`，传入 `cwds: [<当前工作区>]` 和 `forceReload: true`，确认入口已经被原生发现且解析路径仍位于当前 binding 内；没有发现时明确失败，不把“目录已部署”当成“技能已加载”。本轮选中的 Skill 使用发现结果返回的名称与路径作为原生 input item 加入；路径可以是当前视图入口，也可以是其解析后的自有文件代次：

```json
{"type":"skill","name":"<discovered-native-skill-name>","path":"<discovered-binding-skill-path>/SKILL.md"}
```

同一 input 中按 path 去重。包缓存按用户和内容摘要隔离，binding 拥有自己的文件副本；目录指针不指向共享缓存。同版 pin 只免除重复复制，不免除本轮显式 Skill input：用户再次需要同一技能时仍调用该技能，保留当前 binding 副本中的内容。分支从所选 Task 的实际技能快照建立独立副本。

上游选择有三种来源：网页 Agent 选择、用户显式附加、Work 设置中的强制启用。模式和服务器范围先由 EasyWork 过滤；强制项在切换远端绑定后的首次提问由后端检查安装记录，只补齐缺少的版本，后续连续提问复用检查结果；不交给网页模型读取或批准。实际补发项与其他本轮选中项共用上述原生 input item 和版本收据。

## 7. 文件写前 Hook

Codex 使用 app-server 暴露的 Hook 发现与信任接口验证 EasyWork pre-tool hook。

进程启动后，EasyWork 对当前 cwd 调用：

```text
hooks/list {cwds:[cwd]}
```

只接受一个完全匹配的 Hook：

- event name 是当前已知的 `preToolUse` 或 `pre_tool_use`；
- handler 类型为 command；
- `sourcePath` 精确指向该 native store 的 `codex/config.toml`；
- command、status message、enabled 状态和 managed 标记精确匹配；
- `currentHash` 必须是合法 SHA-256。

若 Hook 尚未受信，只通过：

```text
config/batchWrite
```

写入该 Hook key 的精确 `trusted_hash`，再调用 `hooks/list` 复验。不会对请求开启广义 hook trust bypass，也不会顺便信任用户其他 Hook。每个 native session 还会绑定当前 Task ID，使并行 app-server 事件写入正确的 Task manifest。

托管基线缺失或无法信任这条 Hook 会阻止运行。用户显式选择的 Codex 版本若 app-server 早于 Hook discovery，可以继续执行 Agent 功能，但会产生可见兼容性提示，明确该版本的文件修改无法保证完整回溯。

## 8. 事件归一化

Codex app-server 的 thread、turn、item、usage 和 server request 都经过 `codex.mjs` reducer。主要投影包括：

- `thread/started`、`turn/started`、`turn/completed`：session/turn 生命周期；
- item started/completed/delta：稳定 item 生命周期；
- `agentMessage`：助手正文；只有原生 `final_answer` 阶段生成 EasyWork final，`commentary`/async 文本保留为中间活动；
- reasoning summary/text：思考活动；
- command execution、file change/patch、MCP/dynamic tool、协作/子 Agent、sleep、image、web search、review、compaction：对应工具、artifact、状态或文件事件；
- `turn/plan/updated`：唯一的 Todo/计划来源；
- token usage：当前请求上下文用量和累计 billing 分开保存；
- approval、permissions、requestUserInput、MCP elicitation：统一交互请求；
- model reroute、safety、verification、Hook 或兼容性通知：状态/错误信息。

相邻 message、reasoning、plan 和 command output delta 在原始 JSONL 队列前合并。除已适配的交互请求和 `currentTime/read` 外，未知 server request 返回 JSON-RPC `-32601`，不能自动批准；未知 notification 则形成兼容性事件，避免协议新增字段被静默吞掉。

作业提交记录消费同一执行的原生 `item/completed` → `commandExecution`：归一化结果携带 `command` 与 `aggregatedOutput`，终态 `tool_result` 的命令及输出进入统一提交检测器。仅直接 `sbatch` 执行和对应成功回执形成持久提交记录，不扫描旧对话、不采纳 Agent 的查询结果或自然语言总结。成功回执写入账本后，由三种 Agent 共用的后台跟踪器直接查询调度器并持久化终态，不依赖 Codex 后续查询或用户打开算力面板；断线、重连和查询失败边界统一处理。该能力不向 Codex 添加提示词，也不更改原生工具参数。具体识别与跟踪边界见《SSH机制》的提交历史章节。

EasyWork 的 Todo 完全跟随 `turn/plan/updated`，不从普通 assistant Markdown 中解析。`result.usage` 一类累计计费值不覆盖当前 context-window 占用。

## 9. 原生分支、回退与重新生成

Context checkpoint 保存 Codex `threadId`、精确 `turnId` 和 rollout `path`。只有来源 Task 已完成且边界齐全时，上层才调用 `thread/fork`。返回的新 thread ID 和 path 写入目标 binding；原生 thread 已继承的消息前缀在目标 Context receipt 中登记为别名，因此网页历史不重发。

回溯使用 `thread/revert` 原地把来源 thread 截到 `beforeTurnId`。EasyWork 随后协调文件账本恢复和 receipt checkpoint；任一步骤无法证明一致时不会改写 rollout 私有文件，而是让上层推进 `contextEpoch`，下一回合以新 thread 重新评估上下文。

重新生成沿用同一机制：先恢复目标用户消息之前的原生和文件边界，再用原始用户消息创建新 Task。原生 thread 分支和 EasyWork 文件 checkpoint 是两个独立结果，必须都成功或明确进入降级路径。

## 10. 兼容性与升级敏感面

当前实现依赖的易变协议面包括：app-server initialize handshake、`thread/*` 与 `turn/*` 请求参数、paginated history 的 revert 能力、fork 返回的 thread/path、turn steer 的关闭错误、item 类型和 final phase、token usage 形状、approval/input server request、Skill input item、Hook list/trust schema 及 pre-tool event 名称。

用户版本允许对非核心 Hook 能力给出显式降级；托管基线必须满足完整合同。任何升级都不能通过读取或改写 Codex rollout 私有 JSONL 来模拟 thread 操作，原生接口不可用时应保留真实失败并由 EasyWork 上层换绑。
