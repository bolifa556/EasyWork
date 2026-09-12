import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";

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
