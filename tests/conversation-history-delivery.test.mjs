import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createActorContext } from "../gateway/core/actor.mjs";
import { ContextHub } from "../gateway/core/context-hub/index.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import { createAgentBindingKey, createEffectiveContextScope, computeServerIdentity } from "../gateway/core/scope.mjs";
import { RemoteTaskLifecycle, workConversationTranscriptFragments } from "../gateway/core/runtime/services.mjs";

const prompts = new PromptRepository({ promptRoot: fileURLToPath(new URL("../prompts", import.meta.url)) });
for (const agentId of ["codex", "claude-code", "opencode"]) {
  test(`${agentId}: 同一原生对话不补发，A 123 → B 45 → A 仅补发缺少正文，前端交接为空`, async (t) => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-history-delivery-"));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
      await fs.rm(dataRoot, { recursive: true, force: true });
    });
    const actor = createActorContext({ actorType: "user", actorId: "history-user", userId: "history-user", deviceId: "history-device", sessionId: "test-session", roles: [] });
    const selected = { actorType: "user", actorId: actor.actorId, conversationId: "history-conv", branchId: "history-branch", contextEpoch: 0,
      serverId: "history-server", serverIdentity: computeServerIdentity({host:"history.example",port:22,hostKeyFingerprint:"SHA256:historytestfingerprint"}).serverIdentity, workspaceId: "history-workspace", agentId };
    const tasks = new Map(), bindings = new Map(), messages = [], deliveries = [];
    const container = {
      actor, runtime: { prompts }, contextHub: new ContextHub({ dataRoot, actor }),
      baseConversations: {
        async getConversation() { return { summary: { id: selected.conversationId, mode: "work", projectId: null, activeBranchId: selected.branchId } }; },
        async listMessages() { return { items: messages, nextCursor: null }; },
      },
      taskRuntime: { async loadBinding(id) { return bindings.get(id) || null; } },
      taskStore: {
        async getTask(id) { return tasks.get(id) || null; },
        async scanTasks() { return [...tasks.values()]; },
        async listTasks({ statuses } = {}) { return [...tasks.values()].filter(task => !statuses || statuses.includes(task.status)); },
      },
      memoryCoordinator: { async registerTask(input) { assert.deepEqual(input.observedKnowledge, []); } },
      orchestrator: {
        async create(input) {
          const task = { ...input, createdAt: new Date(tasks.size * 1000).toISOString(), status: "queued" };
          tasks.set(task.id, task); return { task };
        },
        async start(id) {
          const task = tasks.get(id);
          let binding = bindings.get(task.agentBindingId);
          if (!binding) { binding = { native: { sessionId: `native-${bindings.size}` } }; bindings.set(task.agentBindingId, binding); }
          const assembled = await container.contextHub.assemble(task.contextSessionId);
          const delivery = await container.contextHub.deliveryForBinding(task.agentBindingId, assembled.delivery, binding.native.sessionId);
          deliveries.push(delivery);
          await container.contextHub.stageDeliveredKnowledge({ bindingKey: task.agentBindingId, taskId: id, delivery });
          await container.contextHub.acknowledge({ bindingKey: task.agentBindingId, nativeSessionId: binding.native.sessionId, delivery });
          await container.contextHub.acknowledgeStagedKnowledge({ bindingKey: task.agentBindingId, nativeSessionId: binding.native.sessionId, taskId: id });
          task.startedAt = new Date().toISOString(); task.status = "running";
          return { taskId: id, status: "running" };
        },
      },
    };
    async function turn(number, contextEpoch) {
      const scope = { ...selected, contextEpoch };
      const user = { id: `u${number}`, role: "user", content: number === 2 || number === 3 ? "继续" : `提问${number}`, replyToMessageId: messages.at(-1)?.id || null };
      messages.push(user);
      const lifecycle = new RemoteTaskLifecycle(container, { messageId: user.id, providerId: "provider", modelId: "model" });
      const result = await lifecycle.create({ scope, userMessage: user.content, handoffFragments: [], idempotencyKey: `turn-${number}` });
      assert.deepEqual(result.handoffFragments, [], "后台历史不得变成前端已发送资料或网页模型候选");
      assert.equal(result.task.goal, user.content, "历史不写进当前提问");
      const answer = { id: `a${number}`, role: "assistant", content: `正文回答${number}`, replyToMessageId: user.id, taskId: result.task.id };
      messages.push(answer); result.task.status = "completed";
      const units = (await workConversationTranscriptFragments([user, answer], null, prompts)).map(f=>f.knowledge);
      const bindingKey = createAgentBindingKey(scope, agentId);
      await container.contextHub.acknowledgeKnowledge({ bindingKey, nativeSessionId: bindings.get(bindingKey).native.sessionId, units });
      const delivery = deliveries.at(-1);
      return { ids: delivery.entries.map(entry=>entry.source.id), prompt: await prompts.remoteDelivery(delivery, user.content), lifecycle, scope };
    }
    assert.deepEqual((await turn(1, 0)).ids, []);
    assert.deepEqual((await turn(2, 0)).ids, []);
    assert.deepEqual((await turn(3, 0)).ids, []);
    const firstB = await turn(4, 1);
    assert.deepEqual(firstB.ids, ["u1", "a1", "u2", "a2", "u3", "a3"]);
    assert.match(firstB.prompt, /## 历史记录/);
    assert.equal(firstB.prompt.match(/继续/g)?.length, 2, "重复文字的两个历史提问均保留");
    assert.doesNotMatch(firstB.prompt, /candidate_id|conversation_sync|binding|账本|已检索资料/);
    assert.deepEqual((await turn(5, 1)).ids, []);
    container.contextHub = new ContextHub({ dataRoot, actor });
    const backA = await turn(6, 0);
    assert.deepEqual(backA.ids, ["u4", "a4", "u5", "a5"]);
    assert.match(backA.prompt, /正文回答4[\s\S]*正文回答5[\s\S]*当前用户请求[\s\S]*提问6/);
    assert.deepEqual((await turn(7, 0)).ids, []);
    const unacknowledgedKnowledge = container.contextHub.unacknowledgedKnowledge;
    container.contextHub.unacknowledgedKnowledge = () => { throw new Error("同一会话不应检查正文缺失收据"); };
    assert.deepEqual(await backA.lifecycle.conversationHistoryForBinding(backA.scope), []);
    container.contextHub.unacknowledgedKnowledge = unacknowledgedKnowledge;

    // Switching back to an existing B can fail before native receives input.
    // That attempt must not make the next B request look like a delivered turn.
    const start = container.orchestrator.start;
    container.orchestrator.start = async (id) => {
      tasks.get(id).status = "failed";
      throw new Error("remote preparation failed before delivery");
    };
    await assert.rejects(turn(8, 1), /preparation failed/);
    container.orchestrator.start = start;
    const retriedB = await turn(9, 1);
    assert.deepEqual(retriedB.ids, ["u6", "a6", "u7", "a7"]);
    assert.doesNotMatch(retriedB.prompt, /提问8/);
  });
}

