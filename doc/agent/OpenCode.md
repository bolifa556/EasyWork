# OpenCode 适配说明

本文记录当前 OpenCode 适配的实际协议面，供 OpenCode 升级后核对 EasyWork 行为。通用 binding、上下文、文件账本和删除机制见 [远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)。

## 1. 当前基线与源码

- EasyWork Agent ID：`opencode`
- 托管包 ID：`opencode`
- Manifest 基线：`1.18.30`
- 进程入口：`opencode serve`
- 统一协议名：`opencode-server-sse`
- 适配器：`gateway/core/agents/opencode.mjs`
- 运行传输：`gateway/core/agent-runtime/transport.mjs`
- 配置：`gateway/core/agent-runtime/configuration.mjs`
- 托管制品：`agent-app/manifest.json`

Manifest 是版本、制品大小和 SHA-256 的权威来源。本文不重复哈希，避免升级时出现第二份版本清单。

## 2. 运行模型与协议选择

每个 binding 启动一个只监听远端回环地址的服务：

```text
opencode serve --hostname 127.0.0.1 --port <deterministic-port>
```

服务可以 detached 运行，从而释放 SSH exec channel，再通过 HTTP/SSE 通道控制；这兼容限制并发 SSH channel 的服务器。进程、端口、协议、运行指纹和 session ID 写入 binding 的 `state/active.json`。同一 binding 的启动单飞；复用前校验健康状态和运行指纹。

当前组合根为新 Work binding 指定 V1。原因是托管 `1.18.30` 的官方 V1 `/session` 面提供原生 fork/revert，而 V2 当前没有 fork 路由。`opencode debug v2 --help` 的结果按“二进制路径 + 实际版本”缓存，用于识别用户安装是否具有 V2 协议。

协议一旦随原生 session 持久化便保持不变：已有 V1 session 继续走 V1，已有 V2 session 继续走 V2，不把一族的 session/message 投影交给另一族接口。若升级后的二进制不再支持已有 session 所需协议，EasyWork 返回实际版本和缺失能力，而不是新建 session 掩盖问题。

Readiness 不只看 health：

- V1 检查 `/global/health` 或公共 health，再从 `/provider` 确认 `easywork/<model>`；
- V2 检查 `/api/health`，再从 `/api/model` 确认模型；
- 模型目录加载期间为空会继续等待，不能因为 health 成功就提前接收请求；
- 首次 readiness 最多等待 120 秒。共享家目录的 HPC 登录节点上，health 可能先返回，而 provider/model 目录要在依赖与配置装载完成后才出现；
- 已经通过模型门槛的活动服务，后续短暂目录刷新只复查 health，避免杀死有效 session。

## 3. 配置与模型路由

网页配置字段为：

| 字段 | 原生含义 | 缺省值 |
| --- | --- | --- |
| `model` | `easywork/<model>` | 由当前模型路由提供 |
| `contextLimit` | provider model context limit | `200000` |
| `reasoningEffort` | prompt `variant` | `default` |
| `permissionMode` | 全局 permission | `allow` |

V1 配置使用 `provider`、`permission`、`snapshot`；V2 使用 `providers`、`permissions`、`snapshots`。模型通过 `@ai-sdk/openai-compatible` 访问 EasyWork 路由。输出上限取 `min(32768, contextLimit / 4)`，API 根会归一到拥有 `/chat/completions` 的 OpenAI-compatible base URL。

当全局权限是 `allow` 时，`edit` 和 `bash` 仍被覆盖成 `ask`。这些权限事件是 EasyWork 写前快照的原生屏障，不是向用户重复索要确认：适配器完成 preimage 捕获后只回复本次操作。Skill 视图路径获得 `external_directory` 访问权。

配置刷新只影响下一次安全的 start/resume；活动 append、审批和 interrupt 继续命中当前服务。思考强度只有被模型明确拒绝后才走统一的一次性自动适配，并把实际 `variant` compare-and-set 回当前对话配置。

网页二级菜单保留 OpenCode 的“打开配置”，模型仍从 EasyWork 已配置的 provider 目录选择。配置快照按 Actor、服务器、网页对话配置域和 Agent 隔离，优先立即显示内存或浏览器缓存；服务器返回更高 revision 时覆盖旧快照，保存遇到 revision 冲突时会重读权威配置并只重放用户本次修改。该缓存只减少重复 SSH/配置读取，不改变原生配置的权威性。

