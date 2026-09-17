import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { RealtimeEventJournal } from "../gateway/core/realtime.mjs";
import {
  computeServerIdentity,
  createAgentBindingKey,
  createLegacyAgentBindingKey,
  createEffectiveContextScope,
} from "../gateway/core/scope.mjs";

const actor = createActorContext({
  actorType: "user",
  actorId: "alice",
  deviceId: "device-a",
  sessionId: "session-a",
  roles: ["user"],
});

async function withDataRoot(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-realtime-"));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("serverIdentity 同时绑定规范化主机、端口和真实主机指纹", () => {
  const first = computeServerIdentity({
    host: "GPU.EXAMPLE.COM.",
    port: 22,
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
  });
  const same = computeServerIdentity({
    host: "gpu.example.com",
    port: 22,
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
  });
  const changedKey = computeServerIdentity({
    host: "gpu.example.com",
    port: 22,
    hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456780",
  });
  assert.equal(first.serverIdentity, same.serverIdentity);
  assert.notEqual(first.serverIdentity, changedKey.serverIdentity);
  assert.equal(first.host, "gpu.example.com");
});

test("EffectiveContextScope 由服务端身份构建并形成完整 Agent binding key", () => {
  const scope = createEffectiveContextScope({
    actor,
    projectId: "project-1",
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    taskId: "task-1",
    serverId: "server-renameable",
    server: {
      host: "107.ustc.edu.cn",
      port: 22,
      hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789",
    },
    versionDomainId: "version-1",
    branchId: "main",
    memoryMode: "project-only",
    memorySnapshotSequence: 9,
    memorySnapshotVersionIds: ["memory-v9"],
    resourceBindingSnapshotId: "resources-v4",
    selectedCollectionIds: ["collection-1"],
    selectedSkillVersions: [{ skillId: "slurm", version: "1.2.0" }],
    capabilities: ["resource.read", "task.run", "resource.read"],
    contextEpoch: 3,
  });

  assert.equal(scope.userId, "alice");
  assert.equal(scope.actorType, "user");
  assert.equal(scope.actorId, "alice");
  assert.match(scope.serverIdentity, /^ssh_/);
  assert.deepEqual(scope.capabilities, ["resource.read", "task.run"]);
  const key = createAgentBindingKey(scope, "codex");
  assert.match(key, /^abk_/);
  assert.equal(key, createAgentBindingKey({ ...scope, taskId: "task-2" }, "codex"));
  assert.notEqual(key, createAgentBindingKey({ ...scope, conversationId: "conversation-2" }, "codex"));
  assert.notEqual(key, createAgentBindingKey({ ...scope, branchId: "branch-2" }, "codex"));
  assert.equal(key, createAgentBindingKey({ ...scope, workspaceId: "workspace-2" }, "codex"));
  assert.notEqual(
    createLegacyAgentBindingKey(scope, "codex"),
    createLegacyAgentBindingKey({ ...scope, workspaceId: "workspace-2" }, "codex"),
  );
  assert.notEqual(key, createAgentBindingKey({ ...scope, serverIdentity: `ssh_${"z".repeat(43)}` }, "codex"));
  assert.notEqual(key, createAgentBindingKey({ ...scope, contextEpoch: 4 }, "codex"));
  assert.notEqual(key, createAgentBindingKey(scope, "claude-code"));
});

test("Guest Chat 可以建立 Scope，但不伪造登录 userId", () => {
  const guestActor = createActorContext({
    actorType: "guest",
    actorId: "guest-01",
    deviceId: "device-guest",
    sessionId: "session-guest",
    roles: [],
  });
  const guestScope = createEffectiveContextScope({
    actor: guestActor,
    conversationId: "conversation-guest",
    memoryMode: "project-only",
  });
  assert.equal(guestScope.actorType, "guest");
  assert.equal(guestScope.actorId, "guest-01");
  assert.equal(guestScope.userId, null);
  assert.equal(guestScope.serverIdentity, null);
});

