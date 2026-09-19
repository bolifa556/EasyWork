# Claude Code 适配说明

本文记录当前 Claude Code stream-json 适配的实际协议面，供 Claude Code 升级后核对 EasyWork 行为。通用 binding、上下文、文件账本和删除机制见 [远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)。

## 1. 当前基线与源码

- EasyWork Agent ID：`claude-code`
- 托管包 ID：`claudecode`
- Manifest 基线：`2.1.269`
- CentOS/RHEL 7（glibc 2.17）兼容基线：`2.1.170`
- 进程入口：`claude`
- 统一协议名：`claude-code-stream-json`
- 适配器：`gateway/core/agents/claude-code.mjs`
- 运行传输：`gateway/core/agent-runtime/transport.mjs`
- 配置：`gateway/core/agent-runtime/configuration.mjs`
- 托管制品：`agent-app/manifest.json`

Claude Code 托管制品是按平台下载的 raw binary，不是 tar archive。版本、大小和 SHA-256 仍只以 Manifest 为准。主版本 `2.1.269` 覆盖 Linux x64/arm64 的 glibc 与 musl；清单另外固定[官方 `2.1.170` 制品](https://downloads.claude.ai/claude-code-releases/2.1.170/manifest.json)，专供 glibc 不高于 2.17 的旧 x64 主机。[上游 issue #69980](https://github.com/anthropics/claude-code/issues/69980) 已记录 `2.1.176` 在 RHEL/CentOS 7、glibc 2.17 上触发 SIGILL 的运行时回归，并确认同一主机上的 `2.1.170` 可运行；本次 scnet 实测中 `2.1.269` 还会在第一条 stream-json 事件前持续占用 CPU，而 `2.1.170` 能正常进入模型请求。部署器实际探测远端 OS、架构和 libc 后选择制品，并把兼容选择写入托管状态；主机升级到较新 glibc 后会自动回到清单主版本。更新器的 `--locked`、`--check` 和 `--latest` 都保留并处理这份兼容条目，因此它仍是完整可复现的清单内容，而不是远端运行时自行降级。

## 2. 进程与 stream-json 合同

标准启动参数为：

```text
-p
--input-format stream-json
--output-format stream-json
--verbose
--include-partial-messages
--permission-prompt-tool stdio
--disallowedTools CronCreate,CronDelete,CronList
```

EasyWork 通过 stdin 连续发送 JSON frame，从 stdout 接收 JSONL。工作区是进程 cwd，环境和 settings 来自当前 binding。预热可以提前启动一个等待输入的进程，但不能发送占位 user frame、创建占位 session 或产生原生回合。

新会话直接发送第一条 user frame；已有 session 在进程参数中加入 `--resume <session-id>`。运行中的追问写入同一进程；自然完成后的后续 Task 可以启动新进程并 resume 同一 session。进程 PID、session、原生 turn 边界和运行指纹记录在 binding runtime 中。

Claude Code 没有修改一个活动进程 cwd 的控制帧。同一服务器和网页分支内切换工作区时，EasyWork 结束或丢弃旧工作区的空闲预热进程，在目标目录作为 cwd 启动新进程，并使用 `--resume <同一 session-id>` 继续原生会话。预热进程只有运行指纹、cwd 和 native store 都一致时才复用；工作区变化不会产生新 session，也不会复制 transcript。

用户安装会按“二进制路径 + 实际版本”缓存一次 `claude --help` 能力探测：

- `-p/--print`、`--input-format`、`--output-format` 是 stream-json 核心能力，缺失时拒绝；
- `--resume` 在需要恢复时缺失会拒绝；
- `--include-partial-messages`、`--permission-prompt-tool`、`--verbose`、`--settings`、`--model`、`--effort`、`--permission-mode` 属于可探测参数，用户版本缺失时移除该参数并发出兼容性信息；
- 托管基线直接按完整合同运行。

能力探测不是每回合执行。已缓存的结果只在二进制路径或实际版本变化时失效。

## 3. 配置、环境与 Skill

网页配置字段为：

| 字段 | 原生含义 | 缺省值 |
| --- | --- | --- |
| `model` | `--model`/settings model | 由模型路由提供 |
| `contextLimit` | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `200000` |
| `effortLevel` | `--effort` 与 `CLAUDE_CODE_EFFORT_LEVEL` | `medium` |
| `permissionMode` | `--permission-mode`/settings permissions | `acceptEdits` |

支持的思考档位为 `low`、`medium`、`high`、`xhigh`、`max`；权限模式为 `default`、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`。

绑定目录中的 `claude/settings.json` 写入 model、effort、默认权限、`autoMemoryEnabled: false` 和 EasyWork `PreToolUse` Hook。进程同时显式传相应 CLI 参数，并设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`：EasyWork 的长期记忆由网页层统一提取和隔离，Claude Code 原生 auto memory 不应跨网页项目另建第二套记忆，也不应尝试写入 binding 控制目录。`CLAUDE_CODE_EFFORT_LEVEL` 的原生优先级最高，所以 EasyWork 将当前实际 effort 同步写入环境，避免旧 settings 覆盖本轮适配值。自动压缩窗口由环境变量提供。

托管二进制只由经过 SHA-256 校验的 Agent 更新器升级。运行进程设置 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_AUTOUPDATER=1` 和 `DISABLE_UPDATES=1`，避免 Claude 自更新绕过 Manifest，也避免遥测、错误上报或后台更新在受限 HPC 登录节点阻塞第一条 stream-json 事件。模型请求仍通过当前 Binding 的 API route；用户主动要求的 WebFetch 等工具流量不由这组开关伪装成模型路由。

网页二级菜单保留 Claude Code 的“打开配置”和“选择模型”。模型仍来自 EasyWork 已配置的 provider 目录。配置快照按 Actor、服务器、网页对话配置域和 Agent 隔离，内存与浏览器缓存最多保留 30 天并优先用于首屏；服务器返回更高 revision 时覆盖旧值，保存遇到 revision 冲突时重读权威配置并只重放用户本次修改。该缓存不改变 `settings.json`、CLI 参数和环境变量的原生优先级。

Skill 包按用户和内容摘要进入不可变缓存，当前 binding 复制出自己的文件代次；`skills/` 中的指针只指向自有副本。`<runtime-data>/claude/skills` 指向这棵独立视图。本轮选中的技能正文从当前自有副本读取，组合为 `skills/easywork-selected/SKILL.md`，为每个技能保留其资源基准目录，并通过 `$ARGUMENTS` 接收本轮交接正文。包装声明 `disable-model-invocation: true`，由 EasyWork 在 stream-json user frame 中显式调用 `/easywork-selected <本轮交接正文>`，让原生命令展开技能，而不只依赖自动匹配。用户原话仍保留在交接正文中，普通补充 prompt 不另行复制 Skill 正文。即使网页分支共享来源 session 的 transcript，技能仍从分叉 Task 的文件快照复制到目标 binding，之后互不影响。

个人安装内容、SSH 上传校验、远端缓存与自有副本的完整目录关系，见[远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)第 7 节；技能文件快照与分支继承见第 10 节。生成的 `easywork-selected` 是本轮调用包装，不作为用户技能加入历史快照。

筛选包括对话模式和 Work 服务器范围。网页 Agent 选择、用户显式附加、Work 强制启用共用当前安装内容的部署链路；后两类不要求网页模型再次读取或批准。自动选择和强制项按技能 ID 复用当前 binding 已有副本，并向网页 Agent 明示已发送状态；只有尚未部署或用户本轮明确重新附加的技能才下发并调用。启动指纹覆盖待发送技能的内容摘要、视图和调用正文；需要加载新内容时不能复用未加载该内容的预热进程。模型 relay 属于 binding，旧进程退出不能关闭替代进程正在使用的 relay。

## 4. 原生操作映射

| EasyWork 操作 | Claude Code 行为 |
| --- | --- |
| start | 在本轮工作区 cwd 启动 stream-json 进程并写入 user frame；已有 session 时加 `--resume` |
| resume | 在目标工作区 cwd 以 `--resume <session>` 启动进程并写入 user frame |
| append | 在活动 stdin 先写 control interrupt，再写新的 user frame |
| interrupt | 发送 `control_request {subtype:"interrupt"}` |
| approval | 对 `can_use_tool` 等请求写 `control_response` |
| input | 对 AskUserQuestion、elicitation 或 dialog 写 `control_response` |
| compact | 在活动进程发送 user `/compact`；无活动进程时 resume 一个一次性进程 |
| contextUsage | 从当前请求的 streaming usage 或原生 context report 读取 |
| fork | 保存 native-deferred 描述，在网页分支的下一条真实消息以新 session 完成 |
| revert / 重新生成 | 保存 native-rewind-deferred 描述，在当前 session 的下一条真实消息回到保留边界 |

标准 user frame 为：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
```

审批的 `approve_session` 被转换为原生 session-scoped permission updates，并只作用于当前 Claude session；不写入共享用户配置。拒绝返回原生 deny。AskUserQuestion、MCP elicitation/form/url 和通用 dialog 分别按其原生 response 形状返回，未知 control request 不自动响应。

## 5. 运行中追问与终止

Claude Code 的 append 通过同一 stream-json stdin 完成：先发原生 control interrupt，让当前采样/工具循环停止在可续接边界，再发用户新 frame。transport 记录 queued turn 数；每个 `result` 都是一个原生回合边界，但只有 queued count 已归零的最后一个 result 才成为整个 EasyWork Task 的 final。这样追问前后的 Agent 调用分段不会一个完成、另一个仍运行。

终止先发原生 control interrupt，控制失败时对当前受管进程补发 `SIGINT`；随后对同一进程发送 `SIGTERM` 并等待最多 4 秒，仍未退出才升级 `SIGKILL` 并再确认最多 2 秒。信号式兼容路径同样有界确认退出。未确认退出时报可重试错误并保留活动状态，不能提前标记停止。不会按进程名批量终止。原生 Cron 工具被禁用，因为当前网页 Task 的结果流不负责完成后定时通知。

收到控制请求的成功回执只证明命令已接收；Task 终态仍以原生结果/进程退出和文件版本收尾为准。

若 stdout 在 terminal `result` 前结束，SSH 进程层保留最近 16 KiB stderr，transport 清除终端颜色、截取并脱敏后返回 `AGENT_PROCESS_EXITED_WITHOUT_RESULT`，同时携带退出码和信号。页面因此显示可定位的原生退出原因，而不是无上下文的 “stream ended without final event”。

## 6. 压缩与上下文用量

Claude Code 把压缩暴露为原生 `/compact` 命令，而不是独立 RPC。活动进程直接接收该 user frame；已完成进程不存在时，EasyWork 用 `--resume` 启动一次性 stream-json 进程。两条路径都先订阅输出再发送命令，并只在收到原生 `system/compact_boundary` 后确认成功。活动进程中属于此前排队回合的 `result` 会按队列计数略过；轮到压缩后若先收到无边界的终态 `result`，则立即返回原生拒绝、失败或未执行原因。流提前关闭返回不完整，90 秒内既没有边界也没有终态才返回超时；任何一种情况都不会伪装成成功。

当前 context-window 用量只接受当前请求的 streaming `message.usage`、`message_delta.usage`，或 assistant frame 的原生 `context_usage` report。终端 `result.usage` 是整个 Agent run 的累计计费用量，可能包含多次模型/工具循环，单独保存为 billing 信息；`modelUsage.contextWindow` 最多用于补齐当前请求的原生上限，不能把累计 token 冒充窗口占用。配置页显示的上限优先使用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 对应的 `contextLimit`，因此表示自动压缩计算窗口，不保证等于模型硬上限。

Claude Code 没有独立的只读 context RPC。EasyWork 读取 Binding 中最近一次经过来源校验的事件快照，不向会话注入测试消息或 `/context`。网页按 Actor、服务器、配置域、Binding 和 Agent 缓存该值，在原生 context revision 前进、菜单重新打开或压缩完成后刷新；原生会话尚未返回可验证用量时明确显示不可用。

## 7. 事件归一化

适配器处理的主要 frame 为：

- `system`：init、status、hook、compact boundary 等生命周期；
- `stream_event`：content block start/delta/stop，投影 text、thinking、tool use 和 citation；
- `assistant`：完整消息快照，用稳定 content-block ID 修正增量状态；
- `user`：tool result 回送；
- `result`：原生回合结果、费用和终态；
- `control_request`/`control_response`：审批、输入与中断控制；
- `tool_progress`：与当前 tool use 关联的 heartbeat/progress；
- `tool_use_summary`、`rate_limit_event`、`auth_status`、`prompt_suggestion`、reset/status：对应状态或兼容性事件；
- EasyWork 内部 `easywork_native_boundary` 与 effort adjustment frame：只承载已验证边界/配置调整，不伪造 Agent 文本。

原生 Todo 只从 `TodoWrite` 及 `TaskCreate`、`TaskList`、`TaskUpdate` 工具结果更新统一 `plan`。这些工具已经投影为计划后，不再重复显示为普通工具活动。进度状态和内容完全来自 Claude Code，不由 EasyWork 补写。

partial message 与快照可能重复描述同一 block；reducer 按 message/content/tool ID 合并，避免正文、thinking 或 tool result 重复。未知非交互 frame 形成兼容性信息；未知交互 frame 明确失败。

作业提交记录使用 Bash `tool_use` 的输入与 `user.tool_result` 的真实输出，通过 `tool_use_id` 关联。只有流式参数时，在 `content_block_stop` 将完整 JSON 输入保存到对应 `tool_use_id`，不依赖下一轮可能复用的内容块索引；已有原生完整工具输入时保留该输入。终态结果进入统一提交检测器，仅直接 `sbatch` 与对应成功回执形成持久提交记录，查询结果、读取到的文件和 Claude 的文字总结不补录历史。成功回执写入账本后，由四种 Agent 共用的后台跟踪器直接查询调度器并持久化终态，不依赖 Claude 后续查询或用户打开算力面板；断线、重连和查询失败边界统一处理。不向 Claude 添加记账提示词或调用其记忆能力。识别与跟踪边界见《SSH机制》的提交历史章节。

接收队列只合并同一通道相邻的增量，允许淘汰已被新事件替代的累计 `thinking_tokens` 计数；不能用 `assistant` 帧与 `stream_event` 相互替换。当前 SDK 的 `assistant` 是已完成内容块，多个不同块可以共用 `message.id`，并非整条消息的累计快照。完整工具输入、流结束和 usage 都必须保留。无独立 ID 的正文/思考完成块按该原生消息的内容块顺序关联已有流式块，不能直接把完成帧数组的 `0` 当作原流式索引，否则会重复正文或覆盖前面的思考块。此合同已对照官方 SDK `0.3.245` 的 `SDKAssistantMessage`、`SDKPartialAssistantMessage` 类型定义及[官方流式输出说明](https://code.claude.com/docs/en/agent-sdk/streaming-output)核查。

## 8. 文件写前 Hook

当前 binding 的 settings 注入：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "<easywork-version-hook>",
        "timeout": 120,
        "statusMessage": "<internal-version-status>"
      }]
    }]
  }
}
```

Hook command 指向该 binding 的受控 launcher；launcher 调用 Python 3 写入 Task/operation manifest，并根据原生工具输入捕获文件 preimage。`PreToolUse` 失败会阻止对应修改，事后 tool result 或 diff 只负责 UI/账本收尾，不能代替 before。

Claude 原生权限请求仍通过 stdio 交给用户；Hook 是独立的版本正确性屏障。两者不能合并为一个“默认允许”提示词。

## 9. 原生分支与同会话回退

Claude Code 没有在活动进程外提供一个等价的“立刻修改 session”RPC，因此分支与回退都延迟到下一条真实用户消息，但两者的会话语义不同。

显式网页分支保存来源 session、目标 session 和精确 `resumeSessionAt`，目标对话下一条真实用户消息到来时使用：

```text
--resume <source-session>
--fork-session
--session-id <target-session>
--resume-session-at <assistant-leaf-uuid>
```

回溯和重新生成保存当前 session 与保留边界，下一条真实用户消息使用：

```text
--resume <current-session>
--resume-session-at <assistant-leaf-uuid>
```

此路径不带 `--fork-session` 和 `--session-id`。网页重新生成先恢复消息、Context receipt 与工作区文件边界，再把原用户消息交给同一个 Claude session，新的回答成为该原生 transcript DAG 上的续接。`--resume-drops-turn <prompt-uuid>` 仅可在已验证被裁剪用户回合 UUID 时作为 guard。

原生边界来自 Claude transcript 中的 `last-prompt.leafUuid`。EasyWork 只读取这个紧凑字段，并验证对应 UUID 确实是一条 assistant 记录；不复制、排序或重写 JSONL transcript。内部 `easywork_native_boundary` 必须在 terminal `result` 之前进入 reducer，因为 result 后 orchestrator 会停止消费该 Task 的 frame。

边界读不到、不是合法 UUID、没有对应 assistant 或仍是上一 turn 的 UUID 时，边界置空。保存 deferred fork/revert 前还会在原生 JSONL 中复验该 assistant UUID。绝不从“最后一条看起来像回答的文本”猜一个分支或回退位置。恢复点必须属于最新保留的网页 Agent Task，不能越过缺少 checkpoint 的较新 Task 去使用更早边界。原生同会话回退因此不能安全执行时，上层推进 `contextEpoch`，下一轮在干净的新 session 中按 Context receipt 重建允许的上下文；不会改用 `--fork-session` 冒充重新生成。

显式 fork 不修改来源 session，并在下一回合得到新的目标 session；revert 和重新生成则保留当前 session。旧版 EasyWork 曾把重新生成错误保存成同 Binding 的 `pendingFork`；当前启动时会把这种状态及其 Context receipt 迁回来源 session。真正的网页分支拥有不同 Binding/native-store owner，不会被误迁移。

## 10. 思考强度兼容

EasyWork 先按网页配置启动 Claude Code。只有原生模型明确拒绝 effort，且尚无实质输出、工具副作用或运行中追加时，transport 才选择最接近且同距偏高的支持档位，缓存“provider + model + 请求档位”的结果并至多重试一次。

实际档位通过 `CLAUDE_CODE_EFFORT_LEVEL` 立即作用于重试进程，同时排队执行对话配置 compare-and-set。若用户在此期间已经改了配置，迟到的自动调整不会覆盖新值。统一 `agent_effort_adjusted` 事件负责前端说明。

## 11. 兼容性与升级敏感面

当前实现依赖的易变协议面包括：stream-json 必需参数、长期 stdin 多 user frame 行为、跨进程从新 cwd `--resume` 同一 session、control interrupt/approval/input 请求形状、partial/snapshot/result 事件关系、result 是否保持进程存活、`compact_boundary` 必须先于压缩 result、当前请求 usage 与 assistant `context_usage` 字段、Todo/Task 工具结果、settings Hook schema、`last-prompt.leafUuid` 与 `--resume-session-at` 契约、fork-session/session-id 参数。

可选 CLI flag 缺失可以显式降级；stream-json、resume、精确 final 或原生分支边界缺失时不能用 transcript 文本拼接来模拟原生能力。托管基线必须满足完整合同。
