import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { WORK_WEB_AGENT_LIMITS } from "../gateway/core/runtime/services.mjs";
import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import { OpenAIChatModel, WebAgentRuntime, createDefaultWebAgentTools } from "../gateway/core/web-agent/index.mjs";

test("Work 不发送单次输出上限，较长推理后可直接完成提交而无需重试", async () => {
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  const tools = await createDefaultWebAgentTools({
    context: { search: async () => ({}) },
    skills: { list: async () => [], read: async () => ({ skills: [] }) },
  }, prompts, { workMemoryTools: false, workResourceTools: false, workSkillTools: true });
  const requests = [];
  const model = new OpenAIChatModel({
    baseUrl: "https://model.example.test", apiKey: "test-key", model: "reasoning-model", systemMessageSeparator: "\n\n",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      // A valid provider response may exceed both the former Work budget and
      // the generic 32k budget. The client must not impose either one.
      const fits = !Object.hasOwn(request, "max_tokens");
      const delta = fits ? { tool_calls: [{ index: 0, id: "submit", function: { name: "handoff_submit", arguments: '{"candidateIds":[]}' } }] } : {};
      const events = [
        { choices: [{ delta: { reasoning_content: "已判断当前提问不需要补充资料。" } }] },
        { choices: [{ delta, finish_reason: fits ? "tool_calls" : "length" }] },
        { choices: [], usage: { prompt_tokens: 1772, completion_tokens: fits ? 50_000 : request.max_tokens } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const runtime = new WebAgentRuntime({ model, tools, prompts, limits: WORK_WEB_AGENT_LIMITS });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "现在还剩哪些文件，简单说一下就好。" });
  assert.equal(requests.length, 1);
  assert.equal(result.toolCallCount, 1);
  assert.deepEqual(result.handoffFragments, []);
  assert.equal(result.usage.completion_tokens, 50_000);
});

test("持续补充新资料可以越过原来的 16 轮和 48 次工具限制，全部候选完整交付", async () => {
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  let calls = 0;
  let reads = 0;
  const tools = await createDefaultWebAgentTools({
    context: {
      search: async () => ({}),
      readResource: async ({ filename }) => {
        reads += 1;
        return { resources: [{ resourceId: filename, resourceVersionId: "v1", chunkId: "read-0", filename, text: `必要资料 ${filename}` }] };
      },
    },
    skills: { list: async () => [], read: async () => ({ skills: [] }) },
  }, prompts, { workMemoryTools: false, workResourceTools: true, workSkillTools: false });
  const model = {
    complete: async ({ messages }) => {
      calls += 1;
      if (calls <= 20) return { toolCalls: Array.from({ length: 3 }, (_, i) => ({ id: `read-${calls}-${i}`, name: "resource_read", input: { filename: `${calls}-${i}.md` } })) };
      const candidateIds = [...new Set(messages.flatMap(message => [...String(message.content).matchAll(/candidate_id:\s*(candidate_[a-f0-9]+)/g)].map(match => match[1])))];
      return { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds } }] };
    },
  };
  const runtime = new WebAgentRuntime({ model, tools, prompts, limits: WORK_WEB_AGENT_LIMITS });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "结合项目资料处理一下。" });
  assert.equal(result.iterations, 21);
  assert.equal(result.toolCallCount, 61);
  assert.equal(reads, 60);
  assert.equal(result.handoffFragments.length, 60);
  assert.ok(result.handoffFragments.some(fragment => fragment.knowledge.content === "必要资料 20-2.md"));
});

test("正常持续输出跨过无响应时长也能完成；用户仍可停止运行", async () => {
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  const tools = await createDefaultWebAgentTools({
    context: { search: async () => ({}) }, skills: { list: async () => [], read: async () => ({ skills: [] }) },
  }, prompts, { workMemoryTools: false, workResourceTools: false, workSkillTools: true });
  const model = {
    complete: async ({ signal, onActivity }) => {
      for (let chunk = 0; chunk < 5; chunk += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        signal.throwIfAborted();
        await onActivity();
      }
      return { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds: [] } }] };
    },
  };
  const runtime = new WebAgentRuntime({ model, tools, prompts, limits: { ...WORK_WEB_AGENT_LIMITS, workModelTimeoutMs: 70 } });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "看看项目资料" });
  assert.equal(result.iterations, 1);
  const controller = new AbortController();
  const stopped = runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "继续", signal: controller.signal });
  setTimeout(() => controller.abort(new Error("用户停止")), 30);
  await assert.rejects(stopped, /用户停止/);
});

