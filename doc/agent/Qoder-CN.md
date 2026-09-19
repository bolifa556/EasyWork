# Qoder CN CLI 适配说明

本文记录 EasyWork 对 Qoder CN CLI 的原生适配边界，供 `qoderclicn` 升级后核对。通用 Binding、网页上下文、Skill、文件投递和版本账本见[远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)。

## 1. 官方基线与安装制品

EasyWork 使用中国站 CLI：

- 运行时 Agent ID：`qoder-cn`；
- 本机制品 ID：`qodercncli`；
- 可执行文件：`qoderclicn`；
- npm 包名：`@qodercn-ai/qoderclicn`；
- 原生配置根环境变量：`QODERCN_CONFIG_DIR`；
- 默认原生配置目录：`~/.qoder-cn`。

更新器从官方中国站 Manifest `https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json` 读取 `latest`、下载地址和 SHA-256。当前固定版本为 `1.1.53`，主机制品目录保存以下五个官方包：

| EasyWork 平台 | Qoder Manifest 架构 | 用途 |
| --- | --- | --- |
| `linux-x64` | `amd64` | 现代 x86-64 glibc 主包 |
| `linux-x64` 兼容项 | `amd64-baseline` | 缺少任一优化指令集的 x86-64 glibc 主机 |
| `linux-x64-musl` | `amd64-musl` | x86-64 musl |
| `linux-arm64` | `arm64` | ARM64 glibc |
| `linux-arm64-musl` | `arm64-musl` | ARM64 musl |

现代 x64 包的选择条件来自官方安装器：`sse4_2`、`popcnt`、`avx`、`avx2`、`bmi1`、`bmi2`、`fma` 全部存在。远端部署前读取 `/proc/cpuinfo`；缺少任一项时使用同版本 baseline 包。安装包先留在主机 `agent-app/qodercncli/<version>/`，用户点击部署后才通过 SSH 上传到远端 `~/.easywork/runtime/releases/`，校验 SHA-256 后原子切换 `~/.easywork/agents/qodercncli/current`。

`agent-app/update-agent-app.ps1` 仍只负责本机制品：

```powershell
./agent-app/update-agent-app.ps1 -Latest -Agent qodercncli
./agent-app/update-agent-app.ps1 -Check -Agent qodercncli
```

脚本不连接任何 EasyWork 服务器，不部署 Agent，也不读取 Qoder 账号。

## 2. 账号登录与隔离

Qoder CN 通过用户自己的 Qoder 账号运行，不使用 EasyWork 的模型 API 配置。服务器上的账号根为：

```text
~/.easywork/accounts/qodercncli/
  .auth/
```

状态检查在这个根中执行：

```text
QODERCN_CONFIG_DIR=~/.easywork/accounts/qodercncli \
NO_BROWSER=1 \
qoderclicn status -o json
```

`logged_in: true` 是已登录的唯一权威判断。版本、文件存在或旧网页状态都不能代替原生 status。

登录入口遵循 Qoder 官方客户端的 device-login 方式。用户点击网页“登录”时：

1. 前端在点击事件内同步创建空白新标签页，避免异步请求结束后被浏览器当成弹窗拦截；
2. 后端在服务器级账号根执行 `qoderclicn login`，环境含 `BROWSER=www-browser`、`NO_BROWSER=1` 和账号根 `QODERCN_CONFIG_DIR`；
3. 后端从 CLI stdout 捕获第一条 HTTP(S) 授权地址并返回；
4. 前端把已创建的新标签页导航到该地址；
5. 前端定期调用原生 status，检测登录完成后刷新 Agent 清单。

EasyWork 不渲染或代理登录页面，不收集账号密码，不把 Qoder token 写入网页数据库。登录进程在远端等待 device flow 完成。登录 URL 读取超时或进程提前退出会返回明确错误；是否登录成功始终重新由原生 `status -o json` 证明。

每个 Binding 的 Qoder 配置仍独立：

