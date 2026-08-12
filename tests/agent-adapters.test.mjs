import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_EVENT_KINDS,
  AGENT_OPERATIONS,
  createAgentAdapters,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createOpenCodeAdapter,
} from "../gateway/core/agents/index.mjs";

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

test("三 Agent adapter 声明同一 clean-break contract 与显式 capability", () => {
  const adapters = createAgentAdapters();
  assert.deepEqual(Object.keys(adapters), ["opencode", "codex", "claude-code"]);
  assert.deepEqual(AGENT_EVENT_KINDS, [
    "message", "reasoning", "plan", "tool_call", "tool_result", "approval_request", "approval_response",
    "file_change", "job_status", "artifact", "usage", "status", "error", "final",
  ]);
  for (const adapter of Object.values(adapters)) {
    assert.deepEqual(Object.keys(adapter.capabilities), AGENT_OPERATIONS);
    for (const operation of AGENT_OPERATIONS) {
      assert.match(adapter.capabilities[operation].availability, /^(?:available|unavailable)$/);
      assert.equal(typeof adapter.capabilities[operation].mode, "string");
    }
  }
  assert.equal(adapters["claude-code"].capabilities.interrupt.mode, "process-signal");
  assert.equal(adapters.opencode.capabilities.contextUsage.mode, "derived");
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
    codex.operation("resume", { threadId: "t-1", prompt: "resume" }),
    codex.operation("compact", { threadId: "t-1" }),
    codex.operation("contextUsage", { threadId: "t-1" }),
    claude.operation("start", { prompt: "inspect files", cwd: "/work" }),
    claude.operation("append", { prompt: "continue" }),
    claude.operation("interrupt", { processId: "pid-1" }),
    claude.operation("resume", { sessionId: "s-1", prompt: "continue" }),
    claude.operation("compact", { sessionId: "s-1" }),
    claude.operation("contextUsage", { sessionId: "s-1" }),
  ];
  const json = JSON.stringify(descriptors);
  assert.equal(/apiKey|password|privateKey|authorization/i.test(json), false);
  assert.equal(descriptors[0].transaction[1].path, "/session/$session.id/prompt_async");
  assert.equal(descriptors[7].calls[0].method, "turn/steer");
  assert.equal(descriptors[12].executable, "claude");
  assert.deepEqual(descriptors[14], {
    adapter: "claude-code",
    operation: "interrupt",
    transport: "process-signal",
    signal: "SIGINT",
    processId: "pid-1",
  });
});

test("OpenCode SSE fixtures 保留顺序并归一化 part、permission、todo 与 session", () => {
  const adapter = createOpenCodeAdapter();
  const frames = [
    { type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant" } } },
    { type: "message.part.updated", properties: { part: { id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning", text: "inspect" } } },
    { type: "todo.updated", properties: { sessionID: "s1", todos: [{ id: "todo-1", content: "Read tree", status: "in_progress", priority: "high" }] } },
    { type: "message.part.updated", properties: { part: { id: "tool-1", sessionID: "s1", messageID: "m1", type: "tool", tool: "Edit", state: { status: "running", input: { file_path: "/work/a.js", password: "must-not-appear" } } } } },
    { type: "permission.asked", properties: { id: "allow-1", sessionID: "s1", type: "edit", pattern: ["/work/*"], title: "Edit a.js", metadata: {} } },
    { type: "permission.replied", properties: { sessionID: "s1", permissionID: "allow-1", response: "once" } },
    { type: "message.part.updated", properties: { part: { id: "tool-1", sessionID: "s1", messageID: "m1", type: "tool", tool: "Edit", state: { status: "completed", input: { file_path: "/work/a.js" }, output: "edited" } } } },
    { type: "message.part.updated", properties: { part: { id: "file-1", sessionID: "s1", messageID: "m1", type: "file", filename: "report.txt", mime: "text/plain", url: "file:///work/report.txt" } } },
    { type: "message.part.updated", properties: { part: { id: "step-1", sessionID: "s1", messageID: "m1", type: "step-finish", tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } } } },
    JSON.stringify({ type: "message.part.updated", properties: { part: { id: "p2", sessionID: "s1", messageID: "m1", type: "text", text: "done" } } }),
    { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
    { type: "session.idle", properties: { sessionID: "s1" } },
  ];
  const result = consume(adapter, frames);
  assertCanonical(adapter, result.events);
  assert.equal(result.state.sessionId, "s1");
  assert.equal(result.state.finalSeen, true);
  assert.equal(result.state.finalText, "done");
  assert.deepEqual(result.events.map((event) => event.kind), [
    "reasoning", "plan", "tool_call", "approval_request", "approval_response", "tool_result", "file_change",
    "artifact", "usage", "message", "status", "status", "final",
  ]);
  assert.equal(JSON.stringify(result.events).includes("must-not-appear"), false);
  assert.equal(result.events.find((event) => event.kind === "usage").payload.total, 17);
});

test("Codex app-server JSON-RPC fixtures 归一化 turn、item、delta、approval 与 token usage", () => {
  const adapter = createCodexAdapter();
  const frames = [
    { method: "thread/started", params: { thread: { id: "thread-1" } } },
    { method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } },
    { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "reason-1", type: "reasoning", summary: "Inspecting" } } },
    { method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: " tree" } },
    { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "plan-1", type: "plan", steps: [{ id: "1", text: "Read", status: "in_progress" }] } } },
    { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "pwd", status: "inProgress" } } },
    { method: "item/commandExecution/outputDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "/work\n" } },
    { id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "pwd", reason: "sandbox" } },
    { id: 77, result: { decision: "accept" } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "/work\n", exitCode: 0 } } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "edit-1", type: "fileChange", changes: [{ path: "/work/a.js", kind: "update", diff: "+ok" }] } } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "img-1", type: "imageGeneration", path: "/work/out.png" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: "answer" } },
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "answer-1", type: "agentMessage", text: "answer" } } },
    { method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, modelContextWindow: 200000 } } },
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
  assert.equal(result.state.contextUsage.limit, 200000);
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
    { type: "stream_event", session_id: "session-1", uuid: "msg-2", event: { type: "message_delta", usage: { input_tokens: 12, output_tokens: 4 } } },
    { type: "assistant", session_id: "session-1", uuid: "msg-2", message: { content: [{ type: "text", text: "finished" }] } },
    { type: "result", subtype: "success", session_id: "session-1", result: "finished", usage: { input_tokens: 12, output_tokens: 4 }, structured_output: { file: "/work/a.js" } },
  ];
  const result = consume(adapter, frames);
  assertCanonical(adapter, result.events);
  assert.equal(result.state.sessionId, "session-1");
  assert.equal(result.state.finalText, "finished");
  assert.equal(result.state.finalSeen, true);
  for (const kind of ["reasoning", "plan", "tool_call", "tool_result", "approval_request", "approval_response", "file_change", "job_status", "message", "usage", "status", "final"]) {
    assert.equal(result.events.some((event) => event.kind === kind), true, `missing Claude Code ${kind}`);
  }
  assert.equal(result.events.find((event) => event.kind === "reasoning").payload.text, "Inspect");
  assert.equal(result.events.some((event) => event.kind === "artifact"), false, "structured_output 不是文件产物");
});

