import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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

test("Agent-native plans mirror todo snapshots and OpenCode events stay structured", async () => {
  const { gatewayTestHelpers } = await import(
    `../gateway/server.mjs?work-events=${Date.now()}`
  );
  const {
    agentPromptWithNativePlanning,
    classifyOpenCodeText,
    extractModelText,
    mergeOpenCodeAuthContent,
    mergeOpenCodeConfigContent,
    normalizeAgentPlanSteps,
    normalizeConversationTitle,
    normalizeOpenCodeVersion,
    openCodeUpdateApplyCommand,
    openCodeUpdateProbeCommand,
    openCodeConfigurationStatus,
    parseOpenCodeLine,
    parseOpenCodeUpdateVersions,
    providerConfigForOpenCode,
    stripEasyWorkProtocolMarkers,
    trailingFinalMessages,
  } = gatewayTestHelpers;
  assert.equal(
    normalizeConversationTitle("“查看登录节点资源是否充足”", "查看资源"),
    "查看登录节点资源是否充足",
  );
  assert.equal(
    normalizeConversationTitle(
      "我们根据对话内容生成标题。用户希望了解助手能力。",
      "介绍一下你自己",
    ),
    "介绍一下你自己",
  );
  assert.equal(
    extractModelText({
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "先分析如何命名。" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "EasyWork助手介绍" }],
        },
      ],
    }),
    "EasyWork助手介绍",
  );
  assert.equal(
    [...normalizeConversationTitle("", "请帮我查看服务器内存、GPU、磁盘与作业队列是否满足训练要求")].length,
    14,
  );
  assert.equal(
    classifyOpenCodeText("[[EASYWORK_FINAL]]\n最终正文").kind,
    "message",
  );
  assert.deepEqual(
    classifyOpenCodeText(
      "正在整理结果。[[EASYWORK_FINAL]]结论：资源可以使用。",
    ),
    {
      kind: "message",
      output: "结论：资源可以使用。",
      pending: false,
    },
  );
  assert.equal(
    stripEasyWorkProtocolMarkers("[[EASYWORK_FINAL]]结论", true),
    "结论",
  );
  const prompt = await agentPromptWithNativePlanning(
    "用户请求：检查资源",
    "保留用户的资源检查目标。",
  );
  assert.match(prompt, /Agent 原生计划联动/);
  assert.match(prompt, /不会在网页端预先生成或注入执行步骤/);
  assert.match(prompt, /原生 todo\/plan 工具及时维护真实状态/);
  assert.match(prompt, /简单任务无需为了界面展示而额外创建计划/);
  assert.match(prompt, /保留用户的资源检查目标/);
  assert.match(prompt, /两个标记只用于前端路由/);
  assert.doesNotMatch(prompt, /先说明结论|必须以.*结论/);
  assert.match(prompt, /\[\[EASYWORK_PROGRESS\]\]/);
  assert.match(prompt, /\[\[EASYWORK_FINAL\]\]/);
  assert.deepEqual(
    trailingFinalMessages([
      { id: "progress", kind: "agent_message" },
      { id: "premature-final", kind: "message" },
      { id: "later-tool", kind: "tool_call" },
      { id: "actual-final", kind: "message" },
    ]),
    [{ id: "actual-final", kind: "message" }],
  );

  assert.equal(normalizeOpenCodeVersion("opencode v1.2.34"), "1.2.34");
  assert.deepEqual(
    parseOpenCodeUpdateVersions(
      "installer output\nEW_CURRENT_VERSION=1.2.30\nEW_LATEST_VERSION=v1.2.34\n",
    ),
    { currentVersion: "1.2.30", latestVersion: "1.2.34" },
  );
  assert.match(openCodeUpdateProbeCommand(), /https:\/\/opencode\.ai\/install/);
  assert.match(openCodeUpdateProbeCommand(), /\.update-candidate/);
  assert.match(openCodeUpdateApplyCommand(), /opencode\.easywork-backup/);
  assert.match(openCodeUpdateApplyCommand(), /cp -p "\$EW_BACKUP" "\$EW_CURRENT"/);

  const parserState = {
    sessionId: "",
    finalText: "",
    lastError: "",
  };
  const todoEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "todo_1",
        tool: "todowrite",
        state: {
          status: "completed",
          input: {
            todos: [
              { id: "inspect", content: "检查训练脚本", status: "completed", priority: "high" },
              { id: "update", content: "修改参数校验", status: "in_progress", priority: "high" },
              { id: "verify", content: "运行验证", status: "pending", priority: "medium" },
              { id: "obsolete", content: "旧方案", status: "cancelled", priority: "low" },
            ],
          },
          output: "4 todos",
        },
      },
    }),
    parserState,
  );
  assert.equal(todoEvent.kind, "plan");
  assert.equal(todoEvent.title, "执行计划");
  assert.equal(todoEvent.sourceId, "agent-native-plan");
  assert.equal(todoEvent.status, "running");
  assert.deepEqual(todoEvent.planSteps, [
    { id: "inspect", title: "检查训练脚本", status: "done" },
    { id: "update", title: "修改参数校验", status: "running" },
    { id: "verify", title: "运行验证", status: "pending" },
    { id: "obsolete", title: "旧方案", status: "cancelled" },
  ]);
  assert.deepEqual(
    normalizeAgentPlanSteps("update_plan", {
      plan: [
        { step: "定位问题", status: "completed" },
        { step: "实施修复", status: "in_progress" },
      ],
    }).map(({ title, status }) => ({ title, status })),
    [
      { title: "定位问题", status: "done" },
      { title: "实施修复", status: "running" },
    ],
  );
  assert.equal(normalizeAgentPlanSteps("bash", { todos: [] }), null);
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

  const schedulerEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "tool_sinfo",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "sinfo -o '%P %a %D %c %G %t'" },
          output: "PARTITION AVAIL NODES CPUS GRES STATE",
        },
      },
    }),
    parserState,
  );
  assert.equal(schedulerEvent.kind, "job_status");
  assert.match(schedulerEvent.command, /^sinfo /);

  const fileEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "tool_2",
        tool: "edit",
        state: {
          status: "completed",
          input: {
            filePath: "/work/train.py",
            oldString: "epochs = 10",
            newString: "epochs = 20",
          },
          output: "updated",
        },
      },
    }),
    parserState,
  );
  assert.equal(fileEvent.kind, "file_change");
  assert.equal(fileEvent.path, "/work/train.py");
  assert.equal(fileEvent.status, "done");
  assert.match(fileEvent.diff, /--- a\/work\/train\.py/);
  assert.match(fileEvent.diff, /-epochs = 10/);
  assert.match(fileEvent.diff, /\+epochs = 20/);

  const agentMessage = parseOpenCodeLine(
    JSON.stringify({
      type: "text",
      part: { id: "text_1", text: "资源检查完成。" },
    }),
    parserState,
  );
  assert.equal(agentMessage.kind, "agent_message");
  assert.equal(agentMessage.output, "资源检查完成。");
  const streamedAgentMessage = parseOpenCodeLine(
    JSON.stringify({
      type: "text",
      part: { id: "text_1", text: "资源检查完成。正在核对结果。" },
    }),
    parserState,
  );
  assert.equal(streamedAgentMessage.sourceId, "text_1");
  assert.equal(streamedAgentMessage.output, "资源检查完成。正在核对结果。");
  const nextAgentMessage = parseOpenCodeLine(
    JSON.stringify({
      type: "text",
      part: { id: "text_2", text: "结果可信，准备汇总。" },
    }),
    parserState,
  );
  assert.equal(nextAgentMessage.sourceId, "text_2");
  assert.equal(nextAgentMessage.output, "结果可信，准备汇总。");
  assert.equal(
    parseOpenCodeLine(
      JSON.stringify({
        type: "text",
        part: { id: "text_final", text: "[[EASY" },
      }),
      parserState,
    ),
    null,
  );
  const streamedFinalMessage = parseOpenCodeLine(
    JSON.stringify({
      type: "text",
      part: {
        id: "text_final",
        text: "WORK_FINAL]]\n可用资源充足。",
      },
    }),
    parserState,
  );
  assert.equal(streamedFinalMessage.kind, "message");
  assert.equal(streamedFinalMessage.output, "可用资源充足。");
  assert.equal(parserState.finalText, "可用资源充足。");
  assert.deepEqual(parserState.textOrder, ["text_1", "text_2", "text_final"]);
  assert.equal(
    parseOpenCodeLine(
      JSON.stringify({
        type: "text",
        part: { id: "empty_text", text: "\n\n" },
      }),
      parserState,
    ),
    null,
  );
  const errorEvent = parseOpenCodeLine(
    JSON.stringify({
      type: "error",
      error: { data: { message: "remote command failed" } },
    }),
    parserState,
  );
  assert.equal(errorEvent.kind, "error");
  assert.equal(errorEvent.output, "remote command failed");

  const provider = {
    baseUrl: "https://api.example.com/v1",
    model: "test-model",
    protocol: "chat-completions",
  };
  const mergedConfig = mergeOpenCodeConfigContent(
    `{
  // Keep the user's own settings.
  "theme": "system",
  "provider": {
    "other": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:11434/v1" },
      "models": { "local-model": {} }
    }
  }
}
`,
    provider,
  );
  assert.match(mergedConfig, /Keep the user's own settings/);
  assert.match(mergedConfig, /"theme": "system"/);
  assert.match(mergedConfig, /"easywork"/);
  assert.match(mergedConfig, /"test-model"/);
  assert.equal(mergedConfig.includes('"apiKey"'), false);
  assert.deepEqual(
    providerConfigForOpenCode(provider).provider.easywork.options,
    { baseURL: "https://api.example.com/v1" },
  );

  const mergedAuth = mergeOpenCodeAuthContent(
    '{"other":{"type":"api","key":"other-key"}}',
    "easywork-key",
  );
  assert.deepEqual(JSON.parse(mergedAuth), {
    other: { type: "api", key: "other-key" },
    easywork: { type: "api", key: "easywork-key" },
  });
  assert.equal(
    openCodeConfigurationStatus(mergedConfig, mergedAuth, {
      managed: true,
    }).configured,
    true,
  );
  assert.equal(
    openCodeConfigurationStatus(
      '{"$schema":"https://opencode.ai/config.json"}',
      "",
      { managed: true },
    ).configured,
    false,
  );
});

