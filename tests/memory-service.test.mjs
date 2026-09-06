import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { PersistentMemoryService } from "../gateway/core/memory/index.mjs";
import { resolveActorPath } from "../gateway/core/paths.mjs";
import { createEffectiveContextScope } from "../gateway/core/scope.mjs";
import { durableMemoryCandidate } from "../gateway/core/memory/policy.mjs";

test("delivery preferences require an actual enduring user statement, not the Agent's chosen method", () => {
  const candidate = { kind: "user-preference", level: "project", semanticKey: "交付方式", content: "默认通过自建 HTTP 服务交付", evidence: { role: "assistant", quote: "通过自建 HTTP 服务交付" } };
  assert.equal(durableMemoryCandidate(candidate, { userMessage: "帮我下载", assistantMessage: "通过自建 HTTP 服务交付" }), false);
  assert.equal(durableMemoryCandidate({ ...candidate, evidence: { role: "user", quote: "以后默认用 HTTP" } }, { userMessage: "帮我下载" }), false);
  assert.equal(durableMemoryCandidate({ ...candidate, content: "文档默认使用 Markdown", evidence: { role: "user", quote: "以后文档默认用 Markdown" } }, { userMessage: "以后文档默认用 Markdown" }), true);
});

test("invalidated memory cannot re-enter Work through cached observations", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-filter-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    const saved = await memory.append({ scope: { level: "user" }, semanticKey: "delivery", content: "Prefer HTTP", authority: "agent-observed", source });
    const fragment = { knowledge: { key: `memory:${saved.record.id}`, content: "Prefer HTTP" } };
    assert.deepEqual(await memory.filterObservations([fragment]), [fragment]);
    await memory.invalidate({ versionIds: [saved.version.id], reason: "not a user preference", source });
    const other = { knowledge: { key: "skill:download", content: "download instructions" } };
    assert.deepEqual(await memory.filterObservations([fragment, other]), [other]);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

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

test("Snapshots freeze every eligible memory instead of inheriting retrieval Top-K", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const memory = new PersistentMemoryService({ dataRoot, actor });
    for (let index = 0; index < 75; index += 1) {
      await memory.append({
        scope: { level: "project", id: "project_a" },
        semanticKey: `snapshot-memory-${index}`,
        content: `项目长期约定第 ${index} 条：保留该稳定事实。`,
        authority: "verified-result",
        source: { ...source, id: `message_${index}` },
      });
    }

    const snapshot = await memory.snapshot(effectiveScope());
    assert.equal(snapshot.versionIds.length, 75);
    const frozen = effectiveScope({
      memorySnapshotSequence: snapshot.sequence,
      memorySnapshotVersionIds: snapshot.versionIds,
    });
    assert.equal((await memory.select(frozen)).entries.length, 50);
    assert.equal((await memory.select(frozen, { limit: 75 })).entries.length, 75);
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

test("记忆混合召回复用 Embedding，按标题加正文预计算并为旧记录回填向量", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    let configured = false;
    const embeddedInputs = [];
    const vectorFor = (text) => {
      const value = String(text);
      if (value.includes("literal-distractor")) return [0, 1];
      return value.includes("ship canary") || value.includes("release-procedure") ? [1, 0] : [0, 1];
    };
    const embedder = {
      async memoryConfiguration() {
        return {
          configured,
          enabled: true,
          embeddingProfileId: "mem_emb_test",
          retrievalProfileId: "mem_ret_test",
          vectorWeight: 0.55,
          lexicalWeight: 0.3,
          titleWeight: 0.15,
          recallLimit: 48,
          resultLimit: 8,
          tokenBudget: 3200,
          pageSize: 20,
        };
      },
      async embedTexts(inputs) {
        embeddedInputs.push(...inputs);
        return { profileId: "mem_emb_test", vectors: inputs.map(vectorFor) };
      },
    };
    const memory = new PersistentMemoryService({ dataRoot, actor, embedder });
    await memory.append({
      scope: { level: "project", id: "project_a" },
      semanticKey: "release-procedure",
      content: "把构建产物发布到预生产环境，并观察一轮指标。",
      authority: "verified-result",
      source,
    });
    await memory.append({
      scope: { level: "project", id: "project_a" },
      semanticKey: "literal-distractor",
      content: "ship canary 是一次无关的词法演示。",
      authority: "verified-result",
      source: { ...source, id: "message_b" },
    });
    configured = true;
    const snapshot = await memory.snapshot(effectiveScope());
    const frozen = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    const result = await memory.select(frozen, { query: "ship canary", limit: 8 });

    assert.equal(result.entries[0].semanticKey, "release-procedure");
    assert.equal(embeddedInputs.some((input) => input === "release-procedure\n把构建产物发布到预生产环境，并观察一轮指标。"), true);
    assert.equal((await memory.find({ scope: { level: "project", id: "project_a" }, semanticKey: "release-procedure" })).versions[0].embedding.profileId, "mem_emb_test");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("Embedding 不可用时记忆检索自动退化为标题与正文词法排序", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const embedder = {
      async memoryConfiguration() {
        return { configured: true, enabled: true, embeddingProfileId: "mem_emb_down" };
      },
      async embedTexts() { throw new Error("provider unavailable"); },
    };
    const memory = new PersistentMemoryService({ dataRoot, actor, embedder });
    await memory.append({ scope: { level: "project", id: "project_a" }, semanticKey: "deployment-port", content: "测试服务端口固定为 8789。", source });
    const snapshot = await memory.snapshot(effectiveScope());
    const frozen = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    assert.deepEqual((await memory.select(frozen, { query: "测试服务端口" })).entries.map((entry) => entry.semanticKey), ["deployment-port"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("记忆候选使用最低相关度与 MMR 抑制近重复结果", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-memory-"));
  try {
    const vectorFor = (text) => {
      const value = String(text);
      if (value.includes("primary")) return [1, 0];
      if (value.includes("duplicate")) return [0.99, 0.1];
      if (value.includes("complement")) return [0.7, 0.714];
      if (value.includes("irrelevant")) return [0.01, 1];
      return [1, 0];
    };
    const embedder = {
      async memoryConfiguration() {
        return {
          configured: true,
          enabled: true,
          embeddingProfileId: "mem_emb_mmr",
          vectorWeight: 1,
          lexicalWeight: 0,
          titleWeight: 0,
          minimumScore: 0.1,
          diversityLambda: 0.4,
        };
      },
      async embedTexts(inputs) {
        return { profileId: "mem_emb_mmr", vectors: inputs.map(vectorFor) };
      },
    };
    const memory = new PersistentMemoryService({ dataRoot, actor, embedder });
    for (const semanticKey of ["primary", "duplicate", "complement", "irrelevant"]) {
      await memory.append({
        scope: { level: "project", id: "project_a" },
        semanticKey,
        content: `${semanticKey} deployment guidance`,
        source: { ...source, id: `message_${semanticKey}` },
      });
    }
    const snapshot = await memory.snapshot(effectiveScope());
    const frozen = effectiveScope({ memorySnapshotSequence: snapshot.sequence, memorySnapshotVersionIds: snapshot.versionIds });
    const result = await memory.select(frozen, { query: "deployment query", limit: 8 });

    assert.deepEqual(result.entries.map((entry) => entry.semanticKey), ["primary", "complement", "duplicate"]);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
