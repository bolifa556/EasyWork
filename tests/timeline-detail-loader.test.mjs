import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineDetailLoader } from "../app/easywork/features/conversation/timeline-detail-loader.mjs";
import { markdownTableLayout } from "../app/easywork/features/conversation/markdown-table-layout.mjs";

const event = (id, topic = "task:one") => ({ eventId: id, topic, ids: { taskId: "one", conversationId: "conversation" }, payload: { text: `${id} detail` } });
function fixture(events, respond) {
  const loaded = new Map();
  const requests = [];
  const byId = new Map(events.map((entry) => [entry.eventId, entry]));
  const load = createTimelineDetailLoader({
    getEvent: (id) => byId.get(id), isLoaded: (id) => loaded.has(id),
    onLoaded: (entries) => entries.forEach((entry) => loaded.set(entry.eventId, entry)),
    request: async (url) => {
      const ids = new URL(url, "http://localhost").searchParams.get("ids").split(",");
      requests.push({ url, ids });
      return respond ? respond(ids, requests.length) : { events: ids.map((id) => byId.get(id)), missingEventIds: [] };
    },
  });
  return { load, loaded, requests };
}

test("expanded siblings share one request; unopened descendants and cached rows are not fetched", async () => {
  const f = fixture([event("thinking1"), event("thinking2"), event("closed-command")]);
  const reads = [f.load(["thinking1"]), f.load(["thinking2"]), f.load(["thinking1"])];
  assert.equal(f.requests.length, 0);
  await Promise.all(reads);
  assert.deepEqual(f.requests.map((r) => r.ids), [["thinking1", "thinking2"]]);
  assert.equal(f.loaded.has("closed-command"), false);
  await f.load(["thinking1", "thinking2"]);
  assert.equal(f.requests.length, 1);
  await f.load(["closed-command"]);
  assert.deepEqual(f.requests[1].ids, ["closed-command"]);
});

test("an expired stream fragment does not reject other visible rows or keep its request pending", async () => {
  const f = fixture([event("ok"), event("expired")], () => ({ events: [event("ok")], missingEventIds: ["expired"] }));
  const good = f.load(["ok"]);
  const missing = assert.rejects(f.load(["expired"]), { code: "TIMELINE_DETAIL_UNAVAILABLE" });
  await Promise.all([good, missing]);
  assert.equal(f.loaded.has("ok"), true);
  await assert.rejects(f.load(["expired"]), { code: "TIMELINE_DETAIL_UNAVAILABLE" });
  assert.equal(f.requests.length, 2);
});

test("network failure allows an explicit retry without fetching hidden rows", async () => {
  const f = fixture([event("one"), event("closed")], (ids, attempt) => {
    if (attempt === 1) throw new Error("offline");
    return { events: ids.map((id) => event(id)), missingEventIds: [] };
  });
  await assert.rejects(f.load(["one"]), /offline/);
  await f.load(["one"]);
  assert.deepEqual(f.requests.map((r) => r.ids), [["one"], ["one"]]);
});

test("explicit expansion never waits for unrelated queued prefetch in its request", async () => {
  const ids = Array.from({ length: 40 }, (_, index) => `cold-${index}`);
  const f = fixture([...ids.map(id => event(id)), event("visible")]);
  await Promise.all([f.load.prefetch([...ids, "visible"]), f.load(["visible"])]);
  assert.deepEqual(f.requests[0].ids, ["visible"]);
  assert.ok(f.requests.slice(1).every(request => request.ids.length <= 8));
  assert.equal(f.requests.flatMap(request => request.ids).length, 41);
  assert.equal(f.loaded.size, 41);
});

test("large visible groups are batched without omission and web/task detail routes stay separate", async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `e${index}`);
  const f = fixture([...ids.map((id) => event(id)), event("web", "conversation:conversation")]);
  await Promise.all([f.load(ids), f.load(["web"])]);
  assert.equal(f.loaded.size, 206);
  assert.deepEqual(f.requests.filter((r) => r.url.startsWith("/api/tasks/")).map((r) => r.ids.length), [100, 100, 5]);
  assert.match(f.requests.at(-1).url, /^\/api\/conversations\/conversation\/events\/details/);
});

test("table columns reserve readable space for short fields and stack on narrow containers", () => {
  const layout = markdownTableLayout([["软件", "conda 环境", "自检结果", "真实跑过的作业"], ["RFdiffusion", "envs/rfdiff", "torch 与 CUDA 的环境检查已经完成。".repeat(12), "logs/rfd_rfd_553.out"]]);
  assert.ok(Math.abs(layout.widths.reduce((sum, width) => sum + width, 0) - 100) < 0.001);
  assert.ok(layout.widths[1] >= 15);
  assert.ok(layout.widths[2] > layout.widths[1]);
  assert.ok(layout.stackBelow > 360 && layout.stackBelow < 600);
  assert.equal(markdownTableLayout([["参数", "值"], ["CPU", "8"]]).stackBelow, 0);
});
