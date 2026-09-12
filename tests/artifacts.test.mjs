import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { ArtifactService } from "../gateway/core/artifacts/index.mjs";
import { createTask } from "../gateway/core/entities/task.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { PreviewService } from "../gateway/core/previews/index.mjs";
import { ActorServiceContainer } from "../gateway/core/runtime/services.mjs";

const TOKEN_SECRET = "artifact-tests-use-a-dedicated-opaque-secret-2026";
const SERVER_IDENTITY = `ssh_${"a".repeat(43)}`;

function actor(actorType = "user", actorId = "artifact_owner") {
  return createActorContext({
    actorType,
    actorId,
    deviceId: `device_${actorId}`,
    sessionId: `session_${actorId}`,
    roles: [],
  });
}

function clockFixture(start = "2026-08-10T00:00:00.000Z") {
  let value = Date.parse(start);
  return {
    clock: () => new Date(value++),
    set(iso) { value = Date.parse(iso); },
    peek() { return new Date(value).toISOString(); },
  };
}

function idFactory() {
  let value = 0;
  return (kind) => `${kind}_${++value}`;
}

function task(currentActor, clock, overrides = {}) {
  return createTask({
    id: overrides.id || "task_a",
    actorId: currentActor.actorId,
    conversationId: overrides.conversationId || "conversation_a",
    branchId: "main",
    sourceMessageId: "message_source_a",
    conversationRunId: "conversation_run_a",
    goal: "Create an artifact",
    route: {
      serverId: "server_a",
      serverIdentity: SERVER_IDENTITY,
      workspaceId: overrides.workspaceId || "workspace_a",
      agentId: "codex",
      providerId: "provider_agent",
      modelId: "model-agent-1",
    },
    contextSessionId: "context_a",
    agentBindingId: "binding_a",
    skillPins: [],
    resourceBindingSnapshotId: "resource_snapshot_a",
    versionCheckpointId: null,
    budgets: {
      maxWallTimeMs: 60_000,
      maxInputTokens: 10_000,
      maxOutputTokens: 4_000,
      maxToolCalls: 20,
    },
    idempotencyKey: `create_${overrides.id || "task_a"}`,
  }, { clock });
}

function hostEvent(sequence, overrides = {}) {
  return {
    kind: "artifact",
    phase: "completed",
    sequence,
    payload: {
      source: "host",
      content: "artifact body\n",
      name: "report.txt",
      kind: "report",
      mime: "text/plain",
      ...overrides,
    },
  };
}

function remoteEvent(sequence, overrides = {}) {
  return {
    kind: "artifact",
    phase: "completed",
    sequence,
    payload: {
      source: "remote",
      path: "/srv/work/private/run/report.bin",
      name: "report.bin",
      kind: "file",
      ...overrides,
    },
  };
}

function serviceOptions(dataRoot, currentActor, clock, overrides = {}) {
  return {
    dataRoot,
    actor: currentActor,
    clock,
    idFactory: idFactory(),
    cursorSecret: TOKEN_SECRET,
    authorizeTask: async ({ task: currentTask }) => currentTask.id !== "task_forbidden",
    ...overrides,
  };
}

