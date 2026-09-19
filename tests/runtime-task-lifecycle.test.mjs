import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteTaskLifecycle,
  conversationCompactionBatch,
  relevantConversationMessages,
  settledConversationHistory,
  workConversationState,
  workConversationTranscriptFragments,
} from "../gateway/core/runtime/services.mjs";

const scope = Object.freeze({
  conversationId: "conversation-resume",
  serverId: "server-resume",
  serverIdentity: "identity-resume",
  workspaceId: "workspace-resume",
  agentId: "opencode",
});

const prompts = {
  async conversationMessage(role, content) {
    return `${role}:${content}`;
  },
  async remoteTask({ userMessage }) {
    return userMessage;
  },
};

test("连续用户 reply edge 不会把启动前已取消的旧提问当作有效追加重新交接", async () => {
  const history = [
    { id: "initial", role: "user", content: "原任务" },
    { id: "append", role: "user", content: "有效追加", replyToMessageId: "initial" },
    { id: "answer", role: "assistant", content: "已完成", replyToMessageId: "append" },
    { id: "cancelled", role: "user", content: "可以，按这套配置部署一下，然后你可以从网上下个pdb文件和", replyToMessageId: "answer" },
    { id: "corrected", role: "user", content: "完整的新提问", replyToMessageId: "cancelled" },
    { id: "final", role: "assistant", content: "结果", replyToMessageId: "corrected" },
    { id: "current", role: "user", content: "继续", replyToMessageId: "final" },
  ];
  const fragments = await workConversationTranscriptFragments(history, "current", prompts, { tasks: [
    { sourceMessageId: "initial", status: "interrupted", startedAt: "2026-09-05T00:00:00Z" },
    { sourceMessageId: "cancelled", status: "interrupted", startedAt: null },
  ] });
  assert.deepEqual(fragments.map((item) => item.knowledge.key), ["conversation:initial", "conversation:append", "conversation:answer", "conversation:corrected", "conversation:final"]);
});

test("网页模型可看见失败请求，但远端重建只采用已结算对话", () => {
  const history = [
    { id: "user-1", role: "user", content: "第一问" },
    { id: "assistant-1", role: "assistant", content: "第一答", replyToMessageId: "user-1" },
    { id: "user-failed-1", role: "user", content: "第一次失败请求" },
    { id: "user-2", role: "user", content: "第二次改写后的请求" },
    { id: "assistant-2", role: "assistant", content: "第二答", replyToMessageId: "user-2" },
    { id: "user-failed-2", role: "user", content: "后来又失败的请求" },
    { id: "user-current", role: "user", content: "当前重试请求" },
  ];
  assert.deepEqual(
    settledConversationHistory(history, "user-current", { retainTrailingUsers: true }).map((entry) => entry.id),
    ["user-1", "assistant-1", "user-failed-1", "user-2", "assistant-2", "user-failed-2"],
  );
  assert.deepEqual(
    settledConversationHistory(history, "user-current").map((entry) => entry.id),
    ["user-1", "assistant-1", "user-2", "assistant-2"],
  );
});

test("Work 网页 Agent 保留用户提问、正文回答和后续纠正以理解追问", () => {
  const history = [
    { id: "checkpoint", role: "system", content: "对话检查点" },
    { id: "user-1", role: "user", content: "开始检查上传链路" },
    { id: "assistant-1", role: "assistant", content: "上传链路把 CRLF 归一化成了 LF", replyToMessageId: "user-1" },
    { id: "user-2", role: "user", content: "纠正：上游 raw blob 本来就是 LF，不是上传损坏" },
    { id: "assistant-2", role: "assistant", content: "收到纠正", replyToMessageId: "user-2" },
    { id: "user-failed", role: "user", content: "中途补充的有效用户约束" },
    { id: "user-current", role: "user", content: "继续第二批" },
  ];

  assert.deepEqual(workConversationState(history, "user-current").map((entry) => entry.id), [
    "checkpoint",
    "user-1",
    "assistant-1",
    "user-2",
    "assistant-2",
    "user-failed",
  ]);
  assert.equal(workConversationState(history, "user-current").some((entry) => entry.content.includes("上传链路把")), true);
});

