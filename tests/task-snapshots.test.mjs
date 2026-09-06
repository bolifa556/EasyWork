import assert from "node:assert/strict";
import test from "node:test";
import { isActiveTask, mergeTaskSnapshots } from "../app/core/task-snapshots.ts";

test("terminal snapshots win over stale bootstrap, HTTP and stop responses before active filtering", () => {
  const running = { id: "task", revision: 3, status: "running", updatedAt: "2026-09-05T01:00:00Z" };
  const completed = { ...running, revision: 5, status: "completed", updatedAt: "2026-09-05T01:01:00Z" };
  for (const groups of [[[running], [completed]], [[completed], [running]], [[completed], [{ ...running, status: "interrupting" }]]]) {
    const snapshots = mergeTaskSnapshots(...groups);
    assert.deepEqual(snapshots, [completed]);
    assert.equal(snapshots.filter(isActiveTask).length, 0);
  }
  const resumed = { ...running, revision: 6 };
  assert.deepEqual(mergeTaskSnapshots([completed], [resumed]), [resumed]);
});
