import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createActorContext } from "../gateway/core/actor.mjs";
import { ContextHub } from "../gateway/core/context-hub/service.mjs";
import { createAgentBindingKey } from "../gateway/core/scope.mjs";
import { RemoteTaskLifecycle } from "../gateway/core/runtime/services.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import { WebAgentRuntime, createDefaultWebAgentTools } from "../gateway/core/web-agent/index.mjs";

test("持久发送收据告诉网页 Agent 技能、文件和记忆已经发过，仅新内容进入下发", async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-delivery-status-"));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const actor = createActorContext({ actorType: "user", actorId: "owner", deviceId: "test", sessionId: "test", roles: [] });
  const scope = { actorType: "user", actorId: actor.actorId, conversationId: "conversation", branchId: "main", contextEpoch: 0,
    serverId: "server", serverIdentity: "identity", workspaceId: "workspace", agentId: "codex", selectedSkillIds: [] };
  const bindingKey = createAgentBindingKey(scope, scope.agentId);
  const binding = { native: { sessionId: "native-a", skillPins: [{ skillId: "guide", version: "old", sha256: "old-content-hash" }] } };
  const memory = { toolName: "memory_catalog", rendered: "计算结果保留三位小数", presented: { memory: [{ content: "计算结果保留三位小数" }] }, knowledge: { key: "memory:precision", version: "record-v1", content: "计算结果保留三位小数" } };
  const file = { toolName: "resource_read", rendered: "输入文件的数据", reference: { kind: "文件", name: "inputs.csv" }, knowledge: { key: "resource:data:file", version: "data-1", content: "输入文件的数据" } };
  const fresh = { toolName: "memory_catalog", rendered: "本次新增要求", presented: { memory: [{ content: "本次新增要求" }] }, knowledge: { key: "memory:new", version: "record-v1", content: "本次新增要求" } };
  await new ContextHub({ dataRoot, actor }).acknowledgeKnowledge({ bindingKey, nativeSessionId: "native-a", units: [memory.knowledge, file.knowledge] });
  const contextHub = new ContextHub({ dataRoot, actor });
  const lifecycle = new RemoteTaskLifecycle({ taskRuntime: { async loadBinding() { return binding; } }, contextHub }, {});
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  const tools = await createDefaultWebAgentTools({ skills: { read: async () => ({ skills: [{ skillId: "guide", name: "已部署规范", sha256: "new-content-hash", files: [{ path: "SKILL.md", content: "技能规则" }] }] }) }, context: {} }, prompts);
  const catalog = await lifecycle.skillCatalogForBinding({ scope, skills: [{ skillId: "guide", name: "已部署规范", description: "操作规范" }] });
  const catalogPrompt = await prompts.skillCatalog(catalog);
  assert.match(catalogPrompt, /已部署规范（已发送到当前远端对话/);
  let calls = 0;
  const runtime = new WebAgentRuntime({ prompts, tools, model: { async complete({ messages }) {
    calls++;
    if (calls === 1) {
      const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
      assert.match(system, /之前已经成功发送/);
      assert.match(system, /计算结果保留三位小数/);
      assert.match(system, /inputs.csv/);
      assert.match(system, /已部署规范（已发送/);
      return { toolCalls: [{ id: "read-again", name: "skill_search", input: { name: "已部署规范", query: "继续之前的工作" } }] };
    }
    assert.match(messages.findLast((message) => message.role === "tool").content, /之前已经成功发送[\s\S]*已部署规范/);
    const ids = [...new Set(messages.flatMap((message) => [...String(message.content).matchAll(/candidate_id:\s*(candidate_[a-f0-9]+)/g)].map((match) => match[1])))];
    assert.equal(ids.length, 1, "只有新增记忆可以提交");
    return { toolCalls: [{ id: "send-new", name: "handoff_submit", input: { candidateIds: ids } }] };
  } } });
  const result = await runtime.run({ mode: "work", actor, scope, userMessage: "继续之前的工作", context: [{ role: "system", content: catalogPrompt }],
    initialObservationFragments: [memory, file, fresh],
    observationFilter: async (fragments) => {
      const pending = new Set(await lifecycle.filterHandoff({ scope, fragments }));
      return fragments.map((fragment) => pending.has(fragment) ? fragment : { ...fragment, deliveryState: "delivered" });
    },
    handoffFilter: (fragments) => lifecycle.filterHandoff({ scope, fragments }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.handoffFragments.map((fragment) => fragment.knowledge.key), [fresh.knowledge.key]);
  assert.doesNotMatch(result.content, /已部署规范|inputs\.csv|三位小数/);
  await contextHub.stageKnowledge({ bindingKey, taskId: "not-started", units: [fresh.knowledge] });
  assert.equal((await lifecycle.filterHandoff({ scope, fragments: [fresh] })).length, 1, "未确认的失败下发不能充当发送收据");
  binding.native.sessionId = "new-native-session";
  assert.equal((await lifecycle.filterHandoff({ scope, fragments: [memory, file] })).length, 2, "新原生会话需要收到自己的文件和记忆");
});