```text
~/.easywork/runtime/agents/qoder-cn/<binding>/data/qoder-cn/
  settings.json
  skills -> <binding>/skills
  projects -> <native-store-binding>/data/qoder-cn/projects
  .auth -> ~/.easywork/accounts/qodercncli/.auth
```

只有 `.auth` 是服务器账号级共享凭据。settings、缓存、Skill、文件和运行状态不共享。升级或卸载托管二进制不删除账号根，因此重新部署不要求重复登录；删除网页对话只回收它自己的 Binding 数据。

## 3. 网页配置与原生模型目录

Qoder CN 不依赖 EasyWork 的 provider/model API route。登录后，二级 Agent 配置通过 Qoder Agent SDK 的 stdio control protocol 建立不发送用户消息、且不持久化会话的短生命周期 Query：以 SDK 版本 `1.0.41` 发送 `initialize`，再发送 `get_models`（`live`，失败时回退初始化目录和 `cache`）与 `get_usage_info`。模型名、可用状态、Credits 倍率、促销前倍率、上下文档位和账户积分均来自当前登录账号的 Qoder 原生响应，不在 EasyWork 中硬编码。

SDK Query 使用 `qodercli` auth payload 复用 `~/.easywork/accounts/qodercncli/.auth`；一次性 payload 权限为 `0600`，查询完成后立即删除。网页只收到经过边界校验的目录与配额字段，不接触登录 token。

模型目录和积分采用两级缓存。后端把同一服务器上的并发 Query 合并，并在 30 秒内复用一次原生结果；前端以 Actor、服务器和已安装 Qoder 版本为键，先显示最近缓存，再决定是否后台刷新。前端结果 5 分钟内视为新鲜，最多保留 30 天；安装版本变化会自然换键。超过新鲜期后，再次打开 Agent/配置/模型菜单会读取原生目录并只在内容变化时替换列表，因此页面不会每次打开都先清空模型，也不会在压缩后丢失目录。

当前字段为：

| 字段 | 原生参数/设置 | 缺省值 |
| --- | --- | --- |
| `model` | `--model` 与 `model.name` | `auto`；网页下拉显示账号当前可用的原生模型 |
| `contextLimit` | `--context-window` 与 `model.contextWindow` | `200000`；选模型时优先使用该模型原生默认档位 |
| `reasoningEffort` | `--reasoning-effort` | `default`，即不传覆盖值 |
| `permissionMode` | `--permission-mode` 与 `general.defaultPermissionMode` | `accept_edits` |

权限值使用当前 Qoder CLI 原生枚举：`default`、`accept_edits`、`dont_ask`、`auto`、`bypass_permissions`。设置文件同时固定：

```json
{
  "general": {
    "defaultPermissionMode": "accept_edits",
    "enableAutoUpdate": false,
    "fileCheckpointing": { "enabled": true }
  },
  "model": {
    "name": "auto",
    "contextWindow": 200000
  },
  "skills": { "loadFromAgentsDirectory": true }
}
```

实际文件还包含 EasyWork 的 `PreToolUse` 版本 Hook。托管进程关闭 Qoder 自更新和遥测入口，防止运行时绕过本机 Manifest。权限请求继续通过原生 stdio control protocol 进入网页审批；“本会话允许”只转换成 `destination: "session"`，不修改账号级或工作区级权限文件。

Agent 一级菜单的状态为：

- 未部署：显示“安装”；
- 已部署、未登录：原安装位置显示“登录”，仍可进入配置页修改权限等选项；
- 已部署、已登录：不显示登录按钮，不显示“需要配置 API”，可选择 Qoder 原生模型；
- 选中但未登录：新建和已有 Work 输入框都禁用，并提示“请先登录 Qoder CN”。

只有 Qoder CN 的“打开配置”入口被移除；OpenCode、Codex 和 Claude Code 仍保留各自入口。Qoder 上下文容量直接显示当前对话配置将物化到原生 `settings.json` 的值；模型有原生上下文档位时使用下拉选择。旧配置没有 `model` 时按 Qoder 原生 `auto` 处理，一级菜单、配置页和模型列表使用同一个有效模型 ID 与原生显示名。

