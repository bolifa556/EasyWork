import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function listenHttpServer(server) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("无法为 HTTP 测试服务分配安全端口");
}

test("Agent-native plans mirror todo snapshots and OpenCode events stay structured", async () => {
  const {
    compareAgentVersions,
    normalizeAgentVersion,
    remoteAgentPlatform,
  } = await import(`../gateway/agent-artifacts.mjs?artifacts=${Date.now()}`);
  const { gatewayTestHelpers } = await import(
    `../gateway/server.mjs?work-events=${Date.now()}`
  );
  const {
    agentBindingKey,
    agentMemoryDelta,
    agentRuntimeCapabilities,
    agentPromptWithNativePlanning,
    classifyOpenCodeText,
    conciseOpenCodeDiagnostic,
    createAgentSyncCursor,
    extractModelText,
    mergeOpenCodeAuthContent,
    mergeOpenCodeConfigContent,
    managedAgentCapabilitySchema,
    managedOpenCodeModel,
    mergeConversationCollections,
    normalizeAgentPlanSteps,
    normalizeConversationTitle,
    normalizeWorkspaceRecord,
    nativeAgentCommand,
    openCodeConfigurationStatus,
    openCodeConfiguredModelDetails,
    openCodeProviderContextLimit,
    openCodeSseAgentEvent,
    parseCodexLine,
    parseClaudeCodeLine,
    parseOpenCodeLine,
    providerConfigForOpenCode,
    providerModelDescriptor,
    providerRelayTarget,
    remoteOpenCodePortCommand,
    stripEasyWorkProtocolMarkers,
    trailingFinalMessages,
    workspaceIdFor,
    workspacePathContains,
    workspaceRecordsOverlap,
    workspaceRunConflict,
    workspaceVersionDomainIdFor,
  } = gatewayTestHelpers;
  const openCodeSchema = managedAgentCapabilitySchema(
    { adapter: "opencode" },
    {},
  );
  assert.deepEqual(Object.keys(openCodeSchema), ["permission"]);
  assert.equal(openCodeSchema.permission.label, "全局工具权限");
  assert.deepEqual(openCodeSchema.permission.options, ["ask", "allow", "deny"]);
  const codexSchema = managedAgentCapabilitySchema(
    { adapter: "codex" },
    {},
  );
  assert.deepEqual(codexSchema.reasoning.options, [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.deepEqual(codexSchema.permission.options, [
    "untrusted",
    "on-request",
    "never",
  ]);
  assert.equal(codexSchema.permission.label, "审批策略");
  assert.equal(codexSchema.sandbox.label, "沙箱权限");
  const claudeSchema = managedAgentCapabilitySchema(
    { adapter: "claude", version: "2.1.203" },
    {},
  );
  assert.deepEqual(claudeSchema.reasoning.options, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
  ]);
  assert.deepEqual(claudeSchema.permission.options, [
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ]);
  assert.equal(claudeSchema.reasoning.value, "high");
  assert.deepEqual(
    managedAgentCapabilitySchema(
      { adapter: "claude", version: "2.1.202" },
      {},
    ).reasoning.options,
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    managedAgentCapabilitySchema({ adapter: "plain" }, {}),
    {},
  );
  const workspaceA = workspaceIdFor("server-a", "/srv/project-a");
  const workspaceB = workspaceIdFor("server-a", "/srv/project-b");
  assert.equal(workspaceA, workspaceIdFor("server-a", "/srv/project-a"));
  assert.notEqual(workspaceA, workspaceB);
  assert.notEqual(
    workspaceA,
    workspaceIdFor("server-b", "/srv/project-a"),
  );
  assert.notEqual(
    agentBindingKey({
      serverId: "server-a",
      workspaceId: workspaceA,
      agentId: "opencode",
      conversationId: "conversation-a",
    }),
    agentBindingKey({
      serverId: "server-a",
      workspaceId: workspaceB,
      agentId: "opencode",
      conversationId: "conversation-a",
    }),
  );
  assert.equal(
    normalizeWorkspaceRecord({
      serverId: "server-a",
      path: "/srv/project-a",
      name: "Project A",
      mode: "attached",
    }).id,
    workspaceA,
  );
  assert.equal(workspacePathContains("/srv/project-a", "/srv/project-a/src"), true);
  assert.equal(workspacePathContains("/srv/project-a", "/srv/project-ab"), false);
  assert.equal(
    workspaceRecordsOverlap(
      { serverId: "server-a", path: "/srv/project-a" },
      { serverId: "server-a", path: "/srv/project-a/src" },
    ),
    true,
  );
  assert.equal(
    workspaceRecordsOverlap(
      { serverId: "server-a", path: "/srv/project-a" },
      { serverId: "server-b", path: "/srv/project-a" },
    ),
    false,
  );
  assert.equal(
    workspaceRecordsOverlap(
      {
        serverId: "profile-a",
        serverIdentity: "ssh-endpoint-shared",
        path: "/srv/project-a",
      },
      {
        serverId: "profile-b",
        serverIdentity: "ssh-endpoint-shared",
        path: "/srv/project-a/src",
      },
    ),
    true,
    "同一 SSH 端点的重复连接配置不能绕过目录冲突检测",
  );
  assert.equal(
    workspaceVersionDomainIdFor("server-a", "/srv/project-a", "/srv/project-a"),
    workspaceVersionDomainIdFor("server-a", "/srv/project-a", "/srv/project-a/src"),
  );
  const activeRuns = new Map([
    [
      "run-a",
      {
        runId: "run-a",
        conversationId: "conversation-a",
        serverId: "server-a",
        workspace: "/srv/project-a/src",
      },
    ],
  ]);
  assert.equal(
    workspaceRunConflict(activeRuns, "conversation-b", {
      serverId: "server-a",
      path: "/srv/project-a",
    })?.runId,
    "run-a",
  );
  assert.equal(
    workspaceRunConflict(activeRuns, "conversation-b", {
      serverId: "server-a",
      path: "/srv/project-b",
    }),
    undefined,
  );
  assert.equal(
    workspaceRunConflict(activeRuns, "conversation-a", {
      serverId: "server-a",
      path: "/srv/project-b",
    })?.runId,
    "run-a",
  );
  const duplicateProfileRuns = new Map([
    [
      "run-profile-a",
      {
        runId: "run-profile-a",
        conversationId: "conversation-profile-a",
        serverId: "profile-a",
        serverIdentity: "ssh-endpoint-shared",
        workspace: "/srv/shared/project",
      },
    ],
  ]);
  assert.equal(
    workspaceRunConflict(duplicateProfileRuns, "conversation-profile-b", {
      serverId: "profile-b",
      serverIdentity: "ssh-endpoint-shared",
      path: "/srv/shared/project/src",
    })?.runId,
    "run-profile-a",
  );
  const sharedVersionDomain = workspaceVersionDomainIdFor(
    "server-a",
    "/srv/monorepo",
    "/srv/monorepo/packages/a",
  );
  const versionDomainRuns = new Map([
    [
      "run-monorepo-a",
      {
        runId: "run-monorepo-a",
        conversationId: "conversation-monorepo-a",
        serverId: "server-a",
        workspace: "/srv/monorepo/packages/a",
        versionDomainId: sharedVersionDomain,
      },
    ],
  ]);
  assert.equal(
    workspaceRunConflict(versionDomainRuns, "conversation-monorepo-b", {
      serverId: "server-a",
      path: "/srv/monorepo/packages/b",
      versionDomainId: sharedVersionDomain,
    })?.runId,
    "run-monorepo-a",
  );
  assert.equal(
    workspaceRunConflict(versionDomainRuns, "conversation-other-server", {
      serverId: "server-b",
      path: "/srv/monorepo/packages/b",
      versionDomainId: sharedVersionDomain,
    }),
    undefined,
  );
  const projectABinding = {
    agentSessionId: "native-project-a",
    syncCursor: {
      memoryEnabled: true,
      memoryVersions: { "memory-project-a": 2 },
      memoryStatuses: { "memory-project-a": "active" },
    },
  };
  const projectBDelta = agentMemoryDelta(
    {
      state: { settings: { memoryEnabled: true } },
      memorySyncRecords: [],
    },
    projectABinding,
  );
  assert.deepEqual(projectBDelta, [
    {
      id: "memory-project-a",
      revision: 2,
      status: "deleted",
      scope: "conversation",
      semanticKey: "memory-project-a",
      source: "memory-out-of-scope",
    },
  ]);
  const revokedCursor = createAgentSyncCursor({
    state: { conversations: [] },
    memoryDocument: { revision: 2 },
    conversationId: "conversation-a",
    deliveredMemoryRecords: projectBDelta,
    previous: projectABinding.syncCursor,
  });
  assert.equal(revokedCursor.memoryStatuses["memory-project-a"], "deleted");
  const projectAReturnDelta = agentMemoryDelta(
    {
      state: { settings: { memoryEnabled: true } },
      memorySyncRecords: [
        {
          id: "memory-project-a",
          revision: 2,
          status: "active",
          scope: "project",
        },
      ],
    },
    {
      agentSessionId: "native-project-a",
      syncCursor: revokedCursor,
    },
  );
  assert.equal(projectAReturnDelta.length, 1);
  assert.equal(projectAReturnDelta[0].status, "active");
  const interruptedState = {
    conversations: [
      {
        id: "conversation-interrupted",
        messages: [
          { id: "user-1", role: "user", content: "开始任务" },
          {
            id: "assistant-1",
            role: "assistant",
            content: "任务已执行到中断位置",
          },
          { id: "user-2", role: "user", content: "继续处理" },
        ],
      },
    ],
  };
  const interruptedCursor = createAgentSyncCursor({
    state: interruptedState,
    memoryDocument: { revision: 1 },
    conversationId: "conversation-interrupted",
    lastMessageId: "assistant-1",
    taskId: "run-interrupted",
    deliveredContent: [
      "user\u0000开始任务",
      "assistant\u0000任务已执行到中断位置",
    ],
  });
  const { agentConversationDelta } = await import("../gateway/memory.mjs");
  const resumeDelta = agentConversationDelta(
    interruptedState,
    "conversation-interrupted",
    { agentSessionId: "native-interrupted", syncCursor: interruptedCursor },
    { currentUserMessageId: "user-2" },
  );
  assert.deepEqual(
    resumeDelta.messages,
    [],
    "中断前已投递到原生会话的内容不应在继续时重复注入",
  );
  const reusableDynamicBinding = agentBindingKey({
    serverId: "server-a",
    workspaceId: workspaceA,
    agentId: "opencode",
    conversationId: "virtual-conversation",
  });
  assert.equal(
    reusableDynamicBinding,
    agentBindingKey({
      serverId: "server-a",
      workspaceId: workspaceA,
      agentId: "opencode",
      conversationId: "virtual-conversation",
    }),
  );
  assert.notEqual(
    reusableDynamicBinding,
    agentBindingKey({
      serverId: "server-a",
      workspaceId: workspaceA,
      agentId: "opencode-user",
      conversationId: "virtual-conversation",
    }),
  );
  assert.notEqual(
    reusableDynamicBinding,
    agentBindingKey({
      serverId: "server-a",
      workspaceId: workspaceA,
      agentId: "opencode",
      conversationId: "another-conversation",
    }),
  );
  assert.equal(
    normalizeWorkspaceRecord({
      serverId: "server-a",
      path: "/home/user/.easywork/virtual/conversation-a",
      name: "虚拟工作区",
      mode: "managed",
      kind: "virtual",
      virtualConversationId: "conversation-a",
    }).virtualConversationId,
    "conversation-a",
  );
  assert.deepEqual(
    agentRuntimeCapabilities("opencode", "ready", { liveControl: true }),
    {
      liveInput: true,
      nativeAbort: true,
      resumeSession: true,
      nativePlanning: true,
      workspaceCheckpoint: true,
      contextReadable: true,
      permissions: true,
    },
  );
  assert.equal(
    agentRuntimeCapabilities("opencode", "ready", { liveControl: false })
      .liveInput,
    false,
  );
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
  assert.equal(
    classifyOpenCodeText("正在整理。[[E").output,
    "正在整理。",
  );
  assert.equal(
    classifyOpenCodeText("正在整理。[[EASYWORK_F").output,
    "正在整理。",
  );
  const prompt = await agentPromptWithNativePlanning(
    "用户请求：检查资源",
    "保留用户的资源检查目标。",
  );
  assert.match(prompt, /EasyWork 远程执行 Agent/);
  assert.match(prompt, /原生 todo\/plan 机制/);
  assert.match(prompt, /计划的目标、顺序和状态反映真实执行过程/);
  assert.match(prompt, /简单任务可以直接完成/);
  assert.match(prompt, /保留用户的资源检查目标/);
  assert.match(prompt, /标记只承担文本路由/);
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

  assert.equal(normalizeAgentVersion("opencode v1.2.34"), "1.2.34");
  assert.equal(compareAgentVersions("1.2.33", "1.2.34"), -1);
  assert.equal(compareAgentVersions("1.2.34", "1.2.34"), 0);
  assert.equal(
    remoteAgentPlatform({ os: "linux", arch: "x86_64", musl: "0" }),
    "linux-x64",
  );
  assert.match(remoteOpenCodePortCommand(), /command -v ss/);
  assert.match(remoteOpenCodePortCommand(), /command -v netstat/);
  assert.doesNotMatch(remoteOpenCodePortCommand(), /python/);

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
  assert.equal(
    parseOpenCodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          id: "todo-empty",
          type: "tool_use",
          tool: "todowrite",
          state: { input: {}, status: "pending" },
        },
      }),
      parserState,
    ),
    null,
  );
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

  assert.equal(
    parseOpenCodeLine(
      JSON.stringify({
        type: "message.updated",
        sessionID: "ses_live",
        info: { id: "msg-user", role: "user" },
      }),
      parserState,
    ),
    null,
  );
  assert.equal(
    parseOpenCodeLine(
      JSON.stringify({
        sessionID: "ses_live",
        part: {
          id: "part-user",
          messageID: "msg-user",
          type: "text",
          text: "不得作为 Agent 输出展示的完整用户交接提示",
        },
      }),
      parserState,
    ),
    null,
  );

  const liveSsePart = openCodeSseAgentEvent(
    {
      directory: "/work/project",
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_live",
          part: {
            id: "tool_live",
            type: "tool",
            tool: "bash",
            state: {
              status: "running",
              input: { command: "pwd && sleep 5" },
              metadata: { output: "/work/project\n" },
            },
          },
        },
      },
    },
    { sessionId: "ses_live", directory: "/work/project" },
  );
  assert.equal(liveSsePart.part.id, "tool_live");
  const liveSseEvent = parseOpenCodeLine(
    JSON.stringify(liveSsePart),
    parserState,
  );
  assert.equal(liveSseEvent.status, "running");
  assert.equal(liveSseEvent.command, "pwd && sleep 5");
  assert.equal(liveSseEvent.output, "/work/project\n");
  assert.equal(
    openCodeSseAgentEvent(
      {
        directory: "/other",
        payload: {
          type: "message.part.updated",
          properties: { sessionID: "ses_live", part: liveSsePart.part },
        },
      },
      { sessionId: "ses_live", directory: "/work/project" },
    ),
    null,
  );

  const permissionPart = openCodeSseAgentEvent(
    {
      directory: "/work/project",
      payload: {
        type: "permission.asked",
        properties: {
          sessionID: "ses_live",
          id: "permission-1",
          permission: "bash",
          patterns: ["rm build.tmp"],
        },
      },
    },
    { sessionId: "ses_live", directory: "/work/project" },
  );
  const permissionEvent = parseOpenCodeLine(
    JSON.stringify(permissionPart),
    parserState,
  );
  assert.equal(permissionEvent.kind, "approval_request");
  assert.equal(permissionEvent.approvalId, "permission-1");
  assert.equal(permissionEvent.approvalType, "permission");
  assert.equal(permissionEvent.status, "pending");

  const questionPart = openCodeSseAgentEvent(
    {
      directory: "/work/project",
      payload: {
        type: "question.asked",
        properties: {
          sessionID: "ses_live",
          id: "question-1",
          questions: [
            {
              header: "目标环境",
              question: "部署到哪个环境？",
              options: [{ label: "测试", description: "测试环境" }],
            },
          ],
        },
      },
    },
    { sessionId: "ses_live", directory: "/work/project" },
  );
  const questionEvent = parseOpenCodeLine(
    JSON.stringify(questionPart),
    parserState,
  );
  assert.equal(questionEvent.approvalType, "question");
  assert.equal(questionEvent.title, "目标环境");
  assert.match(questionEvent.output, /部署到哪个环境/);

  const codexState = { eventIndex: 0 };
  assert.deepEqual(
    parseCodexLine(
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread-1" }),
      codexState,
    ),
    [],
  );
  assert.equal(codexState.sessionId, "codex-thread-1");
  const codexController = nativeAgentCommand({
    agent: { adapter: "codex", managed: true, path: "/agents/codex" },
    runtimeConfiguration: {
      model: "test-model",
      profile: {
        reasoningEffort: "medium",
        permissionMode: "on-request",
        sandboxMode: "workspace-write",
      },
      paths: {
        codexHome: "/runtime/codex-home",
        apiKeyPath: "/runtime/provider.key",
        root: "/runtime/codex",
      },
    },
    nativeSession: { created: false, sessionId: "thread-seed" },
    workspace: "/work/project",
    runDirectory: "/runs/codex-live",
    prompt: "测试 Codex 实时控制",
  });
  assert.match(codexController, /app-server --listen stdio:\/\//);
  assert.match(codexController, /on-request/);
  assert.match(codexController, /excludeTurns/);
  assert.match(codexController, /input\.fifo/);
  assert.match(codexController, /grep -Eq .*turn\/completed/);
  const claudeController = nativeAgentCommand({
    agent: { adapter: "claude", managed: true, path: "/agents/claude" },
    runtimeConfiguration: {
      model: "test-model",
      profile: { reasoningEffort: "medium", permissionMode: "acceptEdits" },
      paths: {
        claudeConfigDir: "/runtime/claude-home",
        apiKeyPath: "/runtime/provider.key",
        root: "/runtime/claude",
      },
    },
    nativeSession: { created: true, sessionId: "claude-session" },
    workspace: "/work/project",
    runDirectory: "/runs/claude-live",
    prompt: "测试 Claude 实时控制",
  });
  assert.match(claudeController, /--input-format stream-json/);
  assert.match(claudeController, /input\.fifo/);
  assert.match(claudeController, /grep -Eq .*result/);
  assert.deepEqual(
    parseCodexLine(
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "codex-user-1",
            type: "userMessage",
            content: [{ type: "text", text: "运行中追加" }],
            status: "completed",
          },
        },
      }),
      codexState,
    ),
    [],
  );
  const codexReasoning = parseCodexLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "codex-reasoning-1",
        type: "reasoning",
        text: "准备给出 [[EASYWORK_FINAL]] 标记后的正文。",
        status: "completed",
      },
    }),
    codexState,
  );
  assert.equal(codexReasoning[0].output, "准备给出  标记后的正文。");
  const codexFinal = parseCodexLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "codex-final-1",
        type: "agent_message",
        text: "中间提示。[[EASYWORK_FINAL]]最终正文",
        status: "completed",
      },
    }),
    codexState,
  );
  assert.equal(codexFinal[0].output, "最终正文");
  const codexPlan = parseCodexLine(
    JSON.stringify({
      type: "item.updated",
      item: {
        id: "codex-plan-1",
        type: "todo_list",
        items: [
          { text: "检查环境", status: "completed" },
          { text: "运行测试", status: "in_progress" },
        ],
      },
    }),
    codexState,
  );
  assert.equal(codexPlan[0].kind, "plan");
  assert.deepEqual(
    codexPlan[0].planSteps.map(({ title, status }) => ({ title, status })),
    [
      { title: "检查环境", status: "done" },
      { title: "运行测试", status: "running" },
    ],
  );
  const codexCommand = parseCodexLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "codex-command-1",
        type: "command_execution",
        command: "uname -a",
        aggregated_output: "Linux test",
        status: "completed",
      },
    }),
    codexState,
  );
  assert.equal(codexCommand[0].kind, "tool_call");
  assert.equal(codexCommand[0].status, "done");
  const codexPatch = parseCodexLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "codex-patch-1",
        type: "command_execution",
        command:
          "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: src/created.txt\n+created\n*** Update File: src/existing.txt\n@@\n-old\n+new\n*** End Patch\nPATCH",
        aggregated_output:
          "Success. Updated the following files:\nA src/created.txt\nM src/existing.txt\n",
        status: "completed",
      },
    }),
    codexState,
  );
  assert.equal(codexPatch.length, 2);
  assert.deepEqual(
    codexPatch.map(({ kind, path, status }) => ({ kind, path, status })),
    [
      { kind: "file_change", path: "src/created.txt", status: "done" },
      { kind: "file_change", path: "src/existing.txt", status: "done" },
    ],
  );
  assert.match(codexPatch[1].diff, /-old\n\+new/);
  const failedCodexPatch = parseCodexLine(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "codex-patch-failed",
        type: "command_execution",
        command:
          "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: nope.txt\ninvalid\n*** End Patch\nPATCH",
        aggregated_output: "Invalid patch hunk",
        status: "failed",
      },
    }),
    codexState,
  );
  assert.equal(failedCodexPatch[0].kind, "tool_call");
  assert.equal(failedCodexPatch[0].status, "error");

  const claudeState = { eventIndex: 0 };
  const claudeToolStart = parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-1",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { id: "claude-tool-1", type: "tool_use", name: "Bash" },
      },
    }),
    claudeState,
  );
  assert.equal(claudeToolStart[0].kind, "tool_call");
  const claudeToolInput = parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-1",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
      },
    }),
    claudeState,
  );
  assert.equal(claudeToolInput[0].command, "pwd");
  const claudeResult = parseClaudeCodeLine(
    JSON.stringify({
      type: "result",
      session_id: "claude-session-1",
      result: "任务完成",
      usage: { input_tokens: 120, output_tokens: 30 },
    }),
    claudeState,
  );
  assert.equal(claudeResult[0].kind, "message");
  assert.equal(claudeState.contextUsage.total, 150);
  assert.deepEqual(
    parseClaudeCodeLine(
      JSON.stringify({ type: "tool_use_summary", summary: "" }),
      claudeState,
    ),
    [],
  );

  const claudePlanState = { eventIndex: 0 };
  const emptyClaudePlan = parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-plan",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          id: "claude-task-create",
          type: "tool_use",
          name: "TaskCreate",
          input: {},
        },
      },
    }),
    claudePlanState,
  );
  assert.deepEqual(emptyClaudePlan, []);
  const claudePlanCreated = parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-plan",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ subject: "检查远端环境" }),
        },
      },
    }),
    claudePlanState,
  );
  assert.equal(claudePlanCreated[0].kind, "plan");
  assert.equal(claudePlanCreated[0].sourceId, "agent-native-plan");
  assert.equal(claudePlanCreated[0].planSteps[0].title, "检查远端环境");
  parseClaudeCodeLine(
    JSON.stringify({
      type: "user",
      session_id: "claude-session-plan",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "claude-task-create",
            content: "Task #1 created successfully: 检查远端环境",
          },
        ],
      },
      tool_use_result: { task: { id: "1", subject: "检查远端环境" } },
    }),
    claudePlanState,
  );
  parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-plan",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          id: "claude-task-update",
          type: "tool_use",
          name: "TaskUpdate",
          input: {},
        },
      },
    }),
    claudePlanState,
  );
  const claudePlanCompleted = parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      session_id: "claude-session-plan",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ taskId: "1", status: "completed" }),
        },
      },
    }),
    claudePlanState,
  );
  assert.equal(claudePlanCompleted[0].kind, "plan");
  assert.equal(claudePlanCompleted[0].status, "done");
  assert.equal(claudePlanCompleted[0].planSteps[0].status, "done");

  const claudeThinkingState = { eventIndex: 0 };
  parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", text: "" },
      },
    }),
    claudeThinkingState,
  );
  parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "检查环境" },
      },
    }),
    claudeThinkingState,
  );
  const duplicateClaudeThinking = parseClaudeCodeLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "检查环境" }] },
    }),
    claudeThinkingState,
  );
  assert.deepEqual(duplicateClaudeThinking, []);

  const claudeFinalState = { eventIndex: 0 };
  parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { id: "claude-final", type: "text", text: "" },
      },
    }),
    claudeFinalState,
  );
  const claudeFinalText = parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "[[EASYWORK_FINAL]]最终答案",
        },
      },
    }),
    claudeFinalState,
  );
  assert.equal(claudeFinalText[0].kind, "message");
  assert.equal(claudeFinalText[0].output, "最终答案");
  const claudeMarkerOnlyState = { eventIndex: 0 };
  parseClaudeCodeLine(
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { id: "claude-marker-only", type: "text", text: "" },
      },
    }),
    claudeMarkerOnlyState,
  );
  assert.deepEqual(
    parseClaudeCodeLine(
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "[[EASYWORK_FINAL]]" },
        },
      }),
      claudeMarkerOnlyState,
    ),
    [],
  );

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

  const commandWithEditInItsArgument = parseOpenCodeLine(
    JSON.stringify({
      type: "tool_use",
      part: {
        id: "tool_bash_edit_marker",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo OPEN_EDIT_RESEND_OK" },
          output: "OPEN_EDIT_RESEND_OK",
        },
      },
    }),
    parserState,
  );
  assert.equal(commandWithEditInItsArgument.kind, "tool_call");

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
  assert.equal(
    providerConfigForOpenCode(provider).provider.easywork.models["test-model"]
      .limit.context,
    200_000,
  );
  assert.equal(
    providerConfigForOpenCode(provider).provider.easywork.models["test-model"]
      .limit.output,
    32_768,
  );
  assert.deepEqual(
    providerConfigForOpenCode({
      ...provider,
      modelContextLimit: 200_000,
      modelOutputLimit: 32_000,
    }).provider.easywork.models["test-model"].limit,
    { context: 200_000, output: 32_000 },
  );
  assert.deepEqual(
    providerModelDescriptor({
      id: "model-with-limits",
      context_window: 262_144,
      max_output_tokens: 32_768,
    }),
    {
      id: "model-with-limits",
      contextLimit: 262_144,
      outputLimit: 32_768,
    },
  );
  assert.equal(
    openCodeProviderContextLimit(
      {
        all: [
          {
            id: "easywork",
            models: {
              "test-model": { id: "test-model", limit: { context: 200_000 } },
            },
          },
        ],
      },
      "easywork",
      "test-model",
    ),
    200_000,
  );
  assert.deepEqual(
    openCodeConfiguredModelDetails(
      {
        model: "easywork/test-model",
        provider: {
          easywork: {
            models: {
              "test-model": { limit: { context: 200_000, output: 16_384 } },
            },
          },
        },
      },
    ),
    {
      providerId: "easywork",
      modelId: "test-model",
      model: "easywork/test-model",
      contextLimit: 200_000,
      outputLimit: 16_384,
    },
  );
  assert.equal(
    managedOpenCodeModel(
      { managed: true, model: "agent-selected-model" },
      provider,
      true,
    ),
    "easywork/agent-selected-model",
  );
  assert.equal(
    managedOpenCodeModel({ managed: true }, provider, true),
    "easywork/test-model",
  );
  assert.equal(
    providerRelayTarget(
      "https://api.example.com/v1",
      "/v1/chat/completions?stream=true",
    ).href,
    "https://api.example.com/v1/chat/completions?stream=true",
  );
  assert.equal(
    providerRelayTarget(
      "https://api.example.com/v1",
      "/chat/completions",
    ).href,
    "https://api.example.com/v1/chat/completions",
  );
  const preservedBranch = {
    id: "branch-1",
    title: "分支",
    updatedAt: "2026-08-04T01:00:00.000Z",
    branch: { parentConversationId: "root-1", action: "edit" },
    messages: [{ id: "m1" }],
  };
  assert.deepEqual(
    mergeConversationCollections(
      [preservedBranch],
      [
        {
          id: "other-device-chat",
          title: "另一设备的新对话",
          updatedAt: "2026-08-04T02:00:00.000Z",
          messages: [],
        },
      ],
    ).map((item) => item.id),
    ["other-device-chat", "branch-1"],
  );
  assert.equal(
    mergeConversationCollections(
      [preservedBranch],
      [
        {
          id: "branch-1",
          title: "较新的标题",
          updatedAt: "2026-08-04T03:00:00.000Z",
          messages: [{ id: "m1" }, { id: "m2" }],
        },
      ],
    )[0].branch.parentConversationId,
    "root-1",
  );
  assert.deepEqual(
    mergeConversationCollections(
      [preservedBranch],
      [preservedBranch],
      { ids: { "branch-1": "2026-08-04T04:00:00.000Z" } },
    ),
    [],
  );
  const conciseDiagnostic = conciseOpenCodeDiagnostic(
    'timestamp=x level=ERROR error.error="AI_APICallError: Rate limit exceeded for api_key: 0123456789abcdef0123456789abcdef. Remaining: 0\\n    at SessionPrompt.run (/bunfs/root/chunk.js:1:2)" cause="stack"',
  );
  assert.match(conciseDiagnostic, /Rate limit exceeded/);
  assert.match(conciseDiagnostic, /api_key: \[已配置\]/);
  assert.equal(conciseDiagnostic.includes("SessionPrompt.run"), false);
  assert.ok(conciseDiagnostic.length < 300);

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

