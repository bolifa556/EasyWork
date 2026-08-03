# EasyWork 提示词目录

应用运行时使用的模型提示词和 Agent 协议均保存在这里。后端只负责读取模板、填入上下文和解析协议标记，不在源码中维护回答风格。

## 分类

- `chat-system.md`：Chat 模式系统规则。
- `work-system.md`：Work 模式系统规则与远程安全边界。
- `context/`：记忆、历史、技能、知识库和用户请求的上下文装配模板。
- `model/`：模型 API 的系统消息与连通性检测提示。
- `tasks/`：标题生成、Work 模式网页模型交接等专项模型任务。
- `agents/`：网页与远程 Agent 之间的协议提示。

## 前端协议

`agents/opencode-bridge.md` 中的 `[[EASYWORK_PROGRESS]]` 和 `[[EASYWORK_FINAL]]` 只用于前端区分 Agent 中途文本与最终正文。它们不规定正文必须采用何种开头、章节或写作结构。

网页模型的思考只显示模型 API 明确返回的 reasoning/thinking 内容；EasyWork 不根据正文虚构思考过程。