## 4. 原生操作映射

适配器先生成统一 `/api/session` facade，transport 再按 session 锁定的协议翻译。

### 4.1 V1

| EasyWork 操作 | OpenCode V1 请求 |
| --- | --- |
| 新建 session | `POST /session?directory=<cwd>` |
| start/resume/append | `POST /session/:id/prompt_async?directory=<cwd>`，body 含 text parts、provider model 和可选 variant |
| compact | `POST /session/:id/summarize?directory=<cwd>` |
| interrupt | `POST /session/:id/abort?directory=<cwd>` |
| fork | `POST /session/:id/fork?directory=<cwd>`，body 使用下一条消息作为 exclusive `messageID` |
| revert | `POST /session/:id/revert?directory=<cwd>`，同样使用 exclusive `messageID` |
| revert 补偿 | `POST /session/:id/unrevert?directory=<cwd>` |
| approval | `POST /permission/:request/reply?directory=<cwd>` |
| input | `POST /question/:request/reply?directory=<cwd>` |
| 事件 | SSE `/event?directory=<cwd>` |

EasyWork 的 retained boundary 是“保留到某消息为止”，而 V1 fork/revert body 需要“从哪条消息开始排除”。适配器先读取 session 消息，验证 retained ID 存在，再换算成下一条消息 ID。fork 完成后还会核对子 session 的消息数量、顺序和角色，并建立来源 message ID 到子 message ID 的边界映射。

### 4.2 V2

| EasyWork 操作 | OpenCode V2 请求 |
| --- | --- |
| 新建 | `POST /api/session` |
| start/resume/append | `POST /api/session/:id/prompt` |
| compact | `POST /api/session/:id/compact` |
| interrupt | `POST /api/session/:id/interrupt` |
| approval | `POST /api/session/:id/permission/:request/reply` |
| input | `POST /api/session/:id/question/:request/reply` |
| revert stage | `POST /api/session/:id/revert/stage` |
| revert commit | `POST /api/session/:id/revert/commit` |
| revert clear/undo | `POST /api/session/:id/revert/clear` |

V2 prompt 必须返回有效 `admittedSeq`，EasyWork 才把请求视为已经进入该 session 的原生事件边界。当前 V2 没有 fork 接口；网页分支因此安全换到新的上下文代次，而不是模拟原生分支。

### 4.3 原生工作区切换

同一服务器和网页分支内选择另一个工作区时，EasyWork 在下一轮事件订阅与 prompt 之前调用 `1.18.30` 的原生控制面：

```json
{"method":"POST","path":"/experimental/control-plane/move-session","body":{"sessionID":"...","destination":{"directory":"/目标/工作区"},"moveChanges":false}}
```

成功后沿用相同 session ID，后续 V1/V2 请求与 SSE 都使用目标目录。`moveChanges:false` 表示不要求 OpenCode 替 EasyWork 搬运工作区修改；真实文件和版本边界仍由所选工作区及 EasyWork 文件账本负责。若当前 OpenCode store、项目边界或版本拒绝移动，EasyWork 明确结束旧绑定尝试，在稳定 binding 下建立新原生 session，并由 Context Hub 交付该 session 尚未收到的网页正文；不会把失败的 move 当成成功续聊。

## 5. 运行中追问与终止

V1 的 `prompt_async` 在原生 run 活动时可以保存用户消息，但其 runner 只等待已有 run，并不会 steer 当前采样。EasyWork 因而先查询 `/session/status`；若 session busy，则调用 `/abort` 并轮询到 idle，再把追问作为同一 session 的下一次 `prompt_async`。新的 EasyWork runtime run ID 隔离旧流迟到的 idle/final，网页上仍属于同一个 Task。

V2 直接使用 prompt 的 steer 语义和 admitted sequence。无论哪种协议，interrupt 都会在返回后继续确认 session 已不忙；仅收到 HTTP 成功不能提前把 Task 标记为停止。