test("Work 远端聊天记忆包含全部已完成提问与正文回复，不包含系统、失败请求和当前提问", async () => {
  const history = [
    { id: "checkpoint", role: "system", content: "对话检查点与思考摘要" },
    { id: "user-1", role: "user", content: "第一问" },
    { id: "assistant-1", role: "assistant", content: "第一答", replyToMessageId: "user-1" },
    { id: "user-failed", role: "user", content: "没有正文回复的失败请求" },
    { id: "user-2", role: "user", content: "第二问" },
    { id: "assistant-2", role: "assistant", content: "第二答", replyToMessageId: "user-2" },
    { id: "user-current", role: "user", content: "当前新请求" },
  ];

  const fragments = await workConversationTranscriptFragments(history, "user-current", prompts);
  assert.deepEqual(fragments.map((entry) => entry.knowledge.key), [
    "conversation:user-1",
    "conversation:assistant-1",
    "conversation:user-2",
    "conversation:assistant-2",
  ]);
  assert.deepEqual(fragments.map((entry) => entry.knowledge.content), [
    "user:第一问",
    "assistant:第一答",
    "user:第二问",
    "assistant:第二答",
  ]);
  assert.ok(fragments.every((entry) => entry.required === true && entry.toolName === "conversation_sync"));
});

test("Work 远端聊天记忆保留一次原生调用中的初始提问与全部中途追加", async () => {
  const history = [
    { id: "previous-user", role: "user", content: "上一轮提问" },
    { id: "previous-assistant", role: "assistant", content: "上一轮正文回复", replyToMessageId: "previous-user" },
    { id: "initial-user", role: "user", content: "本轮初始提问", replyToMessageId: "previous-assistant" },
    { id: "append-user-1", role: "user", content: "中途补充一", replyToMessageId: "initial-user" },
    { id: "append-user-2", role: "user", content: "中途补充二", replyToMessageId: "append-user-1" },
    { id: "assistant-final", role: "assistant", content: "本轮正文回复", replyToMessageId: "append-user-2" },
    { id: "user-current", role: "user", content: "换绑后的当前提问", replyToMessageId: "assistant-final" },
  ];

  const fragments = await workConversationTranscriptFragments(history, "user-current", prompts);
  assert.deepEqual(fragments.map((entry) => entry.knowledge.key), [
    "conversation:previous-user",
    "conversation:previous-assistant",
    "conversation:initial-user",
    "conversation:append-user-1",
    "conversation:append-user-2",
    "conversation:assistant-final",
  ]);
  assert.deepEqual(fragments.map((entry) => entry.knowledge.content), [
    "user:上一轮提问",
    "assistant:上一轮正文回复",
    "user:本轮初始提问",
    "user:中途补充一",
    "user:中途补充二",
    "assistant:本轮正文回复",
  ]);
});

test("助手历史按其回复的用户请求参与相关性排序，并可只返回助手证据", () => {
  const history = [
    { id: "codex-user", role: "user", content: "请让 Codex 检查正式作业" },
    { id: "codex-answer", role: "assistant", replyToMessageId: "codex-user", content: "JobID 5332845，未申请 GPU。" },
    { id: "claude-user", role: "user", content: "请让 Claude Code 做 S07 五项参数只读复核" },
    { id: "claude-answer", role: "assistant", replyToMessageId: "claude-user", content: "五项参数已经核对完成。" },
  ];
  assert.deepEqual(relevantConversationMessages(history, {
    query: "依据此前 Claude Code 的 S07 五项参数复核结果",
    roles: ["assistant"],
    limit: 1,
  }).map((entry) => entry.id), ["claude-answer"]);
});

