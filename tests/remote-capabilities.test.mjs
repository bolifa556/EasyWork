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
import { SshConversationVersionBackend } from "../gateway/core/runtime/conversation-version-backend.mjs";
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
      const publication = /mv -T -- '([^']+)' '([^']+)'/.exec(command);
      if (publication) {
        for (const [candidate, bytes] of [...files]) if (candidate.startsWith(`${publication[1]}/`)) {
          files.set(`${publication[2]}${candidate.slice(publication[1].length)}`, bytes);
          files.delete(candidate);
        }
      }
      if (command.includes("printf '%s' \"$HOME\"")) return { code: 0, stdout: "/home/alice", stderr: "" };
      if (command.startsWith("readlink -f --")) {
        const candidate = command.slice("readlink -f --".length).trim().replace(/^'|'$/g, "");
        return { code: directories.has(candidate) || files.has(candidate) ? 0 : 1, stdout: directories.has(candidate) || files.has(candidate) ? `${candidate}\n` : "", stderr: "" };
      }
      if (command.startsWith("readlink -m --")) {
        const candidate = command.slice("readlink -m --".length).trim().replace(/^'|'$/g, "");
        return { code: 0, stdout: `${path.posix.normalize(candidate)}\n`, stderr: "" };
      }
      if (command.includes(" ls-files --others --exclude-standard -z --")) {
        const names = [...files.keys()].filter((candidate) => candidate.startsWith("/work/project/")).map((candidate) => candidate.slice("/work/project/".length));
        return { code: 0, stdout: names.length ? `${names.join("\0")}\0` : "", stderr: "" };
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

test("default backend advertises terminal, conversation event-ledger versioning, and isolated Skill deployment", async (t) => {
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
  assert.equal(backend.capabilities.versioning.eventLedger, true);
  assert.equal(backend.capabilities.versioning.isolated, true);
  assert.equal(backend.capabilities.skills.storage, "~/.easywork/skills");
  assert.equal(backend.conversationVersion, backend.remoteFs);
  assert.equal(typeof backend.remoteFs.capturePaths, "function");
  assert.equal(typeof backend.remoteFs.restoreSnapshot, "function");
  assert.equal(typeof backend.terminal.resume, "function");
  assert.equal(typeof backend.skillDeployment.inspect, "function");
  assert.equal(typeof backend.agentConfiguration.inspect, "function");
  await backend.close();
});

test("Agent configuration is structured and isolated for managed and user-provided executables", async () => {
  const remote = memoryRemote();
  const deploymentService = {
    async status(agentId, { source = null } = {}) {
      if (source === "user") return { agentId, displayName: agentId, installed: true, managed: false, source: "user" };
      return { agentId, displayName: agentId, installed: true, managed: true, source: "managed" };
    },
  };
  const configuration = new ManagedAgentConfiguration({ executor: remote.executor, deploymentService, actorId: "alice", clock: () => new Date("2026-08-10T01:02:03.000Z") });
  const initial = await configuration.inspect("codex", { source: "managed", configScope: "conversation-current" });
  assert.deepEqual(configuration.snapshot("codex", { configScope: "conversation-current" }), initial);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.fields.map((field) => field.key), ["model", "contextLimit", "reasoningEffort", "approvalPolicy", "sandboxMode"]);
  assert.deepEqual(initial.fields.find((field) => field.key === "contextLimit"), {
    key: "contextLimit",
    label: "自动压缩窗口",
    type: "number",
    nativeKey: "model_auto_compact_token_limit",
  });
  assert.deepEqual(initial.values, { contextLimit: "200000", reasoningEffort: "medium", approvalPolicy: "never", sandboxMode: "auto" });
  assert.deepEqual(initial.fields.find((field) => field.key === "sandboxMode").options.map((option) => option.value), ["auto", "read-only", "workspace-write", "danger-full-access"]);
  assert.equal(initial.fields.find((field) => field.key === "reasoningEffort").options[0].value, "minimal");
  assert.deepEqual(initial.fields.find((field) => field.key === "reasoningEffort").options.map((option) => option.label), ["最低（minimal）", "低（low）", "中等（medium）", "高（high）", "极高（xhigh）"]);
  assert.match(initial.path, /^\/home\/alice\/\.easywork\/runtime\/conversations\/conversation-current-[a-f0-9]{20}\/agents\/codex\/config\.json$/);
  const openCode = await configuration.inspect("opencode", { source: "managed", configScope: "conversation-current" });
  assert.deepEqual(openCode.fields.map((field) => field.key), ["model", "contextLimit", "reasoningEffort", "permissionMode"]);
  assert.deepEqual(openCode.values, { contextLimit: "200000", reasoningEffort: "default", permissionMode: "allow" });
  assert.deepEqual(openCode.fields.find((field) => field.key === "reasoningEffort").options.map((option) => option.label), ["默认（default）", "最低（minimal）", "低（low）", "中等（medium）", "高（high）", "极高（xhigh）", "最大（max）"]);
  assert.equal(openCode.fields.find((field) => field.key === "permissionMode").label, "全局工具权限");
  assert.deepEqual(openCode.fields.find((field) => field.key === "permissionMode").options.map((option) => option.value), ["ask", "allow", "deny"]);
  assert.deepEqual(initial.fields.find((field) => field.key === "approvalPolicy").options.map((option) => option.value), ["untrusted", "on-request", "never"]);
  const initialClaude = await configuration.inspect("claude-code", { source: "managed", configScope: "conversation-current" });
  assert.deepEqual(initialClaude.values, { contextLimit: "200000", effortLevel: "medium", permissionMode: "acceptEdits" });
  assert.deepEqual(initialClaude.fields.find((field) => field.key === "permissionMode").options.map((option) => option.value), ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
  assert.deepEqual(initialClaude.fields.find((field) => field.key === "effortLevel").options.map((option) => option.value), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(initialClaude.fields.find((field) => field.key === "effortLevel").options.map((option) => option.label), ["低（low）", "中等（medium）", "高（high）", "极高（xhigh）", "最大（max，本次会话）"]);
  const updated = await configuration.update("codex", {
    source: "managed",
    configScope: "conversation-current",
    expectedRevision: 0,
    values: { model: "gpt-codex", contextLimit: "262144", reasoningEffort: "high", approvalPolicy: "never", sandboxMode: "danger-full-access" },
  });
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.values, { model: "gpt-codex", contextLimit: "262144", reasoningEffort: "high", approvalPolicy: "never", sandboxMode: "danger-full-access" });
  assert.equal(JSON.parse(remote.files.get(updated.path).toString()).updatedAt, "2026-08-10T01:02:03.000Z");
  assert.equal([...remote.files.keys()].some((candidate) => candidate.startsWith("/home/alice/.codex") || candidate.startsWith("/home/alice/.claude") || candidate.startsWith("/home/alice/.config/opencode")), false);
  const approvalUpdated = await configuration.update("codex", { source: "managed", configScope: "conversation-current", expectedRevision: 1, values: { approvalPolicy: "on-request" } });
  assert.equal(approvalUpdated.values.approvalPolicy, "on-request");
  await assert.rejects(() => configuration.update("codex", { source: "managed", configScope: "conversation-current", expectedRevision: 1, values: { reasoningEffort: "ultracode" } }), (error) => error?.code === "AGENT_CONFIG_VALUE_INVALID");
  const concurrent = await Promise.allSettled([
    configuration.update("codex", { source: "managed", configScope: "conversation-current", expectedRevision: 2, values: { reasoningEffort: "low" } }),
    configuration.update("codex", { source: "managed", configScope: "conversation-current", expectedRevision: 2, values: { reasoningEffort: "medium" } }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(concurrent.find((result) => result.status === "rejected").reason.code, "REVISION_CONFLICT");
  const user = await configuration.inspect("claude-code", { source: "user", configScope: "conversation-user" });
  assert.equal(user.source, "user");
  assert.equal(user.managed, false);
  assert.equal(user.writable, true);
  assert.deepEqual(user.fields.map((field) => field.key), ["model", "contextLimit", "effortLevel", "permissionMode"]);
  assert.deepEqual(user.values, { contextLimit: "200000", effortLevel: "medium", permissionMode: "acceptEdits" });
  const updatedUser = await configuration.update("claude-code", { source: "user", configScope: "conversation-user", expectedRevision: 0, values: { model: "claude", contextLimit: "180000" } });
  assert.equal(updatedUser.source, "user");
  assert.equal(updatedUser.writable, true);
  assert.equal(updatedUser.values.model, "claude");
  assert.equal(updatedUser.values.contextLimit, "180000");
});

test("legacy Claude configurations preserve their selected effort regardless of revision", async () => {
  const remote = memoryRemote();
  const deploymentService = {
    async status(agentId) {
      return { agentId, displayName: agentId, installed: true, managed: true, source: "managed" };
    },
  };
  const initialService = new ManagedAgentConfiguration({ executor: remote.executor, deploymentService, actorId: "alice" });
  const initial = await initialService.inspect("claude-code", { configScope: "legacy-claude" });
  remote.files.set(initial.path, Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    agentId: "claude-code",
    revision: 0,
    values: { contextLimit: "200000", effortLevel: "high", permissionMode: "acceptEdits" },
    updatedAt: null,
  }, null, 2)}\n`));
  const migratedService = new ManagedAgentConfiguration({ executor: remote.executor, deploymentService, actorId: "alice" });
  assert.equal((await migratedService.inspect("claude-code", { configScope: "legacy-claude" })).values.effortLevel, "high");

  remote.files.set(initial.path, Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    agentId: "claude-code",
    revision: 1,
    values: { contextLimit: "200000", effortLevel: "high", permissionMode: "acceptEdits" },
    updatedAt: "2026-08-31T00:00:00.000Z",
  }, null, 2)}\n`));
  const explicitService = new ManagedAgentConfiguration({ executor: remote.executor, deploymentService, actorId: "alice" });
  assert.equal((await explicitService.inspect("claude-code", { configScope: "legacy-claude" })).values.effortLevel, "high");
});

test("three Agent conversation configs persist an accepted effort once and reject stale automatic rewrites", async () => {
  const remote = memoryRemote();
  const deploymentService = {
    async status(agentId) {
      return { agentId, displayName: agentId, installed: true, managed: true, source: "managed" };
    },
  };
  const configuration = new ManagedAgentConfiguration({
    executor: remote.executor,
    deploymentService,
    actorId: "alice",
    clock: () => new Date("2026-09-01T01:02:03.000Z"),
  });
  const cases = [
    { agentId: "codex", field: "reasoningEffort", initial: "high", requested: "high", applied: "xhigh" },
    { agentId: "opencode", field: "reasoningEffort", initial: "default", requested: "high", applied: "xhigh" },
    { agentId: "claude-code", field: "effortLevel", initial: "high", requested: "high", applied: "xhigh" },
  ];
  for (const entry of cases) {
    const configScope = `effort-${entry.agentId}`;
    const initial = await configuration.inspect(entry.agentId, { configScope });
    const selected = await configuration.update(entry.agentId, {
      configScope,
      expectedRevision: initial.revision,
      values: { [entry.field]: entry.initial },
    });
    const adapted = await configuration.adaptEffort(entry.agentId, {
      source: "managed",
      configScope,
      configuredValue: entry.initial,
      requestedEffort: entry.requested,
      appliedEffort: entry.applied,
    });
    assert.equal(adapted.changed, true);
    assert.equal(adapted.field, entry.field);
    assert.equal(adapted.configuration.revision, selected.revision + 1);
    assert.equal(adapted.configuration.values[entry.field], entry.applied);

    const repeated = await configuration.adaptEffort(entry.agentId, {
      source: "managed",
      configScope,
      configuredValue: entry.initial,
      requestedEffort: entry.requested,
      appliedEffort: entry.applied,
    });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.configuration.revision, adapted.configuration.revision);

    const userChanged = await configuration.update(entry.agentId, {
      configScope,
      expectedRevision: adapted.configuration.revision,
      values: { [entry.field]: "low" },
    });
    const stale = await configuration.adaptEffort(entry.agentId, {
      source: "managed",
      configScope,
      configuredValue: entry.applied,
      requestedEffort: entry.applied,
      appliedEffort: "medium",
    });
    assert.equal(stale.changed, false);
    assert.equal(stale.currentValue, "low");
    assert.equal(stale.configuration.revision, userChanged.revision);
    assert.equal(stale.configuration.values[entry.field], "low");
  }
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
  const created = await manager.create({ term: "xterm-256color", rows: 30, cols: 120, scopeKey: "conversation_a:workspace_a", commandId: "cmd_create" });
  assert.equal(opened[0], "server_a");
  assert.deepEqual(opened[1], { term: "xterm-256color", rows: 30, cols: 120 });
  assert.equal(created.status, "open");
  assert.equal(created.attached, true);
  assert.match(created.topic, /^terminal:term_[a-f0-9]{32}$/);

  dataListener({ stream: "stdout", bytes: Buffer.alloc(terminalLimits.maxEventBytes + 5, 7) });
  const listed = manager.list({ scopeKey: "conversation_a:workspace_a" });
  assert.equal(listed.length, 1);
  assert.equal(Buffer.from(listed[0].outputBase64, "base64").length, terminalLimits.maxEventBytes + 5);
  await manager.input(created.sessionId, { text: "printf 'literal user input'\n", commandId: "cmd_input" });
  assert.equal(writes[0].toString(), "printf 'literal user input'\n");
  assert.deepEqual(touched, ["server_a"]);
  assert.equal((await manager.resize(created.sessionId, { rows: 40, cols: 140, commandId: "cmd_resize" })).rows, 40);
  assert.equal((await manager.detach(created.sessionId)).attached, true);
  assert.equal((await manager.resume(created.sessionId)).attached, true);
  await manager.close(created.sessionId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.inspect(created.sessionId).status, "closed");
  const output = events.filter((entry) => entry.event.kind === "terminal.output");
  assert.equal(output.length, 2);
  assert.ok(output.every((entry) => Buffer.from(entry.event.payload.dataBase64, "base64").length <= terminalLimits.maxEventBytes));
  assert.equal(manager.hasOpenSessions(), false);
  assert.ok(events.some((entry) => entry.event.kind === "terminal.closed"));
});

test("conversation version backend stores only ledger metadata under .easywork and never opens the user's .git", async () => {
  const remote = memoryRemote();
  remote.directories.add("/work/project/.git");
  remote.files.set("/work/project/.git/config", Buffer.from("user repository"));
  const identity = `ssh_${"b".repeat(43)}`;
  const backend = await new SshConversationVersionBackend({ executor: remote.executor, actor: actor(), serverIdentity: identity }).initialize();
  const ledgerRoot = `~/.easywork/versioning/alice/${identity}/conversations/vl_example`;
  const statePath = `${ledgerRoot}/ledger.json`;
  await backend.mkdir(ledgerRoot);
  await backend.writeJsonAtomic(statePath, { revision: 0, value: 1 }, { expectedRevision: null });
  await backend.writeJsonAtomic(statePath, { revision: 1, value: 2 }, { expectedRevision: 0 });
  await backend.writeJsonAtomic(statePath, { revision: 2, value: 3 }, { expectedRevision: 1 });
  assert.deepEqual(await backend.readJson(statePath), { revision: 2, value: 3 });
  await assert.rejects(() => backend.readJson(`~/.easywork/versioning/other/${identity}/ledger.json`), (error) => error?.code === "REMOTE_VERSION_STORAGE_ESCAPE");
  await assert.rejects(() => backend.capturePaths({ paths: ["/work/project/.git/config"], objectsRoot: `~/.easywork/versioning/alice/${identity}/objects` }), (error) => error?.code === "REMOTE_VERSION_PATH_FORBIDDEN");
  assert.equal(remote.files.get("/work/project/.git/config").toString(), "user repository");
  assert.equal(remote.commands.some((command) => command.trimStart().startsWith("git ")), false);
});

test("conversation version backend creates deterministic directory archives without requiring modern tar sort support", async () => {
  const remote = memoryRemote();
  remote.directories.add("/work/project/artifacts");
  const originalExec = remote.executor.exec.bind(remote.executor);
  remote.executor.exec = async (command, options) => {
    if (command.includes("easywork-version-capture")) {
      remote.commands.push(command);
      return { code: 0, stdout: `D ${"a".repeat(64)} 1024 755\n`, stderr: "" };
    }
    return originalExec(command, options);
  };
  const identity = `ssh_${"e".repeat(43)}`;
  const backend = await new SshConversationVersionBackend({ executor: remote.executor, actor: actor(), serverIdentity: identity }).initialize();
  const captured = await backend.capturePaths({
    paths: ["/work/project/artifacts"],
    objectsRoot: `~/.easywork/versioning/alice/${identity}/objects`,
  });
  assert.equal(captured[0].snapshot.type, "directory");
  const command = remote.commands.find((candidate) => candidate.includes("easywork-version-capture"));
  assert.doesNotMatch(command, /--sort=name/);
  assert.match(command, /find "\.\/\$base" -print0/);
  assert.match(command, /LC_ALL=C sort -z/);
  assert.match(command, /tar --null --no-recursion --files-from=-/);
});

test("conversation version backend does not restore normalized epoch mtimes from directory archives", async () => {
  const remote = memoryRemote();
  const identity = `ssh_${"f".repeat(43)}`;
  const objectId = "a".repeat(64);
  const objectsRoot = `/home/alice/.easywork/versioning/alice/${identity}/objects`;
  remote.files.set(`${objectsRoot}/aa/${objectId}`, Buffer.from("directory archive"));
  const originalExec = remote.executor.exec.bind(remote.executor);
  remote.executor.exec = async (command, options) => {
    if (command.includes("easywork-version-path")) {
      remote.commands.push(command);
      return { code: 0, stdout: "/work/project/artifacts\n", stderr: "" };
    }
    if (command.includes("easywork-version-restore")) {
      remote.commands.push(command);
      return { code: 0, stdout: "", stderr: "" };
    }
    return originalExec(command, options);
  };
  const backend = await new SshConversationVersionBackend({ executor: remote.executor, actor: actor(), serverIdentity: identity }).initialize();
  await backend.restoreSnapshot({
    path: "/work/project/artifacts",
    snapshot: { exists: true, type: "directory", sha256: objectId, size: 17, mode: 0o755, objectId },
    objectsRoot,
  });
  const command = remote.commands.find((candidate) => candidate.includes("easywork-version-restore"));
  assert.match(command, /tar --touch -xf "\$object" -C "\$parent"/);
  assert.doesNotMatch(command, /\ntar -xf "\$object"/);
});

test("skill deployment uploads immutable actor files only to ~/.easywork/skills and reports status", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-remote-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const currentActor = actor();
  const actorRoot = actorDataRoot(dataRoot, currentActor);
  const sourceRelative = "skills/packages/check/.installed/files/SKILL.md";
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
      targetRoot: "~/.easywork/skills/check",
      entrypoint: "~/.easywork/skills/check/SKILL.md",
      files: [{
        relativePath: "SKILL.md",
        source: { actorRelativePath: sourceRelative, sha256: digest, size: content.length },
        target: { path: "~/.easywork/skills/check/SKILL.md", expectedSha256: digest },
        status: "upload-required",
      }],
      operations: [{ kind: "verify-or-upload" }],
    }],
    agentSkillRefs: [],
  };
  const refs = await deployment.ensure(plan);
  const actorKey = cryptoHash(Buffer.from(`${currentActor.actorType}:${currentActor.actorId}`));
  const remotePath = `/home/alice/.easywork/skills/packages/${actorKey}/${digest}`;
  assert.deepEqual(refs, [{ skillId: "check", sha256: digest, remotePath, entrypoint: `${remotePath}/SKILL.md` }]);
  assert.equal(remote.uploads.length, 1);
  assert.equal(remote.files.get(`${remotePath}/SKILL.md`).toString(), content.toString());
  await deployment.ensure(plan);
  assert.equal(remote.uploads.length, 1, "verified remote hash makes deployment idempotent");
  const inspected = await deployment.inspect();
  assert.equal(inspected.items[0].actorId, "alice");
  assert.equal(inspected.items[0].status, "up-to-date");
  remote.files.set(`${remotePath}/SKILL.md`, Buffer.from("changed"));
  await assert.rejects(() => deployment.ensure(plan), { code: "REMOTE_SKILL_CACHE_CORRUPT" });
  assert.equal(remote.files.get(`${remotePath}/SKILL.md`).toString(), "changed", "corrupt immutable packages are rejected rather than overwritten");
  await assert.rejects(() => deployment.ensure({ ...plan, actorId: "mallory" }), (error) => error?.code === "REMOTE_SKILL_PLAN_SCOPE_MISMATCH");
});

function cryptoHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
