import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { RealtimeBroker, RealtimeSocketServer } from "../gateway/core/index.mjs";

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.bufferedAmount = 0; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closed = { code, reason }; this.emit("close"); }
  ping() {}
  message(value) { this.emit("message", JSON.stringify(value)); }
}

const actor = { actorType: "user", actorId: "user_a", deviceId: "device_a", sessionId: "session_a", roles: [] };

test("Realtime socket authenticates once, replays authorized topics and streams live events", async () => {
  const events = [];
  const journal = {
    async append(topic, event) { const envelope = { ...event, topic, sequence: events.length + 1 }; events.push(envelope); return envelope; },
    async replay(topic, { afterSequence }) { return { events: events.filter((event) => event.topic === topic && event.sequence > afterSequence) }; },
  };
  const broker = new RealtimeBroker({ journal });
  await broker.append("task:one", { kind: "run.started" });
  const server = new RealtimeSocketServer({
    auth: { async resolveSession(token) { assert.equal(token, "token"); return { actor, profile: { username: "alice" } }; } },
    brokerForActor: async () => broker,
    authorizeTopic: async ({ topic }) => assert.equal(topic, "task:one"),
    heartbeatIntervalMs: 60_000,
  });
  const socket = new FakeSocket();
  const cleanup = server.attach(socket);
  socket.message({ type: "authenticate", token: "token", requestId: "auth" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({ type: "subscribe", topics: ["task:one"], resume: { "task:one": 0 }, requestId: "sub" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.some((entry) => entry.type === "event" && entry.event.kind === "run.started"), true);
  await broker.append("task:one", { kind: "run.completed" });
  assert.equal(socket.sent.some((entry) => entry.type === "event" && entry.event.kind === "run.completed"), true);
  cleanup();
});

test("Realtime socket maps an authorized logical Task topic to its private broker topic", async () => {
  const events = [];
  const journal = {
    async append(topic, event) { const envelope = { ...event, eventId: `${topic}:${events.length + 1}`, topic, sequence: events.length + 1 }; events.push(envelope); return envelope; },
    async replay(topic, { afterSequence }) { return { events: events.filter((event) => event.topic === topic && event.sequence > afterSequence) }; },
  };
  const broker = new RealtimeBroker({ journal });
  await broker.append("task:private-digest", { kind: "tool_call" });
  const server = new RealtimeSocketServer({
    auth: { async resolveSession() { return { actor, profile: { username: "alice" } }; } },
    brokerForActor: async () => broker,
    authorizeTopic: async ({ topic }) => {
      assert.equal(topic, "task:task_public");
      return "task:private-digest";
    },
    heartbeatIntervalMs: 60_000,
  });
  const socket = new FakeSocket();
  const cleanup = server.attach(socket);
  socket.message({ type: "authenticate", token: "token", requestId: "auth" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.message({ type: "subscribe", topics: ["task:task_public"], resume: { "task:task_public": 0 }, requestId: "sub" });
  await new Promise((resolve) => setImmediate(resolve));
  const replayed = socket.sent.find((entry) => entry.type === "event" && entry.event.kind === "tool_call");
  assert.equal(replayed.event.topic, "task:task_public");
  await broker.append("task:private-digest", { kind: "tool_result" });
  const streamed = socket.sent.find((entry) => entry.type === "event" && entry.event.kind === "tool_result");
  assert.equal(streamed.event.topic, "task:task_public");
  cleanup();
});

test("Realtime socket rejects subscribing before authentication", async () => {
  const server = new RealtimeSocketServer({
    auth: { async resolveSession() { return { actor }; } },
    brokerForActor: async () => null,
    authorizeTopic: async () => true,
    heartbeatIntervalMs: 60_000,
  });
  const socket = new FakeSocket();
  server.attach(socket);
  socket.message({ type: "subscribe", topics: ["task:one"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.closed.code, 1008);
});
