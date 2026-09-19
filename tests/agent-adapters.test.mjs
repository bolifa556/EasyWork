import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EVENT_KINDS,
  AGENT_OPERATIONS,
  createAgentAdapters,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createOpenCodeAdapter,
  createQoderCnAdapter,
} from "../gateway/core/agents/index.mjs";
import { migrateLegacyRegenerationFork } from "../gateway/core/agent-runtime/native-session.mjs";

function consume(adapter, frames) {
  let state = adapter.createState();
  const events = [];
  for (const frame of frames) {
    const before = structuredClone(state);
    const result = adapter.reduce(state, frame);
    assert.deepEqual(state, before, `${adapter.id} reducer mutated its input state`);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

function assertCanonical(adapter, events) {
  const allowed = new Set(AGENT_EVENT_KINDS);
  let previous = 0;
  for (const event of events) {
    assert.equal(allowed.has(event.kind), true, `unexpected kind ${event.kind}`);
    assert.equal(event.sequence, previous + 1);
    assert.deepEqual(event.producer, adapter.producer);
    assert.equal(Object.hasOwn(event, "raw"), false);
    assert.equal(Object.hasOwn(event.payload, "apiKey"), false);
    previous = event.sequence;
  }
}

test("四种 Agent adapter 声明同一 clean-break contract 与显式 capability", () => {
  const adapters = createAgentAdapters();
  assert.deepEqual(Object.keys(adapters), ["opencode", "codex", "claude-code", "qoder-cn"]);
  assert.deepEqual(AGENT_EVENT_KINDS, [
    "message", "reasoning", "plan", "tool_call", "tool_result", "approval_request", "approval_response",
    "input_request", "input_response", "file_change", "job_status", "artifact", "usage", "status", "error", "final",
  ]);
  for (const adapter of Object.values(adapters)) {
    assert.deepEqual(Object.keys(adapter.capabilities), AGENT_OPERATIONS);
    for (const operation of AGENT_OPERATIONS) {
      assert.match(adapter.capabilities[operation].availability, /^(?:available|unavailable)$/);
      assert.equal(typeof adapter.capabilities[operation].mode, "string");
    }
  }
  assert.equal(adapters["claude-code"].capabilities.interrupt.mode, "native");
  assert.equal(adapters.opencode.capabilities.contextUsage.mode, "derived");
  assert.equal(adapters.codex.capabilities.fork.availability, "available");
  assert.equal(adapters.codex.capabilities.revert.availability, "available");
  assert.equal(adapters.opencode.capabilities.fork.availability, "available");
  assert.equal(adapters.opencode.capabilities.revert.availability, "available");
  assert.equal(adapters["claude-code"].capabilities.fork.availability, "available");
  assert.equal(adapters["claude-code"].capabilities.revert.availability, "available");
  assert.equal(adapters["qoder-cn"].capabilities.append.mode, "native");
  assert.equal(adapters["qoder-cn"].capabilities.fork.availability, "available");
  assert.equal(adapters["qoder-cn"].capabilities.revert.availability, "available");
});

test("四种 Agent 把思考档位自动适配归一为同一种可见配置事件", () => {
  const configuration = {
    agentId: "codex",
    source: "system",
    configScope: "conversation-effort",
    revision: 4,
    values: { model: "provider/model-a", reasoningEffort: "xhigh" },
  };
  const adjustment = {
    operation: "agent_effort_adjusted",
    message: "由于 provider/model-a 不接受 high 思考档位，已自动为您切换至 xhigh 档位。",
    model: "provider/model-a",
    field: "reasoningEffort",
    requestedEffort: "high",
    appliedEffort: "xhigh",
    supportedEfforts: ["low", "medium", "xhigh"],
    configuration,
  };
  const cases = [
    [createOpenCodeAdapter(), { type: "easywork.effort.adjusted", data: adjustment }],
    [createCodexAdapter(), { method: "easywork/effortAdjusted", params: adjustment }],
    [createClaudeCodeAdapter(), { type: "easywork_effort_adjusted", adjustment }],
    [createQoderCnAdapter(), { type: "easywork_effort_adjusted", adjustment }],
  ];

  for (const [adapter, frame] of cases) {
    const { events } = consume(adapter, [frame]);
    assertCanonical(adapter, events);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "job_status");
    assert.equal(events[0].phase, "completed");
    assert.equal(events[0].payload.operation, "agent_effort_adjusted");
    assert.equal(events[0].payload.requestedEffort, "high");
    assert.equal(events[0].payload.appliedEffort, "xhigh");
    assert.deepEqual(events[0].payload.configuration, configuration);
  }
});

test("capability override 会稳定拒绝 unavailable operation", () => {
  const adapter = createCodexAdapter({
    capabilityOverrides: {
      append: { availability: "unavailable", reason: "runtime schema lacks turn/steer" },
    },
  });
  assert.throws(
    () => adapter.operation("append", { threadId: "t", turnId: "v", prompt: "next" }),
    (error) => error.code === "AGENT_CAPABILITY_UNAVAILABLE"
      && error.details.adapter === "codex"
      && error.details.operation === "append",
  );
});

test("operation descriptors 只描述官方 transport，不携带认证字段", () => {
  const openCode = createOpenCodeAdapter();
  const codex = createCodexAdapter();
  const claude = createClaudeCodeAdapter();
  const qoder = createQoderCnAdapter();

  const descriptors = [
    openCode.operation("start", { prompt: "inspect files" }),
    openCode.operation("append", { sessionId: "s-1", prompt: "continue" }),
    openCode.operation("interrupt", { sessionId: "s-1" }),
    openCode.operation("resume", { sessionId: "s-1", prompt: "resume" }),
    openCode.operation("compact", { sessionId: "s-1", providerId: "p", modelId: "m" }),
    openCode.operation("contextUsage", { sessionId: "s-1" }),
    codex.operation("start", { prompt: "inspect files", cwd: "/work" }),
    codex.operation("append", { threadId: "t-1", turnId: "v-1", prompt: "continue" }),
    codex.operation("interrupt", { threadId: "t-1", turnId: "v-1" }),
    codex.operation("resume", { threadId: "t-1", prompt: "resume", cwd: "/work/next" }),
    codex.operation("compact", { threadId: "t-1" }),
    codex.operation("contextUsage", { threadId: "t-1" }),
    claude.operation("start", { prompt: "inspect files", cwd: "/work", sessionId: "s-existing" }),
    claude.operation("append", { prompt: "continue", commandId: "append-command-1" }),
    claude.operation("interrupt", { processId: "pid-1", commandId: "command-1" }),
    claude.operation("resume", { sessionId: "s-1", prompt: "continue" }),
    claude.operation("compact", { sessionId: "s-1" }),
    claude.operation("contextUsage", { sessionId: "s-1" }),
    codex.operation("fork", { threadId: "t-source", path: "/rollouts/source.jsonl", lastTurnId: "turn-7", cwd: "/work" }),
    codex.operation("revert", { threadId: "t-source", beforeTurnId: "turn-8" }),
    openCode.operation("fork", { sessionId: "s-source", retainedMessageId: "msg-7" }),
    openCode.operation("revert", { sessionId: "s-source", retainedMessageId: "msg-7" }),
    claude.operation("fork", { sourceSessionId: "11111111-1111-4111-8111-111111111111", targetSessionId: "22222222-2222-4222-8222-222222222222", resumeSessionAt: "33333333-3333-4333-8333-333333333333" }),
    claude.operation("revert", { sessionId: "11111111-1111-4111-8111-111111111111", resumeSessionAt: "33333333-3333-4333-8333-333333333333" }),
    qoder.operation("start", { prompt: "inspect files", cwd: "/work", sessionId: "q-session" }),
    qoder.operation("append", { prompt: "continue" }),
    qoder.operation("resume", { sessionId: "q-session", prompt: "continue", cwd: "/work/next" }),
    qoder.operation("compact", { sessionId: "q-session", cwd: "/work/next" }),
    qoder.operation("fork", { sourceSessionId: "q-source", targetSessionId: "q-target", resumeSessionAt: "q-message" }),
    qoder.operation("revert", { sessionId: "q-source", resumeSessionAt: "q-message" }),
  ];
  const json = JSON.stringify(descriptors);
  assert.equal(/apiKey|password|privateKey|authorization/i.test(json), false);
  assert.equal(descriptors[0].transaction[1].path, "/api/session/$session.id/prompt");
  assert.deepEqual(descriptors[6].calls[0], {
    method: "thread/start",
    params: { cwd: "/work", historyMode: "paginated" },
  });
  assert.equal(descriptors[7].calls[0].method, "turn/steer");
  assert.equal(descriptors[9].calls[0].params.cwd, "/work/next");
  assert.equal(descriptors[9].calls[1].params.cwd, "/work/next");
  assert.equal(descriptors[12].executable, "claude");
  assert.deepEqual(descriptors[12].args.slice(-2), ["--resume", "s-existing"]);
  assert.deepEqual(descriptors[13], {
    adapter: "claude-code",
    operation: "append",
    transport: "process-jsonl-stdin",
    frames: [{
      type: "control_request",
      request_id: "easywork-steer-append-command-1",
      request: { subtype: "interrupt" },
    }, {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "continue" }] },
      parent_tool_use_id: null,
    }],
  });
  assert.deepEqual(descriptors[14], {
    adapter: "claude-code",
    operation: "interrupt",
    transport: "process-jsonl-stdin",
    frames: [{
      type: "control_request",
      request_id: "easywork-interrupt-command-1",
      request: { subtype: "interrupt" },
    }],
  });
  const codexFork = descriptors.find((descriptor) => descriptor.adapter === "codex" && descriptor.operation === "fork");
  const codexRevert = descriptors.find((descriptor) => descriptor.adapter === "codex" && descriptor.operation === "revert");
  const openCodeFork = descriptors.find((descriptor) => descriptor.adapter === "opencode" && descriptor.operation === "fork");
  const openCodeRevert = descriptors.find((descriptor) => descriptor.adapter === "opencode" && descriptor.operation === "revert");
  const claudeFork = descriptors.find((descriptor) => descriptor.adapter === "claude-code" && descriptor.operation === "fork");
  const claudeRevert = descriptors.find((descriptor) => descriptor.adapter === "claude-code" && descriptor.operation === "revert");
  assert.deepEqual(codexFork.calls, [{
    method: "thread/fork",
    params: {
      threadId: "t-source",
      path: "/rollouts/source.jsonl",
      lastTurnId: "turn-7",
      cwd: "/work",
      excludeTurns: true,
    },
  }]);
  assert.deepEqual(codexRevert.calls, [{
    method: "thread/revert",
    params: { threadId: "t-source", beforeTurnId: "turn-8" },
  }]);
  assert.deepEqual(openCodeFork, {
    adapter: "opencode",
    operation: "fork",
    transport: "http",
    request: { method: "POST", path: "/api/session/s-source/fork", body: {} },
    boundary: { mode: "retain-through", messageId: "msg-7" },
  });
  assert.deepEqual(openCodeRevert, {
    adapter: "opencode",
    operation: "revert",
    transport: "http",
    request: { method: "POST", path: "/api/session/s-source/revert", body: {} },
    boundary: { mode: "retain-through", messageId: "msg-7" },
  });
  assert.deepEqual(claudeFork, {
    adapter: "claude-code",
    operation: "fork",
    transport: "native-deferred",
    sourceSessionId: "11111111-1111-4111-8111-111111111111",
    targetSessionId: "22222222-2222-4222-8222-222222222222",
    resumeSessionAt: "33333333-3333-4333-8333-333333333333",
  });
  assert.deepEqual(claudeRevert, {
    adapter: "claude-code",
    operation: "revert",
    transport: "native-rewind-deferred",
    sessionId: "11111111-1111-4111-8111-111111111111",
    resumeSessionAt: "33333333-3333-4333-8333-333333333333",
  });

  assert.deepEqual(openCode.operation("respondApproval", { requestId: "permission-1", decision: "approve_session", pendingApproval: { sessionId: "s-1" } }), {
    adapter: "opencode",
    operation: "respondApproval",
    transport: "http",
    request: { method: "POST", path: "/api/session/s-1/permission/permission-1/reply", body: { reply: "always" } },
  });
  assert.deepEqual(codex.operation("respondApproval", {
    requestId: "command-1",
    decision: "approve",
    pendingApproval: { wireRequestId: 77 },
  }), {
    adapter: "codex",
    operation: "respondApproval",
    transport: "json-rpc-response",
    requestId: 77,
    result: { decision: "accept" },
  });
  assert.deepEqual(claude.operation("respondApproval", { requestId: "request-1", decision: "reject" }), {
    adapter: "claude-code",
    operation: "respondApproval",
    transport: "process-jsonl-stdin",
    frames: [{
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-1",
        response: { behavior: "deny", message: "User rejected this operation." },
      },
    }],
  });
  assert.deepEqual(claude.operation("respondApproval", {
    requestId: "request-2",
    decision: "approve_session",
    pendingApproval: {
      suggestions: [{
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "timeout 120 python2 -m unittest discover -s tests" }],
        behavior: "allow",
        destination: "localSettings",
      }],
    },
  }), {
    adapter: "claude-code",
    operation: "respondApproval",
    transport: "process-jsonl-stdin",
    frames: [{
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-2",
        response: {
          behavior: "allow",
          updatedPermissions: [{
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "timeout 120 python2 -m unittest discover -s tests" }],
            behavior: "allow",
            destination: "session",
          }],
        },
      },
    }],
  });
  const qoderStart = descriptors.find((descriptor) => descriptor.adapter === "qoder-cn" && descriptor.operation === "start");
  const qoderAppend = descriptors.find((descriptor) => descriptor.adapter === "qoder-cn" && descriptor.operation === "append");
  const qoderResume = descriptors.find((descriptor) => descriptor.adapter === "qoder-cn" && descriptor.operation === "resume");
  const qoderFork = descriptors.find((descriptor) => descriptor.adapter === "qoder-cn" && descriptor.operation === "fork");
  const qoderRevert = descriptors.find((descriptor) => descriptor.adapter === "qoder-cn" && descriptor.operation === "revert");
  assert.equal(qoderStart.executable, "qoderclicn");
  assert.deepEqual(qoderStart.args.slice(-2), ["--resume", "q-session"]);
  assert.equal(qoderStart.cwd, "/work");
  assert.deepEqual(qoderAppend.frames, [{
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "continue" }] },
    parent_tool_use_id: null,
    priority: "now",
  }]);
  assert.equal(qoderResume.cwd, "/work/next");
  assert.deepEqual(qoderResume.args.slice(-2), ["--resume", "q-session"]);
  assert.deepEqual(qoderFork, {
    adapter: "qoder-cn",
    operation: "fork",
    transport: "native-deferred",
    sourceSessionId: "q-source",
    targetSessionId: "q-target",
    resumeSessionAt: "q-message",
  });
  assert.deepEqual(qoderRevert, {
    adapter: "qoder-cn",
    operation: "revert",
    transport: "native-rewind-deferred",
    sessionId: "q-source",
    resumeSessionAt: "q-message",
  });
});

