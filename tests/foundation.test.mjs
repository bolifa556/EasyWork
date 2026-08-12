import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { createOpaqueCursorCodec } from "../gateway/core/cursor.mjs";
import { ApiError, apiFailure, apiSuccess } from "../gateway/core/errors.mjs";
import { ActorMutationQueue } from "../gateway/core/mutation-queue.mjs";
import { actorDataRoot, actorPathLayout, resolveActorPath } from "../gateway/core/paths.mjs";
import { AtomicJsonRepository, replaceFileWithRetry } from "../gateway/core/repository.mjs";
import { assertExpectedRevision } from "../gateway/core/revision.mjs";

function userActor(id = "user-1") {
  return createActorContext({
    actorType: "user",
    actorId: id,
    deviceId: "device-1",
    sessionId: "session-1",
    roles: ["user"],
  });
}

async function withDataRoot(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-foundation-"));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("API 响应统一且不会泄漏密钥字段", () => {
  const success = apiSuccess({ id: "x", apiKey: "plain-secret", nested: { password: "pw" }, output: "received sk-1234567890abcdef" }, { requestId: "req-1" });
  assert.deepEqual(success, {
    status: 200,
    body: {
      data: { id: "x", apiKey: "[REDACTED]", nested: { password: "[REDACTED]" }, output: "received [REDACTED API KEY]" },
      meta: { requestId: "req-1" },
    },
  });

  const failure = apiFailure(new ApiError("BAD_INPUT", "参数错误", {
    status: 400,
    details: { privateKey: "secret", field: "host" },
  }));
  assert.equal(failure.status, 400);
  assert.equal(failure.body.error.code, "BAD_INPUT");
  assert.equal(failure.body.error.retryable, false);
  assert.equal(failure.body.error.details.privateKey, "[REDACTED]");

  const internal = apiFailure(new Error("contains sensitive implementation details"));
  assert.equal(internal.status, 500);
  assert.equal(internal.body.error.message, "服务器处理请求时发生错误");
  assert.equal(JSON.stringify(internal).includes("sensitive implementation"), false);
});

test("opaque cursor 加密、绑定命名空间、校验篡改和过期", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const codec = createOpaqueCursorCodec({ secret, namespace: "resources", defaultTtlMs: 1_000 });
  const token = codec.encode({ offset: 42 }, { now: 10_000 });
  assert.equal(token.includes("offset"), false);
  assert.deepEqual(codec.decode(token, { now: 10_500 }), { offset: 42 });

  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.throws(() => codec.decode(tampered, { now: 10_500 }), (error) => error.code === "CURSOR_INVALID");
  assert.throws(() => codec.decode(token, { now: 11_001 }), (error) => error.code === "CURSOR_EXPIRED");

  const other = createOpaqueCursorCodec({ secret, namespace: "tasks" });
  assert.throws(() => other.decode(token, { now: 10_500 }), (error) => error.code === "CURSOR_INVALID");
});

test("revision 强制 expectedRevision 并返回稳定冲突详情", () => {
  assert.throws(() => assertExpectedRevision(2), (error) => error.code === "EXPECTED_REVISION_REQUIRED" && error.status === 428);
  assert.throws(() => assertExpectedRevision(2, 1), (error) => {
    assert.equal(error.code, "REVISION_CONFLICT");
    assert.deepEqual(error.details, { expectedRevision: 1, actualRevision: 2 });
    return true;
  });
  assert.equal(assertExpectedRevision(2, 2), 2);
});

test("Actor 路径严格位于 data/users 或 data/guests 下并拒绝逃逸", async () => withDataRoot(async (dataRoot) => {
  const actor = userActor("alice");
  assert.equal(actorDataRoot(dataRoot, actor), path.join(dataRoot, "users", "alice"));
  assert.equal(resolveActorPath(dataRoot, actor, "tasks", "one.json"), path.join(dataRoot, "users", "alice", "tasks", "one.json"));
  const layout = actorPathLayout(dataRoot, actor);
  assert.equal(layout.projects, path.join(dataRoot, "users", "alice", "projects"));
  assert.ok(Object.values(layout).every((entry) => entry === layout.root || entry.startsWith(`${layout.root}${path.sep}`)));
  assert.throws(() => resolveActorPath(dataRoot, actor, "..", "bob", "state.json"), (error) => error.code === "ACTOR_PATH_ESCAPE");

  const guest = createActorContext({
    actorType: "guest",
    actorId: "guest-1",
    deviceId: "device-1",
    sessionId: "session-1",
    roles: [],
  });
  assert.equal(actorDataRoot(dataRoot, guest), path.join(dataRoot, "guests", "guest-1"));
}));

