import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/easywork/features/conversation/ConversationTimeline.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("timeline.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "useTimelineDisclosure");
const compiled = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function disclosureFixture(saved = []) {
  const stored = new Set(saved);
  let state;
  let changed;
  let effects;
  const hook = new Function("useState", "useEffect", "storedTimelineDisclosure", "writeTimelineDisclosure", `${compiled}; return useTimelineDisclosure;`)(
    (initialize) => {
      if (!state) state = initialize();
      return [state, (next) => { state = next; changed = true; }];
    },
    (effect) => effects.push(effect),
    (identity) => stored.has(identity),
    (identity, open) => open ? stored.add(identity) : stored.delete(identity),
  );
  return { stored, async render(identity, running, expandable = true) {
    let result;
    for (let pass = 0; pass < 10; pass += 1) {
      changed = false;
      effects = [];
      result = hook(identity, running, expandable);
      effects.forEach((effect) => effect());
      await Promise.resolve();
      if (!changed) return result;
    }
    throw new Error("Disclosure state did not settle");
  } };
}

test("a new thinking phase opens automatically and completion closes even a previously saved open group", async () => {
  const f = disclosureFixture(["group"]);
  assert.equal((await f.render("group", false))[0], true);
  assert.equal((await f.render("group", true))[0], true);
  assert.equal((await f.render("group", true))[0], true);
  assert.equal((await f.render("group", false))[0], false);
  assert.equal(f.stored.has("group"), false);
  assert.equal((await f.render("group", false))[0], false);
});

test("manual choices survive new details within a phase and a new phase resumes automatic expansion", async () => {
  const f = disclosureFixture();
  assert.equal((await f.render("group", true, false))[0], false);
  const running = await f.render("group", true);
  assert.equal(running[0], true);
  running[1]();
  assert.equal((await f.render("group", true))[0], false);
  assert.equal((await f.render("group", false))[0], false);
  const completed = await f.render("group", false);
  completed[1]();
  assert.equal((await f.render("group", false))[0], true);
  assert.equal(f.stored.has("group"), true);
  assert.equal((await f.render("next-group", false))[0], false);
  assert.equal((await f.render("next-group", true))[0], true);
});