test("Claude Code 与 Qoder CN 重新生成在当前原生会话内回退，不创建分支", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const resumeSessionAt = "22222222-2222-4222-8222-222222222222";
  for (const adapter of [createClaudeCodeAdapter(), createQoderCnAdapter()]) {
    const descriptor = adapter.operation("start", {
      sessionId,
      prompt: "regenerate",
      pendingRewind: { sessionId, resumeSessionAt },
    });
    assert.deepEqual(
      descriptor.args.slice(descriptor.args.indexOf("--resume"), descriptor.args.indexOf("--resume-session-at") + 2),
      ["--resume", sessionId, "--resume-session-at", resumeSessionAt],
    );
    assert.equal(descriptor.args.includes("--fork-session"), false);
    assert.equal(descriptor.args.includes("--session-id"), false);
  }
});

test("只迁移旧版重新生成留下的同 binding 待分支，不改动显式网页分支", () => {
  const base = {
    schemaVersion: 1,
    agentBindingId: "binding-current",
    adapterId: "qoder-cn",
    state: { adapterId: "qoder-cn", sessionId: "mistaken-target", turnId: null, status: "idle" },
    native: {
      runtimeBindingId: "binding-current",
      sessionId: "mistaken-target",
      pendingFork: {
        sourceSessionId: "original-session",
        targetSessionId: "mistaken-target",
        resumeSessionAt: "retained-boundary",
      },
    },
  };
  const migrated = migrateLegacyRegenerationFork(base);
  assert.equal(migrated.binding.native.sessionId, "original-session");
  assert.equal(migrated.binding.native.pendingFork, null);
  assert.deepEqual(migrated.binding.native.pendingRewind, {
    sessionId: "original-session",
    resumeSessionAt: "retained-boundary",
  });
  assert.equal(migrated.receiptSourceSessionId, "mistaken-target");
  assert.equal(migrated.receiptTargetSessionId, "original-session");

  assert.equal(migrateLegacyRegenerationFork({
    ...base,
    agentBindingId: "binding-branch",
    native: { ...base.native, runtimeBindingId: "binding-source" },
  }), null);
});

