import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentIds, parseOptions, updateCatalog } from "../agent-app/update-agent-app.mjs";
import { downloadVerified } from "../scripts/artifact-download.mjs";

const bytes = Buffer.from("test agent distribution");
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const artifact = (id) => ({ archive: "raw", file: id + "/pinned-agent", sha256: checksum(bytes), size: bytes.length, source: "https://example.test/" + id });
const quiet = () => {};

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "easywork-agent-updater-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { schemaVersion: 1, updatedAt: "2026-01-01T00:00:00Z", agents: {} };
  for (const id of agentIds) {
    manifest.agents[id] = { version: "1.0.0", artifacts: {
      "linux-x64": artifact(id),
      "linux-x64-musl": artifact(id),
      "linux-arm64": { ...artifact(id), file: id + "/pinned-arm64-agent" },
    } };
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, "pinned-agent"), bytes);
  }
  const original = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(path.join(root, "manifest.json"), original);
  return { root, manifest, original, options: { catalogRoot: root, log: quiet } };
}

async function save({ destination }) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

test("no arguments show help without accessing the catalog or downloading", async () => {
  let output = "";
  await updateCatalog([], { catalogRoot: "missing-catalog", log: (text) => { output += text; }, download: () => assert.fail("No implicit downloads") });
  assert.match(output, /--agent NAME/);
  assert.deepEqual(parseOptions([]).agents, []);
  assert.deepEqual(parseOptions(["--agent", "codex"]).platforms, ["linux-x64"]);
  assert.throws(() => parseOptions(["--check"]), /Select an Agent/);
  assert.throws(() => parseOptions(["--latest", "--agent", "codex"]), /Versions are pinned/);
});

test("selected Agent and platform alone are repaired without modifying the catalog", async (t) => {
  const { root, original, options } = await fixture(t);
  const downloads = [];
  const result = await updateCatalog(["--agent", "codex", "--platform", "linux-arm64"], {
    ...options, download: async (input) => { downloads.push(input); await save(input); },
  });
  assert.deepEqual(downloads.map((entry) => entry.destination), [path.join(root, "codex/pinned-arm64-agent")]);
  assert.equal(result.files, 1);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), original);
  assert.deepEqual((await readdir(path.join(root, "opencode"))), ["pinned-agent"]);
  assert.ok(!(await readdir(root)).includes(".update.lock"));
});

test("multiple selections deduplicate shared archives; all Agents require --all", async (t) => {
  const { options } = await fixture(t);
  let downloads = 0;
  const selected = await updateCatalog(["--agent=codex,opencode,codex", "--platform=linux-x64,linux-x64-musl"], {
    ...options, download: async (input) => { downloads += 1; await save(input); },
  });
  assert.equal(downloads, 2);
  assert.equal(selected.files, 2);
  const all = await updateCatalog(["--all", "--check"], options);
  assert.equal(all.files, 4);
});

test("array and object compatibility catalogs retain their pinned downloads", async (t) => {
  const { root, manifest, options } = await fixture(t);
  const compatibility = (id) => ({ id: "legacy", version: "0.9.0", artifacts: { "linux-x64": { ...artifact(id), file: id + "/legacy-agent" } } });
  manifest.agents.claudecode.compatibility = [compatibility("claudecode")];
  manifest.agents.qodercncli.compatibility = { baseline: compatibility("qodercncli") };
  const pinned = JSON.stringify(manifest);
  await writeFile(path.join(root, "manifest.json"), pinned);
  const result = await updateCatalog(["--agent", "claudecode,qodercncli"], { ...options, download: save });
  assert.equal(result.files, 4);
  await updateCatalog(["--agent", "claudecode,qodercncli", "--check"], options);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), pinned);
});

test("offline check detects missing and corrupted files without making changes", async (t) => {
  const { root, options } = await fixture(t);
  const isolated = { ...options, download: () => assert.fail("Check must not download") };
  const before = await readdir(root);
  await updateCatalog(["--check", "--agent", "codex"], isolated);
  assert.deepEqual(await readdir(root), before);
  await writeFile(path.join(root, "codex/pinned-agent"), "broken");
  await assert.rejects(updateCatalog(["--check", "--agent", "codex"], isolated), /integrity check failed/);
  await assert.rejects(updateCatalog(["--check", "--agent", "codex", "--platform", "linux-arm64"], isolated), /Missing Agent file/);
});

test("download failure releases the lock and never changes pinned versions", async (t) => {
  const { root, original, options } = await fixture(t);
  await assert.rejects(updateCatalog(["--agent", "codex"], { ...options, download: () => { throw new Error("interrupted"); } }), /interrupted/);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), original);
  assert.ok(!(await readdir(root)).includes(".update.lock"));
});

test("invalid selections and unsafe or missing catalog entries fail before downloading", async (t) => {
  assert.throws(() => parseOptions(["--agent", "unknown"]), /Unsupported/);
  assert.throws(() => parseOptions(["--agent", "codex", "--all"]), /either/);
  assert.throws(() => parseOptions(["--agent", "codex", "--platform", "linux-riscv64"]), /Unsupported/);
  assert.throws(() => parseOptions(["--locked", "--check"]), /only one/);
  assert.throws(() => parseOptions(["--agent"]), /Missing value/);
  const { root, manifest, options } = await fixture(t);
  const noDownload = { ...options, download: () => assert.fail("Invalid catalog must fail before download") };
  delete manifest.agents.codex;
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(updateCatalog(["--agent", "codex"], noDownload), /not present/);
  manifest.agents.codex = { version: "1.0.0", artifacts: { "linux-x64": { ...artifact("codex"), file: "../outside" } } };
  const invalid = JSON.stringify(manifest);
  await writeFile(path.join(root, "manifest.json"), invalid);
  await assert.rejects(updateCatalog(["--agent", "codex"], noDownload), /Unsafe/);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), invalid);
});

test("a competing updater cannot remove another updater's lock", async (t) => {
  const { root, options } = await fixture(t);
  await writeFile(path.join(root, ".update.lock"), "another updater");
  await assert.rejects(updateCatalog(["--agent", "codex"], options), /locked/);
  assert.equal(await readFile(path.join(root, ".update.lock"), "utf8"), "another updater");
});

test("streamed downloads preserve the previous file until checksum verification succeeds", async (t) => {
  const { root } = await fixture(t);
  const destination = path.join(root, "download");
  await writeFile(destination, "previous version");
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(await readFile(destination, "utf8"), "previous version");
    attempts += 1;
    return new Response(attempts === 1 ? Buffer.alloc(bytes.length) : bytes);
  });
  await downloadVerified({ url: "https://example.test/agent", destination, sha256: checksum(bytes), size: bytes.length });
  assert.equal(attempts, 2);
  assert.deepEqual(await readFile(destination), bytes);
  assert.ok(!(await readdir(root)).some((file) => file.includes(".partial-")));
  await downloadVerified({ url: "https://example.test/agent", destination, sha256: checksum(bytes), size: bytes.length });
  assert.equal(attempts, 2, "Valid cached file should not be fetched");
});
