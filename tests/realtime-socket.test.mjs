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

test("summary subscriptions replay headings but preserve full live reasoning", async () => {
  const events = [{ eventId: "old", topic: "task:one", sequence: 1, producer: "agent:codex", kind: "reasoning", payload: { event: { text: "旧思考正文" } } }];
  const broker = new RealtimeBroker({ journal: {
    async append(topic, event) { const envelope = { ...event, topic, sequence: events.length + 1 }; events.push(envelope); return envelope; },
    async replay(topic, { afterSequence }) { return { events: events.filter((e) => e.topic === topic && e.sequence > afterSequence) }; },
  } });
  const server = new RealtimeSocketServer({ auth: { resolveSession: async () => ({ actor }) }, brokerForActor: async () => broker, authorizeTopic: async () => "task:one" });
  const socket = new FakeSocket();
  const cleanup = server.attach(socket);
  try {
    socket.message({ type: "authenticate", token: "token" });
    socket.message({ type: "subscribe", topics: ["task:one"], resume: {}, replayView: "summary" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.find((v) => v.type === "event").event.payload.event.text, "");
    await broker.append("task:one", { eventId: "new", producer: "agent:codex", kind: "reasoning", payload: { event: { text: "正在产生的思考" } } });
    assert.equal(socket.sent.filter((v) => v.type === "event").at(-1).event.payload.event.text, "正在产生的思考");
  } finally { cleanup(); }
});

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

test("realtime replays every page and buffers events arriving during replay without duplicates", async () => {
  const events = Array.from({ length: 501 }, (_, index) => ({ sequence: index + 1, kind: index === 500 ? "completed" : "progress", topic: "task:one" }));
  let replayCalls = 0;
  const broker = new RealtimeBroker({ journal: {
    async append(topic, event) { const envelope = { ...event, topic, sequence: events.length + 1 }; events.push(envelope); return envelope; },
    async replay(topic, { afterSequence }) {
      const lastSequence = events.at(-1).sequence;
      const selected = events.filter((event) => event.sequence > afterSequence).slice(0, 500);
      if (replayCalls++ === 0) await broker.append(topic, { kind: "arrived-during-replay" });
      return { events: selected, lastSequence, hasMore: selected.at(-1)?.sequence < lastSequence };
    },
  } });
  const server = new RealtimeSocketServer({ auth: { async resolveSession() { return { actor }; } }, brokerForActor: async () => broker, authorizeTopic: async () => true });
  const socket = new FakeSocket();
  const cleanup = server.attach(socket);
  socket.message({ type: "authenticate", token: "token" });
  socket.message({ type: "subscribe", topics: ["task:one"] });
  await new Promise((resolve) => setImmediate(resolve));
  const received = socket.sent.filter((entry) => entry.type === "event").map((entry) => entry.event.sequence);
  assert.deepEqual(received, Array.from({ length: 502 }, (_, index) => index + 1));
  await broker.append("task:one", { kind: "live" });
  assert.equal(socket.sent.at(-1).event.sequence, 503);
  cleanup();
});

test("revoked sessions cannot subscribe and revocation closes existing subscriptions", async () => {
  let revoked = false;
  let notifyRevoked;
  const broker = new RealtimeBroker({ journal: { async append(topic, event) { return { ...event, topic, sequence: 1 }; }, async replay() { return { events: [] }; } } });
  const auth = {
    async resolveSession() {
      if (revoked) throw Object.assign(new Error("revoked"), { code: "SESSION_REVOKED", status: 401 });
      return { actor };
    },
    onSessionRevoked(fn) { notifyRevoked = fn; return () => {}; },
  };
  const server = new RealtimeSocketServer({ auth, brokerForActor: async () => broker, authorizeTopic: async () => true });
  const socket = new FakeSocket();
  server.attach(socket);
  socket.message({ type: "authenticate", token: "token" });
  await new Promise((resolve) => setImmediate(resolve));
  revoked = true;
  socket.message({ type: "subscribe", topics: ["task:one"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.closed.reason, "SESSION_REVOKED");
  revoked = false;
  const active = new FakeSocket();
  server.attach(active);
  active.message({ type: "authenticate", token: "token" });
  active.message({ type: "subscribe", topics: ["task:one"] });
  await new Promise((resolve) => setImmediate(resolve));
  notifyRevoked({ actorId: actor.actorId, sessionId: actor.sessionId });
  await broker.append("task:one", { kind: "private" });
  assert.equal(active.closed.reason, "SESSION_REVOKED");
  assert.equal(active.sent.some((entry) => entry.type === "event"), false);
});
