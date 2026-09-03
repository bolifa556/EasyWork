import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTask } from "../gateway/core/entities/task.mjs";
import { createGatewayServer } from "../gateway/core/server.mjs";

async function json(baseUrl, pathname, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await response.json() };
}

test("catalog HTTP deletion performs the canonical cascade and Artifact save-as-resource is a real route", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-catalog-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  const gateway = await createGatewayServer({ runtimeOptions: { dataRoot: path.join(root, "data"), helpFile } });
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

  const liveProject = await json(baseUrl, "/api/projects", { token, method: "POST", body: { name: "Artifact target" } });
  const session = await gateway.runtime.auth.resolveSession(token);
  const services = await gateway.runtime.servicesForActor(session.actor);
  const task = createTask({
    id: "task_artifact_api", actorId: session.actor.actorId, conversationId, branchId: "branch_api", sourceMessageId: "message_artifact_api", conversationRunId: "conversation_run_artifact_api", goal: "artifact",
    route: { serverId: "server_api", serverIdentity: `ssh_${"a".repeat(43)}`, workspaceId: "workspace_api", agentId: "codex", providerId: "provider_agent", modelId: "model_agent" },
    contextSessionId: "context_api", agentBindingId: "binding_api", skillPins: [], resourceBindingSnapshotId: "resource_snapshot_api",
    versionCheckpointId: null, budgets: { maxWallTimeMs: 60_000, maxInputTokens: 10_000, maxOutputTokens: 4_000, maxToolCalls: 10 }, idempotencyKey: "create_task_artifact_api",
  });
  await services.taskStore.createTask(task);
  const captured = await services.artifacts.capture({ task, event: {
    kind: "artifact", phase: "completed", sequence: 1,
    payload: { source: "host", content: "promote through API", name: "result.txt", kind: "report", mime: "text/plain" },
  } });
  const listedArtifacts = await json(baseUrl, `/api/artifacts?conversationId=${encodeURIComponent(conversationId)}&limit=100`, { token });
  assert.equal(listedArtifacts.response.status, 200);
  assert.equal(listedArtifacts.payload.data.items.length, 1);
  assert.equal(listedArtifacts.payload.data.items[0].id, captured.artifact.id);
  const artifactRoute = await json(baseUrl, `/api/artifacts/${captured.artifact.id}/save-as-resource`, {
    token, method: "POST", headers: { "if-match": '"0"', "idempotency-key": "catalog-api-promote" }, body: { projectId: liveProject.payload.data.id },
  });
  assert.equal(artifactRoute.response.status, 200);
  assert.equal(artifactRoute.payload.data.artifact.projectId, liveProject.payload.data.id);
  const projectResources = await json(baseUrl, `/api/resources?ownerType=project&ownerId=${liveProject.payload.data.id}`, { token });
  assert.equal(projectResources.payload.data.items.length, 1);
  const removedTarget = await json(baseUrl, `/api/projects/${liveProject.payload.data.id}`, {
    token, method: "DELETE", headers: { "if-match": '"0"', "idempotency-key": "catalog-api-delete-artifact-target" },
  });
  assert.equal(removedTarget.response.status, 200);
  assert.deepEqual(removedTarget.payload.data.detachedArtifactIds, [captured.artifact.id]);
  assert.equal((await json(baseUrl, `/api/artifacts/${captured.artifact.id}`, { token })).payload.data.projectId, null);
  assert.equal((await json(baseUrl, `/api/resources?ownerType=project&ownerId=${liveProject.payload.data.id}`, { token })).payload.data.items.length, 0);
});