OpenCode 的 `serve` 是 binding 隔离 HOME 下的长期后台进程。删除网页对话时，EasyWork 先释放 HTTP relay 和已知 PID，再以该精确 HOME 校验并终止可能失去 `active.json` 的孤儿服务，最后回收 runtime 与原生 store。这个补偿对 NFS 主机尤其必要：仍打开日志的进程会使目录留下 `.nfs*` 占用，但不能因此扩大为按进程名或工作区批量终止。

## 6. 压缩、上下文用量与事件投影

### 6.1 压缩与上下文用量

配置页“压缩”调用当前 session 的原生端点：V1 发送 `POST /session/:id/summarize?directory=<cwd>`，并携带当前 `providerID`/`modelID`；V2 发送 `POST /api/session/:id/compact`。EasyWork 等待原生 HTTP 请求完成，非成功响应直接作为压缩失败返回。V1 的 `session.compacted` 与 V2 的 `session.next.compaction.*` 继续写入事件日志，用于展示真实生命周期；它们不会被 EasyWork 摘要替代。请求完成后页面强制重读上下文用量，但不会清空模型或 provider 列表。

OpenCode 没有独立上下文查询 RPC。统一 `contextUsage` 只读取当前 session 已归一化的原生 usage 事件缓存；终端 billing 统计不冒充当前窗口占用，也不会为了取得数字向对话注入探测问题。网页按 Actor、服务器、配置域、Binding 和 Agent 缓存最近一次已验证值，并在原生上下文 revision 前进或用户完成压缩后刷新；尚无原生 usage 时明确显示不可用。

### 6.2 V1 事件

主要原生事件包括：

- `message.updated`、`message.part.updated`、`message.part.delta`：助手文本、reasoning 和工具 part；
- `todo.updated`：原生 Todo/计划；
- `permission.asked`/`permission.updated`：审批；
- `question.asked`：用户输入；
- `session.status`、`session.idle`、`session.error`、`session.compacted`、`session.diff`：生命周期和文件变化。

V1 以目标 session 的 `idle` 作为原生运行结束边界。适配器从消息 part 中区分正文、reasoning、tool call/result，并只对当前 run/session 的事件完成 final。

### 6.3 V2 事件

主要事件族为：

- `session.next.text.*`、`session.next.reasoning.*`；
- `session.next.tool.input.*`、`tool.called/progress/success/failed`；
- `session.next.shell.*`、`session.next.step.*`；
- `session.next.compaction.*`、`retried`；
- `agent.switched`、`model.switched`、`moved`、`revert.*`；
- V2 permission/question 交互。

V2 的 `session.next.step.ended` 只有 finish 原因不再是 tool calls 时才是回合完成。公共流上重复出现的 V1 message 兼容事件不覆盖权威 `session.next.*` 状态。

安装、PTY、catalog 或 workspace invalidation 等服务级事件不会变成当前 Task 的活动行。未知交互事件失败可见；未知非交互事件形成兼容性信息。工具事件按稳定 call ID 和语义完成状态去重，Todo 只由 `todo.updated` 驱动，不由 EasyWork 推测。

作业提交记录消费终态 Bash 工具事件：V1 的 tool part `state.input` / `state.output`，以及 V2 的 `session.next.tool.success`（失败事件中如已含成功提交回执也可记录），归一化后把同一个 call 的命令和输出交给统一提交检测器。仅直接 `sbatch` 执行与对应成功回执形成持久记录，不从历史查询、文件内容或 Agent 总结补录作业。成功回执写入账本后，由四种 Agent 共用的后台跟踪器直接查询调度器并持久化终态，不依赖 OpenCode 后续查询或用户打开算力面板；断线、重连和查询失败边界统一处理。无需 OpenCode 的额外提示词或新工具。识别与跟踪边界见《SSH机制》的提交历史章节。

## 7. Skill 适配

选中的包先进入按用户和内容摘要隔离的不可变缓存，再复制到当前 binding 自有的文件代次；`skills/<skill-id>` 只指向这个 binding 自己的副本。OpenCode 配置只放行这棵视图，同一服务器上的其他 session 不会自动看到缓存中的包。分支按所选 Task 的实际文件快照复制技能，父子之后各自持有文件。

个人包固定、SSH 上传校验、远端缓存与自有副本的完整目录关系，见[远端文件版本与 Agent 机制](../远端文件版本与Agent机制.md)第 7 节；历史技能快照与分支继承见第 10 节。`<runtime-config>/opencode/skills` 指向当前 binding 的 `skills`，技能附件通过自有目录保留。

