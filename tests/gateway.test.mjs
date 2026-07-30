import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ssh2 from "ssh2";
import { WebSocket } from "ws";

const { Server: SshServer } = ssh2;

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
    assert.equal(typeof initial.deviceToken, "string");
    assert.ok(initial.deviceToken.length > 40);

    const tokenBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${initial.deviceToken}` },
    });
    const tokenActor = await tokenBootstrap.json();
    assert.equal(tokenActor.actor.id, initial.actor.id);

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

    const staleState = structuredClone(state);
    staleState.settings.provider.protocol = "auto";
    const staleStateResponse = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({ state: staleState }),
    });
    assert.equal(staleStateResponse.status, 200);
    const preservedStateResponse = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookies },
    });
    const preservedState = await preservedStateResponse.json();
    assert.equal(
      preservedState.state.settings.provider.protocol,
      "responses",
    );

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
      const socket = new WebSocket(
        `${base.replace("http:", "ws:")}/ws?deviceToken=${encodeURIComponent(initial.deviceToken)}`,
      );
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

    const resumedEvents = [];
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${base.replace("http:", "ws:")}/ws?deviceToken=${encodeURIComponent(initial.deviceToken)}`,
      );
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("resumed websocket timed out"));
      }, 4_000);
      socket.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        resumedEvents.push(event);
        if (
          event.type === "connection.status" &&
          event.status === "connected" &&
          event.resumed
        ) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      });
      socket.on("error", reject);
    });
    assert.ok(resumedEvents.some((event) => event.resumed === true));

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
    const registered = await registration.json();
    assert.equal(registered.actor.authenticated, true);
    assert.ok(registered.deviceToken);

    const authenticatedBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${registered.deviceToken}` },
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

test("an authenticated account can reuse its encrypted SSH key without sending it again", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-ssh-profile-test-"));
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { privateKey: hostPrivateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const { privateKey: userPrivateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const hostKeyPem = hostPrivateKey
    .export({ format: "pem", type: "pkcs1" })
    .toString();
  const userKeyPem = userPrivateKey
    .export({ format: "pem", type: "pkcs1" })
    .toString();
  let authenticationCount = 0;
  let readyCount = 0;
  const sshServer = new SshServer({ hostKeys: [hostKeyPem] }, (client) => {
    client
      .on("authentication", (context) => {
        if (context.method !== "publickey") {
          context.reject();
          return;
        }
        authenticationCount += 1;
        context.accept();
      })
      .on("ready", () => {
        readyCount += 1;
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _rejectExec, info) => {
            const stream = acceptExec();
            if (/printf "%s" "\$HOME"/.test(info.command)) {
              stream.write("/home/easywork-test");
            }
            stream.exit(0);
            stream.end();
          });
        });
      });
  });
  await new Promise((resolve) => sshServer.listen(0, "127.0.0.1", resolve));

  const { createEasyWorkServer } = await import(
    `../gateway/server.mjs?ssh-profile-test=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = server.address();
  const sshAddress = sshServer.address();
  const base = `http://127.0.0.1:${gatewayAddress.port}`;
  let socket;

  const waitForConnection = (
    payload,
    { expectProfile = false, expectAgents = true } = {},
  ) =>
    new Promise((resolve, reject) => {
      const events = [];
      let connected = false;
      let profileReceived = false;
      let agentsReceived = false;
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `SSH profile test timed out: ${events
                .map((event) => `${event.type}:${event.status || event.label || ""}`)
                .join(", ")}`,
            ),
          ),
        6_000,
      );
      const onMessage = (raw) => {
        const event = JSON.parse(String(raw));
        events.push(event);
        if (event.type === "ssh.profile") profileReceived = true;
        if (event.type === "agent.list") agentsReceived = true;
        if (event.type === "connection.status" && event.status === "error") {
          clearTimeout(timer);
          reject(new Error(event.label));
        }
        if (event.type === "connection.status" && event.status === "connected") {
          connected = true;
        }
        if (
          connected &&
          (!expectProfile || profileReceived) &&
          (!expectAgents || agentsReceived)
        ) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(events);
        }
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify(payload));
    });

  try {
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ssh-profile@example.com",
        password: "correct-horse",
        displayName: "SSH 用户",
      }),
    });
    assert.equal(registration.status, 200);
    const account = await registration.json();
    socket = new WebSocket(
      `${base.replace("http:", "ws:")}/ws?deviceToken=${encodeURIComponent(account.deviceToken)}`,
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const firstEvents = await waitForConnection(
      {
        type: "ssh.connect",
        host: "127.0.0.1",
        port: sshAddress.port,
        username: "cluster-user",
        privateKey: userKeyPem,
        privateKeyName: "cluster_ed25519",
        rememberKey: true,
        trustHost: true,
      },
      { expectProfile: true },
    );
    assert.ok(firstEvents.some((event) => event.type === "ssh.profile"));

    await new Promise((resolve) => {
      const onMessage = (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "connection.status" || event.status !== "disconnected") return;
        socket.off("message", onMessage);
        resolve();
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ type: "ssh.disconnect" }));
    });
    await waitForConnection({
      type: "ssh.connect",
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "cluster-user",
      useSavedKey: true,
      trustHost: true,
    });
    assert.ok(authenticationCount >= 2);
    assert.equal(readyCount, 2);

    const bootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${account.deviceToken}` },
    });
    const profile = (await bootstrap.json()).state.settings.ssh;
    assert.deepEqual(profile, {
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "cluster-user",
      keyName: "cluster_ed25519",
      configured: true,
    });
    assert.equal(JSON.stringify(profile).includes("PRIVATE KEY"), false);
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ssh.disconnect" }));
      socket.close();
    }
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => sshServer.close(resolve)),
    ]);
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

    const invalidKeyResponse = await fetch(`${base}/api/settings/provider/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: providerBase,
        apiKey: "https://api.example.com/v1",
      }),
    });
    assert.equal(invalidKeyResponse.status, 400);
    assert.match((await invalidKeyResponse.json()).error, /API Key.*URL/);

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
