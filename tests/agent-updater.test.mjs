import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseOptions, resolveLatest, updateCatalog } from "../agent-app/update-agent-app.mjs";
import { downloadVerified } from "../scripts/artifact-download.mjs";

const bytes = Buffer.from("test agent distribution");
const checksum = (value) => createHash("sha256").update(value).digest("hex");
const artifact = (id) => ({ archive: "raw", file: id + "/old-agent", sha256: checksum(bytes), size: bytes.length, source: "https://example.test/" + id });
const quiet = () => {};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easywork-agent-updater-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { schemaVersion: 1, updatedAt: "2026-01-01T00:00:00Z", agents: {} };
  for (const id of ["opencode", "codex", "claudecode"]) {
    manifest.agents[id] = { version: "1.0.0", artifacts: {
      "linux-x64": artifact(id),
      "linux-x64-musl": artifact(id),
      "linux-arm64": artifact(id),
      "linux-arm64-musl": artifact(id),
    } };
    await mkdir(path.join(root, id));
    await writeFile(path.join(root, id, "old-agent"), bytes);
  }
  const original = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(path.join(root, "manifest.json"), original);
  return { root, manifest, original, options: { catalogRoot: root, log: quiet } };
}

function githubRelease(url) {
  const codex = url.includes("/openai/codex/");
  return {
    tag_name: codex ? "rust-v2.0.0" : "v2.0.0",
    assets: (codex
      ? ["codex-x86_64-unknown-linux-musl.tar.gz", "codex-aarch64-unknown-linux-musl.tar.gz"]
      : ["opencode-linux-x64.tar.gz", "opencode-linux-x64-musl.tar.gz", "opencode-linux-arm64.tar.gz", "opencode-linux-arm64-musl.tar.gz"]
    ).map((name) => ({
      name, digest: "sha256:" + checksum(bytes), size: bytes.length, browser_download_url: "https://example.test/" + name,
    })),
  };
}

async function save({ destination }) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

test("pinned installation repairs files, deduplicates assets and leaves the manifest unchanged", async (t) => {
  const { root, original, options } = await fixture(t);
  await rm(path.join(root, "codex/old-agent"));
  let downloads = 0;
  const result = await updateCatalog([], { ...options, request: () => assert.fail("Pinned install must not query releases"), download: async (input) => { downloads += 1; await save(input); } });
  assert.equal(downloads, 3);
  assert.equal(result.files, 3);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), original);
  assert.deepEqual(await readFile(path.join(root, "codex/old-agent")), bytes);
  assert.ok(!(await readdir(root)).includes(".update.lock"));
});

test("check is offline, leaves no lock or backup and rejects corrupted bytes", async (t) => {
  const { root, options } = await fixture(t);
  const before = await readdir(root);
  const isolated = { ...options, download: () => assert.fail("Check must not download"), request: () => assert.fail("Check must not query releases") };
  await updateCatalog(["--check"], isolated);
  assert.deepEqual(await readdir(root), before);
  await writeFile(path.join(root, "claudecode/old-agent"), "broken");
  await assert.rejects(updateCatalog(["--check"], isolated), /integrity check failed/);
});

test("latest update preserves other agents and old binaries, and backs up the exact prior catalog", async (t) => {
  const { root, original, manifest, options } = await fixture(t);
  await updateCatalog(["--latest", "--agent", "opencode", "--platform", "linux-x64"], { ...options, request: githubRelease, download: save });
  const next = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.equal(next.agents.opencode.version, "2.0.0");
  assert.deepEqual(Object.keys(next.agents.opencode.artifacts), ["linux-x64"]);
  assert.deepEqual(next.agents.codex, manifest.agents.codex);
  assert.equal(await readFile(path.join(root, "manifest.json.previous"), "utf8"), original);
  assert.deepEqual(await readFile(path.join(root, "opencode/old-agent")), bytes);
  assert.deepEqual(await readFile(path.join(root, next.agents.opencode.artifacts["linux-x64"].file)), bytes);
});

test("pinned compatibility releases are downloaded, checked and preserved by latest updates", async (t) => {
  const { root, manifest, options } = await fixture(t);
  const compatibility = [{
    id: "legacy-glibc-2.17",
    version: "0.9.0",
    selector: { platforms: ["linux-x64"], libcFamily: "glibc", libcMax: "2.17" },
    artifacts: {
      "linux-x64": { ...artifact("claudecode"), file: "claudecode/legacy-agent" },
    },
  }];
  manifest.agents.claudecode.compatibility = compatibility;
  await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  let downloads = 0;
  await updateCatalog(["--agent", "claudecode", "--platform", "linux-x64"], {
    ...options,
    download: async (input) => { downloads += 1; await save(input); },
  });
  assert.equal(downloads, 2);
  assert.deepEqual(await readFile(path.join(root, "claudecode/legacy-agent")), bytes);

  await updateCatalog(["--latest", "--agent", "claudecode", "--platform", "linux-x64"], {
    ...options,
    request: async (url) => url.endsWith("/latest")
      ? "2.0.0"
      : { platforms: { "linux-x64": { checksum: checksum(bytes), size: bytes.length } } },
    download: save,
  });
  const next = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  assert.deepEqual(next.agents.claudecode.compatibility, compatibility);
});

test("a late download failure keeps the old catalog and all referenced binaries usable", async (t) => {
  const { root, original, options } = await fixture(t);
  let downloads = 0;
  await assert.rejects(updateCatalog(["--latest", "--agent", "opencode,codex", "--platform", "linux-x64"], {
    ...options, request: githubRelease, download: async (input) => { downloads += 1; if (downloads === 2) throw new Error("connection interrupted"); await save(input); },
  }), /connection interrupted/);
  assert.equal(downloads, 2);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), original);
  for (const id of ["opencode", "codex", "claudecode"]) assert.deepEqual(await readFile(path.join(root, id, "old-agent")), bytes);
  assert.ok(!(await readdir(root)).includes(".update.lock"));
});

