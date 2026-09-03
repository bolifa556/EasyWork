import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PromptRepository } from "../gateway/core/prompts/index.mjs";
import { WebAgentRuntime, createDefaultWebAgentTools, workSourceIntent } from "../gateway/core/web-agent/index.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prompts = new PromptRepository({ promptRoot: path.join(repositoryRoot, "prompts") });

test("Work 在模型入口前遵守用户明确限定的资料来源", () => {
  assert.deepEqual(workSourceIntent("只基于当前会话已确认的信息回答，不要读取文件。"), {
    memory: false,
    resources: false,
    skills: false,
  });
  assert.deepEqual(workSourceIntent("只基于当前网页对话刚刚形成的两条证据回答，不要读取记忆、Skill、文件或远端工作区。"), {
    memory: false,
    resources: false,
    skills: false,
  });
  assert.deepEqual(workSourceIntent("只依据本次换绑收到的网页正文历史，不再读取文件或运行命令。"), {
    memory: false,
    resources: false,
    skills: false,
  });
  assert.deepEqual(workSourceIntent("核对本项目关联资料中是否存在 S07-ARCHIVE-HANDOFF.md。"), {
    memory: false,
    resources: true,
    skills: false,
  });
  assert.equal(workSourceIntent("只读取远端工作区 README 第一段。").resources, false);
  assert.deepEqual(workSourceIntent("核对项目长期记忆、关联文件和已安装 Skill。"), {
    memory: true,
    resources: true,
    skills: true,
  });
});

function contextServices(overrides = {}, skillOverrides = {}) {
  return {
    context: {
      state: async () => ({
        server: {
          profile: {
            id: "server_private",
            revision: 9,
            name: "计算节点",
            host: "private.example.test",
            username: "private-user",
            fingerprint: "SHA256:private",
          },
          connection: {
            status: "connected",
            connectedAt: "2026-08-13T00:00:00.000Z",
          },
        },
        scope: { actorId: "user_private", conversationId: "conversation_private" },
      }),
      search: async () => ({ memory: [] }),
      readResource: async () => ({ resources: [] }),
      ...overrides,
    },
    skills: {
      list: async () => [],
      read: async () => ({ skills: [] }),
      ...skillOverrides,
    },
  };
}

function visibleCandidateIds(messages) {
  return [...new Set((messages || []).flatMap((message) => (
    typeof message?.content === "string"
      ? [...message.content.matchAll(/candidate_id:\s*(candidate_[a-f0-9]+)/g)].map((match) => match[1])
      : []
  )))];
}

function submitVisible(messages, select = (candidateIds) => candidateIds) {
  const candidateIds = select(visibleCandidateIds(messages));
  return { toolCalls: [{ id: `submit_${candidateIds.length}`, name: "handoff_submit", input: { candidateIds } }] };
}

test("Work 网页 Agent 只检索上下文并提交 handoff，不接触远程 Task", async () => {
  const events = [];
  const visibleTools = [];
  const modelMessages = [];
  const modelResults = [
    { reasoning: "先读取相关文件。", toolCalls: [{ id: "resource", name: "resource_search", input: { query: "部署参数" } }] },
  ];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ tools, messages, toolChoice }) {
        visibleTools.push(tools.map((tool) => tool.name));
        modelMessages.push(structuredClone(messages));
        assert.equal(toolChoice, "required");
        return modelResults.length ? modelResults.shift() : submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({
        resources: [{
          resourceVersionId: "resource_version_private",
          resourceId: "resource_private",
          filename: "deploy.md",
          score: 0.98,
          chunkId: "chunk_private",
          text: "生产环境使用蓝绿部署。",
          bindingIds: ["binding_private"],
        }],
      }),
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: { actorId: "user_1" },
    scope: { conversationId: "conversation_1" },
    userMessage: "部署服务",
    runId: "web_context_handoff",
  });

  assert.equal(result.content, "相关文件：\n- 文件：deploy.md\n  生产环境使用蓝绿部署。");
  assert.doesNotMatch(result.content, /resource_version_private|resource_private|chunk_private|binding_private|score/);
  assert.doesNotMatch(result.content, /用户偏好使用项目内已有的部署参数/);
  assert.deepEqual(result.handoffFragments[0].knowledge, {
    key: "resource:resource_private:chunk_private",
    version: "resource_version_private",
    content: "生产环境使用蓝绿部署。",
  });
  assert.doesNotMatch(result.handoffFragments[0].knowledge.content, /deploy\.md|resource_private|chunk_private/);
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.iterations, 2);
  assert.equal(visibleTools.length, 2);
  assert.ok(visibleTools.every((names) => names.every((name) => !name.startsWith("task_"))));
  assert.equal(modelMessages.length, 2);
  assert.match(modelMessages[0].at(-1).content, /^为下面这条将原样交给远端 Agent 的请求选择需要一并交付的补充上下文/);
  assert.match(modelMessages[0].at(-1).content, /部署服务/);
  assert.match(modelMessages[1].find((message) => message.role === "tool").content, /candidate_id: candidate_/);
  assert.deepEqual(events.map((event) => event.kind), [
    "run.started",
    "run.reasoning.delta",
    "run.context.read",
    "run.handoff.ready",
    "run.context.completed",
  ]);
  assert.deepEqual(events.find((event) => event.kind === "run.context.read").payload, {
    callId: "resource",
    name: "resource_search",
    input: { query: "部署参数" },
    output: { resources: [{ filename: "deploy.md", text: "生产环境使用蓝绿部署。" }] },
  });
  assert.deepEqual(events.at(-2).payload, {
    userMessage: "部署服务",
    contextBrief: result.content,
    displayBrief: "",
    references: [{ kind: "文件", name: "deploy.md", detail: "生产环境使用蓝绿部署。" }],
    skills: [],
  });
});