test("上下文压缩不拆开问答，也不把失败请求写进摘要", () => {
  const history = [
    { id: "user-1", role: "user", content: "第一问" },
    { id: "user-failed", role: "user", content: "没有得到回答的请求" },
    { id: "assistant-1", role: "assistant", content: "第一答", replyToMessageId: "user-1" },
    { id: "user-2", role: "user", content: "第二问" },
    { id: "assistant-2", role: "assistant", content: "第二答", replyToMessageId: "user-2" },
    { id: "user-3", role: "user", content: "第三问" },
    { id: "assistant-3", role: "assistant", content: "第三答", replyToMessageId: "user-3" },
  ];
  const batch = conversationCompactionBatch(history, 2);
  assert.deepEqual(batch.covered.map((entry) => entry.id), ["user-1", "user-failed", "assistant-1", "user-2", "assistant-2"]);
  assert.deepEqual(batch.summarized.map((entry) => entry.id), ["user-1", "assistant-1", "user-2", "assistant-2"]);
});

test("上下文压缩在保留侧回答旧请求时向前移动边界", () => {
  const history = [
    { id: "user-1", role: "user", content: "第一问" },
    { id: "user-failed", role: "user", content: "失败请求" },
    { id: "assistant-1", role: "assistant", content: "第一答", replyToMessageId: "user-1" },
    { id: "user-2", role: "user", content: "第二问" },
    { id: "assistant-2", role: "assistant", content: "第二答", replyToMessageId: "user-2" },
  ];
  const batch = conversationCompactionBatch(history, 3);
  assert.deepEqual(batch.covered, []);
  assert.deepEqual(batch.summarized, []);
});

function interruptedTask() {
  return {
    id: "task-resume",
    status: "interrupted",
    updatedAt: "2026-08-12T00:00:00.000Z",
    route: {
      serverId: scope.serverId,
      serverIdentity: scope.serverIdentity,
      workspaceId: scope.workspaceId,
      agentId: scope.agentId,
    },
  };
}

test("RemoteTaskLifecycle 把 interrupted 视为终态并为下一条消息创建新 Task", async () => {
  const task = interruptedTask();
  let requestedStatuses = [];
  let createInput = null;
  const container = {
    runtime: { prompts },
    taskStore: {
      async listTasks({ statuses }) {
        requestedStatuses = statuses;
        return statuses.includes(task.status) ? [task] : [];
      },
    },
  };
  const lifecycle = new RemoteTaskLifecycle(container, { runId: null });
  lifecycle.create = async (input) => {
    createInput = input;
    return { task: { ...task, id: "task-new", status: "queued" }, start: { taskId: "task-new", status: "preparing" } };
  };
  const dispatched = await lifecycle.dispatch({
    scope,
    userMessage: "  中断后的新请求\n保持原样  ",
    handoffFragments: [{ knowledge: { key: "memory:preference", version: "1", content: "保留原样" } }],
    idempotencyKey: "interrupted-new-task-regression",
  });

  assert.equal(requestedStatuses.includes("interrupted"), false);
  assert.equal(dispatched.operation, "create");
  assert.equal(dispatched.task.id, "task-new");
  assert.equal(createInput.userMessage, "  中断后的新请求\n保持原样  ");
  assert.deepEqual(createInput.handoffFragments, [{ knowledge: { key: "memory:preference", version: "1", content: "保留原样" } }]);
});

test("RemoteTaskLifecycle 运行中追加只转发用户原文", async () => {
  const appendScope = { ...scope, agentId: "claude-code" };
  const task = { ...interruptedTask(), status: "running", route: { ...interruptedTask().route, agentId: appendScope.agentId } };
  let receivedPrompt = null;
  const lifecycle = new RemoteTaskLifecycle({
    taskStore: { async listTasks() { return [task]; } },
    orchestrator: {
      async append(_taskId, { prompt, commandId }) {
        receivedPrompt = prompt;
        return { command: { commandId, status: "accepted" }, duplicate: false };
      },
    },
  }, { runId: null });

  const dispatched = await lifecycle.dispatch({
    scope: appendScope,
    userMessage: "  这是追加问题\n不要改写  ",
    idempotencyKey: "append-verbatim-regression",
    directRemoteTaskId: task.id,
  });

  assert.equal(dispatched.operation, "append");
  assert.equal(receivedPrompt, "  这是追加问题\n不要改写  ");
});

