import crypto from "node:crypto";

import { assertNoSensitiveFields, invariant } from "./errors.mjs";
import { AtomicJsonRepository } from "./repository.mjs";

const TOPIC_PATTERN = /^[a-z][a-z0-9._:-]{0,191}$/;

function topicHash(topic) {
  return crypto.createHash("sha256").update(topic).digest("hex");
}

function normalizeIds(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value), "REALTIME_IDS_INVALID", "Realtime ids 必须是对象", { status: 400 });
  const ids = {};
  for (const [key, id] of Object.entries(value)) {
    invariant(/^[a-z][A-Za-z0-9]*Id$/.test(key), "REALTIME_ID_KEY_INVALID", `Realtime id 键无效：${key}`, { status: 400 });
    invariant(id === null || (typeof id === "string" && id.length > 0 && id.length <= 256), "REALTIME_ID_INVALID", `Realtime ${key} 无效`, { status: 400 });
    ids[key] = id;
  }
  return Object.freeze(ids);
}

function sameIds(left, right) {
  const leftEntries = Object.entries(left || {});
  const rightEntries = Object.entries(right || {});
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right?.[key] === value);
}

function streamDescriptor(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (["reasoning", "message"].includes(event.kind)
    && payload.event?.delta === true
    && typeof payload.event?.text === "string"
    && payload.source?.itemId) {
    return {
      key: [event.producer, event.kind, payload.source.itemId].map(String).join(":"),
      textPath: "event",
    };
  }
  if (event.kind === "run.reasoning.delta" && typeof payload.content === "string") {
    return {
      key: [event.producer, event.kind, event.ids?.runId, payload.iteration ?? 0].map(String).join(":"),
      textPath: "payload",
    };
  }
  if (event.kind === "run.output.delta" && typeof payload.content === "string" && payload.segmentId) {
    return {
      key: [event.producer, event.kind, event.ids?.runId, payload.segmentId].map(String).join(":"),
      textPath: "payload",
    };
  }
  return null;
}

function compactStreamEvent(previous, next) {
  const descriptor = streamDescriptor(next);
  if (!descriptor
    || previous?.producer !== next.producer
    || previous?.kind !== next.kind
    || previous?.status !== next.status
    || !sameIds(previous?.ids, next.ids)
    || streamDescriptor(previous)?.key !== descriptor.key) return null;
  const previousPayload = previous.payload || {};
  const nextPayload = next.payload || {};
  if (descriptor.textPath === "event") {
    return {
      ...next,
      payload: {
        ...nextPayload,
        realtimeStreamKey: previousPayload.realtimeStreamKey,
        event: {
          ...nextPayload.event,
          text: `${String(previousPayload.event?.text || "")}${String(nextPayload.event?.text || "")}`,
        },
      },
    };
  }
  return {
    ...next,
    payload: {
      ...nextPayload,
      realtimeStreamKey: previousPayload.realtimeStreamKey,
      content: `${String(previousPayload.content || "")}${String(nextPayload.content || "")}`,
    },
  };
}

function markStreamEvent(event) {
  const descriptor = streamDescriptor(event);
  // Only adjacent deltas are cumulative snapshots. A later delta in the same
  // model iteration starts a new segment after a tool/content event.
  return descriptor ? { ...event, payload: { ...event.payload, realtimeStreamKey: `${descriptor.key}:${event.sequence}` } } : event;
}

export function createRealtimeEnvelope(input) {
  invariant(!["timestamp", "seq", "type", "taskId", "conversationId"].some((key) => key in (input || {})), "REALTIME_RESERVED_FIELD_FORBIDDEN", "Realtime envelope 包含保留字段", { status: 400 });
  const topic = String(input?.topic || "");
  const sequence = Number(input?.sequence);
  invariant(TOPIC_PATTERN.test(topic), "REALTIME_TOPIC_INVALID", "Realtime topic 格式无效", { status: 400 });
  invariant(Number.isSafeInteger(sequence) && sequence > 0, "REALTIME_SEQUENCE_INVALID", "Realtime sequence 必须是正整数", { status: 500, expose: false });
  const payload = structuredClone(input?.payload ?? {});
  assertNoSensitiveFields(payload);
  return Object.freeze({
    schemaVersion: 1,
    eventId: String(input?.eventId || crypto.randomUUID()),
    topic,
    sequence,
    occurredAt: new Date((input.clock || (() => new Date()))()).toISOString(),
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    producer: String(input.producer || "orchestrator"),
    kind: String(input.kind || "status"),
    status: input.status === null || input.status === undefined ? null : String(input.status),
    ids: normalizeIds(input.ids || {}),
    payload,
  });
}

