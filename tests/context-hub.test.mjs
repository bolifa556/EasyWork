import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { ContextHub } from "../gateway/core/context-hub/index.mjs";
import { createEffectiveContextScope } from "../gateway/core/scope.mjs";

const actor = createActorContext({ actorType: "guest", actorId: "guest_a", deviceId: "device_a", sessionId: "session_a", roles: [] });
const scope = createEffectiveContextScope({
  actor,
  conversationId: "conversation_a",
  branchId: "main",
  memoryMode: "project-only",
  contextEpoch: 0,
});

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
    const second = await hub.deliveryForBinding("binding_a", assembled.delivery);
    assert.equal(second.mode, "delta");
    assert.equal(second.entries.length, 0);
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
    const returningAgent = await hub.deliveryForBinding("binding_opencode", assembled);
    assert.equal(returningAgent.mode, "delta");
    assert.deepEqual(returningAgent.entries.map((entry) => entry.id), ["memory_2"]);
    await hub.acknowledge({ bindingKey: "binding_opencode", nativeSessionId: "native_opencode", delivery: returningAgent });

    const switchedAgent = await hub.deliveryForBinding("binding_codex", assembled);
    assert.deepEqual(switchedAgent.entries.map((entry) => entry.id), ["memory_1", "memory_2"]);
    const noDuplicate = await hub.deliveryForBinding("binding_opencode", assembled);
    assert.equal(noDuplicate.entries.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
