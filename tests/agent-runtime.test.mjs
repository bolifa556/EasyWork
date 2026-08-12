import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { createClaudeCodeAdapter } from "../gateway/core/agents/claude-code.mjs";
import { createCodexAdapter } from "../gateway/core/agents/codex.mjs";
import { createOpenCodeAdapter } from "../gateway/core/agents/opencode.mjs";
import {
  AgentDeploymentService,
  AgentRuntimeTransport,
  AsyncQueue,
  HostAgentArtifactCatalog,
  SshAgentExecutor,
  SshProcessHandle,
  createInstallDescriptor,
  normalizeLinuxPlatform,
  remoteAgentPaths,
} from "../gateway/core/agent-runtime/index.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop(), { recursive: true, force: true });
});

async function artifactFixture({ hashOverride = null, archive = "raw", archiveBinary = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "easywork-agent-runtime-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "opencode"), { recursive: true });
  const content = Buffer.from("fixture-opencode-binary");
  const file = "opencode/opencode-linux-x64";
  await writeFile(path.join(root, file), content);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    agents: {
      opencode: {
        version: "9.1.2",
        artifacts: {
          "linux-x64": {
            file,
            archive,
            ...(archiveBinary ? { binary: archiveBinary } : {}),
            sha256: hashOverride || sha256,
            size: content.length,
          },
        },
      },
    },
  }));
  return { root, sha256 };
}

class FakeProcess {
  constructor(id) {
    this.processId = id;
    this.closed = false;
    this.queue = new AsyncQueue();
    this.writes = [];
    this.rpc = [];
    this.signals = [];
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  lines() { return this.queue; }

  discardBufferedLines() {}

  writeJson(value) { this.writes.push(structuredClone(value)); }

  async requestJsonRpc(method, params) {
    this.rpc.push({ method, params: structuredClone(params) });
    if (method === "thread/start") return { thread: { id: "thread-native-1" } };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "turn-native-1" } };
    return {};
  }

  notifyJsonRpc(method, params) {
    this.rpc.push({ method, params: params === undefined ? undefined : structuredClone(params), notification: true });
  }

  async signal(value) { this.signals.push(value); }

  wait() { return this.exitPromise; }

  close() {
    this.closed = true;
    this.queue.end();
    this.resolveExit({ code: 0, signal: null });
  }
}

class FakeExecutor {
  constructor() {
    this.files = new Map();
    this.commands = [];
    this.uploads = [];
    this.writes = [];
    this.spawns = [];
    this.http = [];
    this.eventQueues = [];
    this.processes = [];
    this.proxyRequests = [];
    this.proxyClosed = 0;
    this.remoteReachable = false;
    this.scanOutput = "";
  }

  async home() { return "/home/tester"; }

