import assert from "node:assert/strict";
import test from "node:test";
import { RemoteTaskLifecycle } from "../gateway/core/runtime/services.mjs";
import { createAgentBindingKey } from "../gateway/core/scope.mjs";

const skill = { skillId: "platform-guide", sha256: "a".repeat(64) };
const catalogSkill = (item = skill, forceEnabled = true) => ({
  skillId: item.skillId, name: item.skillId, applicability: { mode: "all", forceEnabled },
  knowledge: { key: "skill:" + item.skillId, version: item.sha256 },
});
function fixture(agentId = "codex") {
  const scope = { actorType: "user", actorId: "delivery-user", conversationId: "conversation", branchId: "main", contextEpoch: 0,
    serverId: "server", serverIdentity: "identity", workspaceId: "workspace", agentId, selectedSkillIds: [] };
  const binding = { native: { sessionId: "native-a", skillPins: [] } };
  const bindings = new Map([[createAgentBindingKey(scope, agentId), binding]]);
  const container = {
    taskRuntime: { async loadBinding(key) { return bindings.get(key) || null; } },
    contextHub: {
      async unacknowledgedKnowledge({ units }) { return units; },
      async unacknowledgedSemanticContent({ values }) { return values; },
    },
  };
  const lifecycle = new RemoteTaskLifecycle(container, {});
  const catalog = (items = [catalogSkill()], route = scope) => lifecycle.skillCatalogForBinding({ scope: route, skills: items });
  const filter = (items = [catalogSkill()], route = scope) => lifecycle.filterHandoff({
    scope: route, fragments: items.map(item => ({ toolName: "skill_search", rendered: item.name, knowledge: item.knowledge })),
  });
  return { scope, binding, bindings, container, lifecycle, catalog, filter };
}
for (const agentId of ["codex", "claude-code", "opencode", "qoder-cn"]) {
  test(agentId + "：技能首次发送后标为已发送，重启 lifecycle 后也不会重复下发", async () => {
    const f = fixture(agentId);
    assert.equal((await f.catalog())[0].deliveryState, "pending");
    assert.equal((await f.filter()).length, 1);
    f.binding.native.skillPins = [skill];
    assert.equal((await f.catalog())[0].deliveryState, "delivered");
    assert.equal((await f.filter()).length, 0);
    const next = new RemoteTaskLifecycle(f.container, {});
    assert.equal((await next.skillCatalogForBinding({ scope: f.scope, skills: [catalogSkill()] }))[0].deliveryState, "delivered");
    f.binding.native.sessionId = null;
    assert.equal((await f.filter()).length, 0, "技能目录不随原生进程退出消失");
  });
}
test("普通技能与强制技能使用相同的发送记录，旧版本字段不会导致重发", async () => {
  const f = fixture();
  const download = { skillId: "remote-download", sha256: "b".repeat(64) };
  f.binding.native.skillPins = [{ ...skill, version: "obsolete" }, download];
  const items = [catalogSkill({ ...skill, sha256: "c".repeat(64) }), catalogSkill(download, false)];
  assert.deepEqual((await f.catalog(items)).map(item => item.deliveryState), ["delivered", "delivered"]);
  assert.deepEqual(await f.filter(items), []);
  assert.equal((await f.filter(items, { ...f.scope, selectedSkillIds: [skill.skillId] })).length, 1, "用户明确重选时允许重新发送当前内容");
});
test("切换绑定、对话或代次重新判断；切回原绑定复用它实际安装的技能", async () => {
  const f = fixture();
  f.binding.native.skillPins = [skill];
  for (const change of [{ agentId: "opencode" }, { conversationId: "other" }, { contextEpoch: 1 }]) {
    const target = { ...f.scope, ...change };
    assert.equal((await f.catalog([catalogSkill()], target))[0].deliveryState, "pending");
    assert.equal((await f.filter([catalogSkill()], target)).length, 1);
    assert.equal((await f.catalog())[0].deliveryState, "delivered");
  }
});
test("分支独立继承实际安装记录，计划或失败下发不记作已发送", async () => {
  const f = fixture();
  assert.equal((await f.catalog([catalogSkill()], { ...f.scope, skillPins: [skill] }))[0].deliveryState, "pending");
  f.binding.native.skillPins = [skill];
  const branch = { ...f.scope, conversationId: "child", branchId: "child" };
  const child = structuredClone(f.binding);
  f.bindings.set(createAgentBindingKey(branch, branch.agentId), child);
  assert.equal((await f.catalog([catalogSkill()], branch))[0].deliveryState, "delivered");
  child.native.skillPins = [];
  assert.equal((await f.catalog([catalogSkill()], branch))[0].deliveryState, "pending");
  assert.equal((await f.catalog())[0].deliveryState, "delivered");
});
