import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import {
  WebAgentObservationLedger,
  renderWebAgentObservations,
} from "../gateway/core/web-agent/observations.mjs";

const actor = createActorContext({ actorType: "user", actorId: "observation_user", deviceId: "device", sessionId: "session", roles: [] });
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prompts = new PromptRepository({ promptRoot: path.join(repositoryRoot, "prompts") });

function fragment({ key = "resource:guide:chunk", version = "v1", content = "第一版", name = "guide.md", priority = 90 } = {}) {
  return {
    toolName: "resource_read",
    rendered: `相关文件：\n- 文件：${name}\n  ${content}`,
    presented: { resources: [{ filename: name, text: content }] },
    knowledge: { key, version, content },
    reference: { kind: "文件", name },
    priority,
  };
}

test("网页已读账本按分支和消息边界复用、回溯并选择最新版本", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-web-observations-"));
  try {
    let tick = 0;
    const ledger = new WebAgentObservationLedger({
      dataRoot,
      actor,
      clock: () => new Date(Date.UTC(2026, 7, 30, 0, 0, tick++)),
    });
    await ledger.record({ conversationId: "conversation", branchId: "main", sourceMessageId: "message-1", fragments: [fragment()] });
    await ledger.record({ conversationId: "conversation", branchId: "main", sourceMessageId: "message-2", fragments: [fragment({ version: "v2", content: "第二版" })] });
    await ledger.record({ conversationId: "conversation", branchId: "main", sourceMessageId: "message-2", fragments: [fragment({ version: "v2", content: "第二版" })] });

    const current = await ledger.list({ conversationId: "conversation", branchId: "main", sourceMessageIds: ["message-1", "message-2"] });
    assert.equal(current.length, 1);
    assert.equal(current[0].knowledge.version, "v2");
    assert.match(await renderWebAgentObservations(current, "work", prompts), /candidate_id: candidate_/);

    await ledger.invalidate({ conversationId: "conversation", branchId: "main", removedMessageIds: ["message-2"] });
    const rewound = await ledger.list({ conversationId: "conversation", branchId: "main", sourceMessageIds: ["message-1"] });
    assert.equal(rewound.length, 1);
    assert.equal(rewound[0].knowledge.version, "v1");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("网页分支只复制分叉点前的已读知识并重绑消息边界", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-web-observation-fork-"));
  try {
    const ledger = new WebAgentObservationLedger({ dataRoot, actor });
    await ledger.record({ conversationId: "source", branchId: "source-branch", sourceMessageId: "source-1", fragments: [fragment({ key: "memory:one", content: "共同事实" })] });
    await ledger.record({ conversationId: "source", branchId: "source-branch", sourceMessageId: "source-2", fragments: [fragment({ key: "memory:two", content: "分叉后事实" })] });
    await ledger.fork({
      sourceConversationId: "source",
      sourceBranchId: "source-branch",
      targetConversationId: "target",
      targetBranchId: "target-branch",
      messageIdMap: new Map([["source-1", "target-1"]]),
    });
    const copied = await ledger.list({ conversationId: "target", branchId: "target-branch", sourceMessageIds: ["target-1"] });
    assert.deepEqual(copied.map((entry) => entry.knowledge.key), ["memory:one"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("完整记忆目录作为当前格式候选渲染，不依赖请求文本预筛选", async () => {
  const memory = fragment({ key: "memory:answer-style", name: "answer-style", content: "用户希望回答使用短句。" });
  memory.toolName = "memory_catalog";
  memory.reference = { kind: "记忆", name: "answer-style" };
  const rendered = await renderWebAgentObservations([memory], "work", prompts);
  assert.match(rendered, /用户希望回答使用短句/);
  assert.match(rendered, /candidate_id: candidate_/);
});
