import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext, createApi, WorkDraftService } from "../gateway/core/index.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easywork-work-draft-"));
  const dataRoot = path.join(root, "data");
  try { return await run(dataRoot); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function actor(actorType, actorId, deviceId) {
  return createActorContext({ actorType, actorId, deviceId, sessionId: `session-${deviceId}`, roles: [] });
}

test("Work 草稿按用户持久化并可由同一账号的另一设备恢复", async () => fixture(async (dataRoot) => {
  const laptop = new WorkDraftService({ dataRoot, actor: actor("user", "user-a", "laptop") });
  const phone = new WorkDraftService({ dataRoot, actor: actor("user", "user-a", "phone") });
  const saved = await laptop.replace({
    selection: { serverId: "cluster-a", agentId: "codex", workspaceId: "__virtual__", workspacePath: "由 EasyWork 自动分配" },
    expectedRevision: 0,
    commandId: "draft-save-1",
  });
  assert.equal(saved.revision, 1);
  assert.deepEqual((await phone.get()).selection, saved.selection);
  const disk = JSON.parse(await readFile(path.join(dataRoot, "users", "user-a", "preferences", "work-draft.json"), "utf8"));
  assert.equal(disk.data.selection.serverId, "cluster-a");
  assert.equal(disk.data.selection.agentId, "codex");
}));

test("访客 Work 草稿彼此隔离，且不写入用户目录", async () => fixture(async (dataRoot) => {
  const first = new WorkDraftService({ dataRoot, actor: actor("guest", "guest-a", "browser-a") });
  const second = new WorkDraftService({ dataRoot, actor: actor("guest", "guest-b", "browser-b") });
  await first.replace({ selection: { serverId: "cluster-a", agentId: null, workspaceId: null, workspacePath: null }, expectedRevision: 0, commandId: "guest-draft" });
  assert.equal((await second.get()).selection.serverId, null);
  assert.equal((await first.get()).selection.serverId, "cluster-a");
}));

test("Work 草稿要求完整依赖、revision 和幂等 commandId", async () => fixture(async (dataRoot) => {
  const drafts = new WorkDraftService({ dataRoot, actor: actor("user", "user-a", "laptop") });
  await assert.rejects(() => drafts.replace({
    selection: { serverId: null, agentId: "codex", workspaceId: null, workspacePath: null }, expectedRevision: 0, commandId: "invalid-dependency",
  }), (error) => error?.code === "WORK_DRAFT_DEPENDENCY_INVALID");
  const input = { selection: { serverId: "cluster-a", agentId: null, workspaceId: null, workspacePath: null }, expectedRevision: 0, commandId: "same-command" };
  const first = await drafts.replace(input);
  const replay = await drafts.replace(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision);
  await assert.rejects(() => drafts.replace({ ...input, selection: { serverId: "cluster-b", agentId: null, workspaceId: null, workspacePath: null } }), (error) => error?.code === "IDEMPOTENCY_KEY_REUSED");
  await assert.rejects(() => drafts.clear({ expectedRevision: 0, commandId: "clear-stale" }), (error) => error?.code === "REVISION_CONFLICT");
  const cleared = await drafts.clear({ expectedRevision: 1, commandId: "clear-current" });
  assert.equal(cleared.selection.serverId, null);
}));

test("Work 草稿 HTTP 合同要求 Bearer、If-Match 与 Idempotency-Key，并保持 Actor 隔离", async () => fixture(async (dataRoot) => {
  const actors = {
    laptop: actor("user", "user-a", "laptop"),
    phone: actor("user", "user-a", "phone"),
    other: actor("user", "user-b", "other"),
  };
  const auth = {
    async resolveSession(token) {
      const selected = actors[token];
      if (!selected) throw Object.assign(new Error("invalid"), { code: "SESSION_INVALID", status: 401 });
      return { actor: selected, profile: { userId: selected.actorId, username: selected.actorId }, firstVisit: false };
    },
  };
  const api = createApi({
    auth,
    servicesForActor: async (current) => ({ workDrafts: new WorkDraftService({ dataRoot, actor: current }) }),
  });
  const unauthorized = await api.dispatch({ method: "GET", url: "/api/drafts/work" });
  assert.equal(unauthorized.status, 401);
  const missingRevision = await api.dispatch({
    method: "PATCH", url: "/api/drafts/work", headers: { authorization: "Bearer laptop", "idempotency-key": "draft-http-1" },
    body: { selection: { serverId: "cluster-a", agentId: null, workspaceId: null, workspacePath: null } },
  });
  assert.equal(missingRevision.status, 428);
  const missingCommand = await api.dispatch({
    method: "PATCH", url: "/api/drafts/work", headers: { authorization: "Bearer laptop", "if-match": "\"0\"" },
    body: { selection: { serverId: "cluster-a", agentId: null, workspaceId: null, workspacePath: null } },
  });
  assert.equal(missingCommand.status, 428);
  const legacyShape = await api.dispatch({
    method: "PATCH", url: "/api/drafts/work",
    headers: { authorization: "Bearer laptop", "if-match": "\"0\"", "idempotency-key": "draft-legacy" },
    body: { selection: { serverId: "cluster-a", agentId: null, workspaceId: null, workspacePath: null }, localStorageKey: "legacy" },
  });
  assert.equal(legacyShape.status, 400);
  const saved = await api.dispatch({
    method: "PATCH", url: "/api/drafts/work",
    headers: { authorization: "Bearer laptop", "if-match": "\"0\"", "idempotency-key": "draft-http-1" },
    body: { selection: { serverId: "cluster-a", agentId: null, workspaceId: null, workspacePath: null } },
  });
  assert.equal(saved.status, 200);
  const phone = await api.dispatch({ method: "GET", url: "/api/drafts/work", headers: { authorization: "Bearer phone" } });
  const other = await api.dispatch({ method: "GET", url: "/api/drafts/work", headers: { authorization: "Bearer other" } });
  assert.equal(phone.body.data.selection.serverId, "cluster-a");
  assert.equal(other.body.data.selection.serverId, null);
}));