test("Actor mutation queue 同 Actor 串行、不同 Actor 可独立推进", async () => {
  const queue = new ActorMutationQueue();
  const actorA = userActor("actor-a");
  const actorB = userActor("actor-b");
  const order = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });

  const first = queue.run(actorA, async () => {
    order.push("a1-start");
    await gateA;
    order.push("a1-end");
  });
  const second = queue.run(actorA, async () => order.push("a2"));
  const other = queue.run(actorB, async () => order.push("b1"));
  await other;
  assert.deepEqual(order, ["a1-start", "b1"]);
  releaseA();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1-start", "b1", "a1-end", "a2"]);
  assert.equal(queue.pendingActors, 0);
});

test("Actor mutation queue 允许同一异步事务重入且不会放行外部并发写", async () => {
  const queue = new ActorMutationQueue();
  const actor = userActor("actor-reentrant");
  const order = [];
  const first = queue.run(actor, async () => {
    order.push("outer-start");
    await queue.run(actor, async () => order.push("inner"));
    await new Promise((resolve) => setImmediate(resolve));
    order.push("outer-end");
  });
  const second = queue.run(actor, async () => order.push("external"));
  await Promise.all([first, second]);
  assert.deepEqual(order, ["outer-start", "inner", "outer-end", "external"]);
  assert.equal(queue.pendingActors, 0);
});

test("AtomicJsonRepository 原子写、校验 revision 并隔离用户", async () => withDataRoot(async (dataRoot) => {
  const actor = userActor("alice");
  const repository = new AtomicJsonRepository({
    dataRoot,
    actor,
    relativePath: ["state", "counter.json"],
    schemaVersion: 1,
    defaultData: () => ({ count: 0 }),
    validate: (data) => Number.isSafeInteger(data?.count) && data.count >= 0,
  });

  const initial = await repository.read();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.data, { count: 0 });

  const first = await repository.update((draft) => {
    draft.count += 1;
  }, { expectedRevision: 0, clock: () => new Date("2026-01-01T00:00:00.000Z") });
  assert.equal(first.revision, 1);
  assert.equal(first.data.count, 1);

  await assert.rejects(repository.replace({ count: 9 }, { expectedRevision: 0 }), (error) => error.code === "REVISION_CONFLICT");
  const persisted = JSON.parse(await fs.readFile(path.join(dataRoot, "users", "alice", "state", "counter.json"), "utf8"));
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.data.count, 1);

  const bobRepository = new AtomicJsonRepository({
    dataRoot,
    actor: userActor("bob"),
    relativePath: ["state", "counter.json"],
    schemaVersion: 1,
    defaultData: () => ({ count: 0 }),
    validate: (data) => Number.isSafeInteger(data?.count),
  });
  assert.equal((await bobRepository.read()).data.count, 0);
}));

test("Windows 原子替换会重试瞬时 EPERM 且不吞掉永久错误", async () => {
  let attempts = 0;
  const delays = [];
  await replaceFileWithRetry("pending.tmp", "state.json", {
    fileSystem: {
      async rename() {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
      },
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 40]);

  let permanentAttempts = 0;
  await assert.rejects(() => replaceFileWithRetry("pending.tmp", "state.json", {
    fileSystem: {
      async rename() {
        permanentAttempts += 1;
        throw Object.assign(new Error("invalid target"), { code: "EINVAL" });
      },
    },
    sleep: async () => undefined,
  }), (error) => error.code === "EINVAL");
  assert.equal(permanentAttempts, 1);
});