test("RemoteTaskLifecycle 通过 OpenCode 原生会话立即接收运行中追加", async () => {
  const task = { ...interruptedTask(), status: "running" };
  let appended = null;
  let created = false;
  let attachedTask = null;
  const lifecycle = new RemoteTaskLifecycle({
    taskStore: { async listTasks() { return [task]; } },
    webInteractionStore: { async addTask(runId, taskId) { attachedTask = { runId, taskId }; } },
    orchestrator: {
      async append(taskId, input) {
        appended = { taskId, ...input };
        return { command: { commandId: input.commandId, status: "accepted" }, duplicate: false };
      },
    },
  }, { runId: "web-run-opencode-append", messageId: "message-opencode-append" });
  lifecycle.create = async () => {
    created = true;
    throw new Error("运行中的 OpenCode 追加不应新建 Task");
  };

  const dispatched = await lifecycle.dispatch({
    scope,
    userMessage: "马上改成只读检查，不要等当前输出结束",
    idempotencyKey: "opencode-native-append-regression",
    directRemoteTaskId: task.id,
  });

  assert.equal(dispatched.operation, "append");
  assert.equal(dispatched.taskId, task.id);
  assert.equal(created, false);
  assert.equal(appended.taskId, task.id);
  assert.equal(appended.prompt, "马上改成只读检查，不要等当前输出结束");
  assert.equal(appended.sourceMessageId, "message-opencode-append");
  assert.equal(appended.conversationRunId, "web-run-opencode-append");
  assert.deepEqual(attachedTask, { runId: "web-run-opencode-append", taskId: task.id });
});

test("RemoteTaskLifecycle 拒绝把追加消息投递给已经变化的运行中 Task", async () => {
  const task = { ...interruptedTask(), id: "task-current", status: "running" };
  const lifecycle = new RemoteTaskLifecycle({
    taskStore: { async listTasks() { return [task]; } },
  }, { runId: null });

  await assert.rejects(
    lifecycle.dispatch({
      scope,
      userMessage: "追加内容",
      idempotencyKey: "append-task-changed-regression",
      directRemoteTaskId: "task-previous",
    }),
    (error) => error.code === "DIRECT_REMOTE_TASK_CHANGED",
  );
});

test("RemoteTaskLifecycle 在原 Task 已进入 finalizing 时等待收口并直接续开原生会话", async () => {
  let task = {
    ...interruptedTask(),
    id: "task-finalizing",
    status: "finalizing",
  };
  let createInput = null;
  let waitedTaskId = null;
  const lifecycle = new RemoteTaskLifecycle({
    taskStore: {
      async listTasks() { return [task]; },
    },
    orchestrator: {
      async getTask() { return task; },
    },
  }, { runId: "web-finalizing-followup", messageId: "message-finalizing-followup" });
  lifecycle.waitFor = async (taskId) => {
    waitedTaskId = taskId;
    task = { ...task, status: "completed" };
    return { task, report: { remoteFinal: { text: "prior answer" } } };
  };
  lifecycle.create = async (input) => {
    createInput = input;
    return { task: { ...task, id: "task-followup", status: "queued" }, start: { taskId: "task-followup", status: "preparing" } };
  };

  const dispatched = await lifecycle.dispatch({
    scope,
    userMessage: "只列出原始毫秒值",
    handoffFragments: [],
    idempotencyKey: "finalizing-native-followup",
    directRemoteTaskId: "task-finalizing",
  });

  assert.equal(waitedTaskId, "task-finalizing");
  assert.equal(dispatched.operation, "create");
  assert.equal(dispatched.taskId, "task-followup");
  assert.equal(createInput.userMessage, "只列出原始毫秒值");
  assert.deepEqual(createInput.handoffFragments, []);
});