test("四个 Agent 的新 EasyWork Task 都在已有原生会话中启动下一轮", () => {
  const openCode = createOpenCodeAdapter().operation("start", { sessionId: "session-existing", prompt: "next task" });
  const codex = createCodexAdapter().operation("start", { threadId: "thread-existing", prompt: "next task", cwd: "/work/next" });
  const claude = createClaudeCodeAdapter().operation("start", { sessionId: "session-existing", prompt: "next task" });
  const qoder = createQoderCnAdapter().operation("start", { sessionId: "session-existing", prompt: "next task" });

  assert.equal(openCode.request.path, "/api/session/session-existing/prompt");
  assert.equal(openCode.transaction, undefined);
  assert.deepEqual(codex.calls.map((call) => call.method), ["turn/start"]);
  assert.equal(codex.calls[0].params.threadId, "thread-existing");
  assert.equal(codex.calls[0].params.cwd, "/work/next");
  assert.deepEqual(claude.args.slice(-2), ["--resume", "session-existing"]);
  assert.deepEqual(qoder.args.slice(-2), ["--resume", "session-existing"]);
});

test("OpenCode 当前 SSE 协议保留 step、文本、工具、权限与 Todo 顺序", () => {
  const adapter = createOpenCodeAdapter();
  const frames = [
    { type: "session.next.step.started", data: { sessionID: "s1", agent: "build", model: { id: "model-a" } } },
    { type: "session.next.reasoning.started", data: { sessionID: "s1", reasoningID: "r1" } },
    { type: "session.next.reasoning.delta", data: { sessionID: "s1", reasoningID: "r1", delta: "inspect" } },
    { type: "session.next.reasoning.ended", data: { sessionID: "s1", reasoningID: "r1", text: "inspect" } },
    { type: "todo.updated", data: { sessionID: "s1", todos: [{ id: "todo-1", content: "Read tree", status: "in_progress", priority: "high" }] } },
    { type: "session.next.tool.called", data: { sessionID: "s1", callID: "tool-1", tool: "Edit", input: { file_path: "/work/a.js", password: "must-not-appear" } } },
    { type: "permission.v2.asked", data: { id: "allow-1", sessionID: "s1", action: "edit", resources: ["/work/*"], save: ["edit"], metadata: {}, source: { callID: "tool-1" } } },
    { type: "permission.v2.replied", data: { sessionID: "s1", requestID: "allow-1", reply: "once" } },
    { type: "session.next.tool.success", data: { sessionID: "s1", callID: "tool-1", result: "edited", outputPaths: ["/work/a.js"] } },
    { type: "session.next.text.started", data: { sessionID: "s1", textID: "p2" } },
    { type: "session.next.text.delta", data: { sessionID: "s1", textID: "p2", delta: "done" } },
    { type: "session.next.text.ended", data: { sessionID: "s1", textID: "p2", text: "done" } },
    { type: "session.next.step.ended", data: { sessionID: "s1", assistantMessageID: "m1", finish: "stop", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } } },
  ];
  const result = consume(adapter, frames);
  assertCanonical(adapter, result.events);
  assert.equal(result.state.sessionId, "s1");
  assert.equal(result.state.turnId, "m1");
  assert.equal(result.state.finalSeen, true);
  assert.equal(result.state.finalText, "done");
  assert.equal(result.events.some((event) => event.kind === "error"), false);
  for (const kind of ["reasoning", "plan", "tool_call", "approval_request", "approval_response", "tool_result", "file_change", "artifact", "message", "usage", "status", "final"]) {
    assert.equal(result.events.some((event) => event.kind === kind), true, `missing OpenCode ${kind}`);
  }
  assert.equal(JSON.stringify(result.events).includes("must-not-appear"), false);
  assert.equal(result.events.find((event) => event.kind === "usage").payload.total, 17);
});

test("OpenCode V1 完成态工具快照只落一次且忽略服务器心跳", () => {
  const adapter = createOpenCodeAdapter();
  const completedPart = {
    id: "part-edit-1",
    callID: "call-edit-1",
    type: "tool",
    tool: "edit",
    sessionID: "session-v1",
    state: {
      status: "completed",
      input: { file_path: "/work/README.md", old_string: "old", new_string: "new" },
      output: "Edit applied successfully.",
    },
  };
  const result = consume(adapter, [
    {
      type: "message.part.updated",
      data: { part: completedPart },
      easywork: { eventEnvelope: "properties", eventSource: "v1-event-stream" },
    },
    {
      type: "message.part.updated",
      data: { part: structuredClone(completedPart) },
      easywork: { eventEnvelope: "properties", eventSource: "v1-history" },
    },
    {
      type: "server.heartbeat",
      data: { timestamp: 123 },
      easywork: { eventEnvelope: "properties", eventSource: "v1-event-stream", agentVersion: "1.18.23" },
    },
  ]);

  assertCanonical(adapter, result.events);
  assert.equal(result.events.filter((event) => event.kind === "tool_result").length, 1);
  assert.equal(result.events.filter((event) => event.kind === "file_change").length, 1);
  assert.equal(result.events.some((event) => event.kind === "job_status"), false);
  assert.equal(result.events.some((event) => event.payload?.eventType === "server.heartbeat"), false);
});

test("OpenCode V1 同一权限的兼容更新与正式询问只生成一个待审批项", () => {
  const adapter = createOpenCodeAdapter();
  const properties = {
    id: "permission-v1-duplicate",
    sessionID: "session-v1",
    permission: "bash",
    patterns: ["python --version"],
    metadata: {},
    always: ["python --version"],
    tool: { callID: "call-v1" },
  };
  const result = consume(adapter, [
    { type: "permission.updated", data: properties, easywork: { eventEnvelope: "properties", eventSource: "v1-event-stream" } },
    { type: "permission.asked", data: structuredClone(properties), easywork: { eventEnvelope: "properties", eventSource: "v1-event-stream" } },
  ]);

  assertCanonical(adapter, result.events);
  assert.equal(result.events.filter((event) => event.kind === "approval_request").length, 1);
  assert.deepEqual(Object.keys(result.state.pendingApprovals), ["permission-v1-duplicate"]);
});

