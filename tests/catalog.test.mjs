import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { CatalogConsistencyService, CollectionService, ProjectService } from "../gateway/core/catalog/index.mjs";
import { ConversationService } from "../gateway/core/conversations/index.mjs";
import { ActorMutationQueue } from "../gateway/core/mutation-queue.mjs";
import { ResourceService } from "../gateway/core/resources/index.mjs";

const actor = createActorContext({ actorType: "user", actorId: "user_a", deviceId: "device_a", sessionId: "session_a", roles: [] });

function resourceAdapters() {
  return {
    extractor: { extract: async ({ content }) => ({ text: Buffer.from(content).toString("utf8"), chunks: [{ chunkId: "chunk_1", text: "indexed" }] }) },
    embedder: {
      embed: async () => ({ profileId: "embedding_test", reference: { vectorIds: ["vector_1"] } }),
      search: async () => [],
    },
  };
}

function catalogFixture(dataRoot, options = {}) {
  const queue = new ActorMutationQueue();
  let consistency;
  const common = { dataRoot, actor, queue };
  const collections = new CollectionService({ ...common, deleteCoordinator: (input) => consistency.deleteCollection(input) });
  const projects = new ProjectService({ ...common, collections, deleteCoordinator: (input) => consistency.deleteProject(input) });
  const conversations = new ConversationService({ ...common, cursorSecret: "catalog-test-cursor-secret-at-least-32-bytes" });
  const resources = new ResourceService({
    ...common,
    mutationQueue: queue,
    authorizeOwner: async ({ ownerType, ownerId }) => {
      if (ownerType === "collection") return Boolean(await collections.get(ownerId));
      if (ownerType === "project") return Boolean(await projects.get(ownerId));
      if (ownerType === "conversation") return Boolean(await conversations.getConversation(ownerId));
      return false;
    },
    ...resourceAdapters(),
  });
  const memoryCalls = [];
  const memories = {
    invalidateProject: async ({ projectId, commandId }) => {
      memoryCalls.push({ projectId, commandId });
      return { invalidated: 2 };
    },
  };
  consistency = new CatalogConsistencyService({ ...common, projects, collections, conversations, resources, memories, faultInjector: options.faultInjector });
  return { queue, collections, projects, conversations, resources, consistency, memoryCalls };
}