test("Skill 发现目录不遗漏排在第 50 项之后的技能，也不截断名称简介", async () => {
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  const catalog = Array.from({ length: 61 }, (_, i) => ({ name: `技能-${i}`, description: "适用条件".repeat(220) + `末尾条件-${i}` }));
  const tools = await createDefaultWebAgentTools({ context: {}, skills: { list: async () => catalog } }, prompts);
  const tool = tools.resolve("skill_list", "work");
  const presented = tool.present({ output: await tool.execute({ actor: {} }) });
  const rendered = await tool.render(presented);
  assert.equal(presented.skills.length, catalog.length);
  assert.match(rendered, /技能-60/);
  assert.match(rendered, /末尾条件-60/);
  let calls = 0;
  const runtime = new WebAgentRuntime({
    tools, prompts, limits: WORK_WEB_AGENT_LIMITS,
    model: { complete: async ({ messages }) => {
      if (++calls === 1) return { toolCalls: [{ id: "catalog", name: "skill_list", input: {} }] };
      assert.match(messages.find(message => message.toolCallId === "catalog").content, /末尾条件-60/);
      return { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds: [] } }] };
    } },
  });
  await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "帮我按对应规范处理。" });
});

test("明确选中的资料超过 128 条时仍全部交付", async () => {
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  const tools = await createDefaultWebAgentTools({ context: {}, skills: {} }, prompts, { workMemoryTools: false, workResourceTools: false, workSkillTools: false });
  const fragments = Array.from({ length: 140 }, (_, i) => ({
    toolName: "resource_read", rendered: `资料-${i}`, presented: { resources: [{ filename: `${i}.md`, text: `资料-${i}` }] },
    knowledge: { key: `resource:${i}:read-0`, version: "v1", content: `资料-${i}` }, reference: { kind: "文件", name: `${i}.md` },
  }));
  const runtime = new WebAgentRuntime({
    prompts, tools, limits: WORK_WEB_AGENT_LIMITS,
    model: { complete: async ({ messages }) => ({ toolCalls: [{ id: "submit", name: "handoff_submit", input: {
      candidateIds: [...new Set(messages.flatMap(message => [...String(message.content).matchAll(/candidate_id:\s*(candidate_[a-f0-9]+)/g)].map(match => match[1])))],
    } }] }) },
  });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "结合这些资料处理。", initialObservationFragments: fragments });
  assert.equal(result.handoffFragments.length, fragments.length);
  assert.equal(result.handoffFragments.at(-1).knowledge.content, "资料-139");
});

test("读取命中已知正文时仍保留后续位置，能够继续取得并交付文件尾部", async () => {
  const prompts = new PromptRepository({ promptRoot: path.resolve("prompts") });
  const head = { resourceId: "requirements", resourceVersionId: "v1", chunkId: "read-0", filename: "交付要求.md", text: "需要比较基准组与改进组。" };
  const tools = await createDefaultWebAgentTools({
    context: {
      search: async () => ({ resources: [head] }),
      readResource: async ({ start }) => ({ resources: [start
        ? { ...head, chunkId: "read-120", text: "还需要保留随机种子和失败记录。", nextOffset: null }
        : { ...head, nextOffset: 120 }] }),
    }, skills: {},
  }, prompts, { workMemoryTools: false, workResourceTools: true, workSkillTools: false });
  let calls = 0;
  const runtime = new WebAgentRuntime({
    tools, prompts, limits: WORK_WEB_AGENT_LIMITS,
    model: { complete: async ({ messages }) => {
      calls += 1;
      if (calls === 1) return { toolCalls: [{ id: "search", name: "resource_search", input: { query: "报告要求" } }] };
      if (calls === 2) return { toolCalls: [{ id: "head", name: "resource_read", input: { filename: "交付要求.md", start: 0 } }] };
      if (calls === 3) {
        const response = messages.find(message => message.toolCallId === "head").content;
        assert.match(response, /同一版本已经在当前上下文中/);
        assert.match(response, /start=120/);
        return { toolCalls: [{ id: "tail", name: "resource_read", input: { filename: "交付要求.md", start: 120 } }] };
      }
      const candidateIds = [...new Set(messages.flatMap(message => [...String(message.content).matchAll(/candidate_id:\s*(candidate_[a-f0-9]+)/g)].map(match => match[1])))];
      return { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds } }] };
    } },
  });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "按要求整理这批实验结果。" });
  assert.deepEqual(result.handoffFragments.map(fragment => fragment.knowledge.content), [head.text, "还需要保留随机种子和失败记录。"]);
});
