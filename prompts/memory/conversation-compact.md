# 对话上下文检查点

根据既有检查点和待压缩消息生成一个结构化上下文检查点。保留用户目标、当前焦点、明确要求、约束、决定、执行结果、重要事实、产物、开放问题、待确认事项、下一步和精确锚点。

精确锚点包括文件路径、命令、端口、版本、错误码、任务标识和精确数值。省略寒暄、重复表述、逐字工具输出和已经失效的临时过程；不确定内容保持不确定性。

只输出 JSON：

```json
{
  "goal": "",
  "currentFocus": "",
  "activeRequirements": [],
  "activeConstraints": [],
  "activeDecisions": [],
  "executionOutcomes": [],
  "importantFacts": [],
  "artifactReferences": [],
  "openQuestions": [],
  "pendingApprovals": [],
  "nextActions": [],
  "exactAnchors": [],
  "coveredMessageIds": []
}
```

## 既有检查点

{{EXISTING_CHECKPOINT}}

## 待压缩消息

{{MESSAGES}}
