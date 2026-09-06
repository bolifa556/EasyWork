import assert from "node:assert/strict";
import test from "node:test";
import { RemoteTaskLifecycle } from "../gateway/core/runtime/services.mjs";
import { createAgentBindingKey } from "../gateway/core/scope.mjs";

const pin = { skillId: "platform-guide", version: "1.0.0", sha256: "a".repeat(64) };
const catalogSkill = (value = pin, forceEnabled = true) => ({
  skillId: value.skillId, name: value.skillId,
  applicability: { mode: "all", forceEnabled },
  knowledge: { key: `skill:${value.skillId}`, version: `semantic-v1:${value.version}:${value.sha256}` },
});

function fixture(agentId = "codex") {
  const scope = { actorType: "user", actorId: "forced-skill-user", conversationId: "conversation", branchId: "main", contextEpoch: 0,
    serverId: "server", serverIdentity: "identity", workspaceId: "workspace", agentId, selectedSkillVersions: [] };
  const bindingKey = createAgentBindingKey(scope, agentId);
  const binding = { adapterId: agentId, activeRunId: null, native: { sessionId: "native-a", skillPins: [] } };
  const bindings = new Map([[bindingKey, binding]]);
  const reads = [];
  const container = {
    taskRuntime: { async loadBinding(key) { reads.push(key); return bindings.get(key) || null; } },
    contextHub: {
      async unacknowledgedKnowledge({ units }) { return units; },
      async unacknowledgedSemanticContent({ values }) { return values; },
    },
  };
  const lifecycle = new RemoteTaskLifecycle(container, {});
  const select = (skills = [catalogSkill()], selectedScope = scope) => lifecycle.filterForcedSkillCatalog({ scope: selectedScope, skills });
  const deployed = (pins = [pin], selectedScope = scope) => {
    bindings.get(createAgentBindingKey(selectedScope, selectedScope.agentId)).native.skillPins = structuredClone(pins);
    lifecycle.settleForcedSkillDelivery(selectedScope, { operation: "create", start: { status: "running" }, task: { skillPins: pins } });
  };
  return { scope, binding, bindings, reads, container, lifecycle, select, deployed };
}

for (const agentId of ["codex", "claude-code", "opencode"]) {
  test(`${agentId}: 连续三次提问只在首次检查并补发强制技能，部署后无需等待 Task 完成`, async () => {
    const f = fixture(agentId);
    assert.equal((await f.select()).length, 1);
    f.deployed();
    assert.equal((await f.select()).length, 0);
    const nextTurn = new RemoteTaskLifecycle(f.container, {});
    assert.equal((await nextTurn.filterForcedSkillCatalog({ scope: f.scope, skills: [catalogSkill()] })).length, 0);
    assert.equal(f.reads.length, 1, "下一轮 lifecycle 复用 Actor 的绑定检查结果");
    f.binding.native.sessionId = "replacement-session";
    assert.equal((await f.select()).length, 0);
    assert.equal(f.reads.length, 1, "同一绑定目录不因底层原生进程重建重复检查");
  });
}

test("切换远端绑定后只在下一问重新检查，A -> B -> A 不沿用过期检查", async () => {
  const f = fixture();
  f.binding.native.skillPins = [pin];
  assert.equal((await f.select()).length, 0);
  assert.equal((await f.select()).length, 0);
  const bScope = { ...f.scope, agentId: "opencode" };
  f.bindings.set(createAgentBindingKey(bScope, bScope.agentId), { native: { skillPins: [] } });
  assert.equal((await f.select([catalogSkill()], bScope)).length, 1);
  f.deployed([pin], bScope);
  assert.equal((await f.select([catalogSkill()], bScope)).length, 0);
  assert.equal((await f.select()).length, 0);
  assert.equal(f.reads.length, 3);
  await f.select([], bScope);
  await f.select();
  assert.equal(f.reads.length, 4, "切到没有强制技能的绑定后，切回也要检查");
});

test("强制技能仍不阻止手动重选或按需下载 Skill 的本轮调用", async () => {
  const f = fixture();
  const download = { ...pin, skillId: "remote-download" };
  f.binding.native.skillPins = [pin, download];
  const skills = [catalogSkill(), catalogSkill(download, false)];
  assert.deepEqual((await f.select(skills)).map(s => s.skillId), [download.skillId]);
  assert.equal((await f.select(skills, { ...f.scope, selectedSkillVersions: [{ skillId: pin.skillId, version: pin.version }] })).length, 2);
  const fragments = skills.map(skill => ({ toolName: "skill_search", rendered: skill.name, knowledge: skill.knowledge }));
  assert.deepEqual(await f.lifecycle.filterHandoff({ scope: f.scope, fragments }), fragments);
});

test("首次检查按精确版本和哈希判断，其他对话或工作区的安装不能混用", async () => {
  const f = fixture();
  f.binding.native.skillPins = [pin];
  const newer = { ...pin, version: "2.0.0", sha256: "b".repeat(64) };
  assert.equal((await f.select([catalogSkill(newer)])).length, 1);
  f.deployed([newer]);
  assert.equal((await f.select([catalogSkill(newer)])).length, 0);
  for (const change of [{ conversationId: "other" }, { workspaceId: "other" }, { contextEpoch: 1 }]) {
    assert.equal((await f.select([catalogSkill()], { ...f.scope, ...change })).length, 1);
  }
  const changedHash = fixture();
  changedHash.binding.native.skillPins = [pin];
  assert.equal((await changedHash.select([catalogSkill({ ...pin, sha256: "c".repeat(64) })])).length, 1);
});

test("分支继承独立的技能视图，首次检查即可复用", async () => {
  const f = fixture();
  f.binding.native.skillPins = [pin];
  const childScope = { ...f.scope, conversationId: "child", branchId: "child" };
  const child = structuredClone(f.binding);
  f.bindings.set(createAgentBindingKey(childScope, childScope.agentId), child);
  assert.equal((await f.select([catalogSkill()], childScope)).length, 0);
  child.native.skillPins[0].sha256 = "b".repeat(64);
  assert.equal((await f.select()).length, 0);
  assert.equal(f.binding.native.skillPins[0].sha256, pin.sha256);
});

test("补发失败后重试检查；只有计划 pin 不算已安装", async () => {
  const f = fixture();
  assert.equal((await f.select([catalogSkill()], { ...f.scope, skillPins: [pin] })).length, 1);
  f.lifecycle.settleForcedSkillDelivery(f.scope, null);
  assert.equal((await f.select()).length, 1);
  f.lifecycle.settleForcedSkillDelivery(f.scope, { operation: "create", start: { status: "interrupted" }, task: { skillPins: [pin] } });
  assert.equal((await f.select()).length, 1);
  assert.equal(f.reads.length, 3);
  f.deployed();
  assert.equal((await f.select()).length, 0);
  assert.equal(f.reads.length, 3);
});
