import assert from "node:assert/strict";
import test from "node:test";

import { OrchestratorVersionAdapter } from "../gateway/core/runtime/adapters.mjs";

function task(id, branchId, versionDomainId) {
  return {
    id,
    actorId: "actor-version-lease",
    conversationId: `conversation-${branchId}`,
    branchId,
    agentBindingId: `binding-${id}`,
    versionCheckpointId: null,
    route: {
      serverId: "server-version-lease",
      serverIdentity: "ssh:user@example.test:22",
      workspaceId: "workspace-shared",
      agentId: "opencode",
    },
    workspacePath: "/work/shared",
    versionDomainId,
  };
}

function workspace(versionDomainId, path = "/work/shared") {
  return {
    id: "workspace-shared",
    canonicalPath: path,
    path,
    kind: "user",
    serverIdentity: "ssh:user@example.test:22",
    versionDomainId,
  };
}

function fixture() {
  const activations = [];
  const domains = new Map([
    ["domain-parent", { revision: 1, branches: { "branch-parent": { headCheckpointId: "checkpoint-parent" } } }],
    ["domain-child", { revision: 1, branches: { "branch-child": { headCheckpointId: "checkpoint-child" } } }],
    ["domain-other", { revision: 1, branches: { "branch-other": { headCheckpointId: "checkpoint-other" } } }],
  ]);
  const service = {
    async getDomain(locator) { return structuredClone(domains.get(locator.versionDomainId)); },
    async activateCheckpoint(locator, input) {
      activations.push({ domain: locator.versionDomainId, checkpointId: input.checkpointId });
      throw new Error("normal Task preparation must not materialize a conversation checkpoint");
    },
    async agentOperationCount() { return 0; },
  };
  const adapter = new OrchestratorVersionAdapter({
    versionFactory: async () => service,
    workspaceFactory: async () => ({ async getRoute() { throw new Error("unexpected recovery route"); } }),
  });
  return { adapter, activations };
}

test("同一物理工作区的不同网页对话并发准备且不自动物化各自 HEAD", async () => {
  const { adapter, activations } = fixture();
  const parent = task("task-parent", "branch-parent", "domain-parent");
  const child = task("task-child", "branch-child", "domain-child");

  const [parentPrepared, childPrepared] = await Promise.all([
    adapter.prepare({ task: parent, workspace: workspace("domain-parent") }),
    adapter.prepare({ task: child, workspace: workspace("domain-child") }),
  ]);

  assert.equal(parentPrepared.headCheckpointId, "checkpoint-parent");
  assert.equal(childPrepared.headCheckpointId, "checkpoint-child");
  assert.deepEqual(activations, []);
  await Promise.all([adapter.finalize({ task: parent }), adapter.finalize({ task: child })]);
});

test("普通 Task 只登记所属网页对话的账本，不把共享文件按 Agent 分片", async () => {
  const { adapter, activations } = fixture();
  const parent = task("task-parent-abandon", "branch-parent", "domain-parent");
  const other = task("task-other-workspace", "branch-other", "domain-other");

  const parentPrepared = await adapter.prepare({ task: parent, workspace: workspace("domain-parent") });
  const otherPrepared = await adapter.prepare({ task: other, workspace: workspace("domain-other", "/work/other") });
  assert.equal(parentPrepared.versionDomainId, "domain-parent");
  assert.equal(otherPrepared.versionDomainId, "domain-other");
  assert.deepEqual(activations, []);
  await adapter.abandon(parent.id);
  await adapter.finalize({ task: other });
});