async function fixture(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-artifacts-"));
  try {
    return await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function streamText(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("远端文件与文件卡片预览提供实际服务器名称，文件库和主机文件不带服务器标签", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const server = { profile: { id: "server_a", serverIdentity: SERVER_IDENTITY, name: "计算服务器" } };
    const remoteSource = { inspect: async () => ({ authorized: true, resolved: true, withinAllowedRoot: true, symlinkSafe: true, canonicalPath: "/srv/work/private/run/report.bin", serverIdentity: SERVER_IDENTITY, workspaceId: "workspace_a", size: 4096, sha256: "b".repeat(64), mime: "application/octet-stream", name: "report.bin" }) };
    const artifacts = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, { remoteSource }));
    const remote = await artifacts.capture({ task: task(currentActor, time.clock), event: remoteEvent(1) });
    const local = await artifacts.capture({ task: task(currentActor, time.clock), event: hostEvent(2) });
    const container = {
      artifacts,
      servers: { list: async () => [server], get: async () => server },
      workspaceFor: async () => ({ getWorkspace: async () => ({ canonicalPath: "/srv/work/private/run" }) }),
      remoteArtifactSource: async () => remoteSource,
      resources: { inspect: async () => ({ data: { versions: [{ id: "resource_a", filename: "notes.txt", revision: 1, blobId: "blob_a" }], blobs: [{ id: "blob_a", size: 12, mime: "text/plain" }] } }) },
    };
    container.previews = new PreviewService({ actor: currentActor, hostSource: ActorServiceContainer.prototype.previewHostSource.call(container), remoteSource: ActorServiceContainer.prototype.previewRemoteSource.call(container) });
    for (const source of [{ kind: "artifact", artifactId: remote.artifact.id }, { kind: "remote", serverId: "server_a", workspaceId: "workspace_a", relativePath: "report.bin" }]) {
      const descriptor = await ActorServiceContainer.prototype.createPreview.call(container, { source });
      assert.equal(descriptor.metadata.serverId, server.profile.id);
      assert.equal(descriptor.metadata.serverName, server.profile.name);
      assert.equal(JSON.stringify(descriptor).includes(SERVER_IDENTITY), false);
      assert.equal(JSON.stringify(descriptor).includes("/srv/work/private"), false);
    }
    for (const source of [{ kind: "artifact", artifactId: local.artifact.id }, { kind: "resource", resourceVersionId: "resource_a" }]) {
      const descriptor = await ActorServiceContainer.prototype.createPreview.call(container, { source });
      assert.equal(descriptor.metadata.serverName, undefined);
    }
    assert.equal(JSON.stringify(await artifacts.get({ artifactId: remote.artifact.id })).includes(SERVER_IDENTITY), false);
    const other = new ArtifactService(serviceOptions(dataRoot, actor("user", "other_actor"), time.clock));
    await assert.rejects(() => other.getSourceServerIdentity({ artifactId: remote.artifact.id }), (error) => error?.code === "ARTIFACT_NOT_FOUND");
  });
});

test("主机小文件按 Actor 隔离保存内容 hash，capture commandId 幂等且 opaque id 不携带文件信息", async () => {
  await fixture(async (dataRoot) => {
    for (const currentActor of [actor("user", "same_artifact"), actor("guest", "same_artifact")]) {
      const time = clockFixture();
      const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock));
      const currentTask = task(currentActor, time.clock);
      const captured = await service.capture({ task: currentTask, event: hostEvent(1) });
      assert.equal(captured.duplicate, false);
      assert.equal(captured.artifact.source, "host");
      assert.equal(captured.artifact.contentLocation, "host-small-file");
      assert.equal(captured.artifact.versions.length, 1);
      assert.equal(captured.artifact.size, Buffer.byteLength("artifact body\n"));
      assert.match(captured.artifact.sha256, /^[a-f0-9]{64}$/);
      assert.equal(captured.artifact.id.includes("report"), false);
      assert.equal(JSON.stringify(captured).includes("actorRelativePath"), false);

      const duplicate = await service.capture({ task: currentTask, event: hostEvent(1) });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.artifact.id, captured.artifact.id);
      await assert.rejects(() => service.capture({ task: currentTask, event: hostEvent(1, { content: "changed" }) }), (error) => error?.code === "ARTIFACT_COMMAND_REUSED");

      const blobPath = path.join(actorDataRoot(dataRoot, currentActor), "artifacts", "blobs", captured.artifact.sha256.slice(0, 2), captured.artifact.sha256);
      assert.equal(await readFile(blobPath, "utf8"), "artifact body\n");
      assert.match(blobPath, currentActor.actorType === "user" ? /[\\/]users[\\/]same_artifact[\\/]/ : /[\\/]guests[\\/]same_artifact[\\/]/);
    }
  });
});

