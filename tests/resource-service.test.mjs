import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { ResourceService } from "../gateway/core/resources/index.mjs";

function actor(actorType = "user", actorId = "user_resource") {
  return createActorContext({
    actorType,
    actorId,
    deviceId: `device_${actorId}`,
    sessionId: `session_${actorId}`,
    roles: [],
  });
}

function idFactory() {
  let sequence = 0;
  return (kind) => `${kind}_${++sequence}`;
}

function fixtureOptions(dataRoot, currentActor, overrides = {}) {
  const allowed = new Set([
    "collection:collection_a",
    "collection:collection_b",
    "project:project_a",
    "conversation:conversation_a",
  ]);
  return {
    dataRoot,
    actor: currentActor,
    parserVersion: "parser-current",
    embeddingProfileId: "embedding-qwen3",
    idFactory: idFactory(),
    authorizeOwner: async ({ ownerType, ownerId }) => allowed.has(`${ownerType}:${ownerId}`),
    extractor: {
      extract: async ({ content }) => ({ text: content.toString("utf8"), chunks: [{ id: "chunk_1", text: content.toString("utf8") }] }),
    },
    embedder: {
      embed: async ({ parsed }) => ({ profileId: "embedding-qwen3", reference: { vectorIds: [`vector:${parsed.text}`] } }),
      search: async ({ query, candidates, limit }) => candidates.slice(0, limit).map((candidate, index) => ({
        resourceVersionId: candidate.resourceVersionId,
        score: 1 - index / 10,
        chunkId: "chunk_1",
        text: `${query}:${candidate.parsed.text}`,
      })),
    },
    ...overrides,
  };
}

async function temporaryFixture(run) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-resources-"));
  try {
    return await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("ingest 先持久化 pending，再将原文件、解析结果和向量引用写入 Actor 目录", async () => {
  await temporaryFixture(async (dataRoot) => {
    const currentActor = actor();
    let service;
    let observedPending = false;
    const options = fixtureOptions(dataRoot, currentActor);
    options.extractor = {
      extract: async ({ content }) => {
        const pending = await service.inspect();
        observedPending = pending.data.versions.length === 1
          && pending.data.versions[0].parseStatus === "pending"
          && pending.data.versions[0].embeddingStatus === "pending";
        return { text: content.toString("utf8") };
      },
    };
    service = new ResourceService(options);
    const ingested = await service.ingest({
      content: Buffer.from("alpha"),
      filename: "alpha.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_a", path: "notes/alpha.txt" },
      expectedRevision: 0,
    });

    assert.equal(observedPending, true);
    assert.equal(ingested.version.parseStatus, "ready");
    assert.equal(ingested.version.embeddingStatus, "ready");
    assert.equal(ingested.version.embeddingProfileId, "embedding-qwen3");
    assert.equal(ingested.binding.ownerType, "collection");
    assert.equal(ingested.binding.path, "notes/alpha.txt");

    const root = actorDataRoot(dataRoot, currentActor);
    assert.equal((await readFile(path.join(root, ingested.blob.storagePath), "utf8")), "alpha");
    const parsed = JSON.parse(await readFile(path.join(root, "resources", "parsed", `${ingested.version.id}.json`), "utf8"));
    const vectors = JSON.parse(await readFile(path.join(root, "resources", "vectors", `${ingested.version.id}.json`), "utf8"));
    assert.deepEqual(parsed.content, { text: "alpha" });
    assert.deepEqual(vectors.content, { vectorIds: ["vector:alpha"] });
    assert.ok(path.resolve(root).startsWith(path.resolve(dataRoot)));
  });
});

test("Artifact promotion streams into a content-addressed Resource and replays without reopening the source", async () => {
  await temporaryFixture(async (dataRoot) => {
    const service = new ResourceService(fixtureOptions(dataRoot, actor()));
    const chunks = [Buffer.alloc(700_000, 0x61), Buffer.alloc(700_000, 0x62), Buffer.alloc(700_000, 0x63)];
    const content = Buffer.concat(chunks);
    const sha256 = (await import("node:crypto")).default.createHash("sha256").update(content).digest("hex");
    let opened = 0;
    const input = {
      commandId: "promote_artifact_a",
      filename: "artifact.bin.txt",
      mime: "text/plain",
      expectedSize: content.length,
      expectedSha256: sha256,
      binding: { ownerType: "project", ownerId: "project_a", path: null },
      openSource: async () => { opened += 1; return { stream: Readable.from(chunks) }; },
    };
    const first = await service.ingestStream(input);
    assert.equal(opened, 1);
    assert.equal(first.blob.sha256, sha256);
    assert.equal(first.binding.ownerType, "project");
    assert.equal(first.version.embeddingStatus, "ready");
    const replay = await service.ingestStream(input);
    assert.equal(opened, 1);
    assert.equal(replay.replayed, true);
    assert.equal(replay.version.id, first.version.id);
    assert.equal(replay.binding.id, first.binding.id);
    assert.equal((await readFile(path.join(actorDataRoot(dataRoot, actor()), first.blob.storagePath))).length, content.length);
  });
});

