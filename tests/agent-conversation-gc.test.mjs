import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { remoteAgentConfigurationPaths, remoteAgentPaths } from "../gateway/core/agent-runtime/contract.mjs";
import { RemoteAgentConversationGarbageCollector } from "../gateway/core/runtime/agent-conversation-gc.mjs";
import { createAgentBindingKey } from "../gateway/core/scope.mjs";
import { createWorkspaceBindingKey } from "../gateway/core/workspaces/contract.mjs";

const actor = createActorContext({ actorType: "user", actorId: "user_gc", deviceId: "device_gc", sessionId: "session_gc", roles: [] });
const serverIdentity = `ssh_${"g".repeat(43)}`;

function remoteRecord({ conversationId, branchId, workspaceId, agentId, contextEpoch, actorId = actor.actorId }) {
  const key = createWorkspaceBindingKey({ actorId, serverIdentity, conversationId, branchId, workspaceId, agentId, contextEpoch });
  const bindingId = `wsb_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
  return {
    bindingId,
    path: `/home/tester/.easywork/bindings/workspaces/${bindingId}.json`,
    value: { schemaVersion: 2, bindingId, conversationId, branchId, workspaceId, versionDomainId: "vl_workspace_binding", agentId, contextEpoch, nativeSessionId: "native-a", lastDeliverySequence: 2, status: "active" },
  };
}

class FakeExecutor {
  constructor(records = [], { existingRuntimeIndices = [0, 1] } = {}) {
    this.commands = [];
    this.records = records;
    this.existingRuntimeIndices = existingRuntimeIndices;
    this.files = new Map(records.map((record) => [record.path, Buffer.from(JSON.stringify(record.value))]));
  }

  async home() { return "/home/tester"; }

  async exec(command) {
    this.commands.push(command);
    if (command.includes("easywork-agent-gc-native-references")) {
      const agentId = ["opencode", "codex", "claude-code"].find((candidate) => command.includes(`/runtime/agents/${candidate}'`)) || "";
      const fields = [...this.files.entries()]
        .filter(([remotePath]) => new RegExp(`/runtime/agents/${agentId}/[^/]+/state/active\\.json$`).test(remotePath))
        .flatMap(([remotePath, bytes]) => [remotePath, Buffer.from(bytes).toString("base64")]);
      return { code: 0, stdout: fields.length ? `${fields.join("\0")}\0` : "", stderr: "" };
    }
    if (command.includes("easywork-agent-gc-existing")) {
      return { code: 0, stdout: `${this.existingRuntimeIndices.join("\n")}\n`, stderr: "" };
    }
    if (command.includes("easywork-agent-gc")) {
      const fields = this.records.flatMap((record) => [record.path, Buffer.from(JSON.stringify(record.value)).toString("base64")]);
      return { code: 0, stdout: fields.length ? `${fields.join("\0")}\0` : "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }

  async readFile(remotePath) {
    if (!this.files.has(remotePath)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.files.get(remotePath);
  }

  async writeAtomic(remotePath, bytes) {
    this.files.set(remotePath, Buffer.from(bytes));
  }
}

test("SSH 重连只回收当前 Actor 与服务器上属于已删除网页对话的 Agent 原生会话", async () => {
  const deletedConversationId = "conversation_deleted";
  const liveConversationId = "conversation_live";
  const deleted = remoteRecord({ conversationId: deletedConversationId, branchId: "branch_main", workspaceId: "workspace_a", agentId: "opencode", contextEpoch: 0 });
  const live = remoteRecord({ conversationId: liveConversationId, branchId: "branch_main", workspaceId: "workspace_a", agentId: "opencode", contextEpoch: 0 });
  const foreign = remoteRecord({ conversationId: deletedConversationId, branchId: "branch_other", workspaceId: "workspace_b", agentId: "claude-code", contextEpoch: 1, actorId: "another_actor" });
  const executor = new FakeExecutor([deleted, live, foreign], { existingRuntimeIndices: [0, 1, 2] });
  const versionRoot = `/home/tester/.easywork/versioning/${actor.actorId}/${serverIdentity}`;
  const versionRegistryPath = `${versionRoot}/ledgers.json`;
  const sharedObjectId = "a".repeat(64);
  executor.files.set(versionRegistryPath, Buffer.from(JSON.stringify({
    schemaVersion: 3,
    revision: 3,
    actorId: actor.actorId,
    serverIdentity,
    ledgers: [
      { versionDomainId: "vl_deleted", conversationId: deletedConversationId, createdAt: "2026-08-01T00:00:00.000Z" },
      { versionDomainId: "vl_live", conversationId: liveConversationId, createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  })));
  executor.files.set(`${versionRoot}/conversations/vl_live/ledger.json`, Buffer.from(JSON.stringify({
    schemaVersion: 3,
    revision: 0,
    actorId: actor.actorId,
    serverIdentity,
    conversationId: liveConversationId,
    versionDomainId: "vl_live",
    storage: {},
    workspaces: {},
    sequence: 1,
    checkpoints: [{
      changes: [{
        before: { exists: false },
        after: { exists: true, objectId: sharedObjectId },
      }],
    }],
    branches: {},
    pending: {},
    rewinds: [],
    switches: [],
    forkedFrom: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  })));
  const remoteAgentBindingId = createAgentBindingKey({
    actorType: actor.actorType,
    actorId: actor.actorId,
    serverIdentity,
    workspaceId: "workspace_a",
    conversationId: deletedConversationId,
    branchId: "branch_main",
    contextEpoch: 0,
  }, "opencode");
  const localAgentBindingId = "abk_local_deleted_binding";
  const localClaudeBindingId = "abk_local_deleted_claude_binding";
  const remotePaths = remoteAgentPaths("/home/tester", "opencode", remoteAgentBindingId);
  const localPaths = remoteAgentPaths("/home/tester", "codex", localAgentBindingId);
  const localClaudePaths = remoteAgentPaths("/home/tester", "claude-code", localClaudeBindingId);
  executor.files.set(`${remotePaths.runtimeState}/active.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, agentId: "opencode", agentBindingId: remoteAgentBindingId, nativeRuntimeBindingId: remoteAgentBindingId, processId: "remote-4101" })));
  executor.files.set(`${localPaths.runtimeState}/active.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, agentId: "codex", agentBindingId: localAgentBindingId, nativeRuntimeBindingId: localAgentBindingId, processId: "remote-4102" })));
  executor.files.set(`${localClaudePaths.runtimeState}/active.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, agentId: "claude-code", agentBindingId: localClaudeBindingId, nativeRuntimeBindingId: localClaudeBindingId, processId: "remote-4103" })));
  const released = [];
  const collector = new RemoteAgentConversationGarbageCollector({
    executor,
    transport: { async releaseBinding(bindingId) { released.push(bindingId); } },
    actor,
    serverIdentity,
  });

  const result = await collector.reconcile({
    conversationIds: [deletedConversationId],
    bindings: [
      { bindingId: localAgentBindingId, agentId: "codex", conversationId: deletedConversationId },
      { bindingId: localClaudeBindingId, agentId: "claude-code", conversationId: deletedConversationId },
    ],
  });

  assert.deepEqual(result, {
    scannedBindings: 3,
    matchedBindings: 1,
    reconciledRuntimes: 3,
    removedBindingRecords: 1,
    reconciledConfigurations: 1,
    reconciledVersionDomains: 1,
    deferredVersionDomains: 0,
    removedWorkspaces: 0,
  });
  assert.deepEqual(new Set(released), new Set([remoteAgentBindingId, localAgentBindingId, localClaudeBindingId]));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-trees") && command.includes(remotePaths.runtimeRoot)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-trees") && command.includes(localPaths.runtimeRoot)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-trees") && command.includes(localClaudePaths.runtimeRoot)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-files") && command.includes(deleted.path)));
  assert.equal(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-files") && command.includes(live.path)), false);
  assert.equal(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-files") && command.includes(foreign.path)), false);
  assert.ok(executor.commands.some((command) => command.includes("gc_pid='4101'") && command.includes(`gc_home='${remotePaths.runtimeHome}'`) && command.includes('HOME=$gc_home')));
  assert.ok(executor.commands.some((command) => command.includes("gc_pid='4102'") && command.includes(`gc_home='${localPaths.runtimeHome}'`) && command.includes('HOME=$gc_home')));
  assert.ok(executor.commands.some((command) => command.includes("gc_pid='4103'") && command.includes(`gc_home='${localClaudePaths.runtimeHome}'`) && command.includes('HOME=$gc_home')));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-runtime-home") && command.includes(remotePaths.runtimeHome)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-runtime-home") && command.includes(localPaths.runtimeHome)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-runtime-home") && command.includes(localClaudePaths.runtimeHome)));
  const configuration = remoteAgentConfigurationPaths("/home/tester", "opencode", actor.actorId, deletedConversationId);
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-trees") && command.includes(configuration.conversationRoot)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-trees") && command.includes(`${versionRoot}/conversations/vl_deleted`)));
  const remainingVersionRegistry = JSON.parse(executor.files.get(versionRegistryPath).toString());
  assert.deepEqual(remainingVersionRegistry.ledgers.map((entry) => entry.versionDomainId), ["vl_live"]);
  assert.ok([...executor.files.entries()].some(([candidate, bytes]) => candidate.startsWith(`${versionRoot}/.gc-live-objects-`) && bytes.toString().includes(sharedObjectId)));
  assert.equal(executor.commands.some((command) => command.includes("$HOME")), false);
});

test("活动记录先消失时仍按隔离 HOME 回收残留 Agent 进程", async () => {
  const executor = new FakeExecutor([], { existingRuntimeIndices: [0] });
  const bindingId = "abk_orphaned_runtime";
  const paths = remoteAgentPaths("/home/tester", "opencode", bindingId);
  const collector = new RemoteAgentConversationGarbageCollector({ executor, actor, serverIdentity });

  const result = await collector.reconcile({
    conversationIds: ["conversation_deleted"],
    bindings: [{ bindingId, agentId: "opencode", conversationId: "conversation_deleted" }],
  });

  assert.equal(result.reconciledRuntimes, 1);
  assert.equal(executor.commands.some((command) => command.includes("gc_pid=")), false);
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-runtime-home") && command.includes(paths.runtimeHome)));
  assert.ok(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-trees") && command.includes(paths.runtimeRoot)));
});

test("没有网页对话删除墓碑时不读取也不修改远端文件", async () => {
  const executor = new FakeExecutor([]);
  const collector = new RemoteAgentConversationGarbageCollector({ executor, actor, serverIdentity });
  assert.deepEqual(await collector.reconcile(), {
    scannedBindings: 0,
    matchedBindings: 0,
    reconciledRuntimes: 0,
    removedBindingRecords: 0,
    reconciledConfigurations: 0,
    reconciledVersionDomains: 0,
    deferredVersionDomains: 0,
    removedWorkspaces: 0,
  });
  assert.equal(executor.commands.length, 0);
});

test("删除 Codex 原生分支的源网页对话时保留被子分支引用的线程仓库，并在最后引用删除后回收", async () => {
  const executor = new FakeExecutor([]);
  const parentBindingId = "abk_codex_parent";
  const childBindingId = "abk_codex_child";
  const parentPaths = remoteAgentPaths("/home/tester", "codex", parentBindingId);
  const childPaths = remoteAgentPaths("/home/tester", "codex", childBindingId);
  const parentActive = `${parentPaths.runtimeState}/active.json`;
  const childActive = `${childPaths.runtimeState}/active.json`;
  executor.files.set(parentActive, Buffer.from(JSON.stringify({
    schemaVersion: 1,
    agentId: "codex",
    agentBindingId: parentBindingId,
    nativeRuntimeBindingId: parentBindingId,
    processId: "remote-4201",
  })));
  executor.files.set(childActive, Buffer.from(JSON.stringify({
    schemaVersion: 1,
    agentId: "codex",
    agentBindingId: childBindingId,
    nativeRuntimeBindingId: parentBindingId,
    processId: "remote-4202",
  })));
  const collector = new RemoteAgentConversationGarbageCollector({ executor, actor, serverIdentity });

  await collector.reconcile({
    conversationIds: ["conversation_parent"],
    bindings: [{ bindingId: parentBindingId, agentId: "codex", conversationId: "conversation_parent" }],
  });
  const firstRemovalCommands = executor.commands.filter((command) => command.includes("easywork-agent-gc-remove-trees"));
  assert.equal(firstRemovalCommands.some((command) => command.includes(parentPaths.runtimeRoot)), false, "仍被子分支引用的 Codex 原生仓库不能删除");
  assert.equal(executor.commands.some((command) => command.includes("easywork-agent-gc-remove-files") && command.includes(parentActive)), true, "源网页 binding 的 active 引用必须退休");
  assert.equal(executor.commands.some((command) => command.includes("gc_pid='4201'") && command.includes(`gc_home='${parentPaths.runtimeHome}'`)), true);

  // FakeExecutor does not execute the remote deletion script; mirror the
  // retired active record before the next reconciliation pass.
  executor.files.delete(parentActive);
  executor.commands.length = 0;
  await collector.reconcile({
    conversationIds: ["conversation_child"],
    bindings: [{ bindingId: childBindingId, agentId: "codex", conversationId: "conversation_child" }],
  });
  const finalRemovalCommands = executor.commands.filter((command) => command.includes("easywork-agent-gc-remove-trees"));
  assert.equal(finalRemovalCommands.some((command) => command.includes(childPaths.runtimeRoot)), true);
  assert.equal(finalRemovalCommands.some((command) => command.includes(parentPaths.runtimeRoot)), true, "最后一个原生分支删除后应回收保留的源线程仓库");
});