网页“压缩”始终调用 Qoder 原生 `/compact`：活动进程直接发送，无活动进程时恢复同一原生 session 后发送。两条路径都只在收到原生 `system/compact_boundary` 后确认成功，并略过命令发送前已排队回合的终态；如果轮到压缩后 Qoder 以 `result` 结束却没有边界，例如对话太短、没有可压缩内容、登录/额度/模型失败或 Hook 阻止，立即把原生原因返回页面。流提前结束报告不完整，只有既无边界又无终态时才等待到 90 秒超时。压缩完成后强制刷新上下文用量，但不清空模型目录。

“当前积分”位于普通设置和卸载区之间，卸载按钮上方只有卸载区自己的分隔线。页面分别显示 `userQuota` 套餐积分和 `addOnQuota` 附加积分，不把两者自行相加；`orgResourcePackage` 只有 `available: true` 才显示。Qoder 用 `available: false`、`cap: -1` 等负数表示没有组织资源包，这些哨兵值会被过滤，不会显示成 `0 / -1 Credits`。原生没有返回可用配额字段时只显示暂时无法读取，不推算余额。

## 4. 进程与原生会话

标准启动参数为：

```text
--print
--input-format stream-json
--output-format stream-json
--include-partial-messages
--permission-prompt-tool stdio
--settings <binding>/data/qoder-cn/settings.json
--disallowed-tools CronCreate
--disallowed-tools CronDelete
--disallowed-tools CronList
```

配置模型和上下文后增加 `--model <model>` 与 `--context-window <tokens>`；配置非默认思考强度时增加 `--reasoning-effort <level>`，并按配置传 `--permission-mode <mode>`。EasyWork 不生成 provider env 文件。工作区绝对路径作为进程 cwd。

