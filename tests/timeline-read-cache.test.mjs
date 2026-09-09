import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AtomicJsonRepository, atomicWriteJson, clearRepositoryReadCache } from "../gateway/core/repository.mjs";
import { ReadCache } from "../gateway/core/read-cache.mjs";
import { RealtimeEventJournal, JOURNAL_SCHEMA_VERSION } from "../gateway/core/realtime.mjs";
import { createTimelineDetailLoader } from "../app/easywork/features/conversation/timeline-detail-loader.mjs";
import { getTimelineDetailCache, clearTimelineDetailCache } from "../app/easywork/features/conversation/timeline-detail-cache.mjs";
import { upgradeJournal, journalContentFingerprint, migrateJournals } from "../scripts/migrate-realtime-journals.mjs";

const actor = { actorType: "user", actorId: "cache-user", deviceId: "device", sessionId: "session" };
const topic = "task:cache";
async function fixture(t, options = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-read-cache-"));
  t.after(async () => { clearRepositoryReadCache(dataRoot); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const reads = [];
  const journal = new RealtimeEventJournal({ dataRoot, actor, onRead: entry => reads.push(entry), ...options });
  const relativePath = ["runtime", "realtime", crypto.createHash("sha256").update(topic).digest("hex"), "journal.json"];
  const repository = new AtomicJsonRepository({ dataRoot, actor, relativePath, schemaVersion: JOURNAL_SCHEMA_VERSION, defaultData: () => ({ topic, firstSequence: 1, lastSequence: 0, events: [] }) });
  return { dataRoot, journal, reads, repository };
}
const detail = (id, sequence = 1) => ({ eventId: id, sequence, actorId: "cache-user", topic, producer: "agent:codex", kind: "reasoning", ids: { taskId: "cache", conversationId: "conversation" }, payload: { event: { text: "正文" } } });
const summary = event => ({ ...event, payload: { event: { text: "" }, timelineDetailIds: [event.eventId] } });
const idsOf = url => new URL(url, "http://localhost").searchParams.get("ids").split(",");

test("concurrent journal details parse once and preserve order, missing IDs and caller isolation", async t => {
  const f = await fixture(t);
  const first = await f.journal.append(topic, { eventId: "first", payload: { nested: { value: "original" } } });
  const second = await f.journal.append(topic, { eventId: "second", payload: { value: "second" } });
  clearRepositoryReadCache(f.dataRoot); f.reads.length = 0;
  const replies = await Promise.all(Array.from({ length: 6 }, () => f.journal.details(topic, [second.eventId, "absent", first.eventId, first.eventId, "absent"])));
  assert.equal(f.reads.filter(entry => !entry.cacheHit).length, 1);
  assert.deepEqual(replies[0].events.map(event => event.eventId), ["first", "second"]);
  assert.deepEqual(replies[0].missingEventIds, ["absent", "absent"]);
  replies[0].events[0].payload.nested.value = "mutated";
  assert.equal((await f.journal.details(topic, ["first"])).events[0].payload.nested.value, "original");
});

test("cache sees commits from another repository and external file replacement, and cannot revive deleted files", async t => {
  const f = await fixture(t);
  await f.journal.append(topic, { eventId: "first" });
  await f.journal.details(topic, ["first"]);
  const initial = await f.repository.read();
  await f.repository.update(data => { data.events[0].payload = { changed: true }; }, { expectedRevision: initial.revision });
  assert.equal((await f.journal.details(topic, ["first"])).events[0].payload.changed, true);
  const changed = await f.repository.read(); changed.data.events[0].payload = { restored: true };
  await atomicWriteJson(f.repository.filePath, changed);
  assert.equal((await f.journal.details(topic, ["first"])).events[0].payload.restored, true);
  await fs.unlink(f.repository.filePath);
  assert.deepEqual((await f.journal.details(topic, ["first"])).missingEventIds, ["first"]);
});

test("stream replacement and retention invalidate old details while replay pins its original version", async t => {
  const f = await fixture(t, { maxEventsPerTopic: 3 });
  const append = text => f.journal.append(topic, { producer: "agent:codex", kind: "reasoning", payload: { source: { itemId: "thought" }, event: { delta: true, text } } });
  const first = await append("你"); await f.journal.details(topic, [first.eventId]);
  const second = await append("好");
  assert.deepEqual((await f.journal.details(topic, [first.eventId])).missingEventIds, [first.eventId]);
  assert.equal((await f.journal.details(topic, [second.eventId])).events[0].payload.event.text, "你好");
  await f.journal.append(topic, { eventId: "third" });
  await f.journal.append(topic, { eventId: "fourth" });
  const pages = f.journal.replayPages(topic, { limit: 1 });
  assert.equal((await pages.next()).value.events[0].eventId, second.eventId);
  await f.journal.append(topic, { eventId: "fifth" });
  const remaining = []; for await (const page of pages) remaining.push(...page.events);
  assert.deepEqual(remaining.map(event => event.eventId), ["third", "fourth"]);
  assert.deepEqual((await f.journal.details(topic, [second.eventId])).missingEventIds, [second.eventId]);
});

test("failed write never publishes uncommitted cache data and expectedRevision remains required for ordinary edits", async t => {
  const f = await fixture(t);
  await f.journal.append(topic, { eventId: "committed" });
  const originalRename = fs.rename;
  fs.rename = async (source, target) => { if (target === f.repository.filePath) throw Object.assign(new Error("injected write failure"), { code: "EIO" }); return originalRename(source, target); };
  try { await assert.rejects(f.journal.append(topic, { eventId: "uncommitted" }), /injected write failure/); }
  finally { fs.rename = originalRename; }
  assert.deepEqual((await f.journal.replay(topic)).events.map(event => event.eventId), ["committed"]);
  await assert.rejects(f.repository.update(data => data), { code: "EXPECTED_REVISION_REQUIRED" });
  const next = await f.journal.append(topic, { eventId: "next" }); assert.equal(next.sequence, 2);
});

test("cache budgets evict read models without changing their callers' held snapshots", () => {
  const cache = new ReadCache({ maxBytes: 10 });
  const first = { value: "first" }; cache.set("first", first, 6); cache.set("second", { value: "second" }, 6);
  assert.equal(cache.get("first"), undefined); assert.equal(first.value, "first"); assert.equal(cache.bytes, 6);
});

test("current-page prefetch shares explicit requests, survives revisits and stays isolated by actor/conversation", async () => {
  clearTimelineDetailCache();
  const events = [detail("a"), detail("b", 2)];
  const page = getTimelineDetailCache("actor-a:conversation-a"); let requests = 0;
  page.ingest(events.map(summary));
  page.activate(async url => { requests += 1; return { events: idsOf(url).map(id => events.find(event => event.eventId === id)) }; });
  await Promise.all([page.prefetch(), page.load(["a"])]);
  assert.equal(requests, 1); assert.equal(page.get(events[0]).payload.event.text, "正文");
  page.deactivate();
  const revisited = getTimelineDetailCache("actor-a:conversation-a");
  revisited.ingest(events.map(summary)); revisited.activate(async () => { throw new Error("must reuse cached detail"); });
  await revisited.prefetch(); await revisited.load(["a", "b"]);
  assert.equal(getTimelineDetailCache("actor-b:conversation-a").get(events[0]), undefined);
  assert.equal(getTimelineDetailCache("actor-a:conversation-b").get(events[0]), undefined);
  clearTimelineDetailCache();
});

test("leaving a page aborts queued prefetch and ignores a late response", async () => {
  clearTimelineDetailCache();
  const events = Array.from({ length: 205 }, (_, i) => detail(`e${i}`, i + 1));
  const page = getTimelineDetailCache("actor:leaving");
  page.ingest(events.map(summary));
  let requests = 0, release, signal;
  page.activate((url, requestSignal) => { requests += 1; signal = requestSignal; return new Promise(resolve => { release = () => resolve({ events: events.filter(event => idsOf(url).includes(event.eventId)) }); }); });
  const prefetch = page.prefetch().catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  page.deactivate(); assert.equal(signal.aborted, true); release();
  assert.equal((await prefetch).name, "AbortError");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); assert.equal(page.get(events[0]), undefined);
  clearTimelineDetailCache();
});

test("manual expansion can overtake pending background batches without duplicating their IDs", async () => {
  const events = Array.from({ length: 205 }, (_, i) => detail(`e${i}`, i + 1));
  const calls = []; const loaded = new Set();
  const loader = createTimelineDetailLoader({ getEvent: id => events.find(event => event.eventId === id), isLoaded: id => loaded.has(id), onLoaded: entries => entries.forEach(event => loaded.add(event.eventId)), request: (url) => new Promise(resolve => calls.push({ ids: idsOf(url), finish: () => resolve({ events: idsOf(url).map(id => events.find(event => event.eventId === id)) }) })) });
  const prefetch = loader.prefetch(events.map(event => event.eventId));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1);
  const manual = loader(["e204"]);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls[1].ids, ["e204"]);
  calls[1].finish(); await manual; calls[0].finish();
  let finished = 2;
  while (loaded.size < events.length) {
    await new Promise(resolve => setImmediate(resolve));
    while (finished < calls.length) calls[finished++].finish();
  }
  await prefetch;
  assert.equal(calls.flatMap(call => call.ids).filter(id => id === "e204").length, 1);
});

