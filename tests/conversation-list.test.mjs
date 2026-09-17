import assert from "node:assert/strict";
import test from "node:test";
import { applyBootstrapConversationChange, applyConversationListChange, mergeConversationListChange, preserveConversationRows, reconcileConversationPage, reconcileConversationRows } from "../app/easywork/runtime/conversation-list.ts";

const row = (id, projectId = null, extra = {}) => ({ id, projectId, title: `对话 ${id}`, mode: "chat", pinned: false, revision: 1, createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z", lastMessageAt: "2026-09-16T00:00:00Z", runningTaskId: null, ...extra });

test("automatic titles patch their own rows while loaded pages, row references and order survive", () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(String(index)));
  const change = { conversationId: "25", kind: "renamed", title: "自动生成的新标题", revision: 4 };
  const next = applyConversationListChange(rows, change, null);
  assert.equal(next.length, 40);
  assert.deepEqual(next.map(item => item.id), rows.map(item => item.id));
  assert.equal(next[25].title, change.title);
  for (const [index, item] of rows.entries()) if (index !== 25) assert.equal(next[index], item);
  assert.equal(applyConversationListChange(next, change, null), next);
  assert.equal(applyConversationListChange(next, { ...change, revision: 2, title: "迟到的标题" }, null), next);
});

test("new conversations insert once without truncating expanded history or moving pinned rows", () => {
  const rows = [row("pinned", null, { pinned: true }), ...Array.from({ length: 20 }, (_, i) => row(String(i)))];
  const change = { conversationId: "new", kind: "created", conversation: row("new") };
  const next = applyConversationListChange(rows, change, null);
  assert.deepEqual(next.slice(0, 3).map(item => item.id), ["pinned", "new", "0"]);
  assert.equal(next.length, 22);
  assert.equal(applyConversationListChange(next, change, null), next);
  const snapshot = rows.slice(0, 8).map(item => ({ ...item }));
  assert.equal(reconcileConversationRows(next, snapshot, null), next, "a partial bootstrap page cannot truncate or reset expanded history");
});

test("project rows update independently and moves or deletions affect only their own conversation", () => {
  const project = [row("a", "project"), row("b", "project")];
  const others = [row("c", "other")];
  const change = { conversationId: "a", kind: "renamed", title: "改名", revision: 2 };
  assert.equal(applyConversationListChange(others, change, "other"), others);
  const renamed = applyConversationListChange(project, change, "project");
  const moved = { conversationId: "a", kind: "updated", conversation: { ...renamed[0], projectId: null, revision: 3 } };
  assert.deepEqual(applyConversationListChange(renamed, moved, "project"), [project[1]]);
  assert.equal(applyConversationListChange([], moved, null)[0].title, "改名");
  assert.deepEqual(applyConversationListChange(renamed, { conversationId: "b", kind: "deleted" }, "project"), [renamed[0]]);
});

test("bootstrap title and creation updates preserve the selected conversation and unrelated metadata", () => {
  const current = { actor: { id: "user" }, projects: [{ id: "project" }], runningTasks: [], recentConversations: [row("first"), row("second")], conversationNavigation: { conversationId: "inside", conversation: row("inside", "project"), projectConversations: { projectId: "project", items: [row("inside", "project"), row("sibling", "project")], nextCursor: "page-2" } } };
  const renamed = applyBootstrapConversationChange(current, { conversationId: "sibling", kind: "renamed", title: "项目的新标题", revision: 2 });
  assert.equal(renamed.recentConversations, current.recentConversations);
  assert.equal(renamed.conversationNavigation.conversation, current.conversationNavigation.conversation);
  assert.equal(renamed.conversationNavigation.projectConversations.nextCursor, "page-2");
  assert.equal(renamed.conversationNavigation.projectConversations.items[1].title, "项目的新标题");
  const created = applyBootstrapConversationChange(current, { conversationId: "new", kind: "created", conversation: row("new") });
  assert.equal(created.conversationNavigation, current.conversationNavigation);
  assert.equal(created.projects, current.projects);
  assert.equal(created.recentConversations[0].id, "new");
});

test("late snapshots cannot overwrite a newer title or remount unchanged rows", () => {
  const rows = [row("a", null, { revision: 5, title: "最新标题" }), row("b")];
  assert.equal(preserveConversationRows(rows, [row("a"), { ...rows[1] }]), rows);
  assert.equal(reconcileConversationRows(rows, [row("a"), { ...rows[1] }], null), rows);
});

test("late pagination appends older rows and preserves a new conversation inserted during the request", () => {
  const initial = [row("a"), row("b")];
  const updated = applyConversationListChange(initial, { conversationId: "new", kind: "created", conversation: row("new") }, null);
  const paged = reconcileConversationRows(updated, [...initial, row("c"), row("d")], null, true, "append");
  assert.deepEqual(paged.map(item => item.id), ["new", "a", "b", "c", "d"]);
  assert.equal(paged[0], updated[0]);
});

test("an immutable pagination snapshot cannot resurrect moved/deleted rows or miss an unseen row's title update", () => {
  const initial = [row("a", "p"), row("b", "p")];
  const changes = new Map([
    ["b", { conversationId: "b", kind: "deleted" }],
    ["c", { conversationId: "c", kind: "renamed", title: "分页期间的新标题", revision: 2 }],
    ["d", { conversationId: "d", kind: "updated", conversation: row("d", "other", { revision: 2 }) }],
  ]);
  const next = reconcileConversationPage(initial, [row("b", "p"), row("c", "p"), row("d", "p")], "p", changes.values(), "append");
  assert.deepEqual(next.map(item => item.id), ["a", "c"]);
  assert.equal(next[1].title, "分页期间的新标题");
  assert.equal(next[0], initial[0]);
});

test("a later automatic title preserves earlier creation or move metadata for older pages", () => {
  const moved = { conversationId: "a", kind: "updated", conversation: row("a", "new-project", { revision: 2 }) };
  const renamed = mergeConversationListChange(moved, { conversationId: "a", kind: "renamed", title: "新的自动标题", revision: 3 });
  assert.equal(renamed.conversation.projectId, "new-project");
  assert.equal(renamed.conversation.title, "新的自动标题");
  assert.deepEqual(reconcileConversationPage([], [row("a", "old-project")], "old-project", [renamed]), []);
  const created = mergeConversationListChange({ ...moved, kind: "created" }, { conversationId: "a", kind: "renamed", title: "新的自动标题", revision: 3 });
  assert.equal(reconcileConversationPage([], [], "new-project", [created])[0].title, "新的自动标题");
  assert.equal(mergeConversationListChange(renamed, moved), renamed);
  const deleted = { conversationId: "a", kind: "deleted" };
  assert.equal(mergeConversationListChange(deleted, moved), deleted);
  const restored = { conversationId: "a", kind: "created", conversation: row("a", "new-project", { revision: 3 }) };
  assert.equal(mergeConversationListChange(deleted, restored), restored, "failed optimistic deletion can restore the row");
});