export class RealtimeEventJournal {
  constructor(options) {
    this.dataRoot = options.dataRoot;
    this.actor = options.actor;
    this.queue = options.queue;
    this.maxEventsPerTopic = options.maxEventsPerTopic ?? 10_000;
    invariant(Number.isSafeInteger(this.maxEventsPerTopic) && this.maxEventsPerTopic > 0, "REALTIME_RETENTION_INVALID", "Realtime retention 无效", { status: 500, expose: false });
  }

  #repository(topic) {
    invariant(TOPIC_PATTERN.test(topic), "REALTIME_TOPIC_INVALID", "Realtime topic 格式无效", { status: 400 });
    return new AtomicJsonRepository({
      dataRoot: this.dataRoot,
      actor: this.actor,
      relativePath: ["runtime", "realtime", topicHash(topic), "journal.json"],
      schemaVersion: 1,
      defaultData: () => ({ topic, firstSequence: 1, lastSequence: 0, events: [] }),
      validate: (data) => data?.topic === topic && Number.isSafeInteger(data.lastSequence) && Array.isArray(data.events),
      queue: this.queue,
    });
  }

  async append(topic, event) {
    const repository = this.#repository(topic);
    for (;;) {
      const current = await repository.read();
      try {
        const updated = await repository.update((data) => {
          const sequence = data.lastSequence + 1;
          const envelope = markStreamEvent(createRealtimeEnvelope({ ...event, actor: this.actor, topic, sequence }));
          const compacted = compactStreamEvent(data.events.at(-1), envelope);
          data.lastSequence = sequence;
          if (compacted) data.events[data.events.length - 1] = compacted;
          else data.events.push(envelope);
          if (data.events.length > this.maxEventsPerTopic) {
            data.events.splice(0, data.events.length - this.maxEventsPerTopic);
          }
          data.firstSequence = data.events[0]?.sequence ?? data.lastSequence + 1;
          return data;
        }, { expectedRevision: current.revision });
        return updated.data.events.at(-1);
      } catch (error) {
        if (error?.code !== "REVISION_CONFLICT") throw error;
      }
    }
  }

  async details(topic, eventIds) {
    invariant(Array.isArray(eventIds) && eventIds.length > 0 && eventIds.length <= 2_000 && eventIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200), "REALTIME_EVENT_IDS_INVALID", "事件编号无效", { status: 400 });
    const selected = new Set(eventIds);
    const { data } = await this.#repository(topic).read();
    const events = data.events.filter((event) => selected.has(event.eventId));
    return { events: structuredClone(events), missingEventIds: eventIds.filter((id) => !events.some((event) => event.eventId === id)) };
  }

  async replay(topic, options = {}) {
    const afterSequence = Number(options.afterSequence ?? 0);
    const limit = Number(options.limit ?? 500);
    invariant(Number.isSafeInteger(afterSequence) && afterSequence >= 0, "REALTIME_CURSOR_INVALID", "afterSequence 无效", { status: 400 });
    invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 2_000, "REALTIME_LIMIT_INVALID", "Realtime replay limit 无效", { status: 400 });
    const envelope = await this.#repository(topic).read();
    const data = envelope.data;
    // `after=0` means "start from the earliest retained event". This remains
    // useful after retention or stream compaction creates sequence gaps, while
    // non-zero stale cursors still receive an explicit expiry response.
    invariant(data.lastSequence === 0 || afterSequence === 0 || afterSequence >= data.firstSequence - 1, "REALTIME_REPLAY_EXPIRED", "请求的事件已超出回放窗口", {
      status: 410,
      details: { firstAvailableSequence: data.firstSequence },
    });
    const events = data.events.filter((event) => event.sequence > afterSequence).slice(0, limit);
    return {
      topic,
      events: structuredClone(events),
      lastSequence: data.lastSequence,
      nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
      hasMore: (events.at(-1)?.sequence ?? afterSequence) < data.lastSequence,
    };
  }
}
