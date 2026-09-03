import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { VersioningService } from "../gateway/core/versioning/index.mjs";

const SERVER_IDENTITY = `ssh_${crypto.createHash("sha256").update("fixture-host-key").digest("base64url")}`;
const ACTOR_ID = "user-1";
const CONVERSATION_A = "conversation-a";
const CONVERSATION_B = "conversation-b";
const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";
const copy = (value) => value === undefined ? undefined : structuredClone(value);
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fileSnapshot(content, mode = 0o600) {
  if (content === undefined) return { exists: false, type: null, sha256: null, size: 0, mode: null, objectId: null };
  const bytes = Buffer.from(String(content));
  const sha256 = digest(bytes);
  return { exists: true, type: "file", sha256, size: bytes.length, mode, objectId: sha256 };
}

class FakeRemoteFs {
  json = new Map();
  files = new Map();
  modes = new Map();
  objects = new Map();
  hookOperations = new Map();
  calls = [];

  put(file, content, mode = 0o600) { this.files.set(file, String(content)); this.modes.set(file, mode); }
  remove(file) { this.files.delete(file); this.modes.delete(file); }
  read(file) { return this.files.get(file); }

  async readJson(file) { this.calls.push({ type: "readJson", file }); return copy(this.json.get(file) ?? null); }
  async writeJsonAtomic(file, value, options = {}) {
    assert.equal(this.json.get(file)?.revision ?? null, options.expectedRevision, `revision mismatch for ${file}`);
    this.json.set(file, copy(value));
    this.calls.push({ type: "writeJson", file });
  }
  async mkdir(directory) { this.calls.push({ type: "mkdir", directory }); }
  async capturePaths({ paths, objectsRoot }) {
    return paths.map((path) => {
      const content = this.files.get(path);
      const snapshot = fileSnapshot(content, this.modes.get(path) ?? 0o600);
      if (snapshot.exists) this.objects.set(`${objectsRoot}/${snapshot.objectId}`, content);
      this.calls.push({ type: "capture", path });
      return { path, snapshot };
    });
  }
  queueHook(operationId, createdAtNs, entries) {
    this.hookOperations.set(operationId, { operationId, createdAtNs, entries: copy(entries) });
  }
  async listAgentHookOperations() {
    return [...this.hookOperations.values()]
      .map(({ operationId, createdAtNs }) => ({ operationId, createdAtNs }))
      .sort((left, right) => left.createdAtNs.localeCompare(right.createdAtNs));
  }
  async captureAgentHookOperations({ objectsRoot }) {
    const operations = await this.listAgentHookOperations();
    const entries = [];
    for (const operation of operations) {
      const queued = this.hookOperations.get(operation.operationId);
      for (const entry of queued.entries) {
        const snapshot = fileSnapshot(entry.content, entry.mode ?? 0o600);
        if (snapshot.exists) this.objects.set(`${objectsRoot}/${snapshot.objectId}`, String(entry.content));
        entries.push({ operationId: operation.operationId, path: entry.path, snapshot });
      }
      this.calls.push({ type: "agentHook", operationId: operation.operationId });
    }
    return { operations, entries };
  }
  async removeAgentHookOperations({ operationIds }) {
    operationIds.forEach((operationId) => this.hookOperations.delete(operationId));
  }
  async fingerprintPath({ path }) { this.calls.push({ type: "fingerprint", path }); return fileSnapshot(this.files.get(path), this.modes.get(path) ?? 0o600); }
  async restoreSnapshot({ path, snapshot, objectsRoot }) {
    this.calls.push({ type: "restore", path, snapshot: copy(snapshot) });
    if (!snapshot.exists) { this.remove(path); return; }
    const content = this.objects.get(`${objectsRoot}/${snapshot.objectId}`);
    assert.notEqual(content, undefined, `missing object ${snapshot.objectId}`);
    this.put(path, content, snapshot.mode);
  }
}

