import crypto from "node:crypto";

import { AsyncLocalStorage } from "node:async_hooks";
import { invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const clone = (value) => structuredClone(value);

function asDate(clock) {
  const value = (clock || (() => new Date()))();
  return value instanceof Date ? value : new Date(value);
}

function assertId(value, field) {
  const id = String(value || "");
  invariant(ID_PATTERN.test(id), "CATALOG_ID_INVALID", `${field} 格式无效`, { status: 400 });
  return id;
}

function assertName(value, field) {
  const name = String(value || "").trim();
  invariant(name.length > 0 && name.length <= 256, "CATALOG_NAME_INVALID", `${field} 长度无效`, { status: 400 });
  return name;
}

function assertCommandId(value) {
  const commandId = String(value || "");
  invariant(ID_PATTERN.test(commandId), "CATALOG_COMMAND_ID_INVALID", "commandId 格式无效", { status: 400 });
  return commandId;
}

function assertRevision(actual, expected) {
  invariant(Number.isSafeInteger(expected), "EXPECTED_REVISION_REQUIRED", "操作必须提供 expectedRevision", { status: 428 });
  invariant(actual === expected, "REVISION_CONFLICT", "数据已被其他操作更新", { status: 409, details: { expectedRevision: expected, actualRevision: actual } });
}

function validateIndex(data) {
  return Boolean(data && typeof data === "object" && !Array.isArray(data) && data.items && typeof data.items === "object" && !Array.isArray(data.items));
}

class ActorCatalogBase {
  #context = new AsyncLocalStorage();
  constructor({ dataRoot, actor, queue, clock }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue || defaultActorMutationQueue;
    this.clock = clock;
  }

  timestamp() {
    return asDate(this.clock).toISOString();
  }

  async serialized(operation, request = null) {
    return this.queue.run(this.actor, async () => {
      await this.recover();
      const fingerprint = request && !(request.operation === "create" && !request.input?.id) ? crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex") : null;
      if (fingerprint) {
        const receipt = (await this.transactions().read()).data.receipts.find((item) => item.fingerprint === fingerprint);
        if (receipt) return clone(receipt.result);
      }
      return this.#context.run(fingerprint, operation);
    });
  }

  transactions() {
    return new AtomicJsonRepository({ dataRoot: this.dataRoot, actor: this.actor, relativePath: ["catalog", `${this.kind}-transactions.json`], schemaVersion: 1,
      defaultData: () => ({ pending: null, receipts: [] }), validate: (data) => data && Array.isArray(data.receipts) && (data.pending === null || typeof data.pending === "object"), queue: this.queue });
  }

  async commitEntity(current, next) {
    const repository = this.transactions();
    const journal = await repository.read();
    const pending = { id: next.id, before: current.data[this.kind], next: clone(next), fingerprint: this.#context.getStore() };
    await repository.replace({ ...journal.data, pending }, { expectedRevision: journal.revision });
    await this.recover();
  }

  async recover() {
    if (!this.kind) return;
    const repository = this.transactions();
    const journal = await repository.read();
    const pending = journal.data.pending;
    if (!pending) return;
    const entityRepository = this.itemRepository(pending.id);
    const current = await entityRepository.read();
    const item = current.data[this.kind];
    invariant(JSON.stringify(item) === JSON.stringify(pending.before) || JSON.stringify(item) === JSON.stringify(pending.next), "CATALOG_RECOVERY_CONFLICT", "目录事务恢复遇到更新冲突", { status: 409 });
    if (JSON.stringify(item) !== JSON.stringify(pending.next)) await entityRepository.replace({ [this.kind]: pending.next }, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
    await this.updateIndex(this.indexRepository(), (data) => {
      if (pending.next.deletedAt) delete data.items[pending.id];
      else data.items[pending.id] = clone(pending.next);
    });
    const receipts = [...journal.data.receipts, ...(pending.fingerprint ? [{ fingerprint: pending.fingerprint, result: clone(pending.next) }] : [])].slice(-1024);
    await repository.replace({ pending: null, receipts }, { expectedRevision: journal.revision });
  }

  async updateIndex(repository, mutate) {
    const current = await repository.read();
    return repository.update(mutate, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
  }
}

function validateCollection(data, id, actorId) {
  const item = data?.collection;
  if (item === null) return true;
  return Boolean(item && item.id === id && item.actorId === actorId && Number.isSafeInteger(item.revision)
    && typeof item.name === "string" && item.createdAt && item.updatedAt && (item.deletedAt === null || typeof item.deletedAt === "string"));
}

export class CollectionService extends ActorCatalogBase {
  constructor(options) {
    super(options);
    this.kind = "collection";
    this.itemRepository = (id) => this.#item(id);
    this.indexRepository = () => this.#index();
    this.deleteCoordinator = options?.deleteCoordinator || null;
  }

  #index() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot, actor: this.actor, relativePath: ["resources", "collections", "index.json"], schemaVersion: 1,
      defaultData: () => ({ items: {} }), validate: validateIndex, queue: this.queue,
    });
  }

  #item(idValue) {
    const id = assertId(idValue, "collectionId");
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot, actor: this.actor, relativePath: ["resources", "collections", id, "metadata.json"], schemaVersion: 1,
      defaultData: () => ({ collection: null }), validate: (data) => validateCollection(data, id, this.actor.actorId), queue: this.queue,
    });
  }

  async create(input) {
    return this.serialized(async () => {
      const id = assertId(input?.id || `collection_${crypto.randomUUID()}`, "collectionId");
      const repository = this.#item(id);
      const current = await repository.read();
      invariant(current.data.collection === null, "COLLECTION_EXISTS", "文件集已存在", { status: 409 });
      const now = this.timestamp();
      const collection = { schemaVersion: 1, id, actorId: this.actor.actorId, revision: 0, name: assertName(input?.name, "文件集名称"), createdAt: now, updatedAt: now, deletedAt: null };
      await this.commitEntity(current, collection);
      return clone(collection);
    }, { operation: "create", input });
  }

  async get(idValue, options = {}) {
    return this.serialized(async () => {
    const id = assertId(idValue, "collectionId");
    const collection = (await this.#item(id).read()).data.collection;
    invariant(collection && (options.includeDeleted || !collection.deletedAt), "COLLECTION_NOT_FOUND", "文件集不存在", { status: 404 });
    return clone(collection);
    });
  }

  async list() {
    return this.serialized(async () => {
    const state = await this.#index().read();
    return Object.values(state.data.items).filter((item) => !item.deletedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).map(clone);
    });
  }

  async rename(input) {
    return this.serialized(async () => {
      const id = assertId(input?.collectionId, "collectionId");
      const repository = this.#item(id);
      const current = await repository.read();
      const collection = current.data.collection;
      invariant(collection && !collection.deletedAt, "COLLECTION_NOT_FOUND", "文件集不存在", { status: 404 });
      assertRevision(collection.revision, input.expectedRevision);
      const next = { ...collection, name: assertName(input.name, "文件集名称"), revision: collection.revision + 1, updatedAt: this.timestamp() };
      await this.commitEntity(current, next);
      return clone(next);
    }, { operation: "rename", input });
  }

  async delete(input) {
    return this.serialized(async () => {
      invariant(typeof this.deleteCoordinator === "function", "COLLECTION_DELETE_COORDINATOR_REQUIRED", "文件集删除必须通过一致性协调器", { status: 500, expose: false });
      const id = assertId(input?.collectionId, "collectionId");
      const repository = this.#item(id);
      const current = await repository.read();
      const collection = current.data.collection;
      invariant(collection, "COLLECTION_NOT_FOUND", "文件集不存在", { status: 404 });
      const expectedRevision = Number(input?.expectedRevision);
      invariant(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "EXPECTED_REVISION_REQUIRED", "操作必须提供 expectedRevision", { status: 428 });
      if (!collection.deletedAt) assertRevision(collection.revision, expectedRevision);
      const commandId = assertCommandId(input?.commandId);
      return this.deleteCoordinator({
        input: { collectionId: id, expectedRevision, commandId },
        collection: clone(collection),
        finalize: async () => {
          const latest = await repository.read();
          const value = latest.data.collection;
          invariant(value, "COLLECTION_NOT_FOUND", "文件集不存在", { status: 404 });
          if (value.deletedAt) {
            invariant(value.revision === expectedRevision + 1, "REVISION_CONFLICT", "文件集已由其他操作删除", { status: 409 });
            await this.updateIndex(this.#index(), (data) => { delete data.items[id]; });
            return clone(value);
          }
          assertRevision(value.revision, expectedRevision);
          const deletedAt = this.timestamp();
          const next = { ...value, revision: value.revision + 1, updatedAt: deletedAt, deletedAt };
          await repository.replace({ collection: next }, { expectedRevision: latest.revision, clock: () => asDate(this.clock) });
          await this.updateIndex(this.#index(), (data) => { delete data.items[id]; });
          return clone(next);
        },
      });
    });
  }
}

function validateProject(data, id, actorId) {
  const item = data?.project;
  if (item === null) return true;
  return Boolean(item && item.id === id && item.actorId === actorId && Number.isSafeInteger(item.revision)
    && typeof item.name === "string" && ["project-only", "global"].includes(item.memoryMode)
    && Array.isArray(item.collectionIds) && new Set(item.collectionIds).size === item.collectionIds.length
    && item.createdAt && item.updatedAt && (item.deletedAt === null || typeof item.deletedAt === "string"));
}

export class ProjectService extends ActorCatalogBase {
  constructor(options) {
    super(options);
    this.kind = "project";
    this.itemRepository = (id) => this.#item(id);
    this.indexRepository = () => this.#index();
    invariant(options?.collections && typeof options.collections.get === "function", "PROJECT_COLLECTION_SERVICE_REQUIRED", "ProjectService 需要 CollectionService", { status: 500, expose: false });
    this.collections = options.collections;
    this.deleteCoordinator = options?.deleteCoordinator || null;
  }

  #index() {
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot, actor: this.actor, relativePath: ["projects", "index.json"], schemaVersion: 1,
      defaultData: () => ({ items: {} }), validate: validateIndex, queue: this.queue,
    });
  }

  #item(idValue) {
    const id = assertId(idValue, "projectId");
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot, actor: this.actor, relativePath: ["projects", id, "project.json"], schemaVersion: 1,
      defaultData: () => ({ project: null }), validate: (data) => validateProject(data, id, this.actor.actorId), queue: this.queue,
    });
  }

  async create(input) {
    return this.serialized(async () => {
      const id = assertId(input?.id || `project_${crypto.randomUUID()}`, "projectId");
      const repository = this.#item(id);
      const current = await repository.read();
      invariant(current.data.project === null, "PROJECT_EXISTS", "项目已存在", { status: 409 });
      const now = this.timestamp();
      const project = {
        schemaVersion: 1, id, actorId: this.actor.actorId, revision: 0, name: assertName(input?.name, "项目名称"),
        memoryMode: input?.memoryMode || "project-only", collectionIds: [], createdAt: now, updatedAt: now, deletedAt: null,
      };
      invariant(["project-only", "global"].includes(project.memoryMode), "PROJECT_MEMORY_MODE_INVALID", "项目记忆范围无效", { status: 400 });
      await this.commitEntity(current, project);
      return clone(project);
    }, { operation: "create", input });
  }

  async get(idValue, options = {}) {
    const id = assertId(idValue, "projectId");
    return this.serialized(async () => {
    const project = (await this.#item(id).read()).data.project;
    invariant(project && (options.includeDeleted || !project.deletedAt), "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
    return clone(project);
    });
  }

  async list() {
    return this.serialized(async () => {
      const state = await this.#index().read();
      return Object.values(state.data.items).filter((item) => !item.deletedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).map(clone);
    });
  }

  async update(input) {
    return this.serialized(async () => {
      const id = assertId(input?.projectId, "projectId");
      const repository = this.#item(id);
      const current = await repository.read();
      const project = current.data.project;
      invariant(project && !project.deletedAt, "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
      assertRevision(project.revision, input.expectedRevision);
      const memoryMode = input.memoryMode === undefined ? project.memoryMode : String(input.memoryMode);
      invariant(["project-only", "global"].includes(memoryMode), "PROJECT_MEMORY_MODE_INVALID", "项目记忆范围无效", { status: 400 });
      const next = {
        ...project,
        name: input.name === undefined ? project.name : assertName(input.name, "项目名称"),
        memoryMode,
        revision: project.revision + 1,
        updatedAt: this.timestamp(),
      };
      await this.commitEntity(current, next);
      return clone(next);
    }, { operation: "update", input });
  }

  async linkCollection(input) {
    const collectionId = assertId(input?.collectionId, "collectionId");
    return this.#changeCollection(input, collectionId, true);
  }

  async unlinkCollection(input) {
    return this.#changeCollection(input, assertId(input?.collectionId, "collectionId"), false);
  }

  async #changeCollection(input, collectionId, linked) {
    return this.serialized(async () => {
      if (linked) await this.collections.get(collectionId);
      const id = assertId(input?.projectId, "projectId");
      const repository = this.#item(id);
      const current = await repository.read();
      const project = current.data.project;
      invariant(project && !project.deletedAt, "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
      assertRevision(project.revision, input.expectedRevision);
      const collectionIds = linked ? [...new Set([...project.collectionIds, collectionId])] : project.collectionIds.filter((value) => value !== collectionId);
      const next = { ...project, collectionIds, revision: project.revision + 1, updatedAt: this.timestamp() };
      await this.commitEntity(current, next);
      return clone(next);
    }, { operation: "change-collection", input, collectionId, linked });
  }

  async delete(input) {
    return this.serialized(async () => {
      invariant(typeof this.deleteCoordinator === "function", "PROJECT_DELETE_COORDINATOR_REQUIRED", "项目删除必须通过一致性协调器", { status: 500, expose: false });
      const id = assertId(input?.projectId, "projectId");
      const conversationPolicy = input?.conversationPolicy === undefined ? "move-out" : String(input.conversationPolicy);
      invariant(["move-out", "delete"].includes(conversationPolicy), "PROJECT_DELETE_CONVERSATION_POLICY_INVALID", "项目对话删除方式无效", { status: 400 });
      const repository = this.#item(id);
      const current = await repository.read();
      const project = current.data.project;
      invariant(project, "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
      const expectedRevision = Number(input?.expectedRevision);
      invariant(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "EXPECTED_REVISION_REQUIRED", "操作必须提供 expectedRevision", { status: 428 });
      if (!project.deletedAt) assertRevision(project.revision, expectedRevision);
      const commandId = assertCommandId(input?.commandId);
      return this.deleteCoordinator({
        // Keep the established move-out command fingerprint unchanged so
        // deletion journals created by earlier versions remain replayable.
        input: {
          projectId: id,
          expectedRevision,
          commandId,
          ...(conversationPolicy === "delete" ? { conversationPolicy } : {}),
        },
        project: clone(project),
        finalize: async () => {
          const latest = await repository.read();
          const value = latest.data.project;
          invariant(value, "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
          if (value.deletedAt) {
            invariant(value.revision === expectedRevision + 1, "REVISION_CONFLICT", "项目已由其他操作删除", { status: 409 });
            await this.updateIndex(this.#index(), (data) => { delete data.items[id]; });
            return clone(value);
          }
          assertRevision(value.revision, expectedRevision);
          const deletedAt = this.timestamp();
          const next = { ...value, revision: value.revision + 1, updatedAt: deletedAt, deletedAt };
          await repository.replace({ project: next }, { expectedRevision: latest.revision, clock: () => asDate(this.clock) });
          await this.updateIndex(this.#index(), (data) => { delete data.items[id]; });
          return clone(next);
        },
      });
    });
  }
}
