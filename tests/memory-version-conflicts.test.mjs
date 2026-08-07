import assert from "node:assert/strict";
import test from "node:test";

import {
  agentConversationDelta,
  appendExplicitMemory,
  defaultMemoryDocument,
  invalidateMemoryVersions,
  memorySnapshotAt,
  selectMemoryRecords,
} from "../gateway/memory.mjs";

const { gatewayTestHelpers } = await import(
  `../gateway/server.mjs?conflict-scenarios=${Date.now()}`
);
const {
  agentBindingKey,
  workspaceIdFor,
  workspaceRunConflict,
  workspaceVersionDomainIdFor,
} = gatewayTestHelpers;

function activeRun(overrides = {}) {
  return {
    runId: "run-a",
    conversationId: "conversation-a",
    serverId: "profile-a",
    serverIdentity: "endpoint-a",
    workspace: "/srv/repo/a",
    versionDomainId: workspaceVersionDomainIdFor(
      "endpoint-a",
      "/srv/repo",
      "/srv/repo/a",
    ),
    ...overrides,
  };
}

test("冲突场景 01：同一目录的两个对话不可并行写入", () => {
  const run = activeRun();
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-b", {
      serverId: "profile-a",
      serverIdentity: "endpoint-a",
      path: "/srv/repo/a",
    })?.runId,
    run.runId,
  );
});

test("冲突场景 02：父工作区与子工作区不可并行写入", () => {
  const run = activeRun({ workspace: "/srv/repo" });
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-b", {
      serverId: "profile-a",
      serverIdentity: "endpoint-a",
      path: "/srv/repo/a/src",
    })?.runId,
    run.runId,
  );
});

test("冲突场景 03：路径前缀相同但不是父子目录时不误锁", () => {
  const run = activeRun({
    workspace: "/srv/project",
    versionDomainId: "version-project",
  });
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-b", {
      serverId: "profile-a",
      serverIdentity: "endpoint-a",
      path: "/srv/project-copy",
      versionDomainId: "version-project-copy",
    }),
    undefined,
  );
});

test("冲突场景 04：同一 Git 根下的兄弟工作区共享版本锁", () => {
  const run = activeRun();
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-b", {
      serverId: "profile-a",
      serverIdentity: "endpoint-a",
      path: "/srv/repo/b",
      versionDomainId: run.versionDomainId,
    })?.runId,
    run.runId,
  );
});

test("冲突场景 05：不同服务器上的同路径互不锁定", () => {
  const run = activeRun();
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-b", {
      serverId: "profile-b",
      serverIdentity: "endpoint-b",
      path: "/srv/repo/a",
      versionDomainId: workspaceVersionDomainIdFor(
        "endpoint-b",
        "/srv/repo",
        "/srv/repo/a",
      ),
    }),
    undefined,
  );
});

test("冲突场景 06：同一 SSH 端点的重复配置不能绕过版本锁", () => {
  const run = activeRun();
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-b", {
      serverId: "duplicate-profile",
      serverIdentity: "endpoint-a",
      path: "/srv/repo/b",
      versionDomainId: run.versionDomainId,
    })?.runId,
    run.runId,
  );
});

test("冲突场景 07：同一网页对话不能跨工作区并发运行", () => {
  const run = activeRun();
  assert.equal(
    workspaceRunConflict(new Map([[run.runId, run]]), "conversation-a", {
      serverId: "profile-b",
      serverIdentity: "endpoint-b",
      path: "/other/repo",
    })?.runId,
    run.runId,
  );
});

test("冲突场景 08：虚拟对话重复写入同目录时复用同一 Agent 绑定", () => {
  const workspaceId = workspaceIdFor("profile-a", "/srv/repo/a");
  const first = agentBindingKey({
    serverId: "profile-a",
    workspaceId,
    agentId: "opencode",
    conversationId: "virtual-chat",
  });
  assert.equal(
    first,
    agentBindingKey({
      serverId: "profile-a",
      workspaceId,
      agentId: "opencode",
      conversationId: "virtual-chat",
    }),
  );
});

test("冲突场景 09：同一网页对话切换 Agent 时使用独立原生会话", () => {
  const input = {
    serverId: "profile-a",
    workspaceId: "workspace-a",
    conversationId: "chat-a",
  };
  assert.notEqual(
    agentBindingKey({ ...input, agentId: "opencode" }),
    agentBindingKey({ ...input, agentId: "claude-code" }),
  );
});

test("冲突场景 10：同一 Agent 切换工作区时使用独立原生会话", () => {
  const input = {
    serverId: "profile-a",
    agentId: "opencode",
    conversationId: "chat-a",
  };
  assert.notEqual(
    agentBindingKey({ ...input, workspaceId: "workspace-a" }),
    agentBindingKey({ ...input, workspaceId: "workspace-b" }),
  );
});