test("invalid downloads never activate the new catalog", async (t) => {
  const { root, original, options } = await fixture(t);
  await assert.rejects(updateCatalog(["--latest", "--agent", "codex"], {
    ...options, request: githubRelease, download: async (input) => { await save(input); await writeFile(input.destination, Buffer.alloc(bytes.length)); },
  }), /integrity check failed/);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), original);
});

test("Codex libc variants share one verified archive per architecture after an update", async (t) => {
  const { root, options } = await fixture(t);
  let downloads = 0;
  await updateCatalog(["--latest", "--agent", "codex"], { ...options, request: githubRelease, download: async (input) => { downloads += 1; await save(input); } });
  const next = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const variants = Object.values(next.agents.codex.artifacts);
  assert.equal(downloads, 2);
  assert.equal(variants.length, 4);
  assert.equal(next.agents.codex.artifacts["linux-x64"].file, next.agents.codex.artifacts["linux-x64-musl"].file);
  assert.equal(next.agents.codex.artifacts["linux-arm64"].file, next.agents.codex.artifacts["linux-arm64-musl"].file);
  assert.equal(variants[0].binary, "codex-x86_64-unknown-linux-musl");
  assert.equal(next.agents.codex.artifacts["linux-arm64"].binary, "codex-aarch64-unknown-linux-musl");
});

test("Claude metadata without a declared size gets the verified binary size in the catalog", async (t) => {
  const { root, options } = await fixture(t);
  await updateCatalog(["--latest", "--agent", "claudecode"], {
    ...options,
    request: async (url) => url.endsWith("/latest") ? "2.0.0" : { platforms: Object.fromEntries([
      "linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl",
    ].map((platform) => [platform, { checksum: checksum(bytes) }])) },
    download: save,
  });
  const next = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  for (const entry of Object.values(next.agents.claudecode.artifacts)) assert.equal(entry.size, bytes.length);
});

test("missing upstream checksum and incompatible CLI options fail before downloading", async () => {
  await assert.rejects(resolveLatest("codex", ["linux-x64"], async () => ({ tag_name: "rust-v2.0.0", assets: [] })), /official SHA-256/);
  assert.deepEqual(parseOptions(["--platform", "linux-arm64"]).platforms, ["linux-arm64"]);
  assert.throws(() => parseOptions(["--platform", "linux-riscv64"]), /Unsupported/);
  assert.throws(() => parseOptions(["--latest", "--check"]), /only one/);
  assert.throws(() => parseOptions(["--agent"]), /Missing value/);
});

test("Qoder CN 官方清单映射四种 Linux 包并为缺少优化指令集的 x64 主机保留 baseline", async () => {
  const hashes = {
    amd64: "1".repeat(64),
    "amd64-musl": "2".repeat(64),
    arm64: "3".repeat(64),
    "arm64-musl": "4".repeat(64),
    "amd64-baseline": "5".repeat(64),
  };
  const release = {
    latest: "1.2.3",
    files: Object.entries(hashes).map(([arch, sha256]) => ({
      os: "linux",
      arch,
      sha256,
      url: `https://static.qoder.com.cn/qoder-cli-cn/1.2.3/qoderclicn-linux-${arch}.tar.gz`,
    })),
  };
  const resolved = await resolveLatest("qodercncli", ["linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl"], async (url) => {
    assert.equal(url, "https://static.qoder.com.cn/qoder-cli-cn/channels/manifest.json");
    return release;
  });
  assert.equal(resolved.version, "1.2.3");
  assert.deepEqual(Object.keys(resolved.artifacts), ["linux-x64", "linux-x64-musl", "linux-arm64", "linux-arm64-musl"]);
  assert.equal(resolved.artifacts["linux-x64"].binary, "qoderclicn");
  assert.equal(resolved.artifacts["linux-arm64-musl"].sha256, hashes["arm64-musl"]);
  const baseline = resolved.compatibility["linux-x64-baseline"];
  assert.equal(baseline.artifacts["linux-x64"].sha256, hashes["amd64-baseline"]);
  assert.deepEqual(baseline.selector.platforms, ["linux-x64"]);
  assert.deepEqual(baseline.selector.missingCpuFlags, ["sse4_2", "popcnt", "avx", "avx2", "bmi1", "bmi2", "fma"]);
});

test("unsafe paths and malformed manifests are never repaired by overwriting the catalog", async (t) => {
  const { root, manifest, options } = await fixture(t);
  manifest.agents.codex.artifacts["linux-x64"].file = "../outside";
  const original = JSON.stringify(manifest);
  await writeFile(path.join(root, "manifest.json"), original);
  await assert.rejects(updateCatalog(["--agent", "codex"], { ...options, download: () => assert.fail("Unsafe path must be rejected before downloading") }), /Unsafe/);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), original);
  await writeFile(path.join(root, "manifest.json"), "{invalid");
  await assert.rejects(updateCatalog(["--latest"], options), SyntaxError);
  assert.equal(await readFile(path.join(root, "manifest.json"), "utf8"), "{invalid");
});

test("an existing update lock is respected and is not removed by a competing updater", async (t) => {
  const { root, options } = await fixture(t);
  await writeFile(path.join(root, ".update.lock"), "another updater");
  await assert.rejects(updateCatalog([], options), /locked/);
  assert.equal(await readFile(path.join(root, ".update.lock"), "utf8"), "another updater");
});

test("streamed downloads preserve the previous file until a retry passes checksum validation", async (t) => {
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