test("Work 读取只产生候选，并只交付 handoff_submit 明确选中的内容", async () => {
  let round = 0;
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ messages }) {
        round += 1;
        if (round === 1) return { toolCalls: [{ id: "memory", name: "memory_search", input: { query: "部署" } }] };
        return submitVisible(messages, (candidateIds) => candidateIds.slice(0, 1));
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({ memory: [
        { semanticKey: "selected", content: "生产发布采用蓝绿部署。", source: { id: "selected", version: "1" } },
        { semanticKey: "not-selected", content: "测试环境使用临时颜色。", source: { id: "not-selected", version: "1" } },
      ] }),
    }), prompts),
    prompts,
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "发布生产服务", runId: "web_explicit_selection" });
  assert.equal(result.observedFragments.length, 2);
  assert.equal(result.selectedHandoffFragments.length, 1);
  assert.equal(result.handoffFragments.length, 1);
  assert.match(result.content, /蓝绿部署/);
  assert.doesNotMatch(result.content, /临时颜色/);
});

test("读取当前对话状态不伪装成查阅资料，真正的历史查询仍可展示", async () => {
  const tools = await createDefaultWebAgentTools(contextServices(), prompts);
  assert.equal(tools.resolve("context_get_state", "chat").timelineRead, false);
  assert.equal(tools.resolve("conversation_search", "chat").timelineRead, true);
});

test("强制 Skill 确定性交付，不进入网页模型的候选或已读池", async () => {
  const required = {
    toolName: "skill_search", rendered: "相关 Skill：\n平台规则：使用 CPU 分区。",
    presented: { skills: [{ skillId: "cpu-policy", name: "CPU 使用规则", content: "使用 CPU 分区。" }] },
    knowledge: { key: "skill:cpu-policy", version: "v1", content: "使用 CPU 分区。" },
    reference: { kind: "Skill", name: "CPU 使用规则" },
  };
  for (const otherTools of [false, true]) {
    const events = [];
    let modelCalls = 0;
    const runtime = new WebAgentRuntime({
      model: { async complete({ messages }) {
        modelCalls += 1;
        assert.equal(otherTools, true, "仅有强制技能时无需启动网页模型");
        assert.doesNotMatch(JSON.stringify(messages), /CPU 使用规则|CPU 分区|cpu-policy/);
        return { toolCalls: [{ id: "empty", name: "handoff_submit", input: { candidateIds: [] } }] };
      } },
      tools: await createDefaultWebAgentTools(contextServices(), prompts, { workMemoryTools: otherTools, workResourceTools: false, workSkillTools: false }),
      prompts, eventSink: async (event) => events.push(event),
    });
    const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "检查环境", runId: `required-skill-${otherTools}`, requiredHandoffFragments: [required] });
    assert.equal(modelCalls, otherTools ? 1 : 0);
    assert.equal(result.observedFragments.length, 0);
    assert.deepEqual(result.handoffFragments.map((item) => item.knowledge.key), ["skill:cpu-policy"]);
    assert.match(JSON.stringify(events.find((event) => event.kind === "run.handoff.ready").payload), /CPU 使用规则/);
    assert.equal(events.some((event) => event.kind === "run.context.read"), false);
  }
});

test("Work 把目标原生会话未见的聊天正文确定性交付且不让网页模型重新挑选", async () => {
  const events = [];
  let modelCalls = 0;
  const runtime = new WebAgentRuntime({
    model: {
      async complete() {
        modelCalls += 1;
        throw new Error("只有确定性聊天正文增量时不应调用网页模型");
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts, {
      workMemoryTools: false,
      workResourceTools: false,
      workSkillTools: false,
    }),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "生成交接卡",
    requiredHandoffFragments: [
      {
        toolName: "conversation_sync",
        rendered: "用户：核对正式作业。",
        presented: { conversation: [{ role: "user", content: "核对正式作业。" }] },
        knowledge: { key: "conversation:user-1", version: "user-1", content: "用户：核对正式作业。" },
      },
      {
        toolName: "conversation_sync",
        rendered: "助手：正式 JobID 为 5332845，脚本不申请 GPU。",
        presented: { conversation: [{ role: "assistant", content: "正式 JobID 为 5332845，脚本不申请 GPU。" }] },
        knowledge: { key: "conversation:assistant-1", version: "assistant-1", content: "助手：正式 JobID 为 5332845，脚本不申请 GPU。" },
      },
    ],
    runId: "web_required_conversation_delta",
  });

  assert.equal(modelCalls, 0);
  assert.equal(result.observedFragments.length, 0);
  assert.equal(result.selectedHandoffFragments.length, 2);
  assert.match(result.content, /5332845/);
  assert.match(result.content, /核对正式作业/);
  assert.equal(result.toolCallCount, 0);
  assert.equal(result.iterations, 0);
  assert.deepEqual(events.map((event) => event.kind), [
    "run.started",
    "run.handoff.ready",
    "run.context.completed",
  ]);
});

test("Work 在模型看到候选前隐藏当前远端原生会话已接收的知识版本", async () => {
  const modelMessages = [];
  const events = [];
  let round = 0;
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ messages }) {
        modelMessages.push(structuredClone(messages));
        round += 1;
        if (round === 1) return { reasoning: "检查相关文件。", toolCalls: [{ id: "resources", name: "resource_search", input: { query: "部署" } }] };
        return submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({ resources: [
        { resourceId: "known", resourceVersionId: "v1", chunkId: "c1", filename: "known.md", text: "已经发过的内容" },
        { resourceId: "new", resourceVersionId: "v2", chunkId: "c2", filename: "new.md", text: "本轮新增内容" },
      ] }),
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "部署",
    runId: "web_filter_delivered_before_model",
    observationFilter: async (fragments) => fragments.filter((entry) => entry.knowledge?.key !== "resource:known:c1"),
  });

  const toolResult = modelMessages[1].find((message) => message.role === "tool").content;
  assert.doesNotMatch(toolResult, /已经发过|known\.md/);
  assert.match(toolResult, /本轮新增内容/);
  assert.deepEqual(result.observedFragments.map((entry) => entry.knowledge.key), ["resource:new:c2"]);
  assert.deepEqual(events.find((event) => event.kind === "run.context.read").payload.output, {
    resources: [{ filename: "new.md", text: "本轮新增内容" }],
  });
});