test("冲突场景 11：切回旧 Agent 只补发其他 Agent 产生的新内容", () => {
  const state = {
    conversations: [
      {
        id: "chat-switch",
        messages: [
          { id: "u1", role: "user", content: "任务一" },
          { id: "a1", role: "assistant", agentId: "agent-a", content: "完成一" },
          { id: "u2", role: "user", content: "任务二" },
          { id: "a2", role: "assistant", agentId: "agent-b", content: "完成二" },
          { id: "u3", role: "user", content: "切回 A" },
        ],
      },
    ],
  };
  const delta = agentConversationDelta(
    state,
    "chat-switch",
    { agentSessionId: "native-a", syncCursor: { lastMessageId: "a1" } },
    { currentUserMessageId: "u3" },
  );
  assert.deepEqual(delta.messages.map((message) => message.id), ["u2", "a2"]);
});

test("冲突场景 12：同工作区交错操作后只撤销目标对话的最新版本", () => {
  let document = defaultMemoryDocument();
  for (const [number, conversation] of [
    [1, "A"],
    [2, "B"],
    [3, "A"],
    [4, "B"],
    [5, "A"],
  ]) {
    document = appendExplicitMemory(document, {
      content: `操作 ${number}`,
      semanticKey: `operation-${number}`,
      scope: "workspace",
      scopeId: "shared-workspace",
      sourceConversationId: conversation,
      sourceTaskId: `${conversation}${number}`,
    });
  }
  document = invalidateMemoryVersions(document, {
    sourceConversationIds: ["A"],
    sourceTaskIds: ["A5"],
  });
  assert.deepEqual(
    selectMemoryRecords(document, {
      prompt: "",
      workspaceId: "shared-workspace",
      relevanceThreshold: 0,
    }).map((record) => record.content).sort(),
    ["操作 1", "操作 2", "操作 3", "操作 4"],
  );
});

test("冲突场景 13：分支冻结不吸收源对话或其他服务器的后续记忆", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "分支前事实",
    semanticKey: "before",
    scope: "project",
    scopeId: "project-a",
    sourceConversationId: "source",
    sourceTaskId: "source-before",
  });
  const frozenAt = document.sequence;
  document = appendExplicitMemory(document, {
    content: "其他服务器后续事实",
    semanticKey: "other-server-future",
    scope: "project",
    scopeId: "project-a",
    sourceConversationId: "other",
    sourceTaskId: "other-future",
  });
  document = appendExplicitMemory(document, {
    content: "源对话后续事实",
    semanticKey: "source-future",
    scope: "project",
    scopeId: "project-a",
    sourceConversationId: "source",
    sourceTaskId: "source-future",
  });
  assert.deepEqual(
    selectMemoryRecords(document, {
      prompt: "",
      projectId: "project-a",
      memoryMode: "project-only",
      asOfSequence: frozenAt,
      snapshotVersionIds: [],
      lineageConversationId: "branch",
      relevanceThreshold: 0,
    }).map((record) => record.content),
    ["分支前事实"],
  );
});

test("冲突场景 14：目标任务晚到的蒸馏记忆进入分支但并发记忆不进入", () => {
  let document = defaultMemoryDocument();
  document = appendExplicitMemory(document, {
    content: "并发任务结果",
    semanticKey: "concurrent",
    scope: "project",
    scopeId: "project-a",
    sourceTaskId: "other-task",
  });
  document = appendExplicitMemory(document, {
    content: "分支目标任务结果",
    semanticKey: "branch-target",
    scope: "project",
    scopeId: "project-a",
    sourceTaskId: "target-task",
  });
  for (const version of document.records.flatMap((record) => record.versions)) {
    version.createdAt = "2026-08-04T12:00:05.000Z";
  }
  const snapshot = memorySnapshotAt(document, "2026-08-04T12:00:01.000Z", {
    sourceTaskIds: ["target-task"],
  });
  assert.deepEqual(
    selectMemoryRecords(document, {
      prompt: "",
      projectId: "project-a",
      memoryMode: "project-only",
      asOfSequence: snapshot.sequence,
      snapshotVersionIds: snapshot.versionIds,
      lineageConversationId: "branch",
      relevanceThreshold: 0,
    }).map((record) => record.content),
    ["分支目标任务结果"],
  );
});

test("冲突场景 15：同内容由两个对话验证时重置一个仍保留另一来源", () => {
  let document = defaultMemoryDocument();
  for (const conversation of ["A", "B"]) {
    document = appendExplicitMemory(document, {
      content: "部署前先检查端口占用",
      semanticKey: "frp-procedure",
      scope: "project",
      scopeId: "project-frp",
      sourceConversationId: conversation,
      sourceTaskId: `${conversation}-task`,
    });
  }
  document = invalidateMemoryVersions(document, {
    sourceConversationIds: ["A"],
    sourceTaskIds: ["A-task"],
  });
  const records = selectMemoryRecords(document, {
    prompt: "",
    projectId: "project-frp",
    memoryMode: "project-only",
    relevanceThreshold: 0,
  });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].sourceConversationIds, ["B"]);
});
