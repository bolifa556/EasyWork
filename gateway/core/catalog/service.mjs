import crypto from "node:crypto";

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
  constructor({ dataRoot, actor, queue, clock }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue || defaultActorMutationQueue;
    this.clock = clock;
  }

  timestamp() {
    return asDate(this.clock).toISOString();
  }

  async serialized(operation) {
    return this.queue.run(this.actor, operation);
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
      await repository.replace({ collection }, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
      await this.updateIndex(this.#index(), (data) => { data.items[id] = clone(collection); });
      return clone(collection);
    });
  }

  async get(idValue, options = {}) {
    const id = assertId(idValue, "collectionId");
    const collection = (await this.#item(id).read()).data.collection;
    invariant(collection && (options.includeDeleted || !collection.deletedAt), "COLLECTION_NOT_FOUND", "文件集不存在", { status: 404 });
    return clone(collection);
  }

  async list() {
    const state = await this.#index().read();
    return Object.values(state.data.items).filter((item) => !item.deletedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).map(clone);
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
      await repository.replace({ collection: next }, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
      await this.updateIndex(this.#index(), (data) => { data.items[id] = clone(next); });
      return clone(next);
    });
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
      await repository.replace({ project }, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
      await this.updateIndex(this.#index(), (data) => { data.items[id] = clone(project); });
      return clone(project);
    });
  }

  async get(idValue, options = {}) {
    const id = assertId(idValue, "projectId");
    const project = (await this.#item(id).read()).data.project;
    invariant(project && (options.includeDeleted || !project.deletedAt), "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
    return clone(project);
  }

  async list() {
    const state = await this.#index().read();
    return Object.values(state.data.items).filter((item) => !item.deletedAt).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).map(clone);
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
      await repository.replace({ project: next }, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
      await this.updateIndex(this.#index(), (data) => { data.items[id] = clone(next); });
      return clone(next);
    });
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
      await repository.replace({ project: next }, { expectedRevision: current.revision, clock: () => asDate(this.clock) });
      await this.updateIndex(this.#index(), (data) => { data.items[id] = clone(next); });
      return clone(next);
    });
  }

  async delete(input) {
    return this.serialized(async () => {
      invariant(typeof this.deleteCoordinator === "function", "PROJECT_DELETE_COORDINATOR_REQUIRED", "项目删除必须通过一致性协调器", { status: 500, expose: false });
      const id = assertId(input?.projectId, "projectId");
      const repository = this.#item(id);
      const current = await repository.read();
      const project = current.data.project;
      invariant(project, "PROJECT_NOT_FOUND", "项目不存在", { status: 404 });
      const expectedRevision = Number(input?.expectedRevision);
      invariant(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, "EXPECTED_REVISION_REQUIRED", "操作必须提供 expectedRevision", { status: 428 });
      if (!project.deletedAt) assertRevision(project.revision, expectedRevision);
      const commandId = assertCommandId(input?.commandId);
      return this.deleteCoordinator({
        input: { projectId: id, expectedRevision, commandId },
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
