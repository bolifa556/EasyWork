import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { VersioningService } from "../gateway/core/versioning/index.mjs";

const SERVER_IDENTITY = `ssh_${crypto.createHash("sha256").update("fixture-host-key").digest("base64url")}`;
const ACTOR_ID = "user-1";

const copy = (value) => value === undefined ? undefined : structuredClone(value);

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function snapshot(content) {
  if (content === undefined) return { exists: false, sha256: null, size: 0 };
  const bytes = Buffer.from(String(content));
  return { exists: true, sha256: digest(bytes), size: bytes.length };
}

function cloneTree(tree) {
  return new Map([...tree.entries()].map(([key, value]) => [key, value]));
}

class FakeRemoteBackend {
  json = new Map();
  text = new Map();
  directories = new Set();
  trees = new Map();
  commits = new Map();
  repositoryHeads = new Map();
  calls = [];
  commitSequence = 0;

  tree(root) {
    if (!this.trees.has(root)) this.trees.set(root, new Map());
    return this.trees.get(root);
  }

  put(root, relativePath, content) {
    this.tree(root).set(relativePath.replace(/\\/g, "/"), String(content));
  }

  read(root, relativePath) {
    return this.tree(root).get(relativePath.replace(/\\/g, "/"));
  }
}

class FakeRemoteFs {
  constructor(backend) {
    this.backend = backend;
  }

  async readJson(file) {
    return copy(this.backend.json.get(file) ?? null);
  }

  async writeJsonAtomic(file, value, options = {}) {
    const current = this.backend.json.get(file);
    const currentRevision = current?.revision ?? null;
    assert.equal(currentRevision, options.expectedRevision, `revision mismatch for ${file}`);
    this.backend.json.set(file, copy(value));
    this.backend.calls.push({ type: "writeJson", file });
  }

  async mkdir(directory) {
    this.backend.directories.add(directory);
    this.backend.calls.push({ type: "mkdir", directory });
  }

  async writeTextAtomic(file, value) {
    this.backend.text.set(file, String(value));
    this.backend.calls.push({ type: "writeText", file });
  }

  async diffTree({ sourceRoot, shadowRoot, exclude }) {
    assert.deepEqual(exclude, [".git", ".easywork"]);
    const source = this.backend.tree(sourceRoot);
    const shadow = this.backend.tree(shadowRoot);
    const keys = new Set([...source.keys(), ...shadow.keys()]);
    const changes = [...keys]
      .filter((key) => !exclude.some((entry) => key === entry || key.startsWith(`${entry}/`)))
      .filter((key) => source.get(key) !== shadow.get(key))
      .map((key) => ({ path: key, before: snapshot(shadow.get(key)), after: snapshot(source.get(key)) }));
    this.backend.calls.push({ type: "diffTree", sourceRoot, shadowRoot, exclude: [...exclude] });
    return changes;
  }

  async syncTree({ sourceRoot, shadowRoot, exclude }) {
    assert.deepEqual(exclude, [".git", ".easywork"]);
    const next = new Map([...this.backend.tree(sourceRoot).entries()]
      .filter(([key]) => !exclude.some((entry) => key === entry || key.startsWith(`${entry}/`))));
    this.backend.trees.set(shadowRoot, next);
    this.backend.calls.push({ type: "syncTree", sourceRoot, shadowRoot, exclude: [...exclude] });
  }

  async fingerprint({ root, path: relativePath }) {
    this.backend.calls.push({ type: "fingerprint", root, path: relativePath });
    return snapshot(this.backend.tree(root).get(relativePath));
  }

  async restorePath({ gitDir, commitId, relativePath, destinationRoot }) {
    const commit = this.backend.commits.get(commitId);
    assert.ok(commit, `missing fake commit ${commitId}`);
    const destination = this.backend.tree(destinationRoot);
    if (commit.has(relativePath)) destination.set(relativePath, commit.get(relativePath));
    else destination.delete(relativePath);
    this.backend.calls.push({ type: "restorePath", gitDir, commitId, relativePath, destinationRoot });
  }