function fixture() {
  const remoteFs = new FakeRemoteFs();
  let tick = 0;
  const service = new VersioningService({ remoteFs, clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  return { remoteFs, service };
}

const locator = (versionDomainId) => ({ actorId: ACTOR_ID, serverIdentity: SERVER_IDENTITY, versionDomainId });
const domainInput = ({ conversationId = CONVERSATION_A, workspaceId = WORKSPACE_A, rootPath = "/home/user/workspace", mode = "real" } = {}) => ({ actorId: ACTOR_ID, serverIdentity: SERVER_IDENTITY, conversationId, workspaceId, rootPath, mode });

async function openWithBranch(service, options = {}) {
  const input = domainInput(options);
  const opened = await service.ensureConversationDomain(input);
  const scope = locator(opened.state.versionDomainId);
  const branchId = options.branchId || "branch-a";
  const state = await service.getDomain(scope);
  if (!state.branches[branchId]) await service.createLogicalBranch(scope, { branchId, conversationId: input.conversationId });
  return { opened, locator: scope, input, branchId };
}

async function runTask(service, scope, { taskId, branchId, conversationId, paths = [], mutate = () => {} }) {
  const beforeCheckpointId = `checkpoint_${taskId}_before`;
  const afterCheckpointId = `checkpoint_${taskId}_after`;
  await service.beginTask(scope, {
    taskId,
    branchId,
    conversationId,
    agentId: "opencode",
    agentBindingId: `binding-${taskId}`,
    workspaceId: WORKSPACE_A,
    beforeCheckpointId,
  });
  if (paths.length) {
    const operationId = `op_${digest(taskId).slice(0, 24)}`;
    const entries = paths.map((entry) => ({
      path: entry.path,
      content: service.remoteFs.read(entry.path),
      mode: service.remoteFs.modes.get(entry.path) ?? 0o600,
    }));
    service.remoteFs.queueHook(operationId, "1000000000000000", entries);
  }
  await mutate();
  const checkpoint = await service.finishTask(scope, { taskId, afterCheckpointId });
  return { beforeCheckpointId, afterCheckpointId, checkpoint };
}

test("one conversation uses one empty ledger across workspaces without scanning", async () => {
  const { remoteFs, service } = fixture();
  remoteFs.put("/srv/a/preexisting.txt", "untouched-a");
  remoteFs.put("/srv/b/preexisting.txt", "untouched-b");
  const first = await service.ensureConversationDomain(domainInput({ rootPath: "/srv/a", workspaceId: WORKSPACE_A }));
  const second = await service.ensureConversationDomain(domainInput({ rootPath: "/srv/b", workspaceId: WORKSPACE_B }));
  const other = await service.ensureConversationDomain(domainInput({ conversationId: CONVERSATION_B, rootPath: "/srv/a", workspaceId: WORKSPACE_A }));
  assert.equal(second.state.versionDomainId, first.state.versionDomainId);
  assert.notEqual(other.state.versionDomainId, first.state.versionDomainId);
  const state = await service.getDomain(locator(first.state.versionDomainId));
  assert.deepEqual(state.workspaces.map((entry) => entry.id).sort(), [WORKSPACE_A, WORKSPACE_B]);
  assert.deepEqual(state.checkpoints, []);
  assert.equal(remoteFs.calls.some((entry) => ["capture", "fingerprint", "restore"].includes(entry.type)), false);
});

test("records only Agent-touched files, including paths outside the workspace", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  remoteFs.put("/home/user/workspace/untouched.txt", "keep");
  remoteFs.put("/opt/shared/outside.txt", "before");
  const result = await runTask(service, source.locator, {
    taskId: "task-one", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/opt/shared/outside.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/opt/shared/outside.txt", "after"),
  });
  assert.equal(result.checkpoint.changes.length, 1);
  assert.equal(result.checkpoint.changes[0].path, "/opt/shared/outside.txt");
  assert.equal(remoteFs.calls.some((entry) => entry.path === "/home/user/workspace/untouched.txt"), false);
});

test("rewind spans workspaces and leaves unrelated files untouched", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  remoteFs.put("/home/user/workspace/unrelated.txt", "outside-ledger");
  const first = await runTask(service, source.locator, {
    taskId: "task-one", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/result.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/result.txt", "one"),
  });
  await runTask(service, source.locator, {
    taskId: "task-two", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/result.txt", workspaceId: WORKSPACE_A }, { path: "/srv/second/new.txt", workspaceId: WORKSPACE_B }],
    mutate: () => { remoteFs.put("/home/user/workspace/result.txt", "two"); remoteFs.put("/srv/second/new.txt", "created"); },
  });
  const rewound = await service.rewind(source.locator, { branchId: source.branchId, targetCheckpointId: first.afterCheckpointId, rewindId: "rewind-one" });
  assert.equal(rewound.applied, true);
  assert.equal(remoteFs.read("/home/user/workspace/result.txt"), "one");
  assert.equal(remoteFs.read("/srv/second/new.txt"), undefined);
  assert.equal(remoteFs.read("/home/user/workspace/unrelated.txt"), "outside-ledger");
});

