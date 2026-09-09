import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteJson } from "../gateway/core/repository.mjs";
import { compactJournalEvents, JOURNAL_SCHEMA_VERSION } from "../gateway/core/realtime.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");

// Independent content check: preserve continuous text and every non-stream
// record in order, without depending on the compactor's output IDs.
export function journalContentFingerprint(events) {
  const segments = [];
  for (const event of events) {
    const payload = event.payload || {};
    const native = ["reasoning", "message"].includes(event.kind) && payload.event?.delta === true && typeof payload.event.text === "string" && payload.source?.itemId;
    const web = event.kind === "run.reasoning.delta" && typeof payload.content === "string";
    const output = event.kind === "run.output.delta" && typeof payload.content === "string" && payload.segmentId;
    if (!native && !web && !output) { segments.push({ record: event }); continue; }
    const key = JSON.stringify([event.producer, event.kind, event.status, Object.entries(event.ids || {}).sort(), native ? payload.source.itemId : web ? [event.ids?.runId, payload.iteration ?? 0] : [event.ids?.runId, payload.segmentId]]);
    const text = native ? payload.event.text : payload.content;
    const previous = segments.at(-1);
    if (previous?.key === key) {
      previous.text = payload.realtimeStreamKey && previous.streamKey === payload.realtimeStreamKey ? text : previous.text + text;
      previous.streamKey = payload.realtimeStreamKey;
    } else segments.push({ key, text, streamKey: payload.realtimeStreamKey });
  }
  return hash(JSON.stringify(segments.map(segment => segment.key ? { key: segment.key, text: segment.text } : segment)));
}

export function upgradeJournal(envelope) {
  assert.ok(envelope && [1, JOURNAL_SCHEMA_VERSION].includes(envelope.schemaVersion), "unknown journal schema");
  if (envelope.schemaVersion === JOURNAL_SCHEMA_VERSION) return envelope;
  const data = envelope.data;
  assert.ok(data && Array.isArray(data.events) && typeof data.topic === "string");
  let sequence = 0;
  for (const event of data.events) {
    assert.equal(event.topic, data.topic);
    assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > sequence && event.sequence <= data.lastSequence, "invalid event order");
    sequence = event.sequence;
  }
  const events = compactJournalEvents(data.events);
  assert.equal(journalContentFingerprint(events), journalContentFingerprint(data.events), "migration changed historical content");
  assert.deepEqual(compactJournalEvents(events), events, "compaction is not idempotent");
  return { ...envelope, schemaVersion: JOURNAL_SCHEMA_VERSION, revision: envelope.revision + 1,
    data: { ...data, events, firstSequence: events[0]?.sequence ?? data.lastSequence + 1 } };
}

async function directories(root) {
  try { return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export async function migrateJournals({ dataRoot, backupRoot, apply = false }) {
  dataRoot = path.resolve(dataRoot);
  if (apply) {
    assert.ok(backupRoot, "backup directory is required"); backupRoot = path.resolve(backupRoot);
    await fs.mkdir(path.dirname(backupRoot), { recursive: true });
    await fs.mkdir(backupRoot);
  }
  const report = { at: new Date().toISOString(), apply, dataRoot, backupRoot, files: [], beforeEvents: 0, afterEvents: 0, beforeBytes: 0, afterBytes: 0, alreadyCurrent: 0 };
  for (const category of ["users", "guests"]) {
    for (const actor of await directories(path.join(dataRoot, category))) {
      const root = path.join(dataRoot, category, actor, "runtime", "realtime");
      for (const topic of await directories(root)) {
        const file = path.join(root, topic, "journal.json");
        let original;
        try { original = await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        const envelope = JSON.parse(original.toString("utf8"));
        if (envelope.schemaVersion === JOURNAL_SCHEMA_VERSION) { report.alreadyCurrent += 1; continue; }
        const next = upgradeJournal(envelope);
        const serialized = `${JSON.stringify(next)}\n`;
        const relativePath = path.relative(dataRoot, file);
        const originalHash = hash(original);
        if (apply) {
          const backup = path.join(backupRoot, relativePath);
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.writeFile(backup, original, { flag: "wx" });
          assert.equal(hash(await fs.readFile(backup)), originalHash, "backup verification failed");
          assert.equal(hash(await fs.readFile(file)), originalHash, "journal changed during migration; stop the gateway first");
          await atomicWriteJson(file, next, { compact: true });
          assert.equal(hash(await fs.readFile(file)), hash(serialized), "written journal differs from verified migration");
        }
        report.files.push({ path: relativePath, beforeHash: originalHash, afterHash: hash(serialized), beforeEvents: envelope.data.events.length, afterEvents: next.data.events.length });
        report.beforeEvents += envelope.data.events.length; report.afterEvents += next.data.events.length;
        report.beforeBytes += original.length; report.afterBytes += Buffer.byteLength(serialized);
      }
    }
  }
  if (apply) await fs.writeFile(path.join(backupRoot, "manifest.json"), JSON.stringify(report, null, 2));
  return report;
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(true));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const apply = args.includes("--apply");
  if (apply) assert.equal(await listening(Number(process.env.EASYWORK_WEB_PORT || 8001)), false, "stop the gateway before applying the migration");
  const report = await migrateJournals({ dataRoot: option("--data-root") || process.env.EASYWORK_DATA_ROOT || "data", backupRoot: option("--backup-root"), apply });
  if (option("--report")) await fs.writeFile(option("--report"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, files: report.files.length }, null, 2));
}