test("Artifact 事件只登记可验证的真实产物并明确来源", () => {
  const openCode = consume(createOpenCodeAdapter(), [
    { type: "message.part.updated", properties: { part: { id: "remote-file", sessionID: "s1", type: "file", filename: "report.txt", url: "file:///work/report.txt" } } },
    { type: "message.part.updated", properties: { part: { id: "web-link", sessionID: "s1", type: "file", filename: "link.txt", url: "https://example.invalid/link.txt" } } },
    { type: "message.part.updated", properties: { part: { id: "snapshot", sessionID: "s1", type: "snapshot", snapshot: "internal-state" } } },
  ]);
  const codex = consume(createCodexAdapter(), [
    { method: "item/completed", params: { threadId: "t1", turnId: "v1", item: { id: "view", type: "imageView", path: "/work/input.png" } } },
    { method: "item/completed", params: { threadId: "t1", turnId: "v1", item: { id: "generated", type: "imageGeneration", path: "/work/output.png" } } },
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

test("失败帧统一为 error，旧事件名不会泄漏进 canonical kind", () => {
  const cases = [
    [createOpenCodeAdapter(), { type: "session.error", properties: { sessionID: "s", error: { message: "failed" } } }],
    [createCodexAdapter(), { method: "error", params: { message: "failed" } }],
    [createClaudeCodeAdapter(), { type: "result", subtype: "error", session_id: "s", is_error: true, result: "failed" }],
  ];
  for (const [adapter, frame] of cases) {
    const { events } = consume(adapter, [frame]);
    assertCanonical(adapter, events);
    assert.equal(events.some((event) => event.kind === "error"), true);
    assert.equal(events.some((event) => ["agent_reply", "terminal", "thinking", "agent_text"].includes(event.kind)), false);
  }
});

test("Codex 重连通知保持任务运行，等待 turn 最终状态", () => {
  const { events, state } = consume(createCodexAdapter(), [
    { method: "turn/started", params: { turn: { id: "turn-retry" } } },
    { method: "error", params: { message: "Reconnecting... 2/5" } },
    { method: "error", params: { error: { message: "temporary transport failure", willRetry: true } } },
    { method: "turn/completed", params: { turn: { id: "turn-retry", status: "completed" } } },
  ]);

  assert.equal(events.some((event) => event.kind === "error"), false);
  assert.equal(events.filter((event) => event.payload?.status === "reconnecting").length, 2);
  assert.equal(events.at(-1)?.kind, "final");
  assert.equal(state.status, "completed");
});