test("rewind rejects a path changed outside the ledger without partial restore", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const first = await runTask(service, source.locator, {
    taskId: "task-one", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/a.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/a.txt", "one"),
  });
  await runTask(service, source.locator, {
    taskId: "task-two", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/a.txt", workspaceId: WORKSPACE_A }, { path: "/home/user/workspace/b.txt", workspaceId: WORKSPACE_A }],
    mutate: () => { remoteFs.put("/home/user/workspace/a.txt", "two"); remoteFs.put("/home/user/workspace/b.txt", "two"); },
  });
  remoteFs.put("/home/user/workspace/b.txt", "manual-edit");
  const conflict = await service.rewind(source.locator, { branchId: source.branchId, targetCheckpointId: first.afterCheckpointId, rewindId: "rewind-conflict" });
  assert.equal(conflict.applied, false);
  assert.equal(conflict.conflict.code, "VERSION_REWIND_PATH_CONFLICT");
  assert.equal(remoteFs.read("/home/user/workspace/a.txt"), "two");
  assert.equal(remoteFs.read("/home/user/workspace/b.txt"), "manual-edit");
});

test("branched conversation copies the shared boundary then diverges", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const boundary = await runTask(service, source.locator, {
    taskId: "task-parent", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/shared.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/shared.txt", "parent"),
  });
  const forked = await service.forkDomain(source.locator, { sourceCheckpointId: boundary.afterCheckpointId, targetConversationId: CONVERSATION_B, targetWorkspaceId: WORKSPACE_A, targetBranchId: "branch-child" });
  const childLocator = locator(forked.state.versionDomainId);
  await runTask(service, childLocator, {
    taskId: "task-child", branchId: "branch-child", conversationId: CONVERSATION_B,
    paths: [{ path: "/home/user/workspace/shared.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/shared.txt", "child"),
  });
  const parentState = await service.getDomain(source.locator);
  const childState = await service.getDomain(childLocator);
  assert.equal(parentState.branches[source.branchId].headCheckpointId, boundary.afterCheckpointId);
  assert.equal(childState.branches["branch-child"].headCheckpointId, "checkpoint_task-child_after");
  assert.deepEqual(childState.checkpoints.slice(0, parentState.checkpoints.length), parentState.checkpoints);
  assert.equal(childState.storage.objectsRoot, parentState.storage.objectsRoot);
});

