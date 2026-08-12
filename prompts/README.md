# EasyWork 提示词目录

应用运行时使用的模型提示词均保存在这里。后端读取模板并通过结构化事件与 Context Hub 投递，不在正文中解析私有标记。

## 分类

- `memory/`：对话压缩和可复用记忆候选提取。
- `tasks/`：标题生成等独立模型任务。
- `web/chat-system.md`：Chat 模式 Web Agent 的工具边界与工作方式。
- `web/work-system.md`：Work 模式网页 Agent 的最小上下文装配边界。
- `agents/common.md`：所有远程 Agent 共用的执行、上下文与版本边界。
- `agents/{opencode,codex,claude-code}.md`：各 Agent 的原生计划与能力补充。

EasyWork 只读取 `web/`、`memory/`、`tasks/` 和上述 `agents/` 提示词。Context Hub 使用结构化实体装配上下文，不再读取旧的文本拼接模板。Work 模式由网页 Agent 只装配上下文，远程 Agent 自主规划、执行并生成最终正文。

网页模型的思考只显示模型 API 明确返回的 reasoning/thinking 内容；EasyWork 不根据正文虚构思考过程。