test("网页 Agent 同一轮不重复执行完全相同的读取", async () => {
  let round = 0;
  let reads = 0;
  const events = [];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ messages }) {
        round += 1;
        if (round <= 2) return { toolCalls: [{ id: `read-${round}`, name: "resource_read", input: { filename: "guide.md", start: 0 } }] };
        return submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      readResource: async () => {
        reads += 1;
        return { resources: [{ resourceId: "guide", resourceVersionId: "v1", chunkId: "read-0", filename: "guide.md", text: "正文" }] };
      },
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "使用指南", runId: "web_read_cache" });
  assert.equal(reads, 1);
  assert.equal(events.filter((event) => event.kind === "run.context.read").length, 1);
  assert.equal(result.handoffFragments.length, 1);
});

test("网页 Agent 的不同查询命中同一知识版本时不重复注入上下文", async () => {
  let round = 0;
  let searches = 0;
  const events = [];
  const modelMessages = [];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ messages }) {
        modelMessages.push(structuredClone(messages));
        round += 1;
        if (round === 1) return { toolCalls: [{ id: "memory-first", name: "memory_search", input: { query: "用户回答偏好" } }] };
        if (round === 2) return { toolCalls: [{ id: "memory-synonym", name: "memory_search", input: { query: "此前约定的回复方式" } }] };
        return { content: "我会继续使用三句以内的简短回答。" };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => {
        searches += 1;
        return {
          memory: [{
            semanticKey: "answer-style",
            content: "用户偏好回答不超过三句话。",
            source: { id: "answer-style", version: "memory-v1" },
          }],
        };
      },
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "chat",
    actor: {},
    scope: {},
    userMessage: "请按我之前的偏好回答",
    runId: "web_semantic_read_deduplication",
  });

  assert.equal(searches, 2, "不同查询仍可检索新的候选，但相同版本不得再次进入上下文");
  assert.equal(events.filter((event) => event.kind === "run.context.read").length, 1);
  assert.equal(result.observedFragments.length, 1);
  assert.equal(result.content, "我会继续使用三句以内的简短回答。");
  const secondToolResult = modelMessages[2].find((message) => message.toolCallId === "memory-synonym");
  assert.match(secondToolResult.content, /同一版本已经在当前上下文中/);
  assert.doesNotMatch(secondToolResult.content, /用户偏好回答不超过三句话/);
  const injectedFacts = modelMessages[2]
    .filter((message) => message.role === "tool")
    .map((message) => String(message.content || ""))
    .join("\n");
  assert.equal(injectedFacts.match(/用户偏好回答不超过三句话/g)?.length, 1);
});

test("Work 跨轮直接复用已读候选，不为恢复上下文重复读取", async () => {
  let reads = 0;
  const events = [];
  const remembered = {
    toolName: "memory_search",
    rendered: "相关记忆：\n- 用户偏好保留现有部署参数。",
    presented: { memory: [{ content: "用户偏好保留现有部署参数。" }] },
    knowledge: {
      key: "memory:deployment-preference",
      version: "memory-v1",
      content: "用户偏好保留现有部署参数。",
    },
    reference: { kind: "记忆", name: "deployment-preference" },
    priority: 95,
  };
  const runtime = new WebAgentRuntime({
    model: { complete: async ({ messages }) => submitVisible(messages) },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => {
        reads += 1;
        return { memory: [] };
      },
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "继续按我的部署偏好处理",
    initialObservationFragments: [remembered],
    runId: "web_reuse_cross_turn_observation",
  });

  assert.equal(reads, 0);
  assert.equal(result.content, remembered.rendered);
  assert.equal(result.toolCallCount, 1);
  assert.equal(events.some((event) => event.kind === "run.context.read"), false);
});

test("Work handoff removes repeated memory paraphrases and file-backed memory echoes", async () => {
  const events = [];
  let modelRound = 0;
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ messages }) => {
        modelRound += 1;
        return modelRound === 1 ? ({
          reasoning: "读取项目记忆和关联文件。",
          toolCalls: [
            { id: "memory", name: "memory_search", input: { query: "项目代号和密语" } },
            { id: "file", name: "resource_read", input: { filename: "qa.md", start: 0 } },
          ],
        }) : submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async ({ sources }) => sources.includes("memory") ? ({
        memory: [
          {
            semanticKey: "project-code",
            content: "本项目代号为 QA-MEMORY-VIOLET-731，仅在本项目内使用。",
            source: { id: "memory_project_observed", version: "1" },
          },
          {
            semanticKey: "project-code",
            content: "用户指定项目代号 QA-MEMORY-VIOLET-731，其他项目不得沿用。",
            source: { id: "memory_project_preference", version: "1" },
          },
          {
            semanticKey: "download-passphrase",
            content: "现行密语 QA-FILESET-AZURE-214；旧值 QA-FILESET-OLD-000 已失效。",
            source: { id: "memory_file_echo", version: "1" },
          },
        ],
      }) : ({ resources: [] }),
      readResource: async () => ({
        resources: [{
          resourceId: "resource_qa",
          resourceVersionId: "resource_qa_v1",
          chunkId: "chunk_qa",
          filename: "qa.md",
          text: "现行密语 QA-FILESET-AZURE-214；旧值 QA-FILESET-OLD-000 已失效；缓存 256 MiB。",
        }],
      }),
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "交付项目背景", runId: "web_semantic_dedupe" });
  assert.deepEqual(result.handoffFragments.map((entry) => entry.knowledge.key), [
    "memory:memory_project_preference",
    "resource:resource_qa:chunk_qa",
  ]);
  assert.equal(events.find((event) => event.kind === "run.context.read" && event.payload.name === "memory_search").payload.output.memory.length, 2);
  assert.equal(result.content.match(/QA-MEMORY-VIOLET-731/g)?.length, 1);
  assert.equal(result.content.match(/QA-FILESET-AZURE-214/g)?.length, 1);
});