  async exec(command) {
    this.commands.push(command);
    if (command.startsWith("uname -s")) return { code: 0, stdout: "Linux\nx86_64\nglibc 2.39\n", stderr: "" };
    if (command.includes("--version")) return { code: 0, stdout: "agent 3.2.1\n", stderr: "" };
    if (command.startsWith("find ")) return { code: this.scanOutput ? 0 : 1, stdout: this.scanOutput, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  async upload(localPath, remotePath) {
    this.uploads.push({ localPath, remotePath });
  }

  async writeAtomic(remotePath, content, options = {}) {
    this.writes.push({ remotePath, content: String(content), options });
    this.files.set(remotePath, Buffer.from(String(content)));
  }

  async readFile(remotePath) {
    if (!this.files.has(remotePath)) throw Object.assign(new Error("No such file"), { code: "ENOENT" });
    return this.files.get(remotePath);
  }

  async spawn(specification) {
    this.spawns.push(structuredClone(specification));
    const process = new FakeProcess(`process-${this.processes.length + 1}`);
    this.processes.push(process);
    return process;
  }

  async spawnDetached(specification) {
    const process = await this.spawn(specification);
    process.detached = true;
    return process;
  }

  async requestHttp(request) {
    this.http.push(structuredClone(request));
    if (request.path === "/global/health") {
      if (this.spawns.length === 0) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return { healthy: true };
    }
    if (request.method === "POST" && request.path === "/session") return { id: "session-native-1" };
    return {};
  }

  async openHttpEventStream(request) {
    this.http.push({ ...structuredClone(request), stream: true });
    const queue = new AsyncQueue();
    this.eventQueues.push(queue);
    return queue;
  }

  async openLoopbackProxy(request) {
    this.proxyRequests.push(structuredClone(request));
    let closed = false;
    return {
      host: "127.0.0.1",
      port: 18443,
      protocol: "http",
      endpointPath: "/relay/v1",
      isClosed: () => closed,
      close: async () => { if (!closed) this.proxyClosed += 1; closed = true; },
    };
  }

  async probeTcp() { return this.remoteReachable; }
}

function deploymentResolver(source = "managed") {
  return {
    async resolveRuntime(agentId) {
      const binary = agentId === "claude-code" ? "claude" : agentId;
      return {
        installed: true,
        source,
        managed: source === "managed",
        binaryPath: source === "managed"
          ? `/home/tester/.easywork/agents/${agentId === "claude-code" ? "claudecode" : agentId}/current/bin/${binary}`
          : `/opt/user-agent/${binary}`,
        version: "1.0.0",
      };
    },
  };
}

function binding(adapter, patch = {}) {
  return {
    schemaVersion: 1,
    agentBindingId: "binding:conversation-1:workspace-1",
    adapterId: adapter.id,
    state: adapter.createState(),
    native: {},
    activeRunId: null,
    ...patch,
  };
}

function requestFor(adapter, operation, input, patch = {}) {
  const currentBinding = patch.binding || binding(adapter);
  return {
    adapterId: adapter.id,
    operation,
    descriptor: adapter.operation(operation, input),
    binding: currentBinding,
    workspace: { path: "/work/demo" },
    skills: [{
      skillId: "review",
      version: "1.0.0",
      sha256: "a".repeat(64),
      remotePath: "/home/tester/.easywork/skills/review/1.0.0",
    }],
    ...patch,
  };
}

describe("host Agent artifact catalog", () => {
  it("validates schema, platform, size and SHA-256 before deployment", async () => {
    const fixture = await artifactFixture();
    const catalog = new HostAgentArtifactCatalog({ root: fixture.root });
    const artifact = await catalog.resolve("opencode", "linux-x64");
    assert.equal(artifact.sha256, fixture.sha256);
    assert.equal(artifact.version, "9.1.2");
    assert.equal(artifact.binary, "opencode");
    assert.equal(normalizeLinuxPlatform({ os: "Linux", arch: "aarch64", musl: true }), "linux-arm64-musl");
  });

  it("rejects an artifact whose content hash does not match the manifest", async () => {
    const fixture = await artifactFixture({ hashOverride: "0".repeat(64) });
    const catalog = new HostAgentArtifactCatalog({ root: fixture.root });
    await assert.rejects(() => catalog.resolve("opencode", "linux-x64"), { code: "AGENT_ARTIFACT_HASH_MISMATCH" });
  });

  it("uses the manifest-declared executable name inside tar archives", async () => {
    const fixture = await artifactFixture({ archive: "tar.gz", archiveBinary: "opencode-linux-x64" });
    const catalog = new HostAgentArtifactCatalog({ root: fixture.root });
    const artifact = await catalog.resolve("opencode", "linux-x64");
    assert.equal(artifact.archiveBinary, "opencode-linux-x64");
    assert.equal(createInstallDescriptor({
      artifact,
      paths: remoteAgentPaths("/home/tester", "opencode"),
    }).archiveBinary, "opencode-linux-x64");
  });
});

describe("SSH process protocol", () => {
  it("commits uploads with remote mv so an existing artifact can be replaced", async () => {
    const commands = [];
    const writes = [];
    let ended = false;
    const executor = new SshAgentExecutor({
      session: {
        exec: async (command) => {
          commands.push(command);
          return { code: 0, stdout: "", stderr: "" };
        },
        sftp: async () => ({
          fastPut(localPath, remotePath, callback) {
            writes.push({ localPath, remotePath });
            callback(null);
          },
          unlink(_remotePath, callback) { callback(null); },
          end() { ended = true; },
        }),
      },
    });

    await executor.upload("C:/host/codex.tar.gz", "/home/tester/.easywork/runtime/release/artifact.tar.gz");

    assert.equal(writes.length, 1);
    assert.match(writes[0].remotePath, /artifact\.tar\.gz\.upload-/);
    assert.match(commands.at(-1), /^mv -f -- /);
    assert.match(commands.at(-1), /artifact\.tar\.gz'$/);
    assert.equal(ended, true);
  });

  it("keeps the forwarded HTTP request writable until the Agent returns its response", async () => {
    class ForwardedStream extends EventEmitter {
      constructor() {
        super();
        this.writes = [];
        this.ended = false;
        this.destroyed = false;
      }

      write(value) {
        this.writes.push(Buffer.from(value));
        queueMicrotask(() => {
          this.emit("data", Buffer.from(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\ntrue",
          ));
        });
        return true;
      }

      destroy() { this.destroyed = true; }

      end() {
        this.ended = true;
        throw new Error("forwarded HTTP channel was half-closed before the response");
      }
    }
    const stream = new ForwardedStream();
    const executor = new SshAgentExecutor({
      session: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        sftp: async () => ({}),
        forwardOut: async () => stream,
      },
    });
    assert.equal(await executor.requestHttp({
      host: "127.0.0.1",
      port: 4096,
      method: "POST",
      path: "/session/native/abort",
    }), true);
    assert.equal(stream.writes.length, 1);
    assert.equal(stream.ended, false);
    assert.equal(stream.destroyed, true);
  });

  it("detaches an HTTP Agent service before opening forwarding channels", async () => {
    const commands = [];
    const executor = new SshAgentExecutor({
      session: {
        exec: async (command) => {
          commands.push(command);
          return command.includes("nohup")
            ? { code: 0, stdout: "__EASYWORK_REMOTE_PID__:4312\n", stderr: "" }
            : { code: 0, stdout: "", stderr: "" };
        },
        sftp: async () => ({}),
      },
    });
    const process = await executor.spawnDetached({
      executable: "/home/tester/.easywork/agents/opencode/current/bin/opencode",
      args: ["serve", "--port", "40123"],
      cwd: "/home/tester/.easywork/workspaces/workspace-1",
      env: { HOME: "/home/tester/.easywork/runtime/home" },
      logPath: "/home/tester/.easywork/runtime/logs/opencode-serve.log",
    });
    assert.equal(process.processId, "remote-4312");
    assert.equal(process.detached, true);
    assert.match(commands[0], /nohup HOME=/);
    assert.match(commands[0], /opencode-serve\.log/);
    await process.signal("SIGTERM");
    assert.match(commands[1], /^kill -TERM -- 4312/);
  });

  it("captures the real remote PID and speaks Codex newline JSON-RPC without legacy headers", async () => {
    class Channel extends EventEmitter {
      constructor() {
        super();
        this.stderr = new EventEmitter();
        this.written = [];
      }

      write(value) { this.written.push(String(value)); }

      signal(_name, callback) { callback(); }
    }
    const channel = new Channel();
    const process = new SshProcessHandle({ channel, processId: "logical-1" });
    channel.emit("data", Buffer.from("__EASYWORK_REMOTE_PID__:4123\n"));
    assert.equal(await process.ready(), "remote-4123");
    const response = process.requestJsonRpc("initialize", { clientInfo: { name: "easywork" } });
    const request = JSON.parse(channel.written[0]);
    assert.equal(request.jsonrpc, undefined);
    channel.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`));
    assert.deepEqual(await response, { ok: true });
    process.notifyJsonRpc("initialized");
    assert.deepEqual(JSON.parse(channel.written[1]), { method: "initialized" });
    channel.emit("close", 0, null);
    assert.deepEqual(await process.wait(), { code: 0, signal: null });
  });
});

describe("managed and user Agent deployment", () => {
  it("uploads a verified release, atomically switches current and persists managed state only in .easywork", async () => {
    const fixture = await artifactFixture();
    const executor = new FakeExecutor();
    const service = new AgentDeploymentService({
      catalog: new HostAgentArtifactCatalog({ root: fixture.root }),
      executor,
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const installed = await service.install("opencode");
    assert.equal(installed.action, "install");
    assert.equal(installed.state.managed, true);
    assert.match(installed.descriptor.remoteArtifact, /^\/home\/tester\/\.easywork\/runtime\/releases\//);
    assert.equal(executor.uploads.length, 1);
    assert.ok(executor.writes.some((entry) => /\.easywork\/runtime\/releases\/scripts\/.+deploy-agent\.sh$/.test(entry.remotePath)));
    assert.ok(executor.writes.some((entry) => entry.remotePath === "/home/tester/.easywork/agents/opencode/state.json"));
    assert.ok(executor.commands.every((command) => !command.includes("/.config/opencode") && !command.includes("/.codex") && !command.includes("/.claude")));

    const unchanged = await service.install("opencode");
    assert.equal(unchanged.action, "none");
    assert.equal(unchanged.changed, false);
    assert.equal((await service.status("opencode")).source, "managed");
    assert.equal((await service.checkUpdate("opencode")).updateAvailable, false);

    const updatedContent = Buffer.from("fixture-opencode-binary-updated");
    const updatedHash = crypto.createHash("sha256").update(updatedContent).digest("hex");
    await writeFile(path.join(fixture.root, "opencode/opencode-linux-x64"), updatedContent);
    await writeFile(path.join(fixture.root, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      agents: {
        opencode: {
          version: "9.2.0",
          artifacts: {
            "linux-x64": {
              file: "opencode/opencode-linux-x64",
              archive: "raw",
              sha256: updatedHash,
              size: updatedContent.length,
            },
          },
        },
      },
    }));
    assert.equal((await service.checkUpdate("opencode")).updateAvailable, true);
    const updated = await service.install("opencode");
    assert.equal(updated.action, "update");
    assert.equal(updated.descriptor.action, "update");
    assert.equal(updated.state.version, "9.2.0");
    const removed = await service.uninstall("opencode", { source: "managed" });
    assert.equal(removed.descriptor.target, "/home/tester/.easywork/agents/opencode");
    assert.ok(executor.commands.at(-1).startsWith("rm -rf -- '/home/tester/.easywork/agents/opencode'"));
  });

  it("records user-selected directories without writing user Agent configuration and scans only on explicit user action", async () => {
    const fixture = await artifactFixture();
    const executor = new FakeExecutor();
    const service = new AgentDeploymentService({ catalog: new HostAgentArtifactCatalog({ root: fixture.root }), executor });
    const selected = await service.registerUserDeployment("opencode", { root: "/opt/my-opencode" });
    assert.equal(selected.binaryPath, "/opt/my-opencode/bin/opencode");
    assert.equal(selected.managed, false);
    assert.equal(executor.writes.length, 1);
    assert.equal(executor.writes[0].remotePath, "/home/tester/.easywork/runtime/agents/registry/opencode.json");
    assert.ok(!executor.writes[0].remotePath.startsWith("/opt/my-opencode"));
    await assert.rejects(() => service.scan("opencode", { trigger: "automatic", roots: ["/opt"] }), { code: "AGENT_SCAN_TRIGGER_REQUIRED" });
    executor.scanOutput = "/opt/my-opencode/bin/opencode\n";
    const found = await service.scan("opencode", { trigger: "user", roots: ["/opt"] });
    assert.equal(found[0].binaryPath, "/opt/my-opencode/bin/opencode");
    await service.uninstall("opencode", { source: "user" });
    assert.ok(executor.commands.at(-1).startsWith("rm -f -- '/home/tester/.easywork/runtime/agents/registry/opencode.json'"));
  });

  it("provides explicit install and uninstall descriptors", async () => {
    const fixture = await artifactFixture();
    const catalog = new HostAgentArtifactCatalog({ root: fixture.root });
    const artifact = await catalog.resolve("opencode", "linux-x64");
    const paths = remoteAgentPaths("/home/tester", "opencode");
    const descriptor = createInstallDescriptor({ artifact, paths });
    assert.equal(descriptor.action, "install");
    assert.equal(descriptor.binaryPath, "/home/tester/.easywork/agents/opencode/current/bin/opencode");
  });

  it("refuses deployment before upload when a controlled .easywork directory is a symlink", async () => {
    const fixture = await artifactFixture();
    class UnsafeExecutor extends FakeExecutor {
      async exec(command) {
        if (command.startsWith("for target in ")) return { code: 73, stdout: "", stderr: "unsafe symlink" };
        return super.exec(command);
      }
    }
    const executor = new UnsafeExecutor();
    const service = new AgentDeploymentService({ catalog: new HostAgentArtifactCatalog({ root: fixture.root }), executor });
    await assert.rejects(() => service.install("opencode"), { code: "AGENT_EASYWORK_ROOT_UNSAFE" });
    assert.equal(executor.uploads.length, 0);
  });
});

describe("three-Agent executable runtime transport", () => {
  it("runs OpenCode over a remote-loopback service and targets append/interrupt at the same native session", async () => {
    const executor = new FakeExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(), clock: () => 1 });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }, {
      apiRoute: {
        remoteReachable: false,
        baseUrl: "https://api.internal/v1",
        apiKey: "proxy-upstream-key",
        model: "model-agent-1",
        protocol: "auto",
      },
    }));
    assert.equal(executor.spawns.length, 1);
    assert.match(executor.spawns[0].logPath, /\/logs\/opencode-serve\.log$/);
    assert.equal(executor.spawns[0].env.HOME.includes("/.easywork/runtime/agents/opencode/"), true);
    assert.equal(executor.spawns[0].env.OPENAI_BASE_URL, "http://127.0.0.1:18443/relay/v1");
    assert.equal(executor.spawns[0].env.OPENAI_API_KEY, "easywork-proxy");
    const openCodeConfig = JSON.parse(executor.writes.find((entry) => entry.remotePath.endsWith("/opencode/opencode.json")).content);
    assert.equal(openCodeConfig.model, "easywork/model-agent-1");
    assert.equal(openCodeConfig.provider.easywork.npm, "@ai-sdk/openai-compatible");
    assert.equal(openCodeConfig.provider.easywork.options.baseURL, "{env:OPENAI_BASE_URL}");
    assert.equal(openCodeConfig.provider.easywork.options.apiKey, "{env:OPENAI_API_KEY}");
    assert.deepEqual(Object.keys(openCodeConfig.provider.easywork.models), ["model-agent-1"]);
    assert.deepEqual(openCodeConfig.permission.external_directory, {
      "/home/tester/.easywork/skills/**": "allow",
    });
    assert.deepEqual(started.bindingPatch.native.apiProxy, { mode: "ssh-reverse", protocol: "http" });
    assert.equal(JSON.stringify(started).includes("proxy-upstream-key"), false);
    assert.equal(executor.writes.some((entry) => entry.content.includes("proxy-upstream-key")), false);
    const initialPrompt = executor.http.find((entry) => entry.path === "/session/session-native-1/prompt_async");
    assert.ok(initialPrompt);
    assert.deepEqual(initialPrompt.body.model, { providerID: "easywork", modelID: "model-agent-1" });
    assert.equal(executor.http.some((entry) => entry.path.includes("$session.id")), false);
    const createIndex = executor.http.findIndex((entry) => entry.method === "POST" && entry.path === "/session");
    const streamIndex = executor.http.findIndex((entry) => entry.stream === true && entry.path === "/event");
    const promptIndex = executor.http.findIndex((entry) => entry.path === "/session/session-native-1/prompt_async");
    assert.ok(createIndex >= 0 && createIndex < streamIndex && streamIndex < promptIndex);
    executor.eventQueues[0].push(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "session-native-1", status: { type: "busy" } } })}`);
    const firstFrame = await started.frames[Symbol.asyncIterator]().next();
    assert.equal(firstFrame.value.type, "session.status");

    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "session-native-1" },
    });
    await transport.execute(requestFor(adapter, "append", { sessionId: "session-native-1", prompt: "also inspect memory" }, { binding: runningBinding }));
    await transport.execute(requestFor(adapter, "interrupt", { sessionId: "session-native-1" }, { binding: runningBinding }));
    assert.equal(executor.spawns.length, 1);
    assert.ok(executor.http.some((entry) => entry.path === "/session/session-native-1/prompt_async"));
    assert.ok(executor.http.some((entry) => entry.path === "/session/session-native-1/abort"));
    await transport.close();
    assert.equal(executor.proxyClosed, 1);
  });

  it("recovers the completed OpenCode turn when the long-lived SSE stream misses the final frames", async () => {
    class PollingExecutor extends FakeExecutor {
      constructor() {
        super();
        this.statusPolls = 0;
      }

      async requestHttp(request) {
        if (request.path === "/session/status") {
          this.http.push(structuredClone(request));
          this.statusPolls += 1;
          return this.statusPolls === 1 ? { "session-native-1": { type: "busy" } } : {};
        }
        if (request.path === "/session/session-native-1/message") {
          this.http.push(structuredClone(request));
          return [{
            info: {
              id: "message-final-1",
              sessionID: "session-native-1",
              role: "assistant",
              finish: "stop",
              time: { created: 10, completed: 20 },
            },
            parts: [{
              id: "part-final-1",
              sessionID: "session-native-1",
              messageID: "message-final-1",
              type: "text",
              text: "recovered final answer",
            }],
          }];
        }
        return super.requestHttp(request);
      }
    }

    const executor = new PollingExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      openCodePollIntervalMs: 1,
    });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }));
    const frames = [];
    for await (const frame of started.frames) frames.push(frame);
    assert.deepEqual(frames.map((frame) => frame.type), ["message.updated", "message.part.updated", "session.idle"]);
    let state = adapter.createState();
    const events = [];
    for (const frame of frames) {
      const reduced = adapter.reduce(state, frame);
      state = reduced.state;
      events.push(...reduced.events);
    }
    assert.equal(state.finalText, "recovered final answer");
    assert.equal(events.at(-1).kind, "final");
    await transport.close();
  });

  it("uses the selected Provider directly when the remote can reach it and returns a typed proxy error when both routes fail", async () => {
    const directExecutor = new FakeExecutor();
    directExecutor.remoteReachable = true;
    const adapter = createOpenCodeAdapter();
    const direct = new AgentRuntimeTransport({ executor: directExecutor, deploymentService: deploymentResolver() });
    const result = await direct.execute(requestFor(adapter, "start", { prompt: "inspect" }, {
      apiRoute: { baseUrl: "https://agent-api.example/v1", apiKey: "direct-runtime-key", model: "model-agent-2", protocol: "auto" },
    }));
    assert.equal(directExecutor.spawns[0].env.OPENAI_BASE_URL, "https://agent-api.example/v1");
    assert.equal(directExecutor.spawns[0].env.OPENAI_API_KEY, "direct-runtime-key");
    assert.equal(directExecutor.proxyRequests.length, 0);
    assert.deepEqual(result.bindingPatch.native.apiProxy, { mode: "direct", protocol: "https" });
    assert.equal(JSON.stringify(result).includes("direct-runtime-key"), false);

    class FailedProxyExecutor extends FakeExecutor {
      async openLoopbackProxy() { throw Object.assign(new Error("sensitive upstream detail"), { code: "SSH_REVERSE_FORWARD_FAILED", status: 502 }); }
    }
    const failed = new AgentRuntimeTransport({ executor: new FailedProxyExecutor(), deploymentService: deploymentResolver() });
    await assert.rejects(() => failed.execute(requestFor(adapter, "start", { prompt: "inspect" }, {
      apiRoute: { baseUrl: "https://agent-api.example/v1", apiKey: "must-not-leak", model: "model-agent-2", protocol: "auto" },
    })), (error) => {
      assert.equal(error.code, "AGENT_API_PROXY_UNAVAILABLE");
      assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes("must-not-leak"), false);
      assert.equal(error.details.reason, "SSH_REVERSE_FORWARD_FAILED");
      return true;
    });
  });

  it("runs a user-deployed Agent with its native HOME while keeping EasyWork metadata and Skill references isolated", async () => {
    const executor = new FakeExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver("user") });
    await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }));
    assert.equal(executor.spawns[0].env.HOME, undefined);
    assert.equal(executor.spawns[0].env.XDG_CONFIG_HOME, undefined);
    assert.equal(executor.spawns[0].env.EASYWORK_SKILLS_DIR, "/home/tester/.easywork/skills");
    assert.ok(executor.writes.every((entry) => entry.remotePath.startsWith("/home/tester/.easywork/")));
  });

  it("keeps Codex JSON-RPC on one app-server process for live append and interrupt", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(), clock: () => 2 });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "run checks", cwd: "/work/demo" }));
    const process = executor.processes[0];
    assert.deepEqual(process.rpc.map((entry) => entry.method), ["initialize", "initialized", "thread/start", "turn/start"]);
    assert.equal(process.rpc[3].params.threadId, "thread-native-1");
    process.queue.push(JSON.stringify({ method: "turn/started", params: { threadId: "thread-native-1", turn: { id: "turn-native-1" } } }));
    assert.equal((await started.frames[Symbol.asyncIterator]().next()).value.method, "turn/started");

    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, threadId: "thread-native-1", turnId: "turn-native-1" },
    });
    await transport.execute(requestFor(adapter, "append", {
      threadId: "thread-native-1",
      turnId: "turn-native-1",
      prompt: "include disk",
    }, { binding: runningBinding }));
    await transport.execute(requestFor(adapter, "interrupt", {
      threadId: "thread-native-1",
      turnId: "turn-native-1",
    }, { binding: runningBinding }));
    assert.equal(executor.spawns.length, 1);
    assert.deepEqual(process.rpc.slice(-2).map((entry) => entry.method), ["turn/steer", "turn/interrupt"]);

    const restartedExecutor = new FakeExecutor();
    const restartedTransport = new AgentRuntimeTransport({ executor: restartedExecutor, deploymentService: deploymentResolver() });
    await restartedTransport.execute(requestFor(adapter, "start", {
      threadId: "thread-native-1",
      prompt: "new task on the same binding",
    }, {
      binding: binding(adapter, { native: { threadId: "thread-native-1" } }),
    }));
    assert.deepEqual(restartedExecutor.processes[0].rpc.map((entry) => entry.method), [
      "initialize",
      "initialized",
      "thread/resume",
      "turn/start",
    ]);
  });

  it("configures managed Codex with the selected Responses provider instead of the built-in OpenAI endpoint", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }, {
      apiRoute: {
        baseUrl: "https://agent-api.example/v1",
        apiKey: "codex-secret-key",
        model: "deepseek-v4-flash",
        protocol: "responses",
        remoteReachable: false,
      },
    }));

    const config = executor.writes.find((entry) => entry.remotePath.endsWith("/codex/config.toml"));
    assert.ok(config);
    assert.match(config.content, /^model = "deepseek-v4-flash"/m);
    assert.match(config.content, /^model_provider = "easywork"/m);
    assert.match(config.content, /^\[model_providers\.easywork\]$/m);
    assert.match(config.content, /^base_url = "http:\/\/127\.0\.0\.1:18443\/relay\/v1"$/m);
    assert.match(config.content, /^env_key = "OPENAI_API_KEY"$/m);
    assert.match(config.content, /^wire_api = "responses"$/m);
    assert.match(config.content, /^supports_websockets = false$/m);
    assert.equal(config.content.includes("codex-secret-key"), false);
    assert.equal(executor.spawns[0].env.OPENAI_BASE_URL, "http://127.0.0.1:18443/relay/v1");
    assert.equal(executor.spawns[0].env.OPENAI_API_KEY, "easywork-proxy");
    await transport.close();
  });

  it("uses the same Claude Code process for live append and SIGINT, then resumes the native session in a fresh isolated process", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(), clock: () => 3 });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const firstProcess = executor.processes[0];
    assert.equal(firstProcess.writes[0].message.content[0].text, "inspect");
    firstProcess.queue.push(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" }));
    assert.equal((await started.frames[Symbol.asyncIterator]().next()).value.session_id, "claude-session-1");

    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "claude-session-1" },
    });
    await transport.execute(requestFor(adapter, "append", { prompt: "include cpu" }, { binding: runningBinding }));
    assert.equal(firstProcess.writes[1].message.content[0].text, "include cpu");
    await transport.execute(requestFor(adapter, "interrupt", { processId: firstProcess.processId }, { binding: runningBinding }));
    assert.deepEqual(firstProcess.signals, ["SIGINT"]);

    const resumed = await transport.execute(requestFor(adapter, "resume", {
      sessionId: "claude-session-1",
      prompt: "continue",
    }, { binding: runningBinding }));
    assert.equal(executor.spawns.length, 2);
    assert.ok(executor.spawns[1].args.includes("--resume"));
    assert.equal(resumed.bindingPatch.native.processId, "process-2");

    const nextTaskStart = await transport.execute(requestFor(adapter, "start", { prompt: "next task" }, {
      binding: binding(adapter, { native: { sessionId: "claude-session-1" } }),
    }));
    assert.ok(executor.spawns[2].args.includes("--resume"));
    assert.equal(nextTaskStart.bindingPatch.native.processId, "process-3");
  });

  it("executes native compact and returns cached context usage without probing unsupported files", async () => {
    const openExecutor = new FakeExecutor();
    const openAdapter = createOpenCodeAdapter();
    const openTransport = new AgentRuntimeTransport({ executor: openExecutor, deploymentService: deploymentResolver() });
    const openStart = await openTransport.execute(requestFor(openAdapter, "start", { prompt: "x" }));
    const openBinding = binding(openAdapter, {
      activeRunId: openStart.runId,
      native: { ...openStart.bindingPatch.native, sessionId: "session-native-1" },
    });
    await openTransport.execute(requestFor(openAdapter, "compact", {
      sessionId: "session-native-1",
      providerId: "provider-1",
      modelId: "model-1",
    }, { binding: openBinding }));
    assert.ok(openExecutor.http.some((entry) => entry.path === "/session/session-native-1/summarize"));

    const codexExecutor = new FakeExecutor();
    const codexAdapter = createCodexAdapter();
    const codexTransport = new AgentRuntimeTransport({ executor: codexExecutor, deploymentService: deploymentResolver() });
    const codexStart = await codexTransport.execute(requestFor(codexAdapter, "start", { prompt: "x" }));
    const codexBinding = binding(codexAdapter, {
      activeRunId: codexStart.runId,
      native: { ...codexStart.bindingPatch.native, threadId: "thread-native-1", turnId: "turn-native-1" },
      state: codexAdapter.createState({ contextUsage: { used: 12_000, limit: 200_000, ratio: 0.06 } }),
    });
    await codexTransport.execute(requestFor(codexAdapter, "compact", { threadId: "thread-native-1" }, { binding: codexBinding }));
    assert.equal(codexExecutor.processes[0].rpc.at(-1).method, "thread/compact/start");
    const contextUsage = await codexTransport.execute(requestFor(codexAdapter, "contextUsage", { threadId: "thread-native-1" }, { binding: codexBinding }));
    assert.deepEqual(contextUsage.contextUsage, { used: 12_000, limit: 200_000, ratio: 0.06 });

    const claudeExecutor = new FakeExecutor();
    const claudeAdapter = createClaudeCodeAdapter();
    const claudeTransport = new AgentRuntimeTransport({ executor: claudeExecutor, deploymentService: deploymentResolver() });
    const claudeStart = await claudeTransport.execute(requestFor(claudeAdapter, "start", { prompt: "x" }));
    const claudeBinding = binding(claudeAdapter, {
      activeRunId: claudeStart.runId,
      native: { ...claudeStart.bindingPatch.native, sessionId: "claude-session-1" },
    });
    await claudeTransport.execute(requestFor(claudeAdapter, "compact", {
      processId: claudeStart.bindingPatch.native.processId,
      sessionId: "claude-session-1",
    }, { binding: claudeBinding }));
    assert.equal(claudeExecutor.processes[0].writes.at(-1).message.content[0].text, "/compact");
  });

  it("rejects Skill paths outside ~/.easywork/skills and reports missing runtime explicitly", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    await assert.rejects(() => transport.execute(requestFor(adapter, "start", { prompt: "x" }, {
      skills: [{ skillId: "bad", version: "1", remotePath: "/home/tester/.codex/skills/bad", sha256: "" }],
    })), { code: "AGENT_SKILL_PATH_FORBIDDEN" });

    const missing = new AgentRuntimeTransport({
      executor,
      deploymentService: {
        async resolveRuntime() { throw Object.assign(new Error("not installed"), { code: "AGENT_NOT_INSTALLED", status: 409 }); },
      },
    });
    await assert.rejects(() => missing.execute(requestFor(adapter, "start", { prompt: "x" })), { code: "AGENT_NOT_INSTALLED" });
  });
});
