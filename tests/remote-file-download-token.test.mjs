import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { createEasyWorkRuntime } from "../gateway/core/runtime/index.mjs";

test("remote-file download links are short-lived, opaque, and restore only their authorized scope", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-download-ticket-"));
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  const runtime = await createEasyWorkRuntime({
    dataRoot: path.join(root, "data"),
    clock: () => new Date(now),
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const actor = createActorContext({
    actorType: "user",
    actorId: "alice",
    deviceId: "device-a",
    sessionId: "session-a",
    roles: ["member"],
  });

  const issued = runtime.issueRemoteFileDownload({
    actor,
    serverId: "server-a",
    workspaceId: "workspace-a",
    path: "outputs/model without suffix",
  });
  const parsed = new URL(issued.url, "http://easywork.local");
  const token = parsed.searchParams.get("downloadToken");
  assert.ok(token);
  assert.equal(issued.url.includes("model%20without%20suffix"), false);
  assert.equal(issued.url.includes("alice"), false);
  assert.equal(issued.expiresAt, "2026-08-26T00:02:00.000Z");

  const resolved = runtime.resolveRemoteFileDownloadToken(token);
  assert.deepEqual({
    actorId: resolved.actor.actorId,
    serverId: resolved.serverId,
    workspaceId: resolved.workspaceId,
    path: resolved.path,
  }, {
    actorId: "alice",
    serverId: "server-a",
    workspaceId: "workspace-a",
    path: "outputs/model without suffix",
  });

  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => runtime.resolveRemoteFileDownloadToken(tampered), (error) => error?.code === "CURSOR_INVALID");
  now += 120_001;
  assert.throws(() => runtime.resolveRemoteFileDownloadToken(token), (error) => error?.code === "CURSOR_EXPIRED");
});
