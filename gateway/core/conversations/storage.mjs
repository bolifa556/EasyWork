import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { invariant } from "../errors.mjs";
import { resolveActorPath } from "../paths.mjs";
import { AtomicJsonRepository } from "../repository.mjs";
import {
  CONVERSATION_MODES,
  CONVERSATION_SCHEMA_VERSION,
  assertBranchId,
  assertConversationId,
  assertMessageId,
  clone,
  commandFileName,
} from "./contract.mjs";

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson(filePath, missingValue) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && arguments.length > 1) return missingValue;
    throw error;
  }
}

function pageName(index) {
  return `${String(index).padStart(8, "0")}.json`;
}

function validateIndexRoot(data) {
  return Boolean(
    data
    && typeof data === "object"
    && !Array.isArray(data)
    && (data.generationId === null || typeof data.generationId === "string")
    && Number.isSafeInteger(data.count)
    && data.count >= 0,
  );
}

function validateSnapshotMeta(meta, conversationId) {
  invariant(meta?.schemaVersion === CONVERSATION_SCHEMA_VERSION, "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照 schema 无效", { status: 500, expose: false });
  invariant(meta.entityType === "ConversationSnapshot", "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照类型无效", { status: 500, expose: false });
  invariant(meta.conversationId === conversationId, "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照归属无效", { status: 500, expose: false });
  invariant(Number.isSafeInteger(meta.revision) && meta.revision >= 1, "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照 revision 无效", { status: 500, expose: false });
  invariant(CONVERSATION_MODES.includes(meta.mode) && !Object.hasOwn(meta, "type"), "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照 mode 无效", { status: 500, expose: false });
  invariant(typeof meta.title === "string" && typeof meta.pinned === "boolean", "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照元数据无效", { status: 500, expose: false });
  invariant(typeof meta.createdAt === "string" && typeof meta.updatedAt === "string" && typeof meta.lastMessageAt === "string", "CONVERSATION_SNAPSHOT_CORRUPT", "对话快照时间无效", { status: 500, expose: false });
  invariant(Array.isArray(meta.branches), "CONVERSATION_SNAPSHOT_CORRUPT", "对话分支索引无效", { status: 500, expose: false });
  invariant(meta.branches.every((branch) => branch && typeof branch === "object" && Number.isSafeInteger(branch.messageCount) && branch.messageCount >= 0), "CONVERSATION_SNAPSHOT_CORRUPT", "对话分支元数据无效", { status: 500, expose: false });
  return meta;
}

function validateMessage(message, conversationId, messageId) {
  invariant(message?.schemaVersion === CONVERSATION_SCHEMA_VERSION && message.entityType === "ConversationMessage", "CONVERSATION_MESSAGE_CORRUPT", "消息 schema 无效", { status: 500, expose: false });
  invariant(message.id === messageId && message.conversationId === conversationId, "CONVERSATION_MESSAGE_CORRUPT", "消息归属无效", { status: 500, expose: false });
  invariant(["user", "assistant", "system", "tool"].includes(message.role) && typeof message.content === "string", "CONVERSATION_MESSAGE_CORRUPT", "消息内容无效", { status: 500, expose: false });
  return message;
}

