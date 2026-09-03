import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import {
  filterRelevantHistoricalObservations,
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

test("Work 只恢复与当前请求相关的历史正文，未发送的旧 Skill 不会永久占据上下文", () => {
  const computeSkill = fragment({
    key: "skill:compute-rules",
    name: "代码与计算任务规范",
    content: "在算力平台组织项目、配置环境、生成 Slurm 作业并检查运行日志。",
  });
  computeSkill.reference = { kind: "Skill", name: "代码与计算任务规范" };
  const deploymentPreference = fragment({
    key: "memory:deployment-preference",
    name: "deployment-preference",
    content: "用户的部署偏好是保留现有参数。",
  });
  deploymentPreference.reference = { kind: "记忆", name: "deployment-preference" };
  const answerPreference = fragment({
    key: "memory:answer-preference",
    name: "answer-preference",
    content: "用户偏好回答不超过三句话。",
  });
  answerPreference.reference = { kind: "记忆", name: "answer-preference" };

  assert.deepEqual(
    filterRelevantHistoricalObservations([computeSkill, deploymentPreference, answerPreference], {
      request: "继续按我的部署偏好处理",
      skills: [{ skillId: "compute-rules", name: "代码与计算任务规范", description: "适用于 Slurm 计算项目" }],
    }).map((entry) => entry.knowledge.key),
    ["memory:deployment-preference"],
  );
  assert.deepEqual(
    filterRelevantHistoricalObservations([computeSkill], {
      request: "创建 Python 项目并提交 Slurm 作业",
      skills: [{ skillId: "compute-rules", name: "代码与计算任务规范", description: "适用于 Slurm 计算项目" }],
    }).map((entry) => entry.knowledge.key),
    ["skill:compute-rules"],
  );
  assert.deepEqual(
    filterRelevantHistoricalObservations([computeSkill], {
      request: "只读取 docs/handoff-note.md，不要运行作业，也不要提交 Git",
      skills: [{ skillId: "compute-rules", name: "代码与计算任务规范", description: "适用于 Slurm 计算项目" }],
    }),
    [],
  );
  assert.deepEqual(
    filterRelevantHistoricalObservations([computeSkill], {
      request: "只把第三行改成“CPU-only，不申请 GPU”，不要运行作业",
      skills: [{ skillId: "compute-rules", name: "代码与计算任务规范", description: "适用于 CPU、GPU 和 Slurm 作业" }],
    }),
    [],
  );
});

test("Work 按文件名复用历史文件，显式文件集范围可恢复已读文件", () => {
  const readme = fragment({ key: "resource:readme:chunk", name: "README.md", content: "验证安装章节" });
  const unrelated = fragment({ key: "resource:notes:chunk", name: "notes.md", content: "其他背景" });
  assert.deepEqual(
    filterRelevantHistoricalObservations([readme, unrelated], { request: "只读取 README.md 的验证安装章节" })
      .map((entry) => entry.knowledge.key),
    ["resource:readme:chunk"],
  );
  assert.deepEqual(
    filterRelevantHistoricalObservations([readme, unrelated], { request: "根据附加资料处理", includeAllResources: true })
      .map((entry) => entry.knowledge.key),
    ["resource:readme:chunk", "resource:notes:chunk"],
  );
});
