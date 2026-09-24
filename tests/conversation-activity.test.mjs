import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGatewayServer } from "../gateway/core/server.mjs";
import { applyConversationActivity, mergeConversationActivity } from "../app/easywork/runtime/conversation-activity.ts";

const activity = (revision, runs = [], instanceId = "gateway-one") => ({ instanceId, revision, runs });

test("sidebar activity rejects stale replay and snapshots without replacing conversation rows", () => {
  const running = activity(1, [{ runId: "run", conversationId: "chat" }]);
  const current = { recentConversations: [{ id: "chat" }], conversationActivity: activity(0), runningTasks: [] };
  const live = applyConversationActivity(current, running);
  assert.equal(live.recentConversations, current.recentConversations);
  assert.equal(live.runningTasks, current.runningTasks);
  assert.equal(mergeConversationActivity(live.conversationActivity, activity(0)), running);
  const completed = applyConversationActivity(live, activity(2));
  assert.equal(applyConversationActivity(completed, running), completed);
  assert.equal(mergeConversationActivity(completed.conversationActivity, running), completed.conversationActivity);
  assert.equal(applyConversationActivity(completed, activity(50, running.runs, "old-process")), completed);
  const restarted = activity(0, [], "gateway-two");
  assert.equal(mergeConversationActivity(completed.conversationActivity, restarted), restarted);
  // Replay received while reconnect bootstrap is in flight is applied after
  // that snapshot establishes the new process, including events missed on a
  // different page. An old process's historical event still cannot win.
  const catchup = [activity(3, running.runs), activity(1, running.runs, "gateway-two")];
  const restored = catchup.reduce(applyConversationActivity, { ...current, conversationActivity: restarted });
  assert.deepEqual(restored.conversationActivity.runs, running.runs);
  assert.equal(restored.conversationActivity.instanceId, "gateway-two");
});

test("chat activity reaches the account stream and bootstrap, and stops on completion, failure and cancellation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-chat-activity-"));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n");
  const modelGates = [];
  const gateway = await createGatewayServer({ runtimeOptions: {
    dataRoot: path.join(root, "data"), helpFile,
    webModelFactory: () => ({ async complete({ messages, signal }) {
      const system = String(messages?.[0]?.content || "");
      if (system.includes("只输出标题本身") || system.includes("# 可复用记忆提取")) return { content: "测试", toolCalls: [], usage: {} };
      const gate = modelGates.shift();
      if (!gate) return { content: "完成", toolCalls: [], usage: {} };
      const abort = () => gate.reject(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try { return await gate.promise; }
      finally { signal?.removeEventListener("abort", abort); }
    } }),
  } });
  t.after(async () => { await gateway.close(); await fs.rm(root, { recursive: true, force: true }); });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  let token;
  const request = async (pathname, body, key) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method: body ? "POST" : "GET",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "idempotency-key": key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.data;
  };
  token = (await request("/api/auth/register", { username: "activity-user", password: "activity-password", deviceId: "activity-device" })).token;
  const session = await gateway.runtime.auth.resolveSession(token);
  const services = await gateway.runtime.servicesForActor(session.actor);
  const events = [];
  const waiters = new Set();
  const unsubscribe = services.broker.subscribe(`conversations:${session.actor.actorId}`, (event) => {
    if (event.kind !== "conversation.activity.updated") return;
    events.push(event);
    for (const resolve of waiters) resolve(event);
  });
  t.after(unsubscribe);
  const nextActivity = (revision) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`missing activity revision ${revision}`)); }, 10_000);
    const check = (event) => {
      if (event.payload.revision !== revision) return;
      clearTimeout(timer); waiters.delete(check); resolve(event.payload);
    };
    waiters.add(check);
    for (const event of events) check(event);
  });
  const begin = async (key) => {
    const gate = Promise.withResolvers();
    modelGates.push(gate);
    const result = await request("/api/conversations", { mode: "chat", content: key, expectedRevision: 0, response: { providerId: "platform-web", modelId: "fake-model", scope: {} } }, key);
    return { ...result, gate };
  };
  const first = await begin("first-chat");
  const second = await begin("second-chat");
  const running = await nextActivity(2);
  const bootstrap = await request("/api/bootstrap");
  assert.equal(bootstrap.runningTasks.length, 0, "chat does not need a remote Task");
  assert.deepEqual(bootstrap.conversationActivity, running);
  assert.deepEqual(new Set(running.runs.map((run) => run.conversationId)), new Set([first.conversation.id, second.conversation.id]));
  first.gate.resolve({ content: "完成", toolCalls: [], usage: {} });
  await services.interactions.waitFor(first.response.runId);
  assert.deepEqual((await nextActivity(3)).runs, [{ runId: second.response.runId, conversationId: second.conversation.id }]);
  second.gate.reject(new Error("model unavailable"));
  await assert.rejects(services.interactions.waitFor(second.response.runId), /model unavailable/);
  assert.deepEqual((await nextActivity(4)).runs, []);
  const third = await begin("cancel-chat");
  await nextActivity(5);
  await services.interactions.interruptConversation(third.conversation.id, { commandId: "stop-chat" });
  await assert.rejects(services.interactions.waitFor(third.response.runId), /请求已停止/);
  assert.deepEqual((await nextActivity(6)).runs, []);
  assert.deepEqual((await request("/api/bootstrap")).conversationActivity.runs, []);
});