test("a normal Task observes shared changes from another web conversation without restoring its own HEAD", async () => {
  const { remoteFs, service } = fixture();
  const target = "/home/user/workspace/shared.txt";
  const source = await openWithBranch(service);
  const boundary = await runTask(service, source.locator, {
    taskId: "task-shared-boundary", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: target, workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put(target, "parent-boundary"),
  });
  const forked = await service.forkDomain(source.locator, {
    sourceCheckpointId: boundary.afterCheckpointId,
    targetConversationId: CONVERSATION_B,
    targetWorkspaceId: WORKSPACE_A,
    targetBranchId: "branch-shared-child",
  });
  await runTask(service, locator(forked.state.versionDomainId), {
    taskId: "task-shared-child", branchId: "branch-shared-child", conversationId: CONVERSATION_B,
    paths: [{ path: target, workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put(target, "child-visible-to-everyone"),
  });

  const parent = await runTask(service, source.locator, {
    taskId: "task-parent-after-child", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: target, workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put(target, "parent-after-shared-state"),
  });
  assert.equal(parent.checkpoint.changes[0].before.sha256, fileSnapshot("child-visible-to-everyone").sha256);

  const rewound = await service.rewind(source.locator, {
    branchId: source.branchId,
    targetCheckpointId: parent.beforeCheckpointId,
    rewindId: "rewind-parent-to-shared-preimage",
  });
  assert.equal(rewound.applied, true);
  assert.equal(remoteFs.read(target), "child-visible-to-everyone");
});

test("activating parent and child conversations materializes each conversation HEAD", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const boundary = await runTask(service, source.locator, {
    taskId: "task-boundary", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/shared.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/shared.txt", "boundary"),
  });
  const parent = await runTask(service, source.locator, {
    taskId: "task-parent-later", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/shared.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/shared.txt", "parent-later"),
  });
  await service.switchToCheckpoint(source.locator, {
    targetCheckpointId: boundary.afterCheckpointId,
    switchId: "switch-child-boundary",
    preserveDomainHead: true,
  });
  const forked = await service.forkDomain(source.locator, {
    sourceCheckpointId: boundary.afterCheckpointId,
    targetConversationId: CONVERSATION_B,
    targetWorkspaceId: WORKSPACE_A,
    targetBranchId: "branch-child",
  });
  const childLocator = locator(forked.state.versionDomainId);
  const child = await runTask(service, childLocator, {
    taskId: "task-child-later", branchId: "branch-child", conversationId: CONVERSATION_B,
    paths: [{ path: "/home/user/workspace/shared.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/shared.txt", "child-later"),
  });
  assert.equal(remoteFs.read("/home/user/workspace/shared.txt"), "child-later");
  const parentActivation = await service.activateCheckpoint(source.locator, {
    checkpointId: parent.afterCheckpointId,
    activationId: "activate-parent",
  });
  assert.equal(parentActivation.applied, true);
  assert.equal(remoteFs.read("/home/user/workspace/shared.txt"), "parent-later");
  const childActivation = await service.activateCheckpoint(childLocator, {
    checkpointId: child.afterCheckpointId,
    activationId: "activate-child",
  });
  assert.equal(childActivation.applied, true);
  assert.equal(remoteFs.read("/home/user/workspace/shared.txt"), "child-later");
});

test("a child file edit is folded into an already tracked ancestor directory", async () => {
  const { remoteFs, service } = fixture();
  const directory = "/home/user/workspace/docs";
  const file = `${directory}/handoff-note.md`;
  remoteFs.put(directory, "parent-directory");
  remoteFs.put(file, "parent-file");
  const source = await openWithBranch(service);
  const boundary = await runTask(service, source.locator, {
    taskId: "task-directory-boundary", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: directory, workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put(directory, "parent-directory-recorded"),
  });
  const forked = await service.forkDomain(source.locator, {
    sourceCheckpointId: boundary.afterCheckpointId,
    targetConversationId: CONVERSATION_B,
    targetWorkspaceId: WORKSPACE_A,
    targetBranchId: "branch-child-directory",
  });
  const childLocator = locator(forked.state.versionDomainId);
  const child = await runTask(service, childLocator, {
    taskId: "task-child-file", branchId: "branch-child-directory", conversationId: CONVERSATION_B,
    paths: [{ path: file, workspaceId: WORKSPACE_A }],
    mutate: () => {
      remoteFs.put(directory, "child-directory-recorded");
      remoteFs.put(file, "child-file");
    },
  });
  assert.deepEqual(child.checkpoint.changes.map((change) => change.path), [directory]);
  const parentActivation = await service.activateCheckpoint(source.locator, {
    checkpointId: boundary.afterCheckpointId,
    activationId: "activate-parent-directory",
  });
  assert.equal(parentActivation.applied, true);
  assert.equal(remoteFs.read(directory), "parent-directory-recorded");
  const childActivation = await service.activateCheckpoint(childLocator, {
    checkpointId: child.afterCheckpointId,
    activationId: "activate-child-directory",
  });
  assert.equal(childActivation.applied, true);
  assert.equal(remoteFs.read(directory), "child-directory-recorded");
});

test("a parent conversation records the shared current ancestor after its child conversation changes that directory", async () => {
  const { remoteFs, service } = fixture();
  const directory = "/home/user/workspace/docs";
  const file = `${directory}/handoff-note.md`;
  remoteFs.put(directory, "boundary-directory");
  remoteFs.put(file, "boundary-file");
  const source = await openWithBranch(service);
  const boundary = await runTask(service, source.locator, {
    taskId: "task-shared-directory-boundary", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: directory, workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put(directory, "parent-directory-recorded"),
  });
  const forked = await service.forkDomain(source.locator, {
    sourceCheckpointId: boundary.afterCheckpointId,
    targetConversationId: CONVERSATION_B,
    targetWorkspaceId: WORKSPACE_A,
    targetBranchId: "branch-shared-directory-child",
  });
  await runTask(service, locator(forked.state.versionDomainId), {
    taskId: "task-shared-directory-child", branchId: "branch-shared-directory-child", conversationId: CONVERSATION_B,
    paths: [{ path: file, workspaceId: WORKSPACE_A }],
    mutate: () => {
      remoteFs.put(directory, "child-directory-visible");
      remoteFs.put(file, "child-file-visible");
    },
  });

  const parent = await runTask(service, source.locator, {
    taskId: "task-parent-after-shared-directory", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: file, workspaceId: WORKSPACE_A }],
    mutate: () => {
      remoteFs.put(directory, "parent-after-shared-directory");
      remoteFs.put(file, "parent-after-shared-file");
    },
  });
  assert.equal(parent.checkpoint.changes[0].path, directory);
  assert.equal(parent.checkpoint.changes[0].before.sha256, fileSnapshot("child-directory-visible").sha256);

  const rewound = await service.rewind(source.locator, {
    branchId: source.branchId,
    targetCheckpointId: parent.beforeCheckpointId,
    rewindId: "rewind-parent-shared-directory",
  });
  assert.equal(rewound.applied, true);
  assert.equal(remoteFs.read(directory), "child-directory-visible");
});