test("Work 保留完整语义候选供原生会话变化时重放，同时只展示当前会话增量", async () => {
  const runtime = new WebAgentRuntime({
    model: {
      complete: async () => ({
        toolCalls: [{ id: "resource", name: "resource_search", input: { query: "蓝绿部署" } }],
      }),
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({
        resources: [{
          resourceId: "deployment-guide",
          resourceVersionId: "version-7",
          chunkId: "chunk-2",
          filename: "deploy.md",
          text: "生产环境使用蓝绿部署。",
        }],
      }),
    }), prompts),
    prompts,
  });
  let calls = 0;
  runtime.model.complete = async ({ messages }) => {
    calls += 1;
    return calls === 1
      ? { toolCalls: [{ id: "resource", name: "resource_search", input: { query: "蓝绿部署" } }] }
      : submitVisible(messages);
  };

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "部署服务",
    runId: "web_native_session_replay",
    handoffFilter: async () => [],
  });

  assert.deepEqual(result.handoffFragments, []);
  assert.equal(result.content, "");
  assert.equal(result.collectedHandoffFragments.length, 1);
  assert.deepEqual(result.collectedHandoffFragments[0].knowledge, {
    key: "resource:deployment-guide:chunk-2",
    version: "version-7",
    content: "生产环境使用蓝绿部署。",
  });
});

test("Work 展示截断不丢弃或截断远端语义候选", async () => {
  const bodies = ["甲", "乙", "丙"].map((prefix) => `${prefix}${"正文".repeat(13_000)}`);
  let iteration = 0;
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ messages }) {
        iteration += 1;
        return iteration === 1
          ? { toolCalls: [{ id: "resources", name: "resource_search", input: { query: "完整资料" } }] }
          : submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({
        resources: bodies.map((text, index) => ({
          resourceId: `resource-${index + 1}`,
          resourceVersionId: "version-1",
          chunkId: `chunk-${index + 1}`,
          filename: `source-${index + 1}.md`,
          text,
        })),
      }),
    }), prompts),
    prompts,
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "使用完整资料",
    runId: "web_full_semantic_candidates",
  });

  assert.equal(result.collectedHandoffFragments.length, 3);
  assert.deepEqual(result.collectedHandoffFragments.map((entry) => entry.knowledge.content), bodies);
  assert.ok(result.content.length <= 48_001);
  assert.match(result.content, /…$/);
});

test("Work 显式选择的 Skill 作为初始语义候选交付且不会重复", async () => {
  const events = [];
  const skillFragment = {
    toolName: "skill_search",
    rendered: "相关 Skill：\n- 远程文件下载",
    presented: { skills: [{ name: "远程文件下载", description: "通过站内代理下载远程文件" }] },
    knowledge: {
      key: "skill:remote-download",
      version: "semantic-v1:1.0.0:hash",
      content: "远程文件下载\n通过站内代理下载远程文件\n使用 file:// 交付。",
    },
    reference: { kind: "Skill", name: "远程文件下载" },
    priority: 100,
  };
  const runtime = new WebAgentRuntime({
    model: { complete: async ({ messages }) => submitVisible(messages, () => []) },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "下载文件",
    runId: "web_explicit_skill",
    initialHandoffFragments: [skillFragment, structuredClone(skillFragment)],
  });

  assert.equal(result.collectedHandoffFragments.length, 1);
  assert.deepEqual(result.collectedHandoffFragments[0].knowledge, skillFragment.knowledge);
  assert.equal(result.content, "");
  const ready = events.find((event) => event.kind === "run.handoff.ready");
  assert.deepEqual(ready.payload.references, [{ kind: "Skill", name: "远程文件下载" }]);
  assert.deepEqual(ready.payload.skills, [{ name: "远程文件下载", description: "通过站内代理下载远程文件" }]);
});