test("Realtime journal 为每个 topic 分配单调序号并支持 replay", async () => withDataRoot(async (dataRoot) => {
  const journal = new RealtimeEventJournal({ dataRoot, actor, maxEventsPerTopic: 10 });
  const one = await journal.append("conversation:one", {
    producer: "orchestrator",
    kind: "status",
    status: "running",
    ids: { conversationId: "one" },
    payload: { phase: "preparing" },
  });
  const two = await journal.append("conversation:one", {
    producer: "remote-agent",
    kind: "message",
    ids: { conversationId: "one" },
    payload: { text: "hello" },
  });
  await journal.append("conversation:two", {
    producer: "orchestrator",
    kind: "status",
    ids: { conversationId: "two" },
    payload: {},
  });

  assert.equal(one.sequence, 1);
  assert.equal(two.sequence, 2);
  assert.deepEqual(Object.keys(one), [
    "schemaVersion",
    "eventId",
    "topic",
    "sequence",
    "occurredAt",
    "actorType",
    "actorId",
    "producer",
    "kind",
    "status",
    "ids",
    "payload",
  ]);
  assert.match(one.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal("timestamp" in one, false);
  assert.equal("seq" in one, false);
  assert.equal("type" in one, false);
  assert.deepEqual(one.ids, { conversationId: "one" });
  const replay = await journal.replay("conversation:one", { afterSequence: 0, limit: 1 });
  assert.deepEqual(replay.events.map((event) => event.sequence), [1]);
  assert.equal(replay.hasMore, true);
  const remaining = await journal.replay("conversation:one", { afterSequence: replay.nextAfterSequence });
  assert.deepEqual(remaining.events.map((event) => event.sequence), [2]);

  const otherTopic = await journal.replay("conversation:two");
  assert.deepEqual(otherTopic.events.map((event) => event.sequence), [1]);
  assert.equal(otherTopic.events[0].actorId, "alice");

  await assert.rejects(journal.append("conversation:one", {
    kind: "status",
    conversationId: "legacy",
    payload: {},
  }), (error) => error.code === "REALTIME_RESERVED_FIELD_FORBIDDEN");
}));

test("Realtime retention 从零游标返回保留窗口，并拒绝非零过期游标", async () => withDataRoot(async (dataRoot) => {
  const journal = new RealtimeEventJournal({ dataRoot, actor, maxEventsPerTopic: 2 });
  for (let index = 0; index < 4; index += 1) {
    await journal.append("task:one", { kind: "status", payload: { index } });
  }
  const initial = await journal.replay("task:one", { afterSequence: 0 });
  assert.deepEqual(initial.events.map((event) => event.sequence), [3, 4]);
  await assert.rejects(journal.replay("task:one", { afterSequence: 1 }), (error) => {
    assert.equal(error.code, "REALTIME_REPLAY_EXPIRED");
    assert.equal(error.details.firstAvailableSequence, 3);
    return true;
  });
  const replay = await journal.replay("task:one", { afterSequence: 2 });
  assert.deepEqual(replay.events.map((event) => event.sequence), [3, 4]);
}));

test("Realtime journal 合并同一 Agent token 流并保持可续传游标", async () => withDataRoot(async (dataRoot) => {
  const journal = new RealtimeEventJournal({ dataRoot, actor, maxEventsPerTopic: 100 });
  const base = {
    producer: "agent:codex",
    kind: "message",
    status: "updated",
    ids: { taskId: "task-stream" },
  };
  const first = await journal.append("task:stream", {
    ...base,
    payload: { source: { itemId: "message-1" }, event: { text: "你", delta: true } },
  });
  const second = await journal.append("task:stream", {
    ...base,
    payload: { source: { itemId: "message-1" }, event: { text: "好", delta: true } },
  });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.notEqual(second.eventId, first.eventId);
  assert.equal(second.payload.event.text, "你好");
  assert.ok(second.payload.realtimeStreamKey);
  assert.equal(second.payload.realtimeStreamKey, first.payload.realtimeStreamKey);

  const retained = await journal.replay("task:stream", { afterSequence: 0 });
  assert.equal(retained.events.length, 1);
  assert.equal(retained.events[0].sequence, 2);
  assert.equal(retained.events[0].payload.event.text, "你好");
  const resumed = await journal.replay("task:stream", { afterSequence: 1 });
  assert.deepEqual(resumed.events.map((event) => event.sequence), [2]);
}));

test("网页思考在正文事件之后继续时获得独立段标识，回放不丢失前一段", async () => withDataRoot(async (dataRoot) => {
  const journal = new RealtimeEventJournal({ dataRoot, actor });
  const append = (kind, content) => journal.append("conversation:thought", {
    producer: "web-agent", kind, ids: { runId: "thought-one", conversationId: "thought" }, payload: { iteration: 0, content },
  });
  const first = await append("run.reasoning.delta", "需要简短回答。");
  await append("run.output.delta", "你好。");
  const tail = await append("run.reasoning.delta", "\n");
  assert.notEqual(first.payload.realtimeStreamKey, tail.payload.realtimeStreamKey);
  assert.deepEqual((await journal.replay("conversation:thought")).events.map((event) => event.payload.content), ["需要简短回答。", "你好。", "\n"]);
}));

test("Realtime journal 并发 append 仍产生连续且不重复的 topic sequence", async () => withDataRoot(async (dataRoot) => {
  const journal = new RealtimeEventJournal({ dataRoot, actor, maxEventsPerTopic: 100 });
  const appended = await Promise.all(Array.from({ length: 20 }, (_, index) => journal.append("task:parallel", {
    kind: "status",
    payload: { index },
  })));
  assert.deepEqual(
    appended.map((event) => event.sequence).sort((left, right) => left - right),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  const replay = await journal.replay("task:parallel");
  assert.deepEqual(replay.events.map((event) => event.sequence), Array.from({ length: 20 }, (_, index) => index + 1));
}));

test("Realtime event 拒绝写入敏感字段", async () => withDataRoot(async (dataRoot) => {
  const journal = new RealtimeEventJournal({ dataRoot, actor });
  await assert.rejects(journal.append("task:secret", {
    kind: "status",
    payload: { apiKey: "must-not-leak" },
  }), (error) => error.code === "SENSITIVE_FIELD_FORBIDDEN");
  await assert.rejects(journal.append("task:secret", {
    kind: "message",
    payload: { text: "agent echoed sk-1234567890abcdef" },
  }), (error) => error.code === "SENSITIVE_VALUE_FORBIDDEN");
}));