test("legacy EasyWork OpenCode is migrated and receives native configuration automatically", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "easywork-agent-migration-test-"),
  );
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { createEasyWorkServer, gatewayTestHelpers } = await import(
    `../gateway/server.mjs?agent-migration=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const home = "/home/easywork-test";
  const legacyPath = `${home}/.easywork/bin/opencode`;
  const userPath = `${home}/.opencode/bin/opencode`;
  const managedPath = `${home}/.easywork/agents/opencode/bin/opencode`;
  const configPath = `${home}/.config/opencode/opencode.json`;
  const authPath = `${home}/.local/share/opencode/auth.json`;
  const files = new Map([
    [legacyPath, { content: Buffer.from("legacy-opencode"), mode: 0o755 }],
    [userPath, { content: Buffer.from("user-opencode"), mode: 0o755 }],
    [
      configPath,
      {
        content: Buffer.from(
          '{"$schema":"https://opencode.ai/config.json"}\n',
        ),
        mode: 0o600,
      },
    ],
  ]);

  const fakeClient = {
    exec(command, _options, callback) {
      const stream = new PassThrough();
      stream.stderr = new PassThrough();
      callback(null, stream);
      setImmediate(() => {
        let stdout = "";
        let code = 0;
        if (command.includes('managed_opencode="$HOME/.easywork/agents')) {
          if (files.get(managedPath)?.mode & 0o111) {
            stdout = `opencode\t${home}/.easywork/agents/opencode\t${managedPath}\t1.18.9\topencode\n`;
          } else if (files.get(userPath)?.mode & 0o111) {
            stdout = `opencode\t${home}/.opencode\t${userPath}\t1.18.9\topencode\n`;
          }
        } else if (/^test -x /.test(command)) {
          const target = command.match(/^test -x '([^']+)'/)?.[1] || "";
          code = files.get(target)?.mode & 0o111 ? 0 : 1;
        } else if (command.includes(`cp '${legacyPath}' '${managedPath}'`)) {
          files.set(managedPath, {
            content: Buffer.from(files.get(legacyPath).content),
            mode: 0o755,
          });
          stdout = "1.18.9\n";
        } else if (command.includes("mv -f")) {
          const match = command.match(/mv -f '([^']+)' '([^']+)'/);
          if (match) {
            const source = files.get(match[1]);
            if (source) {
              files.set(match[2], source);
              files.delete(match[1]);
            } else {
              code = 1;
            }
          }
        }
        if (stdout) stream.write(stdout);
        stream.emit("close", code);
      });
    },
    sftp(callback) {
      callback(null, {
        readFile(remotePath, done) {
          const file = files.get(remotePath);
          if (file) {
            done(null, Buffer.from(file.content));
            return;
          }
          const error = new Error("No such file");
          error.code = 2;
          done(error);
        },
        writeFile(remotePath, content, options, done) {
          files.set(remotePath, {
            content: Buffer.from(content),
            mode: options?.mode ?? 0o600,
          });
          done(null);
        },
        end() {},
      });
    },
  };

  try {
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "agent-migration@example.com",
        password: "correct-horse",
        displayName: "Agent 迁移用户",
      }),
    });
    assert.equal(registration.status, 200);
    const account = await registration.json();
    const providerResponse = await fetch(`${base}/api/settings/provider`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${account.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "https://api.example.com/v1",
        apiKey: "saved-provider-key",
        model: "test-model",
        protocol: "chat-completions",
      }),
    });
    assert.equal(providerResponse.status, 200);

    const agents = await gatewayTestHelpers.prepareRemoteAgents(
      {
        client: fakeClient,
        home,
        host: "cluster.example.com",
        port: 22,
        username: "cluster-user",
        serverId: "cluster-agent-test",
      },
      account.actor,
    );
    const opencode = agents.find((agent) => agent.adapter === "opencode");
    assert.equal(opencode.path, managedPath);
    assert.equal(opencode.managed, true);
    assert.equal(opencode.configured, true);
    assert.equal(files.get(managedPath)?.mode, 0o755);
    assert.equal(files.get(configPath)?.mode, 0o600);
    assert.equal(files.get(authPath)?.mode, 0o600);
    const nativeConfig = JSON.parse(files.get(configPath).content.toString());
    const nativeAuth = JSON.parse(files.get(authPath).content.toString());
    assert.equal(
      nativeConfig.provider.easywork.options.baseURL,
      "https://api.example.com/v1",
    );
    assert.ok(nativeConfig.provider.easywork.models["test-model"]);
    assert.equal(nativeConfig.provider.easywork.options.apiKey, undefined);
    assert.deepEqual(nativeAuth.easywork, {
      type: "api",
      key: "saved-provider-key",
    });
    await gatewayTestHelpers.ensureOpenCodeNativeConfig(
      {
        client: fakeClient,
        home,
        host: "cluster.example.com",
        port: 22,
        username: "cluster-user",
        serverId: "cluster-agent-test",
      },
      account.actor,
      () => undefined,
      "alternate-model",
    );
    const alternateConfig = JSON.parse(files.get(configPath).content.toString());
    assert.deepEqual(
      Object.keys(alternateConfig.provider.easywork.models),
      ["alternate-model"],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(temporaryRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
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
    assert.equal(initial.capabilities.chatStream, true);
    assert.equal("gatewayEndpointConfig" in initial.capabilities, false);

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

    const chatResponse = await fetch(`${base}/api/chat/stream`, {
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
    const chatEvents = (await chatResponse.text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const chatDone = chatEvents.find((event) => event.type === "done");
    assert.equal(chatDone.demo, true);
    assert.ok(
      chatEvents
        .find((event) => event.type === "meta")
        .sources.includes("cluster-notes.txt"),
    );

    const events = [];
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${base.replace("http:", "ws:")}/ws?deviceToken=${encodeURIComponent(initial.deviceToken)}`,
      );
      let updateRequested = false;
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
          events.some((event) => event.type === "agent.list") &&
          !updateRequested
        ) {
          updateRequested = true;
          socket.send(
            JSON.stringify({
              type: "agent.update.check",
              serverId: "demo",
              agentId: "opencode",
            }),
          );
        }
        if (
          events.some(
            (event) =>
              event.type === "agent.update.status" &&
              event.status === "current",
          )
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
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent.update.status" && event.status === "current",
      ),
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