test("switching to an already materialized checkpoint is metadata-only", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const current = await runTask(service, source.locator, {
    taskId: "task-current", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [
      { path: "/home/user/workspace/project", workspaceId: WORKSPACE_A },
      { path: "/home/user/workspace/project/result.txt", workspaceId: WORKSPACE_A },
    ],
    mutate: () => {
      remoteFs.put("/home/user/workspace/project", "directory-snapshot");
      remoteFs.put("/home/user/workspace/project/result.txt", "current");
    },
  });
  const fingerprintsBefore = remoteFs.calls.filter((entry) => entry.type === "fingerprint").length;
  const switched = await service.switchToCheckpoint(source.locator, {
    targetCheckpointId: current.afterCheckpointId,
    switchId: "switch-current",
    preserveDomainHead: true,
  });
  const fingerprintsAfter = remoteFs.calls.filter((entry) => entry.type === "fingerprint").length;
  assert.equal(switched.applied, true);
  assert.equal(fingerprintsAfter, fingerprintsBefore);
  assert.equal(remoteFs.calls.filter((entry) => entry.type === "restore").length, 0);
});

test("activating a freshly seeded fork at the shared checkpoint is metadata-only", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const boundary = await runTask(service, source.locator, {
    taskId: "task-fork-boundary", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [
      { path: "/home/user/workspace/project", workspaceId: WORKSPACE_A },
      { path: "/home/user/workspace/project/result.txt", workspaceId: WORKSPACE_A },
    ],
    mutate: () => {
      remoteFs.put("/home/user/workspace/project", "directory-snapshot");
      remoteFs.put("/home/user/workspace/project/result.txt", "boundary");
    },
  });
  const forked = await service.forkDomain(source.locator, {
    sourceCheckpointId: boundary.afterCheckpointId,
    targetConversationId: CONVERSATION_B,
    targetWorkspaceId: WORKSPACE_A,
    targetBranchId: "branch-child",
  });
  const childLocator = locator(forked.state.versionDomainId);
  const fingerprintsBefore = remoteFs.calls.filter((entry) => entry.type === "fingerprint").length;
  const activation = await service.activateCheckpoint(childLocator, {
    checkpointId: boundary.afterCheckpointId,
    activationId: "activate-fresh-child",
  });
  const fingerprintsAfter = remoteFs.calls.filter((entry) => entry.type === "fingerprint").length;
  assert.equal(activation.applied, true);
  assert.equal(activation.reusedMaterialization, true);
  assert.equal(fingerprintsAfter, fingerprintsBefore);
  assert.equal(remoteFs.calls.filter((entry) => entry.type === "restore").length, 0);
});

