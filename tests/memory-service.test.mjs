import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { PersistentMemoryService } from "../gateway/core/memory/index.mjs";
import { resolveActorPath } from "../gateway/core/paths.mjs";
import { createEffectiveContextScope } from "../gateway/core/scope.mjs";

const actor = createActorContext({ actorType: "user", actorId: "user_a", deviceId: "device_a", sessionId: "session_a", roles: [] });
const source = { type: "message", id: "message_a", version: "1" };

const effectiveScope = (overrides = {}) => createEffectiveContextScope({
  actor,
  projectId: "project_a",
  conversationId: "conversation_a",
  workspaceId: "workspace_a",
  taskId: "task_a",
  branchId: "main",
  memoryMode: "global",
  contextEpoch: 0,
  ...overrides,
});

test("Persistent memory stores immutable versions and requires optimistic revision", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    const first = await memory.append({ scope: { level: "user" }, semanticKey: "preferred-shell", content: "Prefer bash", authority: "user-explicit", confidence: 1, source });
    assert.equal(first.record.revision, 0);
    await assert.rejects(
      () => memory.append({ scope: { level: "user" }, semanticKey: "preferred-shell", content: "Prefer zsh", source }),
      (error) => error?.code === "EXPECTED_REVISION_REQUIRED",
    );
    const second = await memory.append({ scope: { level: "user" }, semanticKey: "preferred-shell", content: "Prefer zsh", authority: "user-explicit", confidence: 1, source, expectedRevision: 0 });
    assert.equal(second.record.revision, 1);
    assert.equal(second.record.versions.length, 2);
    assert.equal(second.version.supersedes, first.version.id);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Only account, project, and conversation memory enter model context", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    for (const [level, id] of [["user"], ["project", "project_a"], ["conversation", "conversation_a"]]) {
      await memory.append({ scope: { level, id }, semanticKey: `key-${level}`, content: `memory-${level}`, authority: "verified-result", source });
    }
    for (const [level, id] of [["workspace", "workspace_a"], ["task", "task_a"]]) {
      await assert.rejects(
        () => memory.append({ scope: { level, id }, semanticKey: `key-${level}`, content: `memory-${level}`, authority: "verified-result", source }),
        (error) => error?.code === "MEMORY_SCOPE_INVALID",
      );
    }

    // Seed records in the old on-disk schema to prove upgrades can still read
    // and invalidate them without ever projecting them into model context.
    const storePath = resolveActorPath(dataRoot, actor, "memory", "persistent.json");
    const stored = JSON.parse(await readFile(storePath, "utf8"));
    for (const [level, id] of [["workspace", "workspace_a"], ["task", "task_a"]]) {
      stored.data.sequence += 1;
      const recordId = `legacy_${level}`;
      const timestamp = "2026-01-01T00:00:00.000Z";
      stored.data.records[recordId] = {
        id: recordId,
        scope: { level, id },
        semanticKey: `key-${level}`,
        revision: 0,
        versions: [{
          id: `legacy_version_${level}`,
          sequence: stored.data.sequence,
          content: `memory-${level}`,
          authority: "verified-result",
          confidence: 1,
          sensitivity: "private",
          portability: `${level}-bound`,
          source,
          supersedes: null,
          createdAt: timestamp,
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }
    stored.revision += 1;
    await writeFile(storePath, `${JSON.stringify(stored, null, 2)}\n`);

    const snapshot = await memory.snapshot(effectiveScope());
    const global = await memory.select(effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds }));
    assert.deepEqual(new Set(global.entries.map((entry) => entry.scope.level)), new Set(["user", "project", "conversation"]));
    const projectOnlyScope = effectiveScope({ memoryMode: "project-only", memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    const projectOnly = await memory.select(projectOnlyScope);
    assert.deepEqual(new Set(projectOnly.entries.map((entry) => entry.scope.level)), new Set(["project", "conversation"]));
    const otherWorkspace = effectiveScope({ workspaceId: "workspace_b", taskId: "task_b", memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    const isolated = await memory.select(otherWorkspace);
    assert.equal(isolated.entries.some((entry) => ["workspace", "task"].includes(entry.scope.level)), false);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Snapshots remain stable while live state advances and reset invalidates only later matching versions", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    const before = await memory.append({ scope: { level: "conversation", id: "conversation_a" }, semanticKey: "result-a", content: "kept", source });
    const snapshot = await memory.snapshot(effectiveScope());
    const after = await memory.append({ scope: { level: "conversation", id: "conversation_a" }, semanticKey: "result-b", content: "removed", source });
    await memory.append({ scope: { level: "conversation", id: "conversation_b" }, semanticKey: "other", content: "untouched", source });
    const reset = await memory.invalidateAfter({ scope: effectiveScope(), afterSequence: snapshot.sequence, reason: "retry from previous reply", source });
    assert.equal(reset.invalidated, 1);
    const liveScope = effectiveScope({ memorySnapshotSequence: reset.sequence, memorySnapshotVersionIds: [] });
    const live = await memory.select(liveScope);
    assert.equal(live.entries.some((entry) => entry.version.id === before.version.id), true);
    assert.equal(live.entries.some((entry) => entry.version.id === after.version.id), false);
    const historicalScope = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    const historical = await memory.select(historicalScope);
    assert.deepEqual(historical.entries.map((entry) => entry.version.content), ["kept"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Restricted memory is excluded from model context unless explicitly authorized", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    await memory.append({ scope: { level: "conversation", id: "conversation_a" }, semanticKey: "private", content: "restricted observation", sensitivity: "restricted", source });
    const snapshot = await memory.snapshot(effectiveScope(), { includeRestricted: true });
    const scope = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    assert.equal((await memory.select(scope)).entries.length, 0);
    assert.equal((await memory.select(scope, { includeRestricted: true })).entries.length, 1);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("中文记忆检索不因单字重合展示无关项目约定，同时保留单字查询", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    await memory.append({
      scope: { level: "project", id: "project_a" },
      semanticKey: "batch-size",
      content: "该项目过去约定的默认批处理大小固定为 99。",
      authority: "user-explicit",
      confidence: 1,
      source,
    });
    await memory.append({
      scope: { level: "project", id: "project_a" },
      semanticKey: "maintenance-window",
      content: "本项目的维护窗口简称固定为 CHAT-SEED-742。",
      authority: "user-explicit",
      confidence: 1,
      source,
    });
    const snapshot = await memory.snapshot(effectiveScope());
    const scope = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });

    const focused = await memory.select(scope, { query: "批处理大小 batch size 约定" });
    assert.deepEqual(focused.entries.map((entry) => entry.semanticKey), ["batch-size"]);

    const singleCharacter = await memory.select(scope, { query: "窗" });
    assert.deepEqual(singleCharacter.entries.map((entry) => entry.semanticKey), ["maintenance-window"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("带文件名和作业号的记忆查询不会因通用术语命中无关项目事实", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    await memory.append({
      scope: { level: "project", id: "project_a" },
      semanticKey: "artifact-hygiene",
      content: "项目产物使用 ast.parse 做静态检查，并删除 compileall 生成的 pyc。",
      authority: "verified-result",
      source,
    });
    await memory.append({
      scope: { level: "project", id: "project_a" },
      semanticKey: "s07-job",
      content: "S07 正式作业 5332845 使用 p6_cpu_verify.sbatch，脚本没有申请 GPU。",
      authority: "verified-result",
      source,
    });
    const snapshot = await memory.snapshot(effectiveScope());
    const scope = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });

    const selected = await memory.select(scope, { query: "S07 CPU 正式作业 5332845 GPU 静态检查交接" });
    assert.deepEqual(selected.entries.map((entry) => entry.semanticKey), ["s07-job"]);
    assert.deepEqual((await memory.select(scope, { query: "静态检查" })).entries.map((entry) => entry.semanticKey), ["artifact-hygiene"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