test("历史正文不因检索预算变小而丢失末尾，当前提问相同文字仍各归其位", async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-history-budget-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataRoot)), path.resolve(os.tmpdir()));
    await fs.rm(dataRoot, { recursive: true, force: true });
  });
  const actor = createActorContext({ actorType: "user", actorId: "history-budget", userId: "history-budget", deviceId: "history-device", sessionId: "session", roles: [] });
  const hub = new ContextHub({ dataRoot, actor, tokenEstimator: value => value.length });
  const scope = createEffectiveContextScope({ actor, conversationId: "conv", branchId: "main", contextEpoch: 0, memoryMode: "project-only" });
  const session = await hub.createSession({ consumer: "remote-agent", consumerId: "task", scope, budget: { maxTokens: 16, reservedOutputTokens: 4 } });
  await hub.stageKnowledge({ bindingKey: "binding", taskId: "task", units: [
    { key: "conversation:u1", version: "u1", content: "- 用户：继续" },
    { key: "conversation:a1", version: "a1", content: "- 助手：" + "长正文".repeat(100) },
    { key: "conversation:u2", version: "u2", content: "- 用户：继续" },
    { key: "conversation:a2", version: "a2", content: "- 助手：末尾完整保留" },
  ] });
  const { delivery } = await hub.assemble(session.id);
  assert.deepEqual(delivery.entries.map(entry=>entry.source.id), ["u1", "a1", "u2", "a2"]);
  const rendered = await prompts.remoteDelivery(delivery, "继续");
  assert.equal(rendered.match(/继续/g)?.length, 3);
  assert.match(rendered, /末尾完整保留/);
});
