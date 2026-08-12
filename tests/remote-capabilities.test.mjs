import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import { ManagedAgentConfiguration } from "../gateway/core/agent-runtime/configuration.mjs";
import { actorDataRoot } from "../gateway/core/paths.mjs";
import { SshShadowVersionBackend } from "../gateway/core/runtime/shadow-version-backend.mjs";
import { SshSkillDeployment } from "../gateway/core/runtime/skill-deployment.mjs";
import { SshTerminalManager, terminalLimits } from "../gateway/core/runtime/terminal.mjs";
import { createDefaultRemoteBackend } from "../gateway/core/runtime/remote.mjs";
import { composeResourceList } from "../gateway/core/runtime/runtime.mjs";
import { Ssh2TransportFactory } from "../gateway/core/ssh/ssh2-transport.mjs";

function actor() {
  return createActorContext({ actorType: "user", actorId: "alice", deviceId: "device_alice", sessionId: "session_alice", roles: [] });
}

function missing() {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function memoryRemote() {
  const files = new Map();
  const directories = new Set(["/", "/home", "/home/alice", "/work", "/work/project"]);
  const attrs = (candidate) => ({
    size: files.get(candidate)?.length || 0,
    isDirectory: () => directories.has(candidate),
    isSymbolicLink: () => false,
  });
  const childEntries = (directory) => {
    const prefix = directory === "/" ? "/" : `${directory}/`;
    const names = new Set();
    for (const candidate of [...directories, ...files.keys()]) {
      if (!candidate.startsWith(prefix) || candidate === directory) continue;
      const tail = candidate.slice(prefix.length);
      if (tail && !tail.includes("/")) names.add(tail);
    }
    return [...names].map((filename) => {
      const candidate = path.posix.join(directory, filename);
      return { filename, attrs: attrs(candidate) };
    });
  };
  const ensureParents = (candidate) => {
    let current = path.posix.dirname(candidate);
    const pending = [];
    while (current !== "/" && !directories.has(current)) { pending.push(current); current = path.posix.dirname(current); }
    for (const item of pending.reverse()) directories.add(item);
  };
  const sftp = {
    lstat(candidate, callback) { callback(directories.has(candidate) || files.has(candidate) ? null : missing(), attrs(candidate)); },
    stat(candidate, callback) { this.lstat(candidate, callback); },
    readdir(directory, callback) { callback(directories.has(directory) ? null : missing(), childEntries(directory)); },
    readFile(candidate, callback) { callback(files.has(candidate) ? null : missing(), files.get(candidate)); },
    writeFile(candidate, content, _options, callback) { ensureParents(candidate); files.set(candidate, Buffer.from(content)); callback(null); },
    rename(from, to, callback) { if (!files.has(from)) return callback(missing()); ensureParents(to); files.set(to, files.get(from)); files.delete(from); callback(null); },
    unlink(candidate, callback) { if (!files.has(candidate)) return callback(missing()); files.delete(candidate); callback(null); },
    mkdir(candidate, _options, callback) { ensureParents(candidate); directories.add(candidate); callback(null); },
    rmdir(candidate, callback) {
      if (!directories.has(candidate)) return callback(missing());
      if (childEntries(candidate).length) return callback(Object.assign(new Error("not empty"), { code: "ENOTEMPTY" }));
      directories.delete(candidate); callback(null);
    },
    end() {},
  };
  const commands = [];
  const uploads = [];
  const executor = {
    async home() { return "/home/alice"; },
    async withSftp(operation) { return operation(sftp); },
    async readFile(candidate) { if (!files.has(candidate)) throw missing(); return Buffer.from(files.get(candidate)); },
    async writeAtomic(candidate, content) { ensureParents(candidate); files.set(candidate, Buffer.from(content)); },
    async upload(localPath, remotePath) { uploads.push({ localPath, remotePath }); ensureParents(remotePath); files.set(remotePath, await fs.readFile(localPath)); },
    async exec(command) {
      commands.push(command);
      if (command.includes("printf '%s' \"$HOME\"")) return { code: 0, stdout: "/home/alice", stderr: "" };
      if (command.startsWith("readlink -f --")) {
        const candidate = command.slice("readlink -f --".length).trim().replace(/^'|'$/g, "");
        return { code: directories.has(candidate) || files.has(candidate) ? 0 : 1, stdout: directories.has(candidate) || files.has(candidate) ? `${candidate}\n` : "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { executor, files, directories, commands, uploads, sftp };
}

test("resource refresh joins bindings through resourceVersionId and returns canonical blob size", () => {
  const binding = { id: "binding_a", resourceVersionId: "version_a", ownerType: "project", ownerId: "project_a", path: "notes/readme.md" };
  const version = { id: "version_a", blobId: "blob_a", filename: "readme.md", parseStatus: "ready", embeddingStatus: "ready" };
  const blob = { id: "blob_a", sha256: "a".repeat(64), size: 4096, mime: "text/markdown", storagePath: "resources/blobs/aa/blob_a" };
  const items = composeResourceList({ data: { bindings: [binding], versions: [version], blobs: [blob] } }, { ownerType: "project", ownerId: "project_a" });
  assert.deepEqual(items, [{ binding, version, blob, size: 4096 }]);
  binding.resourceVersionId = "missing";
  assert.throws(() => composeResourceList({ data: { bindings: [binding], versions: [version], blobs: [blob] } }), (error) => error?.code === "RESOURCE_VERSION_MISSING");
});

test("default backend advertises real terminal, shadow versioning, and isolated Skill deployment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-default-remote-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = memoryRemote();
  const session = {
    async exec(command, options) { return remote.executor.exec(command, options); },
    async sftp() { return remote.sftp; },
  };
  const currentActor = actor();
  const container = {
    actor: currentActor,
    runtime: { dataRoot: path.join(root, "data") },
    broker: { async append(_topic, event) { return event; } },
    clock: () => new Date(),
  };
  const backend = await createDefaultRemoteBackend({
    serverId: "server_default",
    serverIdentity: `ssh_${"d".repeat(43)}`,
    sshWorker: { async withSession(_serverId, operation) { return operation(session); } },
    container,
    catalog: { async resolve() { throw new Error("not used"); } },
  });
  assert.equal(backend.capabilities.terminal.pty, true);
  assert.equal(backend.capabilities.versioning.userGitIsolated, true);
  assert.equal(backend.capabilities.skills.storage, "~/.easywork/skills");
  assert.equal(typeof backend.remoteFs.diffTree, "function");
  assert.equal(typeof backend.remoteExec.git, "function");
  assert.equal(typeof backend.terminal.resume, "function");
  assert.equal(typeof backend.skillDeployment.inspect, "function");
  assert.equal(typeof backend.agentConfiguration.inspect, "function");
  await backend.close();
});

test("managed Agent configuration is structured and isolated while user deployments stay read-only", async () => {
  const remote = memoryRemote();
  const deploymentService = {
    async status(agentId, { source = null } = {}) {
      if (source === "user") return { agentId, displayName: agentId, installed: true, managed: false, source: "user" };
      return { agentId, displayName: agentId, installed: true, managed: true, source: "managed" };
    },
  };
  const configuration = new ManagedAgentConfiguration({ executor: remote.executor, deploymentService, clock: () => new Date("2026-08-10T01:02:03.000Z") });
  const initial = await configuration.inspect("codex", { source: "managed" });
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.fields.map((field) => field.key), ["model", "reasoningEffort", "approvalPolicy", "sandboxMode"]);
  assert.equal(initial.path, "/home/alice/.easywork/agents/codex/runtime/config.json");
  const updated = await configuration.update("codex", {
    source: "managed",
    expectedRevision: 0,
    values: { model: "gpt-codex", reasoningEffort: "high", approvalPolicy: "on-request", sandboxMode: "workspace-write" },
  });
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.values, { model: "gpt-codex", reasoningEffort: "high", approvalPolicy: "on-request", sandboxMode: "workspace-write" });
  assert.equal(JSON.parse(remote.files.get(updated.path).toString()).updatedAt, "2026-08-10T01:02:03.000Z");
  assert.equal([...remote.files.keys()].some((candidate) => candidate.startsWith("/home/alice/.codex") || candidate.startsWith("/home/alice/.claude") || candidate.startsWith("/home/alice/.config/opencode")), false);
  await assert.rejects(() => configuration.update("codex", { source: "managed", expectedRevision: 1, values: { reasoningEffort: "ultracode" } }), (error) => error?.code === "AGENT_CONFIG_VALUE_INVALID");
  const concurrent = await Promise.allSettled([
    configuration.update("codex", { source: "managed", expectedRevision: 1, values: { reasoningEffort: "low" } }),
    configuration.update("codex", { source: "managed", expectedRevision: 1, values: { reasoningEffort: "medium" } }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(concurrent.find((result) => result.status === "rejected").reason.code, "REVISION_CONFLICT");
  const user = await configuration.inspect("claude-code", { source: "user" });
  assert.deepEqual({ writable: user.writable, fields: user.fields, values: user.values }, { writable: false, fields: [], values: {} });
  await assert.rejects(() => configuration.update("claude-code", { source: "user", expectedRevision: 0, values: { model: "claude" } }), (error) => error?.code === "AGENT_CONFIG_READ_ONLY");
});

test("ssh2 PTY opens the login shell API and never accepts a command string", async () => {
  const observations = [];
  class Channel extends EventEmitter {
    constructor() { super(); this.stderr = new EventEmitter(); }
    write(bytes) { observations.push({ write: Buffer.from(bytes).toString() }); }
    setWindow(rows, cols, height, width) { observations.push({ window: { rows, cols, height, width } }); }
    end() {}
    close() { this.emit("close", 0, null); }
  }
  class Client extends EventEmitter {
    connect(config) {
      config.hostVerifier(Buffer.from("host-key"));
      queueMicrotask(() => this.emit("ready"));
    }
    shell(window, callback) {
      observations.push({ shell: window });
      this.channel = new Channel();
      callback(null, this.channel);
    }
    end() { this.emit("close"); }
  }
  const factory = new Ssh2TransportFactory({ ClientClass: Client });
  const session = await factory.connect({
    profile: { host: "server.example", port: 22, username: "alice", fingerprint: null },
    credential: { method: "password", password: "secret" },
  });
  await assert.rejects(() => session.openPty({ command: "uname -a" }), (error) => error?.code === "SSH_PTY_OPTIONS_INVALID");
  const handle = await session.openPty({ term: "xterm-256color", rows: 28, cols: 100 });
  assert.deepEqual(observations[0], { shell: { term: "xterm-256color", rows: 28, cols: 100, width: 0, height: 0 } });
  handle.write("hello\n");
  handle.resize({ rows: 40, cols: 160 });
  assert.deepEqual(observations.slice(1), [{ write: "hello\n" }, { window: { rows: 40, cols: 160, height: 0, width: 0 } }]);
  await handle.close();
  await session.close();
});

test("controlled PTY stays on the actor worker, streams bounded events, and supports detach/resume", async () => {
  const events = [];
  const writes = [];
  let dataListener;
  let closeListener;
  const handle = {
    closed: false,
    onData(listener) { dataListener = listener; },
    onClose(listener) { closeListener = listener; },
    write(bytes) { writes.push(Buffer.from(bytes)); return bytes.length; },
    resize({ rows, cols }) { return { rows, cols }; },
    async close() { this.closed = true; closeListener?.(null, { code: 0, signal: null }); },
  };
  const opened = [];
  const touched = [];
  const worker = {
    async withSession(serverId, operation) {
      opened.push(serverId);
      return operation({ async openPty(options) { opened.push(options); return handle; } });
    },
    async touch(serverId) { touched.push(serverId); },
  };
  const manager = new SshTerminalManager({
    worker,
    serverId: "server_a",
    serverIdentity: `ssh_${"a".repeat(43)}`,
    broker: { async append(topic, event) { events.push({ topic, event }); return event; } },
  });
  await assert.rejects(() => manager.create({ command: "rm -rf /" }), (error) => error?.code === "TERMINAL_INPUT_SCHEMA_INVALID");
  const created = await manager.create({ term: "xterm-256color", rows: 30, cols: 120, commandId: "cmd_create" });
  assert.equal(opened[0], "server_a");
  assert.deepEqual(opened[1], { term: "xterm-256color", rows: 30, cols: 120 });
  assert.equal(created.status, "open");
  assert.equal(created.attached, true);
  assert.match(created.topic, /^terminal:term_[a-f0-9]{32}$/);

  dataListener({ stream: "stdout", bytes: Buffer.alloc(terminalLimits.maxEventBytes + 5, 7) });
  await manager.input(created.sessionId, { text: "printf 'literal user input'\n", commandId: "cmd_input" });
  assert.equal(writes[0].toString(), "printf 'literal user input'\n");
  assert.deepEqual(touched, ["server_a"]);
  assert.equal((await manager.resize(created.sessionId, { rows: 40, cols: 140, commandId: "cmd_resize" })).rows, 40);
  assert.equal((await manager.detach(created.sessionId)).attached, false);
  assert.equal((await manager.resume(created.sessionId)).attached, true);
  await manager.close(created.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.inspect(created.sessionId).status, "closed");
  const output = events.filter((entry) => entry.event.kind === "terminal.output");
  assert.equal(output.length, 2);
  assert.ok(output.every((entry) => Buffer.from(entry.event.payload.dataBase64, "base64").length <= terminalLimits.maxEventBytes));
  assert.ok(events.some((entry) => entry.event.kind === "terminal.detached"));
  assert.ok(events.some((entry) => entry.event.kind === "terminal.resumed"));
  assert.ok(events.some((entry) => entry.event.kind === "terminal.closed"));
});

test("shadow version backend mirrors workspace data but never reads or writes the user's .git", async () => {
  const remote = memoryRemote();
  remote.files.set("/work/project/readme.md", Buffer.from("one"));
  remote.directories.add("/work/project/src");
  remote.files.set("/work/project/src/app.mjs", Buffer.from("export default 1;"));
  remote.directories.add("/work/project/.git");
  remote.files.set("/work/project/.git/config", Buffer.from("user repository"));
  const identity = `ssh_${"b".repeat(43)}`;
  const backend = await new SshShadowVersionBackend({ executor: remote.executor, actor: actor(), serverIdentity: identity }).initialize();
  const shadow = `~/.easywork/versioning/alice/${identity}/vd_example/worktree`;
  await backend.mkdir(shadow);
  const synchronized = await backend.syncTree({ sourceRoot: "/work/project", shadowRoot: shadow, exclude: [".git", ".easywork"] });
  assert.equal(synchronized.fileCount, 2);
  const expandedShadow = `/home/alice/.easywork/versioning/alice/${identity}/vd_example/worktree`;
  assert.equal(remote.files.get(`${expandedShadow}/readme.md`).toString(), "one");
  assert.equal(remote.files.get(`${expandedShadow}/src/app.mjs`).toString(), "export default 1;");
  assert.equal(remote.files.has(`${expandedShadow}/.git/config`), false);
  assert.equal(remote.files.get("/work/project/.git/config").toString(), "user repository");

  remote.files.set("/work/project/readme.md", Buffer.from("two"));
  remote.files.set("/work/project/new.txt", Buffer.from("new"));
  const changes = await backend.diffTree({ sourceRoot: "/work/project", shadowRoot: shadow, exclude: [".git", ".easywork"] });
  assert.deepEqual(changes.map((entry) => entry.path), ["new.txt", "readme.md"]);
  assert.equal((await backend.fingerprint({ root: "/work/project", path: "readme.md" })).sha256, cryptoHash("two"));

  const statePath = `~/.easywork/versioning/alice/${identity}/vd_example/state.json`;
  await backend.writeJsonAtomic(statePath, { revision: 0, value: 1 }, { expectedRevision: null });
  await backend.writeJsonAtomic(statePath, { revision: 1, value: 2 }, { expectedRevision: 0 });
  await assert.rejects(() => backend.writeJsonAtomic(statePath, { revision: 2 }, { expectedRevision: 0 }), (error) => error?.code === "REVISION_CONFLICT");
  await assert.rejects(() => backend.readJson(`~/.easywork/versioning/other/${identity}/state.json`), (error) => error?.code === "REMOTE_VERSION_STORAGE_ESCAPE");
  await assert.rejects(() => backend.git({
    gitDir: "/work/project/.git",
    workTree: "/work/project",
    indexFile: "/work/project/.git/index",
    configFile: "/work/project/.git/config",
    args: ["add", "--all", "--", "."],
  }), (error) => error?.code === "REMOTE_GIT_STORAGE_ESCAPE");
});

test("skill deployment uploads immutable actor files only to ~/.easywork/skills and reports status", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-remote-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const currentActor = actor();
  const actorRoot = actorDataRoot(dataRoot, currentActor);
  const sourceRelative = "skills/packages/check/1.0/files/SKILL.md";
  const localPath = path.join(actorRoot, ...sourceRelative.split("/"));
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  const content = Buffer.from("# checked skill\n");
  await fs.writeFile(localPath, content);
  const digest = cryptoHash(content);
  const remote = memoryRemote();
  const identity = `ssh_${"c".repeat(43)}`;
  const deployment = await new SshSkillDeployment({ executor: remote.executor, actor: currentActor, dataRoot, serverId: "server_c", serverIdentity: identity }).initialize();
  const plan = {
    schemaVersion: 1,
    taskId: "task_a",
    actorId: currentActor.actorId,
    remoteBase: "~/.easywork/skills",
    skills: [{
      skillId: "check",
      version: "1.0",
      sha256: digest,
      targetRoot: "~/.easywork/skills/check/1.0",
      entrypoint: "~/.easywork/skills/check/1.0/SKILL.md",
      files: [{
        relativePath: "SKILL.md",
        source: { actorRelativePath: sourceRelative, sha256: digest, size: content.length },
        target: { path: "~/.easywork/skills/check/1.0/SKILL.md", expectedSha256: digest },
        status: "upload-required",
      }],
      operations: [{ kind: "verify-or-upload" }],
    }],
    agentSkillRefs: [],
  };
  const refs = await deployment.ensure(plan);
  assert.deepEqual(refs, [{ skillId: "check", version: "1.0", sha256: digest, remotePath: "/home/alice/.easywork/skills/check/1.0" }]);
  assert.equal(remote.uploads.length, 1);
  assert.equal(remote.files.get("/home/alice/.easywork/skills/check/1.0/SKILL.md").toString(), content.toString());
  await deployment.ensure(plan);
  assert.equal(remote.uploads.length, 1, "verified remote hash makes deployment idempotent");
  const inspected = await deployment.inspect();
  assert.equal(inspected.items[0].actorId, "alice");
  assert.equal(inspected.items[0].status, "up-to-date");
  await assert.rejects(() => deployment.ensure({ ...plan, actorId: "mallory" }), (error) => error?.code === "REMOTE_SKILL_PLAN_SCOPE_MISMATCH");
});

function cryptoHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