test("远端 Artifact 必须由工作区检查器完成 realpath、symlink、scope 与 hash 验证，公开结果不泄露路径", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const inspections = [];
    const availabilityChecks = [];
    let remoteDeleted = false;
    const remoteSource = {
      async inspect(input) {
        inspections.push(structuredClone(input));
        return {
          authorized: true,
          resolved: true,
          withinAllowedRoot: true,
          symlinkSafe: true,
          canonicalPath: "/srv/work/private/run/report.bin",
          serverIdentity: SERVER_IDENTITY,
          workspaceId: "workspace_a",
          size: 4096,
          sha256: "b".repeat(64),
          mime: "application/octet-stream",
          name: "report.bin",
        };
      },
      async openReadStream({ canonicalPath, range }) {
        assert.equal(canonicalPath, "/srv/work/private/run/report.bin");
        return ReadableFrom(`remote:${range.start}-${range.endExclusive}`);
      },
      async verifyAvailable(input) {
        availabilityChecks.push(structuredClone(input));
        if (remoteDeleted) {
          const error = new Error("文件已被删除");
          error.code = "ARTIFACT_REMOTE_DELETED";
          error.status = 410;
          throw error;
        }
        return { available: true, size: input.expectedSize };
      },
    };
    const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, { remoteSource }));
    const captured = await service.capture({ task: task(currentActor, time.clock), event: remoteEvent(2, { name: "下载 report.bin（测试文件）" }) });
    assert.equal(inspections.length, 1);
    assert.equal(inspections[0].workspaceId, "workspace_a");
    assert.equal(captured.artifact.contentLocation, "remote-reference");
    assert.equal(captured.artifact.name, "report.bin");
    assert.equal(captured.artifact.expiresAt, null);
    const detail = await service.get({ artifactId: captured.artifact.id });
    const list = await service.list({ taskId: "task_a" });
    assert.equal(availabilityChecks.length, 0, "capture/get/list must not probe the remote file");
    const unexpectedBlobPath = path.join(actorDataRoot(dataRoot, currentActor), "artifacts", "blobs", "bb", "b".repeat(64));
    await assert.rejects(() => access(unexpectedBlobPath));
    const descriptor = await service.issueDownload({ artifactId: captured.artifact.id });
    assert.equal(availabilityChecks.length, 1);
    assert.equal(availabilityChecks[0].canonicalPath, "/srv/work/private/run/report.bin");
    assert.equal(availabilityChecks[0].expectedSize, 4096);
    for (const output of [captured, detail, list, descriptor]) {
      const serialized = JSON.stringify(output);
      assert.equal(serialized.includes("/srv/work/private"), false);
      assert.equal(serialized.includes("remotePath"), false);
      assert.equal(serialized.includes("canonicalPath"), false);
    }
    assert.equal(descriptor.downloadToken.includes("/srv/work/private"), false);
    const opened = await service.openDownload({ downloadToken: descriptor.downloadToken, range: { start: 4, endExclusive: 12 } });
    assert.equal(await streamText(opened.stream), "remote:4-12");
    remoteDeleted = true;
    await assert.rejects(() => service.issueDownload({ artifactId: captured.artifact.id }), (error) => error?.code === "ARTIFACT_REMOTE_DELETED" && error?.message === "文件已被删除");
    await assert.rejects(() => service.issueDownload({ artifactId: captured.artifact.id, remotePath: "/etc/shadow" }), (error) => error?.code === "ARTIFACT_INPUT_UNKNOWN_FIELD");
    await assert.rejects(() => service.openDownload({ downloadToken: descriptor.downloadToken, path: "/etc/shadow" }), (error) => error?.code === "ARTIFACT_INPUT_UNKNOWN_FIELD");
  });
});

function ReadableFrom(value) {
  return Readable.from([Buffer.from(value)]);
}

test("不安全远端路径、缺失 hash、Task 越权与 Actor 不匹配均在落盘前拒绝", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const unsafe = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, {
      remoteSource: {
        async inspect() {
          return {
            authorized: true,
            resolved: true,
            withinAllowedRoot: false,
            symlinkSafe: false,
          };
        },
      },
    }));
    await assert.rejects(() => unsafe.capture({ task: task(currentActor, time.clock), event: remoteEvent(1) }), (error) => error?.code === "ARTIFACT_REMOTE_PATH_FORBIDDEN");
    assert.equal((await unsafe.list()).total, 0);

    const missingHash = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, {
      remoteSource: {
        async inspect() {
          return {
            authorized: true,
            resolved: true,
            withinAllowedRoot: true,
            symlinkSafe: true,
            canonicalPath: "/srv/work/report",
            serverIdentity: SERVER_IDENTITY,
            workspaceId: "workspace_a",
            size: 1,
            mime: "text/plain",
          };
        },
      },
    }));
    await assert.rejects(() => missingHash.capture({ task: task(currentActor, time.clock), event: remoteEvent(2) }), (error) => error?.code === "ARTIFACT_REMOTE_HASH_REQUIRED");

    const forbiddenTask = task(currentActor, time.clock, { id: "task_forbidden" });
    await assert.rejects(() => unsafe.capture({ task: forbiddenTask, event: hostEvent(3) }), (error) => error?.code === "ARTIFACT_TASK_FORBIDDEN");
    const otherActorTask = task(actor("user", "other_owner"), time.clock);
    await assert.rejects(() => unsafe.capture({ task: otherActorTask, event: hostEvent(4) }), (error) => error?.code === "ARTIFACT_TASK_FORBIDDEN");
  });
});

