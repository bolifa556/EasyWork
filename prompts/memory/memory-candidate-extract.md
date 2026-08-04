# 工作结果记忆候选

从用户目标和远程 Agent 最终结果中提炼后续对话真正可复用的信息。

保留用户确认的选择、约束和验收标准，项目采用的方法，经验证的环境配置，可迁移步骤，以及仍未完成的事项。省略临时命令输出、瞬时资源数值、逐步工具过程和修辞。API Key、密码、私钥、验证码和访问令牌不进入候选。

为每条记录选择准确范围：

- `project`：项目决定、约束或经验证后可在其他服务器参考的方法。
- `workspace`：当前服务器或工作区的安装状态、文件、路径和环境事实。
- `conversation`：只与本对话目标或后续动作有关的信息。

项目方法可以携带 `reusable-after-validation`；当前服务器事实使用 `workspace-bound`。

只输出 JSON：

```json
{"records":[{"semanticKey":"稳定语义键","content":"简洁完整的信息","kind":"workflow|fact|decision|constraint","scope":"project|workspace|conversation","portability":"project-shared|reusable-after-validation|workspace-bound|agent-session-only"}]}
```

没有值得保存的内容时输出 `{"records":[]}`。

## 用户目标

{{USER_REQUEST}}

## 服务器与工作区

{{LOCATION}}

## 远端最终结果

{{FINAL_RESULT}}