test("Codex app-server JSON-RPC fixtures 归一化 turn、item、delta、approval 与 token usage", () => {
  const adapter = createCodexAdapter();
  const frames = [
    { method: "thread/started", params: { thread: { id: "thread-1" } } },
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "reason-1", type: "reasoning", summary: "Inspecting" } } },
    { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: " tree" } },
    { method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [{ step: "Read", status: "inProgress" }] } },
    { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "pwd", status: "inProgress" } } },
    { method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "/work\n" } },
    { id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "pwd", reason: "sandbox" } },
    { id: 77, result: { decision: "accept" } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "/work\n", exitCode: 0 } } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "edit-1", type: "fileChange", changes: [{ path: "/work/a.js", kind: "update", diff: "+ok" }] } } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "img-1", type: "imageGeneration", savedPath: "/work/out.png" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "answer" } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "answer-1", type: "agentMessage", text: "answer" } } },
    { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { inputTokens: 300, outputTokens: 100, totalTokens: 400 }, last: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, modelContextWindow: 200000 } } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
  ];
  const result = consume(adapter, frames);
  assertCanonical(adapter, result.events);
  assert.equal(result.state.sessionId, "thread-1");
  assert.equal(result.state.turnId, "turn-1");
  assert.equal(result.state.finalSeen, true);
  for (const kind of ["reasoning", "plan", "tool_call", "tool_result", "approval_request", "approval_response", "file_change", "artifact", "message", "usage", "status", "final"]) {
    assert.equal(result.events.some((event) => event.kind === kind), true, `missing Codex ${kind}`);
  }
  const requestIndex = result.events.findIndex((event) => event.kind === "approval_request");
  const responseIndex = result.events.findIndex((event) => event.kind === "approval_response");
  assert.equal(responseIndex, requestIndex + 1);
  const usage = result.events.find((event) => event.kind === "usage");
  assert.equal(usage.payload.usage.total, 400, "累计用量仍用于 Task 报告");
  assert.equal(usage.payload.context.used, 40, "上下文占用必须采用 Codex 的 last 用量");
  assert.equal(result.state.contextUsage.used, 40);
  assert.equal(result.state.contextUsage.limit, 200000);
});

test("Codex 0.154 新增输出、写入审批、认证恢复与用户验证协议均可消费", () => {
  const adapter = createCodexAdapter();
  const result = consume(adapter, [
    {
      method: "item/completed",
      params: {
        threadId: "thread-154",
        turnId: "turn-154",
        item: {
          id: "function-output-1",
          type: "functionCallOutput",
          namespace: "weather",
          name: "lookup",
          output: [{ type: "input_text", text: "sunny" }],
        },
      },
    },
    {
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-154",
        turnId: "turn-154",
        itemId: "command-154",
        kind: "writeStdin",
        approvalId: "approval-154",
        command: "python interactive.py",
        cwd: "/work/next",
      },
    },
    { method: "modelProvider/authRecoveryStarted", params: { provider: "reta", message: "refreshing credentials" } },
    { method: "modelProvider/authRecoveryCompleted", params: { provider: "reta", message: "credentials refreshed" } },
    { method: "mcpServer/event/stream/notification", params: { serverName: "files", event: { type: "progress" } } },
    { method: "thread/realtime/item/started", params: { threadId: "thread-154", item: { id: "realtime-1" } } },
    {
      id: 92,
      method: "mcpServer/elicitation/request",
      params: {
        mode: "openai/userVerification",
        title: "Verify device",
        description: "Paste the verification proof",
        challenge: "challenge-154",
        serverName: "accounts",
      },
    },
  ]);

  assertCanonical(adapter, result.events);
  assert.equal(result.events.some((event) => event.kind === "error"), false);
  assert.equal(result.events.some((event) => event.payload?.eventType), false);
  const output = result.events.find((event) => event.kind === "tool_result");
  assert.equal(output.payload.name, "weather.lookup");
  assert.equal(output.payload.text, "sunny");
  const approval = result.events.find((event) => event.kind === "approval_request");
  assert.equal(approval.payload.action, "write_stdin");
  assert.equal(approval.payload.details.approvalId, "approval-154");
  assert.deepEqual(
    result.events.filter((event) => event.payload?.operation === "provider_auth_recovery").map((event) => event.phase),
    ["started", "completed"],
  );
  const request = result.events.find((event) => event.kind === "input_request");
  assert.equal(request.payload.input.mode, "openai/userVerification");
  assert.equal(request.payload.input.questions[0].id, "proof");
  assert.equal(request.payload.input.questions[0].isSecret, true);

  const response = adapter.operation("respondInput", {
    requestId: "92",
    answers: { proof: "proof-token" },
    pendingInput: result.state.pendingInputs["92"],
  });
  assert.deepEqual(response, {
    adapter: "codex",
    operation: "respondInput",
    transport: "json-rpc-response",
    requestId: 92,
    result: { action: "accept", content: { proof: "proof-token" }, _meta: null },
  });
});

test("EasyWork 执行前版本 Hook 只进入内部版本链路", () => {
  const codex = consume(createCodexAdapter(), [{
    method: "hook/completed",
    params: {
      run: {
        id: "pre-tool-use:0:/home/tester/.easywork/config.toml:tool-native-1",
        eventName: "pre_tool_use",
        status: "completed",
        statusMessage: "__easywork_internal_version_snapshot__",
      },
    },
  }]);
  assert.equal(codex.events.length, 1);
  assert.equal(codex.events[0].kind, "tool_call");
  assert.equal(codex.events[0].source.itemId, "tool-native-1");
  assert.equal(codex.events[0].payload.visibility, "internal");

  const claude = consume(createClaudeCodeAdapter(), [{
    type: "system",
    subtype: "hook_response",
    session_id: "session-native-1",
    hook_event: "PreToolUse",
    hook_name: "PreToolUse:.*",
    outcome: "success",
  }]);
  assert.equal(claude.events.length, 1);
  assert.equal(claude.events[0].kind, "job_status");
  assert.equal(claude.events[0].payload.visibility, "internal");
});