标准用户帧为：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"parent_tool_use_id":null}
```

运行中追加在同一进程写入同一形状，并增加：

```json
{"priority":"now"}
```

这是 Qoder 原生即时输入能力。它不会像 Claude Code 适配那样先制造一条 interrupt frame。显式终止仍使用原生 `control_request {subtype:"interrupt"}`，随后有界确认进程退出。

若 stdout 在 terminal `result` 前结束，SSH 进程层保留最近 16 KiB stderr，transport 清除终端颜色、截取并脱敏后返回 `AGENT_PROCESS_EXITED_WITHOUT_RESULT`，同时携带退出码和信号。页面因此显示可定位的 Qoder 原生退出原因，而不是无上下文的 “stream ended without final event”。

## 5. 工作区切换

Qoder CLI 提供 `--cwd`/进程 cwd 和 `--resume`，没有修改一个已经启动的 CLI 进程 cwd 的独立控制 RPC。EasyWork 因而按原生方式切换：

1. 网页 Route 改为目标工作区；
2. 保留当前 Binding 中已验证的 Qoder `session_id` 和 native-store owner；
3. 不复用 cwd 不同的预热或旧进程；
4. 在目标绝对路径启动 `qoderclicn`；
5. 传 `--resume <同一 session-id>` 并发送下一条真实用户帧。

同一稳定 Binding 的运行配置保持隔离，`projects` 指向原 native-store owner，所以 Qoder 从原 transcript 恢复。网页对话不新建、原生 session 不新建、历史正文不重放。若 Qoder 原生明确报告 session 不存在，上层才进入新的上下文代次并按 Context receipt 补发允许的网页正文。

## 6. 原生操作映射

| EasyWork 操作 | Qoder CN 行为 |
| --- | --- |
| start | 在当前 cwd 启动 stream-json；存在 session 时自动加 `--resume` |
| resume | 在目标 cwd 用 `--resume <session-id>` 启动新进程并发送 user frame |
| append | 向活动 stdin 写带 `priority:"now"` 的 user frame |
| interrupt | 向活动 stdin 写原生 interrupt control request，并有界确认退出 |
| approval | 对 `can_use_tool` 等原生请求写 control response |
| input | 按 AskUserQuestion、elicitation 或 dialog 的原生形状回答 |
| compact | 活动进程发送 `/compact`；无活动进程时恢复一次性进程 |
| contextUsage | 使用当前请求的 streaming usage、原生 context report 或可验证 ratio |
| fork | 持久化精确 native-deferred 边界；目标网页分支下一条真实输入使用原生 fork-at-boundary 参数 |
| revert / 重新生成 | 保留当前 `session_id`，持久化 native-rewind-deferred 边界；下一条真实输入在同一 session 内恢复到该边界 |

Qoder 的原生分支参数为：

```text
--resume <source-session>
--fork-session
--session-id <target-session>
--resume-session-at <assistant-leaf-uuid>
```

回溯和重新生成不带 `--fork-session`，也不生成 `--session-id`：

```text
--resume <current-session>
--resume-session-at <retained-assistant-leaf-uuid>
```

网页先把消息、Context receipt 和工作区版本恢复到同一保留边界，再以原用户消息创建新 Task。Qoder 会在同一个 session 的原生 transcript DAG 上继续生成，因此重新生成不是网页分支，也不会创建新的 Qoder session。`--resume-drops-turn <prompt-uuid>` 只在已取得并验证被丢弃用户回合 UUID 时作为防误删 guard；不能用 assistant UUID 或网页消息 ID 代替。

边界来自 Qoder `projects` transcript 的最新 `active-leaf.leafUuid`，并且该 UUID 必须在同一 JSONL 中对应一条 `type:"assistant"` 记录。Qoder CLI `1.1.53` 的 `last-prompt` 只有 `lastPrompt`、`sessionId` 和 `type`，不能按 Claude 的 `last-prompt.leafUuid` 读取。stream-json 的顶层 `assistant.uuid` 是 SDK 事件标识，不作为 `--resume-session-at` 边界。EasyWork 在 Task 终态读取并验证 `active-leaf`，在保存 deferred fork/revert 前再次验证；缺少边界时不能从回答文本猜测。

原生同会话回退不能安全执行时，上层推进 `contextEpoch`，下一轮在干净的新 session 中按 Context receipt 重建允许的上下文；不会改用 `--fork-session` 冒充重新生成。恢复点必须属于最新保留的网页 Agent Task，不能因为该 Task 缺少 checkpoint 就退回更早的原生边界，否则网页与原生历史会错位。旧版 EasyWork 曾把重新生成错误保存成同 Binding 的 `pendingFork`；当前启动时会把这种状态连同 Context receipt 迁回来源 session，而显式网页分支因使用独立 Binding/native-store owner，不参与该迁移。

## 7. 事件、Skill 与文件版本

适配器消费当前 Qoder stream-json 的 `system`、`stream_event`、`assistant`、`user`、`result`、`control_request`、`control_response` 和专用控制帧，并映射为 EasyWork 的正文、思考、计划、工具调用、审批、输入请求、文件变化、用量、错误和终态。已明确适配的 Qoder 扩展事件包括模型排队和 API 重试、`command_lifecycle`、前后台 task、plan mode、goal 更新/清除、Hook 进度、权限拒绝、文件持久化、artifact、memory generation/consumption/recall、skill evolution、可用模型/命令变化、认证与限流、cloud agent 和会话 reset。未知交互请求明确失败；未知非交互事件形成兼容性信息。

当前上下文用量以 `message.usage`、`message_delta.usage` 或 assistant frame 的原生 `context_usage` report 为准。Qoder 只返回 `context_usage_ratio` 或 token 计数暂时为 0 时，适配器会结合终态 `modelUsage.contextWindow` 还原当前窗口 token；终端 `result.usage` 的累计 token 仍只进入任务报告，不能覆盖当前 context window。配置页显示的上限优先使用当前 `contextLimit`，即自动压缩计算窗口。读取只消费 Binding 事件缓存，不向会话注入测试 prompt；网页用量缓存按 Actor、服务器、配置域、Binding 和 Agent 隔离，并在 context revision 变化或压缩后强制刷新。partial delta 与完成快照按 message/content/tool 原生 ID 合并，避免重复正文和连续思考块。

`artifacts_update` 中 `kind: "changed"` 的条目作为内部 `file_change` 进入版本账本，避免与普通 Edit/Write 结果重复展示；`kind: "presented"` 的条目形成用户可见 artifact 卡片。memory 与 skill evolution 状态只记入内部作业状态，不替换 EasyWork 的记忆和技能库当前内容。

Binding 的 `skills/` 链接到 `QODERCN_CONFIG_DIR/skills`。本轮明确选择的 Skill 使用技能库当前内容生成原生命令入口并在 user frame 中调用；自动选择和强制项复用已发送的技能，网页 Agent 能看到已发送状态。Skill 内容、附件及用户文件均按 Binding 隔离，用户文件和工作区写前 Hook 沿用公共文件版本机制。Cron 工具被禁用，因为当前网页 Task 流不负责在任务完成后长期调度通知。

作业提交记录使用 Bash/shell 工具调用的结构化输入和对应 `tool_result` 输出，通过原生 call ID 关联后交给四种 Agent 共用的提交检测器。只有直接执行 `sbatch` 且返回可验证成功回执才进入持久账本；查询结果、文件文本和 Agent 总结不补录。后台跟踪器随后直接查询调度器并保存终态，不依赖 Qoder 再次查询或用户打开算力面板。

## 8. 升级核对清单

更新 Qoder CN 后至少核对：

1. 官方 Manifest 的 `latest`、平台架构、URL、SHA-256 和 tar 内二进制名；
2. x64 optimized/baseline 的 CPU 条件；
3. `status -o json` 的 `logged_in` 和版本字段；
4. `login` 是否仍输出可打开的 device-login HTTP(S) URL；
5. stream-json 参数、user `priority:"now"`、control request/response 和 result 终态；
6. `QODERCN_CONFIG_DIR`、`.auth`、`projects`、settings 和 Skill 目录规则；
7. `--resume` 跨 cwd、同 session 的 `--resume-session-at`、可选 `--resume-drops-turn` guard，以及独立分支的 `--fork-session`；
8. 权限枚举、reasoning effort、当前请求 usage、`context_usage_ratio` 和文件 checkpoint Hook；
9. SDK `1.0.41` control 的 `initialize`、`get_models`、`get_usage_info`，以及模型倍率、上下文档位、配额哨兵和积分结构；
10. `/compact` 是否仍以 `system/compact_boundary` 先于终态证明成功，以及无边界 result 的失败/未执行语义；
11. 模型目录缓存键、原生目录变化、`artifacts_update`、goal/task/memory/skill/cloud 等扩展事件形状。

核对来源以官方源码和类型定义为主：

- [Qoder CLI 安装文档](https://docs.qoder.cn/cli/installation)
- [Qoder CLI 模型文档](https://docs.qoder.com/cli/model)
- [Qoder CLI 命令参考](https://docs.qoder.com/cli/cli-reference)
- [Qoder CLI 设置参考](https://docs.qoder.com/cli/settings-reference)
- [Qoder CLI 用量文档](https://docs.qoder.com/cli/usage)
- [Qoder Agent SDK 文档](https://docs.qoder.com/cli/sdk)
- [Qoderian 原生目录探测源码](https://github.com/QoderAI/Qoderian/blob/main/src/qoder/commands/probe-runtime-commands.ts)
- [Qoderian 积分读取源码](https://github.com/QoderAI/Qoderian/blob/main/src/qoder/services/credits-usage.ts)
- [Qoderian 登录服务源码](https://github.com/QoderAI/Qoderian/blob/main/src/qoder/services/qoder-login-service.ts)
- [Qoder CN CLI npm 包](https://www.npmjs.com/package/@qodercn-ai/qoderclicn)