test("RemoteTaskLifecycle 在 Task 失败后立即返回失败原因，不等待可能缺失的报告", async () => {
  const failedTask = {
    ...interruptedTask(),
    status: "failed",
    failure: { code: "AGENT_SERVICE_START_FAILED", message: "OpenCode loopback 服务未就绪", retryable: true },
  };
  let observations = 0;
  const lifecycle = new RemoteTaskLifecycle({
    orchestrator: {
      async getTask() { return failedTask; },
    },
    broker: {
      async replay() { return { events: [], nextAfterSequence: 0 }; },
    },
    taskReports: {
      async get() { return null; },
    },
  }, { runId: null });
  const originalObserve = lifecycle.observe.bind(lifecycle);
  lifecycle.observe = async (input) => {
    observations += 1;
    return originalObserve(input);
  };

  const observation = await lifecycle.waitFor(failedTask.id);

  assert.equal(observation.task.status, "failed");
  assert.equal(observation.task.failure.message, "OpenCode loopback 服务未就绪");
  assert.equal(observation.report, null);
  assert.equal(observations, 1);
});

test("RemoteTaskLifecycle 不把等待审批当作远端回复终态", async () => {
  const lifecycle = new RemoteTaskLifecycle({}, { runId: null });
  let observations = 0;
  lifecycle.observe = async () => {
    observations += 1;
    if (observations === 1) {
      return {
        task: { id: "task-approval", status: "waiting_approval" },
        report: null,
        events: [],
        nextAfterSequence: 4,
      };
    }
    return {
      task: { id: "task-approval", status: "completed" },
      report: { remoteFinal: { text: "审批后完成" } },
      events: [],
      nextAfterSequence: 9,
    };
  };

  const observation = await lifecycle.waitFor("task-approval");

  assert.equal(observations, 2);
  assert.equal(observation.task.status, "completed");
  assert.equal(observation.report.remoteFinal.text, "审批后完成");
});

test("RemoteTaskLifecycle 创建新 Task 前修复当前原生会话最后一轮的语义水位线", async () => {
  const previousTask = {
    id: "task-previous",
    status: "completed",
    remoteRunId: "run-previous",
    agentBindingId: null,
  };
  const messages = [
    { id: "message-user-previous", role: "user", content: "上一轮问题", taskId: null },
    { id: "message-assistant-previous", role: "assistant", content: "上一轮答案", taskId: previousTask.id },
  ];
  let bindingId = null;
  let acknowledged = null;
  let acknowledgedKnowledge = null;
  let stagedKnowledge = null;
  let registeredTaskInput = null;
  let deliveryChecks = 0;
  let listCalls = 0;
  const container = {
    actor: { actorType: "user", actorId: "user-runtime", userId: "user-runtime" },
    runtime: {
      prompts: {
        ...prompts,
        async conversationMessage(role, content) { return `${role}:${content}`; },
      },
    },
    taskStore: {
      async getTask() { return null; },
      async listTasks() {
        listCalls += 1;
        if (listCalls === 1) return [];
        previousTask.agentBindingId = bindingId;
        return [previousTask];
      },
    },
    taskRuntime: {
      async loadBinding(id) {
        bindingId = id;
        return { activeRunId: previousTask.remoteRunId, native: { sessionId: "native-current" } };
      },
    },
    baseConversations: {
      async getConversation() {
        return { summary: { id: scope.conversationId, projectId: null, activeBranchId: "branch-runtime" } };
      },
      async listMessages() { return { items: messages, nextCursor: null }; },
    },
    contextHub: {
      async acknowledgeStagedKnowledge() {},
      async acknowledgeSemanticContent(value) { acknowledged = value; },
      async acknowledgeKnowledge(value) { acknowledgedKnowledge = value; },
      async checkpointBinding() {},
      async unacknowledgedKnowledge({ units }) { deliveryChecks += 1; return units; },
      async unacknowledgedSemanticContent({ values }) { return values; },
      async stageKnowledge(value) { stagedKnowledge = value.units; },
      async createSession(input) { return { id: input.id }; },
    },
    memoryCoordinator: {
      async taskDescriptor() { return null; },
      async registerTask(input) { registeredTaskInput = input; },
    },
    webInteractionStore: {
      async findByTask() { return [{ input: { messageId: messages[0].id } }]; },
    },
    orchestrator: {
      async create(input) { return { task: { ...input, status: "queued", skillPins: [] } }; },
      async start(id) { return { taskId: id, status: "preparing" }; },
    },
  };
  const lifecycle = new RemoteTaskLifecycle(container, { runId: null, providerId: "provider-web", modelId: "model-web", messageId: "message-current" });
  const created = await lifecycle.create({
    scope: { ...scope, branchId: "branch-runtime" },
    userMessage: "这一轮问题",
    handoffFragments: [
      { knowledge: { key: "memory:project-goal", version: "1", content: "项目目标" } },
      { knowledge: { key: "skill:platform-guide", version: "semantic-v1:1.0.0:hash-a", content: "平台规范正文" } },
      { toolName: "conversation_reference_search", knowledge: { key: "conversation-reference:source:snapshot:message", version: "snapshot-v1", content: "显式引用正文" } },
    ],
    idempotencyKey: "semantic-watermark-regression",
  });

  assert.equal(created.task.status, "queued");
  assert.equal(acknowledged.bindingKey, bindingId);
  assert.equal(acknowledged.nativeSessionId, "native-current");
  assert.deepEqual(acknowledged.values, ["user:上一轮问题", "assistant:上一轮答案"]);
  assert.deepEqual(acknowledgedKnowledge.units, [
    { key: "conversation:message-user-previous", version: "message-user-previous", content: "user:上一轮问题" },
    { key: "conversation:message-assistant-previous", version: "message-assistant-previous", content: "assistant:上一轮答案" },
  ]);
  assert.deepEqual(stagedKnowledge, [
    { key: "memory:project-goal", version: "1", content: "项目目标" },
    { key: "conversation-reference:source:snapshot:message", version: "snapshot-v1", content: "显式引用正文" },
  ]);
  assert.deepEqual(registeredTaskInput.observedKnowledge.map((entry) => entry.knowledge.key), ["memory:project-goal", "skill:platform-guide"]);
  assert.equal(deliveryChecks, 1);
});

