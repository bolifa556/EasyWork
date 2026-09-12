import crypto from "node:crypto";

import { invariant } from "../errors.mjs";
import { AtomicJsonRepository } from "../repository.mjs";

const SCHEMA_VERSION = 1;
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function validateJournal(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.operations || typeof data.operations !== "object" || Array.isArray(data.operations)) return false;
  return Object.values(data.operations).every((entry) => entry
    && entry.schemaVersion === SCHEMA_VERSION
    && ["project.delete", "collection.delete"].includes(entry.kind)
    && ["running", "failed", "completed"].includes(entry.status)
    && typeof entry.commandId === "string"
    && typeof entry.fingerprint === "string"
    && entry.input && typeof entry.input === "object"
    && entry.steps && typeof entry.steps === "object"
    && (entry.result === null || typeof entry.result === "object"));
}

function fingerprint(kind, input) {
  return crypto.createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");
}

function errorSummary(error) {
  return {
    code: String(error?.code || "CATALOG_DELETE_FAILED").slice(0, 128),
    message: String(error?.message || "目录实体删除失败").slice(0, 1024),
  };
}

async function allProjectConversations(conversations, projectId) {
  const items = [];
  let cursor = null;
  do {
    const page = await conversations.listConversations({ projectId, cursor: cursor || undefined, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/**
 * Actor-local deletion saga. Logical references are removed before the catalog
 * tombstone is committed. Each action is idempotent, so a crash between an
 * action and its journal checkpoint is repaired by replaying the same command.
 */
export class CatalogConsistencyService {
  constructor(options) {
    invariant(options?.actor?.actorId, "ACTOR_CONTEXT_REQUIRED", "CatalogConsistencyService 需要 ActorContext", { status: 500, expose: false });
    invariant(options?.projects && options?.collections && options?.conversations && options?.resources && typeof options?.memories?.invalidateProject === "function", "CATALOG_CONSISTENCY_DEPENDENCIES_REQUIRED", "目录一致性服务依赖不完整", { status: 500, expose: false });
    this.actor = options.actor;
    this.projects = options.projects;
    this.collections = options.collections;
    this.conversations = options.conversations;
    this.deleteConversation = options.deleteConversation || ((input) => this.conversations.delete(input));
    this.resources = options.resources;
    this.memories = options.memories;
    this.clock = options.clock || (() => new Date());
    this.faultInjector = options.faultInjector || null;
    this.repository = new AtomicJsonRepository({
      dataRoot: options.dataRoot,
      actor: options.actor,
      relativePath: ["catalog", "operations.json"],
      schemaVersion: SCHEMA_VERSION,
      defaultData: () => ({ operations: {} }),
      validate: validateJournal,
      queue: options.queue,
    });
  }

  #timestamp() {
    const value = this.clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async #update(mutator) {
    const current = await this.repository.read();
    return this.repository.update(mutator, { expectedRevision: current.revision, clock: this.clock });
  }

  async #begin(kind, input) {
    const commandId = String(input.commandId || "");
    const operationFingerprint = fingerprint(kind, input);
    let existing = (await this.repository.read()).data.operations[commandId] || null;
    if (existing) {
      invariant(existing.kind === kind && existing.fingerprint === operationFingerprint, "CATALOG_COMMAND_REUSED", "commandId 已用于其他目录操作", { status: 409 });
      if (existing.status === "completed") return { operation: existing, replay: true, resumed: true };
      await this.#update((data) => {
        data.operations[commandId] = { ...data.operations[commandId], status: "running", lastError: null, updatedAt: this.#timestamp() };
      });
      existing = (await this.repository.read()).data.operations[commandId];
      return { operation: existing, replay: false, resumed: true };
    }
    const now = this.#timestamp();
    const operation = {
      schemaVersion: SCHEMA_VERSION,
      commandId,
      kind,
      fingerprint: operationFingerprint,
      input: clone(input),
      status: "running",
      steps: {},
      result: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    await this.#update((data) => { data.operations[commandId] = clone(operation); });
    return { operation, replay: false, resumed: false };
  }

  async #step(operation, name, action, prepare = null) {
    let latest = (await this.repository.read()).data.operations[operation.commandId];
    if (latest?.steps?.[name]?.completedAt) return clone(latest.steps[name].result);
    if (!latest?.steps?.[name]) {
      const plan = prepare ? await prepare() : null;
      await this.#update((data) => {
        data.operations[operation.commandId].steps[name] = { startedAt: this.#timestamp(), plan: clone(plan), completedAt: null, result: null };
        data.operations[operation.commandId].updatedAt = this.#timestamp();
      });
      latest = (await this.repository.read()).data.operations[operation.commandId];
    }
    const result = await action(clone(latest.steps[name].plan));
    if (this.faultInjector) await this.faultInjector({ operation: clone(latest || operation), step: name, phase: "after-action" });
    await this.#update((data) => {
      data.operations[operation.commandId].steps[name] = { ...data.operations[operation.commandId].steps[name], completedAt: this.#timestamp(), result: clone(result ?? null) };
      data.operations[operation.commandId].updatedAt = this.#timestamp();
    });
    return clone(result);
  }

  async #complete(operation, result) {
    await this.#update((data) => {
      const entry = data.operations[operation.commandId];
      entry.status = "completed";
      entry.result = clone(result);
      entry.lastError = null;
      entry.updatedAt = this.#timestamp();
      entry.completedAt = this.#timestamp();
    });
    return clone(result);
  }

  async #failed(operation, error) {
    await this.#update((data) => {
      const entry = data.operations[operation.commandId];
      entry.status = "failed";
      entry.lastError = errorSummary(error);
      entry.updatedAt = this.#timestamp();
    }).catch(() => undefined);
  }

  async deleteProject({ input, project, finalize }) {
    const started = await this.#begin("project.delete", input);
    if (started.replay) return clone(started.operation.result);
    const operation = started.operation;
    try {
      invariant(!project.deletedAt || started.resumed, "PROJECT_ALREADY_DELETED", "项目已被删除", { status: 409 });
      const conversationPolicy = input.conversationPolicy === "delete" ? "delete" : "move-out";
      const handledConversations = await this.#step(operation, conversationPolicy === "delete" ? "delete-conversations" : "move-conversations", async (plan) => {
        for (const planned of plan.conversations) {
          let current;
          try {
            current = await this.conversations.getConversation(planned.id);
          } catch (error) {
            if (conversationPolicy === "delete" && error?.code === "CONVERSATION_NOT_FOUND") continue;
            throw error;
          }
          if (conversationPolicy === "move-out" && current.summary.projectId === null) continue;
          invariant(current.summary.projectId === input.projectId, "PROJECT_DELETE_CONVERSATION_MOVED", "项目删除期间对话被移至其他项目", { status: 409 });
          if (conversationPolicy === "delete") {
            await this.deleteConversation({
              conversationId: planned.id,
              expectedRevision: current.summary.revision,
              commandId: `${input.commandId}:delete:${planned.id}`,
            });
          } else {
            await this.conversations.moveToProject({
              conversationId: planned.id,
              projectId: null,
              expectedRevision: current.summary.revision,
              commandId: `${input.commandId}:move:${planned.id}`,
            });
          }
        }
        return { conversationIds: plan.conversations.map((entry) => entry.id) };
      }, async () => ({ conversations: (await allProjectConversations(this.conversations, input.projectId)).map((entry) => ({ id: entry.id })) }));
      const cleanup = await this.#step(operation, "remove-resource-bindings", () => this.resources.removeOwnerBindings({ ownerType: "project", ownerId: input.projectId }));
      const memoryCleanup = await this.#step(operation, "invalidate-project-memory", () => this.memories.invalidateProject({
        projectId: input.projectId,
        commandId: `${input.commandId}:invalidate-memory`,
      }));
      const deletedProject = await this.#step(operation, "tombstone", finalize);
      return this.#complete(operation, {
        project: deletedProject,
        cleanup: { ownerType: "project", ownerId: input.projectId, ...cleanup, memory: memoryCleanup },
        conversationPolicy,
        movedConversationIds: conversationPolicy === "move-out" ? handledConversations?.conversationIds || [] : [],
        deletedConversationIds: conversationPolicy === "delete" ? handledConversations?.conversationIds || [] : [],
        commandId: input.commandId,
      });
    } catch (error) {
      await this.#failed(operation, error);
      throw error;
    }
  }

  async deleteCollection({ input, collection, finalize }) {
    const started = await this.#begin("collection.delete", input);
    if (started.replay) return clone(started.operation.result);
    const operation = started.operation;
    try {
      invariant(!collection.deletedAt || started.resumed, "COLLECTION_ALREADY_DELETED", "文件集已被删除", { status: 409 });
      const unlinked = await this.#step(operation, "unlink-projects", async (plan) => {
        for (const planned of plan.projects) {
          const projectEntry = await this.projects.get(planned.id);
          if (!projectEntry.collectionIds.includes(input.collectionId)) continue;
          await this.projects.unlinkCollection({
            projectId: projectEntry.id,
            collectionId: input.collectionId,
            expectedRevision: projectEntry.revision,
          });
        }
        return { projectIds: plan.projects.map((entry) => entry.id) };
      }, async () => ({ projects: (await this.projects.list()).filter((entry) => entry.collectionIds.includes(input.collectionId)).map((entry) => ({ id: entry.id })) }));
      const cleanup = await this.#step(operation, "remove-resource-bindings", () => this.resources.removeOwnerBindings({ ownerType: "collection", ownerId: input.collectionId }));
      const deletedCollection = await this.#step(operation, "tombstone", finalize);
      return this.#complete(operation, {
        collection: deletedCollection,
        cleanup: { ownerType: "collection", ownerId: input.collectionId, ...cleanup },
        unlinkedProjectIds: unlinked?.projectIds || [],
        commandId: input.commandId,
      });
    } catch (error) {
      await this.#failed(operation, error);
      throw error;
    }
  }

  async recoverPending() {
    const operations = Object.values((await this.repository.read()).data.operations)
      .filter((entry) => entry.status !== "completed")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const results = [];
    for (const operation of operations) {
      try {
        const result = operation.kind === "project.delete"
          ? await this.projects.delete(operation.input)
          : await this.collections.delete(operation.input);
        results.push({ commandId: operation.commandId, status: "completed", result });
      } catch (error) {
        results.push({ commandId: operation.commandId, status: "failed", error: errorSummary(error) });
      }
    }
    return results;
  }

  async inspectOperations() {
    return this.repository.read();
  }
}