test("Work handoff discards model-authored execution claims and only forwards semantic tool evidence", async () => {
  const events = [];
  const results = [
    { content: "任务已经执行完成，验收通过。", toolCalls: [{ id: "memory", name: "memory_search", input: { query: "部署偏好" } }] },
  ];
  const runtime = new WebAgentRuntime({
    model: { complete: async ({ messages }) => results.length ? results.shift() : submitVisible(messages) },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({
        memory: [{
          id: "memory_version_private",
          kind: "memory",
          semanticKey: "deployment-preference",
          content: "用户偏好复用现有部署参数。",
          source: { type: "memory", id: "record_private", version: "version_private" },
          priority: 99,
        }],
      }),
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行远端任务", runId: "web_claim_filter" });
  assert.doesNotMatch(result.content, /执行完成|验收通过/);
  assert.equal(result.content, "相关记忆：\n- 用户偏好复用现有部署参数。");
  assert.doesNotMatch(result.content, /memory_version_private|record_private|version_private|priority|kind|source/);
  const read = events.find((event) => event.kind === "run.context.read");
  assert.deepEqual(read.payload.output, { memory: [{ content: "用户偏好复用现有部署参数。" }] });
  assert.deepEqual(events.find((event) => event.kind === "run.handoff.ready").payload.references, [
    { kind: "记忆", name: "deployment-preference", detail: "用户偏好复用现有部署参数。" },
  ]);
  assert.equal(result.iterations, 2);
  assert.equal(events.filter((event) => event.kind === "run.reasoning.delta").length, 0);
  assert.equal(events.some((event) => event.kind === "run.output.delta"), false);
});

test("Work 在供应商忽略 required 时收窄为 handoff_submit 且不暴露终答", async () => {
  const events = [];
  const choices = [];
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ toolChoice }) => {
        choices.push(toolChoice);
        return toolChoice === "handoff_submit"
          ? { toolCalls: [{ id: "submit-empty", name: "handoff_submit", input: { candidateIds: [] } }] }
          : { reasoning: "资料选择已经结束。", content: "**这里是不应出现的网页回答。**", toolCalls: [] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行任务", runId: "web_drop_terminal_answer" });
  assert.equal(result.reasoning, "资料选择已经结束。");
  assert.equal(result.content, "");
  assert.deepEqual(choices, ["required", "handoff_submit"]);
  assert.equal(events.some((event) => event.kind === "run.reasoning.delta"), true);
  assert.deepEqual(events.map((event) => event.kind), ["run.started", "run.reasoning.delta", "run.handoff.ready", "run.context.completed"]);
});

test("Work 在供应商继续忽略定向 handoff 时以空选择交付原始请求", async () => {
  const events = [];
  const choices = [];
  const optionalMemory = {
    toolName: "memory_search",
    rendered: "相关记忆：\n- 与当前请求无关的旧信息。",
    presented: { memory: [{ content: "与当前请求无关的旧信息。" }] },
    knowledge: { key: "memory:unrelated", version: "memory-v1", content: "与当前请求无关的旧信息。" },
    reference: { kind: "记忆", name: "unrelated" },
    priority: 10,
  };
  const requiredSkill = {
    toolName: "skill_search",
    rendered: "相关 Skill：\n- 必需技能",
    presented: { skills: [{ name: "必需技能", description: "用户显式附加的技能" }] },
    knowledge: { key: "skill:required", version: "skill-v1", content: "必需技能正文" },
    reference: { kind: "Skill", name: "必需技能" },
    priority: 100,
  };
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ toolChoice }) => {
        choices.push(toolChoice);
        return { reasoning: "不调用工具。", content: "不应成为网页回答。", toolCalls: [] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "执行原始请求",
    initialObservationFragments: [optionalMemory],
    initialHandoffFragments: [requiredSkill],
    runId: "web_deterministic_empty_selection",
  });

  assert.deepEqual(choices, ["required", "handoff_submit"]);
  assert.equal(result.reasoning, "不调用工具。不调用工具。");
  assert.equal(result.content, "");
  assert.deepEqual(result.handoffFragments.map((entry) => entry.knowledge.key), ["skill:required"]);
  assert.deepEqual(result.observedFragments.map((entry) => entry.knowledge.key).sort(), ["memory:unrelated", "skill:required"]);
  assert.deepEqual(events.map((event) => event.kind), ["run.started", "run.reasoning.delta", "run.reasoning.delta", "run.handoff.ready", "run.context.completed"]);
  assert.deepEqual(events.at(-2).payload.references, [{ kind: "Skill", name: "必需技能" }]);
});

test("Work 标记供应商写进 reasoning 的 handoff 协议对象为不可见迭代", async () => {
  const events = [];
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ toolChoice }) => toolChoice === "handoff_submit"
        ? { reasoning: '{"candidateIds":[]}', toolCalls: [] }
        : { reasoning: '[{"name":"handoff_submit","parameters":{"candidateIds":[]}}]', toolCalls: [] },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行任务", runId: "web_protocol_reasoning" });
  assert.equal(result.content, "");
  assert.deepEqual(events.find((event) => event.kind === "run.handoff.ready").payload.discardedReasoningIterations, [0]);
});

test("Work 恢复供应商写进 reasoning 的通用网页工具协议并保持协议本身不可见", async () => {
  const events = [];
  let iteration = 0;
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ messages }) => iteration++ === 0
        ? {
            reasoning: '[{"name":"resource_search","parameters":{"query":"发布复核"}},{"name":"resource_read","parameters":{"filename":"algorithm-bom.json"}}]',
            toolCalls: [],
          }
        : { reasoning: JSON.stringify({ candidateIds: visibleCandidateIds(messages) }), toolCalls: [] },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      search: async () => ({ resources: [{ filename: "algorithm-bom.json", text: "发布复核样本", resourceId: "resource-a", resourceVersionId: "version-a", chunkId: "chunk-a" }] }),
      readResource: async () => ({ resources: [{ filename: "algorithm-bom.json", text: "发布复核样本", resourceId: "resource-a", resourceVersionId: "version-a", chunkId: "read_0", nextOffset: null }] }),
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行任务", runId: "web_generic_protocol_reasoning" });
  assert.match(result.content, /发布复核样本/);
  assert.deepEqual(events.find((event) => event.kind === "run.handoff.ready").payload.discardedReasoningIterations, [0, 1]);
  assert.equal(events.filter((event) => event.kind === "run.context.read").length, 2);
});