test("RemoteTaskLifecycle 切回无 activeRun 的原生会话时依据检查点排除它自己的上一轮", async () => {
  const previousTask = {
    id: "task-previous-checkpoint",
    status: "completed",
    remoteRunId: "run-previous-checkpoint",
    agentBindingId: null,
    sourceMessageId: "message-user-previous",
  };
  const messages = [
    { id: "message-user-previous", role: "user", content: "上一轮问题", taskId: null },
    { id: "message-assistant-previous", role: "assistant", content: "上一轮答案", taskId: previousTask.id },
  ];
  const acknowledgedKeys = new Set();
  let bindingId = null;
  const lifecycle = new RemoteTaskLifecycle({
    runtime: {
      prompts: {
        ...prompts,
        async conversationMessage(role, content) { return `${role}:${content}`; },
      },
    },
    taskRuntime: {
      async loadBinding(id) {
        bindingId = id;
        previousTask.agentBindingId = id;
        return { adapterId: "claude-code", activeRunId: null, native: { sessionId: "native-checkpoint" } };
      },
    },
    taskStore: {
      async listTasks() { return [previousTask]; },
    },
    baseConversations: {
      async listMessages() { return { items: messages, nextCursor: null }; },
    },
    contextHub: {
      async getBindingCheckpoint({ checkpointId }) {
        return checkpointId === previousTask.id
          ? { checkpointId, nativeBoundary: { sessionId: "native-checkpoint" } }
          : null;
      },
      async acknowledgeStagedKnowledge() {},
      async acknowledgeSemanticContent() {},
      async acknowledgeKnowledge({ units }) {
        for (const unit of units) acknowledgedKeys.add(`${unit.key}\0${unit.version}`);
      },
      async unacknowledgedKnowledge({ units }) {
        return units.filter((unit) => !acknowledgedKeys.has(`${unit.key}\0${unit.version}`));
      },
      async unacknowledgedSemanticContent({ values }) { return values; },
    },
    memoryCoordinator: {
      async taskDescriptor() { return { sourceMessageId: previousTask.sourceMessageId }; },
    },
    webInteractionStore: {
      async findByTask() { return []; },
    },
  }, { runId: null });

  const fragments = await lifecycle.filterHandoff({
    scope: { ...scope, actorType: "user", actorId: "user-runtime", branchId: "branch-runtime", contextEpoch: 0 },
    fragments: [
      {
        rendered: "user:上一轮问题",
        knowledge: { key: "conversation:message-user-previous", version: "message-user-previous", content: "user:上一轮问题" },
      },
      {
        rendered: "assistant:上一轮答案",
        knowledge: { key: "conversation:message-assistant-previous", version: "message-assistant-previous", content: "assistant:上一轮答案" },
      },
      {
        rendered: "user:另一 Agent 的新增问题",
        knowledge: { key: "conversation:message-user-new", version: "message-user-new", content: "user:另一 Agent 的新增问题" },
      },
    ],
  });

  assert.deepEqual(fragments.map((entry) => entry.knowledge.key), ["conversation:message-user-new"]);
  assert.equal(previousTask.agentBindingId, bindingId);
});

