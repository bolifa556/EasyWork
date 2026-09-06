import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { captureSkillSnapshot, restoreSkillSnapshot, readSkillView, selectedSkillCommand } from "../gateway/core/agent-runtime/skill-views.mjs";

const runFile = promisify(execFile);
function shellWords(command) {
  const words = []; let word = "", quote = null;
  for (const char of command) {
    if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) { if (word) { words.push(word); word = ""; } }
    else word += char;
  }
  if (word) words.push(word);
  return words;
}
class LocalExecutor {
  failManifest = false;
  async readFile(file) { return fs.readFile(file); }
  async writeAtomic(file, bytes, options) {
    if (this.failManifest && file.endsWith("/skill-view.json")) { this.failManifest = false; throw new Error("manifest disk fault"); }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes, options);
  }
  async exec(command) {
    const args = shellWords(command);
    if (args[0] === "python3") {
      const result = await runFile(process.env.EASYWORK_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3"), args.slice(1), { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return { code: 0, ...result };
    }
    assert.equal(args[0], "ln");
    await fs.mkdir(path.dirname(args[4]), { recursive: true });
    await fs.symlink(args[3], args[4], process.platform === "win32" ? "junction" : "dir");
    assert.equal(args[6], "mv");
    try { assert.equal((await fs.lstat(args[10])).isSymbolicLink(), true); await fs.unlink(args[10]); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fs.rename(args[9], args[10]);
    return { code: 0, stdout: "" };
  }
}
function pathsFor(root, binding) {
  const easyworkRoot = `${root}/.easywork`;
  const runtimeRoot = `${easyworkRoot}/runtime/agents/claude-code/${binding}`;
  return { easyworkRoot, runtimeRoot, runtimeState: `${runtimeRoot}/state`, skillsRoot: `${runtimeRoot}/skills` };
}
const skill = (body) => `---\nname: guide\ndescription: A test guide.\n---\n\n${body}\n`;

test("historical Skill snapshots inherit edited, added and deleted files and survive a partial restore", async () => {
  const root = (await fs.mkdtemp(path.join(os.tmpdir(), "easywork-skill-snapshot-"))).replaceAll("\\", "/");
  const executor = new LocalExecutor();
  const parent = pathsFor(root, "parent"), child = pathsFor(root, "child"), empty = pathsFor(root, "empty");
  try {
    await fs.mkdir(parent.skillsRoot, { recursive: true });
    const first = await captureSkillSnapshot(executor, parent, "task-before-skills", []);
    const pin = { skillId: "guide", version: "v1", sha256: "a".repeat(64) };
    await executor.writeAtomic(`${parent.skillsRoot}/guide/SKILL.md`, skill("parent instructions"));
    await executor.writeAtomic(`${parent.skillsRoot}/guide/说明 (周末).txt`, "edited before the fork");
    await executor.writeAtomic(`${parent.skillsRoot}/guide/removed.txt`, "delete before the fork");
    await fs.unlink(`${parent.skillsRoot}/guide/removed.txt`);
    const boundary = await captureSkillSnapshot(executor, parent, "task-boundary", [pin]);
    await executor.writeAtomic(`${parent.skillsRoot}/guide/说明 (周末).txt`, "parent later edit");
    await executor.writeAtomic(`${parent.skillsRoot}/future/SKILL.md`, skill("future skill"));
    assert.deepEqual(await captureSkillSnapshot(executor, parent, "task-boundary", [pin]), boundary);
    executor.failManifest = true;
    await assert.rejects(() => restoreSkillSnapshot(executor, child, boundary), /manifest disk fault/);
    await restoreSkillSnapshot(executor, child, boundary);
    assert.equal(await fs.readFile(`${child.skillsRoot}/guide/说明 (周末).txt`, "utf8"), "edited before the fork");
    await assert.rejects(() => fs.access(`${child.skillsRoot}/guide/removed.txt`), { code: "ENOENT" });
    await assert.rejects(() => fs.access(`${child.skillsRoot}/future`), { code: "ENOENT" });
    await executor.writeAtomic(`${child.skillsRoot}/guide/SKILL.md`, skill("child instructions"));
    assert.match(await fs.readFile(`${parent.skillsRoot}/guide/SKILL.md`, "utf8"), /parent instructions/);
    const command = await selectedSkillCommand(executor, child, [{ ...pin, remotePath: `${child.skillsRoot}/guide` }]);
    assert.match(await fs.readFile(command.path, "utf8"), /child instructions/);
    await restoreSkillSnapshot(executor, empty, first);
    assert.deepEqual((await readSkillView(executor, empty)).skills, []);
    const descriptorFile = `${boundary.root}/snapshot.json`;
    const descriptor = JSON.parse(await fs.readFile(descriptorFile, "utf8"));
    descriptor.skillPins[0].version = "forged";
    await fs.writeFile(descriptorFile, JSON.stringify(descriptor));
    await assert.rejects(() => restoreSkillSnapshot(executor, pathsFor(root, "tampered"), boundary), { code: "AGENT_SKILL_SNAPSHOT_CHANGED" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
