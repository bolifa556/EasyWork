import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentAdapters } from "../gateway/core/agents/index.mjs";
import { RoutingAgentTransport, SshVersionControlFacade } from "../gateway/core/runtime/remote.mjs";
import { createEasyWorkRuntime } from "../gateway/core/runtime/runtime.mjs";

test("RoutingAgentTransport selects the remote Agent transport from the Task server route", async () => {
  const seen = [];
  const routing = new RoutingAgentTransport(async (serverId) => ({
    async execute(request) {
      seen.push({ serverId, request });
      return { serverId, ok: true };
    },
  }));
  const request = { task: { route: { serverId: "server_b" } }, operation: "start" };
  assert.deepEqual(await routing.execute(request), { serverId: "server_b", ok: true });
  assert.equal(seen[0].request, request);
  await assert.rejects(() => routing.execute({ task: { route: {} } }), (error) => error?.code === "AGENT_ROUTE_SERVER_REQUIRED");
});

test("RoutingAgentTransport resolves the persisted Work provider/model only in memory", async () => {
  const seen = [];
  const resolved = [];
  const routing = new RoutingAgentTransport(
    async () => ({ async execute(request) { seen.push(request); return { runId: "run-a", bindingPatch: {} }; } }),
    async (input) => {
      resolved.push(input);
      return { providerId: input.providerId, model: input.modelId, baseUrl: "https://agent.example/v1", apiKey: "memory-route-key", protocol: "auto" };
    },
  );
  const result = await routing.execute({ task: { route: { serverId: "server-a", providerId: "provider-agent", modelId: "model-agent" } }, operation: "start" });
  assert.equal(resolved[0].providerId, "provider-agent");
  assert.equal(resolved[0].modelId, "model-agent");
  assert.equal(seen[0].apiRoute.apiKey, "memory-route-key");
  assert.equal(JSON.stringify(result).includes("memory-route-key"), false);
});

test("version facade exposes only shadow state and forwards rewind without touching workspace git", async () => {
  const workspace = {
    id: "workspace_a",
    actorId: "alice",
    serverIdentity: "ssh_identity_a",
    canonicalPath: "/home/alice/project",
    kind: "user",
    versionDomainId: "vd_a",
    remoteRef: { private: "must-not-leak" },
  };
  const rewindCalls = [];
  const versioning = {
    async getDomain() {
      return {
        versionDomainId: "vd_a",
        revision: 4,
        workspace: { rootPath: workspace.canonicalPath },
        storage: { workTree: "/home/alice/.easywork/versioning/worktree", repositoryGit: "/home/alice/.easywork/versioning/repository.git" },
        branches: { branch_a: { id: "branch_a", conversationId: "conversation_a", fromCheckpointId: null, headCheckpointId: "checkpoint_a", createdAt: "2026-01-01T00:00:00.000Z" } },
        checkpoints: [{ id: "checkpoint_a", sequence: 1, conversationId: "conversation_a", logicalBranchId: "branch_a", parentCheckpointId: null, status: "retained", message: "baseline", createdAt: "2026-01-01T00:00:00.000Z", rewoundAt: null, changes: [] }],
      };
    },
    async rewind(locator, input) { rewindCalls.push({ locator, input }); return { applied: true }; },
  };
  const facade = new SshVersionControlFacade({
    serverId: "server_a",
    serverIdentity: workspace.serverIdentity,
    container: {
      actor: { actorId: "alice" },
      async workspaceFor() { return { async getWorkspace() { return workspace; } }; },
      async versioningFor() { return versioning; },
    },
    remoteFs: {
      async diffTree(input) {
        assert.deepEqual(input.exclude, [".git", ".easywork"]);
        return [{ path: "notes.txt", before: { exists: false, sha256: null, size: 0 }, after: { exists: true, sha256: "abc", size: 3 } }];
      },
    },
  });
  const status = await facade.status({ workspaceId: workspace.id, branchId: "branch_a" });
  assert.deepEqual(status.workspace, { id: workspace.id, canonicalPath: workspace.canonicalPath, kind: "user", versionDomainId: "vd_a" });
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.deepEqual(status.counts, { added: 1, modified: 0, deleted: 0 });
  assert.equal(status.headCheckpointId, "checkpoint_a");
  const rewound = await facade.rewind({ workspaceId: workspace.id, branchId: "branch_a", targetCheckpointId: "checkpoint_a", rewindId: "rewind_a" });
  assert.equal(rewound.applied, true);
  assert.equal(rewindCalls[0].locator.versionDomainId, "vd_a");
  assert.deepEqual(rewindCalls[0].input, { branchId: "branch_a", targetCheckpointId: "checkpoint_a", rewindId: "rewind_a" });
});

test("Actor runtime reads native Agent context through the binding transport and persists its patch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easywork-agent-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runtime = await createEasyWorkRuntime({
    dataRoot: path.join(root, "data"),
    agentTransportFactory: async () => ({
      async execute(request) {
        calls.push(request);
        return { runId: "native_run", contextUsage: { usedTokens: 12, limitTokens: 100 }, bindingPatch: { native: { runtimeRoot: "/home/alice/.easywork/runtime" } } };
      },
    }),
  });
  t.after(() => runtime.close());
  const registered = await runtime.auth.register({ username: "agent-context", password: "password-value", deviceId: "device-a" });
  const session = await runtime.auth.resolveSession(registered.token);
  const services = await runtime.servicesForActor(session.actor);
  const bindingId = "binding_context_a";
  await services.taskRuntime.saveBinding(bindingId, {
    schemaVersion: 1,
    agentBindingId: bindingId,
    adapterId: "codex",
    state: createAgentAdapters().codex.createState({ sessionId: "thread-a" }),
    native: { threadId: "thread-a", agentSource: "managed" },
    activeRunId: null,
    activeCommandId: null,
  });
  const result = await services.agentOperation("server-a", "codex", "contextUsage", { bindingId });
  assert.deepEqual(result.contextUsage, { usedTokens: 12, limitTokens: 100 });
  assert.equal(calls[0].descriptor.transport, "event-cache");
  assert.equal(calls[0].task.route.serverId, "server-a");
  const saved = await services.taskRuntime.loadBinding(bindingId);
  assert.equal(saved.native.runtimeRoot, "/home/alice/.easywork/runtime");
  assert.deepEqual(saved.state.contextUsage, { usedTokens: 12, limitTokens: 100 });
});