test("File sets and projects are Actor-scoped, versioned, and projects default to project-only memory", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-catalog-"));
  try {
    const { collections, projects } = catalogFixture(dataRoot);
    const collection = await collections.create({ id: "collection_a", name: "资料" });
    const project = await projects.create({ id: "project_a", name: "研究" });
    assert.equal(project.memoryMode, "project-only");
    const linked = await projects.linkCollection({ projectId: project.id, collectionId: collection.id, expectedRevision: 0 });
    assert.deepEqual(linked.collectionIds, [collection.id]);
    const global = await projects.update({ projectId: project.id, memoryMode: "global", expectedRevision: 1 });
    assert.equal(global.memoryMode, "global");
    await assert.rejects(() => projects.update({ projectId: project.id, name: "stale", expectedRevision: 0 }), (error) => error?.code === "REVISION_CONFLICT");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("project delete saga retries after a crash, moves conversations out, and removes project resources", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-catalog-"));
  let injected = false;
  try {
    const fixture = catalogFixture(dataRoot, {
      faultInjector: ({ step }) => {
        if (!injected && step === "move-conversations") {
          injected = true;
          throw Object.assign(new Error("simulated crash"), { code: "FAULT_INJECTED" });
        }
      },
    });
    const project = await fixture.projects.create({ id: "project_a", name: "研究" });
    const conversation = await fixture.conversations.sendMessage({ mode: "work", projectId: project.id, role: "user", content: "开始", expectedRevision: 0, commandId: "create_conversation" });
    const ingested = await fixture.resources.ingest({
      filename: "project.md", mime: "text/markdown", content: Buffer.from("project resource"),
      binding: { ownerType: "project", ownerId: project.id, path: null }, expectedRevision: 0,
    });
    assert.equal(ingested.binding.ownerId, project.id);

    const deletion = { projectId: project.id, expectedRevision: 0, commandId: "delete_project_a" };
    await assert.rejects(() => fixture.projects.delete(deletion), (error) => error?.code === "FAULT_INJECTED");
    assert.equal((await fixture.conversations.getConversation(conversation.conversation.id)).summary.projectId, null);
    assert.equal((await fixture.projects.get(project.id)).id, project.id);

    const completed = await fixture.projects.delete(deletion);
    assert.deepEqual(completed.movedConversationIds, [conversation.conversation.id]);
    assert.deepEqual(fixture.memoryCalls, [{ projectId: "project_a", commandId: "delete_project_a:invalidate-memory" }]);
    assert.equal(completed.cleanup.memory.invalidated, 2);
    await assert.rejects(() => fixture.projects.get(project.id), (error) => error?.code === "PROJECT_NOT_FOUND");
    assert.equal((await fixture.resources.inspect()).data.bindings.some((entry) => entry.ownerType === "project" && entry.ownerId === project.id), false);
    const replay = await fixture.projects.delete(deletion);
    assert.deepEqual(replay, completed);
    assert.equal(fixture.memoryCalls.length, 1);
    const journal = await fixture.consistency.inspectOperations();
    assert.equal(journal.data.operations.delete_project_a.status, "completed");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("project delete can permanently delete every conversation instead of moving them out", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-catalog-"));
  let injected = false;
  try {
    const fixture = catalogFixture(dataRoot, {
      faultInjector: ({ step }) => {
        if (!injected && step === "delete-conversations") {
          injected = true;
          throw Object.assign(new Error("simulated crash"), { code: "FAULT_INJECTED" });
        }
      },
    });
    const project = await fixture.projects.create({ id: "project_delete_all", name: "整组删除" });
    const first = await fixture.conversations.sendMessage({ mode: "chat", projectId: project.id, role: "user", content: "first", expectedRevision: 0, commandId: "create_first" });
    const second = await fixture.conversations.sendMessage({ mode: "work", projectId: project.id, role: "user", content: "second", expectedRevision: 0, commandId: "create_second" });

    const deletion = {
      projectId: project.id,
      expectedRevision: 0,
      commandId: "delete_project_and_conversations",
      conversationPolicy: "delete",
    };
    await assert.rejects(() => fixture.projects.delete(deletion), (error) => error?.code === "FAULT_INJECTED");
    await assert.rejects(() => fixture.conversations.getConversation(first.conversation.id), (error) => error?.code === "CONVERSATION_NOT_FOUND");
    await assert.rejects(() => fixture.conversations.getConversation(second.conversation.id), (error) => error?.code === "CONVERSATION_NOT_FOUND");
    assert.equal((await fixture.projects.get(project.id)).id, project.id);

    const completed = await fixture.projects.delete(deletion);

    assert.equal(completed.conversationPolicy, "delete");
    assert.deepEqual(new Set(completed.deletedConversationIds), new Set([first.conversation.id, second.conversation.id]));
    assert.deepEqual(completed.movedConversationIds, []);
    await assert.rejects(() => fixture.projects.get(project.id), (error) => error?.code === "PROJECT_NOT_FOUND");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("collection delete saga unlinks every project and garbage-collects only unreferenced resource entities", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "easywork-catalog-"));
  let injected = false;
  try {
    const fixture = catalogFixture(dataRoot, {
      faultInjector: ({ step }) => {
        if (!injected && step === "unlink-projects") {
          injected = true;
          throw Object.assign(new Error("simulated crash"), { code: "FAULT_INJECTED" });
        }
      },
    });
    const collection = await fixture.collections.create({ id: "collection_a", name: "资料" });
    const projectA = await fixture.projects.create({ id: "project_a", name: "A" });
    const projectB = await fixture.projects.create({ id: "project_b", name: "B" });
    await fixture.projects.linkCollection({ projectId: projectA.id, collectionId: collection.id, expectedRevision: 0 });
    await fixture.projects.linkCollection({ projectId: projectB.id, collectionId: collection.id, expectedRevision: 0 });
    await fixture.resources.ingest({
      filename: "collection.txt", mime: "text/plain", content: Buffer.from("collection resource"),
      binding: { ownerType: "collection", ownerId: collection.id, path: "folder/collection.txt" }, expectedRevision: 0,
    });

    const deletion = { collectionId: collection.id, expectedRevision: 0, commandId: "delete_collection_a" };
    await assert.rejects(() => fixture.collections.delete(deletion), (error) => error?.code === "FAULT_INJECTED");
    assert.deepEqual((await fixture.projects.get(projectA.id)).collectionIds, []);
    assert.deepEqual((await fixture.projects.get(projectB.id)).collectionIds, []);
    const completed = await fixture.collections.delete(deletion);
    assert.deepEqual(new Set(completed.unlinkedProjectIds), new Set([projectA.id, projectB.id]));
    await assert.rejects(() => fixture.collections.get(collection.id), (error) => error?.code === "COLLECTION_NOT_FOUND");
    const resources = await fixture.resources.inspect();
    assert.equal(resources.data.bindings.length, 0);
    assert.equal(resources.data.versions.length, 0);
    assert.equal(resources.data.blobs.length, 0);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});


test("catalog create and update recover an interrupted index publication on read and idempotent retry", async (t) => {
  const dataRoot=await mkdtemp(path.join(os.tmpdir(),"easywork-catalog-repair-"));t.after(()=>rm(dataRoot,{recursive:true,force:true}));
  const fixture=catalogFixture(dataRoot);
  for (const kind of ["collection","project"]) {
    const service=kind==="collection"?fixture.collections:fixture.projects;
    const create={id:kind+"_recovery",name:"before"};const original=service.updateIndex;
    service.updateIndex=async()=>{throw Object.assign(new Error("disk fault"),{code:"TEST_INDEX_FAULT"});};
    await assert.rejects(()=>service.create(create),{code:"TEST_INDEX_FAULT"});
    service.updateIndex=original;
    const fresh=catalogFixture(dataRoot);const recovered=kind==="collection"?fresh.collections:fresh.projects;
    assert.equal((await recovered.list()).find((item)=>item.id===create.id)?.name,"before");
    assert.equal((await recovered.create(create)).id,create.id);
    const update={ [kind+"Id"]:create.id,name:"after",expectedRevision:0};const method=kind==="collection"?"rename":"update";
    const write=recovered.updateIndex;recovered.updateIndex=async()=>{throw Object.assign(new Error("disk fault"),{code:"TEST_INDEX_FAULT"});};
    await assert.rejects(()=>recovered[method](update),{code:"TEST_INDEX_FAULT"});recovered.updateIndex=write;
    assert.equal((await recovered.get(create.id)).name,"after");
    assert.equal((await recovered.list()).find((item)=>item.id===create.id)?.name,"after");
    assert.equal((await recovered[method](update)).revision,1);
  }
});
