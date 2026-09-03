import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";

async function startGateway(runtimeOptions) {
  const gateway = await createGatewayServer({ runtimeOptions });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  return { gateway, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function requestJson(baseUrl, pathname, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

function recoveredModelFactory() {
  return {
    async complete({ messages, onDelta }) {
      const system = String(messages?.[0]?.content || "");
      if (system.includes("# 可复用记忆提取")) return { content: "", toolCalls: [], usage: {} };
      if (system.includes("不超过 14 个汉字")) return { content: "恢复回复", toolCalls: [], usage: {} };
      await onDelta?.({ kind: "content", content: "重启后完成。" });
      return { content: "重启后完成。", reasoning: "", toolCalls: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    },
  };
}

test("WebInteraction 重启后不会擅自恢复旧对话请求", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-web-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  let active = await startGateway({ dataRoot, helpFile, webModelFactory: recoveredModelFactory });
  t.after(async () => active?.gateway.close().catch(() => undefined));
  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "recovery-user", password: "recovery-password", deviceId: "recovery-device" },
  });
  const token = registered.payload.data.token;
  const created = await requestJson(active.baseUrl, "/api/conversations", {
    token,
    method: "POST",
    headers: { "idempotency-key": "recovery-first-message" },
    body: { mode: "chat", content: "请在重启后回答", expectedRevision: 0 },
  });
  const conversationId = created.payload.data.conversation.id;
  const messageId = created.payload.data.messageId;
  const commandId = "recovery-web-response";
  const session = await active.gateway.runtime.auth.resolveSession(token);
  const services = await active.gateway.runtime.servicesForActor(session.actor);
  const runId = `web_${crypto.createHash("sha256").update(`${session.actor.actorId}:${commandId}`).digest("hex").slice(0, 32)}`;
  await services.webInteractionStore.claim(runId, {
    conversationId,
    messageId,
    providerId: "platform-web",
    modelId: "fake-model",
    scope: {},
    commandId,
  });
  await active.gateway.close();

  active = await startGateway({ dataRoot, helpFile, webModelFactory: recoveredModelFactory });
  await active.gateway.runtime.actorRecoveryPromise;
  const inspected = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/runs/${runId}`, { token });
  assert.equal(inspected.response.status, 200);
  assert.equal(inspected.payload.data.status, "failed");
  assert.equal(inspected.payload.data.failure.code, "WEB_RUN_GATEWAY_RESTARTED");
  const messages = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/messages`, { token });
  assert.deepEqual(messages.payload.data.items.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "请在重启后回答" },
  ]);
});

test("历史版本在等待审批处误结算的 WebInteraction 可以重新打开", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-web-approval-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  const active = await startGateway({ dataRoot, helpFile, webModelFactory: recoveredModelFactory });
  t.after(async () => active.gateway.close().catch(() => undefined));
  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "approval-recovery-user", password: "approval-recovery-password", deviceId: "approval-recovery-device" },
  });
  const session = await active.gateway.runtime.auth.resolveSession(registered.payload.data.token);
  const services = await active.gateway.runtime.servicesForActor(session.actor);
  const runId = "web_approval_recovery";
  await services.webInteractionStore.claim(runId, {
    conversationId: "conversation-approval-recovery",
    messageId: "message-approval-recovery",
    providerId: "platform-web",
    modelId: "fake-model",
    scope: {},
    commandId: "approval-recovery-command",
  });
  await services.webInteractionStore.addTask(runId, "task-approval-recovery");
  await services.webInteractionStore.complete(runId, {
    assistantMessageId: null,
    result: { taskId: "task-approval-recovery", taskStatus: "waiting_approval" },
  });

  const resumable = await services.webInteractionStore.listResumable();
  assert.deepEqual(resumable.map((record) => record.runId), [runId]);
  const reopened = await services.webInteractionStore.reopen(runId);
  assert.equal(reopened.status, "running");
  assert.equal(reopened.assistantMessageId, null);
});

test("WebInteraction 重启后为历史静默失败补发一次可见原因", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-web-failure-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  let active = await startGateway({ dataRoot, helpFile, webModelFactory: recoveredModelFactory });
  t.after(async () => active?.gateway.close().catch(() => undefined));
  const registered = await requestJson(active.baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "failure-recovery-user", password: "failure-recovery-password", deviceId: "failure-recovery-device" },
  });
  const token = registered.payload.data.token;
  const created = await requestJson(active.baseUrl, "/api/conversations", {
    token,
    method: "POST",
    headers: { "idempotency-key": "failure-recovery-message" },
    body: { mode: "work", content: "执行远端任务", expectedRevision: 0 },
  });
  const conversationId = created.payload.data.conversation.id;
  const session = await active.gateway.runtime.auth.resolveSession(token);
  const services = await active.gateway.runtime.servicesForActor(session.actor);
  const commandId = "failure-recovery-response";
  const runId = `web_${crypto.createHash("sha256").update(`${session.actor.actorId}:${commandId}`).digest("hex").slice(0, 32)}`;
  await services.webInteractionStore.claim(runId, {
    conversationId,
    messageId: created.payload.data.messageId,
    providerId: "platform-web",
    modelId: "fake-model",
    scope: {},
    commandId,
  });
  await services.webInteractionStore.fail(runId, {
    code: "AGENT_SERVICE_START_FAILED",
    message: "OpenCode loopback 服务未就绪",
    retryable: true,
  });
  await active.gateway.close();

  active = await startGateway({ dataRoot, helpFile, webModelFactory: recoveredModelFactory });
  await active.gateway.runtime.actorRecoveryPromise;
  let replay = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events?limit=2000`, { token });
  let failures = replay.payload.data.events.filter((event) => event.kind === "run.failed" && event.ids.runId === runId);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].payload, {
    code: "AGENT_SERVICE_START_FAILED",
    message: "OpenCode loopback 服务未就绪",
    retryable: true,
  });

  await active.gateway.close();
  active = await startGateway({ dataRoot, helpFile, webModelFactory: recoveredModelFactory });
  await active.gateway.runtime.actorRecoveryPromise;
  replay = await requestJson(active.baseUrl, `/api/conversations/${conversationId}/events?limit=2000`, { token });
  failures = replay.payload.data.events.filter((event) => event.kind === "run.failed" && event.ids.runId === runId);
  assert.equal(failures.length, 1);
});
