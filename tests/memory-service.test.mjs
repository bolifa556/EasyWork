import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { PersistentMemoryService } from "../gateway/core/memory/index.mjs";
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

test("Five memory scopes obey project-only/global and exact workspace/task identity", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    for (const [level, id] of [["user"], ["project", "project_a"], ["conversation", "conversation_a"], ["workspace", "workspace_a"], ["task", "task_a"]]) {
      await memory.append({ scope: { level, id }, semanticKey: `key-${level}`, content: `memory-${level}`, authority: "verified-result", source });
    }
    const snapshot = await memory.snapshot(effectiveScope());
    const global = await memory.select(effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds }));
    assert.deepEqual(new Set(global.entries.map((entry) => entry.scope.level)), new Set(["user", "project", "conversation", "workspace", "task"]));
    const projectOnlyScope = effectiveScope({ memoryMode: "project-only", memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    const projectOnly = await memory.select(projectOnlyScope);
    assert.equal(projectOnly.entries.some((entry) => entry.scope.level === "user"), false);
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