test("edit and resend rewinds to the before-boundary then creates replacement history", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const original = await runTask(service, source.locator, {
    taskId: "task-original", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/generated.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/generated.txt", "original"),
  });
  const rewound = await service.rewind(source.locator, { branchId: source.branchId, targetCheckpointId: original.beforeCheckpointId, rewindId: "rewind-edit" });
  assert.equal(rewound.applied, true);
  assert.equal(remoteFs.read("/home/user/workspace/generated.txt"), undefined);
  await runTask(service, source.locator, {
    taskId: "task-replacement", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: "/home/user/workspace/generated.txt", workspaceId: WORKSPACE_A }],
    mutate: () => remoteFs.put("/home/user/workspace/generated.txt", "replacement"),
  });
  assert.equal(remoteFs.read("/home/user/workspace/generated.txt"), "replacement");
});

test("stale pending task is finalized before the next task in one ledger transaction", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  await service.beginTask(source.locator, {
    taskId: "task-stale", branchId: source.branchId, conversationId: CONVERSATION_A,
    agentId: "opencode", agentBindingId: "binding-stale", workspaceId: WORKSPACE_A,
  });
  remoteFs.queueHook("op_444444444444444444444444", "1000000000000000", [{ path: "/home/user/workspace/recovered.txt", content: undefined }]);
  remoteFs.put("/home/user/workspace/recovered.txt", "recovered");
  await service.beginTask(source.locator, {
    taskId: "task-next", branchId: source.branchId, conversationId: CONVERSATION_A,
    agentId: "opencode", agentBindingId: "binding-next", workspaceId: WORKSPACE_A,
  });
  const state = await service.getDomain(source.locator);
  assert.equal(state.pending["task-stale"], undefined);
  assert.ok(state.pending["task-next"]);
  assert.equal(state.checkpoints.find((entry) => entry.id === "checkpoint_task-stale_after")?.changes.length, 1);
  assert.equal(state.branches[source.branchId].headCheckpointId, "checkpoint_task-next_before");
  assert.equal(remoteFs.hookOperations.size, 0);
});

test("a native pre-tool snapshot preserves the state before a newly created file", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const target = "/home/user/workspace/race.txt";
  await service.beginTask(source.locator, {
    taskId: "task-race", branchId: source.branchId, conversationId: CONVERSATION_A,
    agentId: "codex", agentBindingId: "binding-race", workspaceId: WORKSPACE_A,
  });
  remoteFs.queueHook("op_111111111111111111111111", "1000000000000000", [{ path: target, content: undefined }]);
  remoteFs.put(target, "created-after-native-call");
  const after = await service.finishTask(source.locator, { taskId: "task-race", afterCheckpointId: "checkpoint_task-race_after" });
  assert.equal(after.changes.length, 1);
  assert.equal(after.changes[0].before.exists, false);
  assert.equal(after.changes[0].after.sha256, fileSnapshot("created-after-native-call").sha256);
});

test("task finalization drains unconsumed hooks chronologically and keeps the first preimage", async () => {
  const { remoteFs, service } = fixture();
  const source = await openWithBranch(service);
  const target = "/home/user/workspace/tracked.txt";
  await runTask(service, source.locator, {
    taskId: "task-create", branchId: source.branchId, conversationId: CONVERSATION_A,
    paths: [{ path: target, workspaceId: WORKSPACE_A, before: fileSnapshot(undefined) }],
    mutate: () => remoteFs.put(target, "one"),
  });
  await service.beginTask(source.locator, {
    taskId: "task-late-edit", branchId: source.branchId, conversationId: CONVERSATION_A,
    agentId: "claude-code", agentBindingId: "binding-late-edit", workspaceId: WORKSPACE_A,
  });
  remoteFs.queueHook("op_222222222222222222222222", "1000000000000000", [{ path: target, content: "one" }]);
  remoteFs.queueHook("op_333333333333333333333333", "1000000000000001", [{ path: target, content: "two" }]);
  remoteFs.put(target, "three");
  const after = await service.finishTask(source.locator, { taskId: "task-late-edit", afterCheckpointId: "checkpoint_task-late-edit_after" });
  assert.equal(after.changes.length, 1);
  assert.equal(after.changes[0].before.sha256, fileSnapshot("one").sha256);
  assert.equal(after.changes[0].after.sha256, fileSnapshot("three").sha256);
  assert.equal(remoteFs.hookOperations.size, 0);
});