export class ConversationStorage {
  constructor(options) {
    this.dataRoot = options.dataRoot;
    this.actor = options.actor;
    this.indexPageSize = options.indexPageSize ?? 100;
    this.messagePageSize = options.messagePageSize ?? 100;
    invariant(Number.isSafeInteger(this.indexPageSize) && this.indexPageSize >= 1 && this.indexPageSize <= 1000, "INDEX_PAGE_SIZE_INVALID", "indexPageSize 无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(this.messagePageSize) && this.messagePageSize >= 1 && this.messagePageSize <= 1000, "MESSAGE_PAGE_SIZE_INVALID", "messagePageSize 无效", { status: 500, expose: false });
    this.indexRepository = new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["conversations", "index.json"],
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      defaultData: () => ({ generationId: null, count: 0 }),
      validate: validateIndexRoot,
      queue: options.indexQueue,
    });
  }

  path(...segments) {
    return resolveActorPath(this.dataRoot, this.actor, "conversations", ...segments);
  }

  async readIndexRoot() {
    return this.indexRepository.read();
  }

  async readIndexGeneration(generationId) {
    if (generationId === null) return [];
    const manifest = await readJson(this.path("_index", generationId, "manifest.json"));
    invariant(manifest?.schemaVersion === CONVERSATION_SCHEMA_VERSION, "CONVERSATION_INDEX_CORRUPT", "对话摘要索引 schema 无效", { status: 500, expose: false });
    invariant(Number.isSafeInteger(manifest.pageCount) && manifest.pageCount >= 0, "CONVERSATION_INDEX_CORRUPT", "对话摘要索引页数无效", { status: 500, expose: false });
    const pages = await Promise.all(Array.from({ length: manifest.pageCount }, (_, index) => readJson(this.path("_index", generationId, "pages", pageName(index)))));
    const summaries = pages.flat();
    invariant(summaries.length === manifest.count, "CONVERSATION_INDEX_CORRUPT", "对话摘要索引数量不一致", { status: 500, expose: false });
    return summaries;
  }

  async stageIndexGeneration(generationId, summaries) {
    const pages = [];
    for (let index = 0; index < summaries.length; index += this.indexPageSize) pages.push(summaries.slice(index, index + this.indexPageSize));
    await Promise.all(pages.map((page, index) => writeJsonAtomic(this.path("_index", generationId, "pages", pageName(index)), page)));
    await writeJsonAtomic(this.path("_index", generationId, "manifest.json"), {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      generationId,
      count: summaries.length,
      pageSize: this.indexPageSize,
      pageCount: pages.length,
    });
  }

  async commitIndexGeneration(generationId, count, expectedIndexRevision, clock) {
    return this.indexRepository.replace({ generationId, count }, { expectedRevision: expectedIndexRevision, clock });
  }

  async readCommand(commandId) {
    return readJson(this.path("_commands", commandFileName(commandId)), null);
  }

  async stageCommand(commandId, record) {
    await writeJsonAtomic(this.path("_commands", commandFileName(commandId)), record);
  }

  async writeMessage(conversationId, message) {
    assertConversationId(conversationId);
    assertMessageId(message.id);
    const messagePath = this.path(conversationId, "messages", `${message.id}.json`);
    const existing = await readJson(messagePath, null);
    if (existing !== null) {
      invariant(JSON.stringify(existing) === JSON.stringify(message), "MESSAGE_ID_COLLISION", "消息标识发生冲突", { status: 500, expose: false });
      return;
    }
    await writeJsonAtomic(messagePath, message);
  }

  async readMessage(conversationId, messageId) {
    assertConversationId(conversationId);
    assertMessageId(messageId);
    const message = await readJson(this.path(conversationId, "messages", `${messageId}.json`), null);
    invariant(message !== null, "MESSAGE_NOT_FOUND", "消息不存在", { status: 404 });
    return validateMessage(message, conversationId, messageId);
  }

  async stageSnapshot(conversationId, snapshotId, meta, branchChains) {
    assertConversationId(conversationId);
    validateSnapshotMeta(meta, conversationId);
    for (const branch of meta.branches) {
      assertBranchId(branch.id);
      const chain = branchChains.get(branch.id);
      invariant(Array.isArray(chain) && chain.length === branch.messageCount, "CONVERSATION_CHAIN_INVALID", "分支消息链与快照不一致", { status: 500, expose: false });
      const pages = [];
      for (let index = 0; index < chain.length; index += this.messagePageSize) pages.push(chain.slice(index, index + this.messagePageSize));
      await Promise.all(pages.map((page, index) => writeJsonAtomic(this.path(conversationId, "snapshots", snapshotId, "branches", branch.id, "pages", pageName(index)), page)));
      await writeJsonAtomic(this.path(conversationId, "snapshots", snapshotId, "branches", branch.id, "manifest.json"), {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        branchId: branch.id,
        messageCount: chain.length,
        pageSize: this.messagePageSize,
        pageCount: pages.length,
      });
    }
    const branchPages = [];
    for (let index = 0; index < meta.branches.length; index += this.indexPageSize) branchPages.push(meta.branches.slice(index, index + this.indexPageSize));
    await Promise.all(branchPages.map((page, index) => writeJsonAtomic(
      this.path(conversationId, "snapshots", snapshotId, "branch-index", pageName(index)),
      page,
    )));
    const metaWithoutBranches = clone(meta);
    delete metaWithoutBranches.branches;
    await writeJsonAtomic(this.path(conversationId, "snapshots", snapshotId, "meta.json"), {
      ...metaWithoutBranches,
      branchCount: meta.branches.length,
      branchPageSize: this.indexPageSize,
      branchPageCount: branchPages.length,
    });
  }

  async readSnapshot(conversationId, snapshotId) {
    assertConversationId(conversationId);
    const stored = await readJson(this.path(conversationId, "snapshots", snapshotId, "meta.json"), null);
    invariant(stored !== null, "CONVERSATION_SNAPSHOT_NOT_FOUND", "对话快照不存在", { status: 500, expose: false });
    invariant(Number.isSafeInteger(stored.branchPageCount) && stored.branchPageCount >= 0, "CONVERSATION_SNAPSHOT_CORRUPT", "分支索引页数无效", { status: 500, expose: false });
    const pages = await Promise.all(Array.from({ length: stored.branchPageCount }, (_, index) => readJson(
      this.path(conversationId, "snapshots", snapshotId, "branch-index", pageName(index)),
    )));
    const branches = pages.flat();
    invariant(branches.length === stored.branchCount, "CONVERSATION_SNAPSHOT_CORRUPT", "分支索引数量不一致", { status: 500, expose: false });
    const meta = clone(stored);
    delete meta.branchCount;
    delete meta.branchPageSize;
    delete meta.branchPageCount;
    return clone(validateSnapshotMeta({ ...meta, branches }, conversationId));
  }

  async readBranchChain(conversationId, snapshotId, branchId) {
    assertConversationId(conversationId);
    assertBranchId(branchId);
    const manifest = await readJson(this.path(conversationId, "snapshots", snapshotId, "branches", branchId, "manifest.json"), null);
    invariant(manifest !== null, "BRANCH_NOT_FOUND", "分支不存在", { status: 404 });
    const pages = await Promise.all(Array.from({ length: manifest.pageCount }, (_, index) => readJson(this.path(conversationId, "snapshots", snapshotId, "branches", branchId, "pages", pageName(index)))));
    const chain = pages.flat();
    invariant(chain.length === manifest.messageCount, "CONVERSATION_CHAIN_CORRUPT", "分支消息链数量不一致", { status: 500, expose: false });
    chain.forEach((messageId) => assertMessageId(messageId));
    return chain;
  }

  async readAllBranchChains(conversationId, snapshotId, meta) {
    const entries = await Promise.all(meta.branches.map(async (branch) => [branch.id, await this.readBranchChain(conversationId, snapshotId, branch.id)]));
    return new Map(entries);
  }

  async isSnapshotAncestor(conversationId, currentSnapshotId, candidateSnapshotId) {
    let cursor = currentSnapshotId;
    const visited = new Set();
    while (cursor) {
      if (cursor === candidateSnapshotId) return true;
      invariant(!visited.has(cursor), "CONVERSATION_SNAPSHOT_CYCLE", "对话快照链存在循环", { status: 500, expose: false });
      visited.add(cursor);
      const meta = await this.readSnapshot(conversationId, cursor);
      cursor = meta.parentSnapshotId;
    }
    return false;
  }
}
