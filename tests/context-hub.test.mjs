import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { ContextHub } from "../gateway/core/context-hub/index.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import { createEffectiveContextScope } from "../gateway/core/scope.mjs";

const actor = createActorContext({ actorType: "guest", actorId: "guest_a", deviceId: "device_a", sessionId: "session_a", roles: [] });
const scope = createEffectiveContextScope({
  actor,
  conversationId: "conversation_a",
  branchId: "main",
  memoryMode: "project-only",
  contextEpoch: 0,
});
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prompts = new PromptRepository({ promptRoot: path.join(repositoryRoot, "prompts") });

test("Context Hub assembles a sealed budgeted delivery and only redelivers unknown entries", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-"));
  try {
    const hub = new ContextHub({
      dataRoot,
      actor,
      tokenEstimator: (value) => String(value).length,
      sources: {
        system: async () => ({ id: "system_a", kind: "system", content: "system", required: true, priority: 100, source: { type: "prompt", id: "chat", version: "1" } }),
        conversation: async () => ({ id: "message_a", kind: "message", content: "hello", required: true, priority: 90, source: { type: "message", id: "message_a", version: "1" } }),
        memory: async () => ({ id: "memory_a", kind: "memory", content: "optional memory", priority: 1, source: { type: "memory", id: "memory_a", version: "1" } }),
        environment: async () => ({ id: "json_private", kind: "environment", format: "json", content: "{\"serverId\":\"private\"}", required: true, priority: 200 }),
      },
    });
    const session = await hub.createSession({ consumer: "web-agent", consumerId: "web", scope, budget: { maxTokens: 16, reservedOutputTokens: 4 } });
    const assembled = await hub.assemble(session.id);
    assert.equal(assembled.session.status, "sealed");
    assert.deepEqual(assembled.delivery.entries.map((entry) => entry.id), ["system_a", "message_a"]);
    assert.equal(assembled.usage.omittedEntries, 1);
    const first = await hub.deliveryForBinding("binding_a", assembled.delivery);
    assert.equal(first.entries.length, 2);
    await hub.acknowledge({ bindingKey: "binding_a", nativeSessionId: "native_a", delivery: first });
    await hub.checkpointBinding({
      bindingKey: "binding_a",
      nativeSessionId: "native_a",
      checkpointId: "task_a",
    });
    const second = await hub.deliveryForBinding("binding_a", assembled.delivery, "native_a");
    assert.equal(second.mode, "delta");
    assert.equal(second.entries.length, 0);
    await hub.acknowledge({ bindingKey: "binding_a", nativeSessionId: "native_a", delivery: second });
    await hub.checkpointBinding({
      bindingKey: "binding_a",
      nativeSessionId: "native_a",
      checkpointId: "task_a",
      nativeBoundary: {
        protocol: "codex",
        sessionId: "native_a",
        turnId: "turn_a",
        rolloutPath: "/home/tester/.codex/sessions/native_a.jsonl",
      },
    });
    assert.deepEqual((await hub.getBindingCheckpoint({
      bindingKey: "binding_a",
      nativeSessionId: "native_a",
      checkpointId: "task_a",
    })).nativeBoundary, {
      protocol: "codex",
      sessionId: "native_a",
      turnId: "turn_a",
      rolloutPath: "/home/tester/.codex/sessions/native_a.jsonl",
    });
    await hub.checkpointBinding({
      bindingKey: "binding_a",
      nativeSessionId: "native_a",
      checkpointId: "task_a",
      nativeBoundary: {
        protocol: "codex",
        sessionId: "native_a",
        turnId: "turn_a_final",
        rolloutPath: "/home/tester/.codex/sessions/native_a.jsonl",
      },
    });
    assert.equal((await hub.getBindingCheckpoint({
      bindingKey: "binding_a",
      nativeSessionId: "native_a",
      checkpointId: "task_a",
    })).nativeBoundary.turnId, "turn_a_final", "同一 Task 的早期边界必须推进到终态边界");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Context Hub refuses required context that exceeds the session budget", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-"));
  try {
    const hub = new ContextHub({
      dataRoot,
      actor,
      tokenEstimator: (value) => String(value).length,
      sources: { system: async () => ({ id: "required", kind: "system", content: "too long", required: true, source: { type: "prompt", id: "chat", version: "1" } }) },
    });
    const session = await hub.createSession({ consumer: "web-agent", consumerId: "web", scope, budget: { maxTokens: 5, reservedOutputTokens: 1 } });
    await assert.rejects(() => hub.assemble(session.id), (error) => error?.code === "CONTEXT_REQUIRED_ENTRY_EXCEEDS_BUDGET");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("远端 prompt 只发送语义正文和一次用户请求，不暴露 Context Hub 元数据", async () => {
  const request = "介绍一下你自己";
  const prompt = await prompts.remoteDelivery({
    id: "delivery_private",
    sessionId: "ctx_private",
    entries: [
      {
        id: "entry_private",
        kind: "message",
        source: { type: "conversation", id: "msg_private", version: "revision_private" },
        content: { format: "text", value: "用户：先简短回答。" },
        tokenEstimate: 8,
        sensitivity: "private",
        digest: "digest_private",
      },
      {
        id: "entry_current_user",
        kind: "message",
        source: { type: "conversation", id: "message_current", version: "message_current" },
        content: { format: "text", value: await prompts.conversationMessage("user", request) },
        tokenEstimate: 8,
        sensitivity: "private",
        digest: "digest_current",
      },
    ],
  }, request);

  assert.match(prompt, /^用户：先简短回答。/);
  assert.match(prompt, new RegExp(`\\n\\n${request}$`));
  assert.equal(prompt.split(request).length - 1, 1);
  assert.doesNotMatch(prompt, /运行约束|内部提示词|编排机制|工具协议/);
  assert.doesNotMatch(prompt, /delivery_private|ctx_private|entry_private|msg_private|revision_private|digest_private|kind|source|tokenEstimate|sensitivity/);
});

test("同一 Agent binding 只接收新增 delta，切换 Agent 获得完整快照且切回不会重复原生上下文", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-agent-delta-"));
  try {
    const memories = [{ id: "memory_1", content: "project fact one" }];
    const hub = new ContextHub({
      dataRoot,
      actor,
      sources: {
        memory: async () => memories.map((entry) => ({
          ...entry,
          kind: "memory",
          source: { type: "memory", id: entry.id, version: "1" },
        })),
      },
    });
    const firstSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_1", scope, budget: { maxTokens: 100, reservedOutputTokens: 10 } });
    const first = await hub.deliveryForBinding("binding_opencode", (await hub.assemble(firstSession.id)).delivery);
    assert.deepEqual(first.entries.map((entry) => entry.id), ["memory_1"]);
    await hub.acknowledge({ bindingKey: "binding_opencode", nativeSessionId: "native_opencode", delivery: first });

    memories.push({ id: "memory_2", content: "project fact two" });
    const secondSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_2", scope, budget: { maxTokens: 100, reservedOutputTokens: 10 } });
    const assembled = (await hub.assemble(secondSession.id)).delivery;
    const returningAgent = await hub.deliveryForBinding("binding_opencode", assembled, "native_opencode");
    assert.equal(returningAgent.mode, "delta");
    assert.deepEqual(returningAgent.entries.map((entry) => entry.id), ["memory_2"]);
    await hub.acknowledge({ bindingKey: "binding_opencode", nativeSessionId: "native_opencode", delivery: returningAgent });

    const switchedAgent = await hub.deliveryForBinding("binding_codex", assembled);
    assert.deepEqual(switchedAgent.entries.map((entry) => entry.id), ["memory_1", "memory_2"]);
    const noDuplicate = await hub.deliveryForBinding("binding_opencode", assembled, "native_opencode");
    assert.equal(noDuplicate.entries.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("原生会话确认丢失后从历史交付重建旧上下文并叠加当前增量", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-rebind-"));
  try {
    let conversation = [{ id: "user_old", kind: "message", content: "用户：旧请求", source: { type: "conversation", id: "user_old", version: "user_old" } }];
    let memories = [{ id: "memory_policy_v1", kind: "memory", content: "旧策略", source: { type: "memory", id: "policy", version: "1" } }];
    const hub = new ContextHub({
      dataRoot,
      actor,
      sources: {
        conversation: async () => conversation,
        memory: async () => memories,
      },
    });
    const firstSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_old", scope, budget: { maxTokens: 1_000, reservedOutputTokens: 100 } });
    const first = await hub.deliveryForBinding("binding_rebind", (await hub.assemble(firstSession.id)).delivery);
    await hub.acknowledge({ bindingKey: "binding_rebind", nativeSessionId: "native_removed", delivery: first });

    conversation = [{ id: "user_current", kind: "message", content: "用户：当前请求", source: { type: "conversation", id: "user_current", version: "user_current" } }];
    memories = [{ id: "memory_policy_v2", kind: "memory", content: "新策略", source: { type: "memory", id: "policy", version: "2" } }];
    const currentSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_current", scope, budget: { maxTokens: 1_000, reservedOutputTokens: 100 } });
    const current = (await hub.assemble(currentSession.id)).delivery;
    const rebound = await hub.deliveryForRebinding("binding_rebind", current);

    assert.equal(rebound.mode, "bootstrap");
    assert.deepEqual(rebound.entries.map((entry) => entry.id), ["user_old", "user_current", "memory_policy_v2"]);
    assert.equal(rebound.entries.some((entry) => entry.content.value === "旧策略"), false, "同一来源只恢复当前有效版本");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("原生会话确认的用户与助手消息不会重复补发，session 变化后重新投递", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-native-semantic-"));
  try {
    const entries = [
      { id: "user_1", kind: "message", content: "用户：第一问", source: { type: "conversation", id: "user_1", version: "user_1" } },
      { id: "assistant_1", kind: "message", content: "助手：第一答", source: { type: "conversation", id: "assistant_1", version: "assistant_1" } },
    ];
    const hub = new ContextHub({ dataRoot, actor, sources: { conversation: async () => entries } });
    const firstSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_semantic_1", scope, budget: { maxTokens: 100, reservedOutputTokens: 10 } });
    const first = (await hub.assemble(firstSession.id)).delivery;
    await hub.acknowledge({ bindingKey: "binding_semantic", nativeSessionId: "native_1", delivery: first });
    const secondSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_semantic_2", scope, budget: { maxTokens: 100, reservedOutputTokens: 10 } });
    const assembled = (await hub.assemble(secondSession.id)).delivery;
    assert.equal((await hub.deliveryForBinding("binding_semantic", assembled, "native_1")).entries.length, 0);
    assert.deepEqual((await hub.deliveryForBinding("binding_semantic", assembled, "native_2")).entries.map((entry) => entry.id), ["user_1", "assistant_1"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("A 到 B 全量补齐 1-3，切回 A 只补齐 A 未见的 4-5", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-agent-transcript-"));
  try {
    const hub = new ContextHub({ dataRoot, actor });
    const transcript = Array.from({ length: 5 }, (_, index) => {
      const turn = index + 1;
      return [
        { key: `conversation:user-${turn}`, version: `user-${turn}`, content: `用户：问题 ${turn}` },
        { key: `conversation:assistant-${turn}`, version: `assistant-${turn}`, content: `助手：回答 ${turn}` },
      ];
    }).flat();

    await hub.acknowledgeKnowledge({
      bindingKey: "binding_A",
      nativeSessionId: "native_A",
      units: transcript.slice(0, 6),
    });
    assert.deepEqual(
      (await hub.unacknowledgedKnowledge({ bindingKey: "binding_B", nativeSessionId: "native_B", units: transcript.slice(0, 6) }))
        .map((entry) => entry.key),
      transcript.slice(0, 6).map((entry) => entry.key),
    );

    await hub.acknowledgeKnowledge({
      bindingKey: "binding_B",
      nativeSessionId: "native_B",
      units: transcript,
    });
    assert.deepEqual(
      (await hub.unacknowledgedKnowledge({ bindingKey: "binding_A", nativeSessionId: "native_A", units: transcript }))
        .map((entry) => entry.key),
      transcript.slice(6).map((entry) => entry.key),
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("内容相同但消息身份不同的聊天轮次仍按完整记录增量投递", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-duplicate-transcript-"));
  try {
    let entries = [
      { id: "user_repeat_1", kind: "message", content: "用户：再检查一次", source: { type: "conversation", id: "user_repeat_1", version: "user_repeat_1" } },
    ];
    const hub = new ContextHub({ dataRoot, actor, sources: { conversation: async () => entries } });
    const firstSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_repeat_1", scope, budget: { maxTokens: 100, reservedOutputTokens: 10 } });
    const first = (await hub.assemble(firstSession.id)).delivery;
    await hub.acknowledge({ bindingKey: "binding_repeat", nativeSessionId: "native_repeat", delivery: first });

    entries = [
      ...entries,
      { id: "user_repeat_2", kind: "message", content: "用户：再检查一次", source: { type: "conversation", id: "user_repeat_2", version: "user_repeat_2" } },
    ];
    const secondSession = await hub.createSession({ consumer: "remote-agent", consumerId: "task_repeat_2", scope, budget: { maxTokens: 100, reservedOutputTokens: 10 } });
    const delta = await hub.deliveryForBinding("binding_repeat", (await hub.assemble(secondSession.id)).delivery, "native_repeat");
    assert.deepEqual(delta.entries.map((entry) => entry.id), ["user_repeat_2"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Embedding 文件片段在同一原生会话去重，原生会话变化后重新交付正文", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-resource-session-"));
  try {
    const unit = {
      key: "resource:project-guide:chunk-3",
      version: "resource-version-9",
      content: "生产环境发布窗口为每周三晚间。",
    };
    const hub = new ContextHub({ dataRoot, actor });
    await hub.stageKnowledge({ bindingKey: "binding_resource", taskId: "task_resource_1", units: [unit] });
    const firstSession = await hub.createSession({
      consumer: "remote-agent",
      consumerId: "task_resource_1",
      scope,
      budget: { maxTokens: 100, reservedOutputTokens: 10 },
    });
    const first = await hub.deliveryForBinding("binding_resource", (await hub.assemble(firstSession.id)).delivery);
    assert.deepEqual(first.entries.map((entry) => entry.content.value), [unit.content]);
    await hub.acknowledge({ bindingKey: "binding_resource", nativeSessionId: "native_1", delivery: first });

    await hub.stageKnowledge({ bindingKey: "binding_resource", taskId: "task_resource_2", units: [unit] });
    const secondSession = await hub.createSession({
      consumer: "remote-agent",
      consumerId: "task_resource_2",
      scope,
      budget: { maxTokens: 100, reservedOutputTokens: 10 },
    });
    const assembled = (await hub.assemble(secondSession.id)).delivery;
    assert.equal((await hub.deliveryForBinding("binding_resource", assembled, "native_1")).entries.length, 0);
    assert.deepEqual(
      (await hub.deliveryForBinding("binding_resource", assembled, "native_2")).entries.map((entry) => entry.content.value),
      [unit.content],
    );
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("绑定知识账本按语义键和版本去重，版本更新或原生会话变化时重新投递", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-knowledge-"));
  try {
    const hub = new ContextHub({ dataRoot, actor });
    await hub.acknowledgeKnowledge({
      bindingKey: "binding_knowledge",
      nativeSessionId: "native_1",
      units: [{ key: "skill:cluster-guide", version: "1.0.0", content: "第一版规范" }],
    });
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_knowledge",
      nativeSessionId: "native_1",
      units: [{ key: "skill:cluster-guide", version: "1.0.0", content: "即使展示格式变化也不重发" }],
    }), []);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_knowledge",
      nativeSessionId: "native_1",
      units: [{ key: "skill:cluster-guide", version: "2.0.0", content: "第二版规范" }],
    }), [{ key: "skill:cluster-guide", version: "2.0.0", content: "第二版规范" }]);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_knowledge",
      nativeSessionId: "native_1",
      units: [{ key: "memory:independent-fact", version: "1", content: "第一版规范" }],
    }), [{ key: "memory:independent-fact", version: "1", content: "第一版规范" }]);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_knowledge",
      nativeSessionId: "native_2",
      units: [{ key: "skill:cluster-guide", version: "1.0.0", content: "第一版规范" }],
    }), [{ key: "skill:cluster-guide", version: "1.0.0", content: "第一版规范" }]);
    await hub.acknowledgeKnowledge({
      bindingKey: "binding_resource",
      nativeSessionId: "native_1",
      units: [{ key: "resource:guide:chunk-7", version: "resource-v3", content: "Embedding 命中的正文片段" }],
    });
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_resource",
      nativeSessionId: "native_1",
      units: [{ key: "resource:guide:chunk-7", version: "resource-v3", content: "Embedding 命中的正文片段" }],
    }), []);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_resource",
      nativeSessionId: "native_2",
      units: [{ key: "resource:guide:chunk-7", version: "resource-v3", content: "Embedding 命中的正文片段" }],
    }), [{ key: "resource:guide:chunk-7", version: "resource-v3", content: "Embedding 命中的正文片段" }]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("原生对话回执按 Task 检查点回退，并把分支前缀复制到新的原生会话", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-checkpoints-"));
  try {
    const hub = new ContextHub({ dataRoot, actor });
    const firstKnowledge = { key: "skill:platform-guide", version: "1", content: "平台规范第一版" };
    const secondKnowledge = { key: "skill:platform-guide", version: "2", content: "平台规范第二版" };
    await hub.acknowledgeSemanticContent({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      values: ["用户：第一问", "助手：第一答"],
    });
    await hub.acknowledgeKnowledge({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      units: [firstKnowledge],
    });
    await hub.checkpointBinding({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      checkpointId: "task_1",
      nativeBoundary: { protocol: "codex", sessionId: "native_source", turnId: "turn_1", rolloutPath: "/rollouts/native_source.jsonl" },
    });

    await hub.acknowledgeSemanticContent({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      values: ["用户：第二问", "助手：第二答"],
    });
    await hub.acknowledgeKnowledge({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      units: [secondKnowledge],
    });
    await hub.checkpointBinding({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      checkpointId: "task_2",
      nativeBoundary: { protocol: "codex", sessionId: "native_source", turnId: "turn_2", rolloutPath: "/rollouts/native_source.jsonl" },
    });

    assert.equal((await hub.getBindingCheckpoint({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      checkpointId: "task_2",
    })).nativeBoundary.turnId, "turn_2");

    await hub.forkBindingCheckpoint({
      sourceBindingKey: "binding_source",
      sourceNativeSessionId: "native_source",
      targetBindingKey: "binding_target",
      targetNativeSessionId: "native_target",
      checkpointId: "task_1",
      inheritedUnits: [{
        key: "conversation:target-message-1",
        version: "target-message-version-1",
        content: "用户：第一问",
      }],
    });
    assert.deepEqual(await hub.listBindingCheckpointIds({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
    }), ["task_1", "task_2"]);
    assert.deepEqual(await hub.listBindingCheckpointIds({
      bindingKey: "binding_target",
      nativeSessionId: "native_target",
    }), ["task_1"]);
    assert.deepEqual((await hub.getBindingCheckpoint({
      bindingKey: "binding_target",
      nativeSessionId: "native_target",
      checkpointId: "task_1",
    })).nativeBoundary, {
      protocol: "codex",
      sessionId: "native_target",
      turnId: "turn_1",
      rolloutPath: "/rollouts/native_source.jsonl",
    });
    await hub.forkBindingCheckpoint({
      sourceBindingKey: "binding_source",
      sourceNativeSessionId: "native_source",
      targetBindingKey: "binding_mapped_target",
      targetNativeSessionId: "native_mapped_target",
      checkpointId: "task_2",
      nativeBoundaryMap: { turn_1: "child_turn_1", turn_2: "child_turn_2" },
      targetNativeBoundary: { protocol: "v1", rolloutPath: "/rollouts/native_mapped_target.jsonl" },
    });
    assert.deepEqual((await hub.getBindingCheckpoint({
      bindingKey: "binding_mapped_target",
      nativeSessionId: "native_mapped_target",
      checkpointId: "task_1",
    })).nativeBoundary, {
      protocol: "v1",
      sessionId: "native_mapped_target",
      turnId: "child_turn_1",
      rolloutPath: "/rollouts/native_mapped_target.jsonl",
    });
    assert.equal((await hub.getBindingCheckpoint({
      bindingKey: "binding_mapped_target",
      nativeSessionId: "native_mapped_target",
      checkpointId: "task_2",
    })).nativeBoundary.turnId, "child_turn_2");
    assert.deepEqual(await hub.listBindingCheckpointIds({
      bindingKey: "binding_target",
      nativeSessionId: "stale_native_target",
    }), []);
    assert.deepEqual(await hub.unacknowledgedSemanticContent({
      bindingKey: "binding_target",
      nativeSessionId: "native_target",
      values: ["用户：第一问", "用户：第二问"],
    }), ["用户：第二问"]);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_target",
      nativeSessionId: "native_target",
      units: [
        firstKnowledge,
        secondKnowledge,
        { key: "conversation:target-message-1", version: "target-message-version-1", content: "用户：第一问" },
      ],
    }), [secondKnowledge]);

    await hub.restoreBindingCheckpoint({
      bindingKey: "binding_target",
      nativeSessionId: "native_target",
      checkpointId: "task_1",
    });
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_target",
      nativeSessionId: "native_target",
      units: [{ key: "conversation:target-message-1", version: "target-message-version-1", content: "用户：第一问" }],
    }), [], "restoring the native fork boundary must retain cloned webpage message identities");

    await hub.restoreBindingCheckpoint({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      checkpointId: "task_1",
    });
    assert.equal(await hub.getBindingCheckpoint({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      checkpointId: "task_2",
    }), null);
    assert.deepEqual(await hub.unacknowledgedSemanticContent({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      values: ["助手：第一答", "助手：第二答"],
    }), ["助手：第二答"]);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_source",
      nativeSessionId: "native_source",
      units: [firstKnowledge, secondKnowledge],
    }), [secondKnowledge]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Task 待确认知识跨进程恢复，只有原生会话确证后才推进账本", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-pending-knowledge-"));
  try {
    const unit = { key: "memory:project-goal", version: "3", content: "项目目标第三版" };
    const first = new ContextHub({ dataRoot, actor });
    await first.stageKnowledge({ bindingKey: "binding_pending", taskId: "task_pending", units: [unit] });
    const session = await first.createSession({
      consumer: "remote-agent",
      consumerId: "task_pending",
      scope,
      budget: { maxTokens: 100, reservedOutputTokens: 10 },
    });
    const delivery = (await first.assemble(session.id)).delivery;
    await first.stageDeliveredKnowledge({
      bindingKey: "binding_pending",
      taskId: "task_pending",
      delivery,
    });

    const recovered = new ContextHub({ dataRoot, actor });
    assert.deepEqual(await recovered.unacknowledgedKnowledge({
      bindingKey: "binding_pending",
      nativeSessionId: "native_pending",
      units: [unit],
    }), [unit]);
    await recovered.acknowledgeStagedKnowledge({
      bindingKey: "binding_pending",
      nativeSessionId: "native_pending",
      taskId: "task_pending",
    });
    assert.deepEqual(await recovered.unacknowledgedKnowledge({
      bindingKey: "binding_pending",
      nativeSessionId: "native_pending",
      units: [unit],
    }), []);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("待确认文件知识会进入本轮远端交付并由原生会话回执去重", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-pending-resource-"));
  try {
    const unit = {
      key: "resource:remote-download:chunk-1",
      version: "1.0.0:hash-a",
      content: "下载地址由站内代理生成，不向用户暴露远端凭据。",
    };
    const hub = new ContextHub({ dataRoot, actor });
    await hub.stageKnowledge({ bindingKey: "binding_resource", taskId: "task_resource", units: [unit] });
    const session = await hub.createSession({
      consumer: "remote-agent",
      consumerId: "task_resource",
      scope,
      budget: { maxTokens: 100, reservedOutputTokens: 10 },
    });
    const delivery = (await hub.assemble(session.id)).delivery;
    assert.equal(delivery.entries.length, 1);
    assert.equal(delivery.entries[0].kind, "resource");
    assert.equal(delivery.entries[0].source.type, "resource");
    assert.equal(delivery.entries[0].content.value, unit.content);

    await hub.acknowledge({ bindingKey: "binding_resource", nativeSessionId: "native_resource", delivery });
    assert.equal((await hub.deliveryForBinding("binding_resource", delivery, "native_resource")).entries.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("待确认知识只回执预算和原生会话筛选后实际交付的语义单元", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-context-exact-delivery-"));
  try {
    const deliveredUnit = { key: "resource:guide:chunk-1", version: "v1", content: "短片段" };
    const omittedUnit = { key: "resource:guide:chunk-2", version: "v1", content: "这个片段因为上下文预算不足而没有进入实际交付" };
    const hub = new ContextHub({
      dataRoot,
      actor,
      tokenEstimator: (value) => String(value).length,
    });
    await hub.stageKnowledge({
      bindingKey: "binding_exact",
      taskId: "task_exact",
      units: [deliveredUnit, omittedUnit],
    });
    const session = await hub.createSession({
      consumer: "remote-agent",
      consumerId: "task_exact",
      scope,
      budget: { maxTokens: 8, reservedOutputTokens: 0 },
    });
    const assembled = await hub.assemble(session.id);
    assert.equal(assembled.delivery.entries.length, 1);
    assert.equal(assembled.delivery.entries[0].content.value, deliveredUnit.content);

    await hub.stageDeliveredKnowledge({
      bindingKey: "binding_exact",
      taskId: "task_exact",
      delivery: assembled.delivery,
    });
    await hub.acknowledgeStagedKnowledge({
      bindingKey: "binding_exact",
      nativeSessionId: "native_exact",
      taskId: "task_exact",
    });

    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_exact",
      nativeSessionId: "native_exact",
      units: [deliveredUnit],
    }), []);
    assert.deepEqual(await hub.unacknowledgedKnowledge({
      bindingKey: "binding_exact",
      nativeSessionId: "native_exact",
      units: [omittedUnit],
    }), [omittedUnit]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