test("host worker persists a Work result without any browser subscriber", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-worker-task-test-"));
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { createEasyWorkServer, gatewayTestHelpers } = await import(
    `../gateway/server.mjs?worker-task=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "background-work@example.com",
        password: "correct-horse",
        displayName: "后台任务用户",
      }),
    });
    const account = await registration.json();
    const actor = account.actor;
    const worker = await gatewayTestHelpers.getSshWorker(actor);
    const session = gatewayTestHelpers.createSshSession(worker, "cluster-bg");
    worker.sessions.set(session.serverId, session);
    const task = gatewayTestHelpers.createWorkerTask(session, {
      conversationId: "conversation-background",
      runId: "run-background",
      userMessageId: "message-background-user",
      assistantMessageId: "message-background-assistant",
      prompt: "检查后台任务是否继续执行",
      agentId: "opencode",
      workspace: "~",
      firstTurn: true,
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "conversation.title",
      conversationId: task.conversationId,
      runId: task.runId,
      title: "后台 Work 任务",
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "workflow",
      conversationId: task.conversationId,
      runId: task.runId,
      steps: [
        { id: "step-bg", title: "执行远程检查", status: "done" },
        { id: "step-follow-up", title: "可选后续检查", status: "pending" },
      ],
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "agent.event",
      conversationId: task.conversationId,
      runId: task.runId,
      event: {
        id: "message-bg",
        kind: "message",
        title: "Agent 最终回复",
        output: "网页关闭后任务仍已完成。",
        status: "done",
        timestamp: new Date().toISOString(),
      },
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "task.complete",
      conversationId: task.conversationId,
      runId: task.runId,
      result: "网页关闭后任务仍已完成。",
    });
    await gatewayTestHelpers.persistWorkerTaskConversation(actor, task);
    if (worker.persistTimer) {
      clearTimeout(worker.persistTimer);
      worker.persistTimer = null;
    }
    await worker.persistQueue;

    const bootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${account.deviceToken}` },
    });
    const state = (await bootstrap.json()).state;
    const conversation = state.conversations.find(
      (item) => item.id === "conversation-background",
    );
    assert.equal(conversation.title, "后台 Work 任务");
    assert.equal(conversation.work.serverId, "cluster-bg");
    assert.equal(conversation.messages[0].trace.status, "done");
    assert.deepEqual(
      conversation.messages[0].trace.steps.map((step) => step.status),
      ["done", "pending"],
    );
    assert.equal(
      conversation.messages.find((message) => message.role === "assistant").content,
      "网页关闭后任务仍已完成。",
    );
    assert.equal(worker.sockets.size, 0);
    session.lastUserActivityAt = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    await gatewayTestHelpers.cleanupIdleSshWorkers(Date.now());
    assert.equal(worker.sessions.has("cluster-bg"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(temporaryRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test("account settings follow the user across devices and stay isolated from other users", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-account-sync-test-"));
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { createEasyWorkServer } = await import(
    `../gateway/server.mjs?account-sync-test=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "multi-device@example.com",
        password: "correct-horse",
        displayName: "多设备用户",
      }),
    });
    assert.equal(registration.status, 200);
    const firstDevice = await registration.json();
    const firstAuthorization = `Bearer ${firstDevice.deviceToken}`;

    const providerResponse = await fetch(`${base}/api/settings/provider`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: firstAuthorization,
      },
      body: JSON.stringify({
        baseUrl: "https://llm.example.com/v1",
        apiKey: "account-owned-api-key",
        model: "shared-model",
        protocol: "responses",
      }),
    });
    assert.equal(providerResponse.status, 200);

    const serverResponse = await fetch(
      `${base}/api/settings/servers/shared-cluster`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: firstAuthorization,
        },
        body: JSON.stringify({
          name: "学校集群",
          host: "login.example.edu",
          port: 22,
          username: "researcher",
          authMethod: "key",
          keyName: "cluster_ed25519",
          privateKey:
            "-----BEGIN OPENSSH PRIVATE KEY-----\ndraft-account-key\n-----END OPENSSH PRIVATE KEY-----",
        }),
      },
    );
    assert.equal(serverResponse.status, 200);

    const secondLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "multi-device@example.com",
        password: "correct-horse",
      }),
    });
    assert.equal(secondLogin.status, 200);
    const secondDevice = await secondLogin.json();
    const secondBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${secondDevice.deviceToken}` },
    });
    const sharedAccount = await secondBootstrap.json();
    assert.equal(sharedAccount.state.settings.provider.baseUrl, "https://llm.example.com/v1");
    assert.equal(sharedAccount.state.settings.provider.model, "shared-model");
    assert.equal(sharedAccount.state.settings.provider.configured, true);
    assert.equal("apiKey" in sharedAccount.state.settings.provider, false);
    assert.deepEqual(
      sharedAccount.state.settings.servers.find(
        (profile) => profile.id === "shared-cluster",
      ),
      {
        id: "shared-cluster",
        name: "学校集群",
        host: "login.example.edu",
        port: 22,
        username: "researcher",
        authMethod: "key",
        keyName: "cluster_ed25519",
        configured: true,
      },
    );
    assert.equal(JSON.stringify(sharedAccount).includes("draft-account-key"), false);

    const staleState = structuredClone(sharedAccount.state);
    staleState.settings.provider = {
      ...staleState.settings.provider,
      baseUrl: "https://stale-device.invalid/v1",
      model: "stale-model",
      configured: false,
    };
    staleState.settings.servers = [];
    const staleSave = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: firstAuthorization,
      },
      body: JSON.stringify({ state: staleState }),
    });
    assert.equal(staleSave.status, 200);
    const protectedBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${secondDevice.deviceToken}` },
    });
    const protectedAccount = await protectedBootstrap.json();
    assert.equal(protectedAccount.state.settings.provider.model, "shared-model");
    assert.ok(
      protectedAccount.state.settings.servers.some(
        (profile) => profile.id === "shared-cluster",
      ),
    );

    const otherRegistration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "isolated-user@example.com",
        password: "correct-horse",
        displayName: "隔离用户",
      }),
    });
    assert.equal(otherRegistration.status, 200);
    const otherAccount = await otherRegistration.json();
    const otherBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${otherAccount.deviceToken}` },
    });
    const isolated = await otherBootstrap.json();
    assert.equal(isolated.state.settings?.provider, undefined);
    assert.equal(isolated.state.settings?.servers, undefined);
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