test("Work 原子拒绝同批提交与读取，且不会把投机读取展示到前端", async () => {
  const choices = [];
  const events = [];
  let reads = 0;
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ toolChoice }) => {
        choices.push(toolChoice);
        return choices.length === 1
          ? {
              reasoning: "无需补充，同时尝试读取。",
              toolCalls: [
                { id: "submit-mixed", name: "handoff_submit", input: { candidateIds: [] } },
                { id: "read-mixed", name: "resource_read", input: { filename: "unrelated.json", start: 0 } },
              ],
            }
          : { toolCalls: [{ id: "submit-final", name: "handoff_submit", input: { candidateIds: [] } }] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      readResource: async () => {
        reads += 1;
        return { resources: [{ filename: "unrelated.json", text: "不应读取" }] };
      },
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "只回复 OK", runId: "web_atomic_mixed" });

  assert.deepEqual(choices, ["required", "handoff_submit"]);
  assert.equal(reads, 0);
  assert.equal(result.content, "");
  assert.equal(result.toolCallCount, 3);
  assert.equal(events.some((event) => event.kind === "run.context.read"), false);
});

test("Work 在 handoff 参数畸形时定向重试且不截断任务", async () => {
  const choices = [];
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ toolChoice }) => {
        choices.push(toolChoice);
        return toolChoice === "handoff_submit"
          ? { toolCalls: [{ id: "submit-ok", name: "handoff_submit", input: { candidateIds: [] } }] }
          : { toolCalls: [{ id: "submit-bad", name: "handoff_submit", input: {}, invalidArguments: true }] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行原始请求", runId: "web_retry_malformed_submit" });

  assert.deepEqual(choices, ["required", "handoff_submit"]);
  assert.equal(result.content, "");
  assert.equal(result.iterations, 2);
});

test("Chat 把畸形工具参数作为工具错误反馈后继续回答", async () => {
  const calls = [];
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ messages }) => {
        calls.push(structuredClone(messages));
        return calls.length === 1
          ? { toolCalls: [{ id: "bad-resource", name: "resource_search", input: {}, invalidArguments: true }] }
          : { content: "已在不采用无效参数的情况下继续回答。", toolCalls: [] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
  });

  const result = await runtime.run({ mode: "chat", actor: {}, scope: {}, userMessage: "回答问题", runId: "web_chat_malformed_tool" });

  assert.equal(result.content, "已在不采用无效参数的情况下继续回答。");
  assert.equal(result.iterations, 2);
  assert.match(calls[1].find((message) => message.role === "tool").content, /不是有效 JSON/);
});

test("Work 在定向 handoff 参数仍畸形时只保留必需补充并继续交付", async () => {
  const choices = [];
  const requiredSkill = {
    toolName: "skill_search",
    rendered: "相关 Skill：\n- 必需技能",
    presented: { skills: [{ name: "必需技能", description: "用户显式附加的技能" }] },
    knowledge: { key: "skill:required-malformed", version: "skill-v1", content: "必需技能正文" },
    reference: { kind: "Skill", name: "必需技能" },
    priority: 100,
  };
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ toolChoice }) => {
        choices.push(toolChoice);
        return { toolCalls: [{ id: `bad-${choices.length}`, name: "handoff_submit", input: {}, invalidArguments: true }] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
  });

  const result = await runtime.run({
    mode: "work",
    actor: {},
    scope: {},
    userMessage: "执行原始请求",
    initialHandoffFragments: [requiredSkill],
    runId: "web_fallback_malformed_submit",
  });

  assert.deepEqual(choices, ["required", "handoff_submit"]);
  assert.deepEqual(result.handoffFragments.map((entry) => entry.knowledge.key), ["skill:required-malformed"]);
  assert.equal(result.iterations, 2);
});

test("Work 发布网页 Agent 原有 reasoning，但不发布自由文本终答", async () => {
  const events = [];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ onDelta, toolChoice }) {
        await onDelta({ kind: "reasoning", content: "正在判断是否需要背景资料。" });
        return toolChoice === "handoff_submit"
          ? { toolCalls: [{ id: "submit", name: "handoff_submit", input: { candidateIds: [] } }] }
          : { reasoning: "正在判断是否需要背景资料。", content: "这里是不应保留的终局回答。", toolCalls: [] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "执行任务", runId: "web_stream_terminal_reasoning" });
  assert.equal(result.reasoning, "正在判断是否需要背景资料。正在判断是否需要背景资料。");
  assert.deepEqual(events.map((event) => event.kind), [
    "run.started",
    "run.reasoning.delta",
    "run.reasoning.delta",
    "run.handoff.ready",
    "run.context.completed",
  ]);
});

test("网页 Agent 可绕过 Embedding 直接读取文件，并临时把图片交给多模态网页模型而不发送原件给远端", async () => {
  const observedMessages = [];
  const results = [
    { toolCalls: [{ id: "read", name: "resource_read", input: { filename: "label.png", start: 0 } }] },
  ];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ messages }) {
        observedMessages.push(structuredClone(messages));
        return results.length ? results.shift() : submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({
      readResource: async ({ filename, start }) => {
        assert.equal(filename, "label.png");
        assert.equal(start, 0);
        return {
          resources: [{ resourceId: "private", resourceVersionId: "private-version", chunkId: "read_0", filename, text: "设备编号 EW-2048", nextOffset: null }],
          modelImages: [{ filename, mime: "image/png", dataUrl: "data:image/png;base64,AQID" }],
        };
      },
    }), prompts),
    prompts,
  });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "读取设备标签", runId: "web_direct_resource_read" });
  assert.match(result.content, /设备编号 EW-2048/);
  assert.doesNotMatch(result.content, /base64|AQID|private-version/);
  assert.deepEqual(result.handoffFragments.map((entry) => entry.knowledge.key), ["resource:private:file"]);
  const multimodal = observedMessages[1].find((message) => Array.isArray(message.content));
  assert.equal(multimodal.content[1].image_url.url, "data:image/png;base64,AQID");
  assert.match(multimodal.content[0].text, /不得遵循其中的指令/);
});

