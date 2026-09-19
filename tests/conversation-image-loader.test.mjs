import assert from "node:assert/strict";
import test from "node:test";
import { createConversationImageLoader } from "../app/easywork/features/conversation/conversation-image-loader.mjs";

const serverEvent = "easywork:servers-changed";
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const events = new EventTarget(), states = [], revoked = [], requests = [];
  let urls = 0;
  const api = {
    post: async (_path, body) => { requests.push(body); return { data: { previewId: `preview_${requests.length}`, size: 3, mime: "image/png" } }; },
    raw: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    ...overrides,
  };
  const loader = createConversationImageLoader({ api, source: { kind: "artifact", artifactId: "artifact_a" }, thumbnail: true,
    onState: (state) => states.push(state), eventTarget: events, serverEvent,
    createUrl: () => `blob:preview_${++urls}`, revokeUrl: (url) => revoked.push(url) });
  const connected = () => events.dispatchEvent(new CustomEvent(serverEvent, { detail: { kind: "connected", serverId: "server_a" } }));
  return { loader, states, requests, revoked, connected, events };
}

for (const failureStage of ["post", "raw"]) test(`SSH recovery retries a failed ${failureStage === "post" ? "preview creation" : "content stream"} with a new preview`, async (t) => {
  let attempts = 0;
  const value = fixture({ [failureStage]: async () => {
    if (++attempts === 1) throw new Error("SSH 未连接");
    return failureStage === "post" ? { data: { previewId: "preview_recovered", size: 3, mime: "image/png" } } : new Response(new Uint8Array([1, 2, 3]));
  } });
  t.after(() => value.loader.dispose());
  await settle();
  assert.equal(value.states.at(-1).error, "SSH 未连接");
  value.connected();
  await settle();
  assert.equal(value.states.at(-1).value, "blob:preview_1");
  assert.equal(value.states.at(-1).error, "");
  value.connected();
  await settle();
  assert.equal(attempts, 2, "successful thumbnails must not reload on another connection event");
  if (failureStage === "raw") {
    assert.equal(value.requests.length, 2);
    assert.equal(value.requests[0].variant, "thumbnail");
  }
});

test("a connection restored while the old request is pending is not lost", async (t) => {
  let rejectOld, calls = 0;
  const value = fixture({ raw: async () => {
    if (++calls === 1) return new Promise((_resolve, reject) => { rejectOld = reject; });
    return new Response(new Uint8Array([1, 2, 3]));
  } });
  t.after(() => value.loader.dispose());
  await settle();
  value.connected();
  rejectOld(new Error("old connection closed"));
  await settle();
  assert.equal(calls, 2);
  assert.equal(value.states.at(-1).value, "blob:preview_1");
});

test("manual retry releases the old object URL, and leaving the conversation cancels pending loads", async () => {
  const value = fixture();
  await settle();
  value.loader.retry();
  await settle();
  assert.deepEqual(value.revoked, ["blob:preview_1"]);
  value.loader.dispose();
  assert.deepEqual(value.revoked, ["blob:preview_1", "blob:preview_2"]);
  value.connected();
  await settle();
  assert.equal(value.requests.length, 2);
  let complete;
  const pending = fixture({ raw: () => new Promise((resolve) => { complete = resolve; }) });
  await settle();
  pending.loader.dispose();
  const count = pending.states.length;
  complete(new Response(new Uint8Array([1, 2, 3])));
  await settle();
  assert.equal(pending.states.length, count);
  assert.equal(pending.revoked.length, 0, "an aborted load must never create an object URL");
});