  async removePath({ root, path: relativePath }) {
    this.backend.tree(root).delete(relativePath);
    this.backend.calls.push({ type: "removePath", root, path: relativePath });
  }
}

class FakeRemoteExec {
  constructor(backend) {
    this.backend = backend;
  }

  async git(descriptor) {
    assert.equal("cwd" in descriptor, false, "version git must never inherit a workspace cwd");
    assert.match(descriptor.gitDir, /\.easywork\/versioning\/.*\/repository\.git$/);
    assert.match(descriptor.workTree, /\.easywork\/versioning\/.*\/worktree$/);
    assert.match(descriptor.indexFile, /\.easywork\/versioning\/.*\/index$/);
    assert.match(descriptor.configFile, /\.easywork\/versioning\/.*\/gitconfig$/);
    assert.equal(descriptor.gitDir.includes("/workspace/.git"), false);
    this.backend.calls.push({ type: "git", descriptor: copy(descriptor) });
    const command = descriptor.args[0];
    if (command === "commit") {
      const commitId = `commit-${String(++this.backend.commitSequence).padStart(4, "0")}`;
      this.backend.commits.set(commitId, cloneTree(this.backend.tree(descriptor.workTree)));
      this.backend.repositoryHeads.set(descriptor.gitDir, commitId);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "rev-parse") {
      return { code: 0, stdout: `${this.backend.repositoryHeads.get(descriptor.gitDir)}\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

function fixture() {
  const backend = new FakeRemoteBackend();
  let tick = 0;
  const service = new VersioningService({
    remoteFs: new FakeRemoteFs(backend),
    remoteExec: new FakeRemoteExec(backend),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  return { backend, service };
}

const scope = (versionDomainId) => ({ actorId: ACTOR_ID, serverIdentity: SERVER_IDENTITY, versionDomainId });

async function openWithBranches(service, rootPath = "/home/user/workspace") {
  const opened = await service.openDomain({ actorId: ACTOR_ID, serverIdentity: SERVER_IDENTITY, rootPath, mode: "real" });
  const locator = scope(opened.state.versionDomainId);
  await service.createLogicalBranch(locator, { branchId: "branch-a", conversationId: "conversation-a" });
  return { opened, locator };
}

test("isolates every EasyWork git operation and preserves workspace .git", async () => {
  const { backend, service } = fixture();
  backend.put("/home/user/workspace", "base.txt", "baseline");
  backend.put("/home/user/workspace", ".git/config", "user repository");
  backend.put("/home/user/workspace", ".easywork/local", "user local control");

  const { opened, locator } = await openWithBranches(service);
  assert.equal(opened.created, true);
  const baseline = backend.commits.get(opened.state.baselineCommitId);
  assert.equal(baseline.get("base.txt"), "baseline");
  assert.equal(baseline.has(".git/config"), false);
  assert.equal(baseline.has(".easywork/local"), false);

  backend.put("/home/user/workspace", "base.txt", "checkpoint one");
  await service.checkpoint(locator, {
    checkpointId: "checkpoint-1",
    branchId: "branch-a",
    conversationId: "conversation-a",
  });
  assert.equal(backend.read("/home/user/workspace", ".git/config"), "user repository");
  assert.ok(backend.calls.filter((entry) => entry.type === "git").every((entry) => !JSON.stringify(entry).includes("/home/user/workspace/.git")));
  assert.ok(backend.calls.filter((entry) => ["diffTree", "syncTree"].includes(entry.type)).every((entry) => entry.exclude.join(",") === ".git,.easywork"));
});

test("reuses exact domains and reports nested workspace risk explicitly", async () => {
  const { service } = fixture();
  const original = await service.openDomain({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    rootPath: "/srv/project",
    mode: "real",
  });
  const exact = await service.openDomain({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    rootPath: "/srv/project",
    mode: "real",
  });
  assert.equal(exact.reused, true);
  assert.equal(exact.state.versionDomainId, original.state.versionDomainId);

  const assessed = await service.assessWorkspace({ actorId: ACTOR_ID, serverIdentity: SERVER_IDENTITY, rootPath: "/srv/project/nested" });
  assert.equal(assessed.canCreate, false);
  assert.equal(assessed.risk.code, "WORKSPACE_DOMAIN_OVERLAP");
  assert.equal(assessed.risk.relationships[0].relationship, "contained_by");
  const rejected = await service.openDomain({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    rootPath: "/srv/project/nested",
    mode: "real",
  });
  assert.equal(rejected.state, null);
  assert.equal(rejected.risk.code, "WORKSPACE_DOMAIN_OVERLAP");
  const reused = await service.openDomain({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    rootPath: "/srv/project/nested",
    mode: "real",
  }, { overlapPolicy: "reuse-containing" });
  assert.equal(reused.state.versionDomainId, original.state.versionDomainId);
});

test("dynamic writes create or reuse the most specific virtual version domain", async () => {
  const { service } = fixture();
  const first = await service.resolveDynamicWrite({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    targetPath: "/tmp/research/report.md",
  });
  assert.equal(first.created, true);
  assert.equal(first.state.workspace.mode, "virtual");
  assert.equal(first.state.workspace.rootPath, "/tmp/research");
  assert.deepEqual(first.state.workspace.dynamicPaths, ["/tmp/research/report.md"]);

  const second = await service.resolveDynamicWrite({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    targetPath: "/tmp/research/results/table.csv",
  });
  assert.equal(second.reused, true);
  assert.equal(second.state.versionDomainId, first.state.versionDomainId);
  assert.deepEqual(second.state.workspace.dynamicPaths, ["/tmp/research/report.md", "/tmp/research/results/table.csv"]);

  const folder = await service.resolveDynamicWrite({
    actorId: ACTOR_ID,
    serverIdentity: SERVER_IDENTITY,
    targetPath: "/opt/isolated",
    targetKind: "directory",
  });
  assert.equal(folder.state.workspace.rootPath, "/opt/isolated");
  assert.notEqual(folder.state.versionDomainId, first.state.versionDomainId);

  await assert.rejects(
    service.resolveDynamicWrite({
      actorId: ACTOR_ID,
      serverIdentity: SERVER_IDENTITY,
      targetPath: "/tmp/research/.git/config",
    }),
    (error) => error?.code === "VERSION_PROTECTED_PATH",
  );
});

test("logical branches are metadata-only and checkpoints share one global timeline", async () => {
  const { backend, service } = fixture();
  const { locator } = await openWithBranches(service);
  const beforeBranch = backend.calls.filter((entry) => ["git", "diffTree", "syncTree", "restorePath", "removePath"].includes(entry.type)).length;
  await service.createLogicalBranch(locator, { branchId: "branch-b", conversationId: "conversation-b" });
  const afterBranch = backend.calls.filter((entry) => ["git", "diffTree", "syncTree", "restorePath", "removePath"].includes(entry.type)).length;
  assert.equal(afterBranch, beforeBranch, "creating a logical branch must not touch workspace or git history");

  backend.put("/home/user/workspace", "a.txt", "A1");
  await service.checkpoint(locator, { checkpointId: "a-1", branchId: "branch-a", conversationId: "conversation-a" });
  backend.put("/home/user/workspace", "b.txt", "B2");
  await service.checkpoint(locator, { checkpointId: "b-2", branchId: "branch-b", conversationId: "conversation-b" });
  backend.put("/home/user/workspace", "shared.txt", "A3");
  await service.checkpoint(locator, { checkpointId: "a-3", branchId: "branch-a", conversationId: "conversation-a" });
  backend.put("/home/user/workspace", "b.txt", "B4");
  await service.checkpoint(locator, { checkpointId: "b-4", branchId: "branch-b", conversationId: "conversation-b" });
  backend.put("/home/user/workspace", "shared.txt", "A5");
  await service.checkpoint(locator, { checkpointId: "a-5", branchId: "branch-a", conversationId: "conversation-a" });

  const state = await service.getDomain(locator);
  assert.deepEqual(state.checkpoints.map((entry) => [entry.id, entry.sequence]), [
    ["a-1", 1], ["b-2", 2], ["a-3", 3], ["b-4", 4], ["a-5", 5],
  ]);
});

test("rewind removes only later checkpoints on that branch and preserves globally retained work", async () => {
  const { backend, service } = fixture();
  const { locator } = await openWithBranches(service);
  await service.createLogicalBranch(locator, { branchId: "branch-b", conversationId: "conversation-b" });

  backend.put("/home/user/workspace", "a.txt", "A1");
  await service.checkpoint(locator, { checkpointId: "a-1", branchId: "branch-a", conversationId: "conversation-a" });
  backend.put("/home/user/workspace", "b.txt", "B2");
  await service.checkpoint(locator, { checkpointId: "b-2", branchId: "branch-b", conversationId: "conversation-b" });
  backend.put("/home/user/workspace", "shared.txt", "A3");
  await service.checkpoint(locator, { checkpointId: "a-3", branchId: "branch-a", conversationId: "conversation-a" });
  backend.put("/home/user/workspace", "b.txt", "B4");
  await service.checkpoint(locator, { checkpointId: "b-4", branchId: "branch-b", conversationId: "conversation-b" });
  backend.put("/home/user/workspace", "shared.txt", "A5");
  await service.checkpoint(locator, { checkpointId: "a-5", branchId: "branch-a", conversationId: "conversation-a" });

  const result = await service.rewind(locator, { branchId: "branch-a", targetCheckpointId: "a-3", rewindId: "rewind-a-to-3" });
  assert.equal(result.applied, true);
  assert.deepEqual(result.rewind.removedCheckpointIds, ["a-5"]);
  assert.equal(backend.read("/home/user/workspace", "shared.txt"), "A3");
  assert.equal(backend.read("/home/user/workspace", "b.txt"), "B4");
  const state = await service.getDomain(locator);
  assert.deepEqual(state.checkpoints.map((entry) => [entry.id, entry.status]), [
    ["a-1", "retained"], ["b-2", "retained"], ["a-3", "retained"], ["b-4", "retained"], ["a-5", "rewound"],
  ]);
  assert.equal(state.branches["branch-a"].headCheckpointId, "a-3");
});

test("rewind stops before every write when the live workspace fingerprint conflicts", async () => {
  const { backend, service } = fixture();
  const { locator } = await openWithBranches(service);
  backend.put("/home/user/workspace", "target.txt", "one");
  await service.checkpoint(locator, { checkpointId: "checkpoint-one", branchId: "branch-a", conversationId: "conversation-a" });
  backend.put("/home/user/workspace", "target.txt", "two");
  await service.checkpoint(locator, { checkpointId: "checkpoint-two", branchId: "branch-a", conversationId: "conversation-a" });
  backend.put("/home/user/workspace", "target.txt", "untracked external edit");
  const writesBefore = backend.calls.filter((entry) => ["restorePath", "removePath", "git", "syncTree"].includes(entry.type)).length;

  const result = await service.rewind(locator, {
    branchId: "branch-a",
    targetCheckpointId: "checkpoint-one",
    rewindId: "conflicting-rewind",
  });
  assert.equal(result.applied, false);
  assert.equal(result.conflict.code, "VERSION_REWIND_WORKSPACE_CONFLICT");
  assert.deepEqual(result.conflict.paths.map((entry) => entry.path), ["target.txt"]);
  const writesAfter = backend.calls.filter((entry) => ["restorePath", "removePath", "git", "syncTree"].includes(entry.type)).length;
  assert.equal(writesAfter, writesBefore, "a conflict must stop before applying or committing any change");
  const state = await service.getDomain(locator);
  assert.equal(state.checkpoints.find((entry) => entry.id === "checkpoint-two").status, "retained");
  assert.equal(backend.read("/home/user/workspace", "target.txt"), "untracked external edit");
});
