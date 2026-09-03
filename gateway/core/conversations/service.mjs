import crypto from "node:crypto";

import { createOpaqueCursorCodec } from "../cursor.mjs";
import { ApiError, invariant } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import {
  CONVERSATION_SCHEMA_VERSION,
  assertBranchId,
  assertCommandId,
  assertConversationId,
  assertConversationMode,
  assertExpectedConversationRevision,
  assertInputKeys,
  assertLimit,
  assertMessageContent,
  assertMessageId,
  assertMessageRole,
  assertOptionalProjectId,
  assertOptionalTaskId,
  assertTitle,
  clone,
  commandInputDigest,
  createIdentifier,
  defaultConversationTitle,
} from "./contract.mjs";
import { ConversationStorage } from "./storage.mjs";

const DIRECT_QUEUE = Object.freeze({ run: (_actor, operation) => operation() });

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  invariant(Number.isFinite(date.getTime()), "CONVERSATION_CLOCK_INVALID", "clock 返回了无效时间", { status: 500, expose: false });
  return date.toISOString();
}

function compareSummaries(left, right) {
  if (Boolean(left.deletedAt) !== Boolean(right.deletedAt)) return left.deletedAt ? 1 : -1;
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const messaged = right.lastMessageAt.localeCompare(left.lastMessageAt);
  return messaged || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

function findSummary(summaries, conversationId) {
  return summaries.find((summary) => summary.id === conversationId) || null;
}

function assertVisibleSummary(summary) {
  invariant(summary && !summary.deletedAt, "CONVERSATION_NOT_FOUND", "对话不存在", { status: 404 });
  return summary;
}

function assertConversationRevision(summary, expectedRevision) {
  const expected = assertExpectedConversationRevision(expectedRevision);
  if (summary.revision !== expected) {
    throw new ApiError("REVISION_CONFLICT", "对话已被其他操作更新", {
      status: 409,
      details: { expectedRevision: expected, actualRevision: summary.revision },
    });
  }
}

function branchById(meta, branchId) {
  const branch = meta.branches.find((entry) => entry.id === branchId);
  invariant(branch, "BRANCH_NOT_FOUND", "分支不存在", { status: 404 });
  return branch;
}

function createMessage(input) {
  return {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    entityType: "ConversationMessage",
    id: input.id,
    conversationId: input.conversationId,
    branchId: input.branchId,
    role: input.role,
    content: input.content,
    taskId: input.taskId,
    replyToMessageId: input.replyToMessageId,
    createdAt: input.createdAt,
  };
}

function removedBoundary(chain, messages, retainedMessageId = null, context = {}) {
  const taskIds = messages.map((message) => message.taskId).filter(Boolean);
  return {
    sourceSnapshotId: context.sourceSnapshotId || null,
    branchId: context.branchId || null,
    message: {
      afterMessageId: retainedMessageId,
      firstRemovedMessageId: chain[0] || null,
      lastRemovedMessageId: chain.at(-1) || null,
      count: chain.length,
    },
    task: {
      firstRemovedTaskId: taskIds[0] || null,
      lastRemovedTaskId: taskIds.at(-1) || null,
      count: new Set(taskIds).size,
    },
  };
}

function updateBranchCount(meta, branchId, chain, timestamp) {
  meta.branches = meta.branches.map((branch) => branch.id === branchId
    ? { ...branch, messageCount: chain.length, updatedAt: timestamp }
    : branch);
}

function nextSnapshotMeta(meta, snapshotId, timestamp) {
  return {
    ...clone(meta),
    revision: meta.revision + 1,
    parentSnapshotId: snapshotId,
    updatedAt: timestamp,
  };
}

function queryDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ConversationService {
  constructor(options) {
    invariant(options?.actor?.actorType && options?.actor?.actorId, "ACTOR_CONTEXT_REQUIRED", "ConversationService 需要 ActorContext", { status: 500, expose: false });
    invariant(typeof options.dataRoot === "string", "DATA_ROOT_INVALID", "ConversationService 需要 dataRoot", { status: 500, expose: false });
    this.actor = options.actor;
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.queue = options.queue || defaultActorMutationQueue;
    this.beforeIndexCommit = options.beforeIndexCommit || null;
    this.authorizeProject = options.authorizeProject || null;
    this.storage = new ConversationStorage({
      dataRoot: options.dataRoot,
      actor: options.actor,
      indexPageSize: options.indexPageSize,
      messagePageSize: options.messagePageSize,
      indexQueue: DIRECT_QUEUE,
    });
    this.cursorCodec = createOpaqueCursorCodec({
      secret: options.cursorSecret,
      namespace: "easywork-conversations",
      defaultTtlMs: options.cursorTtlMs,
    });
  }

  #id(prefix) {
    return createIdentifier(prefix, () => this.idFactory(prefix));
  }

  async #readIndex() {
    const root = await this.storage.readIndexRoot();
    return { root, summaries: await this.storage.readIndexGeneration(root.data.generationId) };
  }

  async #loadConversation(summaries, conversationId, options = {}) {
    const id = assertConversationId(conversationId);
    const summary = findSummary(summaries, id);
    if (options.includeDeleted) invariant(summary, "CONVERSATION_NOT_FOUND", "对话不存在", { status: 404 });
    else assertVisibleSummary(summary);
    const meta = await this.storage.readSnapshot(id, summary.snapshotId);
    const chains = await this.storage.readAllBranchChains(id, summary.snapshotId, meta);
    return { summary, meta, chains };
  }

  async #isCommittedCommand(record, summaries) {
    const summary = findSummary(summaries, record.conversationId);
    if (!summary || summary.revision < record.conversationRevision) return false;
    return this.storage.isSnapshotAncestor(record.conversationId, summary.snapshotId, record.snapshotId);
  }

  async #runMutation(operation, commandIdValue, digestInput, builder) {
    const commandId = assertCommandId(commandIdValue);
    const digest = commandInputDigest(operation, digestInput);
    return this.queue.run(this.actor, async () => {
      const { root, summaries } = await this.#readIndex();
      const cached = await this.storage.readCommand(commandId);
      if (cached) {
        invariant(cached.commandId === commandId && cached.operation === operation && cached.inputDigest === digest, "COMMAND_ID_REUSED", "commandId 已用于其他操作或参数", { status: 409 });
        if (await this.#isCommittedCommand(cached, summaries)) return clone(cached.result);
      }

      const timestamp = nowIso(this.clock);
      const mutation = await builder({ summaries, timestamp });
      const newMessages = mutation.newMessages || [];
      await Promise.all(newMessages.map((message) => this.storage.writeMessage(mutation.conversationId, message)));
      await this.storage.stageSnapshot(mutation.conversationId, mutation.snapshotId, mutation.meta, mutation.chains);

      const nextSummaries = summaries.filter((summary) => summary.id !== mutation.conversationId);
      nextSummaries.push(mutation.summary);
      nextSummaries.sort(compareSummaries);
      const generationId = this.#id("cidx");
      await this.storage.stageIndexGeneration(generationId, nextSummaries);
      await this.storage.stageCommand(commandId, {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        commandId,
        operation,
        inputDigest: digest,
        conversationId: mutation.conversationId,
        conversationRevision: mutation.summary.revision,
        snapshotId: mutation.snapshotId,
        result: clone(mutation.result),
        preparedAt: timestamp,
      });
      if (this.beforeIndexCommit) await this.beforeIndexCommit({
        operation,
        conversationId: mutation.conversationId,
        conversationRevision: mutation.summary.revision,
        snapshotId: mutation.snapshotId,
      });
      await this.storage.commitIndexGeneration(generationId, nextSummaries.length, root.revision, this.clock);
      return clone(mutation.result);
    });
  }

  async #summaryFrom(meta, snapshotId, chains, newMessages = []) {
    const activeChain = chains.get(meta.activeBranchId) || [];
    const pending = new Map(newMessages.map((message) => [message.id, message]));
    const lastMessage = activeChain.length
      ? pending.get(activeChain.at(-1)) || await this.storage.readMessage(meta.conversationId, activeChain.at(-1))
      : null;
    const preview = lastMessage ? Array.from(lastMessage.content.replace(/\s+/g, " ").trim()).slice(0, 120).join("") : "";
    return {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      entityType: "ConversationSummary",
      id: meta.conversationId,
      revision: meta.revision,
      snapshotId,
      mode: meta.mode,
      title: meta.title,
      projectId: meta.projectId,
      pinned: meta.pinned,
      rootBranchId: meta.rootBranchId,
      activeBranchId: meta.activeBranchId,
      branchCount: meta.branches.length,
      messageCount: activeChain.length,
      lastMessagePreview: preview,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastMessageAt: meta.lastMessageAt,
      deletedAt: meta.deletedAt,
    };
  }

  async listConversations(options = {}) {
    assertInputKeys(options, ["cursor", "limit", "projectId", "mode", "pinned"], "ListConversationsInput");
    const limit = assertLimit(options.limit, 30);
    const filter = {
      projectId: options.projectId === undefined ? undefined : assertOptionalProjectId(options.projectId),
      mode: options.mode === undefined ? undefined : assertConversationMode(options.mode),
      pinned: options.pinned === undefined ? undefined : Boolean(options.pinned),
    };
    const digest = queryDigest(filter);
    let generationId;
    let offset;
    if (options.cursor) {
      const cursor = this.cursorCodec.decode(options.cursor);
      invariant(cursor.actorType === this.actor.actorType && cursor.actorId === this.actor.actorId && cursor.kind === "conversation-list" && cursor.filterDigest === digest, "CURSOR_INVALID", "游标不属于当前对话列表", { status: 400 });
      generationId = cursor.generationId;
      offset = cursor.offset;
    } else {
      const root = await this.storage.readIndexRoot();
      generationId = root.data.generationId;
      offset = 0;
    }
    const summaries = (await this.storage.readIndexGeneration(generationId)).filter((summary) => (
      !summary.deletedAt
      && (filter.projectId === undefined || summary.projectId === filter.projectId)
      && (filter.mode === undefined || summary.mode === filter.mode)
      && (filter.pinned === undefined || summary.pinned === filter.pinned)
    ));
    const items = summaries.slice(offset, offset + limit).map(clone);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < summaries.length ? this.cursorCodec.encode({
        actorType: this.actor.actorType,
        actorId: this.actor.actorId,
        kind: "conversation-list",
        filterDigest: digest,
        generationId,
        offset: nextOffset,
      }) : null,
    };
  }

  async bootstrapOverview(options = {}) {
    assertInputKeys(options, ["limit", "projectId"], "ConversationBootstrapOverviewInput");
    const limit = assertLimit(options.limit, 30);
    const projectId = options.projectId === undefined ? undefined : assertOptionalProjectId(options.projectId);
    const root = await this.storage.readIndexRoot();
    const summaries = (await this.storage.readIndexGeneration(root.data.generationId))
      .filter((summary) => !summary.deletedAt);
    const filtered = projectId === undefined
      ? summaries
      : summaries.filter((summary) => summary.projectId === projectId);
    const items = filtered.slice(0, limit).map(clone);
    const projectConversationCounts = {};
    for (const summary of summaries) {
      if (!summary.projectId) continue;
      projectConversationCounts[summary.projectId] = (projectConversationCounts[summary.projectId] || 0) + 1;
    }
    const filterDigest = queryDigest({ projectId, mode: undefined, pinned: undefined });
    return {
      items,
      nextCursor: items.length < filtered.length ? this.cursorCodec.encode({
        actorType: this.actor.actorType,
        actorId: this.actor.actorId,
        kind: "conversation-list",
        filterDigest,
        generationId: root.data.generationId,
        offset: items.length,
      }) : null,
      projectConversationCounts,
    };
  }

  async listDeletedConversations() {
    const { summaries } = await this.#readIndex();
    return summaries.filter((summary) => Boolean(summary.deletedAt)).map(clone);
  }

  async getConversationSummaries(conversationIds = []) {
    invariant(Array.isArray(conversationIds), "CONVERSATION_IDS_INVALID", "对话 ID 列表无效", { status: 400 });
    const requested = new Set(conversationIds.map((conversationId) => assertConversationId(conversationId)));
    if (!requested.size) return [];
    const { summaries } = await this.#readIndex();
    return summaries.filter((summary) => requested.has(summary.id) && !summary.deletedAt).map(clone);
  }

  async listAllMessagesIncludingDeleted(conversationId) {
    const { summaries } = await this.#readIndex();
    const { chains } = await this.#loadConversation(summaries, conversationId, { includeDeleted: true });
    const messageIds = [...new Set([...chains.values()].flat())];
    return Promise.all(messageIds.map((messageId) => this.storage.readMessage(conversationId, messageId)));
  }

  async getConversation(conversationId) {
    const { summaries } = await this.#readIndex();
    const { summary, meta } = await this.#loadConversation(summaries, conversationId);
    return { summary: clone(summary), branches: clone(meta.branches) };
  }

  async listMessages(options) {
    assertInputKeys(options, ["conversationId", "branchId", "cursor", "limit"], "ListMessagesInput");
    const conversationId = assertConversationId(options?.conversationId);
    const limit = assertLimit(options?.limit, 50);
    const { summaries } = await this.#readIndex();
    const summary = assertVisibleSummary(findSummary(summaries, conversationId));
    let snapshotId = summary.snapshotId;
    let branchId = options.branchId ? assertBranchId(options.branchId) : summary.activeBranchId;
    let offset = 0;
    if (options.cursor) {
      const cursor = this.cursorCodec.decode(options.cursor);
      invariant(cursor.actorType === this.actor.actorType && cursor.actorId === this.actor.actorId && cursor.kind === "message-list" && cursor.conversationId === conversationId, "CURSOR_INVALID", "游标不属于当前消息列表", { status: 400 });
      snapshotId = cursor.snapshotId;
      branchId = cursor.branchId;
      offset = cursor.offset;
    }
    const chain = await this.storage.readBranchChain(conversationId, snapshotId, branchId);
    const ids = chain.slice(offset, offset + limit);
    const items = await Promise.all(ids.map((messageId) => this.storage.readMessage(conversationId, messageId)));
    const nextOffset = offset + items.length;
    return {
      items,
      snapshotId,
      branchId,
      nextCursor: nextOffset < chain.length ? this.cursorCodec.encode({
        actorType: this.actor.actorType,
        actorId: this.actor.actorId,
        kind: "message-list",
        conversationId,
        snapshotId,
        branchId,
        offset: nextOffset,
      }) : null,
    };
  }

  async sendMessage(input) {
    assertInputKeys(input, ["conversationId", "branchId", "role", "content", "taskId", "mode", "projectId", "title", "expectedRevision", "commandId"], "SendMessageInput");
    const isNew = !input?.conversationId;
    const expectedRevision = assertExpectedConversationRevision(input?.expectedRevision);
    const role = assertMessageRole(input?.role ?? "user");
    const content = assertMessageContent(input?.content);
    const taskId = assertOptionalTaskId(input?.taskId);
    const requestedMode = input?.mode === undefined ? undefined : assertConversationMode(input.mode);
    invariant(!isNew || expectedRevision === 0, "REVISION_CONFLICT", "新对话 expectedRevision 必须为 0", { status: 409, details: { expectedRevision, actualRevision: 0 } });
    invariant(!isNew || role === "user", "CONVERSATION_LAZY_CREATE_USER_REQUIRED", "新对话只能由首条用户消息创建", { status: 400 });
    invariant(!isNew || requestedMode, "CONVERSATION_MODE_REQUIRED", "新对话必须指定模式", { status: 400 });
    const projectId = isNew ? assertOptionalProjectId(input?.projectId) : undefined;
    const title = isNew && input?.title !== undefined ? assertTitle(input.title) : undefined;
    const digestInput = { conversationId: input?.conversationId || null, branchId: input?.branchId || null, expectedRevision, role, content, taskId, mode: requestedMode || null, projectId, title: title || null };

    return this.#runMutation("conversation.send_message", input?.commandId, digestInput, async ({ summaries, timestamp }) => {
      if (isNew) {
        if (projectId && this.authorizeProject) invariant(await this.authorizeProject(projectId), "CONVERSATION_PROJECT_FORBIDDEN", "项目不存在或不可访问", { status: 404 });
        const conversationId = this.#id("conv");
        const branchId = this.#id("branch");
        const messageId = this.#id("msg");
        const snapshotId = this.#id("csnap");
        const message = createMessage({ id: messageId, conversationId, branchId, role, content, taskId, replyToMessageId: null, createdAt: timestamp });
        const chains = new Map([[branchId, [messageId]]]);
        const meta = {
          schemaVersion: CONVERSATION_SCHEMA_VERSION,
          entityType: "ConversationSnapshot",
          conversationId,
          revision: 1,
          parentSnapshotId: null,
          mode: requestedMode,
          title: title || defaultConversationTitle(content),
          projectId,
          pinned: false,
          rootBranchId: branchId,
          activeBranchId: branchId,
          branches: [{ id: branchId, parentBranchId: null, forkMessageId: null, messageCount: 1, createdAt: timestamp, updatedAt: timestamp }],
          createdAt: timestamp,
          updatedAt: timestamp,
          lastMessageAt: timestamp,
          deletedAt: null,
        };
        const summary = await this.#summaryFrom(meta, snapshotId, chains, [message]);
        return { conversationId, snapshotId, meta, chains, newMessages: [message], summary, result: { conversation: summary, messageId, branchId } };
      }

      const conversationId = assertConversationId(input.conversationId);
      const loaded = await this.#loadConversation(summaries, conversationId);
      assertConversationRevision(loaded.summary, expectedRevision);
      if (requestedMode !== undefined) invariant(requestedMode === loaded.meta.mode, "CONVERSATION_MODE_FIXED", "对话模式已固定；请先显式转换模式", { status: 409, details: { currentMode: loaded.meta.mode, requestedMode } });
      const branchId = input.branchId ? assertBranchId(input.branchId) : loaded.meta.activeBranchId;
      branchById(loaded.meta, branchId);
      const chain = loaded.chains.get(branchId);
      const messageId = this.#id("msg");
      const snapshotId = this.#id("csnap");
      const replyToMessageId = chain.at(-1) || null;
      const message = createMessage({ id: messageId, conversationId, branchId, role, content, taskId, replyToMessageId, createdAt: timestamp });
      chain.push(messageId);
      const meta = nextSnapshotMeta(loaded.meta, loaded.summary.snapshotId, timestamp);
      meta.activeBranchId = branchId;
      meta.lastMessageAt = timestamp;
      updateBranchCount(meta, branchId, chain, timestamp);
      const summary = await this.#summaryFrom(meta, snapshotId, loaded.chains, [message]);
      return { conversationId, snapshotId, meta, chains: loaded.chains, newMessages: [message], summary, result: { conversation: summary, messageId, branchId } };
    });
  }

  async #metadataMutation(operation, input, mutate) {
    const conversationId = assertConversationId(input?.conversationId);
    const expectedRevision = assertExpectedConversationRevision(input?.expectedRevision);
    return this.#runMutation(operation, input?.commandId, { ...input, commandId: undefined }, async ({ summaries, timestamp }) => {
      const loaded = await this.#loadConversation(summaries, conversationId);
      assertConversationRevision(loaded.summary, expectedRevision);
      const snapshotId = this.#id("csnap");
      const meta = nextSnapshotMeta(loaded.meta, loaded.summary.snapshotId, timestamp);
      await mutate(meta, loaded, timestamp);
      const summary = await this.#summaryFrom(meta, snapshotId, loaded.chains);
      return { conversationId, snapshotId, meta, chains: loaded.chains, summary, result: { conversation: summary } };
    });
  }

  rename(input) {
    assertInputKeys(input, ["conversationId", "title", "expectedRevision", "commandId"], "RenameConversationInput");
    const title = assertTitle(input?.title);
    return this.#metadataMutation("conversation.rename", { ...input, title }, (meta) => { meta.title = title; });
  }

  setPinned(input) {
    assertInputKeys(input, ["conversationId", "pinned", "expectedRevision", "commandId"], "SetConversationPinnedInput");
    invariant(typeof input?.pinned === "boolean", "PINNED_INVALID", "pinned 必须是布尔值", { status: 400 });
    return this.#metadataMutation("conversation.set_pinned", input, (meta) => { meta.pinned = input.pinned; });
  }

  moveToProject(input) {
    assertInputKeys(input, ["conversationId", "projectId", "expectedRevision", "commandId"], "MoveConversationInput");
    const projectId = assertOptionalProjectId(input?.projectId);
    return this.#metadataMutation("conversation.move_project", { ...input, projectId }, async (meta) => {
      if (projectId && this.authorizeProject) invariant(await this.authorizeProject(projectId), "CONVERSATION_PROJECT_FORBIDDEN", "项目不存在或不可访问", { status: 404 });
      meta.projectId = projectId;
    });
  }

  activateBranch(input) {
    assertInputKeys(input, ["conversationId", "branchId", "expectedRevision", "commandId"], "ActivateConversationBranchInput");
    const branchId = assertBranchId(input?.branchId);
    return this.#metadataMutation("conversation.activate_branch", { ...input, branchId }, (meta) => {
      branchById(meta, branchId);
      meta.activeBranchId = branchId;
    });
  }

  async delete(input) {
    assertInputKeys(input, ["conversationId", "expectedRevision", "commandId"], "DeleteConversationInput");
    return this.#metadataMutation("conversation.delete", input, (meta, loaded, timestamp) => {
      meta.deletedAt = timestamp;
      meta.pinned = false;
    });
  }

  async branch(input) {
    assertInputKeys(input, ["conversationId", "sourceBranchId", "atMessageId", "expectedRevision", "commandId"], "BranchConversationInput");
    const conversationId = assertConversationId(input?.conversationId);
    const sourceBranchIdInput = input?.sourceBranchId ? assertBranchId(input.sourceBranchId) : null;
    const atMessageId = assertMessageId(input?.atMessageId);
    const expectedRevision = assertExpectedConversationRevision(input?.expectedRevision);
    return this.#runMutation("conversation.branch", input?.commandId, { conversationId, sourceBranchId: sourceBranchIdInput, atMessageId, expectedRevision }, async ({ summaries, timestamp }) => {
      const loaded = await this.#loadConversation(summaries, conversationId);
      assertConversationRevision(loaded.summary, expectedRevision);
      const sourceBranchId = sourceBranchIdInput || loaded.meta.activeBranchId;
      branchById(loaded.meta, sourceBranchId);
      const sourceChain = loaded.chains.get(sourceBranchId);
      const forkIndex = sourceChain.indexOf(atMessageId);
      invariant(forkIndex >= 0, "BRANCH_FORK_MESSAGE_NOT_FOUND", "分支起点不在来源消息链中", { status: 404 });
      const branchId = this.#id("branch");
      const chain = sourceChain.slice(0, forkIndex + 1);
      loaded.chains.set(branchId, chain);
      const snapshotId = this.#id("csnap");
      const meta = nextSnapshotMeta(loaded.meta, loaded.summary.snapshotId, timestamp);
      meta.activeBranchId = branchId;
      meta.branches.push({ id: branchId, parentBranchId: sourceBranchId, forkMessageId: atMessageId, messageCount: chain.length, createdAt: timestamp, updatedAt: timestamp });
      const summary = await this.#summaryFrom(meta, snapshotId, loaded.chains);
      return { conversationId, snapshotId, meta, chains: loaded.chains, summary, result: { conversation: summary, branch: clone(meta.branches.at(-1)) } };
    });
  }

  async forkConversation(input) {
    assertInputKeys(input, ["conversationId", "sourceBranchId", "atMessageId", "expectedRevision", "commandId"], "ForkConversationInput");
    const sourceConversationId = assertConversationId(input?.conversationId);
    const sourceBranchIdInput = input?.sourceBranchId ? assertBranchId(input.sourceBranchId) : null;
    const atMessageId = assertMessageId(input?.atMessageId);
    const expectedRevision = assertExpectedConversationRevision(input?.expectedRevision);
    return this.#runMutation("conversation.fork_conversation", input?.commandId, {
      conversationId: sourceConversationId,
      sourceBranchId: sourceBranchIdInput,
      atMessageId,
      expectedRevision,
    }, async ({ summaries, timestamp }) => {
      const loaded = await this.#loadConversation(summaries, sourceConversationId);
      assertConversationRevision(loaded.summary, expectedRevision);
      const sourceBranchId = sourceBranchIdInput || loaded.meta.activeBranchId;
      branchById(loaded.meta, sourceBranchId);
      const sourceChain = loaded.chains.get(sourceBranchId);
      const forkIndex = sourceChain.indexOf(atMessageId);
      invariant(forkIndex >= 0, "BRANCH_FORK_MESSAGE_NOT_FOUND", "分支起点不在来源消息链中", { status: 404 });

      const sourceMessages = await Promise.all(sourceChain.slice(0, forkIndex + 1)
        .map((messageId) => this.storage.readMessage(sourceConversationId, messageId)));
      const conversationId = this.#id("conv");
      const branchId = this.#id("branch");
      const snapshotId = this.#id("csnap");
      const idMap = new Map(sourceMessages.map((message) => [message.id, this.#id("msg")]));
      const newMessages = sourceMessages.map((message) => createMessage({
        id: idMap.get(message.id),
        conversationId,
        branchId,
        role: message.role,
        content: message.content,
        // A derived webpage conversation keeps the immutable Task reference
        // for every inherited answer.  Task and realtime journals are
        // content-addressed historical records; retaining the reference lets
        // the child render the complete pre-fork reasoning and Agent activity
        // without copying or mutating the source run.
        taskId: message.taskId,
        replyToMessageId: message.replyToMessageId ? idMap.get(message.replyToMessageId) || null : null,
        createdAt: message.createdAt,
      }));
      const chain = newMessages.map((message) => message.id);
      const chains = new Map([[branchId, chain]]);
      const baseTitle = Array.from(String(loaded.meta.title || "新对话")).slice(0, 232).join("");
      const meta = {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        entityType: "ConversationSnapshot",
        conversationId,
        revision: 1,
        parentSnapshotId: null,
        mode: loaded.meta.mode,
        title: `${baseTitle} · 分支`,
        projectId: loaded.meta.projectId,
        pinned: false,
        rootBranchId: branchId,
        activeBranchId: branchId,
        branches: [{ id: branchId, parentBranchId: null, forkMessageId: idMap.get(atMessageId), messageCount: chain.length, createdAt: timestamp, updatedAt: timestamp }],
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: timestamp,
        deletedAt: null,
      };
      const summary = await this.#summaryFrom(meta, snapshotId, chains, newMessages);
      return {
        conversationId,
        snapshotId,
        meta,
        chains,
        newMessages,
        summary,
        result: {
          conversation: summary,
          branch: clone(meta.branches[0]),
          source: { conversationId: sourceConversationId, branchId: sourceBranchId, atMessageId },
          sourceMessageIds: sourceMessages.map((message) => message.id),
        },
      };
    });
  }

  async retry(input) {
    assertInputKeys(input, ["conversationId", "branchId", "messageId", "content", "taskId", "expectedRevision", "commandId"], "RetryConversationReplyInput");
    const conversationId = assertConversationId(input?.conversationId);
    const branchIdInput = input?.branchId ? assertBranchId(input.branchId) : null;
    const targetMessageId = input?.messageId ? assertMessageId(input.messageId) : null;
    const content = assertMessageContent(input?.content);
    const taskId = assertOptionalTaskId(input?.taskId);
    const expectedRevision = assertExpectedConversationRevision(input?.expectedRevision);
    return this.#runMutation("conversation.retry", input?.commandId, { conversationId, branchId: branchIdInput, messageId: targetMessageId, content, taskId, expectedRevision }, async ({ summaries, timestamp }) => {
      const loaded = await this.#loadConversation(summaries, conversationId);
      assertConversationRevision(loaded.summary, expectedRevision);
      const branchId = branchIdInput || loaded.meta.activeBranchId;
      branchById(loaded.meta, branchId);
      const chain = loaded.chains.get(branchId);
      invariant(chain.length > 0, "RETRY_MESSAGE_NOT_FOUND", "当前分支没有可重试的回复", { status: 404 });
      const previous = await this.storage.readMessage(conversationId, chain.at(-1));
      invariant(previous.role === "assistant", "LATEST_ASSISTANT_MESSAGE_REQUIRED", "只能重试最新一条助手回复", { status: 409 });
      invariant(!targetMessageId || previous.id === targetMessageId, "LATEST_ASSISTANT_MESSAGE_REQUIRED", "只能重试最新一条助手回复", { status: 409, details: { latestMessageId: previous.id } });
      const retained = chain.slice(0, -1);
      const messageId = this.#id("msg");
      const message = createMessage({ id: messageId, conversationId, branchId, role: "assistant", content, taskId, replyToMessageId: retained.at(-1) || null, createdAt: timestamp });
      retained.push(messageId);
      loaded.chains.set(branchId, retained);
      const snapshotId = this.#id("csnap");
      const meta = nextSnapshotMeta(loaded.meta, loaded.summary.snapshotId, timestamp);
      meta.lastMessageAt = timestamp;
      updateBranchCount(meta, branchId, retained, timestamp);
      const summary = await this.#summaryFrom(meta, snapshotId, loaded.chains, [message]);
      return {
        conversationId, snapshotId, meta, chains: loaded.chains, newMessages: [message], summary,
        result: {
          conversation: summary,
          messageId,
          branchId,
          removedBoundary: removedBoundary([previous.id], [previous], retained.at(-2) || null, { sourceSnapshotId: loaded.summary.snapshotId, branchId }),
        },
      };
    });
  }

  async rewind(input) {
    assertInputKeys(input, ["conversationId", "branchId", "toMessageId", "expectedRevision", "commandId"], "RewindConversationInput");
    const conversationId = assertConversationId(input?.conversationId);
    const branchIdInput = input?.branchId ? assertBranchId(input.branchId) : null;
    const toMessageId = assertMessageId(input?.toMessageId);
    const expectedRevision = assertExpectedConversationRevision(input?.expectedRevision);
    return this.#runMutation("conversation.rewind", input?.commandId, { conversationId, branchId: branchIdInput, toMessageId, expectedRevision }, async ({ summaries, timestamp }) => {
      const loaded = await this.#loadConversation(summaries, conversationId);
      assertConversationRevision(loaded.summary, expectedRevision);
      const branchId = branchIdInput || loaded.meta.activeBranchId;
      branchById(loaded.meta, branchId);
      const chain = loaded.chains.get(branchId);
      const targetIndex = chain.indexOf(toMessageId);
      invariant(targetIndex >= 0, "REWIND_MESSAGE_NOT_FOUND", "回溯位置不在当前分支中", { status: 404 });
      const removedIds = chain.slice(targetIndex + 1);
      invariant(removedIds.length > 0, "REWIND_NO_CHANGES", "该位置之后没有可回溯的消息", { status: 409 });
      const removedMessages = await Promise.all(removedIds.map((id) => this.storage.readMessage(conversationId, id)));
      const retained = chain.slice(0, targetIndex + 1);
      loaded.chains.set(branchId, retained);
      const snapshotId = this.#id("csnap");
      const meta = nextSnapshotMeta(loaded.meta, loaded.summary.snapshotId, timestamp);
      meta.activeBranchId = branchId;
      meta.lastMessageAt = timestamp;
      updateBranchCount(meta, branchId, retained, timestamp);
      const summary = await this.#summaryFrom(meta, snapshotId, loaded.chains);
      return {
        conversationId, snapshotId, meta, chains: loaded.chains, summary,
        result: {
          conversation: summary,
          branchId,
          removedBoundary: removedBoundary(removedIds, removedMessages, toMessageId, { sourceSnapshotId: loaded.summary.snapshotId, branchId }),
        },
      };
    });
  }
}