test("offline migration backs up every changed file, keeps content/order, and runtime accepts only the new schema", async t => {
  const f = await fixture(t);
  const make = (id, sequence, text, kind = "reasoning") => ({ ...detail(id, sequence), kind, status: "updated", payload: { source: { itemId: "thought" }, event: { delta: true, text } } });
  const events = [make("a", 1, "你"), make("b", 2, "好"), make("c", 3, "阶段总结", "message"), make("d", 4, "继续")];
  const old = { schemaVersion: 1, revision: 4, updatedAt: "2026-09-08T00:00:00Z", data: { topic, events, firstSequence: 1, lastSequence: 4 } };
  await atomicWriteJson(f.repository.filePath, old);
  await assert.rejects(f.journal.replay(topic), { code: "SCHEMA_VERSION_MISMATCH" });
  const next = upgradeJournal(old);
  assert.equal(next.data.events.length, 3);
  assert.equal(journalContentFingerprint(events), journalContentFingerprint(next.data.events));
  const backupRoot = path.join(f.dataRoot, "backup");
  const result = await migrateJournals({ dataRoot: f.dataRoot, backupRoot, apply: true });
  assert.equal(result.files.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(backupRoot, result.files[0].path), "utf8")), old);
  assert.deepEqual((await f.journal.replay(topic)).events, next.data.events);
  assert.equal((await migrateJournals({ dataRoot: f.dataRoot })).files.length, 0);
});