test("remote Runtime polling reuses one SFTP channel", async () => {
  const { gatewayTestHelpers } = await import(
    `../gateway/server.mjs?runtime-sftp=${Date.now()}`
  );
  let openedChannels = 0;
  let activeReads = 0;
  let maximumActiveReads = 0;
  const content = new Map([
    ["status", "running\n"],
    ["pid", "4321\n"],
    ["exit_code", ""],
    ["stdout.log", "stdout"],
    ["stderr.log", "stderr"],
    ["agent-events.sse", "data: {}\n"],
  ]);
  const client = {
    sftp(callback) {
      openedChannels += 1;
      callback(null, {
        readFile(remotePath, done) {
          activeReads += 1;
          maximumActiveReads = Math.max(maximumActiveReads, activeReads);
          setImmediate(() => {
            activeReads -= 1;
            const name = remotePath.split("/").at(-1);
            done(null, Buffer.from(content.get(name) || ""));
          });
        },
        end() {},
      });
    },
  };
  const snapshot = await gatewayTestHelpers.readRemoteRuntimeRun(
    { client },
    { runDirectory: "/home/user/.easywork/runtime/runs/run-1" },
  );
  assert.equal(openedChannels, 1);
  assert.equal(maximumActiveReads, 1);
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.pid, "4321");
  assert.equal(snapshot.stdout.toString("utf8"), "stdout");
  assert.equal(snapshot.agentEvents.toString("utf8"), "data: {}\n");
});