test("Artifact list 使用有上限的 opaque cursor，稳定筛选并在索引变化后拒绝旧 cursor", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, { maxListLimit: 2 }));
    const currentTask = task(currentActor, time.clock);
    const ids = [];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const captured = await service.capture({ task: currentTask, event: hostEvent(sequence, { name: `${sequence}.txt`, content: `${sequence}` }) });
      ids.push(captured.artifact.id);
    }
    const first = await service.list({ limit: 2, conversationId: "conversation_a" });
    assert.equal(first.items.length, 2);
    assert.equal(first.total, 3);
    assert.ok(first.nextCursor);
    assert.equal(first.nextCursor.includes(ids[0]), false);
    const second = await service.list({ limit: 2, conversationId: "conversation_a", cursor: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    await assert.rejects(() => service.list({ limit: 3 }), (error) => error?.code === "ARTIFACT_LIST_LIMIT_INVALID");
    await assert.rejects(() => service.list({ limit: 2, taskId: "different", cursor: first.nextCursor }), (error) => error?.code === "ARTIFACT_CURSOR_FILTER_MISMATCH");

    await service.capture({ task: currentTask, event: hostEvent(4, { name: "4.txt", content: "4" }) });
    await assert.rejects(() => service.list({ limit: 2, conversationId: "conversation_a", cursor: first.nextCursor }), (error) => error?.code === "ARTIFACT_CURSOR_STALE");
  });
});

test("pin、unpin 与 delete 使用实体 revision 和 commandId，固定 Artifact 不会被直接删除", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock));
    const captured = await service.capture({ task: task(currentActor, time.clock), event: hostEvent(1) });
    const pinned = await service.pin({ artifactId: captured.artifact.id, expectedRevision: 0, commandId: "pin_a" });
    assert.equal(pinned.artifact.lifecycle, "pinned");
    assert.equal(pinned.artifact.revision, 1);
    assert.equal(pinned.artifact.expiresAt, null);
    const duplicate = await service.pin({ artifactId: captured.artifact.id, expectedRevision: 0, commandId: "pin_a" });
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(() => service.delete({ artifactId: captured.artifact.id, expectedRevision: 1, commandId: "delete_pinned" }), (error) => error?.code === "ARTIFACT_PINNED");
    await assert.rejects(() => service.unpin({ artifactId: captured.artifact.id, expectedRevision: 0, commandId: "unpin_stale" }), (error) => error?.code === "REVISION_CONFLICT");
    const unpinned = await service.unpin({ artifactId: captured.artifact.id, expectedRevision: 1, commandId: "unpin_a" });
    const deleted = await service.delete({ artifactId: captured.artifact.id, expectedRevision: unpinned.artifact.revision, commandId: "delete_a" });
    assert.equal(deleted.artifact.lifecycle, "deleted");
    assert.equal((await service.list()).total, 0);
    assert.equal((await service.list({ lifecycle: "deleted" })).total, 1);
    await assert.rejects(() => service.issueDownload({ artifactId: captured.artifact.id }), (error) => error?.code === "ARTIFACT_NOT_AVAILABLE");
  });
});

test("下载 descriptor 仅含 opaque token；host 与 remote 均按 Range 流式打开且 token 绑定 Actor 与 revision", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock));
    const captured = await service.capture({ task: task(currentActor, time.clock), event: hostEvent(1, { content: "abcdefghij" }) });
    const issued = await service.issueDownload({ artifactId: captured.artifact.id, ttlMs: 60_000 });
    assert.deepEqual(Object.keys(issued).sort(), ["artifact", "downloadToken", "expiresAt"]);
    const opened = await service.openDownload({ downloadToken: issued.downloadToken, range: { start: 2, endExclusive: 6 } });
    assert.equal(opened.contentLength, 4);
    assert.equal(await streamText(opened.stream), "cdef");
    await assert.rejects(() => service.openDownload({ downloadToken: issued.downloadToken, range: { start: 0, endExclusive: 999 } }), (error) => error?.code === "ARTIFACT_RANGE_INVALID");

    await service.pin({ artifactId: captured.artifact.id, expectedRevision: 0, commandId: "pin_for_stale" });
    await assert.rejects(() => service.openDownload({ downloadToken: issued.downloadToken }), (error) => error?.code === "ARTIFACT_DOWNLOAD_STALE");

    const other = new ArtifactService(serviceOptions(dataRoot, actor("user", "other_download_actor"), time.clock));
    await assert.rejects(() => other.openDownload({ downloadToken: issued.downloadToken }), (error) => ["CURSOR_INVALID", "ARTIFACT_DOWNLOAD_FORBIDDEN"].includes(error?.code));
    await assert.rejects(() => other.get({ artifactId: captured.artifact.id }), (error) => error?.code === "ARTIFACT_NOT_FOUND");
  });
});