网页 Agent 用 Skill 入口判断相关性。当前托管 V1 从本轮所选自有副本读取正文并保留各技能资源基准目录，生成 `skills/easywork-selected/SKILL.md`，用 `$ARGUMENTS` 接收本轮交接正文；此包装不加入历史技能快照。先以 GET `/command?directory=<cwd>` 确认原生命令可发现，再以 POST `/session/:id/command?directory=<cwd>` 传入 `command: "easywork-selected"`、本轮交接正文 `arguments`、model 和 variant，由原生命令展开技能正文。该 HTTP 调用允许持续到原生回合结束，帧流与提交错误一并收敛。已有 V2 会话仍按其固定协议运行，不冒充支持 V1 command。普通补充 prompt 不复制技能正文，pin 只代表部署收据，不代表当前回合已经调用。

用户显式附加及符合模式、服务器范围的 Work 强制 Skill 由 EasyWork 直接选定，不进入网页模型的检索目录和候选池；与网页选中项共用上述原生交付通道。强制项仅在切换远端绑定后的首次提问检查并补齐，后续连续提问复用检查结果；用户显式或网页按需选中的项仍执行本轮原生调用。网页“发给远端 Agent”只显示本轮实际补发或调用的 Skill 引用。

## 8. 文件写前快照

OpenCode 没有直接使用 Codex/Claude 的 command hook 配置。EasyWork 把原生 mutation permission 当成写前边界：

1. `edit` 或 `bash` permission 到达；
2. transport 从原生 tool 输入和 cwd 生成 operation manifest；
3. 远端 Python 3 Hook 捕获目标路径 preimage；
4. 捕获成功后内部回复 `once`；
5. 捕获失败则拒绝让该修改继续。

即使全局 permission 是 `allow`，mutation 仍逐次经过这条屏障。`approve_session` 对 mutation 也会降为 `once`，不能通过一次“始终允许”绕过后续写前捕获。事后的 `session.diff` 仅用于展示和收尾参考。

## 9. 原生分支与回退

### 9.1 V1 分支

OpenCode 的 XDG data store 包含 session 数据，父子长期服务不能同时打开同一份可写 store。当前实现不是 SQLite backup API，实际流程为：

1. 验证来源 native-store binding 属于同一受控 Agent runtime 根；
2. 停止来源 binding 的 OpenCode 服务；
3. 将 `data/opencode/opencode*.db` 连同存在的 `-wal`、`-shm`、`-journal` sidecar 用 `cp -a` 复制到目标 binding；
4. 若没有数据库而存在旧版 `data/opencode/storage`，复制该 storage 树；
5. 复制存在的 `auth.json` 和 `mcp-auth.json`；
6. 目标服务只打开自己的 store，再调用 V1 官方 `/session/:id/fork`；
7. 校验子 session 历史并保存 message boundary map。

父子 binding 此后拥有独立可写 store、HOME、配置、Skill 视图和服务进程，但仍可指向同一物理工作区。

### 9.2 回退

V1 使用原生 `revert`，EasyWork 文件账本恢复成功后保留该结果；若文件恢复失败则调用 `unrevert` 补偿。V2 使用 stage/commit/clear：先 stage 原生边界，文件恢复成功后 commit，失败则 clear。

任何阶段缺少 retained message、session、协议或验证结果，都不会修改 OpenCode 私有数据库伪造历史；运行层返回失败，让上层换用新的 `contextEpoch`。

## 10. 升级时容易变化的协议面

OpenCode 版本升级时，现有实现依赖的变化点集中在：V1/V2 配置键、health 与模型目录形状、session create/prompt/abort/summarize/compact/fork/revert 路由及错误语义、`/experimental/control-plane/move-session` 的请求与项目边界、SSE 用量/压缩事件命名和终态、permission/question reply 结构、`prompt_async` 的活跃 run 行为、fork 的 exclusive message 边界、原生 store 布局及 sidecar、一致的 model/variant 参数。

托管基线必须完整满足这些约束。用户二进制可以通过能力探测保留不影响正确性的差异，但核心 session 协议、明确 final、mutation 写前屏障或边界验证缺失时必须显式降级或拒绝，不能靠提示词弥补。
