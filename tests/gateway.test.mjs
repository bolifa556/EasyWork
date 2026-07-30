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

test("work planning is prepared before execution and OpenCode events stay structured", async () => {
  const { gatewayTestHelpers } = await import(
    `../gateway/server.mjs?work-events=${Date.now()}`
  );
  const {
    agentPromptWithWorkflow,
    normalizeConversationTitle,
    parseOpenCodeLine,
    parseWorkPlan,
    parseWorkflowPlan,
    workflowFor,
    workflowIndexForEvent,
  } = gatewayTestHelpers;
  const fallback = workflowFor("查看内存和 CPU");
  const planned = parseWorkflowPlan(
    '```json\n{"steps":["确认登录节点","检查可用内存","核对 CPU 资源","给出判断"]}\n```',
    fallback,
  );
  assert.deepEqual(planned, [
    "确认登录节点",
    "检查可用内存",
    "核对 CPU 资源",
    "给出判断",
  ]);
  assert.equal(
    normalizeConversationTitle("“查看登录节点资源是否充足”", "查看资源"),
    "查看登录节点资源是否充足",
  );
  assert.equal(
    [...normalizeConversationTitle("", "请帮我查看服务器内存、GPU、磁盘与作业队列是否满足训练要求")].length,
    14,
  );
  assert.deepEqual(
    parseWorkPlan(
      '{"title":"训练资源检查","steps":["查看内存","检查 GPU","给出判断"]}',
      "检查训练资源",
    ),
    {
      title: "训练资源检查",
      steps: ["查看内存", "检查 GPU", "给出判断"],
    },
  );
  const prompt = agentPromptWithWorkflow("用户请求：检查资源", planned);
  assert.match(prompt, /EasyWork 网页端已编排的执行流程/);
  assert.match(prompt, /2\. 检查可用内存/);
  assert.match(prompt, /不要重新生成另一套计划/);

  const parserState = {
    sessionId: "",
    finalText: "",
    lastError: "",
  };
  const commandEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "tool_1",
        tool: "bash",
        state: {
          status: "running",
          input: { command: "free -h" },
          output: "Mem: 125Gi",
        },
      },
    }),
    parserState,
  );
  assert.equal(commandEvent.kind, "tool_call");
  assert.equal(commandEvent.command, "free -h");
  assert.equal(commandEvent.sourceId, "tool_1");
  assert.equal(
    workflowIndexForEvent(commandEvent, ["查看服务器内存", "查看可用资源", "判断结果"], 0),
    0,
  );

  const fileEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "tool_2",
        tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "/work/train.py" },
          output: "updated",
        },
      },
    }),
    parserState,
  );
  assert.equal(fileEvent.kind, "file_change");
  assert.equal(fileEvent.path, "/work/train.py");
  assert.equal(fileEvent.status, "done");

  const errorEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "error",
      error: { data: { message: "remote command failed" } },
    }),
    parserState,
  );
  assert.equal(errorEvent.kind, "error");
  assert.equal(errorEvent.output, "remote command failed");
});

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
        socket.send(
          JSON.stringify({
            type: "ssh.connect",
            serverId: "demo",
            demo: true,
          }),
        );
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
          event.type === "connections.snapshot" &&
          event.connections?.some(
            (connection) =>
              connection.serverId === "demo" &&
              connection.status === "connected" &&
              connection.resumed,
          )
        ) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      });
      socket.on("error", reject);
    });
    assert.ok(
      resumedEvents.some(
        (event) =>
          event.type === "connections.snapshot" &&
          event.connections?.some((connection) => connection.resumed === true),
      ),
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

test("an authenticated account can reuse encrypted SSH keys and passwords", async () => {
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
        if (context.method === "publickey") {
          authenticationCount += 1;
          context.accept();
          return;
        }
        if (
          context.method === "password" &&
          context.password === "secret-password"
        ) {
          authenticationCount += 1;
          context.accept();
          return;
        }
        context.reject();
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
        if (event.type === "server.profile") profileReceived = true;
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
        serverId: "cluster-a",
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
    assert.ok(firstEvents.some((event) => event.type === "server.profile"));

    await waitForConnection(
      {
        type: "ssh.connect",
        serverId: "cluster-b",
        name: "备用登录节点",
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

    await new Promise((resolve) => {
      const onMessage = (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "connection.status" || event.status !== "disconnected") return;
        socket.off("message", onMessage);
        resolve();
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({ type: "ssh.disconnect", serverId: "cluster-a" }),
      );
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("second SSH session was closed unexpectedly")),
        3_000,
      );
      const onMessage = (raw) => {
        const event = JSON.parse(String(raw));
        if (event.type !== "agent.list" || event.serverId !== "cluster-b") return;
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve();
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({ type: "agent.scan", serverId: "cluster-b" }),
      );
    });
    await waitForConnection({
      type: "ssh.connect",
      serverId: "cluster-a",
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "cluster-user",
      useSavedKey: true,
      trustHost: true,
    });
    assert.ok(authenticationCount >= 2);
    assert.equal(readyCount, 3);

    const bootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${account.deviceToken}` },
    });
    const profiles = (await bootstrap.json()).state.settings.servers;
    assert.ok(profiles.some((item) => item.id === "cluster-a"));
    assert.ok(profiles.some((item) => item.id === "cluster-b"));
    const profile = profiles.find((item) => item.id === "cluster-a");
    assert.deepEqual(profile, {
      id: "cluster-a",
      name: "127.0.0.1",
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "cluster-user",
      authMethod: "key",
      keyName: "cluster_ed25519",
      configured: true,
      lastConnectedAt: profile.lastConnectedAt,
    });
    assert.equal(JSON.stringify(profile).includes("PRIVATE KEY"), false);

    await waitForConnection(
      {
        type: "ssh.connect",
        serverId: "cluster-c",
        name: "密码登录节点",
        host: "127.0.0.1",
        port: sshAddress.port,
        username: "password-user",
        authMethod: "password",
        password: "secret-password",
        rememberCredential: true,
        trustHost: true,
      },
      { expectProfile: true },
    );
    await new Promise((resolve) => {
      const onMessage = (raw) => {
        const event = JSON.parse(String(raw));
        if (
          event.type !== "connection.status" ||
          event.serverId !== "cluster-c" ||
          event.status !== "disconnected"
        ) {
          return;
        }
        socket.off("message", onMessage);
        resolve();
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({ type: "ssh.disconnect", serverId: "cluster-c" }),
      );
    });
    await waitForConnection({
      type: "ssh.connect",
      serverId: "cluster-c",
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "password-user",
      authMethod: "password",
      useSavedCredential: true,
      trustHost: true,
    });
    assert.equal(readyCount, 5);
    const passwordBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${account.deviceToken}` },
    });
    const passwordProfiles = (await passwordBootstrap.json()).state.settings
      .servers;
    const passwordProfile = passwordProfiles.find(
      (item) => item.id === "cluster-c",
    );
    assert.deepEqual(passwordProfile, {
      id: "cluster-c",
      name: "密码登录节点",
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "password-user",
      authMethod: "password",
      keyName: "",
      configured: true,
      lastConnectedAt: passwordProfile.lastConnectedAt,
    });
    assert.equal(JSON.stringify(passwordProfile).includes("secret-password"), false);

    await new Promise((resolve) => {
      const onMessage = (raw) => {
        const event = JSON.parse(String(raw));
        if (
          event.type !== "connection.status" ||
          event.serverId !== "cluster-b" ||
          event.status !== "disconnected"
        ) {
          return;
        }
        socket.off("message", onMessage);
        resolve();
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({ type: "ssh.disconnect", serverId: "cluster-b" }),
      );
    });
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "ssh.disconnect", serverId: "cluster-a" }));
      socket.send(JSON.stringify({ type: "ssh.disconnect", serverId: "cluster-b" }));
      socket.send(JSON.stringify({ type: "ssh.disconnect", serverId: "cluster-c" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    const requestBody = Buffer.concat(chunks).toString("utf8");
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
          choices: [
            {
              message: {
                content: requestBody.includes("任务编排器")
                  ? '{"steps":["确认目标","检查文件","执行修改","验证结果"]}'
                  : "OK",
              },
            },
          ],
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

  const { createEasyWorkServer, gatewayTestHelpers } = await import(
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

    const plannedSteps = await gatewayTestHelpers.planWorkSteps(
      {
        baseUrl: providerBase,
        model: "chat-model",
        protocol: "chat-completions",
      },
      "test-key",
      "修改训练脚本并验证",
    );
    assert.deepEqual(plannedSteps, [
      "确认目标",
      "检查文件",
      "执行修改",
      "验证结果",
    ]);
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
