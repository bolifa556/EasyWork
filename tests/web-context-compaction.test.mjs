import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { createGatewayServer } from "../gateway/core/server.mjs";
import { conversationCompactionBatch } from "../gateway/core/runtime/services.mjs";

async function fixture(t, { tokens = 111_000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-web-compact-"));
  const compactCalls = [];
  const modelCalls = [];
  const gateway = await createGatewayServer({ runtimeOptions: { dataRoot: path.join(root, "data"), webModelFactory: ({ providerId, modelId }) => ({
    async complete({ messages }) {
      const system = String(messages[0]?.content || "");
      if (system.includes("# 对话上下文压缩")) {
        compactCalls.push({ providerId, modelId, messages });
        return { content: "目标：核对资料。已确认：项目代号 A-551。下一步继续。" };
      }
      if (system.includes("只输出标题本身")) return { content: "压缩验证" };
      if (system.includes("# 可复用记忆提取")) return { content: "" };
      modelCalls.push(messages);
      return { content: "收到。", usage: { prompt_tokens: tokens, completion_tokens: 3, total_tokens: tokens + 3 } };
    },
  }) } });
  t.after(async () => { await gateway.close(); await fs.rm(root, { recursive: true, force: true }); });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  let token;
  const request = async (pathname, body, method = "POST") => {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { method, headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  token = (await request("/api/auth/register", { username: "compact-user", password: "compact-password", deviceId: "compact-device" })).data.token;
  const session = await gateway.runtime.auth.resolveSession(token);
  const services = await gateway.runtime.servicesForActor(session.actor);
  const created = await request("/api/conversations", { mode: "chat", expectedRevision: 0, content: `项目代号 A-551。${"原始长资料。".repeat(1500)}`, response: { providerId: "old-provider", modelId: "old-model", scope: {} } });
  assert.equal(created.status, 200, JSON.stringify(created.error));
  const id = created.data.conversation.id;
  await services.interactions.waitFor(created.data.response.runId);
  await services.taskRuntime.waitForIdle();
  return { request, services, id, compactCalls, modelCalls };
}

test("手动压缩一组长问答使用刚选择的模型，真实生成摘要且保留原始消息", async (t) => {
  const { request, services, id, compactCalls } = await fixture(t);
  assert.equal(compactCalls.length, 0, "56% 不触发 95% 的自动阈值");
  const before = await services.conversationContext.get(id);
  assert.equal(before.usage.source, "native");
  const result = await request(`/api/conversations/${id}/context/compact`, { providerId: "selected-provider", modelId: "selected-model" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.compaction, { status: "completed", coveredMessageCount: 2, providerId: "selected-provider", modelId: "selected-model" });
  assert.equal(result.data.compressing, false);
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].modelId, "selected-model");
  assert.equal(compactCalls[0].providerId, "selected-provider");
  assert.equal(result.data.usage.source, "estimated");
  assert.ok(result.data.usage.usedTokens < before.usage.usedTokens / 10);
  const detail = await services.baseConversations.getConversation(id);
  const history = await services.conversationContext.history(id, detail.summary.activeBranchId);
  assert.equal(history.length, 1);
  assert.equal(history[0].role, "system");
  assert.match(history[0].content, /A-551/);
  assert.doesNotMatch(history[0].content, /原始长资料/);
  assert.equal((await services.baseConversations.listMessages({ conversationId: id })).items.length, 2);
  const again = await request(`/api/conversations/${id}/context/compact`, { providerId: "selected-provider", modelId: "selected-model" });
  assert.equal(again.data.compaction.status, "skipped");
  assert.equal(compactCalls.length, 1, "没有新问答时不再次调用模型");
});

test("自动压缩已启用，一轮长对话达到阈值也压缩并沿用本轮模型", async (t) => {
  const { services, id, compactCalls } = await fixture(t, { tokens: 195_000 });
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].providerId, "old-provider");
  assert.equal(compactCalls[0].modelId, "old-model");
  assert.equal((await services.conversationContext.get(id)).usage.source, "estimated");
});

test("保存阈值触发压缩也采用当前选择，缺一半的模型路由被拒绝", async (t) => {
  const { request, services, id, compactCalls } = await fixture(t);
  const config = await services.conversationContext.get(id);
  const invalid = await request(`/api/conversations/${id}/context/compact`, { modelId: "new-model" });
  assert.equal(invalid.status, 409);
  const saved = await request(`/api/conversations/${id}/context`, { maxTokens: 120_000, autoCompactThreshold: 0.9, providerId: "new-provider", modelId: "new-model", expectedRevision: config.revision }, "PATCH");
  assert.equal(saved.status, 200);
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].providerId, "new-provider");
  assert.equal(compactCalls[0].modelId, "new-model");
});

test("手动压缩包含最新完整问答，Chat/Work 未结束的用户追加仍留在上下文", () => {
  const history = [
    { id: "u1", role: "user", content: "已完成问题" },
    { id: "a1", role: "assistant", replyToMessageId: "u1", content: "答案" },
    { id: "u2", role: "user", content: "仍在运行" },
    { id: "u3", role: "user", replyToMessageId: "u2", content: "补充要求" },
  ];
  assert.deepEqual(conversationCompactionBatch(history, 0).covered.map((entry) => entry.id), ["u1", "a1"]);
  assert.deepEqual(conversationCompactionBatch(history.slice(2), 0).covered, []);
});
