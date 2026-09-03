import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentAdapters } from "../gateway/core/agents/index.mjs";
import { RoutingAgentTransport, SshSchedulerExecutor } from "../gateway/core/runtime/remote.mjs";
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

test("SSH scheduler probes use the transport's bounded concurrency instead of a second serial queue", async () => {
  let active = 0;
  let peak = 0;
  const executor = new SshSchedulerExecutor({
    async exec(command) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { code: 0, stdout: command.includes("sinfo") ? "slurm 24.05" : "slurm 24.05", stderr: "" };
    },
  });
  const descriptor = (executable) => ({ executable, argv: ["--version"], timeoutMs: 1_000, maxOutputBytes: 4_096 });

  const results = await Promise.all([
    executor.run(descriptor("sinfo")),
    executor.run(descriptor("squeue")),
    executor.run(descriptor("scontrol")),
  ]);

  assert.equal(peak, 3);
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0]);
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
    route: {
      serverId: "server-a",
      serverIdentity: `ssh_${"a".repeat(43)}`,
      workspaceId: "workspace-a",
      agentId: "codex",
      providerId: "provider-agent",
      modelId: "model-agent",
    },
    state: createAgentAdapters().codex.createState({ sessionId: "thread-a" }),
    native: { threadId: "thread-a", agentSource: "managed" },
    activeRunId: null,
    activeCommandId: null,
  });
  const result = await services.agentOperation("server-a", "codex", "contextUsage", { bindingId, configScope: "conversation-a" });
  assert.deepEqual(result.contextUsage, { usedTokens: 12, limitTokens: 100 });
  assert.equal(calls[0].descriptor.transport, "event-cache");
  assert.equal(calls[0].task.route.serverId, "server-a");
  const saved = await services.taskRuntime.loadBinding(bindingId);
  assert.equal(saved.native.runtimeRoot, "/home/alice/.easywork/runtime");
  assert.deepEqual(saved.state.contextUsage, { usedTokens: 12, limitTokens: 100 });
});

test("OpenCode native compact reuses the model route persisted on its binding", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "easywork-opencode-compact-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const runtime = await createEasyWorkRuntime({
    dataRoot: path.join(root, "data"),
    agentTransportFactory: async () => ({
      async execute(request) {
        calls.push(request);
        return { runId: "native_run", bindingPatch: {} };
      },
    }),
  });
  t.after(() => runtime.close());
  const registered = await runtime.auth.register({ username: "opencode-compact-route", password: "password-value", deviceId: "device-a" });
  const session = await runtime.auth.resolveSession(registered.token);
  const services = await runtime.servicesForActor(session.actor);
  const bindingId = "binding_opencode_compact";
  await services.taskRuntime.saveBinding(bindingId, {
    schemaVersion: 1,
    agentBindingId: bindingId,
    adapterId: "opencode",
    route: {
      serverId: "server-a",
      serverIdentity: `ssh_${"a".repeat(43)}`,
      workspaceId: "workspace-a",
      agentId: "opencode",
      providerId: "provider-agent",
      modelId: "model-agent",
    },
    state: services.agentAdapters.opencode.createState({ sessionId: "session-a" }),
    native: { sessionId: "session-a", agentSource: "managed" },
    activeRunId: "native_run",
    activeCommandId: null,
  });

  await services.agentOperation("server-a", "opencode", "compact", { bindingId, configScope: "conversation-a" });

  assert.equal(calls[0].descriptor.request.path, "/api/session/session-a/compact");
  assert.equal(calls[0].descriptor.request.body, undefined);
  assert.equal(calls[0].task.route.providerId, "provider-agent");
  assert.equal(calls[0].task.route.modelId, "model-agent");
});