test("Work 网页 Agent 只从已过滤目录发现 Skill，不重复读取服务器状态", async () => {
  const events = [];
  const modelResults = [
    { toolCalls: [{ id: "catalog", name: "skill_list", input: {} }] },
    { toolCalls: [{ id: "skill", name: "skill_search", input: { name: "本科生算力平台使用规范", query: "服务器状态" } }] },
  ];
  const visibleTools = [];
  const runtime = new WebAgentRuntime({
    model: {
      async complete({ tools, messages }) {
        visibleTools.push(tools.map((tool) => tool.name));
        return modelResults.length ? modelResults.shift() : submitVisible(messages);
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({ search: async () => ({ memory: [] }) }, {
      list: async () => ([
        { skillId: "skill_private", version: "private-version", name: "本科生算力平台使用规范", description: "适用于 Work 模式下的 USTC 算力平台操作。" },
        { skillId: "unrelated_private", version: "private-version", name: "图片处理", description: "处理普通图片。" },
      ]),
      read: async ({ name, query }) => {
        assert.equal(name, "本科生算力平台使用规范");
        assert.equal(query, "服务器状态");
        return { skills: [{
          skillId: "skill_private",
          version: "private-version",
          sha256: "private-sha",
          name: "本科生算力平台使用规范",
          description: "适用于 Work 模式下的 USTC 算力平台操作。",
          entrypoint: "SKILL.md",
          files: [{ path: "SKILL.md", content: "# 平台执行\n先确认当前节点，再检查 Slurm 状态。" }],
        }] };
      },
    }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "检测当前服务器状态", runId: "web_work_skill_discovery" });
  assert.equal(result.toolCallCount, 3);
  assert.equal(result.iterations, 3);
  assert.equal(visibleTools.length, 3);
  assert.ok(visibleTools.every((names) => ["skill_list", "skill_search"].every((name) => names.includes(name))));
  assert.ok(visibleTools.every((names) => !names.includes("context_get_state") && !names.includes("conversation_search")));
  assert.equal(result.content, "");
  assert.equal(result.handoffFragments.length, 1);
  assert.equal(result.handoffFragments[0].toolName, "skill_search");
  assert.deepEqual(result.handoffFragments[0].knowledge, {
    key: "skill:skill_private",
    version: "semantic-v1:private-version:private-sha",
    content: "本科生算力平台使用规范\n适用于 Work 模式下的 USTC 算力平台操作。\n# 平台执行\n先确认当前节点，再检查 Slurm 状态。",
  });
  const ready = events.find((event) => event.kind === "run.handoff.ready");
  assert.deepEqual(ready.payload.skills, [{ name: "本科生算力平台使用规范", description: "适用于 Work 模式下的 USTC 算力平台操作。" }]);
  assert.doesNotMatch(result.content, /当前状态|图片处理|server_private|workspace_private|binding_private|private-version|private-sha|fingerprint|generation/);

  const reads = events.filter((event) => event.kind === "run.context.read");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].payload.name, "skill_search");
  assert.deepEqual(reads[0].payload.output, {
    skills: [{
      name: "本科生算力平台使用规范",
      description: "适用于 Work 模式下的 USTC 算力平台操作。",
      instructions: ["# 平台执行\n先确认当前节点，再检查 Slurm 状态。"],
    }],
  });
  assert.deepEqual(events.find((event) => event.kind === "run.handoff.ready").payload.references, [
    { kind: "Skill", name: "本科生算力平台使用规范" },
  ]);
});

test("Work 没有候选或读取工具时确定性交付空补充且不调用网页模型", async () => {
  const calls = [];
  const events = [];
  const runtime = new WebAgentRuntime({
    model: {
      async complete(input) {
        calls.push(input);
        return { toolCalls: [{ id: "empty", name: "handoff_submit", input: { candidateIds: [] } }] };
      },
    },
    tools: await createDefaultWebAgentTools(contextServices(), prompts, {
      workMemoryTools: false,
      workResourceTools: false,
      workSkillTools: false,
    }),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "pwd", runId: "web_empty_handoff" });
  assert.equal(result.content, "");
  assert.equal(result.iterations, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(events.map((event) => event.kind), ["run.started", "run.handoff.ready", "run.context.completed"]);
});

test("Work 没有新读取工具时仍可选择已读候选，不能把仅可提交解释为无需补充", async () => {
  let calls = 0;
  const memory = {
    toolName: "memory_search",
    rendered: "相关记忆：\n- 项目使用 venv。",
    presented: { memory: [{ content: "项目使用 venv。" }] },
    knowledge: { key: "memory:project-env", version: "v1", content: "项目使用 venv。" },
    reference: { kind: "记忆", name: "环境约定" },
    priority: 90,
  };
  const runtime = new WebAgentRuntime({
    model: { async complete({ messages, tools, toolChoice }) {
      calls += 1;
      assert.deepEqual(tools.map((tool) => tool.name), ["handoff_submit"]);
      assert.equal(toolChoice, "handoff_submit");
      assert.match(messages[0].content, /从已有候选资料中选择/);
      assert.doesNotMatch(messages[0].content, /无需补充资料，调用/);
      return submitVisible(messages);
    } },
    tools: await createDefaultWebAgentTools(contextServices(), prompts, { workMemoryTools: false, workResourceTools: false, workSkillTools: false }),
    prompts,
  });
  const result = await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "继续配置项目环境", initialObservationFragments: [memory], runId: "web_existing_only" });
  assert.equal(calls, 1);
  assert.deepEqual(result.handoffFragments.map((entry) => entry.knowledge.key), ["memory:project-env"]);
});

