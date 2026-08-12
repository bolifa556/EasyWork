import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEasyWorkRuntime } from "../gateway/core/runtime/runtime.mjs";

function projectMemoryModelFactory({ runId }) {
  let iteration = 0;
  return {
    async complete({ messages }) {
      const system = String(messages[0]?.content || "");
      if (system.includes("# 可复用记忆提取")) {
        const exchange = JSON.parse(messages.at(-1).content);
        const memories = exchange.assistantMessage.includes("8789")
          ? [{ level: "project", semanticKey: "service-port", content: "项目服务端口为 8789", confidence: 1 }]
          : [];
        return { content: JSON.stringify({ memories }), reasoning: "", toolCalls: [], usage: null };
      }
      const user = messages.findLast((entry) => entry.role === "user")?.content || "";
      if (user.includes("记住")) return { content: "已确认项目服务端口为 8789。", reasoning: "", toolCalls: [], usage: null };
      if (iteration++ === 0) {
        return {
          content: "",
          reasoning: "",
          toolCalls: [{ id: `${runId}:search`, name: "memory_search", input: { query: "项目服务端口" } }],
          usage: null,
        };
      }
      const tool = messages.findLast((entry) => entry.role === "tool");
      return { content: `跨对话读取：${tool.content}`, reasoning: "", toolCalls: [], usage: null };
    },
  };
}

async function fixture(t, webModelFactory = projectMemoryModelFactory) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-runtime-memory-"));
  const runtime = await createEasyWorkRuntime({ dataRoot: path.join(root, "data"), webModelFactory });
  t.after(async () => {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const registered = await runtime.auth.register({ username: `memory-${Date.now()}`, password: "password-value", deviceId: "device-a" });
  const session = await runtime.auth.resolveSession(registered.token);
  return { runtime, services: await runtime.servicesForActor(session.actor) };
}

test("Web Agent 在每轮冻结快照后跨对话读取同项目记忆", async (t) => {
  const { services } = await fixture(t);
  const project = await services.projects.create({ name: "Memory Project" });
  const first = await services.conversations.sendMessage({
    mode: "chat",
    projectId: project.id,
    content: "记住这个项目的服务端口",
    expectedRevision: 0,
    commandId: "memory-first-message",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(first.response.runId);
  await services.waitForIdle();

  const second = await services.conversations.sendMessage({
    mode: "chat",
    projectId: project.id,
    content: "另一个对话里项目服务端口是多少？",
    expectedRevision: 0,
    commandId: "memory-second-message",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(second.response.runId);
  const messages = await services.baseConversations.listMessages({ conversationId: second.conversation.id, branchId: second.branchId, limit: 20 });
  assert.match(messages.items.at(-1).content, /项目服务端口为 8789/);
});

test("独立记忆提取失败不影响网页最终回复落盘", async (t) => {
  const { services } = await fixture(t, ({ runId }) => ({
    async complete({ messages }) {
      if (String(messages[0]?.content || "").includes("# 可复用记忆提取")) throw new Error("extractor failed");
      return { content: `reply:${runId}`, reasoning: "", toolCalls: [], usage: null };
    },
  }));
  const sent = await services.conversations.sendMessage({
    mode: "chat",
    content: "仍需回复",
    expectedRevision: 0,
    commandId: "memory-extraction-failure",
    response: { providerId: "platform-web", modelId: "memory-model", scope: {} },
  });
  await services.interactions.waitFor(sent.response.runId);
  await services.waitForIdle();
  const messages = await services.baseConversations.listMessages({ conversationId: sent.conversation.id, branchId: sent.branchId, limit: 20 });
  assert.match(messages.items.at(-1).content, /^reply:web_/);
  assert.equal((await services.memory.snapshot(await services.memoryCoordinator.freezeScope({
    actorType: services.actor.actorType,
    actorId: services.actor.actorId,
    userId: services.actor.userId,
    projectId: null,
    conversationId: sent.conversation.id,
    workspaceId: null,
    taskId: null,
    serverId: null,
    serverIdentity: null,
    versionDomainId: null,
    memoryMode: "global",
    branchId: sent.branchId,
    memorySnapshotSequence: 0,
    memorySnapshotVersionIds: [],
    resourceBindingSnapshotId: null,
    selectedCollectionIds: [],
    selectedSkillVersions: [],
    capabilities: [],
    contextEpoch: 0,
  }))).versionIds.length, 0);
});