test("SSH authentication errors distinguish missing and expired OTP codes", async () => {
  const { gatewayTestHelpers } = await import(
    `../gateway/server.mjs?ssh-auth-copy-test=${Date.now()}`
  );
  const missingOtp = Object.assign(
    new Error("All configured authentication methods failed"),
    {
      sshAuth: {
        authMethod: "key",
        otpPrompted: true,
        otpProvided: false,
      },
    },
  );
  const expiredOtp = Object.assign(
    new Error("All configured authentication methods failed"),
    {
      sshAuth: {
        authMethod: "key",
        otpPrompted: true,
        otpProvided: true,
      },
    },
  );
  assert.match(gatewayTestHelpers.describeSshError(missingOtp), /要求动态验证码/);
  assert.match(gatewayTestHelpers.describeSshError(expiredOtp), /可能已经过期/);
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
  let secondDeviceSocket;

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

    const secondDeviceLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ssh-profile@example.com",
        password: "correct-horse",
      }),
    });
    assert.equal(secondDeviceLogin.status, 200);
    const secondDeviceAccount = await secondDeviceLogin.json();
    const authenticationCountBeforeSecondDevice = authenticationCount;
    const secondDeviceSnapshot = await new Promise((resolve, reject) => {
      secondDeviceSocket = new WebSocket(
        `${base.replace("http:", "ws:")}/ws?deviceToken=${encodeURIComponent(secondDeviceAccount.deviceToken)}`,
      );
      const timer = setTimeout(
        () => reject(new Error("second device did not resume account SSH sessions")),
        4_000,
      );
      secondDeviceSocket.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (
          event.type !== "connections.snapshot" ||
          !event.connections?.some(
            (connection) =>
              connection.serverId === "cluster-a" && connection.resumed,
          ) ||
          !event.connections?.some(
            (connection) =>
              connection.serverId === "cluster-b" && connection.resumed,
          )
        ) {
          return;
        }
        clearTimeout(timer);
        resolve(event);
      });
      secondDeviceSocket.once("error", reject);
    });
    assert.equal(secondDeviceSnapshot.connections.length >= 2, true);
    assert.equal(authenticationCount, authenticationCountBeforeSecondDevice);
    secondDeviceSocket.close();
    secondDeviceSocket = undefined;

    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 160));
    const authenticationCountAfterAllPagesClosed = authenticationCount;
    const hostMaintainedSnapshot = await new Promise((resolve, reject) => {
      socket = new WebSocket(
        `${base.replace("http:", "ws:")}/ws?deviceToken=${encodeURIComponent(account.deviceToken)}`,
      );
      const timer = setTimeout(
        () => reject(new Error("host worker did not retain SSH after all pages closed")),
        4_000,
      );
      socket.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        if (
          event.type !== "connections.snapshot" ||
          !event.connections?.some(
            (connection) =>
              connection.serverId === "cluster-a" &&
              connection.status === "connected",
          ) ||
          !event.connections?.some(
            (connection) =>
              connection.serverId === "cluster-b" &&
              connection.status === "connected",
          )
        ) {
          return;
        }
        clearTimeout(timer);
        resolve(event);
      });
      socket.once("error", reject);
    });
    assert.equal(hostMaintainedSnapshot.connections.length >= 2, true);
    assert.equal(authenticationCount, authenticationCountAfterAllPagesClosed);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const workerRuntime = JSON.parse(
      await readFile(
        path.join(
          temporaryRoot,
          "data",
          "users",
          account.actor.id,
          "ssh-worker.json",
        ),
        "utf8",
      ),
    );
    assert.match(workerRuntime.workerId, /^ssh-worker-/);
    assert.ok(
      workerRuntime.sessions.some(
        (session) =>
          session.serverId === "cluster-a" && session.status === "connected",
      ),
    );
    assert.equal(JSON.stringify(workerRuntime).includes("PRIVATE KEY"), false);

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
    if (secondDeviceSocket?.readyState === WebSocket.OPEN) {
      secondDeviceSocket.close();
    }
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
      const parsedBody = JSON.parse(requestBody || "{}");
      if (parsedBody.stream) {
        const completeText = "我是 **EasyWork Chat 助手**，很高兴见到你。";
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write(
          `data: ${JSON.stringify({
            type: "response.content_part.added",
            part: { type: "output_text", text: "我是 **" },
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta: "EasyWork Chat 助手**，很高兴见到你。",
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: "response.output_text.done",
            text: completeText,
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              output: [
                {
                  type: "message",
                  content: [{ type: "output_text", text: completeText }],
                },
              ],
            },
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "responses unsupported" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const parsedBody = JSON.parse(requestBody || "{}");
      if (parsedBody.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: "先检查上下文。" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "<thi" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "nk>再核对资源。</thi" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "nk>流式" } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "回答" } }],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
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

    const bootstrapResponse = await fetch(`${base}/api/bootstrap`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrapPayload = await bootstrapResponse.json();
    assert.equal(bootstrapPayload.capabilities.chatStream, true);
    const authorization = `Bearer ${bootstrapPayload.deviceToken}`;
    const saveProviderResponse = await fetch(`${base}/api/settings/provider`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({
        baseUrl: providerBase,
        apiKey: "test-key",
        model: "chat-model",
        protocol: "chat-completions",
      }),
    });
    assert.equal(saveProviderResponse.status, 200);
    const storedKeyResponse = await fetch(
      `${base}/api/settings/provider/key`,
      { headers: { Authorization: authorization } },
    );
    assert.equal(storedKeyResponse.status, 200);
    assert.equal((await storedKeyResponse.json()).apiKey, "test-key");
    const storedCredentialModelsResponse = await fetch(
      `${base}/api/settings/provider/models`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify({ baseUrl: providerBase }),
      },
    );
    assert.equal(storedCredentialModelsResponse.status, 200);
    assert.deepEqual(
      (await storedCredentialModelsResponse.json()).models,
      ["chat-model"],
    );
    const streamResponse = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({
        conversationId: "stream-test",
        prompt: "测试流式输出",
        firstTurn: false,
      }),
    });
    assert.equal(streamResponse.status, 200);
    assert.match(
      streamResponse.headers.get("content-type"),
      /application\/x-ndjson/,
    );
    const streamEvents = (await streamResponse.text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      streamEvents
        .filter((event) => event.type === "content_delta")
        .map((event) => event.delta),
      ["流式", "回答"],
    );
    assert.deepEqual(
      streamEvents
        .filter((event) => event.type === "reasoning_delta")
        .map((event) => event.delta),
      ["先检查上下文。", "再核对资源。"],
    );
    assert.equal(
      streamEvents.find((event) => event.type === "done")?.content,
      "流式回答",
    );
    assert.equal(
      streamEvents.find((event) => event.type === "done")?.reasoning,
      "先检查上下文。再核对资源。",
    );

    const saveResponsesProvider = await fetch(`${base}/api/settings/provider`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({
        baseUrl: providerBase,
        apiKey: "test-key",
        model: "chat-model",
        protocol: "responses",
      }),
    });
    assert.equal(saveResponsesProvider.status, 200);
    const responsesStreamResponse = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify({
        conversationId: "responses-stream-test",
        prompt: "测试 Responses 首分片",
        firstTurn: false,
      }),
    });
    assert.equal(responsesStreamResponse.status, 200);
    const responsesStreamEvents = (await responsesStreamResponse.text())
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      responsesStreamEvents
        .filter((event) => event.type === "content_delta")
        .map((event) => event.delta),
      ["我是 **", "EasyWork Chat 助手**，很高兴见到你。"],
    );
    assert.equal(
      responsesStreamEvents.find((event) => event.type === "done")?.content,
      "我是 **EasyWork Chat 助手**，很高兴见到你。",
    );

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
