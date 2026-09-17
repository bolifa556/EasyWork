import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const timelineUrl = new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url);
const memoryUrl = new URL("../app/easywork/features/conversation/timeline-disclosure-memory.mjs", import.meta.url);
const source = await readFile(timelineUrl, "utf8");
const ast = ts.createSourceFile("timeline.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "useTimelineDisclosure");
const compiled = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function freshMemory(name) {
  const url = new URL(memoryUrl);
  url.searchParams.set("page", name);
  return import(url.href);
}

function disclosureFixture(memory) {
  let state;
  const hook = new Function("useState", "hasTimelineDisclosureChoice", "readTimelineDisclosure", "writeTimelineDisclosure", `${compiled}; return useTimelineDisclosure;`)(
    (initialize) => {
      if (state === undefined) state = typeof initialize === "function" ? initialize() : initialize;
      return [state, (next) => { state = typeof next === "function" ? next(state) : next; }];
    },
    memory.hasTimelineDisclosureChoice,
    memory.readTimelineDisclosure,
    memory.writeTimelineDisclosure,
  );
  return { async render(identity, expandable = true, updating = false) {
    return hook(identity, expandable, updating);
  } };
}

test("activity disclosure choices survive conversation switches within one page", async () => {
  const memory = await freshMemory("same-page");
  const mounted = disclosureFixture(memory);

  const first = await mounted.render("conversation-a:activity-1");
  assert.equal(first[0], false);
  first[1]();
  assert.equal((await mounted.render("conversation-a:activity-1"))[0], true);

  assert.equal((await mounted.render("conversation-b:activity-1"))[0], false);
  assert.equal((await mounted.render("conversation-a:activity-1"))[0], true);

  const remounted = disclosureFixture(memory);
  assert.equal((await remounted.render("conversation-a:activity-1"))[0], true);
});

test("live activity opens and settles automatically until the user takes control", async () => {
  const memory = await freshMemory("live-automation");
  const untouched = disclosureFixture(memory);

  assert.equal((await untouched.render("live", true, true, "first"))[0], true, "更新中的汇总栏自动展开");
  assert.equal((await untouched.render("live", true, true, "delta"))[0], true, "后续更新保持展开");
  assert.equal((await untouched.render("live", true, false, "done"))[0], false, "更新结束时自动收纳");

  const userCollapsed = disclosureFixture(await freshMemory("user-collapsed"));
  await userCollapsed.render("live", true, true, "first");
  const opened = await userCollapsed.render("live", true, true, "delta");
  opened[1]();
  assert.equal((await userCollapsed.render("live", true, true, "more"))[0], false, "用户收纳后更新不再强制展开");
  assert.equal((await userCollapsed.render("live", true, false, "done"))[0], false);

  const userExpanded = disclosureFixture(await freshMemory("user-expanded"));
  const closed = await userExpanded.render("complete", true, false, "done");
  closed[1]();
  assert.equal((await userExpanded.render("complete", true, true, "retry"))[0], true, "用户展开后自动状态不再覆盖");
  assert.equal((await userExpanded.render("complete", true, false, "settled"))[0], true);
});

test("a refreshed page and another device both start with every activity collapsed", async () => {
  const firstPage = await freshMemory("first-page");
  firstPage.writeTimelineDisclosure("conversation-a:activity-1", true);
  assert.equal(firstPage.readTimelineDisclosure("conversation-a:activity-1"), true);

  const refreshedPage = await freshMemory("refreshed-page");
  const otherDevice = await freshMemory("other-device");
  assert.equal(refreshedPage.readTimelineDisclosure("conversation-a:activity-1"), false);
  assert.equal(otherDevice.readTimelineDisclosure("conversation-a:activity-1"), false);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("nested activity rows use the same page-memory disclosure state", () => {
  for (const name of [
    "BackgroundResult",
    "BackgroundTrace",
    "CurrentStateTrace",
    "ReasoningTrace",
    "WebThought",
    "WorkHandoff",
    "HandoffReferenceGroup",
    "HandoffDetailReference",
    "CommandItem",
    "OperationGroup",
    "FileItem",
    "EventRow",
    "AgentThinking",
    "AgentCall",
  ]) {
    const node = ast.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
    assert.ok(node, `${name} should exist`);
    assert.match(node.getText(ast), /useTimelineDisclosure\(/, `${name} should remember its disclosure state`);
  }
});