test("Claude Code stream-json fixtures 归一化 streaming、tool、plan、control、compact 与 result", () => {
  const adapter = createClaudeCodeAdapter();
  const frames = [
    { type: "system", subtype: "init", session_id: "session-1", model: "claude-test", tools: ["Bash", "Edit"], slash_commands: ["compact"] },
    { type: "stream_event", session_id: "session-1", uuid: "msg-1", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { type: "stream_event", session_id: "session-1", uuid: "msg-1", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect" } } },
    { type: "stream_event", session_id: "session-1", uuid: "msg-1", event: { type: "content_block_stop", index: 0 } },
    { type: "assistant", session_id: "session-1", uuid: "tool-message", message: { content: [{ type: "tool_use", id: "todo-1", name: "TodoWrite", input: { todos: [{ content: "Read files", status: "in_progress" }] } }, { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/work/a.js" } }] } },
    { type: "control_request", session_id: "session-1", request_id: "request-1", request: { subtype: "can_use_tool", tool_name: "Edit", tool_use_id: "edit-1", input: { file_path: "/work/a.js" } } },
    { type: "control_response", session_id: "session-1", response: { subtype: "success", request_id: "request-1", response: { behavior: "allow" } } },
    { type: "user", session_id: "session-1", message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: "updated" }] } },
    { type: "system", subtype: "compact_boundary", session_id: "session-1", compact_metadata: { pre_tokens: 1200 } },
    { type: "stream_event", session_id: "session-1", uuid: "msg-2", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", session_id: "session-1", uuid: "msg-2", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "finished" } } },
    { type: "stream_event", session_id: "session-1", uuid: "msg-2", event: { type: "message_delta", usage: { input_tokens: 12, cache_read_input_tokens: 100, output_tokens: 4 } } },
    { type: "assistant", session_id: "session-1", uuid: "msg-2", message: { content: [{ type: "text", text: "finished" }] } },
    { type: "result", subtype: "success", session_id: "session-1", result: "finished", usage: { input_tokens: 72, cache_read_input_tokens: 400, output_tokens: 20 }, modelUsage: { "claude-test": { inputTokens: 72, contextWindow: 200000 } }, structured_output: { file: "/work/a.js" } },
  ];
  const result = consume(adapter, frames);
  assertCanonical(adapter, result.events);
  assert.equal(result.state.sessionId, "session-1");
  assert.equal(result.state.turnId, "msg-2");
  assert.equal(result.state.finalText, "finished");
  assert.equal(result.state.finalSeen, true);
  for (const kind of ["reasoning", "plan", "tool_call", "tool_result", "approval_request", "approval_response", "file_change", "job_status", "message", "usage", "status", "final"]) {
    assert.equal(result.events.some((event) => event.kind === kind), true, `missing Claude Code ${kind}`);
  }
  assert.equal(result.events.find((event) => event.kind === "reasoning").payload.text, "Inspect");
  assert.equal(result.events.some((event) => event.kind === "artifact"), false, "structured_output 不是文件产物");
  assert.equal(result.state.contextUsage.used, 116, "当前窗口只能采用最后一次模型请求的 message_delta usage");
  assert.equal(result.state.contextUsage.limit, 200000);
  assert.equal(result.state.contextUsage.source, "claude-code-current-request");
  const completedUsage = result.events.findLast((event) => event.kind === "usage");
  assert.equal(completedUsage.payload.input, 72, "result 的累计用量仍供 Task 报告使用");
  assert.equal(completedUsage.payload.context.used, 116, "result 不得用累计用量覆盖当前窗口");
});

test("Qoder CN 原生 stream-json 保留思考、权限、正文、会话与当前上下文", () => {
  const adapter = createQoderCnAdapter();
  const frames = [
    { type: "system", subtype: "init", session_id: "q-session-1", model: "qoder-model", permissionMode: "acceptEdits" },
    { type: "stream_event", session_id: "q-session-1", event: { type: "message_start", message: { id: "q-message-1", usage: { input_tokens: 8 } } } },
    { type: "stream_event", session_id: "q-session-1", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { type: "stream_event", session_id: "q-session-1", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先查看文件" } } },
    { type: "control_request", session_id: "q-session-1", request_id: "q-permission-1", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "q-tool-1", input: { command: "pwd" }, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }] } },
    { type: "control_response", session_id: "q-session-1", response: { subtype: "success", request_id: "q-permission-1", response: { behavior: "allow" } } },
    { type: "stream_event", session_id: "q-session-1", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
    { type: "stream_event", session_id: "q-session-1", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "已完成" } } },
    { type: "stream_event", session_id: "q-session-1", event: { type: "message_delta", usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 } } },
    { type: "result", subtype: "success", session_id: "q-session-1", result: "已完成", usage: { input_tokens: 50, output_tokens: 12 }, modelUsage: { "qoder-model": { inputTokens: 50, contextWindow: 100000 } } },
  ];
  const result = consume(adapter, frames);
  assertCanonical(adapter, result.events);
  assert.equal(result.state.sessionId, "q-session-1");
  assert.equal(result.state.finalText, "已完成");
  assert.equal(result.state.finalSeen, true);
  for (const kind of ["reasoning", "approval_request", "approval_response", "message", "usage", "status", "final"]) {
    assert.equal(result.events.some((event) => event.kind === kind), true, `missing Qoder CN ${kind}`);
  }
  assert.equal(result.events.find((event) => event.kind === "reasoning").payload.text, "先查看文件");
  assert.equal(result.state.contextUsage.used, 12, "当前上下文只累计 prompt、cache-read 与 cache-write token");
  assert.equal(result.state.contextUsage.limit, 100000);
  assert.equal(result.state.contextUsage.source, "qoder-cn-current-request");
  const approval = result.events.find((event) => event.kind === "approval_request");
  const response = adapter.operation("respondApproval", {
    requestId: approval.payload.requestId,
    decision: "approve_session",
    pendingApproval: { suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }] }] },
  });
  assert.equal(response.frames[0].response.response.updatedPermissions[0].destination, "session");
});

test("Qoder CN 在 token 计数为零时用原生 context_usage_ratio 还原当前上下文", () => {
  const adapter = createQoderCnAdapter();
  const result = consume(adapter, [
    { type: "system", subtype: "init", session_id: "q-session-ratio", model: "qoder-model" },
    { type: "result", subtype: "success", session_id: "q-session-ratio", result: "完成", usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.375 }, modelUsage: { "qoder-model": { inputTokens: 0, contextWindow: 200000 } } },
  ]);
  assertCanonical(adapter, result.events);
  assert.deepEqual(result.state.contextUsage, {
    used: 75_000,
    limit: 200_000,
    remaining: 125_000,
    ratio: 0.375,
    source: "qoder-cn-current-request",
  });
  const completedUsage = result.events.findLast((event) => event.kind === "usage");
  assert.equal(completedUsage.payload.context.used, 75_000);
  assert.equal(completedUsage.payload.input, 0, "累计 result token 仍保留在任务用量中");
});

test("Qoder CN 最新 SDK 的队列、目标、产物和后台状态都有确定事件映射", () => {
  const result = consume(createQoderCnAdapter(), [
    { type: "system", subtype: "model_queue_status", status: "queued", request_id: "request-1", request_set_id: "set-1", model_key: "qwen", queue_count: 2, wait_time_ms: 1200, session_id: "q-session" },
    { type: "system", subtype: "model_queue_status", status: "ready", request_id: "request-1", request_set_id: "set-1", model_key: "qwen", session_id: "q-session" },
    { type: "command_lifecycle", command_uuid: "command-1", state: "queued", session_id: "q-session" },
    { type: "command_lifecycle", command_uuid: "command-1", state: "completed", session_id: "q-session" },
    { type: "system", subtype: "plan_mode_changed", plan_mode: { active: true }, session_id: "q-session" },
    { type: "system", subtype: "goal_updated", goal: { id: "goal-1", objective: "完成验收", status: "blocked", turns_used: 3, max_turns: 12, time_used_seconds: 45, credits_budget: 10, credits_used: 2 }, reason: "waiting-user", session_id: "q-session" },
    { type: "system", subtype: "artifacts_update", artifacts: [
      { kind: "changed", path: "/work/output.txt", display_path: "output.txt", name: "output.txt", additions: 4, deletions: 1, is_new: false },
      { kind: "presented", path: "/work/report.pdf", display_path: "report.pdf", name: "report.pdf" },
    ], session_id: "q-session" },
    { type: "system", subtype: "memory_generation", result: { status: "partial", attemptId: "memory-1", origin: "turn_complete", writtenFiles: [{ rootId: "root", path: "MEMORY.md" }], failedFiles: [], durationMs: 20 }, session_id: "q-session" },
    { type: "system", subtype: "memory_consumption", result: { status: "partial", files: [{ id: "memory", path: "MEMORY.md", status: "truncated" }] }, session_id: "q-session" },
    { type: "system", subtype: "skill_evolution", result: { status: "suggested", attemptId: "skill-1", origin: "turn_complete", suggestions: [{ skillName: "review", action: "update", summary: "补充验收", confidence: 0.9 }], durationMs: 30 }, session_id: "q-session" },
    { type: "system", subtype: "session_title_changed", title: "原生标题", source: "ai", revision: 2, session_id: "q-session" },
    { type: "system", subtype: "available_models_update", models: [{ value: "qwen" }], currentModel: "qwen", session_id: "q-session" },
    { type: "system", subtype: "commands_changed", commands: [{ name: "review" }], session_id: "q-session" },
    { type: "cloud_agent_event", event: "task.updated", id: "cloud-1", data: { status: "running", summary: "远端任务运行中" }, session_id: "q-session" },
    { type: "system", subtype: "goal_cleared", goal_id: "goal-1", reason: "done", session_id: "q-session" },
  ]);

  assertCanonical(createQoderCnAdapter(), result.events);
  assert.equal(result.events.some((event) => event.payload.operation === "unmapped_agent_event"), false);
  assert.equal(result.events.find((event) => event.payload.operation === "model_queue")?.phase, "waiting");
  assert.equal(result.events.find((event) => event.payload.operation === "command_lifecycle")?.phase, "waiting");
  assert.equal(result.events.find((event) => event.payload.operation === "goal" && event.payload.status === "blocked")?.phase, "waiting");
  assert.equal(result.events.find((event) => event.kind === "file_change")?.payload.visibility, "internal");
  assert.deepEqual(result.events.find((event) => event.kind === "artifact")?.payload, {
    source: "remote",
    path: "/work/report.pdf",
    name: "report.pdf",
    kind: "file",
  });
  for (const operation of ["plan_mode", "memory_generation", "memory_consumption", "skill_evolution", "session_title", "available_models", "available_commands", "cloud_agent"]) {
    assert.equal(result.events.some((event) => event.payload.operation === operation), true, `missing Qoder CN ${operation}`);
  }
});

