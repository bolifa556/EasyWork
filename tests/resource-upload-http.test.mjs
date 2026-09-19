import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";

test("conversation images upload without configured OCR and are visible in messages and the first model request", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-image-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const observed = [];
  const gateway = await createGatewayServer({ runtimeOptions: {
    dataRoot: path.join(root, "data"),
    webModelFactory: () => ({ complete: async ({ messages }) => {
      observed.push(structuredClone(messages));
      return { content: "已查看图片。", reasoning: "", toolCalls: [], usage: null };
    } }),
  } });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  t.after(() => gateway.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const registered = await requestJson(baseUrl, "/api/auth/register", { method: "POST", body: { username: "image-user", password: "image-password", deviceId: "image-device" } });
  const token = registered.payload.data.token;
  const created = await requestJson(baseUrl, "/api/conversations", { token, method: "POST", body: { mode: "chat", content: "这张图是什么？" }, headers: { "if-match": '"0"', "idempotency-key": "image-conversation" } });
  assert.equal(created.response.status, 200, JSON.stringify(created.payload));
  const { conversation, messageId } = created.payload.data;
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG6kAAAAASUVORK5CYII=", "base64");
  const query = new URLSearchParams({ ownerType: "conversation", ownerId: conversation.id, messageId, filename: "photo.png", size: String(bytes.length), providerId: "platform-web", modelId: "vision-model" });
  const uploaded = await fetch(`${baseUrl}/api/resources/upload?${query}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/png", "x-content-sha256": crypto.createHash("sha256").update(bytes).digest("hex"), "if-match": '"0"', "idempotency-key": "image-upload" }, body: bytes });
  const upload = await uploaded.json();
  assert.equal(uploaded.status, 200, JSON.stringify(upload));
  assert.equal(upload.data.binding.messageId, messageId);
  const listed = await requestJson(baseUrl, `/api/conversations/${conversation.id}/messages`, { token });
  assert.equal(listed.payload.data.items[0].attachments[0].name, "photo.png");
  const preview = await requestJson(baseUrl, "/api/previews", { token, method: "POST", body: { source: { kind: "resource", resourceVersionId: upload.data.version.id } } });
  const content = await fetch(`${baseUrl}${preview.payload.data.delivery.endpoint}`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  const response = await requestJson(baseUrl, `/api/conversations/${conversation.id}/respond`, { token, method: "POST", body: { messageId, providerId: "platform-web", modelId: "vision-model", scope: { selectedResourceVersions: [upload.data.version.id] } }, headers: { "idempotency-key": "image-response" } });
  assert.equal(response.response.status, 200, JSON.stringify(response.payload));
  const session = await gateway.runtime.auth.resolveSession(token);
  const services = await gateway.runtime.servicesForActor(session.actor);
  await services.interactions.waitFor(response.payload.data.runId);
  await services.taskRuntime.waitForIdle();
  const userInput = observed.flat().find((entry) => entry.role === "user" && Array.isArray(entry.content));
  assert.ok(userInput, "first conversational request must include the original image without resource_read");
  assert.equal(userInput.content.find((part) => part.type === "image_url").image_url.url, `data:image/png;base64,${bytes.toString("base64")}`);
  observed.length = 0;
  const latest = await requestJson(baseUrl, `/api/conversations/${conversation.id}`, { token });
  const followUp = await requestJson(baseUrl, `/api/conversations/${conversation.id}/messages`, { token, method: "POST", body: { content: "继续解释刚才的图片。" }, headers: { "if-match": `"${latest.payload.data.summary.revision}"`, "idempotency-key": "image-followup" } });
  assert.equal(followUp.response.status, 200, JSON.stringify(followUp.payload));
  const second = await requestJson(baseUrl, `/api/conversations/${conversation.id}/respond`, { token, method: "POST", body: { messageId: followUp.payload.data.messageId, providerId: "platform-web", modelId: "vision-model" }, headers: { "idempotency-key": "image-followup-response" } });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  await services.interactions.waitFor(second.payload.data.runId);
  await services.taskRuntime.waitForIdle();
  const historyImage = observed.flat().find((entry) => entry.role === "user" && Array.isArray(entry.content));
  assert.ok(historyImage, "a text follow-up retains the prior image in its original user message");
  assert.deepEqual(historyImage.content, userInput.content);
});

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

test("资源上传使用二进制流并绕过 JSON 请求体上限", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-resource-upload-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# EasyWork\n", "utf8");
  const gateway = await createGatewayServer({ runtimeOptions: {
    dataRoot: path.join(root, "data"),
    helpFile,
    webModelFactory: () => ({
      complete: async ({ messages }) => ({
        content: String(messages[0]?.content || "").includes("# 文件发现简介")
          ? "一个用于验证流式上传与大文件处理的纯文本文件。"
          : "",
        reasoning: "",
        toolCalls: [],
        usage: null,
      }),
    }),
  } });
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  t.after(() => gateway.close());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const registered = await requestJson(baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username: "stream-user", password: "stream-password", deviceId: "stream-device" },
  });
  const token = registered.payload.data.token;
  const collection = await requestJson(baseUrl, "/api/collections", {
    token,
    method: "POST",
    body: { name: "大文件" },
  });
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 37, 0x61);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const query = new URLSearchParams({
    ownerType: "collection",
    ownerId: collection.payload.data.id,
    filename: "nested.txt",
    path: "folder/nested.txt",
    size: String(bytes.length),
    providerId: "platform-web",
    modelId: "summary-model",
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "text/plain",
    "x-content-sha256": sha256,
    "if-match": '"0"',
    "idempotency-key": "stream-resource-upload-0001",
  };
  const uploaded = await fetch(`${baseUrl}/api/resources/upload?${query}`, { method: "POST", headers, body: bytes });
  const payload = await uploaded.json();
  assert.equal(uploaded.status, 200);
  assert.equal(payload.data.blob.size, bytes.length);
  assert.equal(payload.data.blob.sha256, sha256);
  assert.equal(payload.data.binding.path, "folder/nested.txt");

  const replay = await fetch(`${baseUrl}/api/resources/upload?${query}`, { method: "POST", headers, body: bytes });
  const replayPayload = await replay.json();
  assert.equal(replay.status, 200);
  assert.equal(replayPayload.data.replayed, true);
  assert.equal(replayPayload.data.version.id, payload.data.version.id);

  const listed = await requestJson(baseUrl, `/api/resources?ownerType=collection&ownerId=${encodeURIComponent(collection.payload.data.id)}`, { token });
  assert.equal(listed.payload.data.items.length, 1);
  assert.equal(listed.payload.data.items[0].size, bytes.length);
});