test("expire 与 GC 只清理 expired/deleted 元数据和无引用 host blob，不删除 remote 源或共享 blob", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const remoteCalls = [];
    const remoteSource = {
      async inspect() {
        return {
          authorized: true,
          resolved: true,
          withinAllowedRoot: true,
          symlinkSafe: true,
          canonicalPath: "/srv/work/result.bin",
          serverIdentity: SERVER_IDENTITY,
          workspaceId: "workspace_a",
          size: 4,
          sha256: "c".repeat(64),
          mime: "application/octet-stream",
        };
      },
      async delete(...args) { remoteCalls.push(args); },
    };
    const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, { remoteSource }));
    const currentTask = task(currentActor, time.clock);
    const first = await service.capture({ task: currentTask, event: hostEvent(1, { content: "shared", name: "first.txt", expiresAt: "2026-08-10T00:00:00.100Z" }) });
    const second = await service.capture({ task: currentTask, event: hostEvent(2, { content: "shared", name: "second.txt", expiresAt: "2026-08-10T00:00:00.100Z" }) });
    const remote = await service.capture({ task: currentTask, event: remoteEvent(3, { expiresAt: "2026-08-10T00:00:00.100Z" }) });
    const pinned = await service.pin({ artifactId: second.artifact.id, expectedRevision: 0, commandId: "pin_shared" });
    assert.equal(pinned.artifact.expiresAt, null);
    time.set("2026-08-11T00:00:00.000Z");
    const expired = await service.expireDue({ commandId: "expire_due", at: "2026-08-11T00:00:00.000Z" });
    assert.deepEqual(new Set(expired.expiredArtifactIds), new Set([first.artifact.id, remote.artifact.id]));
    const blobPath = path.join(actorDataRoot(dataRoot, currentActor), "artifacts", "blobs", first.artifact.sha256.slice(0, 2), first.artifact.sha256);
    await access(blobPath);
    const collected = await service.garbageCollect({ commandId: "gc_1", before: "2026-08-12T00:00:00.000Z" });
    assert.deepEqual(new Set(collected.removedArtifactIds), new Set([first.artifact.id, remote.artifact.id]));
    assert.equal(collected.removedHostBlobCount, 0);
    await access(blobPath);
    assert.equal(remoteCalls.length, 0);
    await assert.rejects(() => service.get({ artifactId: first.artifact.id }), (error) => error?.code === "ARTIFACT_NOT_FOUND");

    const unpinned = await service.unpin({ artifactId: second.artifact.id, expectedRevision: 1, commandId: "unpin_shared", expiresAt: null });
    await service.delete({ artifactId: second.artifact.id, expectedRevision: unpinned.artifact.revision, commandId: "delete_shared" });
    const collectedLast = await service.garbageCollect({ commandId: "gc_2", before: "2026-08-13T00:00:00.000Z" });
    assert.equal(collectedLast.removedHostBlobCount, 1);
    await assert.rejects(() => access(blobPath));
    await assert.rejects(() => service.capture({ task: currentTask, event: hostEvent(2, { content: "shared", name: "second.txt", expiresAt: "2026-08-10T00:00:00.100Z" }) }), (error) => error?.code === "ARTIFACT_COMMAND_RESULT_GONE");
  });
});

test("内联大文件与未声明 source 的旧格式事件被 clean-break 契约拒绝", async () => {
  await fixture(async (dataRoot) => {
    const currentActor = actor();
    const time = clockFixture();
    const service = new ArtifactService(serviceOptions(dataRoot, currentActor, time.clock, { maxInlineBytes: 4 }));
    const currentTask = task(currentActor, time.clock);
    await assert.rejects(() => service.capture({ task: currentTask, event: hostEvent(1, { content: "12345" }) }), (error) => error?.code === "ARTIFACT_INLINE_TOO_LARGE");
    await assert.rejects(() => service.capture({
      task: currentTask,
      event: { kind: "artifact", sequence: 2, payload: { path: "/legacy/path", name: "legacy" } },
    }), (error) => error?.code === "ARTIFACT_SOURCE_INVALID");
    assert.equal((await service.list()).total, 0);
  });
});
