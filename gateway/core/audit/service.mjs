import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createOpaqueCursorCodec } from "../cursor.mjs";
import { invariant, redactSensitive } from "../errors.mjs";
import { defaultActorMutationQueue } from "../mutation-queue.mjs";
import { resolveActorPath } from "../paths.mjs";

const ACTION_PATTERN = /^[a-z][a-z0-9._:-]{1,127}$/;

function monthKey(occurredAt) {
  return occurredAt.slice(0, 7);
}

function normalizeEvent(input, actor, clock) {
  const occurredAt = new Date(clock()).toISOString();
  const action = String(input?.action || "");
  invariant(ACTION_PATTERN.test(action), "AUDIT_ACTION_INVALID", "Audit action 无效", { status: 400 });
  const metadata = redactSensitive(input?.metadata || {});
  return Object.freeze({
    schemaVersion: 1,
    id: `audit_${crypto.randomUUID()}`,
    occurredAt,
    actorType: actor.actorType,
    actorId: actor.actorId,
    deviceId: actor.deviceId,
    sessionId: actor.sessionId,
    action,
    status: String(input?.status || "success"),
    target: input?.target ? redactSensitive(input.target) : null,
    requestId: input?.requestId ? String(input.requestId).slice(0, 256) : null,
    metadata,
  });
}

export class AuditService {
  constructor({ dataRoot, actor, cursorSecret, queue = defaultActorMutationQueue, clock = () => new Date() }) {
    this.dataRoot = dataRoot;
    this.actor = actor;
    this.queue = queue;
    this.clock = clock;
    this.cursor = createOpaqueCursorCodec({ secret: cursorSecret, namespace: `audit:${actor.actorType}:${actor.actorId}`, defaultTtlMs: 24 * 60 * 60_000 });
  }

  #file(month) {
    invariant(/^\d{4}-\d{2}$/.test(month), "AUDIT_MONTH_INVALID", "Audit month 无效", { status: 400 });
    return resolveActorPath(this.dataRoot, this.actor, "audit", `${month}.jsonl`);
  }

  async append(input) {
    const event = normalizeEvent(input, this.actor, this.clock);
    await this.queue.run(this.actor, async () => {
      const filePath = this.#file(monthKey(event.occurredAt));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const handle = await fs.open(filePath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return structuredClone(event);
  }

  async list({ month = new Date(this.clock()).toISOString().slice(0, 7), cursor = null, limit = 100 } = {}) {
    const pageSize = Number(limit);
    invariant(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 500, "AUDIT_LIMIT_INVALID", "Audit limit 无效", { status: 400 });
    let offset = 0;
    if (cursor) {
      const decoded = this.cursor.decode(cursor);
      invariant(decoded.month === month && Number.isSafeInteger(decoded.offset), "AUDIT_CURSOR_INVALID", "Audit cursor 无效", { status: 400 });
      offset = decoded.offset;
    }
    let lines = [];
    try {
      lines = (await fs.readFile(this.#file(month), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).reverse();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const items = lines.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < lines.length ? this.cursor.encode({ month, offset: nextOffset }) : null,
    };
  }
}