test("Claude Code 原生 transcript 边界只更新会话状态且不产生前端事件", () => {
  const adapter = createClaudeCodeAdapter();
  const initial = adapter.createState({ sessionId: "session-1", turnId: "tool-use-message" });
  const advanced = adapter.reduce(initial, {
    type: "easywork_native_boundary",
    session_id: "session-1",
    turn_id: "final-transcript-message",
  });
  assert.equal(advanced.state.turnId, "final-transcript-message");
  assert.deepEqual(advanced.events, []);
  const cleared = adapter.reduce(advanced.state, {
    type: "easywork_native_boundary",
    session_id: "session-1",
    turn_id: null,
  });
  assert.equal(cleared.state.turnId, null);
  assert.deepEqual(cleared.events, []);
});

test("Qoder CN 只用验证后的 active-leaf 更新可恢复边界", () => {
  const adapter = createQoderCnAdapter();
  const initial = adapter.createState({ sessionId: "q-session", turnId: "verified-old-leaf" });
  const streamed = adapter.reduce(initial, {
    type: "assistant",
    session_id: "q-session",
    uuid: "sdk-event-not-in-transcript",
    message: { content: [{ type: "text", text: "完成" }] },
  });
  assert.equal(streamed.state.turnId, "verified-old-leaf");
  const verified = adapter.reduce(streamed.state, {
    type: "easywork_native_boundary",
    session_id: "q-session",
    turn_id: "verified-active-leaf",
  });
  assert.equal(verified.state.turnId, "verified-active-leaf");
});

test("Claude Code 长任务 heartbeat 归并到原工具且不会留下伪运行卡片", () => {
  const adapter = createClaudeCodeAdapter();
  const result = consume(adapter, [
    { type: "assistant", session_id: "session-1", message: { content: [{ type: "tool_use", id: "bash-long", name: "Bash", input: { command: "python2 -m unittest" } }] } },
    { type: "tool_progress", session_id: "session-1", tool_use_id: "bash-long-heartbeat-0", tool_name: "Bash", elapsed_time_seconds: 30, heartbeat: true },
    { type: "tool_progress", session_id: "session-1", tool_use_id: "bash-long-heartbeat-1", tool_name: "Bash", elapsed_time_seconds: 60, heartbeat: true },
    { type: "user", session_id: "session-1", message: { content: [{ type: "tool_result", tool_use_id: "bash-long", content: "done" }] } },
  ]);

  assert.equal(result.state.items["bash-long"].status, "completed");
  assert.equal(Object.keys(result.state.items).some((itemId) => itemId.includes("-heartbeat-")), false);
  const heartbeatEvents = result.events.filter((event) => event.kind === "tool_call" && event.payload.heartbeat === true);
  assert.deepEqual(heartbeatEvents.map((event) => event.payload.callId), ["bash-long", "bash-long"]);
  assert.deepEqual(heartbeatEvents.map((event) => event.payload.elapsedSeconds), [30, 60]);
});

test("Claude Code 排队轮次的 result 只结束原生本轮，最后一个 result 才完成 Task", () => {
  const adapter = createClaudeCodeAdapter();
  let state = adapter.createState();
  const first = adapter.reduce(state, {
    type: "result",
    subtype: "success",
    session_id: "session-queued",
    result: "first turn",
    queued_turn_count: 1,
    easywork: { terminalResult: false, queuedTurnCount: 1, queueSource: "native" },
  });
  state = first.state;
  assert.equal(first.events.some((event) => event.kind === "final"), false);
  assert.equal(first.events.some((event) => event.kind === "error"), false);
  assert.equal(first.events.find((event) => event.kind === "status")?.payload.queuedTurnCount, 1);
  assert.equal(state.status, "running");
  assert.equal(state.finalSeen, false);

  const second = adapter.reduce(state, {
    type: "result",
    subtype: "success",
    session_id: "session-queued",
    result: "second turn",
    queued_turn_count: 0,
    easywork: { terminalResult: true, queuedTurnCount: 0, queueSource: "native" },
  });
  assert.equal(second.events.filter((event) => event.kind === "final").length, 1);
  assert.equal(second.events.find((event) => event.kind === "final")?.payload.text, "second turn");
  assert.equal(second.state.status, "completed");
  assert.equal(second.state.finalSeen, true);
});

test("Claude Code 原生中断诊断在仍有排队追问时只是轮次边界", () => {
  const adapter = createClaudeCodeAdapter();
  const reduced = adapter.reduce(adapter.createState(), {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
    easywork: { terminalResult: false, queuedTurnCount: 1, queueSource: "scoped-interrupt" },
  });
  assert.equal(reduced.state.status, "running");
  assert.equal(reduced.events.some((event) => event.kind === "error"), false);
  assert.equal(reduced.events.find((event) => event.kind === "status")?.payload.queuedTurnCount, 1);
});

test("三种 Agent 的原生 Todo 协议都归一化为可清空的完整计划快照", () => {
  const claude = consume(createClaudeCodeAdapter(), [
    { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", id: "create-a", name: "TaskCreate", input: { subject: "创建目录" } }] } },
    { type: "user", session_id: "s1", tool_use_result: { task: { id: "1" } }, message: { content: [{ type: "tool_result", tool_use_id: "create-a", content: "Task #1 created successfully" }] } },
    { type: "assistant", session_id: "s1", message: { content: [{ type: "tool_use", id: "create-b", name: "TaskCreate", input: { subject: "安装依赖" } }] } },
    { type: "user", session_id: "s1", tool_use_result: { task: { id: "2" } }, message: { content: [{ type: "tool_result", tool_use_id: "create-b", content: "Task #2 created successfully" }] } },
    { type: "assistant", session_id: "s1", message: { content: [
      { type: "tool_use", id: "update-a", name: "TaskUpdate", input: { taskId: "1", status: "completed" } },
      { type: "tool_use", id: "update-b", name: "TaskUpdate", input: { taskId: "2", status: "in_progress", activeForm: "正在安装依赖" } },
    ] } },
  ]);
  assert.deepEqual(claude.state.plan, [
    { id: "1", text: "创建目录", status: "completed" },
    { id: "2", text: "正在安装依赖", status: "in_progress" },
  ]);
  assert.deepEqual(claude.events.filter((event) => event.kind === "plan").at(-1).payload.items, claude.state.plan);

  const codex = consume(createCodexAdapter(), [
    { method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: [
      { step: "读取源码", status: "completed" },
      { step: "修改实现", status: "inProgress" },
    ] } },
  ]);
  assert.deepEqual(codex.state.plan, [
    { id: "1", text: "读取源码", status: "completed" },
    { id: "2", text: "修改实现", status: "in_progress" },
  ]);

  const openCode = consume(createOpenCodeAdapter(), [
    { type: "todo.updated", data: { sessionID: "s1", todos: [{ id: "todo-1", content: "检查", status: "in_progress" }] } },
    { type: "todo.updated", data: { sessionID: "s1", todos: [] } },
  ]);
  assert.deepEqual(openCode.state.plan, []);
  assert.deepEqual(openCode.events.filter((event) => event.kind === "plan").at(-1).payload.items, []);
});

