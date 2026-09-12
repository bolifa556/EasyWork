import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";

async function json(baseUrl, pathname, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test("catalog HTTP deletion performs the canonical project cascade", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-catalog-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  const gateway = await createGatewayServer({
    runtimeOptions: {
      dataRoot: path.join(root, "data"),
      helpFile,
    },
  });
  t.after(() => gateway.close().catch(() => undefined));
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const registered = await json(baseUrl, "/api/auth/register", { method: "POST", body: { username: "catalog-api", password: "catalog-password", deviceId: "catalog-device" } });
  const token = registered.payload.data.token;

  const project = await json(baseUrl, "/api/projects", { token, method: "POST", body: { name: "Project" } });
  const projectId = project.payload.data.id;
  const conversation = await json(baseUrl, "/api/conversations", {
    token, method: "POST", headers: { "idempotency-key": "catalog-api-conversation" },
    body: { mode: "chat", projectId, content: "hello", expectedRevision: 0 },
  });
  const conversationId = conversation.payload.data.conversation.id;
  const deleted = await json(baseUrl, `/api/projects/${projectId}`, {
    token, method: "DELETE", headers: { "if-match": '"0"', "idempotency-key": "catalog-api-delete-project" },
  });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.payload.data.movedConversationIds, [conversationId]);
  assert.equal((await json(baseUrl, `/api/conversations/${conversationId}`, { token })).payload.data.summary.projectId, null);
  assert.equal((await json(baseUrl, `/api/projects/${projectId}`, { token })).response.status, 404);
  const replay = await json(baseUrl, `/api/projects/${projectId}`, {
    token, method: "DELETE", headers: { "if-match": '"0"', "idempotency-key": "catalog-api-delete-project" },
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.payload.data, deleted.payload.data);

  const cascadeProject = await json(baseUrl, "/api/projects", { token, method: "POST", body: { name: "Delete conversations" } });
  const cascadeConversation = await json(baseUrl, "/api/conversations", {
    token, method: "POST", headers: { "idempotency-key": "catalog-api-cascade-conversation" },
    body: { mode: "chat", projectId: cascadeProject.payload.data.id, content: "delete me", expectedRevision: 0 },
  });
  const cascadeConversationId = cascadeConversation.payload.data.conversation.id;
  const cascadeDeleted = await json(baseUrl, `/api/projects/${cascadeProject.payload.data.id}?conversationPolicy=delete`, {
    token, method: "DELETE", headers: { "if-match": '"0"', "idempotency-key": "catalog-api-delete-project-and-conversations" },
  });
  assert.equal(cascadeDeleted.response.status, 200);
  assert.equal(cascadeDeleted.payload.data.conversationPolicy, "delete");
  assert.deepEqual(cascadeDeleted.payload.data.deletedConversationIds, [cascadeConversationId]);
  assert.equal((await json(baseUrl, `/api/conversations/${cascadeConversationId}`, { token })).response.status, 404);

});
