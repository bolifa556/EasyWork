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
import { ApiError } from "../gateway/core/errors.mjs";
import {
  AgentDeploymentService,
  AgentRuntimeTransport,
  AsyncQueue,
  HostAgentArtifactCatalog,
  SshAgentExecutor,
  SshProcessHandle,
  agentLineMerger,
  agentLineQueueOptions,
  coalescedAgentFrames,
  createInstallDescriptor,
  normalizeLinuxPlatform,
  remoteAgentPaths,
} from "../gateway/core/agent-runtime/index.mjs";

const temporaryDirectories = [];

it("native process replacement and late exit cannot close the binding's active API relay", async () => {
  for (const adapter of [createClaudeCodeAdapter(), createCodexAdapter()]) {
    const executor = new FakeExecutor();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const request = requestFor(adapter, "start", { prompt: "prepare", cwd: "/work/demo" }, {
      task: { id: "task-relay", route: { agentId: adapter.id } },
      apiRoute: { baseUrl: "https://api.internal/v1", apiKey: "fixture", model: "model-agent-1", remoteReachable: false },
    });
    await transport.prepare(request);
    const old = executor.processes[0];
    // Force a runtime replacement, as happens when selected Skills change.
    for (const entry of transport.active.values()) entry.runtimeFingerprint = "previous-skills";
    const result = await transport.execute(request);
    assert.equal(executor.processes.length, 2);
    old.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executor.proxyClosed, 0);
    assert.equal(executor.proxyRequests.length, 1);
    assert.ok(result.runId);
    await transport.close();
    assert.equal(executor.proxyClosed, 1);
  }
});

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
  constructor(id, { codexHook = null, skillCatalog = null } = {}) {
    this.skillCatalog = skillCatalog;
    this.processId = id;
    this.closed = false;
    this.queue = new AsyncQueue();
    this.writes = [];
    this.rpc = [];
    this.signals = [];
    this.inputEnded = false;
    this.codexHook = codexHook ? { ...codexHook, trustStatus: "untrusted" } : null;
    this.additionalCodexHooks = [];
    this.rejectCodexSteerOnce = false;
    this.codexTurnSequence = 0;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
  }

  lines() { return this.queue; }

  discardBufferedLines() {}

  writeJson(value) { this.writes.push(structuredClone(value)); }

  endInput() { this.inputEnded = true; }

  async requestControl(value) {
    this.writeJson(value);
    return { type: "control_response", response: { subtype: "success", request_id: value.request_id } };
  }

  async requestJsonRpc(method, params) {
    this.rpc.push({ method, params: structuredClone(params) });
    if (method === "skills/extraRoots/set") { this.skillRoots = params.extraRoots; return {}; }
    if (method === "skills/list") return { data: [{ cwd: params.cwds[0], skills: await this.skillCatalog(this.skillRoots) }] };
    if (method === "turn/steer" && this.rejectCodexSteerOnce) {
      this.rejectCodexSteerOnce = false;
      throw Object.assign(new Error("no active turn to steer"), { code: "AGENT_RPC_FAILED" });
    }
    if (method === "hooks/list") {
      assert.ok(this.codexHook);
      return {
        data: [{ cwd: params.cwds[0], hooks: [{ ...this.codexHook }, ...this.additionalCodexHooks.map((hook) => ({ ...hook }))], warnings: [], errors: [] }],
      };
    }
    if (method === "config/batchWrite") {
      assert.ok(this.codexHook);
      const trustedHash = params.edits[0].value[this.codexHook.key].trusted_hash;
      assert.equal(trustedHash, this.codexHook.currentHash);
      this.codexHook.trustStatus = "trusted";
      return { configFilePath: this.codexHook.sourcePath, version: "2" };
    }
    if (method === "thread/start") return { thread: { id: "thread-native-1", path: "/home/tester/.codex/sessions/thread-native-1.jsonl" } };
    if (method === "thread/resume") return { thread: { id: params.threadId, path: `/home/tester/.codex/sessions/${params.threadId}.jsonl` } };
    if (method === "thread/fork") return { thread: { id: "thread-native-fork", path: "/home/tester/.codex/sessions/thread-native-fork.jsonl" } };
    if (method === "thread/revert") return { thread: { id: params.threadId, path: `/home/tester/.codex/sessions/${params.threadId}.jsonl` } };
    if (method === "turn/start") return { turn: { id: `turn-native-${++this.codexTurnSequence}` } };
    return {};
  }

  notifyJsonRpc(method, params) {
    this.rpc.push({ method, params: params === undefined ? undefined : structuredClone(params), notification: true });
  }

  respondJsonRpc(id, result) {
    this.rpc.push({ response: true, id, result: structuredClone(result) });
  }

  async signal(value) {
    this.signals.push(value);
    if (["SIGTERM", "SIGKILL"].includes(value) && this.writes.at(-1)?.request?.subtype === "interrupt") this.close();
  }

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
    this.links = new Map();
    this.commands = [];
    this.uploads = [];
    this.writes = [];
    this.spawns = [];
    this.http = [];
    this.eventQueues = [];
    this.processes = [];
    this.proxyRequests = [];
    this.proxyClosed = 0;
    this.proxyEffortHandler = null;
    this.remoteReachable = false;
    this.scanOutput = "";
    this.claudeBoundaryOutput = "";
    this.claudeBoundaryOutputs = [];
  }

  async home() { return "/home/tester"; }

  async exec(command) {
    this.commands.push(command);
    const copied = /cp -a --reflink=auto -- '([^']+)\/\.' '([^']+)'/.exec(command);
    if (copied) for (const [file, bytes] of [...this.files]) if (file.startsWith(`${copied[1]}/`)) this.files.set(`${copied[2]}${file.slice(copied[1].length)}`, Buffer.from(bytes));
    const linked = /ln -s -- '([^']+)' '([^']+)'/.exec(command);
    if (linked) this.links.set(linked[2], linked[1]);
    const moved = /mv -Tf -- '([^']+)' '([^']+)'/.exec(command);
    if (moved && this.links.has(moved[1])) { this.links.set(moved[2], this.links.get(moved[1])); this.links.delete(moved[1]); }
    if (command.includes("leafUuid")) return {
      code: 0,
      stdout: this.claudeBoundaryOutputs.length ? this.claudeBoundaryOutputs.shift() : this.claudeBoundaryOutput,
      stderr: "",
    };
    if (command.startsWith("uname -s")) return { code: 0, stdout: "Linux\nx86_64\nglibc 2.39\n", stderr: "" };
    if (command.includes("command -v bwrap")) return { code: 0, stdout: "available\n", stderr: "" };
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
    for (let depth = 0; depth < 8; depth += 1) {
      const link = [...this.links].find(([prefix]) => remotePath === prefix || remotePath.startsWith(`${prefix}/`));
      if (!link) break;
      remotePath = `${link[1]}${remotePath.slice(link[0].length)}`;
    }
    if (!this.files.has(remotePath)) throw Object.assign(new Error("No such file"), { code: "ENOENT" });
    return this.files.get(remotePath);
  }

  async spawn(specification) {
    this.spawns.push(structuredClone(specification));
    const codexConfigPath = specification.env?.CODEX_HOME ? `${specification.env.CODEX_HOME}/config.toml` : null;
    const codexConfig = codexConfigPath && this.files.get(codexConfigPath)?.toString("utf8");
    const commandLine = codexConfig?.match(/^command = (.+)$/m)?.[1] || null;
    const statusLine = codexConfig?.match(/^statusMessage = (.+)$/m)?.[1] || null;
    const codexHook = commandLine && statusLine ? {
      key: `${codexConfigPath}:pre_tool_use:0:0`,
      eventName: "preToolUse",
      handlerType: "command",
      sourcePath: codexConfigPath,
      command: JSON.parse(commandLine),
      statusMessage: JSON.parse(statusLine),
      currentHash: `sha256:${"a".repeat(64)}`,
      enabled: true,
      isManaged: false,
    } : null;
    const process = new FakeProcess(`process-${this.processes.length + 1}`, { codexHook, skillCatalog: async (roots) => {
      const results = [];
      for (const root of roots || []) for (const [view] of this.links) if (view.startsWith(`${root}/`)) {
        const body = (await this.readFile(`${view}/SKILL.md`)).toString();
        results.push({ name: /^name: (.+)$/m.exec(body)?.[1], path: `${view}/SKILL.md` });
      }
      return results;
    } });
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
    if (request.path === "/api/health") {
      if (this.spawns.length === 0) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return { healthy: true };
    }
    if (request.path === "/api/model") {
      return { data: [
        { providerID: "easywork", id: "model-agent-1" },
        { providerID: "easywork", id: "model-agent-2" },
      ] };
    }
    if (request.method === "POST" && request.path === "/api/session") return { data: { id: "session-native-1" } };
    if (request.method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(request.path)) return { data: { admittedSeq: 1 } };
    if (request.path === "/api/session/active") return {};
    if (/^\/api\/session\/[^/]+\/history\?/.test(request.path)) return { data: [], hasMore: false };
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
      setEffortAdaptationHandler: (handler) => {
        this.proxyEffortHandler = typeof handler === "function" ? handler : null;
        return () => {
          if (this.proxyEffortHandler === handler) this.proxyEffortHandler = null;
        };
      },
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
    task: { id: "task-1" },
    workspace: { path: "/work/demo" },
    skills: [],
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
  it("fails a stalled Agent event consumer with bounded backpressure instead of exhausting the gateway heap", async () => {
    let overflow = null;
    const queue = new AsyncQueue(null, {
      maxItems: 2,
      maxBytes: 1024,
      onOverflow: (error) => { overflow = error; },
    });
    queue.push("one");
    queue.push("two");
    queue.push("three");
    assert.equal(overflow?.code, "AGENT_EVENT_BACKPRESSURE_OVERFLOW");
    await assert.rejects(() => queue.next(), { code: "AGENT_EVENT_BACKPRESSURE_OVERFLOW" });
  });

  it("lets a bounded queue merge the last unconsumed item without weakening its byte limit", async () => {
    const queue = new AsyncQueue(null, {
      maxItems: 1,
      maxBytes: 16,
      merge: (previous, current) => `${previous}${current}`,
    });
    queue.push("a");
    queue.push("b");
    queue.end();
    assert.deepEqual(await queue.next(), { value: "ab", done: false });
    assert.deepEqual(await queue.next(), { value: undefined, done: true });
  });

  it("reads ahead and coalesces only adjacent delta lanes for Codex, OpenCode and Claude Code", async () => {
    async function collect(agentId, frames) {
      async function* source() {
        for (const frame of frames) yield structuredClone(frame);
      }
      const stream = coalescedAgentFrames(source(), agentId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const output = [];
      for await (const frame of stream) output.push(frame);
      return output;
    }

    const codex = await collect("codex", [
      { method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "m", delta: "你" } },
      { method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "m", delta: "好" } },
      { method: "item/started", params: { threadId: "t", turnId: "r", item: { id: "tool", type: "commandExecution" } } },
      { method: "item/reasoning/textDelta", params: { threadId: "t", turnId: "r", itemId: "reason", contentIndex: 0, delta: "先" } },
      { method: "item/reasoning/textDelta", params: { threadId: "t", turnId: "r", itemId: "reason", contentIndex: 0, delta: "查" } },
    ]);
    assert.equal(codex.length, 3);
    assert.equal(codex[0].params.delta, "你好");
    assert.equal(codex[1].method, "item/started");
    assert.equal(codex[2].params.delta, "先查");

    const opencode = await collect("opencode", [
      { type: "session.next.text.delta", data: { sessionID: "s", textID: "m", delta: "A" }, durable: { seq: 1 } },
      { type: "session.next.text.delta", data: { sessionID: "s", textID: "m", delta: "B" }, durable: { seq: 2 } },
      { type: "session.next.tool.called", data: { sessionID: "s", callID: "c", tool: "Read" }, durable: { seq: 3 } },
    ]);
    assert.equal(opencode.length, 2);
    assert.equal(opencode[0].data.delta, "AB");
    assert.equal(opencode[0].durable.seq, 2);
    assert.equal(opencode[1].type, "session.next.tool.called");

    const claude = await collect("claude-code", [
      { type: "stream_event", session_id: "s", uuid: "u1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "甲" } } },
      { type: "stream_event", session_id: "s", uuid: "u2", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "乙" } } },
      { type: "stream_event", session_id: "s", uuid: "u3", event: { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { url: "https://example.test" } } } },
    ]);
    assert.equal(claude.length, 2);
    assert.equal(claude[0].event.delta.text, "甲乙");
    assert.equal(claude[1].event.delta.type, "citations_delta");
  });

  it("drains a large Codex token burst while a slow consumer persists the first frame", async () => {
    async function* source() {
      for (let index = 0; index < 10_000; index += 1) {
        yield { method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "m", delta: "x" } };
      }
    }
    const iterator = coalescedAgentFrames(source(), "codex", { maxItems: 2, maxBytes: 32 * 1024 })[Symbol.asyncIterator]();
    const first = await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const output = [first.value];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      output.push(next.value);
    }
    assert.ok(output.length <= 2);
    assert.equal(output.map((frame) => frame.params.delta).join("").length, 10_000);
  });

  it("coalesces a Claude JSONL burst in the process line queue before its item limit", async () => {
    class Channel extends EventEmitter {
      constructor() {
        super();
        this.stderr = new EventEmitter();
        this.inputEnds = 0;
      }

      write() {}

      end() { this.inputEnds += 1; }
    }

    const channel = new Channel();
    const process = new SshProcessHandle({ channel, processId: "claude-burst" });
    channel.emit("data", Buffer.from("__EASYWORK_REMOTE_PID__:4124\n"));
    await process.ready();
    process.endInput();
    process.endInput();
    assert.equal(channel.inputEnds, 1);
    const lines = process.lines({
      maxItems: 2,
      maxBytes: 128 * 1024,
      merge: agentLineMerger("claude-code"),
    });
    const frames = Array.from({ length: 10_000 }, (_unused, index) => JSON.stringify({
      type: "stream_event",
      session_id: "session-1",
      uuid: `wrapper-${index}`,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "x" },
      },
    })).join("\n");
    channel.emit("data", Buffer.from(`${frames}\n`));
    channel.emit("close", 0, null);
    const first = await lines.next();
    assert.equal(first.done, false);
    assert.equal(JSON.parse(first.value).event.delta.partial_json.length, 10_000);
    assert.deepEqual(await lines.next(), { value: undefined, done: true });
  });

  it("preserves Claude completed content blocks and lifecycle events under a queued stream burst", async () => {
    const queue = new AsyncQueue(null, {
      maxItems: 16,
      maxBytes: 128 * 1024,
      ...agentLineQueueOptions("claude-code"),
    });
    const stream = (event) => ({ type: "stream_event", session_id: "session-overlap", parent_tool_use_id: null, event });
    const completed = (uuid, content) => ({ type: "assistant", session_id: "session-overlap", parent_tool_use_id: null, uuid, message: { id: "message-1", content: [content] } });
    const input = { command: "DURATION=60 sbatch scripts/run_generate.sh", description: "Submit job" };
    const frames = [
      stream({ type: "message_start", message: { id: "message-1" } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "submit", name: "Bash", input: {} } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input).slice(0, -2) } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"}' } }),
      completed("block-submit", { type: "tool_use", id: "submit", name: "Bash", input }),
      stream({ type: "content_block_stop", index: 0 }),
      completed("block-read", { type: "tool_use", id: "read", name: "Read", input: { file_path: "/work/README.md" } }),
      stream({ type: "message_delta", usage: { output_tokens: 90 } }),
      stream({ type: "message_stop" }),
    ];
    for (const frame of frames) queue.push(JSON.stringify(frame));
    queue.end();
    const values = [];
    for await (const line of queue) values.push(JSON.parse(line));
    assert.deepEqual(values.filter((frame) => frame.type === "assistant").map((frame) => frame.uuid), ["block-submit", "block-read"], "同一 message.id 下的完成帧是不同内容块，不能互相替换");
    assert.deepEqual(values.filter((frame) => frame.type === "stream_event").map((frame) => frame.event.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.deepEqual(JSON.parse(values.find((frame) => frame.event?.type === "content_block_delta").event.delta.partial_json), input);
  });

  it("drops stale Claude thinking-token telemetry so alternating thinking deltas still coalesce", async () => {
    const queue = new AsyncQueue(null, {
      maxItems: 8,
      maxBytes: 128 * 1024,
      ...agentLineQueueOptions("claude-code"),
    });
    for (let index = 1; index <= 10_000; index += 1) {
      queue.push(JSON.stringify({
        type: "stream_event",
        session_id: "session-thinking",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } },
      }));
      queue.push(JSON.stringify({
        type: "system",
        subtype: "thinking_tokens",
        session_id: "session-thinking",
        parent_tool_use_id: null,
        thinking_tokens: index,
      }));
    }
    queue.end();
    const values = [];
    for await (const line of queue) values.push(JSON.parse(line));
    assert.equal(values.length, 2);
    assert.equal(values[0].type, "stream_event");
    assert.equal(values[0].event.delta.thinking.length, 10_000);
    assert.equal(values[1].type, "system");
    assert.equal(values[1].subtype, "thinking_tokens");
    assert.equal(values[1].thinking_tokens, 10_000);
  });

  it("ends Claude stream-json input after the terminal result so completed turns release their SSH channel", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const process = executor.processes[0];
    process.queue.push(JSON.stringify({ type: "result", subtype: "success", session_id: "claude-session-1", result: "done" }));

    const iterator = started.frames[Symbol.asyncIterator]();
    const terminal = await iterator.next();
    assert.equal(terminal.value.type, "result");
    assert.equal(process.inputEnded, true);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    await transport.close();
  });

  it("persists a rejected Claude effort at the nearest stronger level and emits one visible adjustment", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    let values = { model: "qwen3.8-flash-next", contextLimit: "200000", effortLevel: "medium", permissionMode: "acceptEdits" };
    const adaptations = [];
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: {
        async runtimeValues() {
          return { ...values };
        },
        async adaptEffort(agentId, input) {
          adaptations.push({ agentId, input: structuredClone(input) });
          values = { ...values, effortLevel: input.appliedEffort };
          return {
            changed: true,
            field: "effortLevel",
            requestedEffort: input.requestedEffort,
            appliedEffort: input.appliedEffort,
            configuration: {
              agentId,
              configScope: input.configScope,
              source: "managed",
              managed: true,
              writable: true,
              revision: 2,
              fields: [{ key: "effortLevel", label: "思考强度", type: "enum", nativeKey: "--effort", options: [] }],
              values: { ...values },
            },
          };
        },
      },
    });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }, {
      apiRoute: {
        baseUrl: "https://agent-api.example/v1",
        apiKey: "agent-key",
        model: "qwen3.8-flash-next",
        providerId: "provider-reta",
        protocol: "auto",
        remoteReachable: true,
      },
      task: { id: "task-1", conversationId: "conversation-1" },
    }));
    const firstProcess = executor.processes[0];
    const error = "API Error: 400 Unexpected reasoning effort medium. Supported types are xhigh (default) and low.";
    firstProcess.queue.push(JSON.stringify({
      type: "assistant",
      session_id: "failed-session",
      message: { id: "failed-message", content: [{ type: "text", text: error }] },
    }));
    firstProcess.queue.push(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "failed-session",
      result: error,
    }));

    const iterator = started.frames[Symbol.asyncIterator]();
    const nextFrame = iterator.next();
    for (let attempt = 0; attempt < 20 && executor.processes.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(executor.processes.length, 2);
    assert.equal(executor.spawns[0].args[executor.spawns[0].args.indexOf("--effort") + 1], "medium");
    assert.equal(executor.spawns[0].env.CLAUDE_CODE_EFFORT_LEVEL, "medium");
    assert.equal(executor.spawns[1].args[executor.spawns[1].args.indexOf("--effort") + 1], "xhigh");
    assert.equal(executor.spawns[1].env.CLAUDE_CODE_EFFORT_LEVEL, "xhigh");
    assert.deepEqual(firstProcess.signals, ["SIGTERM"]);
    executor.processes[1].queue.push(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "retry-session",
      result: "done",
    }));
    const adjustment = await nextFrame;
    assert.equal(adjustment.value.type, "easywork_effort_adjusted");
    assert.equal(adjustment.value.adjustment.requestedEffort, "medium");
    assert.equal(adjustment.value.adjustment.appliedEffort, "xhigh");
    assert.match(adjustment.value.adjustment.message, /qwen3\.8-flash-next.*medium.*xhigh/);
    const reduced = adapter.reduce(adapter.createState(), adjustment.value);
    assert.equal(reduced.events[0].kind, "job_status");
    assert.equal(reduced.events[0].payload.operation, "agent_effort_adjusted");
    const terminal = await iterator.next();
    assert.equal(terminal.value.type, "result");
    assert.equal(terminal.value.result, "done");
    assert.equal(JSON.stringify(terminal.value).includes("Unexpected reasoning effort"), false);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.equal(adaptations.length, 1);
    assert.equal(adaptations[0].input.configuredValue, "medium");
    assert.equal(values.effortLevel, "xhigh");
    const stored = JSON.parse(executor.writes.filter((entry) => entry.remotePath.endsWith("/claude/settings.json")).at(-1).content);
    assert.equal(stored.effortLevel, "xhigh");
    await transport.close();
  });

  it("keeps one Claude stream-json process alive across native queued turns and advances each transcript boundary", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const firstLeaf = "22222222-2222-4222-8222-222222222222";
    const secondLeaf = "33333333-3333-4333-8333-333333333333";
    executor.claudeBoundaryOutputs = [`${firstLeaf}\n`, `${secondLeaf}\n`];
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const process = executor.processes[0];
    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId },
      state: adapter.createState({ sessionId }),
    });
    await transport.execute(requestFor(adapter, "append", { prompt: "also verify logs" }, { binding: runningBinding }));
    assert.equal(process.writes.length, 3);
    assert.equal(process.writes[1].request.subtype, "interrupt");
    assert.equal(process.writes[2].message.content[0].text, "also verify logs");

    const iterator = started.frames[Symbol.asyncIterator]();
    process.queue.push(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "first turn",
      queued_turn_count: 1,
    }));
    const firstBoundary = await iterator.next();
    const firstResult = await iterator.next();
    assert.equal(firstBoundary.value.type, "easywork_native_boundary");
    assert.equal(firstBoundary.value.turn_id, firstLeaf);
    assert.equal(firstResult.value.easywork.terminalResult, false);
    assert.equal(firstResult.value.easywork.queuedTurnCount, 1);
    assert.equal(firstResult.value.easywork.queueSource, "native");
    assert.equal(process.inputEnded, false);

    process.queue.push(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "second turn",
      queued_turn_count: 0,
    }));
    const secondBoundary = await iterator.next();
    const secondResult = await iterator.next();
    assert.equal(secondBoundary.value.type, "easywork_native_boundary");
    assert.equal(secondBoundary.value.turn_id, secondLeaf);
    assert.equal(secondResult.value.easywork.terminalResult, true);
    assert.equal(process.inputEnded, true);
    assert.equal(executor.commands.filter((command) => command.includes("leafUuid")).at(-1).includes(firstLeaf), true,
      "the second result must wait for a transcript leaf newer than the first turn");
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    await transport.close();
  });

  it("uses scoped submitted-turn accounting when an older Claude result omits queued_turn_count", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "first", cwd: "/work/demo" }));
    const process = executor.processes[0];
    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "legacy-session" },
    });
    await transport.execute(requestFor(adapter, "append", { prompt: "second" }, { binding: runningBinding }));
    const iterator = started.frames[Symbol.asyncIterator]();
    process.queue.push(JSON.stringify({ type: "result", subtype: "success", session_id: "legacy-session", result: "one" }));
    const first = await iterator.next();
    assert.equal(first.value.easywork.terminalResult, false);
    assert.equal(first.value.easywork.queueSource, "scoped-process");
    assert.equal(process.inputEnded, false);
    process.queue.push(JSON.stringify({ type: "result", subtype: "success", session_id: "legacy-session", result: "two" }));
    const second = await iterator.next();
    assert.equal(second.value.easywork.terminalResult, true);
    assert.equal(process.inputEnded, true);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    await transport.close();
  });

  it("keeps Claude append alive when native interrupt leaks an ede diagnostic before the queued follow-up", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "first", cwd: "/work/demo" }));
    const process = executor.processes[0];
    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "interrupt-session" },
    });
    await transport.execute(requestFor(adapter, "append", { prompt: "correct direction" }, { binding: runningBinding }));
    const iterator = started.frames[Symbol.asyncIterator]();
    process.queue.push(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "interrupt-session",
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      queued_turn_count: 0,
    }));
    const interrupted = await iterator.next();
    assert.equal(interrupted.value.easywork.terminalResult, false);
    assert.equal(interrupted.value.easywork.queuedTurnCount, 1);
    assert.equal(interrupted.value.easywork.queueSource, "scoped-interrupt");
    assert.equal(process.inputEnded, false);

    process.queue.push(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "interrupt-session",
      result: "corrected",
      queued_turn_count: 0,
    }));
    const completed = await iterator.next();
    assert.equal(completed.value.easywork.terminalResult, true);
    assert.equal(completed.value.result, "corrected");
    assert.equal(process.inputEnded, true);
    await transport.close();
  });

  it("emits Claude's authoritative transcript leaf before the terminal result", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const leafUuid = "22222222-2222-4222-8222-222222222222";
    executor.claudeBoundaryOutput = `${leafUuid}\n`;
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const process = executor.processes[0];
    process.queue.push(JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: "done" }));

    const frames = [];
    for await (const frame of started.frames) frames.push(frame);
    assert.deepEqual(frames.map((frame) => frame.type), ["easywork_native_boundary", "result"]);
    assert.equal(frames[0].session_id, sessionId);
    assert.equal(frames[0].turn_id, leafUuid);
    assert.equal(executor.commands.some((command) => command.includes(`${sessionId}.jsonl`)
      && command.includes("leafUuid")
      && command.includes("type")
      && command.includes("assistant")
      && command.includes('if [ -z "$transcript" ]; then transcript=')), true,
    "fresh Claude forks must rediscover a transcript that appears after the terminal result");
    let state = adapter.createState();
    for (const frame of frames) state = adapter.reduce(state, frame).state;
    assert.equal(state.sessionId, sessionId);
    assert.equal(state.turnId, leafUuid);
    assert.equal(state.finalSeen, true);
    await transport.close();
  });

  it("snapshots a legacy Claude session boundary before writing the next prompt", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const previousLeaf = "66666666-6666-4666-8666-666666666666";
    const currentLeaf = "77777777-7777-4777-8777-777777777777";
    executor.claudeBoundaryOutputs = [`${previousLeaf}\n`, `${currentLeaf}\n`];
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const legacyBinding = binding(adapter, {
      native: { sessionId },
      state: adapter.createState({ sessionId, turnId: null }),
    });
    const started = await transport.execute(requestFor(adapter, "start", {
      prompt: "continue",
      cwd: "/work/demo",
    }, { binding: legacyBinding }));
    executor.processes[0].queue.push(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "done",
    }));

    const frames = [];
    for await (const frame of started.frames) frames.push(frame);
    const boundaryCommands = executor.commands.filter((command) => command.includes("leafUuid"));
    assert.equal(boundaryCommands.length, 2);
    assert.match(boundaryCommands[1], new RegExp(previousLeaf));
    assert.equal(frames[0].turn_id, currentLeaf);
    await transport.close();
  });

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
      path: "/api/session/native/interrupt",
    }), true);
    assert.equal(stream.writes.length, 1);
    assert.equal(stream.ended, false);
    assert.equal(stream.destroyed, true);
  });

  it("bounds the complete loopback HTTP request including a stalled SSH forward", async () => {
    let lateStreamDestroyed = false;
    const executor = new SshAgentExecutor({
      session: {
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
        sftp: async () => ({}),
        forwardOut: async () => new Promise((resolve) => setTimeout(() => resolve({
          destroy() { lateStreamDestroyed = true; },
          end() {},
        }), 320)),
      },
    });

    await assert.rejects(executor.requestHttp({
      host: "127.0.0.1",
      port: 4096,
      path: "/api/health",
      timeoutMs: 250,
    }), (error) => error.code === "AGENT_HTTP_REQUEST_TIMEOUT" && error.details.timeoutMs === 250);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(lateStreamDestroyed, true);
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
      envFile: "/home/tester/.easywork/runtime/agents/opencode/binding/config/provider.env",
      logPath: "/home/tester/.easywork/runtime/logs/opencode-serve.log",
    });
    assert.equal(process.processId, "remote-4312");
    assert.equal(process.detached, true);
    assert.match(commands[0], /\. '\/home\/tester\/\.easywork\/runtime\/agents\/opencode\/binding\/config\/provider\.env';/);
    assert.match(commands[0], /HOME='[^']+' nohup/);
    assert.doesNotMatch(commands[0], /nohup HOME=/);
    assert.match(commands[0], /opencode-serve\.log/);
    await process.signal("SIGTERM");
    assert.match(commands[1], /^kill -TERM -- 4312/);
  });

  it("captures the real remote PID and speaks the current Codex newline JSON-RPC protocol", async () => {
    class Channel extends EventEmitter {
      constructor() {
        super();
        this.stderr = new EventEmitter();
        this.written = [];
      }

      write(value) { this.written.push(String(value)); }

      signal(name) { this.signals = [...(this.signals || []), name]; }
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
    const control = process.requestControl({ type: "control_request", request_id: "interrupt-1", request: { subtype: "interrupt" } });
    assert.deepEqual(JSON.parse(channel.written[2]), { type: "control_request", request_id: "interrupt-1", request: { subtype: "interrupt" } });
    channel.emit("data", Buffer.from(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "interrupt-1" } })}\n`));
    assert.equal((await control).response.subtype, "success");
    await process.signal("SIGINT");
    assert.deepEqual(channel.signals, ["INT"]);
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
    const statusCommandCount = executor.commands.length;
    assert.equal((await service.status("opencode", { source: "managed" })).source, "managed");
    assert.equal(executor.commands.length, statusCommandCount, "同一远端部署状态应复用短时缓存");
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
  it("probes the Codex app-server initialization protocol before Agent selection", async () => {
    const executor = new FakeExecutor();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });

    const readiness = await transport.checkReadiness("codex", { configScope: "conversation-1" });

    assert.equal(readiness.ready, true);
    assert.equal(readiness.protocol, "codex-app-server-jsonrpc");
    assert.deepEqual(executor.spawns[0].args, ["app-server"]);
    assert.equal(executor.spawns[0].env.CODEX_HOME, "/home/tester/.easywork/runtime/readiness/codex");
    assert.deepEqual(executor.processes[0].rpc.map((entry) => entry.method), ["initialize", "initialized"]);
    assert.deepEqual(executor.processes[0].signals, ["SIGTERM"]);
  });

  it("rejects Codex selection when the installed app-server cannot initialize", async () => {
    const executor = new FakeExecutor();
    executor.spawn = async function spawn(specification) {
      this.spawns.push(structuredClone(specification));
      const process = new FakeProcess("process-readiness-failure");
      process.requestJsonRpc = async () => {
        throw Object.assign(new Error("process exited before initialize"), { code: "AGENT_PROCESS_EXITED" });
      };
      this.processes.push(process);
      return process;
    };
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });

    await assert.rejects(
      transport.checkReadiness("codex", { configScope: "conversation-1" }),
      (error) => error.code === "AGENT_CODEX_PROTOCOL_UNAVAILABLE"
        && error.message.includes("app-server 初始化协议")
        && error.details.reason === "AGENT_PROCESS_EXITED",
    );
    assert.deepEqual(executor.processes[0].signals, ["SIGTERM"]);
  });

  it("recovers discoverable Skills and sends only this turn's selection through Codex native inputs", async () => {
    const executor = new FakeExecutor();
    const refs = new Map();
    for (const [skillId, version, character] of [["cluster-guide", "2.0.0", "b"], ["review", "1.0.0", "a"]]) {
      const remotePath = "/home/tester/.easywork/skills/packages/actor/" + character.repeat(64);
      const sha256 = character.repeat(64);
      const content = Buffer.from("---\nname: " + skillId + "\ndescription: fixture\n---\n\nApply " + skillId + " rules.\n");
      const entrypoint = skillId === "review" ? "review-guide.md" : "SKILL.md";
      executor.files.set(remotePath + "/" + entrypoint, content);
      executor.files.set(remotePath + "/package.json", Buffer.from(JSON.stringify({ sha256, manifest: { name: skillId, description: "fixture", entrypoint }, files: [{ path: entrypoint }] })));
      refs.set(skillId, { skillId, version, sha256, remotePath });
    }
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(),
      skillDeployment: { async ensurePins(pins) { return pins.map((pin) => refs.get(pin.skillId)); } },
      configurationService: { async runtimeValues() { return { approvalPolicy: "never", sandboxMode: "workspace-write" }; } },
    });
    const result = await transport.execute(requestFor(adapter, "start", { prompt: "continue", cwd: "/work/demo" }, {
      recoveredSkillPins: [{ skillId: "cluster-guide", version: "2.0.0", sha256: "b".repeat(64) }], skills: [refs.get("review")],
    }));
    assert.deepEqual(result.bindingPatch.native.skillPins.map((pin) => pin.skillId).sort(), ["cluster-guide", "review"]);
    const paths = remoteAgentPaths("/home/tester", "codex", "binding:conversation-1:workspace-1");
    const manifest = JSON.parse((await executor.readFile(paths.runtimeState + "/skill-view.json")).toString());
    assert.equal(manifest.skills.length, 2);
    for (const skill of manifest.skills) {
      assert.ok(skill.ownedRoot.startsWith(paths.runtimeRoot + "/skill-generations/"));
      assert.equal(executor.links.get(paths.skillsRoot + "/" + skill.skillId), skill.ownedRoot);
      assert.ok((await executor.readFile(skill.remotePath + "/SKILL.md")).length > 0);
    }
    const roots = executor.processes[0].rpc.find((entry) => entry.method === "skills/extraRoots/set");
    assert.deepEqual(roots.params.extraRoots, [paths.skillsRoot]);
    const turnInput = executor.processes[0].rpc.find((entry) => entry.method === "turn/start").params.input;
    assert.deepEqual(turnInput, [{ type: "text", text: "continue" }, { type: "skill", name: "review", path: paths.skillsRoot + "/review/SKILL.md" }]);
    const review = manifest.skills.find((skill) => skill.skillId === "review");
    executor.files.set(review.ownedRoot + "/SKILL.md", Buffer.from("changed in conversation"));
    assert.match((await executor.readFile(refs.get("review").remotePath + "/review-guide.md")).toString(), /Apply review rules/);
    assert.equal(executor.files.has(refs.get("review").remotePath + "/SKILL.md"), false);
    await transport.close();
  });

  it("uses a verified bubblewrap sandbox in Codex automatic mode", async () => {
    const executor = new FakeExecutor();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: {
        async runtimeValues() {
          return { approvalPolicy: "on-request", sandboxMode: "auto" };
        },
      },
    });
    await transport.execute(requestFor(createCodexAdapter(), "start", { prompt: "inspect", cwd: "/work/demo" }));
    assert.equal(executor.commands.some((command) => command.includes("command -v bwrap") && command.includes("/bin/true")), true);
    assert.equal(executor.spawns[0].args.includes('sandbox_mode="workspace-write"'), true);
    await transport.close();
  });

  it("falls back to no sandbox when Codex automatic mode cannot run bubblewrap", async () => {
    class NoSandboxExecutor extends FakeExecutor {
      async exec(command) {
        if (command.includes("command -v bwrap")) {
          this.commands.push(command);
          return { code: 127, stdout: "", stderr: "" };
        }
        return super.exec(command);
      }
    }
    const executor = new NoSandboxExecutor();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { approvalPolicy: "never", sandboxMode: "auto" }; } },
    });
    await transport.execute(requestFor(createCodexAdapter(), "start", { prompt: "inspect", cwd: "/work/demo" }));
    assert.equal(executor.spawns[0].args.includes('sandbox_mode="danger-full-access"'), true);
    await transport.close();
  });

  it("writes each Agent's native permission vocabulary and refreshes active isolated config", async () => {
    let openCodeValues = { permissionMode: "allow", contextLimit: "262144" };
    const openCodeExecutor = new FakeExecutor();
    const openCodeTransport = new AgentRuntimeTransport({
      executor: openCodeExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { ...openCodeValues }; } },
    });
    await openCodeTransport.execute(requestFor(createOpenCodeAdapter(), "start", { prompt: "inspect" }));
    const openCodeConfigs = () => openCodeExecutor.writes.filter((entry) => entry.remotePath.endsWith("/opencode/opencode.json"));
    assert.deepEqual(JSON.parse(openCodeConfigs().at(-1).content).permissions.slice(0, 3), [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "bash", resource: "*", effect: "ask" },
    ]);
    assert.equal(JSON.parse(openCodeConfigs().at(-1).content).provider?.easywork, undefined);
    openCodeValues = { permissionMode: "ask" };
    assert.deepEqual(await openCodeTransport.refreshManagedConfiguration("opencode"), { agentId: "opencode", updatedBindings: 1 });
    assert.deepEqual(JSON.parse(openCodeConfigs().at(-1).content).permissions[0], { action: "*", resource: "*", effect: "ask" });
    assert.ok(openCodeExecutor.writes.some((entry) => entry.remotePath.endsWith("/state/easywork-version-pretool.sh") && entry.options.mode === 0o700));
    assert.ok(openCodeExecutor.commands.some((command) => command.includes("easywork-version-pretool.sh") && command.includes("--check")));
    await openCodeTransport.close();

    let codexValues = { model: "gpt-codex", contextLimit: "262144", reasoningEffort: "medium", approvalPolicy: "never", sandboxMode: "workspace-write" };
    const codexExecutor = new FakeExecutor();
    const codexAdapter = createCodexAdapter();
    const codexTransport = new AgentRuntimeTransport({
      executor: codexExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { ...codexValues }; } },
    });
    const codexStart = await codexTransport.execute(requestFor(codexAdapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const codexConfig = codexExecutor.writes.find((entry) => entry.remotePath.endsWith("/codex/config.toml"));
    assert.equal(codexExecutor.spawns[0].args.includes('model_reasoning_effort="medium"'), true);
    assert.equal(codexExecutor.spawns[0].args.includes('approval_policy="never"'), true);
    assert.equal(codexExecutor.spawns[0].args.includes('sandbox_mode="workspace-write"'), true);
    assert.equal(codexExecutor.spawns[0].args.includes("model_auto_compact_token_limit=262144"), true);
    assert.equal(codexExecutor.processes[0].rpc.find((entry) => entry.method === "turn/start").params.model, "gpt-codex");
    assert.equal(codexExecutor.processes[0].rpc.find((entry) => entry.method === "turn/start").params.effort, "medium");
    assert.match(codexConfig.content, /^\[\[hooks\.PreToolUse\]\]$/m);
    assert.match(codexConfig.content, /easywork-version-pretool\.sh.+easywork-version-pretool\.py/);
    assert.match(codexConfig.content, /__easywork_internal_version_snapshot__/);
    assert.doesNotMatch(codexConfig.content, /^(?:model|model_provider|model_reasoning_effort|approval_policy|sandbox_mode|model_auto_compact_token_limit)\s*=/m);
    codexValues = { ...codexValues, model: "gpt-codex-next", reasoningEffort: "high", approvalPolicy: "on-request", sandboxMode: "read-only" };
    await codexTransport.refreshManagedConfiguration("codex");
    const codexBinding = binding(codexAdapter, { native: { ...codexStart.bindingPatch.native, threadId: "thread-native-1" } });
    const codexRestart = await codexTransport.execute(requestFor(codexAdapter, "start", { prompt: "inspect again", cwd: "/work/demo" }, { binding: codexBinding }));
    assert.equal(codexExecutor.spawns.length, 2);
    assert.deepEqual(codexExecutor.processes[0].signals, ["SIGTERM"]);
    assert.notEqual(codexRestart.bindingPatch.native.runtimeFingerprint, codexStart.bindingPatch.native.runtimeFingerprint);
    assert.equal(codexExecutor.spawns[1].args.includes('approval_policy="on-request"'), true);
    assert.equal(codexExecutor.spawns[1].args.includes('sandbox_mode="read-only"'), true);
    assert.equal(codexExecutor.processes[1].rpc.find((entry) => entry.method === "turn/start").params.model, "gpt-codex-next");
    assert.equal(codexExecutor.processes[1].rpc.find((entry) => entry.method === "turn/start").params.effort, "high");
    await codexTransport.close();

    const claudeExecutor = new FakeExecutor();
    const claudeTransport = new AgentRuntimeTransport({
      executor: claudeExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { model: "claude-sonnet", contextLimit: "180000", effortLevel: "high", permissionMode: "default" }; } },
    });
    await claudeTransport.execute(requestFor(createClaudeCodeAdapter(), "start", { prompt: "inspect", cwd: "/work/demo" }));
    const claudeConfig = JSON.parse(claudeExecutor.writes.find((entry) => entry.remotePath.endsWith("/claude/settings.json")).content);
    assert.equal(claudeConfig.autoMemoryEnabled, false);
    assert.equal(claudeConfig.effortLevel, "high");
    assert.deepEqual(claudeConfig.permissions, { defaultMode: "default" });
    assert.equal(claudeConfig.hooks.PreToolUse[0].matcher, ".*");
    assert.match(claudeConfig.hooks.PreToolUse[0].hooks[0].command, /easywork-version-pretool\.sh.+easywork-version-pretool\.py/);
    assert.equal(claudeConfig.hooks.PreToolUse[0].hooks[0].statusMessage, "__easywork_internal_version_snapshot__");
    assert.ok(claudeExecutor.spawns[0].args.includes("--permission-mode"));
    assert.ok(claudeExecutor.spawns[0].args.includes("default"));
    assert.ok(claudeExecutor.spawns[0].args.includes("--permission-prompt-tool"));
    assert.ok(claudeExecutor.spawns[0].args.includes("stdio"));
    assert.equal(claudeExecutor.spawns[0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "180000");
    assert.equal(claudeExecutor.spawns[0].env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    await claudeTransport.close();
  });

  it("routes approval responses through each live Agent's native control protocol", async () => {
    const openCodeExecutor = new FakeExecutor();
    const openCodeAdapter = createOpenCodeAdapter();
    const openCodeTransport = new AgentRuntimeTransport({
      executor: openCodeExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "200000", permissionMode: "ask" }; } },
    });
    const openCodeStarted = await openCodeTransport.execute(requestFor(openCodeAdapter, "start", { prompt: "inspect" }));
    const openCodeBinding = binding(openCodeAdapter, {
      activeRunId: openCodeStarted.runId,
      native: { ...openCodeStarted.bindingPatch.native, sessionId: "session-native-1" },
    });
    await openCodeTransport.execute(requestFor(openCodeAdapter, "respondApproval", {
      requestId: "permission-1",
      decision: "approve_session",
      pendingApproval: { sessionId: "session-native-1" },
    }, { binding: openCodeBinding }));
    assert.deepEqual(openCodeExecutor.http.at(-1), {
      host: "127.0.0.1",
      port: openCodeStarted.bindingPatch.native.servicePort,
      method: "POST",
      path: "/api/session/session-native-1/permission/permission-1/reply",
      body: { reply: "always" },
    });
    await openCodeTransport.close();

    const codexExecutor = new FakeExecutor();
    const codexAdapter = createCodexAdapter();
    const codexTransport = new AgentRuntimeTransport({
      executor: codexExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "200000", reasoningEffort: "medium", approvalPolicy: "on-request", sandboxMode: "workspace-write" }; } },
    });
    const codexStarted = await codexTransport.execute(requestFor(codexAdapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const codexBinding = binding(codexAdapter, {
      activeRunId: codexStarted.runId,
      native: { ...codexStarted.bindingPatch.native, threadId: "thread-native-1", turnId: "turn-native-1" },
    });
    await codexTransport.execute(requestFor(codexAdapter, "respondApproval", {
      requestId: "command-1",
      decision: "approve",
      pendingApproval: { wireRequestId: 77 },
    }, { binding: codexBinding }));
    assert.deepEqual(codexExecutor.processes[0].rpc.at(-1), { response: true, id: 77, result: { decision: "accept" } });
    await codexTransport.close();

    const claudeExecutor = new FakeExecutor();
    const claudeAdapter = createClaudeCodeAdapter();
    const claudeTransport = new AgentRuntimeTransport({
      executor: claudeExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "200000", effortLevel: "high", permissionMode: "default" }; } },
    });
    const claudeStarted = await claudeTransport.execute(requestFor(claudeAdapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const claudeBinding = binding(claudeAdapter, {
      activeRunId: claudeStarted.runId,
      native: { ...claudeStarted.bindingPatch.native, sessionId: "session-native-1" },
    });
    await claudeTransport.execute(requestFor(claudeAdapter, "respondApproval", {
      requestId: "request-session",
      decision: "approve_session",
      pendingApproval: {
        suggestions: [{
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "python2 -m unittest" }],
          behavior: "allow",
          destination: "localSettings",
        }],
      },
    }, { binding: claudeBinding }));
    assert.deepEqual(claudeExecutor.processes[0].writes.at(-1), {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-session",
        response: {
          behavior: "allow",
          updatedPermissions: [{
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "python2 -m unittest" }],
            behavior: "allow",
            destination: "session",
          }],
        },
      },
    });
    await claudeTransport.execute(requestFor(claudeAdapter, "respondApproval", {
      requestId: "request-1",
      decision: "reject",
    }, { binding: claudeBinding }));
    assert.deepEqual(claudeExecutor.processes[0].writes.at(-1), {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "request-1",
        response: { behavior: "deny", message: "User rejected this operation." },
      },
    });
    await claudeTransport.close();
  });

  it("uses OpenCode 1.18 V1's source-backed permission reply route for automatic and explicit approvals", async () => {
    class OpenCodeV1Executor extends FakeExecutor {
      permissionReplies = new Map();

      async requestHttp(request) {
        const pathname = String(request.path || "").split("?")[0];
        if (pathname === "/provider") {
          this.http.push(structuredClone(request));
          return { all: [] };
        }
        if (request.method === "POST" && pathname === "/session") {
          this.http.push(structuredClone(request));
          return { id: "session-native-1" };
        }
        if (request.method === "POST" && pathname === "/session/session-native-1/prompt_async") {
          this.http.push(structuredClone(request));
          return {};
        }
        if (pathname === "/session/session-native-1/message") {
          this.http.push(structuredClone(request));
          return [];
        }
        if (request.method === "POST" && pathname === "/permission/per_auto/reply") {
          this.http.push(structuredClone(request));
          const count = Number(this.permissionReplies.get("per_auto") || 0) + 1;
          this.permissionReplies.set("per_auto", count);
          if (count > 1) throw new ApiError("AGENT_HTTP_REQUEST_FAILED", "Agent HTTP 请求失败：404", {
            status: 502,
            details: { remoteStatus: 404 },
          });
          return {};
        }
        return super.requestHttp(request);
      }
    }

    const executor = new OpenCodeV1Executor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "200000", permissionMode: "allow" }; } },
      openCodeDefaultProtocol: "v1",
    });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }));
    assert.equal(started.bindingPatch.native.protocol, "v1");
    const iterator = started.frames[Symbol.asyncIterator]();
    executor.eventQueues[0].push(`data: ${JSON.stringify({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-tool-1",
          sessionID: "session-native-1",
          messageID: "msg-assistant-1",
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: { status: "running", input: { command: "python --version" } },
        },
      },
    })}`);
    executor.eventQueues[0].push(`data: ${JSON.stringify({
      type: "permission.updated",
      properties: {
        id: "per_auto",
        sessionID: "session-native-1",
        permission: "bash",
        patterns: ["python --version"],
        metadata: {},
        always: ["python --version"],
        tool: { messageID: "msg-assistant-1", callID: "call-1" },
      },
    })}`);
    executor.eventQueues[0].push(`data: ${JSON.stringify({
      type: "permission.asked",
      properties: {
        id: "per_auto",
        sessionID: "session-native-1",
        permission: "bash",
        patterns: ["python --version"],
        metadata: {},
        always: ["python --version"],
        tool: { messageID: "msg-assistant-1", callID: "call-1" },
      },
    })}`);
    executor.eventQueues[0].push(`data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "session-native-1" } })}`);
    assert.equal((await iterator.next()).value.type, "message.part.updated");
    assert.equal((await iterator.next()).value.type, "session.idle");
    assert.deepEqual(executor.http.find((entry) => String(entry.path).startsWith("/permission/per_auto/reply")), {
      host: "127.0.0.1",
      port: started.bindingPatch.native.servicePort,
      method: "POST",
      path: "/permission/per_auto/reply?directory=%2Fwork%2Fdemo",
      body: { reply: "once" },
    });
    assert.equal(executor.permissionReplies.get("per_auto"), 1);
    const snapshotCommand = executor.commands.find((command) => command.startsWith("printf '%s'") && command.includes("easywork-version-pretool"));
    assert.match(snapshotCommand, /"easywork_task_id":"task-1"/);

    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "session-native-1" },
    });
    await transport.execute(requestFor(adapter, "respondApproval", {
      requestId: "per_manual",
      decision: "approve_session",
      pendingApproval: { sessionId: "session-native-1" },
    }, { binding: runningBinding }));
    assert.deepEqual(executor.http.at(-1), {
      host: "127.0.0.1",
      port: started.bindingPatch.native.servicePort,
      method: "POST",
      path: "/permission/per_manual/reply?directory=%2Fwork%2Fdemo",
      body: { reply: "always" },
    });
    await transport.close();
  });

  it("aborts an OpenCode native turn when the required pre-mutation snapshot fails", async () => {
    class FailingSnapshotExecutor extends FakeExecutor {
      async exec(command) {
        if (command.startsWith("printf '%s'") && command.includes("easywork-version-pretool")) {
          this.commands.push(command);
          return { code: 2, stdout: "", stderr: "snapshot unavailable" };
        }
        return super.exec(command);
      }

      async requestHttp(request) {
        const pathname = String(request.path || "").split("?")[0];
        if (pathname === "/provider") {
          this.http.push(structuredClone(request));
          return { all: [] };
        }
        if (request.method === "POST" && pathname === "/session") {
          this.http.push(structuredClone(request));
          return { id: "session-native-1" };
        }
        if (request.method === "POST" && pathname === "/session/session-native-1/prompt_async") {
          this.http.push(structuredClone(request));
          return {};
        }
        if (pathname === "/session/session-native-1/message") {
          this.http.push(structuredClone(request));
          return [];
        }
        return super.requestHttp(request);
      }
    }

    const executor = new FailingSnapshotExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "200000", permissionMode: "allow" }; } },
      openCodeDefaultProtocol: "v1",
    });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "write" }));
    const iterator = started.frames[Symbol.asyncIterator]();
    executor.eventQueues[0].push(`data: ${JSON.stringify({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-tool-failed",
          sessionID: "session-native-1",
          messageID: "msg-assistant-1",
          type: "tool",
          callID: "call-write-failed",
          tool: "write",
          state: { status: "running", input: { filePath: "/work/demo/result.txt", content: "new" } },
        },
      },
    })}`);
    executor.eventQueues[0].push(`data: ${JSON.stringify({
      type: "permission.updated",
      properties: {
        id: "per_failed",
        sessionID: "session-native-1",
        permission: "edit",
        patterns: ["result.txt"],
        tool: { messageID: "msg-assistant-1", callID: "call-write-failed" },
      },
    })}`);
    assert.equal((await iterator.next()).value.type, "message.part.updated");
    await assert.rejects(() => iterator.next(), { code: "AGENT_OPENCODE_VERSION_CAPTURE_FAILED" });
    assert.ok(executor.http.some((request) => request.method === "POST"
      && request.path === "/session/session-native-1/abort?directory=%2Fwork%2Fdemo"));
    assert.equal(executor.http.some((request) => String(request.path).startsWith("/permission/per_failed/reply")), false);
    await transport.close();
  });

  it("turns an OpenCode V1 mid-run append into native abort then prompt on the same session", async () => {
    class OpenCodeV1SteerExecutor extends FakeExecutor {
      constructor() {
        super();
        this.busy = false;
      }

      async requestHttp(request) {
        const pathname = String(request.path || "").split("?")[0];
        if (pathname === "/provider") {
          this.http.push(structuredClone(request));
          return { all: [] };
        }
        if (request.method === "POST" && pathname === "/session") {
          this.http.push(structuredClone(request));
          return { id: "session-native-1" };
        }
        if (request.method === "POST" && pathname === "/session/session-native-1/abort") {
          this.http.push(structuredClone(request));
          this.busy = false;
          return {};
        }
        if (pathname === "/session/status") {
          this.http.push(structuredClone(request));
          return { "session-native-1": { type: this.busy ? "busy" : "idle" } };
        }
        if (pathname === "/session/session-native-1/message") {
          this.http.push(structuredClone(request));
          return [];
        }
        if (request.method === "POST" && pathname === "/session/session-native-1/prompt_async") {
          this.http.push(structuredClone(request));
          this.busy = true;
          return {};
        }
        return super.requestHttp(request);
      }
    }

    const executor = new OpenCodeV1SteerExecutor();
    const adapter = createOpenCodeAdapter();
    let now = 10;
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "200000", permissionMode: "allow" }; } },
      openCodeDefaultProtocol: "v1",
      clock: () => ++now,
    });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }));
    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "session-native-1" },
    });
    const appended = await transport.execute(requestFor(adapter, "append", {
      sessionId: "session-native-1",
      prompt: "correct the current direction",
    }, { binding: runningBinding }));
    const abortIndex = executor.http.findIndex((entry) => String(entry.path).startsWith("/session/session-native-1/abort"));
    const promptIndex = executor.http.findLastIndex((entry) => String(entry.path).startsWith("/session/session-native-1/prompt_async"));
    assert.ok(abortIndex >= 0 && abortIndex < promptIndex, JSON.stringify(executor.http.map((entry) => entry.path)));
    assert.equal(executor.http[promptIndex].body.parts[0].text, "correct the current direction");
    assert.notEqual(appended.runId, started.runId);
    assert.equal(appended.bindingPatch.native.sessionId, "session-native-1");
    const idle = `data: ${JSON.stringify({ type: "session.idle", properties: { sessionID: "session-native-1" } })}`;
    executor.eventQueues[0].push(idle);
    executor.eventQueues[1].push(idle);
    await Promise.all([started.frames, appended.frames].map(async (frames) => {
      for await (const frame of frames) {
        void frame; // drain the native terminal boundary
      }
    }));
    await transport.close();
  });

  it("runs OpenCode over a remote-loopback service and targets append/interrupt at the same native session", async () => {
    const executor = new FakeExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "262144", reasoningEffort: "high", permissionMode: "allow" }; } },
      clock: () => 1,
    });
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
    assert.equal(executor.spawns[0].env.OPENAI_BASE_URL, undefined);
    assert.equal(executor.spawns[0].env.OPENAI_API_KEY, undefined);
    assert.match(executor.spawns[0].envFile, /\/config\/provider\.env$/);
    const providerEnvironment = executor.writes.find((entry) => entry.remotePath === executor.spawns[0].envFile);
    assert.equal(providerEnvironment.options.mode, 0o600);
    assert.match(providerEnvironment.content, /export OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:18443\/relay\/v1'/);
    assert.match(providerEnvironment.content, /export OPENAI_API_KEY='easywork-proxy'/);
    const openCodeConfig = JSON.parse(executor.writes.find((entry) => entry.remotePath.endsWith("/opencode/opencode.json")).content);
    assert.equal(openCodeConfig.model, "easywork/model-agent-1");
    assert.equal(openCodeConfig.providers.easywork.api.package, "@ai-sdk/openai-compatible");
    assert.equal(openCodeConfig.providers.easywork.api.url, "http://127.0.0.1:18443/relay/v1");
    assert.deepEqual(Object.keys(openCodeConfig.providers.easywork.models), ["model-agent-1"]);
    assert.equal(openCodeConfig.providers.easywork.models["model-agent-1"].limit.context, 262144);
    assert.equal(openCodeConfig.providers.easywork.models["model-agent-1"].limit.output, 32768);
    assert.deepEqual(openCodeConfig.permissions.slice(0, 3), [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "bash", resource: "*", effect: "ask" },
    ]);
    assert.equal(openCodeConfig.snapshots, true);
    assert.deepEqual(openCodeConfig.compaction, { auto: true });
    assert.ok(executor.writes.some((entry) => entry.remotePath.endsWith("/state/easywork-version-pretool.sh") && entry.options.mode === 0o700));
    assert.ok(executor.writes.some((entry) => entry.remotePath.endsWith("/state/easywork-version-pretool.py")));
    assert.equal(Object.hasOwn(openCodeConfig, "provider"), false);
    assert.equal(Object.hasOwn(openCodeConfig, "permission"), false);
    assert.equal(Object.hasOwn(openCodeConfig, "plugin"), false);
    assert.equal(Object.hasOwn(openCodeConfig, "skills"), false);
    assert.deepEqual(started.bindingPatch.native.apiProxy, { mode: "ssh-reverse", protocol: "http" });
    assert.equal(JSON.stringify(started).includes("proxy-upstream-key"), false);
    assert.equal(executor.writes.filter((entry) => entry.remotePath !== executor.spawns[0].envFile).some((entry) => entry.content.includes("proxy-upstream-key")), false);
    const initialPrompt = executor.http.find((entry) => entry.path === "/api/session/session-native-1/prompt");
    assert.ok(initialPrompt);
    assert.equal(initialPrompt.body.variant, "high");
    const createSession = executor.http.find((entry) => entry.method === "POST" && entry.path === "/api/session");
    assert.deepEqual(createSession.body.model, { providerID: "easywork", id: "model-agent-1" });
    assert.equal(executor.http.some((entry) => entry.path.includes("$session.id")), false);
    const createIndex = executor.http.findIndex((entry) => entry.method === "POST" && entry.path === "/api/session");
    const streamIndex = executor.http.findIndex((entry) => entry.stream === true && entry.path === "/api/event");
    const promptIndex = executor.http.findIndex((entry) => entry.path === "/api/session/session-native-1/prompt");
    assert.ok(createIndex >= 0 && createIndex < streamIndex && streamIndex < promptIndex);
    executor.eventQueues[0].push(`data: ${JSON.stringify({ type: "session.next.step.started", data: { sessionID: "session-native-1", agent: "build", model: { id: "model-agent-1" } }, durable: { seq: 1 } })}`);
    const firstFrame = await started.frames[Symbol.asyncIterator]().next();
    assert.equal(firstFrame.value.type, "session.next.step.started");

    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, sessionId: "session-native-1" },
    });
    await transport.execute(requestFor(adapter, "append", { sessionId: "session-native-1", prompt: "also inspect memory" }, { binding: runningBinding }));
    await transport.execute(requestFor(adapter, "interrupt", { sessionId: "session-native-1" }, { binding: runningBinding }));
    assert.equal(executor.spawns.length, 1);
    assert.ok(executor.http.some((entry) => entry.path === "/api/session/session-native-1/prompt"));
    assert.equal(executor.http.filter((entry) => entry.path === "/api/session/session-native-1/prompt").every((entry) => entry.body.variant === "high"), true);
    assert.ok(executor.http.some((entry) => entry.path === "/api/session/session-native-1/interrupt"));
    await transport.close();
    assert.equal(executor.proxyClosed, 1);
  });

  it("uses OpenCode's source-backed V1 fork boundary, then isolates the branch native store", async () => {
    class NativeHistoryExecutor extends FakeExecutor {
      constructor() {
        super();
        this.childHistoryReads = 0;
      }

      async requestHttp(request) {
        const pathname = String(request.path || "").split("?")[0];
        if (pathname === "/provider") {
          this.http.push(structuredClone(request));
          return { all: [] };
        }
        if (pathname === "/session/session-source/message") {
          this.http.push(structuredClone(request));
          return [
            { info: { id: "msg-source-u1", role: "user" }, parts: [] },
            { info: { id: "msg-source-a1", role: "assistant" }, parts: [] },
            { info: { id: "msg-source-u2", role: "user" }, parts: [] },
            { info: { id: "msg-source-a2", role: "assistant" }, parts: [] },
          ];
        }
        if (pathname === "/session/session-source/fork" && request.method === "POST") {
          this.http.push(structuredClone(request));
          return { id: "session-child" };
        }
        if (pathname === "/session/session-child/message") {
          this.http.push(structuredClone(request));
          this.childHistoryReads += 1;
          return this.childHistoryReads === 1
            ? [
                { info: { id: "msg-child-u1", role: "user" }, parts: [] },
                { info: { id: "msg-child-a1", role: "assistant" }, parts: [] },
              ]
            : [
                { info: { id: "msg-child-u1", role: "user" }, parts: [] },
                { info: { id: "msg-child-a1", role: "assistant" }, parts: [] },
                { info: { id: "msg-child-u2", role: "user" }, parts: [] },
                { info: { id: "msg-child-a2", role: "assistant" }, parts: [] },
              ];
        }
        if (pathname === "/session/session-child/revert" && request.method === "POST") {
          this.http.push(structuredClone(request));
          return { id: "session-child" };
        }
        return super.requestHttp(request);
      }
    }

    const executor = new NativeHistoryExecutor();
    const adapter = createOpenCodeAdapter();
    const sourceBindingId = "binding:conversation-source:workspace-1";
    const branchBinding = binding(adapter, {
      agentBindingId: "binding:conversation-branch:workspace-1",
      native: { runtimeBindingId: sourceBindingId },
    });
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      openCodeDefaultProtocol: "v1",
    });
    const forked = await transport.execute(requestFor(adapter, "fork", {
      sessionId: "session-source",
      retainedMessageId: "msg-source-a1",
    }, { binding: branchBinding }));

    const forkRequest = executor.http.find((entry) => String(entry.path).startsWith("/session/session-source/fork"));
    assert.deepEqual(forkRequest.body, { messageID: "msg-source-u2" }, "Session.fork excludes messageID, so EasyWork must send the first message after the retained assistant");
    assert.equal(forked.bindingPatch.native.sessionId, "session-child");
    assert.equal(forked.bindingPatch.native.turnId, "msg-child-a1");
    assert.equal(forked.bindingPatch.native.protocol, "v1");
    assert.deepEqual(forked.nativeBoundaryMap, {
      "msg-source-u1": "msg-child-u1",
      "msg-source-a1": "msg-child-a1",
    });
    assert.equal(forked.bindingPatch.native.runtimeBindingId, branchBinding.agentBindingId);
    const sourcePaths = remoteAgentPaths("/home/tester", "opencode", sourceBindingId);
    const branchPaths = remoteAgentPaths("/home/tester", "opencode", branchBinding.agentBindingId);
    const stopSourceCommandIndex = executor.commands.findIndex((command) => command.includes("pgrep -f -x") && command.includes(" serve --hostname 127.0.0.1 --port "));
    const cloneCommandIndex = executor.commands.findIndex((command) => command.includes("opencode-native-store-clone-v4.sh"));
    const cloneCommand = executor.commands[cloneCommandIndex];
    assert.ok(stopSourceCommandIndex >= 0, "OpenCode 原生分支复制会话库前必须先停止源服务并刷新 SQLite 状态");
    assert.ok(cloneCommandIndex > stopSourceCommandIndex, "停止源服务必须发生在复制原生会话库之前");
    const cloneScript = executor.writes.find((entry) => entry.remotePath.endsWith("/opencode-native-store-clone-v4.sh"));
    assert.match(cloneScript.content, /\"\$source_app\"\/opencode\*\.db/, "停止写入后只复制 OpenCode 原生会话数据库，不应搬运庞大的 snapshot 与日志目录");
    assert.match(cloneScript.content, /cp -a -- \"\$source_app\/storage\"/, "旧版 OpenCode 的 JSON storage 仍应有兼容路径");
    assert.doesNotMatch(cloneScript.content, /python/i, "分支复制不得依赖服务器 Python 环境");
    assert.match(cloneCommand, new RegExp(sourcePaths.runtimeData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(cloneCommand, new RegExp(branchPaths.runtimeData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(forked.bindingPatch.native.runtimeStoreRoot, branchPaths.runtimeRoot);
    assert.equal(executor.spawns[0].env.XDG_DATA_HOME, branchPaths.runtimeData);
    assert.equal(executor.spawns[0].env.HOME, branchPaths.runtimeHome);
    assert.notEqual(executor.spawns[0].env.HOME, sourcePaths.runtimeHome);
    const config = JSON.parse(executor.writes.find((entry) => entry.remotePath.endsWith("/opencode/opencode.json")).content);
    assert.equal(config.snapshot, true);

    const childBinding = binding(adapter, {
      agentBindingId: branchBinding.agentBindingId,
      state: forked.bindingPatch.state,
      native: forked.bindingPatch.native,
    });
    const reverted = await transport.execute(requestFor(adapter, "revert", {
      sessionId: "session-child",
      retainedMessageId: "msg-child-a1",
    }, { binding: childBinding }));
    const revertRequest = executor.http.find((entry) => String(entry.path).startsWith("/session/session-child/revert"));
    assert.deepEqual(revertRequest.body, { messageID: "msg-child-u2" });
    assert.equal(reverted.bindingPatch.native.sessionId, "session-child");
    assert.equal(reverted.bindingPatch.native.turnId, "msg-child-a1");
    await transport.close();
  });

  it("maps an existing OpenCode V2 regenerate to staged native revert, commit and clear", async () => {
    const executor = new FakeExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    let current = binding(adapter, {
      native: { sessionId: "session-v2", protocol: "v2", turnId: "msg-v2-a2" },
      state: adapter.createState({ sessionId: "session-v2", turnId: "msg-v2-a2" }),
    });
    const staged = await transport.execute(requestFor(adapter, "revert", {
      sessionId: "session-v2",
      retainedMessageId: "msg-v2-a1",
      stageOnly: true,
    }, { binding: current }));
    const stage = executor.http.find((entry) => entry.path === "/api/session/session-v2/revert/stage");
    assert.deepEqual(stage.body, { messageID: "msg-v2-a1", files: true });
    current = binding(adapter, {
      native: { ...current.native, ...staged.bindingPatch.native },
      state: { ...current.state, ...staged.bindingPatch.state },
    });
    await transport.execute(requestFor(adapter, "revert", {
      sessionId: "session-v2",
      commit: true,
    }, { binding: current }));
    assert.ok(executor.http.some((entry) => entry.path === "/api/session/session-v2/revert/commit"));
    await transport.execute(requestFor(adapter, "revert", {
      sessionId: "session-v2",
      undo: true,
    }, { binding: current }));
    assert.ok(executor.http.some((entry) => entry.path === "/api/session/session-v2/revert/clear"));
    await transport.close();
  });

  it("drops a failed detached OpenCode service before retrying the same binding", async () => {
    class StartupFailureExecutor extends FakeExecutor {
      async requestHttp(request) {
        if (request.path === "/api/health" && this.spawns.length < 2) {
          this.http.push(structuredClone(request));
          throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
        }
        return super.requestHttp(request);
      }
    }

    const executor = new StartupFailureExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      httpReadyAttempts: 1,
      httpReadyDelayMs: 0,
    });
    const request = requestFor(adapter, "start", { prompt: "inspect" });
    await assert.rejects(() => transport.execute(request), { code: "AGENT_SERVICE_START_FAILED" });
    assert.deepEqual(executor.processes[0].signals, ["SIGTERM"]);
    assert.equal(executor.proxyClosed, 0);

    const retried = await transport.execute(request);
    assert.equal(executor.spawns.length, 2);
    assert.equal(Number.isSafeInteger(retried.bindingPatch.native.servicePort), true);
    assert.equal(executor.http.filter((entry) => entry.method === "POST" && entry.path === "/api/session").length, 1);
    await transport.close();
  });

  it("reuses a healthy detached OpenCode service after its SSH launch handle closes", async () => {
    const executor = new FakeExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({
      executor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { model: "model-agent-1" }; } },
      clock: () => 10_000,
    });
    const first = await transport.execute(requestFor(adapter, "start", { prompt: "first" }));
    executor.processes[0].closed = true;
    const warmBinding = binding(adapter, {
      native: { ...first.bindingPatch.native, sessionId: "session-native-1" },
    });
    await transport.execute(requestFor(adapter, "start", { prompt: "second" }, { binding: warmBinding }));
    assert.equal(executor.spawns.length, 1);
    assert.equal(executor.http.filter((entry) => entry.path === "/api/model").length, 1);
    await transport.close();
  });

  it("recovers the completed OpenCode turn when the long-lived SSE stream misses the final frames", async () => {
    class PollingExecutor extends FakeExecutor {
      constructor() {
        super();
        this.statusPolls = 0;
      }

      async requestHttp(request) {
        if (request.path === "/api/session/active") {
          this.http.push(structuredClone(request));
          this.statusPolls += 1;
          return this.statusPolls === 1 ? { "session-native-1": { type: "busy" } } : {};
        }
        if (request.path === "/api/session/session-native-1/history?after=0&limit=100") {
          this.http.push(structuredClone(request));
          return {
            data: [
              { type: "session.next.text.started", data: { sessionID: "session-native-1", textID: "text-final-1" }, durable: { seq: 1 } },
              { type: "session.next.text.ended", data: { sessionID: "session-native-1", textID: "text-final-1", text: "recovered final answer" }, durable: { seq: 2 } },
              { type: "session.next.step.ended", data: { sessionID: "session-native-1", finish: "stop", tokens: {} }, durable: { seq: 3 } },
            ],
            hasMore: false,
          };
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
    assert.deepEqual(frames.map((frame) => frame.type), ["session.next.text.started", "session.next.text.ended", "session.next.step.ended"]);
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

  it("defaults to the SSH relay, uses direct routing only when explicitly declared, and returns a typed proxy error when relay setup fails", async () => {
    const defaultExecutor = new FakeExecutor();
    defaultExecutor.remoteReachable = true;
    const adapter = createOpenCodeAdapter();
    const defaultTransport = new AgentRuntimeTransport({ executor: defaultExecutor, deploymentService: deploymentResolver() });
    const proxied = await defaultTransport.execute(requestFor(adapter, "start", { prompt: "inspect" }, {
      apiRoute: { baseUrl: "https://agent-api.example", apiKey: "relay-runtime-key", model: "model-agent-2", protocol: "auto" },
    }));
    assert.equal(defaultExecutor.proxyRequests.length, 1);
    assert.deepEqual(proxied.bindingPatch.native.apiProxy, { mode: "ssh-reverse", protocol: "http" });
    assert.match(defaultExecutor.writes.find((entry) => entry.remotePath.endsWith("/provider.env")).content, /export OPENAI_API_KEY='easywork-proxy'/);
    await defaultTransport.close();

    const directExecutor = new FakeExecutor();
    directExecutor.remoteReachable = true;
    const direct = new AgentRuntimeTransport({ executor: directExecutor, deploymentService: deploymentResolver() });
    const result = await direct.execute(requestFor(adapter, "start", { prompt: "inspect" }, {
      apiRoute: { baseUrl: "https://agent-api.example", apiKey: "direct-runtime-key", model: "model-agent-2", protocol: "auto", remoteReachable: true },
    }));
    assert.equal(directExecutor.spawns[0].env.OPENAI_BASE_URL, undefined);
    assert.equal(directExecutor.spawns[0].env.OPENAI_API_KEY, undefined);
    assert.match(directExecutor.spawns[0].envFile, /\/config\/provider\.env$/);
    const directEnvironment = directExecutor.writes.find((entry) => entry.remotePath === directExecutor.spawns[0].envFile);
    assert.match(directEnvironment.content, /export OPENAI_BASE_URL='https:\/\/agent-api\.example\/v1'/);
    assert.match(directEnvironment.content, /export OPENAI_API_KEY='direct-runtime-key'/);
    const directOpenCodeConfig = JSON.parse(directExecutor.writes.find((entry) => entry.remotePath.endsWith("/opencode/opencode.json")).content);
    assert.equal(directOpenCodeConfig.providers.easywork.api.url, "https://agent-api.example/v1");
    assert.equal(directOpenCodeConfig.providers.easywork.models["model-agent-2"].api.url, "https://agent-api.example/v1");
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

  it("runs a user-deployed executable inside the same per-binding EasyWork HOME and config isolation", async () => {
    const executor = new FakeExecutor();
    const adapter = createOpenCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver("user") });
    await transport.execute(requestFor(adapter, "start", { prompt: "inspect" }));
    assert.match(executor.spawns[0].env.HOME, /^\/home\/tester\/\.easywork\/runtime\/agents\/opencode\//);
    assert.match(executor.spawns[0].env.XDG_CONFIG_HOME, /^\/home\/tester\/\.easywork\/runtime\/agents\/opencode\//);
    assert.match(executor.spawns[0].env.OPENCODE_CONFIG_DIR, /\/config\/opencode$/);
    assert.equal(executor.spawns[0].env.EASYWORK_SKILLS_DIR, remoteAgentPaths("/home/tester", "opencode", "binding:conversation-1:workspace-1").skillsRoot);
    assert.ok(executor.writes.some((entry) => entry.remotePath.endsWith("/config/opencode/opencode.json")));
    assert.ok(executor.writes.every((entry) => entry.remotePath.startsWith("/home/tester/.easywork/")));
  });

  it("keeps Codex JSON-RPC on one app-server process for live append and interrupt", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(), clock: () => 2 });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "run checks", cwd: "/work/demo" }));
    const process = executor.processes[0];
    assert.deepEqual(process.rpc.map((entry) => entry.method), [
      "initialize",
      "initialized",
      "skills/extraRoots/set",
      "hooks/list",
      "config/batchWrite",
      "hooks/list",
      "thread/start",
      "turn/start",
    ]);
    assert.equal(process.rpc.find((entry) => entry.method === "thread/start").params.config, undefined);
    assert.equal(process.rpc.find((entry) => entry.method === "turn/start").params.threadId, "thread-native-1");
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
      "skills/extraRoots/set",
      "hooks/list",
      "config/batchWrite",
      "hooks/list",
      "thread/resume",
      "turn/start",
    ]);
    assert.equal(restartedExecutor.processes[0].rpc.find((entry) => entry.method === "thread/resume").params.config, undefined);
  });

  it("continues on the same Codex thread when the native steer window closes during UI drain", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(), clock: () => 2 });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const process = executor.processes[0];
    const runningBinding = binding(adapter, {
      activeRunId: started.runId,
      native: { ...started.bindingPatch.native, threadId: "thread-native-1", turnId: "turn-native-1" },
    });

    process.rejectCodexSteerOnce = true;
    const continued = await transport.execute(requestFor(adapter, "append", {
      threadId: "thread-native-1",
      turnId: "turn-native-1",
      prompt: "late correction",
    }, { binding: runningBinding }));

    assert.equal(executor.spawns.length, 1);
    assert.deepEqual(process.rpc.slice(-2).map((entry) => entry.method), ["turn/steer", "turn/start"]);
    assert.equal(process.rpc.at(-1).params.threadId, "thread-native-1");
    assert.deepEqual(process.rpc.at(-1).params.input, [{ type: "text", text: "late correction" }]);
    assert.equal(continued.bindingPatch.native.threadId, "thread-native-1");
    assert.equal(continued.bindingPatch.native.turnId, "turn-native-2");
    assert.equal(continued.runId, started.runId,
      "the replacement turn should keep the active EasyWork run while its original thread event pump is alive");
    assert.equal(continued.frames, undefined,
      "the replacement turn must not compete with the existing thread event pump");
    process.queue.push(JSON.stringify({ method: "turn/started", params: { threadId: "thread-native-1", turn: { id: "turn-native-2" } } }));
    assert.equal((await started.frames[Symbol.asyncIterator]().next()).value.params.turn.id, "turn-native-2");
    await transport.close();
  });

  it("accepts the documented snake_case Codex HookEventName wire value", async () => {
    class DocumentedCodexHookExecutor extends FakeExecutor {
      async spawn(specification) {
        const process = await super.spawn(specification);
        process.codexHook.eventName = "pre_tool_use";
        return process;
      }
    }

    const executor = new DocumentedCodexHookExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const started = await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    assert.equal(started.bindingPatch.native.threadId, "thread-native-1");
    assert.equal(executor.processes[0].codexHook.trustStatus, "trusted");
    assert.equal(executor.processes[0].rpc.find((entry) => entry.method === "thread/start").params.config, undefined);
    await transport.close();
  });

  it("trusts only the exact EasyWork Codex Hook and leaves unrelated user Hooks untrusted", async () => {
    class ConflictingCodexHookExecutor extends FakeExecutor {
      async spawn(specification) {
        const process = await super.spawn(specification);
        process.additionalCodexHooks.push({
          key: "workspace:pre_tool_use:unsafe",
          eventName: "preToolUse",
          handlerType: "command",
          sourcePath: "/work/demo/.codex/config.toml",
          command: "python unsafe.py",
          statusMessage: "unsafe",
          currentHash: `sha256:${"b".repeat(64)}`,
          trustStatus: "untrusted",
          enabled: true,
          isManaged: false,
        });
        return process;
      }
    }

    const executor = new ConflictingCodexHookExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    await transport.execute(requestFor(adapter, "start", { prompt: "inspect", cwd: "/work/demo" }));
    const process = executor.processes[0];
    const trustWrite = process.rpc.find((entry) => entry.method === "config/batchWrite");
    assert.deepEqual(Object.keys(trustWrite.params.edits[0].value), [process.codexHook.key]);
    assert.equal(process.codexHook.trustStatus, "trusted");
    assert.equal(process.additionalCodexHooks[0].trustStatus, "untrusted");
    assert.equal(process.rpc.find((entry) => entry.method === "thread/start").params.config, undefined);
    await transport.close();
  });

  it("loads a persisted Codex thread into a warmed app-server before turn/start", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const sharedBinding = binding(adapter, {
      agentBindingId: "binding:conversation-branch:workspace-1",
      native: {
        agentSource: "managed",
        runtimeBindingId: "binding:conversation-source:workspace-1",
        threadId: "thread-native-fork",
      },
    });
    const apiRoute = {
      baseUrl: "https://agent-api.example/v1",
      apiKey: "warm-runtime-key",
      model: "model-agent-1",
      protocol: "responses",
      remoteReachable: true,
    };
    const task = {
      id: "task-warmed-native",
      conversationId: "conversation-branch",
      route: { agentId: "codex", providerId: "provider-1", modelId: "model-agent-1" },
    };

    await transport.prepare({
      adapterId: "codex",
      task,
      binding: sharedBinding,
      workspace: { path: "/work/demo" },
      apiRoute,
    });
    await transport.execute(requestFor(adapter, "start", {
      threadId: "thread-native-fork",
      prompt: "continue the warmed thread",
      cwd: "/work/demo",
    }, {
      binding: sharedBinding,
      task,
      apiRoute,
    }));

    assert.equal(executor.spawns.length, 1);
    assert.deepEqual(executor.processes[0].rpc.map((entry) => entry.method), [
      "initialize",
      "initialized",
      "skills/extraRoots/set",
      "hooks/list",
      "config/batchWrite",
      "hooks/list",
      "thread/resume",
      "turn/start",
    ]);
    assert.equal(executor.processes[0].rpc.find((entry) => entry.method === "thread/resume").params.config, undefined);
    assert.equal(executor.processes[0].rpc.find((entry) => entry.method === "turn/start").params.threadId, "thread-native-fork");
    await transport.close();
  });

  it("never reuses a Codex app-server across different native store roots", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const apiRoute = {
      baseUrl: "https://agent-api.example/v1",
      apiKey: "store-runtime-key",
      model: "model-agent-1",
      protocol: "responses",
      remoteReachable: true,
    };
    const task = {
      id: "task-store-switch",
      conversationId: "conversation-branch",
      route: { agentId: "codex", providerId: "provider-1", modelId: "model-agent-1" },
    };
    const sourceStoreBinding = binding(adapter, {
      agentBindingId: "binding:conversation-branch:workspace-1",
      native: { runtimeBindingId: "binding:conversation-source:workspace-1" },
    });

    await transport.prepare({
      adapterId: "codex",
      task,
      binding: sourceStoreBinding,
      workspace: { path: "/work/demo" },
      apiRoute,
    });
    const localStoreBinding = binding(adapter, {
      agentBindingId: sourceStoreBinding.agentBindingId,
      native: { threadId: "thread-local-store" },
    });
    await transport.execute(requestFor(adapter, "start", {
      threadId: "thread-local-store",
      prompt: "continue in the local store",
      cwd: "/work/demo",
    }, {
      binding: localStoreBinding,
      task,
      apiRoute,
    }));

    assert.equal(executor.spawns.length, 2);
    assert.deepEqual(executor.processes[0].signals, ["SIGTERM"]);
    assert.notEqual(executor.spawns[0].env.CODEX_HOME, executor.spawns[1].env.CODEX_HOME);
    assert.equal(executor.processes[1].rpc.some((entry) => entry.method === "thread/resume"), true);
    await transport.close();
  });

  it("keeps shared Codex HOME and the SSH relay after an event-cache probe", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const sharedBinding = binding(adapter, {
      agentBindingId: "binding:conversation-branch:workspace-1",
      native: {
        agentSource: "managed",
        runtimeBindingId: "binding:conversation-source:workspace-1",
        threadId: "thread-native-fork",
      },
    });
    const apiRoute = {
      baseUrl: "https://agent-api.example/v1",
      apiKey: "context-probe-route-key",
      model: "model-agent-1",
      protocol: "responses",
    };

    await transport.execute(requestFor(adapter, "start", {
      threadId: "thread-native-fork",
      prompt: "first turn",
    }, { binding: sharedBinding, apiRoute }));
    await transport.execute(requestFor(adapter, "contextUsage", {
      threadId: "thread-native-fork",
    }, { binding: sharedBinding, apiRoute }));

    // Preserve the warm entry while forcing the next formal turn to create a
    // fresh app-server process from its cached preparation.
    executor.processes[0].closed = true;
    await transport.execute(requestFor(adapter, "start", {
      threadId: "thread-native-fork",
      prompt: "second turn",
    }, { binding: sharedBinding, apiRoute }));

    const sharedPaths = remoteAgentPaths("/home/tester", "codex", "binding:conversation-source:workspace-1");
    assert.equal(executor.spawns.length, 2);
    assert.equal(executor.spawns[1].env.CODEX_HOME, `${sharedPaths.runtimeData}/codex`);
    assert.equal(executor.proxyRequests.length, 1);
    assert.match(executor.spawns[1].args.join(" "), /127\.0\.0\.1:18443/);
    assert.doesNotMatch(executor.spawns[1].args.join(" "), /agent-api\.example/);
    assert.equal(executor.processes[1].rpc.find((entry) => entry.method === "thread/resume").params.config, undefined);
    await transport.close();
  });

  it("persists Codex rollout paths and executes native fork and history-only revert", async () => {
    const executor = new FakeExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const source = await transport.execute(requestFor(adapter, "start", { prompt: "source", cwd: "/work/demo" }));
    assert.equal(source.bindingPatch.native.rolloutPath, "/home/tester/.codex/sessions/thread-native-1.jsonl");

    const branchBinding = binding(adapter, {
      agentBindingId: "binding:conversation-branch:workspace-1",
      native: { runtimeBindingId: source.bindingPatch.native.runtimeBindingId },
    });
    const forked = await transport.execute(requestFor(adapter, "fork", {
      threadId: "thread-native-1",
      path: source.bindingPatch.native.rolloutPath,
      lastTurnId: "turn-native-1",
      cwd: "/work/demo",
    }, { binding: branchBinding }));
    assert.deepEqual(executor.processes[1].rpc.map((entry) => entry.method), [
      "initialize",
      "initialized",
      "skills/extraRoots/set",
      "hooks/list",
      "config/batchWrite",
      "hooks/list",
      "thread/fork",
    ]);
    assert.deepEqual(executor.processes[1].rpc.at(-1).params, {
      threadId: "thread-native-1",
      path: "/home/tester/.codex/sessions/thread-native-1.jsonl",
      lastTurnId: "turn-native-1",
      cwd: "/work/demo",
      excludeTurns: true,
    });
    assert.equal(forked.bindingPatch.state.sessionId, "thread-native-fork");
    assert.equal(forked.bindingPatch.state.status, "idle");
    assert.equal(forked.bindingPatch.native.threadId, "thread-native-fork");
    assert.equal(forked.bindingPatch.native.rolloutPath, "/home/tester/.codex/sessions/thread-native-fork.jsonl");
    assert.equal(forked.bindingPatch.native.turnId, null);
    assert.equal(forked.bindingPatch.native.runtimeBindingId, "binding:conversation-1:workspace-1");
    assert.equal(executor.spawns[0].env.CODEX_HOME, executor.spawns[1].env.CODEX_HOME, "原生分支必须共享 Codex 分页线程仓库");
    assert.notEqual(executor.spawns[0].env.HOME, executor.spawns[1].env.HOME, "网页分支仍需隔离进程 HOME");

    const forkedBinding = binding(adapter, {
      agentBindingId: branchBinding.agentBindingId,
      state: forked.bindingPatch.state,
      native: forked.bindingPatch.native,
    });
    const reverted = await transport.execute(requestFor(adapter, "revert", {
      threadId: "thread-native-fork",
      beforeTurnId: "turn-to-remove",
    }, { binding: forkedBinding }));
    assert.deepEqual(executor.processes[1].rpc.at(-1), {
      method: "thread/revert",
      params: { threadId: "thread-native-fork", beforeTurnId: "turn-to-remove" },
    });
    assert.equal(reverted.bindingPatch.state.sessionId, "thread-native-fork");
    assert.equal(reverted.bindingPatch.state.status, "idle");
    assert.equal(reverted.bindingPatch.native.rolloutPath, "/home/tester/.codex/sessions/thread-native-fork.jsonl");
    assert.equal(reverted.bindingPatch.native.turnId, null);

    await transport.execute(requestFor(adapter, "start", {
      threadId: "thread-native-fork",
      prompt: "continue on branch",
    }, {
      binding: forkedBinding,
      task: { id: "task-branch-2" },
    }));
    const sourcePaths = remoteAgentPaths("/home/tester", "codex", "binding:conversation-1:workspace-1");
    const branchPaths = remoteAgentPaths("/home/tester", "codex", branchBinding.agentBindingId);
    const routedTask = executor.writes.find((entry) => entry.remotePath === `${sourcePaths.runtimeState}/version-hooks/session-tasks/thread-native-fork.json` && entry.content.includes("task-branch-2"));
    assert.ok(routedTask, "共享 Codex Hook 必须按原生 thread 映射到网页分支 Task");
    assert.equal(JSON.parse(routedTask.content).hookRoot, `${branchPaths.runtimeState}/version-hooks`);
    await transport.close();
  });

  it("drops stale Codex events from an earlier turn when a native thread is resumed", async () => {
    class SequencedCodexProcess extends FakeProcess {
      constructor(id, options) {
        super(id, options);
        this.turnNumber = 0;
      }

      async requestJsonRpc(method, params) {
        if (["hooks/list", "config/batchWrite"].includes(method)) return super.requestJsonRpc(method, params);
        this.rpc.push({ method, params: structuredClone(params) });
        if (method === "thread/resume") return { thread: { id: params.threadId } };
        if (method === "turn/start") {
          this.turnNumber += 1;
          return { turn: { id: `turn-current-${this.turnNumber}` } };
        }
        return {};
      }
    }

    class SequencedCodexExecutor extends FakeExecutor {
      async spawn(specification) {
        const codexConfigPath = `${specification.env.CODEX_HOME}/config.toml`;
        const codexConfig = this.files.get(codexConfigPath).toString("utf8");
        const commandLine = codexConfig.match(/^command = (.+)$/m)[1];
        const statusLine = codexConfig.match(/^statusMessage = (.+)$/m)[1];
        const process = new SequencedCodexProcess(`proc-${this.spawns.length + 1}`, {
          codexHook: {
            key: `${codexConfigPath}:pre_tool_use:0:0`,
            eventName: "preToolUse",
            handlerType: "command",
            sourcePath: codexConfigPath,
            command: JSON.parse(commandLine),
            statusMessage: JSON.parse(statusLine),
            currentHash: `sha256:${"a".repeat(64)}`,
            enabled: true,
            isManaged: false,
          },
        });
        this.spawns.push(structuredClone(specification));
        this.processes.push(process);
        return process;
      }
    }

    const executor = new SequencedCodexExecutor();
    const adapter = createCodexAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const result = await transport.execute(requestFor(adapter, "resume", {
      threadId: "thread-native-1",
      prompt: "continue",
    }, {
      binding: binding(adapter, { native: { threadId: "thread-native-1", turnId: "turn-old" } }),
    }));
    const process = executor.processes[0];
    process.queue.push(JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread-native-1", turn: { id: "turn-old", status: "interrupted" } },
    }));
    process.queue.push(JSON.stringify({
      method: "turn/started",
      params: { threadId: "thread-native-1", turn: { id: "turn-current-1" } },
    }));

    const frame = await result.frames[Symbol.asyncIterator]().next();
    assert.equal(frame.value.method, "turn/started");
    assert.equal(result.bindingPatch.native.turnId, "turn-current-1");
    process.close();
    await transport.close();
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
    assert.match(config.content, /^\[\[hooks\.PreToolUse\]\]$/m);
    assert.equal(executor.spawns[0].args.includes('model="deepseek-v4-flash"'), true);
    assert.equal(executor.spawns[0].args.includes('model_provider="easywork"'), true);
    assert.equal(executor.spawns[0].args.includes('model_providers.easywork.base_url="http://127.0.0.1:18443/relay/v1"'), true);
    assert.equal(executor.spawns[0].args.includes('model_providers.easywork.env_key="OPENAI_API_KEY"'), true);
    assert.equal(executor.spawns[0].args.includes('model_providers.easywork.wire_api="responses"'), true);
    assert.equal(executor.spawns[0].args.includes("model_providers.easywork.supports_websockets=false"), true);
    assert.equal(executor.processes[0].rpc.find((entry) => entry.method === "turn/start").params.model, "deepseek-v4-flash");
    assert.equal(JSON.stringify(executor.spawns[0].args).includes("codex-secret-key"), false);
    assert.equal(executor.spawns[0].env.OPENAI_BASE_URL, undefined);
    assert.equal(executor.spawns[0].env.OPENAI_API_KEY, undefined);
    assert.match(executor.spawns[0].envFile, /\/config\/provider\.env$/);
    assert.match(executor.writes.find((entry) => entry.remotePath === executor.spawns[0].envFile).content, /export OPENAI_API_KEY='easywork-proxy'/);
    await transport.close();
  });

  it("restarts a Claude native session from the same binding settings and provider environment files", async () => {
    const executor = new FakeExecutor();
    executor.remoteReachable = true;
    const adapter = createClaudeCodeAdapter();
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver(), clock: () => 4 });
    const apiRoute = {
      baseUrl: "https://agent-api.example/v1",
      apiKey: "claude-binding-key",
      model: "deepseek-v4-flash",
      protocol: "auto",
      remoteReachable: true,
    };
    const first = await transport.execute(requestFor(adapter, "start", { prompt: "first", cwd: "/work/demo" }, { apiRoute }));
    assert.match(executor.spawns[0].envFile, /\/config\/provider\.env$/);
    assert.ok(executor.spawns[0].args.includes("--settings"));
    assert.ok(executor.spawns[0].args.includes(executor.writes.find((entry) => entry.remotePath.endsWith("/claude/settings.json")).remotePath));
    assert.equal(executor.spawns[0].env.ANTHROPIC_API_KEY, undefined);
    const providerEnvironment = executor.writes.find((entry) => entry.remotePath === executor.spawns[0].envFile);
    assert.match(providerEnvironment.content, /export ANTHROPIC_API_KEY='claude-binding-key'/);
    executor.processes[0].close();
    await new Promise((resolve) => setImmediate(resolve));

    const resumedBinding = binding(adapter, {
      native: { ...first.bindingPatch.native, sessionId: "claude-session-1" },
      state: adapter.createState({ sessionId: "claude-session-1" }),
    });
    await transport.execute(requestFor(adapter, "start", { prompt: "second", cwd: "/work/demo" }, { apiRoute, binding: resumedBinding }));
    assert.equal(executor.spawns.length, 2);
    assert.equal(executor.spawns[1].envFile, executor.spawns[0].envFile);
    assert.ok(executor.spawns[1].args.includes("--resume"));
    assert.ok(executor.spawns[1].args.includes("claude-session-1"));
    assert.ok(executor.spawns[1].args.includes("--settings"));
    assert.equal(executor.writes.filter((entry) => entry.remotePath === providerEnvironment.remotePath).length, 1);
    await transport.close();
  });

  it("defers Claude native branching until the next turn and launches the exact source-backed fork", async () => {
    const executor = new FakeExecutor();
    const adapter = createClaudeCodeAdapter();
    const sourceBindingId = "binding:conversation-source:workspace-1";
    const targetBindingId = "binding:conversation-branch:workspace-1";
    const sourceSessionId = "11111111-1111-4111-8111-111111111111";
    const targetSessionId = "22222222-2222-4222-8222-222222222222";
    const boundaryMessageId = "33333333-3333-4333-8333-333333333333";
    const target = binding(adapter, {
      agentBindingId: targetBindingId,
      native: { runtimeBindingId: sourceBindingId },
    });
    const transport = new AgentRuntimeTransport({ executor, deploymentService: deploymentResolver() });
    const deferred = await transport.execute(requestFor(adapter, "fork", {
      sourceSessionId,
      targetSessionId,
      resumeSessionAt: boundaryMessageId,
    }, { binding: target }));

    assert.equal(executor.spawns.length, 0, "native-deferred must not start Claude before a real user turn exists");
    assert.deepEqual(deferred.bindingPatch.native.pendingFork, {
      sourceSessionId,
      targetSessionId,
      resumeSessionAt: boundaryMessageId,
    });
    assert.equal(deferred.bindingPatch.native.runtimeBindingId, sourceBindingId);
    const sourcePaths = remoteAgentPaths("/home/tester", "claude-code", sourceBindingId);
    const targetPaths = remoteAgentPaths("/home/tester", "claude-code", targetBindingId);
    const prepareCommand = executor.commands.find((command) => command.includes(`${targetPaths.runtimeData}/claude/projects`));
    assert.match(prepareCommand, new RegExp(`${sourcePaths.runtimeData.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/claude/projects`));
    assert.match(prepareCommand, /ln -sfn/);

    const pendingBinding = binding(adapter, {
      agentBindingId: targetBindingId,
      state: deferred.bindingPatch.state,
      native: deferred.bindingPatch.native,
    });
    const forkTurn = await transport.execute(requestFor(adapter, "start", {
      prompt: "continue on the webpage branch",
      cwd: "/work/demo",
      pendingFork: deferred.bindingPatch.native.pendingFork,
    }, { binding: pendingBinding }));

    assert.equal(executor.spawns.length, 1);
    const args = executor.spawns[0].args;
    const forkArgs = args.slice(args.indexOf("--resume"), args.indexOf("--resume-session-at") + 2);
    assert.deepEqual(forkArgs, [
      "--resume", sourceSessionId,
      "--fork-session",
      "--session-id", targetSessionId,
      "--resume-session-at", boundaryMessageId,
    ]);
    assert.equal(executor.spawns[0].env.CLAUDE_CONFIG_DIR, `${targetPaths.runtimeData}/claude`);
    assert.ok(args.includes(`${targetPaths.runtimeData}/claude/settings.json`));
    assert.notEqual(executor.spawns[0].env.CLAUDE_CONFIG_DIR, `${sourcePaths.runtimeData}/claude`);

    const leafUuid = "44444444-4444-4444-8444-444444444444";
    executor.claudeBoundaryOutput = `${leafUuid}\n`;
    executor.processes[0].queue.push(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: targetSessionId,
      result: "done",
    }));
    const nativeFrames = [];
    for await (const frame of forkTurn.frames) nativeFrames.push(frame);
    const boundaryCommand = executor.commands.findLast((command) => command.includes("leafUuid"));
    assert.match(boundaryCommand, new RegExp(boundaryMessageId));
    assert.equal(nativeFrames[0].turn_id, leafUuid);
    await transport.close();
  });

  it("uses the same Claude Code process for live append and native interrupt, then resumes the native session in a fresh isolated process", async () => {
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
    assert.equal(firstProcess.writes[1].request.subtype, "interrupt");
    assert.equal(firstProcess.writes[2].message.content[0].text, "include cpu");
    await transport.execute(requestFor(adapter, "interrupt", { processId: firstProcess.processId, commandId: "command-1" }, { binding: runningBinding }));
    assert.deepEqual(firstProcess.signals, ["SIGTERM"]);
    assert.deepEqual(firstProcess.writes[3], {
      type: "control_request",
      request_id: "easywork-interrupt-command-1",
      request: { subtype: "interrupt" },
    });

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
    }, {
      binding: openBinding,
      apiRoute: {
        remoteReachable: false,
        baseUrl: "https://api.internal/v1",
        apiKey: "proxy-upstream-key",
        model: "model-agent-1",
        protocol: "auto",
      },
    }));
    const openCompact = openExecutor.http.find((entry) => entry.path === "/api/session/session-native-1/compact");
    assert.equal(openCompact.body, undefined);

    const codexExecutor = new FakeExecutor();
    const codexAdapter = createCodexAdapter();
    const codexTransport = new AgentRuntimeTransport({
      executor: codexExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "150000" }; } },
    });
    const codexStart = await codexTransport.execute(requestFor(codexAdapter, "start", { prompt: "x" }));
    const codexBinding = binding(codexAdapter, {
      activeRunId: codexStart.runId,
      native: { ...codexStart.bindingPatch.native, threadId: "thread-native-1", turnId: "turn-native-1" },
      state: codexAdapter.createState({ contextUsage: { used: 12_000, limit: 200_000, ratio: 0.06 } }),
    });
    await codexTransport.execute(requestFor(codexAdapter, "compact", { threadId: "thread-native-1" }, { binding: codexBinding }));
    assert.equal(codexExecutor.processes[0].rpc.at(-1).method, "thread/compact/start");
    const contextUsage = await codexTransport.execute(requestFor(codexAdapter, "contextUsage", { threadId: "thread-native-1" }, { binding: codexBinding }));
    assert.deepEqual(contextUsage.contextUsage, { used: 12_000, limit: 150_000, remaining: 138_000, ratio: 0.08 });

    const claudeExecutor = new FakeExecutor();
    const claudeAdapter = createClaudeCodeAdapter();
    const claudeTransport = new AgentRuntimeTransport({
      executor: claudeExecutor,
      deploymentService: deploymentResolver(),
      configurationService: { async runtimeValues() { return { contextLimit: "180000" }; } },
    });
    const claudeStart = await claudeTransport.execute(requestFor(claudeAdapter, "start", { prompt: "x" }));
    const claudeBinding = binding(claudeAdapter, {
      activeRunId: claudeStart.runId,
      native: { ...claudeStart.bindingPatch.native, sessionId: "claude-session-1" },
      state: claudeAdapter.createState({ contextUsage: { used: 42_000, limit: 200_000, ratio: 0.21, source: "claude-code-current-request" } }),
    });
    await claudeTransport.execute(requestFor(claudeAdapter, "compact", {
      processId: claudeStart.bindingPatch.native.processId,
      sessionId: "claude-session-1",
    }, { binding: claudeBinding }));
    assert.equal(claudeExecutor.processes[0].writes.at(-1).message.content[0].text, "/compact");

    claudeExecutor.processes[0].close();
    const completedCompact = claudeTransport.execute(requestFor(claudeAdapter, "compact", {
      processId: claudeStart.bindingPatch.native.processId,
      sessionId: "claude-session-1",
    }, { binding: claudeBinding }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(claudeExecutor.processes.length, 2);
    assert.ok(claudeExecutor.spawns[1].args.includes("--resume"));
    assert.ok(claudeExecutor.spawns[1].args.includes("claude-session-1"));
    assert.equal(claudeExecutor.processes[1].writes[0].message.content[0].text, "/compact");
    claudeExecutor.processes[1].queue.push(JSON.stringify({ type: "system", subtype: "compact_boundary", session_id: "claude-session-1" }));
    await completedCompact;
    assert.deepEqual(claudeExecutor.processes[1].signals, ["SIGTERM"]);
    const claudeProcessCount = claudeExecutor.processes.length;
    const claudeUsage = await claudeTransport.execute(requestFor(claudeAdapter, "contextUsage", {
      sessionId: "claude-session-1",
    }, { binding: claudeBinding }));
    assert.deepEqual(claudeUsage.contextUsage, { used: 42_000, limit: 180_000, remaining: 138_000, ratio: 42_000 / 180_000, source: "claude-code-current-request" });
    assert.equal(claudeExecutor.processes.length, claudeProcessCount, "读取用量不能向原生会话注入 /context");
    const poisonedUsage = await claudeTransport.execute(requestFor(claudeAdapter, "contextUsage", {
      sessionId: "claude-session-1",
    }, {
      binding: binding(claudeAdapter, {
        native: { sessionId: "claude-session-1" },
        state: claudeAdapter.createState({ contextUsage: { used: 115_000, limit: 200_000, ratio: 0.575, source: "claude-code-/context" } }),
      }),
    }));
    assert.equal(poisonedUsage.contextUsage, null, "非原生用量探针结果不能作为真实用量显示");
    const aggregateUsage = await claudeTransport.execute(requestFor(claudeAdapter, "contextUsage", {
      sessionId: "claude-session-1",
    }, {
      binding: binding(claudeAdapter, {
        native: { sessionId: "claude-session-1" },
        state: claudeAdapter.createState({ contextUsage: { used: 182_113, limit: 200_000, ratio: 0.91 } }),
      }),
    }));
    assert.equal(aggregateUsage.contextUsage, null, "累计 result usage 不能作为当前窗口显示");
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