test("Claude Code 复用消息 id、空完整输入和原生 TaskList 时仍以原生任务库校准计划", () => {
  const adapter = createClaudeCodeAdapter();
  let state = adapter.createState({
    plan: [
      { id: "2", text: "旧的实现任务", status: "pending" },
      { id: "6", text: "旧的六号任务", status: "completed" },
    ],
  });
  const consumeOne = (frame) => {
    const reduced = adapter.reduce(state, frame);
    state = reduced.state;
    return reduced.events;
  };
  const createViaReusedStream = (toolId, task) => {
    consumeOne({
      type: "stream_event",
      session_id: "s-reused",
      uuid: "same-message",
      event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolId, name: "TaskCreate", input: {} } },
    });
    consumeOne({
      type: "stream_event",
      session_id: "s-reused",
      uuid: "same-message",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ subject: task.subject }) } },
    });
    consumeOne({
      type: "stream_event",
      session_id: "s-reused",
      uuid: "same-message",
      event: { type: "content_block_stop", index: 1 },
    });
    consumeOne({
      type: "user",
      session_id: "s-reused",
      tool_use_result: { task: { id: task.id, subject: task.subject } },
      message: { content: [{ type: "tool_result", tool_use_id: toolId, content: `Task #${task.id} created successfully: ${task.subject}` }] },
    });
  };

  createViaReusedStream("create-6", { id: "6", subject: "核对成功作业号" });
  assert.deepEqual(state.plan, [
    { id: "2", text: "旧的实现任务", status: "pending" },
    { id: "6", text: "核对成功作业号", status: "pending" },
  ], "原生复用 id 时新任务必须替换旧任务，不能产生重复 key");
  createViaReusedStream("create-7", { id: "7", subject: "核对两组 CSV" });
  createViaReusedStream("create-8", { id: "8", subject: "记录清理待办" });

  consumeOne({
    type: "user",
    session_id: "s-reused",
    tool_use_result: { success: true, taskId: "6", updatedFields: ["status"], statusChange: { from: "pending", to: "completed" } },
    message: { content: [{ type: "tool_result", tool_use_id: "unseen-update-6", content: "Updated task #6 status" }] },
  });
  consumeOne({
    type: "user",
    session_id: "s-reused",
    tool_use_result: { success: true, taskId: "7", updatedFields: ["status"], statusChange: { from: "pending", to: "completed" } },
    message: { content: [{ type: "tool_result", tool_use_id: "unseen-update-7", content: "Updated task #7 status" }] },
  });
  assert.equal(state.plan.find((item) => item.id === "6")?.status, "completed");
  assert.equal(state.plan.find((item) => item.id === "7")?.status, "completed");

  const taskListEvents = consumeOne({
    type: "user",
    session_id: "s-reused",
    tool_use_result: { tasks: [
      { id: "1", subject: "设计方案", status: "completed" },
      { id: "2", subject: "实现程序", status: "completed" },
      { id: "6", subject: "核对成功作业号", status: "completed" },
      { id: "7", subject: "核对两组 CSV", status: "completed" },
      { id: "8", subject: "记录清理待办", status: "pending" },
    ] },
    message: { content: [{ type: "tool_result", tool_use_id: "unseen-task-list", content: "#1 [completed] 设计方案" }] },
  });
  assert.deepEqual(state.plan, [
    { id: "1", text: "设计方案", status: "completed" },
    { id: "2", text: "实现程序", status: "completed" },
    { id: "6", text: "核对成功作业号", status: "completed" },
    { id: "7", text: "核对两组 CSV", status: "completed" },
    { id: "8", text: "记录清理待办", status: "pending" },
  ]);
  assert.equal(taskListEvents.some((event) => event.kind === "tool_result"), false, "TaskList 只进入原生计划面，不重复显示成普通工具事件");
  assert.deepEqual(taskListEvents.filter((event) => event.kind === "plan").at(-1).payload.items, state.plan);
});

test("文件编辑工具在没有原生 diff 时从 Write/Edit 输入生成可展示差异", () => {
  const claude = consume(createClaudeCodeAdapter(), [
    { type: "assistant", session_id: "s1", message: { content: [
      { type: "tool_use", id: "write-1", name: "Write", input: { file_path: "/work/new.txt", content: "hello\nworld\n" } },
      { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/work/a.txt", old_string: "old", new_string: "new" } },
    ] } },
    { type: "user", session_id: "s1", message: { content: [
      { type: "tool_result", tool_use_id: "write-1", content: "written" },
      { type: "tool_result", tool_use_id: "edit-1", content: "edited" },
    ] } },
  ]);
  const changes = claude.events.filter((event) => event.kind === "file_change");
  assert.match(changes[0].payload.diff, /--- a\/work\/new\.txt[\s\S]+\+hello[\s\S]+\+world/);
  assert.match(changes[1].payload.diff, /--- a\/work\/a\.txt[\s\S]+-old[\s\S]+\+new/);
});

test("Claude Code 缺少当前 run 的 message_delta 时不把累计 result usage 冒充上下文", () => {
  const adapter = createClaudeCodeAdapter();
  const seed = adapter.createState({
    contextUsage: { used: 42_000, limit: 200_000, source: "claude-code-current-request" },
  });
  let reduced = adapter.reduce(seed, { type: "system", subtype: "init", session_id: "session-2" });
  reduced = adapter.reduce(reduced.state, {
    type: "result",
    subtype: "success",
    session_id: "session-2",
    result: "done",
    usage: { input_tokens: 30_000, cache_read_input_tokens: 120_000, output_tokens: 2_000 },
  });
  assert.equal(reduced.state.contextUsage, null);
  assert.equal(Object.hasOwn(reduced.events.find((event) => event.kind === "usage").payload, "context"), false);
});

test("Claude Code partial-message wrapper UUID 变化时仍保留同一内容块 identity", () => {
  const adapter = createClaudeCodeAdapter();
  const result = consume(adapter, [
    { type: "stream_event", session_id: "session-1", uuid: "wrapper-start", event: { type: "message_start", message: { id: "message-1" } } },
    { type: "stream_event", session_id: "session-1", uuid: "wrapper-block", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", session_id: "session-1", uuid: "wrapper-delta-1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } } },
    { type: "stream_event", session_id: "session-1", uuid: "wrapper-delta-2", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } } },
  ]);
  const messages = result.events.filter((event) => event.kind === "message");
  assert.deepEqual(messages.map((event) => event.source.itemId), ["message-1:0", "message-1:0"]);
  assert.equal(result.state.items["message-1:0"].text, "你好");
});