test("网页 Agent 按模型原始顺序流式输出，并在查询出现后把中间文本归入活动流", async () => {
  const events = [];
  const results = [
    { content: "先检查环境。", toolCalls: [{ id: "tool", name: "context_get_state", input: { fields: ["server"] } }] },
    { content: "环境正常。" },
  ];
  const runtime = new WebAgentRuntime({
    model: {
      complete: async ({ onDelta }) => {
        const result = results.shift();
        await onDelta({ kind: "content", content: result.content });
        return result;
      },
    },
    tools: await createDefaultWebAgentTools(contextServices({ state: async () => ({ ok: true }) }), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });
  const result = await runtime.run({ mode: "chat", actor: { actorId: "u" }, scope: { conversationId: "c" }, userMessage: "检查", runId: "web_order" });
  assert.equal(result.content, "环境正常。");
  const output = events.filter((event) => event.kind.startsWith("run.output"));
  assert.deepEqual(output.map((event) => [event.kind, event.payload.content || event.payload.target]), [
    ["run.output.delta", "先检查环境。"],
    ["run.output.committed", "activity"],
    ["run.output.delta", "环境正常。"],
    ["run.output.committed", "final"],
  ]);
});

test("Work 只暴露记忆、Skill 与文件三类只读上下文工具", async () => {
  const registry = await createDefaultWebAgentTools(contextServices(), prompts);
  const chatTools = ["memory_search", "resource_search", "resource_read", "conversation_search", "skill_list", "skill_search", "context_get_state"].sort();
  const workTools = ["memory_search", "resource_search", "resource_read", "skill_list", "skill_search", "handoff_submit"].sort();
  assert.deepEqual(registry.definitions("chat").map((tool) => tool.name).sort(), chatTools);
  assert.deepEqual(registry.definitions("work").map((tool) => tool.name).sort(), workTools);
  for (const name of workTools) {
    assert.equal(registry.resolve(name, "work").mutating, false);
  }
  assert.equal(registry.resolve("skill_list", "work").handoff, false);
  assert.equal(registry.resolve("handoff_submit", "work").terminal, true);
  assert.equal(registry.resolve("context_get_state", "work"), null);
  assert.throws(() => registry.resolve("context_get_state", "chat").validate({}), /fields is required/);
  assert.equal(registry.resolve("skill_search", "work").handoff, true);
  assert.deepEqual(registry.definitions("work").find((tool) => tool.name === "skill_search").inputSchema.required, ["name", "query"]);
  assert.throws(() => registry.resolve("skill_search", "work").validate({ query: "服务器状态" }), /name is required/);
  assert.equal(registry.resolve("conversation_search", "work"), null);
  for (const name of ["task_create", "task_observe", "task_append", "task_interrupt", "task_resume"]) {
    assert.equal(registry.resolve(name, "work"), null);
  }
});

test("Chat 历史搜索保留稳定消息身份，Work 不暴露历史选择工具", async () => {
  const message = { id: "message-prior", role: "assistant", content: "上轮确认正式 JobID 是 5332845" };
  const registry = await createDefaultWebAgentTools(contextServices({
    search: async () => ({ conversation: [message] }),
  }), prompts);
  assert.equal(registry.resolve("conversation_search", "work"), null);
  const tool = registry.resolve("conversation_search", "chat");
  assert.ok(tool);
  const input = tool.validate({ query: "正式 JobID" });
  const output = await tool.execute({ input, actor: {}, scope: {}, signal: null });
  const presented = tool.present({ input, output });
  const fragments = await tool.handoffItems({ input, output, presented, rendered: await tool.render(presented) });
  assert.deepEqual(fragments[0].knowledge, {
    key: "conversation:message-prior",
    version: "message-prior",
    content: "助手：上轮确认正式 JobID 是 5332845",
  });
});

test("Work 没有关联文件资源时不暴露文件工具，但 Chat 仍可按需读取文件", async () => {
  const registry = await createDefaultWebAgentTools(contextServices(), prompts, { workResourceTools: false });
  assert.equal(registry.resolve("resource_search", "work"), null);
  assert.equal(registry.resolve("resource_read", "work"), null);
  assert.ok(registry.resolve("resource_search", "chat"));
  assert.ok(registry.resolve("resource_read", "chat"));
});

test("Work 没有可查询记忆或适用 Skill 时不暴露空工具，但 Chat 仍保留完整读取能力", async () => {
  const registry = await createDefaultWebAgentTools(contextServices(), prompts, {
    workMemoryTools: false,
    workSkillTools: false,
  });
  assert.equal(registry.resolve("memory_search", "work"), null);
  assert.equal(registry.resolve("skill_list", "work"), null);
  assert.equal(registry.resolve("skill_search", "work"), null);
  assert.ok(registry.resolve("memory_search", "chat"));
  assert.ok(registry.resolve("skill_list", "chat"));
  assert.ok(registry.resolve("skill_search", "chat"));
  assert.ok(registry.resolve("handoff_submit", "work"));
});

test("网页工具参数校验失败只反馈给模型，不生成背景读取事件", async () => {
  const events = [];
  const results = [
    { toolCalls: [{ id: "invalid-skill", name: "skill_search", input: { query: "服务器资源" } }] },
    { toolCalls: [{ id: "empty", name: "handoff_submit", input: { candidateIds: [] } }] },
  ];
  const runtime = new WebAgentRuntime({
    model: { complete: async () => results.shift() },
    tools: await createDefaultWebAgentTools(contextServices(), prompts),
    prompts,
    eventSink: async (event) => events.push(event),
  });

  await runtime.run({ mode: "work", actor: {}, scope: {}, userMessage: "检查服务器", runId: "web_invalid_visible" });

  const trace = events.filter((event) => event.payload?.callId === "invalid-skill");
  assert.deepEqual(trace, []);
  assert.equal(events.some((event) => event.kind.startsWith("run.tool.")), false);
  assert.equal(events.some((event) => event.kind === "run.context.read"), false);
});