test("用户和访客资源严格分目录，越权 owner 与相对路径在写文件前被拒绝", async () => {
  await temporaryFixture(async (dataRoot) => {
    const user = actor("user", "same_name");
    const guest = actor("guest", "same_name");
    const userService = new ResourceService(fixtureOptions(dataRoot, user));
    const guestService = new ResourceService(fixtureOptions(dataRoot, guest));
    const userResult = await userService.ingest({
      content: "user",
      filename: "user.txt",
      mime: "text/plain",
      binding: { ownerType: "project", ownerId: "project_a" },
      expectedRevision: 0,
    });
    const guestResult = await guestService.ingest({
      content: "guest",
      filename: "guest.txt",
      mime: "text/plain",
      binding: { ownerType: "conversation", ownerId: "conversation_a" },
      expectedRevision: 0,
    });
    assert.match(path.join(actorDataRoot(dataRoot, user), userResult.blob.storagePath), /[\\/]users[\\/]same_name[\\/]/);
    assert.match(path.join(actorDataRoot(dataRoot, guest), guestResult.blob.storagePath), /[\\/]guests[\\/]same_name[\\/]/);

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-resources-reject-"));
    try {
      const service = new ResourceService(fixtureOptions(emptyRoot, user));
      await assert.rejects(() => service.ingest({
        content: "bad",
        filename: "bad.txt",
        mime: "text/plain",
        binding: { ownerType: "collection", ownerId: "collection_forbidden" },
        expectedRevision: 0,
      }), (error) => error?.code === "RESOURCE_OWNER_FORBIDDEN");
      await assert.rejects(() => service.ingest({
        content: "bad",
        filename: "bad.txt",
        mime: "text/plain",
        binding: { ownerType: "collection", ownerId: "collection_a", path: "../escape.txt" },
        expectedRevision: 0,
      }), (error) => error?.code === "RESOURCE_BINDING_PATH_INVALID");
      await assert.rejects(() => access(path.join(actorDataRoot(emptyRoot, user), "resources", "blobs")));
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

test("解析或 Embedding 失败会持久化失败状态，并可按 expectedRevision 重试", async () => {
  await temporaryFixture(async (dataRoot) => {
    const currentActor = actor();
    let attempts = 0;
    const options = fixtureOptions(dataRoot, currentActor);
    options.extractor = {
      extract: async ({ content }) => {
        attempts += 1;
        if (attempts === 1) throw new Error("parser unavailable");
        return { text: content.toString("utf8") };
      },
    };
    const service = new ResourceService(options);
    const failed = await service.ingest({
      content: "retry me",
      filename: "retry.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_a" },
      expectedRevision: 0,
    });
    assert.equal(failed.version.parseStatus, "failed");
    assert.equal(failed.version.embeddingStatus, "pending");
    assert.match(failed.version.parseError, /parser unavailable/);
    await assert.rejects(() => service.retryIndexing({ versionId: failed.version.id, expectedRevision: 0 }), (error) => error?.code === "REVISION_CONFLICT");
    const retried = await service.retryIndexing({ versionId: failed.version.id, expectedRevision: failed.revision });
    assert.equal(retried.version.parseStatus, "ready");
    assert.equal(retried.version.embeddingStatus, "ready");
    assert.equal(retried.version.parseError, null);
    assert.equal(attempts, 2);
  });
});

test("检索只向 Embedding 适配器提供已授权 Scope 内且 ready 的去重候选", async () => {
  await temporaryFixture(async (dataRoot) => {
    const currentActor = actor();
    const searchCalls = [];
    const options = fixtureOptions(dataRoot, currentActor);
    options.embedder = {
      ...options.embedder,
      search: async (input) => {
        searchCalls.push(input);
        return input.candidates.map((candidate) => ({ resourceVersionId: candidate.resourceVersionId, score: 0.8, text: candidate.parsed.text }));
      },
    };
    const service = new ResourceService(options);
    const first = await service.ingest({
      content: "collection content",
      filename: "collection.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_a" },
      expectedRevision: 0,
    });
    const linked = await service.bindVersion({
      versionId: first.version.id,
      ownerType: "project",
      ownerId: "project_a",
      expectedRevision: first.revision,
    });
    const second = await service.ingest({
      content: "conversation content",
      filename: "conversation.txt",
      mime: "text/plain",
      binding: { ownerType: "conversation", ownerId: "conversation_a" },
      expectedRevision: linked.revision,
    });

    const project = await service.search({ query: "query", scope: { projectId: "project_a" } });
    assert.equal(project.results.length, 1);
    assert.equal(project.results[0].resourceVersionId, first.version.id);
    assert.equal(searchCalls[0].candidates.length, 1);
    assert.equal(searchCalls[0].candidates[0].bindings.length, 1);

    const combined = await service.search({
      query: "query",
      scope: { selectedCollectionIds: ["collection_a"], projectId: "project_a", conversationId: "conversation_a" },
    });
    assert.equal(combined.results.length, 2);
    assert.deepEqual(new Set(combined.results.map((entry) => entry.resourceVersionId)), new Set([first.version.id, second.version.id]));
    assert.equal(searchCalls[1].candidates.length, 2);
    await assert.rejects(() => service.search({ query: "query", scope: { collectionIds: ["collection_forbidden"] } }), (error) => error?.code === "RESOURCE_OWNER_FORBIDDEN");
    await assert.rejects(() => service.search({ query: "query", scope: {} }), (error) => error?.code === "RESOURCE_SCOPE_EMPTY");
  });
});

test("删除绑定会回收孤立版本与解析文件，并只在最后引用消失后 GC 内容 Blob", async () => {
  await temporaryFixture(async (dataRoot) => {
    const currentActor = actor();
    const service = new ResourceService(fixtureOptions(dataRoot, currentActor));
    const first = await service.ingest({
      content: "same bytes",
      filename: "one.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_a" },
      expectedRevision: 0,
    });
    const second = await service.ingest({
      content: "same bytes",
      filename: "two.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_b" },
      expectedRevision: first.revision,
    });
    assert.equal(first.blob.id, second.blob.id);
    const blobPath = path.join(actorDataRoot(dataRoot, currentActor), first.blob.storagePath);

    const removedFirst = await service.removeBinding({ bindingId: first.binding.id, expectedRevision: second.revision });
    assert.equal(removedFirst.garbageCollected.versionId, first.version.id);
    assert.equal(removedFirst.garbageCollected.blobId, null);
    await access(blobPath);
    await assert.rejects(() => access(path.join(actorDataRoot(dataRoot, currentActor), "resources", "parsed", `${first.version.id}.json`)));

    const removedSecond = await service.removeBinding({ bindingId: second.binding.id, expectedRevision: removedFirst.revision });
    assert.equal(removedSecond.garbageCollected.blobId, first.blob.id);
    await assert.rejects(() => access(blobPath));
    const final = await service.inspect();
    assert.deepEqual(final.data, { blobs: [], versions: [], bindings: [] });
  });
});

test("同一服务的并发写入严格串行，过期 expectedRevision 不会覆盖先完成的写入", async () => {
  await temporaryFixture(async (dataRoot) => {
    const service = new ResourceService(fixtureOptions(dataRoot, actor()));
    const first = service.ingest({
      content: "first",
      filename: "first.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_a" },
      expectedRevision: 0,
    });
    const stale = service.ingest({
      content: "stale",
      filename: "stale.txt",
      mime: "text/plain",
      binding: { ownerType: "collection", ownerId: "collection_b" },
      expectedRevision: 0,
    });
    const [firstResult, staleResult] = await Promise.allSettled([first, stale]);
    assert.equal(firstResult.status, "fulfilled");
    assert.equal(staleResult.status, "rejected");
    assert.equal(staleResult.reason.code, "REVISION_CONFLICT");
    const state = await service.inspect();
    assert.equal(state.data.versions.length, 1);
    assert.equal(state.data.versions[0].filename, "first.txt");
  });
});