test("RemoteTaskLifecycle 筛选新交接前先确认重启遗留的已投递知识", async () => {
  const previousTask = {
    id: "task-previous-pending",
    status: "completed",
    remoteRunId: "run-previous-pending",
    agentBindingId: null,
  };
  let repaired = false;
  const lifecycle = new RemoteTaskLifecycle({
    taskRuntime: {
      async loadBinding(bindingId) {
        previousTask.agentBindingId = bindingId;
        return { activeRunId: previousTask.remoteRunId, native: { sessionId: "native-current" } };
      },
    },
    taskStore: {
      async listTasks() { return [previousTask]; },
    },
    contextHub: {
      async acknowledgeSemanticContent() {},
      async acknowledgeStagedKnowledge({ taskId }) {
        assert.equal(taskId, previousTask.id);
        repaired = true;
      },
      async unacknowledgedKnowledge({ units }) { return repaired ? [] : units; },
      async unacknowledgedSemanticContent({ values }) { return values; },
    },
    memoryCoordinator: {
      async taskDescriptor() { return null; },
    },
    webInteractionStore: {
      async findByTask() { return []; },
    },
  }, { runId: null });

  const fragments = await lifecycle.filterHandoff({
    scope: { ...scope, actorType: "user", actorId: "user-runtime", branchId: "branch-runtime", contextEpoch: 0 },
    fragments: [{
      rendered: "相关记忆：项目目标",
      knowledge: { key: "memory:project-goal", version: "1", content: "项目目标" },
      priority: 40,
    }],
  });

  assert.equal(repaired, true);
  assert.deepEqual(fragments, []);
});

test("RemoteTaskLifecycle reuses deployed Skills and sends them again only to a fresh binding", async () => {
  let nativeSessionId = "native-a";
  const known = { key: "skill:platform-guide", version: "1.0.0:hash-a" };
  const lifecycle = new RemoteTaskLifecycle({
    taskRuntime: {
      async loadBinding() {
        return {
          native: {
            sessionId: nativeSessionId,
            skillPins: nativeSessionId === "native-a"
              ? [{ skillId: "platform-guide", version: "1.0.0", sha256: "hash-a" }]
              : [],
          },
        };
      },
    },
    contextHub: {
      async unacknowledgedKnowledge({ units }) { return units; },
      async unacknowledgedSemanticContent({ values }) { return values; },
    },
  }, { runId: null });
  const fragments = [
    { toolName: "skill_search", rendered: "平台规范", knowledge: { ...known, version: "semantic-v1:1.0.0:hash-a" } },
    { toolName: "skill_search", rendered: "健康检查", knowledge: { key: "skill:health-check", version: "semantic-v1:2.0.0:hash-b" } },
  ];
  const effectiveScope = { ...scope, actorType: "user", actorId: "user-runtime", branchId: "branch-runtime", contextEpoch: 0 };

  assert.deepEqual((await lifecycle.filterHandoff({ scope: effectiveScope, fragments })).map((entry) => entry.knowledge.key), ["skill:health-check"]);
  nativeSessionId = "native-b";
  assert.deepEqual((await lifecycle.filterHandoff({ scope: effectiveScope, fragments })).map((entry) => entry.knowledge.key), ["skill:platform-guide", "skill:health-check"]);
});
