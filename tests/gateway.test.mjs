import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

function mergeCookies(current, response) {
  const next = new Map(
    String(current || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => [item.split("=")[0], item]),
  );
  for (const raw of response.headers.getSetCookie?.() || []) {
    const pair = raw.split(";")[0];
    next.set(pair.split("=")[0], pair);
  }
  return [...next.values()].join("; ");
}

test("gateway persists identity, indexes files, and opens a demo work session", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-test-"));
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { createEasyWorkServer } = await import(
    `../gateway/server.mjs?test=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  let cookies = "";

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "easywork-gateway");

    const bootstrap = await fetch(`${base}/api/bootstrap`);
    cookies = mergeCookies(cookies, bootstrap);
    const initial = await bootstrap.json();
    assert.equal(initial.actor.authenticated, false);
    assert.match(initial.actor.id, /^[a-f0-9-]{20,}$/i);

    const state = {
      projects: [],
      conversations: [],
      skills: [],
      files: [],
      memories: [],
      settings: {
        memoryEnabled: true,
        referenceHistory: true,
        autoCapture: true,
        provider: {
          name: "OpenAI Compatible",
          baseUrl: "https://api.openai.com/v1",
          model: "test-model",
          protocol: "responses",
          configured: false,
        },
        embedding: {
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          dimensions: "1536",
          configured: false,
          hybridEnabled: true,
          rerankEnabled: false,
        },
      },
    };
    const stateResponse = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({ state }),
    });
    assert.equal(stateResponse.status, 200);

    const fileResponse = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        id: "file_test",
        name: "cluster-notes.txt",
        type: "text/plain",
        size: 54,
        contentBase64: Buffer.from(
          "登录节点有 128 GiB 内存。训练任务需要通过调度器提交。",
        ).toString("base64"),
      }),
    });
    assert.equal(fileResponse.status, 200);
    const indexed = await fileResponse.json();
    assert.equal(indexed.status, "keyword-only");
    assert.ok(indexed.chunks >= 1);

    const chatResponse = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        conversationId: "chat_test",
        prompt: "登录节点有多少内存？",
        skillIds: [],
        memoryMode: "default",
      }),
    });
    assert.equal(chatResponse.status, 200);
    const chat = await chatResponse.json();
    assert.equal(chat.demo, true);
    assert.ok(chat.sources.includes("cluster-notes.txt"));

    const events = [];
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
        headers: { Cookie: cookies },
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("demo websocket timed out"));
      }, 4_000);
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "ssh.connect", demo: true }));
      });
      socket.on("message", (raw) => {
        events.push(JSON.parse(String(raw)));
        if (
          events.some(
            (event) =>
              event.type === "connection.status" && event.status === "connected",
          ) &&
          events.some((event) => event.type === "agent.list")
        ) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      });
      socket.on("error", reject);
    });
    assert.ok(events.some((event) => event.demo === true));
    assert.ok(
      events
        .find((event) => event.type === "agent.list")
        .agents.some((agent) => agent.id === "opencode"),
    );

    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        email: "test@example.com",
        password: "correct-horse",
        displayName: "测试用户",
      }),
    });
    assert.equal(registration.status, 200);
    cookies = mergeCookies(cookies, registration);
    assert.equal((await registration.json()).actor.authenticated, true);

    const authenticatedBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookies },
    });
    const authenticated = await authenticatedBootstrap.json();
    assert.equal(authenticated.actor.displayName, "测试用户");
    assert.equal(authenticated.state.settings.memoryEnabled, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(temporaryRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("an SSH failure is not overwritten by a later close event", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-ssh-error-test-"));
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { createEasyWorkServer } = await import(
    `../gateway/server.mjs?ssh-error-test=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  const interruptedSshServer = createTcpServer((socket) => socket.destroy());
  let acceptedConnections = 0;
  interruptedSshServer.on("connection", () => {
    acceptedConnections += 1;
  });
  await new Promise((resolve) => interruptedSshServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = server.address();
  const sshAddress = interruptedSshServer.address();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  const events = [];
  let socket;

  try {
    await new Promise((resolve, reject) => {
      socket = new WebSocket(`ws://127.0.0.1:${gatewayAddress.port}/ws`);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("SSH failure websocket timed out"));
      }, 4_000);
      socket.on("open", () => {
        socket.send(
          JSON.stringify({
            type: "ssh.connect",
            host: "127.0.0.1",
            port: sshAddress.port,
            username: "test-user",
            privateKey: privateKeyPem,
          }),
        );
      });
      socket.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        events.push(event);
        if (event.type === "connection.status" && event.status === "error") {
          setTimeout(() => {
            clearTimeout(timer);
            resolve();
          }, 200);
        }
      });
      socket.on("error", reject);
    });

    assert.equal(acceptedConnections, 1);
    const errorIndex = events.findIndex(
      (event) => event.type === "connection.status" && event.status === "error",
    );
    assert.ok(errorIndex >= 0);
    assert.equal(
      events
        .slice(errorIndex + 1)
        .some((event) => event.type === "connection.status" && event.status === "disconnected"),
      false,
    );
  } finally {
    socket?.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => interruptedSshServer.close(resolve));
    const resolved = path.resolve(temporaryRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("gateway detects models, auto-selects a compatible chat protocol, and permits local access", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-model-test-"));
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");

  const providerServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { id: "chat-model" },
            { id: "text-embedding-test" },
          ],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "responses unsupported" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address();
  const providerBase = `http://127.0.0.1:${providerAddress.port}/v1`;

  const { createEasyWorkServer } = await import(
    `../gateway/server.mjs?models=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const preflight = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://easywork.example",
        "Access-Control-Request-Private-Network": "true",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-private-network"),
      "true",
    );

    const modelsResponse = await fetch(`${base}/api/settings/provider/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: providerBase, apiKey: "test-key" }),
    });
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual((await modelsResponse.json()).models, ["chat-model"]);

    const embeddingResponse = await fetch(`${base}/api/settings/embedding/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: providerBase, apiKey: "test-key" }),
    });
    assert.equal(embeddingResponse.status, 200);
    assert.deepEqual((await embeddingResponse.json()).models, [
      "text-embedding-test",
    ]);

    const testResponse = await fetch(`${base}/api/settings/provider/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: providerBase,
        apiKey: "test-key",
        model: "chat-model",
        protocol: "auto",
      }),
    });
    assert.equal(testResponse.status, 200);
    assert.equal((await testResponse.json()).protocol, "chat-completions");
  } finally {
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => providerServer.close(resolve)),
    ]);
    const resolved = path.resolve(temporaryRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});
