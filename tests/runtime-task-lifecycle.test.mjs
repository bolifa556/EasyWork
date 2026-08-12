import assert from "node:assert/strict";
import test from "node:test";

import { RemoteTaskLifecycle } from "../gateway/core/runtime/services.mjs";

const scope = Object.freeze({
  conversationId: "conversation-resume",
  serverId: "server-resume",
  serverIdentity: "identity-resume",
  workspaceId: "workspace-resume",
  agentId: "opencode",
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

test("RemoteTaskLifecycle 等待异步 resume 离开 interrupted 后才交给最终状态观察器", async () => {
  const task = interruptedTask();
  let taskReads = 0;
  const container = {
    taskStore: {
      async listTasks() { return [task]; },
    },
    orchestrator: {
      async resume(_taskId, { commandId }) {
        return { command: { commandId, status: "accepted" }, duplicate: false };
      },
      async getTask() {
        taskReads += 1;
        return taskReads < 3 ? task : { ...task, status: "recovering" };
      },
      async getCommand(_taskId, commandId) {
        return { commandId, status: "running" };
      },
    },
  };
  const lifecycle = new RemoteTaskLifecycle(container, { runId: null });
  const dispatched = await lifecycle.dispatch({
    scope,
    userMessage: "从中断处继续",
    contextBrief: "",
    idempotencyKey: "resume-race-regression",
  });

  assert.equal(dispatched.operation, "resume");
  assert.equal(dispatched.task.status, "recovering");
  assert.ok(taskReads >= 3);
});

test("RemoteTaskLifecycle 将异步 resume 失败返回给网页交互而不是伪装成普通中断", async () => {
  const task = interruptedTask();
  const container = {
    taskStore: {
      async listTasks() { return [task]; },
    },
    orchestrator: {
      async resume(_taskId, { commandId }) {
        return { command: { commandId, status: "accepted" }, duplicate: false };
      },
      async getTask() { return task; },
      async getCommand(_taskId, commandId) {
        return {
          commandId,
          status: "failed",
          failure: { code: "AGENT_RESUME_REJECTED", message: "原生会话不能恢复", retryable: false },
        };
      },
    },
  };
  const lifecycle = new RemoteTaskLifecycle(container, { runId: null });

  await assert.rejects(
    lifecycle.dispatch({ scope, userMessage: "继续", contextBrief: "", idempotencyKey: "resume-failure-regression" }),
    (error) => error.code === "AGENT_RESUME_REJECTED" && error.message === "原生会话不能恢复",
  );
});
