# Claude Code 适配说明

本文记录当前 Claude Code stream-json 适配的实际协议面，供 Claude Code 升级后核对 EasyWork 行为。通用 binding、上下文、文件账本和删除机制见 [远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)。

## 1. 当前基线与源码

- EasyWork Agent ID：`claude-code`
- 托管包 ID：`claudecode`
- Manifest 基线：`2.1.245`
- 进程入口：`claude`
- 统一协议名：`claude-code-stream-json`
- 适配器：`gateway/core/agents/claude-code.mjs`
- 运行传输：`gateway/core/agent-runtime/transport.mjs`
- 配置：`gateway/core/agent-runtime/configuration.mjs`
- 托管制品：`agent-app/manifest.json`

Claude Code 托管制品是按平台下载的 raw binary，不是 tar archive。版本、大小和 SHA-256 仍只以 Manifest 为准。

## 2. 进程与 stream-json 合同

标准启动参数为：

```text
-p
--input-format stream-json
--output-format stream-json
--verbose
--include-partial-messages
--permission-prompt-tool stdio
```

EasyWork 通过 stdin 连续发送 JSON frame，从 stdout 接收 JSONL。工作区是进程 cwd，环境和 settings 来自当前 binding。预热可以提前启动一个等待输入的进程，但不能发送占位 user frame、创建占位 session 或产生原生回合。

新会话直接发送第一条 user frame；已有 session 在进程参数中加入 `--resume <session-id>`。运行中的追问写入同一进程；自然完成后的后续 Task 可以启动新进程并 resume 同一 session。进程 PID、session、原生 turn 边界和运行指纹记录在 binding runtime 中。

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

服务器级 Skill 包经筛选后链接到当前 binding 的 `skills/`；`<runtime-data>/claude/skills` 再指向这棵 binding-local 视图。Claude Code 使用原生 Skill 发现读取它，普通 prompt 不复制 Skill 正文。即使网页分支共享来源 session 的 transcript，Skill 视图仍按目标 binding 独立。

筛选包括对话模式和 Work 服务器范围。网页 Agent 选择、用户显式附加、Work 强制启用最终共用同一部署及版本收据；后两类不要求网页模型再次读取或批准。已经确认发送给当前 native session 的同版包不会重复投递。

## 4. 原生操作映射

| EasyWork 操作 | Claude Code 行为 |
| --- | --- |
| start | 启动 stream-json 进程并写入 user frame；已有 session 时加 `--resume` |
| resume | `--resume <session>` 启动进程并写入 user frame |
| append | 在活动 stdin 先写 control interrupt，再写新的 user frame |
| interrupt | 发送 `control_request {subtype:"interrupt"}` |
| approval | 对 `can_use_tool` 等请求写 `control_response` |
| input | 对 AskUserQuestion、elicitation 或 dialog 写 `control_response` |
| compact | 在活动进程发送 user `/compact`；无活动进程时 resume 一个一次性进程 |
| contextUsage | 从当前 streaming message usage 推导 |
| fork/revert | 保存 native-deferred 描述，在下一条真实消息启动时完成 |