test("managed OpenCode uses a conversation-scoped native configuration", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "easywork-agent-config-test-"),
  );
  process.env.EASYWORK_DATA_DIR = path.join(temporaryRoot, "data");
  process.env.EASYWORK_SKILL_DIR = path.join(temporaryRoot, "skill");
  const { createEasyWorkServer, gatewayTestHelpers } = await import(
    `../gateway/server.mjs?agent-config=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await listenHttpServer(server);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const home = "/home/easywork-test";
  const managedPath = `${home}/.easywork/agents/opencode/bin/opencode`;
  const files = new Map([
    [managedPath, { content: Buffer.from("managed-opencode"), mode: 0o755 }],
  ]);

  const fakeClient = {
    exec(command, _options, callback) {
      const stream = new PassThrough();
      stream.stderr = new PassThrough();
      callback(null, stream);
      setImmediate(() => {
        let stdout = "";
        let code = 0;
        if (command.includes('emit_agent opencode "$HOME/.easywork/agents')) {
          if (files.get(managedPath)?.mode & 0o111) {
            stdout = `opencode\t${home}/.easywork/agents/opencode\t${managedPath}\t1.18.9\topencode\teasywork\n`;
          }
        } else if (command.includes("provider-probe.err")) {
          stdout = "CODE=0\nHTTP=401\n";
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
        username: "agent-config",
        password: "correct-horse",
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

    const fakeSession = {
      client: fakeClient,
      home,
      host: "cluster.example.com",
      port: 22,
      username: "cluster-user",
      serverId: "cluster-agent-test",
    };
    const scope = {
      conversationId: "conversation-config-test",
      workspaceId: "workspace-config-test",
    };
    const agents = await gatewayTestHelpers.prepareRemoteAgents(
      fakeSession,
      account.actor,
      scope,
    );
    const opencode = agents.find((agent) => agent.adapter === "opencode");
    assert.equal(opencode.path, managedPath);
    assert.equal(opencode.managed, true);
    assert.equal(opencode.configured, true);
    assert.match(opencode.configPath, /\.easywork\/runtime\/agents\/opencode\//);
    assert.match(opencode.authPath, /\.easywork\/runtime\/agents\/opencode\//);
    assert.match(opencode.configRoot, /\.easywork\/runtime\/agents\/opencode\//);
    assert.equal(files.get(managedPath)?.mode, 0o755);
    const configured = await gatewayTestHelpers.ensureManagedAgentRuntimeConfig(
      fakeSession,
      account.actor,
      opencode,
      scope,
    );
    const configPath = configured.paths.opencodeConfigPath;
    const authPath = configured.paths.opencodeAuthPath;
    assert.match(configPath, /\.easywork\/runtime\/agents\/opencode\//);
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
    await gatewayTestHelpers.ensureManagedAgentRuntimeConfig(
      fakeSession,
      account.actor,
      opencode,
      scope,
    );
    const alternateConfig = JSON.parse(files.get(configPath).content.toString());
    assert.deepEqual(
      Object.keys(alternateConfig.provider.easywork.models),
      ["test-model"],
    );
    assert.equal(
      files.has(`${home}/.config/opencode/opencode.json`),
      false,
      "EasyWork must not write the user's native OpenCode config",
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
  await listenHttpServer(server);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  let cookies = "";

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "easywork-gateway");

    const helpResponse = await fetch(`${base}/api/help`);
    assert.equal(helpResponse.status, 200);
    assert.equal(helpResponse.headers.get("cache-control"), "no-store");
    const helpPayload = await helpResponse.json();
    assert.match(helpPayload.content, /^# EasyWork 使用帮助/m);
    assert.match(helpPayload.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const helpEventsResponse = await fetch(`${base}/api/help/events`);
    assert.equal(helpEventsResponse.status, 200);
    assert.match(
      helpEventsResponse.headers.get("content-type") || "",
      /^text\/event-stream\b/,
    );
    const helpEventsReader = helpEventsResponse.body.getReader();
    const firstHelpEvent = await helpEventsReader.read();
    assert.match(new TextDecoder().decode(firstHelpEvent.value), /connected/);
    await helpEventsReader.cancel();

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
        providers: [
          {
            id: "provider-default",
            name: "OpenAI Compatible",
            baseUrl: "https://api.openai.com/v1",
            model: "test-model",
            protocol: "responses",
            configured: false,
          },
        ],
        activeProviderId: "provider-default",
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
    staleState.settings.providers[0].protocol = "auto";
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
      preservedState.state.settings.providers[0].protocol,
      "responses",
    );

    const branchState = structuredClone(preservedState.state);
    branchState.conversations = [
      {
        id: "conversation-source",
        title: "分支测试",
        mode: "chat",
        updatedAt: new Date().toISOString(),
        messages: [
          { id: "user-1", role: "user", mode: "chat", content: "执行原任务", createdAt: new Date().toISOString() },
          { id: "assistant-1", role: "assistant", mode: "chat", content: "原任务完成", createdAt: new Date().toISOString() },
        ],
      },
    ];
    const branchStateResponse = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({ state: branchState }),
    });
    assert.equal(branchStateResponse.status, 200);
    const branchResponse = await fetch(`${base}/api/conversations/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        action: "reset",
        conversationId: "conversation-source",
        messageId: "assistant-1",
      }),
    });
    assert.equal(branchResponse.status, 200);
    const branchPayload = await branchResponse.json();
    assert.equal(branchPayload.seedPrompt, "执行原任务");
    assert.equal(branchPayload.conversation.id, "conversation-source");
    assert.equal(branchPayload.conversation.messages.length, 0);

    const branchSourceState = structuredClone(branchState);
    branchSourceState.conversations[0].updatedAt = new Date(
      Date.now() + 1_000,
    ).toISOString();
    const branchSourceStateResponse = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({ state: branchSourceState }),
    });
    assert.equal(branchSourceStateResponse.status, 200);
    const nonDestructiveBranchResponse = await fetch(
      `${base}/api/conversations/action`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({
          action: "branch",
          conversationId: "conversation-source",
          messageId: "assistant-1",
          newConversationId: "conversation-branch",
        }),
      },
    );
    assert.equal(nonDestructiveBranchResponse.status, 200);
    const nonDestructiveBranch = await nonDestructiveBranchResponse.json();
    assert.equal(nonDestructiveBranch.conversation.id, "conversation-branch");
    assert.equal(nonDestructiveBranch.conversation.messages.length, 2);
    assert.equal(
      typeof nonDestructiveBranch.conversation.branch.memorySnapshotSequence,
      "number",
    );

    const editResponse = await fetch(`${base}/api/conversations/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        action: "edit",
        conversationId: "conversation-source",
        messageId: "user-1",
        content: "执行修改后的任务",
      }),
    });
    assert.equal(editResponse.status, 200);
    const editPayload = await editResponse.json();
    assert.equal(editPayload.conversation.id, "conversation-source");
    assert.equal(editPayload.conversation.messages.length, 0);
    assert.equal(editPayload.seedPrompt, "执行修改后的任务");
    const stateAfterEditResponse = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookies },
    });
    const stateAfterEdit = await stateAfterEditResponse.json();
    assert.deepEqual(
      stateAfterEdit.state.conversations.map((conversation) => conversation.id),
      ["conversation-source"],
    );

    const rewindState = structuredClone(stateAfterEdit.state);
    const rewindStartedAt = Date.now() + 2_000;
    rewindState.conversations.unshift({
      id: "conversation-rewind",
      title: "回溯测试",
      mode: "chat",
      updatedAt: new Date(rewindStartedAt + 4_000).toISOString(),
      messages: [
        {
          id: "rewind-user-1",
          role: "user",
          mode: "chat",
          content: "保留的问题",
          createdAt: new Date(rewindStartedAt).toISOString(),
        },
        {
          id: "rewind-assistant-1",
          role: "assistant",
          mode: "chat",
          content: "保留的回复",
          createdAt: new Date(rewindStartedAt + 1_000).toISOString(),
        },
        {
          id: "rewind-user-2",
          role: "user",
          mode: "chat",
          content: "需要清除的问题",
          createdAt: new Date(rewindStartedAt + 2_000).toISOString(),
        },
        {
          id: "rewind-assistant-2",
          role: "assistant",
          mode: "chat",
          content: "需要清除的回复",
          createdAt: new Date(rewindStartedAt + 3_000).toISOString(),
        },
      ],
    });
    const rewindStateResponse = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({ state: rewindState }),
    });
    assert.equal(rewindStateResponse.status, 200);

    const rewindDescendantResponse = await fetch(
      `${base}/api/conversations/action`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({
          action: "branch",
          conversationId: "conversation-rewind",
          messageId: "rewind-assistant-2",
          newConversationId: "rewind-descendant",
        }),
      },
    );
    assert.equal(rewindDescendantResponse.status, 200);

    const rewindResponse = await fetch(`${base}/api/conversations/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        action: "rewind",
        conversationId: "conversation-rewind",
        messageId: "rewind-assistant-1",
      }),
    });
    assert.equal(rewindResponse.status, 200);
    const rewindPayload = await rewindResponse.json();
    assert.equal(rewindPayload.seedPrompt, "");
    assert.deepEqual(
      rewindPayload.conversation.messages.map((message) => message.id),
      ["rewind-user-1", "rewind-assistant-1"],
    );
    assert.deepEqual(rewindPayload.removedConversationIds, [
      "rewind-descendant",
    ]);
    assert.equal(
      rewindPayload.capability.rewoundToMessageId,
      "rewind-assistant-1",
    );

    const stateAfterRewindResponse = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookies },
    });
    const stateAfterRewind = await stateAfterRewindResponse.json();
    assert.equal(
      stateAfterRewind.state.conversations.some(
        (conversation) => conversation.id === "rewind-descendant",
      ),
      false,
    );
    assert.deepEqual(
      stateAfterRewind.state.conversations
        .find((conversation) => conversation.id === "conversation-rewind")
        .messages.map((message) => message.id),
      ["rewind-user-1", "rewind-assistant-1"],
    );

    const redundantRewindResponse = await fetch(
      `${base}/api/conversations/action`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({
          action: "rewind",
          conversationId: "conversation-rewind",
          messageId: "rewind-assistant-1",
        }),
      },
    );
    assert.equal(redundantRewindResponse.status, 409);

    const contextResponse = await fetch(
      `${base}/api/context?conversationId=conversation-source&serverId=server-a&agentId=opencode`,
      { headers: { Cookie: cookies } },
    );
    assert.equal(contextResponse.status, 200);
    const contextPayload = await contextResponse.json();
    assert.equal(contextPayload.web.limit, 200_000);
    assert.equal(contextPayload.web.breakdown.messages, 0);
    assert.equal(contextPayload.web.breakdown.system > 0, true);
    assert.equal(contextPayload.web.breakdown.outputReserve, 8_192);
    assert.equal(contextPayload.agent.status, "connection-unavailable");
    assert.equal(contextPayload.agent.bound, false);
    assert.equal(contextPayload.agent.readable, false);
    assert.equal(contextPayload.agent.available, false);
    const unavailableAgentCompact = await fetch(
      `${base}/api/context/agent/compress`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({ conversationId: "conversation-source" }),
      },
    );
    assert.equal(unavailableAgentCompact.status, 409);
    const contextSettingsResponse = await fetch(`${base}/api/context/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        conversationLimit: 80_000,
        automaticCompressionThreshold: 0.82,
      }),
    });
    assert.equal(contextSettingsResponse.status, 200);
    const adjustedContextResponse = await fetch(
      `${base}/api/context?conversationId=conversation-source`,
      { headers: { Cookie: cookies } },
    );
    const adjustedContext = await adjustedContextResponse.json();
    assert.equal(adjustedContext.web.limit, 80_000);
    assert.equal(adjustedContext.web.automaticCompressionThreshold, 0.82);

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
        memoryMode: "project-and-global",
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
        `${base.replace("http:", "ws:")}/easywork-ws?deviceToken=${encodeURIComponent(initial.deviceToken)}`,
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
        `${base.replace("http:", "ws:")}/easywork-ws?deviceToken=${encodeURIComponent(initial.deviceToken)}`,
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

    const workspaceListResponse = await fetch(
      `${base}/api/workspaces?serverId=demo`,
      { headers: { Cookie: cookies } },
    );
    assert.equal(workspaceListResponse.status, 200);
    const workspaceList = await workspaceListResponse.json();
    assert.equal(workspaceList.connected, true);
    assert.equal(workspaceList.home, "/home/demo");
    const homeWorkspace = workspaceList.workspaces.find(
      (workspace) => workspace.path === "/home/demo",
    );
    assert.ok(homeWorkspace?.id);

    const secondWorkspaceResponse = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        serverId: "demo",
        path: "/home/demo/project-b",
      }),
    });
    assert.equal(secondWorkspaceResponse.status, 200);
    const secondWorkspace = (await secondWorkspaceResponse.json()).workspace;
    assert.notEqual(secondWorkspace.id, homeWorkspace.id);

    const virtualWorkspaceResponse = await fetch(
      `${base}/api/workspaces/virtual`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({
          serverId: "demo",
          conversationId: "virtual-conversation",
        }),
      },
    );
    assert.equal(virtualWorkspaceResponse.status, 200);
    const virtualWorkspace = (await virtualWorkspaceResponse.json()).workspace;
    assert.equal(virtualWorkspace.kind, "virtual");
    assert.equal(virtualWorkspace.virtualConversationId, "virtual-conversation");
    assert.match(virtualWorkspace.path, /\.easywork\/virtual\/virtual-conversation$/);
    const scopedVirtualList = await fetch(
      `${base}/api/workspaces?serverId=demo&conversationId=virtual-conversation`,
      { headers: { Cookie: cookies } },
    ).then((response) => response.json());
    assert.ok(
      scopedVirtualList.workspaces.some(
        (workspace) => workspace.id === virtualWorkspace.id,
      ),
    );
    const otherVirtualList = await fetch(
      `${base}/api/workspaces?serverId=demo&conversationId=other-conversation`,
      { headers: { Cookie: cookies } },
    ).then((response) => response.json());
    assert.ok(
      !otherVirtualList.workspaces.some(
        (workspace) => workspace.id === virtualWorkspace.id,
      ),
    );

    const beforeWorkspaceBinding = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookies },
    }).then((response) => response.json());
    const workState = structuredClone(beforeWorkspaceBinding.state);
    workState.conversations = [
      {
        id: "workspace-conversation",
        title: "工作区切换",
        mode: "work",
        updatedAt: new Date().toISOString(),
        messages: [
          {
            id: "workspace-user",
            role: "user",
            mode: "work",
            content: "检查工作区",
            createdAt: new Date().toISOString(),
          },
        ],
        work: {
          serverId: "demo",
          agentId: "opencode",
          connectionEnabled: true,
        },
      },
      ...(workState.conversations || []),
    ];
    const workStateResponse = await fetch(`${base}/api/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({ state: workState }),
    });
    assert.equal(workStateResponse.status, 200);

    const crossConversationVirtualSwitch = await fetch(
      `${base}/api/conversations/workspace-conversation/workspace`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookies },
        body: JSON.stringify({ workspaceId: virtualWorkspace.id }),
      },
    );
    assert.equal(crossConversationVirtualSwitch.status, 409);
    assert.match(
      (await crossConversationVirtualSwitch.json()).error,
      /虚拟工作区只属于创建它的对话/,
    );

    for (const workspace of [homeWorkspace, secondWorkspace, homeWorkspace]) {
      const switchResponse = await fetch(
        `${base}/api/conversations/workspace-conversation/workspace`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Cookie: cookies },
          body: JSON.stringify({ workspaceId: workspace.id }),
        },
      );
      assert.equal(switchResponse.status, 200);
    }
    const workspaceBoundState = await fetch(`${base}/api/bootstrap`, {
      headers: { Cookie: cookies },
    }).then((response) => response.json());
    const workspaceConversation = workspaceBoundState.state.conversations.find(
      (conversation) => conversation.id === "workspace-conversation",
    );
    assert.equal(workspaceConversation.work.workspaceId, homeWorkspace.id);
    assert.equal(workspaceConversation.work.workspace, "/home/demo");
    assert.deepEqual(
      workspaceConversation.work.workspaceHistory.map((entry) => entry.workspaceId),
      [homeWorkspace.id, secondWorkspace.id, homeWorkspace.id],
    );

    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies },
      body: JSON.stringify({
        username: "测试用户",
        password: "correct-horse",
      }),
    });
    assert.equal(registration.status, 200);
    cookies = mergeCookies(cookies, registration);
    const registered = await registration.json();
    assert.equal(registered.actor.authenticated, true);
    assert.equal(registered.actor.username, "测试用户");
    assert.equal("email" in registered.actor, false);
    assert.ok(registered.deviceToken);

    const authenticatedBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${registered.deviceToken}` },
    });
    const authenticated = await authenticatedBootstrap.json();
    assert.equal(authenticated.actor.displayName, "测试用户");
    assert.equal(authenticated.state.settings.memoryEnabled, true);

    const renamedProfileResponse = await fetch(`${base}/api/profile`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${registered.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "重命名用户" }),
    });
    assert.equal(renamedProfileResponse.status, 200);
    const renamedProfile = await renamedProfileResponse.json();
    assert.equal(renamedProfile.actor.username, "重命名用户");

    const oldUsernameLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "测试用户",
        password: "correct-horse",
      }),
    });
    assert.equal(oldUsernameLogin.status, 401);
    assert.equal(
      (await oldUsernameLogin.json()).error,
      "用户名或密码不正确",
    );

    const renamedLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "重命名用户",
        password: "correct-horse",
      }),
    });
    assert.equal(renamedLogin.status, 200);
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
  await listenHttpServer(server);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "background-work",
        password: "correct-horse",
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
      workspace: "/home/background/project",
      workspaceId: "workspace-background-project",
      workspaceName: "后台项目",
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
        id: "reasoning-bg",
        kind: "reasoning",
        title: "思考中",
        output: "先核对后台任务的持久化状态。",
        status: "running",
        timestamp: new Date().toISOString(),
      },
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "agent.event",
      conversationId: task.conversationId,
      runId: task.runId,
      event: {
        id: "reasoning-bg",
        kind: "reasoning",
        title: "思考完成",
        status: "done",
        timestamp: new Date().toISOString(),
      },
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
    assert.equal(
      conversation.messages.find((message) => message.role === "assistant").reasoning,
      "先核对后台任务的持久化状态。",
    );
    const abortedTask = gatewayTestHelpers.createWorkerTask(session, {
      conversationId: "conversation-aborted",
      runId: "run-aborted",
      prompt: "停止远端命令",
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "agent.event",
      runId: abortedTask.runId,
      event: {
        id: "command-aborted",
        kind: "tool_call",
        command: "sleep 120",
        status: "running",
      },
    });
    gatewayTestHelpers.publishWorkerEvent(session, {
      type: "task.aborted",
      runId: abortedTask.runId,
      result: "任务已停止。",
    });
    assert.equal(abortedTask.status, "aborted");
    assert.equal(abortedTask.events[0].status, "cancelled");
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
  await listenHttpServer(server);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "multi-device",
        password: "correct-horse",
      }),
    });
    assert.equal(registration.status, 200);
    const firstDevice = await registration.json();
    assert.equal(firstDevice.actor.username, "multi-device");
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
        username: "multi-device",
        password: "correct-horse",
      }),
    });
    assert.equal(secondLogin.status, 200);
    const secondDevice = await secondLogin.json();
    const secondBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${secondDevice.deviceToken}` },
    });
    const sharedAccount = await secondBootstrap.json();
    const sharedProvider = sharedAccount.state.settings.providers.find(
      (provider) => provider.id === sharedAccount.state.settings.activeProviderId,
    );
    assert.equal(sharedProvider.baseUrl, "https://llm.example.com/v1");
    assert.equal(sharedProvider.model, "shared-model");
    assert.equal(sharedProvider.configured, true);
    assert.equal("apiKey" in sharedProvider, false);
    assert.equal("provider" in sharedAccount.state.settings, false);
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
    staleState.settings.providers = staleState.settings.providers.map((provider) =>
      provider.id === staleState.settings.activeProviderId
        ? {
            ...provider,
            baseUrl: "https://stale-device.invalid/v1",
            model: "stale-model",
            configured: false,
          }
        : provider,
    );
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
    assert.equal(
      protectedAccount.state.settings.providers.find(
        (provider) => provider.id === protectedAccount.state.settings.activeProviderId,
      ).model,
      "shared-model",
    );
    assert.ok(
      protectedAccount.state.settings.servers.some(
        (profile) => profile.id === "shared-cluster",
      ),
    );

    const otherRegistration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "isolated-user",
        password: "correct-horse",
      }),
    });
    assert.equal(otherRegistration.status, 200);
    const otherAccount = await otherRegistration.json();
    const otherBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${otherAccount.deviceToken}` },
    });
    const isolated = await otherBootstrap.json();
    assert.equal(isolated.state.settings?.providers?.[0]?.configured, false);
    assert.equal(isolated.state.settings?.providers?.length, 1);
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
  await listenHttpServer(server);
  const gatewayAddress = server.address();
  const sshAddress = interruptedSshServer.address();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  const events = [];
  let socket;

  try {
    await new Promise((resolve, reject) => {
      socket = new WebSocket(`ws://127.0.0.1:${gatewayAddress.port}/easywork-ws`);
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
  await listenHttpServer(server);
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
        username: "ssh-profile",
        password: "correct-horse",
      }),
    });
    assert.equal(registration.status, 200);
    const account = await registration.json();
    socket = new WebSocket(
      `${base.replace("http:", "ws:")}/easywork-ws?deviceToken=${encodeURIComponent(account.deviceToken)}`,
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
        keyName: "cluster_ed25519",
        rememberCredential: true,
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
        keyName: "cluster_ed25519",
        rememberCredential: true,
        trustHost: true,
      },
      { expectProfile: true },
    );

    const secondDeviceLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "ssh-profile",
        password: "correct-horse",
      }),
    });
    assert.equal(secondDeviceLogin.status, 200);
    const secondDeviceAccount = await secondDeviceLogin.json();
    const authenticationCountBeforeSecondDevice = authenticationCount;
    const secondDeviceSnapshot = await new Promise((resolve, reject) => {
      secondDeviceSocket = new WebSocket(
        `${base.replace("http:", "ws:")}/easywork-ws?deviceToken=${encodeURIComponent(secondDeviceAccount.deviceToken)}`,
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
        `${base.replace("http:", "ws:")}/easywork-ws?deviceToken=${encodeURIComponent(account.deviceToken)}`,
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
          "runtime",
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
        if (
          event.type !== "connection.status" ||
          event.serverId !== "cluster-b" ||
          event.status !== "connected"
        ) {
          return;
        }
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve();
      };
      socket.on("message", onMessage);
      socket.send(
        JSON.stringify({
          type: "ssh.connect",
          serverId: "cluster-b",
          useSavedCredential: true,
        }),
      );
    });
    await waitForConnection({
      type: "ssh.connect",
      serverId: "cluster-a",
      host: "127.0.0.1",
      port: sshAddress.port,
      username: "cluster-user",
      useSavedCredential: true,
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
  await listenHttpServer(providerServer);
  const providerAddress = providerServer.address();
  const providerBase = `http://127.0.0.1:${providerAddress.port}/v1`;

  const { createEasyWorkServer } = await import(
    `../gateway/server.mjs?models=${Date.now()}`
  );
  const { server } = await createEasyWorkServer();
  await listenHttpServer(server);
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
    assert.equal(embeddingResponse.status, 403);
    assert.match((await embeddingResponse.json()).error, /管理员统一配置/);

    const adminRegistration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EasyWork-Device-Id": "model-test-device-0001",
      },
      body: JSON.stringify({
        username: "platform-admin",
        password: "correct-horse",
      }),
    });
    assert.equal(adminRegistration.status, 200);
    const adminAccount = await adminRegistration.json();
    assert.equal(adminAccount.actor.isAdmin, true);
    const adminEmbeddingResponse = await fetch(`${base}/api/admin/providers/models`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminAccount.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        category: "embedding",
        baseUrl: providerBase,
        apiKey: "test-key",
      }),
    });
    assert.equal(adminEmbeddingResponse.status, 200);
    assert.deepEqual((await adminEmbeddingResponse.json()).models, [
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
    const saveSecondProviderResponse = await fetch(
      `${base}/api/settings/provider`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify({
          providerId: "provider-backup",
          name: "备用 API",
          baseUrl: providerBase,
          apiKey: "backup-key",
          activate: false,
        }),
      },
    );
    assert.equal(saveSecondProviderResponse.status, 200);
    const secondProviderPayload = await saveSecondProviderResponse.json();
    assert.equal(secondProviderPayload.activeProviderId, "provider-default");
    assert.equal(secondProviderPayload.providers.length, 2);
    const secondStoredKeyResponse = await fetch(
      `${base}/api/settings/provider/key?providerId=provider-backup`,
      { headers: { Authorization: authorization } },
    );
    assert.equal(secondStoredKeyResponse.status, 200);
    assert.equal((await secondStoredKeyResponse.json()).apiKey, "backup-key");
    const originalStoredKeyResponse = await fetch(
      `${base}/api/settings/provider/key?providerId=provider-default`,
      { headers: { Authorization: authorization } },
    );
    assert.equal((await originalStoredKeyResponse.json()).apiKey, "test-key");
    const activateSecondProviderResponse = await fetch(
      `${base}/api/settings/provider`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify({
          providerId: "provider-backup",
          name: "备用 API",
          baseUrl: providerBase,
          model: "chat-model",
          protocol: "chat-completions",
          activate: true,
        }),
      },
    );
    assert.equal(activateSecondProviderResponse.status, 200);
    const activatedSecondProvider = await activateSecondProviderResponse.json();
    assert.equal(activatedSecondProvider.activeProviderId, "provider-backup");
    assert.equal("provider" in activatedSecondProvider, false);
    assert.equal(
      activatedSecondProvider.providers.find(
        (provider) => provider.id === activatedSecondProvider.activeProviderId,
      ).model,
      "chat-model",
    );
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

    const firstDeviceBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: {
        Authorization: `Bearer ${adminAccount.deviceToken}`,
        "X-EasyWork-Device-Id": "admin-browser-device-0001",
      },
    });
    assert.equal(firstDeviceBootstrap.status, 200);
    assert.equal((await firstDeviceBootstrap.json()).device.firstVisit, true);
    const returningDeviceBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: {
        Authorization: `Bearer ${adminAccount.deviceToken}`,
        "X-EasyWork-Device-Id": "admin-browser-device-0001",
      },
    });
    assert.equal(returningDeviceBootstrap.status, 200);
    assert.equal((await returningDeviceBootstrap.json()).device.firstVisit, false);

    const platformSettingsResponse = await fetch(`${base}/api/admin/platform`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminAccount.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providers: {
          web: { name: "站点网页模型", baseUrl: providerBase, model: "chat-model" },
          agent: { name: "站点 Agent 模型", baseUrl: providerBase, model: "chat-model" },
        },
        embedding: {
          name: "站点向量模型",
          baseUrl: providerBase,
          model: "text-embedding-test",
          chunkStrategy: "paragraph",
          chunkSize: 1200,
          chunkOverlap: 120,
          batchSize: 16,
          hybridEnabled: true,
          rerankEnabled: true,
        },
        webApiKey: "platform-web-secret",
        agentApiKey: "platform-agent-secret",
        embeddingApiKey: "platform-embedding-secret",
      }),
    });
    assert.equal(platformSettingsResponse.status, 200);
    const platformSettings = await platformSettingsResponse.json();
    assert.equal(platformSettings.settings.providers.web.configured, true);
    assert.equal(platformSettings.settings.providers.agent.configured, true);
    assert.equal(platformSettings.settings.embedding.chunkStrategy, "paragraph");
    assert.equal(platformSettings.settings.embedding.chunkSize, 1200);
    assert.equal("apiKey" in platformSettings.settings.providers.web, false);

    const sshPolicyResponse = await fetch(`${base}/api/admin/ssh-policy`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${adminAccount.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ssh: {
          idleTtlMinutes: 1440,
          keepaliveIntervalSeconds: 45,
          keepaliveCountMax: 4,
          connectTimeoutSeconds: 18,
          cleanupIntervalMinutes: 90,
        },
      }),
    });
    assert.equal(sshPolicyResponse.status, 200);
    assert.equal((await sshPolicyResponse.json()).settings.ssh.idleTtlMinutes, 1440);

    const publicBootstrap = await fetch(`${base}/api/bootstrap`, {
      headers: { "X-EasyWork-Device-Id": "public-model-device-0001" },
    });
    assert.equal(publicBootstrap.status, 200);
    const publicPayload = await publicBootstrap.json();
    assert.ok(
      publicPayload.state.settings.providers.some(
        (provider) => provider.id === "platform-web" && provider.managedBy === "platform",
      ),
    );
    assert.equal(publicPayload.state.settings.embedding.model, "text-embedding-test");
    const publicChatResponse = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publicPayload.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversationId: "platform-usage-chat",
        userMessageId: "platform-usage-user",
        assistantMessageId: "platform-usage-assistant",
        prompt: "验证平台公共模型",
        firstTurn: false,
      }),
    });
    assert.equal(publicChatResponse.status, 200);
    assert.match(await publicChatResponse.text(), /"type":"done"/);

    const secondRegistration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ordinary-user", password: "correct-horse" }),
    });
    assert.equal(secondRegistration.status, 200);
    const secondAccount = await secondRegistration.json();
    assert.equal(secondAccount.actor.isAdmin, false);
    const forbiddenOverview = await fetch(`${base}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${secondAccount.deviceToken}` },
    });
    assert.equal(forbiddenOverview.status, 403);

    const adminListPath = path.join(
      process.env.EASYWORK_DATA_DIR,
      "admins",
      "adminList",
    );
    const initialAdminList = await readFile(adminListPath, "utf8");
    assert.match(initialAdminList, /platform-admin/);
    await writeFile(adminListPath, `${initialAdminList.trim()}\nordinary-user\n`, "utf8");
    const delegatedOverview = await fetch(`${base}/api/admin/overview`, {
      headers: { Authorization: `Bearer ${secondAccount.deviceToken}` },
    });
    assert.equal(delegatedOverview.status, 200);
    const overviewPayload = await delegatedOverview.json();
    assert.equal(overviewPayload.userCount, 2);
    assert.equal(overviewPayload.adminCount, 2);
    assert.ok(overviewPayload.usage.daily.web.requests >= 1);

    const platformSecretsSource = await readFile(
      path.join(process.env.EASYWORK_DATA_DIR, "admins", "platform-secrets.json"),
      "utf8",
    );
    assert.doesNotMatch(platformSecretsSource, /platform-(?:web|agent|embedding)-secret/);

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
