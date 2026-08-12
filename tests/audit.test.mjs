import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AuditService, createActorContext } from "../gateway/core/index.mjs";

test("audit log is append-only inside the Actor directory and redacts sensitive metadata", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-audit-"));
  try {
    const actor = createActorContext({ actorType: "user", actorId: "user_a", deviceId: "device_a", sessionId: "session_a", roles: [] });
    const audit = new AuditService({ dataRoot, actor, cursorSecret: "audit-secret-that-is-at-least-thirty-two-bytes", clock: () => new Date("2026-08-10T01:02:03.000Z") });
    await audit.append({ action: "ssh.connect", target: { serverId: "server_a" }, metadata: { apiKey: "secret", result: "ok" } });
    await audit.append({ action: "task.append", target: { taskId: "task_a" } });
    const stored = await readFile(path.join(dataRoot, "users", "user_a", "audit", "2026-08.jsonl"), "utf8");
    assert.equal(stored.includes("secret"), false);
    const firstPage = await audit.list({ month: "2026-08", limit: 1 });
    assert.equal(firstPage.items[0].action, "task.append");
    assert.ok(firstPage.nextCursor);
    const secondPage = await audit.list({ month: "2026-08", cursor: firstPage.nextCursor, limit: 1 });
    assert.equal(secondPage.items[0].action, "ssh.connect");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