标准 user frame 为：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
```

审批的 `approve_session` 被转换为原生 session-scoped permission updates，并只作用于当前 Claude session；不写入共享用户配置。拒绝返回原生 deny。AskUserQuestion、MCP elicitation/form/url 和通用 dialog 分别按其原生 response 形状返回，未知 control request 不自动响应。

## 5. 运行中追问与终止

Claude Code 的 append 通过同一 stream-json stdin 完成：先发原生 control interrupt，让当前采样/工具循环停止在可续接边界，再发用户新 frame。transport 记录 queued turn 数；每个 `result` 都是一个原生回合边界，但只有 queued count 已归零的最后一个 result 才成为整个 EasyWork Task 的 final。这样追问前后的 Agent 调用分段不会一个完成、另一个仍运行。

终止优先使用原生 control interrupt。如果旧用户版本不支持、返回错误或未能结束，则只对当前 binding 已验证的进程句柄升级：先 `SIGINT`，再有界等待 `SIGTERM`，最后才 `SIGKILL`。不会按进程名批量终止，也不会影响另一个网页对话的 Claude 进程。

收到控制请求的成功回执只证明命令已接收；Task 终态仍以原生结果/进程退出和文件版本收尾为准。

## 6. 压缩与上下文用量

Claude Code 把压缩暴露为原生 `/compact` 命令，而不是独立 RPC。活动进程直接接收该 user frame；已完成进程不存在时，EasyWork 用 `--resume` 启动一次性 stream-json 进程，等待原生 `compact_boundary`，然后停止该进程。超时或缺少边界不会标记为压缩成功。

当前 context-window 用量只取 streaming `message.usage` 与 `message_delta.usage`。终端 `result.usage` 是整个 Agent run 的累计计费用量，可能包含多次模型/工具循环，单独保存为 billing 信息，不覆盖当前请求上下文占用。

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

作业提交记录使用 Bash `tool_use` 的输入与 `user.tool_result` 的真实输出，通过 `tool_use_id` 关联。只有流式参数时，在 `content_block_stop` 将完整 JSON 输入保存到对应 `tool_use_id`，不依赖下一轮可能复用的内容块索引；已有原生完整工具输入时保留该输入。终态结果进入统一提交检测器，仅直接 `sbatch` 与对应成功回执形成持久提交记录，查询结果、读取到的文件和 Claude 的文字总结不补录历史。成功回执写入账本后，由三种 Agent 共用的后台跟踪器直接查询调度器并持久化终态，不依赖 Claude 后续查询或用户打开算力面板；断线、重连和查询失败边界统一处理。不向 Claude 添加记账提示词或调用其记忆能力。识别与跟踪边界见《SSH机制》的提交历史章节。

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

## 9. Native-deferred 分支与回退

Claude Code 没有在活动进程外提供一个等价的“立刻 fork/revert session”RPC。适配器把 `fork` 和 `revert` 声明为 `native-deferred`：网页操作时持久保存来源 session、目标 session 和精确 `resumeSessionAt`；目标对话下一条真实用户消息到来时，以以下参数启动：

```text
--resume <source-session>
--fork-session
--session-id <target-session>
--resume-session-at <assistant-leaf-uuid>
```

原生边界来自 Claude transcript 中的 `last-prompt.leafUuid`。EasyWork 只读取这个紧凑字段，并验证对应 UUID 确实是一条 assistant 记录；不复制、排序或重写 JSONL transcript。内部 `easywork_native_boundary` 必须在 terminal `result` 之前进入 reducer，因为 result 后 orchestrator 会停止消费该 Task 的 frame。

边界读不到、不是合法 UUID、没有对应 assistant 或仍是上一 turn 的 UUID 时，边界置空，让上层使用新 `contextEpoch`。绝不从“最后一条看起来像回答的文本”猜一个分支位置。

fork 与 revert 对 Claude 都通过同一原生 fork-at-boundary 机制实现：它们不会修改来源 session，而是在下一回合得到新的目标 session。Context receipt 与 EasyWork 文件账本仍在网页操作时恢复/分叉到同一边界，下一次真实消息才完成 Claude 原生侧。

## 10. 思考强度兼容

EasyWork 先按网页配置启动 Claude Code。只有原生模型明确拒绝 effort，且尚无实质输出、工具副作用或运行中追加时，transport 才选择最接近且同距偏高的支持档位，缓存“provider + model + 请求档位”的结果并至多重试一次。

实际档位通过 `CLAUDE_CODE_EFFORT_LEVEL` 立即作用于重试进程，同时排队执行对话配置 compare-and-set。若用户在此期间已经改了配置，迟到的自动调整不会覆盖新值。统一 `agent_effort_adjusted` 事件负责前端说明。

## 11. 兼容性与升级敏感面

当前实现依赖的易变协议面包括：stream-json 必需参数、长期 stdin 多 user frame 行为、control interrupt/approval/input 请求形状、partial/snapshot/result 事件关系、result 是否保持进程存活、`compact_boundary`、当前请求 usage 字段、Todo/Task 工具结果、settings Hook schema、`last-prompt.leafUuid` 与 `--resume-session-at` 契约、fork-session/session-id 参数。

可选 CLI flag 缺失可以显式降级；stream-json、resume、精确 final 或原生分支边界缺失时不能用 transcript 文本拼接来模拟原生能力。托管基线必须满足完整合同。