test("Claude Code 单块 assistant 完成帧复用原流式块身份而不重复正文或覆盖思考", () => {
  const stream = (event) => ({ type: "stream_event", session_id: "session-1", event });
  const complete = (uuid, type, value) => ({ type: "assistant", session_id: "session-1", uuid, message: { id: "multi-block", content: [{ type, [type === "thinking" ? "thinking" : "text"]: value }] } });
  const result = consume(createClaudeCodeAdapter(), [
    stream({ type: "message_start", message: { id: "multi-block" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect files" } }),
    complete("thinking-block", "thinking", "Inspect files"),
    stream({ type: "content_block_stop", index: 0 }),
    stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "First" } }),
    complete("text-block-one", "text", "First"),
    stream({ type: "content_block_stop", index: 1 }),
    stream({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Second" } }),
    stream({ type: "content_block_stop", index: 3 }),
    stream({ type: "message_stop" }),
    complete("text-block-two", "text", "Second"),
    complete("text-block-two", "text", "Second"),
  ]);
  assert.equal(result.state.finalText, "FirstSecond");
  assert.equal(result.state.items["multi-block:0"].partType, "thinking");
  assert.equal(result.state.items["multi-block:1"].text, "First");
  assert.equal(result.state.items["multi-block:3"].text, "Second");
  assert.deepEqual([...new Set(result.events.filter((event) => event.kind === "message").map((event) => event.source.itemId))], ["multi-block:1", "multi-block:3"]);
});

test("Claude Code 将模型混入 result 的 think 标签拆为 reasoning 和最终正文", () => {
  const adapter = createClaudeCodeAdapter();
  const result = consume(adapter, [
    { type: "assistant", session_id: "session-1", uuid: "msg-1", message: { content: [{ type: "text", text: "先分析用户要求。</think>CLAUDE_OK" }] } },
    { type: "result", subtype: "success", session_id: "session-1", result: "先分析用户要求。</think>CLAUDE_OK" },
  ]);
  assert.equal(result.state.finalText, "CLAUDE_OK");
  assert.equal(result.events.find((event) => event.kind === "reasoning")?.payload.text, "先分析用户要求。");
  assert.equal(result.events.find((event) => event.kind === "final")?.payload.text, "CLAUDE_OK");
});

test("Artifact 事件只登记可验证的真实产物并明确来源", () => {
  const openCode = consume(createOpenCodeAdapter(), [
    { type: "session.next.tool.called", data: { sessionID: "s1", callID: "remote-file", tool: "write", input: { path: "/work/report.txt" } } },
    { type: "session.next.tool.success", data: { sessionID: "s1", callID: "remote-file", result: "done", outputPaths: ["/work/report.txt"] } },
    { type: "session.next.tool.success", data: { sessionID: "s1", callID: "web-link", result: "done", outputPaths: ["https://example.invalid/link.txt"] } },
  ]);
  const codex = consume(createCodexAdapter(), [
    { method: "item/completed", params: { threadId: "t1", turnId: "v1", item: { id: "view", type: "imageView", path: "/work/input.png" } } },
    { method: "item/completed", params: { threadId: "t1", turnId: "v1", item: { id: "generated", type: "imageGeneration", savedPath: "/work/output.png" } } },
  ]);

  const artifacts = [...openCode.events, ...codex.events].filter((event) => event.kind === "artifact");
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map((event) => event.payload), [
    { source: "remote", path: "/work/report.txt", name: "report.txt", kind: "file" },
    { source: "remote", path: "/work/output.png", kind: "image", name: "/work/output.png" },
  ]);
  for (const event of artifacts) {
    assert.equal(["host", "remote"].includes(event.payload.source), true);
    assert.equal("url" in event.payload, false);
    assert.equal("value" in event.payload, false);
  }
});

test("Agent 最终回复中的远程文件链接转换为下载产物且不泄露 file URI", () => {
  const result = consume(createCodexAdapter(), [
    { method: "turn/started", params: { threadId: "thread-download", turn: { id: "turn-download" } } },
    { method: "item/completed", params: { threadId: "thread-download", turnId: "turn-download", item: {
      id: "answer-download",
      type: "agentMessage",
      text: "文件已生成：[音频包.zip](file:///work/output/audio%20bundle.zip)",
    } } },
    { method: "turn/completed", params: { threadId: "thread-download", turn: { id: "turn-download", status: "completed" } } },
  ]);
  const artifact = result.events.find((event) => event.kind === "artifact");
  assert.deepEqual(artifact?.payload, {
    source: "remote",
    path: "/work/output/audio bundle.zip",
    name: "audio bundle.zip",
    kind: "file",
  });
  const final = result.events.findLast((event) => event.kind === "final");
  assert.equal(final.payload.text, "文件已生成。");
  assert.equal(final.payload.text.includes("file:///"), false);
});

test("Agent 最终回复保留 Markdown 段落与列表边界", () => {
  const text = [
    "你好！我是 Codex。",
    "",
    "**我能做什么**",
    "",
    "- 读写代码",
    "- 运行测试",
    "",
    "**我的风格**",
    "",
    "- 先验证再回答",
    "",
    "随时告诉我下一步。",
  ].join("\n");
  const result = consume(createCodexAdapter(), [
    { method: "turn/started", params: { threadId: "thread-markdown", turn: { id: "turn-markdown" } } },
    { method: "item/completed", params: { threadId: "thread-markdown", turnId: "turn-markdown", item: {
      id: "answer-markdown",
      type: "agentMessage",
      text,
    } } },
    { method: "turn/completed", params: { threadId: "thread-markdown", turn: { id: "turn-markdown", status: "completed" } } },
  ]);
  assert.equal(result.events.findLast((event) => event.kind === "final").payload.text, text);
});

test("Agent 的文件链接列表只生成下载产物，不在正文重复文件名占位行", () => {
  const result = consume(createCodexAdapter(), [
    { method: "turn/started", params: { threadId: "thread-download-list", turn: { id: "turn-download-list" } } },
    { method: "item/completed", params: { threadId: "thread-download-list", turnId: "turn-download-list", item: {
      id: "answer-download-list",
      type: "agentMessage",
      text: "文件已确认存在，下载链接如下：\n\n- [下载 sample.txt](file:///work/output/sample.txt)\n- [README](file:///work/output/README)",
    } } },
    { method: "turn/completed", params: { threadId: "thread-download-list", turn: { id: "turn-download-list", status: "completed" } } },
  ]);
  assert.deepEqual(result.events.filter((event) => event.kind === "artifact").map((event) => event.payload.name), ["sample.txt", "README"]);
  assert.equal(result.events.findLast((event) => event.kind === "final").payload.text, "文件已确认存在，下载链接如下：");
});

test("Agent 加粗的下载链接转为卡片后不会遗留空强调符号", () => {
  const result = consume(createCodexAdapter(), [
    { method: "turn/started", params: { threadId: "thread-download-bold", turn: { id: "turn-download-bold" } } },
    { method: "item/completed", params: { threadId: "thread-download-bold", turnId: "turn-download-bold", item: {
      id: "answer-download-bold",
      type: "agentMessage",
      text: "**下载文件卡片**\n\n- 下载：**[sample.txt](file:///work/output/sample.txt)**",
    } } },
    { method: "turn/completed", params: { threadId: "thread-download-bold", turn: { id: "turn-download-bold", status: "completed" } } },
  ]);
  assert.equal(result.events.findLast((event) => event.kind === "final").payload.text, "**下载文件卡片**");
  assert.deepEqual(result.events.filter((event) => event.kind === "artifact").map((event) => event.payload.name), ["sample.txt"]);
});

test("三种当前失败帧统一为 canonical error", () => {
  const cases = [
    [createOpenCodeAdapter(), { type: "session.next.step.failed", data: { sessionID: "s", error: { message: "failed" } } }],
    [createCodexAdapter(), { method: "error", params: { error: { message: "failed" }, willRetry: false, threadId: "t", turnId: "v" } }],
    [createClaudeCodeAdapter(), { type: "result", subtype: "error", session_id: "s", is_error: true, result: "failed" }],
  ];
  for (const [adapter, frame] of cases) {
    const { events } = consume(adapter, [frame]);
    assertCanonical(adapter, events);
    assert.equal(events.some((event) => event.kind === "error"), true);
    assert.equal(events.some((event) => ["agent_reply", "terminal", "thinking", "agent_text"].includes(event.kind)), false);
  }
});

test("Claude Code 失败帧优先保留 errors 中的原始原因", () => {
  const { events } = consume(createClaudeCodeAdapter(), [{
    type: "result",
    subtype: "error",
    session_id: "session-failed",
    is_error: true,
    result: "Claude Code failed",
    errors: ["No conversation found with session ID session-source"],
  }]);
  const failure = events.find((event) => event.kind === "error");
  assert.match(failure.payload.message, /No conversation found with session ID session-source/);
  assert.match(failure.payload.message, /Claude Code failed/);
});

test("Codex 重连通知保持任务运行，等待 turn 最终状态", () => {
  const { events, state } = consume(createCodexAdapter(), [
    { method: "turn/started", params: { turn: { id: "turn-retry" } } },
    { method: "error", params: { error: { message: "Reconnecting... 2/5" }, willRetry: true, threadId: "thread-1", turnId: "turn-retry" } },
    { method: "error", params: { error: { message: "temporary transport failure" }, willRetry: true, threadId: "thread-1", turnId: "turn-retry" } },
    { method: "turn/completed", params: { turn: { id: "turn-retry", status: "completed" } } },
  ]);

  assert.equal(events.some((event) => event.kind === "error"), false);
  assert.equal(events.filter((event) => event.payload?.status === "reconnecting").length, 2);
  assert.equal(events.at(-1)?.kind, "final");
  assert.equal(state.status, "completed");
});
