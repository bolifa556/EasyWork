import assert from "node:assert/strict";
import test from "node:test";
import { catchUpConversation } from "../app/easywork/features/conversation/conversation-stream-catchup.mjs";

const event = (sequence) => ({ sequence, eventId: `event-${sequence}` });

test("quiet-socket catch-up publishes each page before fetching the next and stops at its snapshot", async () => {
  const received = [];
  const urls = [];
  const cursor = await catchUpConversation({ conversationId: "one", after: 10,
    request: async (url) => {
      urls.push(url);
      if (urls.length === 1) return { events: [event(11)], lastSequence: 12, nextAfterSequence: 11, hasMore: true };
      assert.deepEqual(received, [event(11)], "first delta is already visible while the next page is pending");
      return { events: [event(12), event(13)], lastSequence: 13, nextAfterSequence: 13, hasMore: true };
    }, onPage: (events) => received.push(...events),
  });
  assert.deepEqual(received, [event(11), event(12)]);
  assert.equal(urls.length, 2);
  assert.match(urls[1], /after=11&limit=500$/);
  assert.equal(cursor, 12, "unpublished later events must remain eligible for the next catch-up");
});

test("an expired HTTP replay cursor restarts from retained history once", async () => {
  const urls = [];
  const received = [];
  await catchUpConversation({ conversationId: "one", after: 2,
    request: async (url) => {
      urls.push(url);
      if (urls.length === 1) throw Object.assign(new Error("expired"), { code: "REALTIME_REPLAY_EXPIRED" });
      return { events: [event(20)], lastSequence: 20, hasMore: false };
    }, onPage: (events) => received.push(...events),
  });
  assert.match(urls[1], /after=0&/);
  assert.deepEqual(received, [event(20)]);
  let attempts = 0;
  await assert.rejects(catchUpConversation({ conversationId: "one", after: 2,
    request: async () => { attempts++; throw Object.assign(new Error("expired"), { code: "REALTIME_REPLAY_EXPIRED" }); }, onPage() {},
  }), /expired/);
  assert.equal(attempts, 2);
});

test("navigating away during catch-up does not publish the abandoned response", async () => {
  const controller = new AbortController();
  let published = false;
  await assert.rejects(catchUpConversation({ conversationId: "one", signal: controller.signal,
    request: async () => { controller.abort(); return { events: [event(1)], lastSequence: 1, hasMore: false }; },
    onPage: () => { published = true; },
  }), { name: "AbortError" });
  assert.equal(published, false);
});
