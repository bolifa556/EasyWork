import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { renderPromptTemplate } from "../gateway/core/prompts/repository.mjs";
import { SshTerminalManager } from "../gateway/core/runtime/terminal.mjs";
import { ServerCapabilityService } from "../gateway/core/runtime/server-capabilities.mjs";
import { OpenAIEmbeddingAdapter } from "../gateway/core/resources/embedding-client.mjs";
import { SshRemoteFiles, SshSchedulerExecutor, WorkerBoundAgentExecutor } from "../gateway/core/runtime/remote.mjs";
import { PreviewService } from "../gateway/core/previews/index.mjs";
import { createActorContext } from "../gateway/core/actor.mjs";
import { createHostApiRelay } from "../gateway/core/ssh/api-reverse-proxy.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const actor = createActorContext({ actorType: "user", actorId: "audit_user", deviceId: "device", sessionId: "session", roles: [] });
const container = { actor, async workspaceFor() { return { async getWorkspace() { return { id: "audit-ws", actorId: actor.actorId, serverIdentity: "audit-ssh", canonicalPath: "/audit" }; } }; } };

test("template substitution never interprets inserted user data", () => {
  const text = "文档里的 {{API_KEY}} 和 {{USER_MESSAGE}} 是什么意思？";
  assert.equal(renderPromptTemplate("用户：{{USER_MESSAGE}}", { USER_MESSAGE: text }), `用户：${text}`);
  assert.throws(() => renderPromptTemplate("{{MISSING}}", {}), { code: "PROMPT_VARIABLE_REQUIRED" });
});

function terminal() {
  const worker = { async withSession(_id, operation) { return operation({ async openPty() {
    let closed;
    return { closed: false, onData() {}, onClose(fn) { closed = fn; }, async close() { this.closed = true; await closed?.(null, { code: 0 }); } };
  } }); } };
  return new SshTerminalManager({ worker, serverId: "audit", serverIdentity: "audit-ssh", broker: { async append() {} } });
}

test("terminal byte-sized SSH bursts preserve order and close without a journal write per byte", async () => {
  let emit, close;
  const events = [];
  const handle = { onData(fn) { emit=fn; }, onClose(fn) { close=fn; }, async close() { await close(null,{code:0}); } };
  const manager = new SshTerminalManager({ serverId:"audit", serverIdentity:"ssh-audit", worker:{ async withSession(_id,operation) { return operation({async openPty() { return handle; }}); } }, broker:{async append(_topic,event){events.push(event);}} });
  const session = await manager.create({scopeKey:"burst"});
  for(let i=0;i<12000;i++)emit({stream:"stdout",bytes:Buffer.from([65+i%26])});
  emit({stream:"stderr",bytes:Buffer.from("error-boundary")});
  emit({stream:"stdout",bytes:Buffer.from("tail")});
  await manager.close(session.sessionId);
  const output=events.filter(e=>e.kind==="terminal.output");
  assert.equal(output.length,3);
  assert.deepEqual(output.map(e=>e.payload.stream),["stdout","stderr","stdout"]);
  const expected=Buffer.concat([Buffer.from(Array.from({length:12000},(_,i)=>65+i%26)),Buffer.from("error-boundarytail")]);
  assert.deepEqual(Buffer.concat(output.map(e=>Buffer.from(e.payload.dataBase64,"base64"))),expected);
  assert.equal(events.at(-1).kind,"terminal.closed");
  assert.equal(manager.inspect(session.sessionId).status,"closed");
});

test("terminal limit counts pending and open sessions, with bounded closed history", async () => {
  const manager = terminal();
  for (let i = 0; i < 70; i += 1) { const created = await manager.create({ scopeKey: "audit" }); await manager.close(created.sessionId); }
  assert.ok(manager.sessions.size <= 32);
  const results = await Promise.allSettled(Array.from({ length: 33 }, () => manager.create({ scopeKey: "audit" })));
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 32);
  assert.equal(results.find((entry) => entry.status === "rejected").reason.code, "TERMINAL_SESSION_LIMIT");
  await manager.closeAll();
  assert.equal(manager.hasOpenSessions(), false);
  assert.equal((await manager.create({ scopeKey: "audit" })).status, "open");
  await manager.closeAll();
});

test("in-flight capability probes cannot cross connection generations", async () => {
  let server = { profile: { id: "audit", serverIdentity: "ssh_a" }, connection: { status: "connected", generation: 1 } };
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const service = new ServerCapabilityService({
    servers: { async get() { return structuredClone(server); } },
    async resolveRemoteBackend() { await waiting; return { remoteFiles: { list() {} } }; },
    async resolveScheduler() { return { async getCapabilities() { return { scheduler: "generic", features: {} }; } }; },
  });
  const old = service.get("audit");
  await tick();
  server = { ...server, connection: { status: "disconnected", generation: 2 } };
  const fresh = await service.get("audit");
  assert.equal(fresh.features.remoteFiles.available, false);
  finish();
  assert.equal((await old).features.remoteFiles.available, false);
  assert.equal((await service.peek("audit")).features.remoteFiles.available, false);
});

test("embedding batches reject duplicate indices, non-numeric values and dimension changes", async () => {
  for (const data of [
    [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }],
    [{ index: 0, embedding: [null, 2] }, { index: 1, embedding: [3, 4] }],
    [{ index: 0, embedding: ["1", 2] }, { index: 1, embedding: [3, 4] }],
    [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3] }],
  ]) {
    const adapter = new OpenAIEmbeddingAdapter({ baseUrl: "http://model.invalid", apiKey: "test", model: "test", dimensions: 2, fetchImpl: async () => ({ ok: true, json: async () => ({ data }) }) });
    await assert.rejects(() => adapter.embedTexts(["one", "two"]), { code: "EMBEDDING_RESPONSE_INVALID" });
  }
  const adapter = new OpenAIEmbeddingAdapter({ baseUrl: "http://model.invalid", apiKey: "test", model: "test", fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] }) }) });
  assert.deepEqual((await adapter.embedTexts(["one", "two"])).vectors, [[1, 2], [3, 4]]);
});

test("FIFO download is rejected before hashing", async () => {
  let hashCalls = 0;
  const executor = {
    async withSftp(operation) { return operation({ lstat(_path, callback) { callback(null, { size: 0, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false }); } }); },
    async exec(command) {
      if (command.startsWith("readlink")) return { code: 0, stdout: command.match(/'([^']+)'/)?.[1] + "\n" };
      hashCalls += 1;
      throw new Error("must not hash a FIFO");
    },
  };
  const files = new SshRemoteFiles({ executor, container, serverId: "audit", serverIdentity: "audit-ssh" });
  await assert.rejects(() => files.inspectDownload({ workspaceId: "audit-ws", path: "pipe" }), { code: "REMOTE_FILE_NOT_REGULAR" });
  assert.equal(hashCalls, 0);
});

test("download cancellation closes its source and releases a close-only SFTP operation", async () => {
  const source = new Readable({ read() {} });
  const files = new SshRemoteFiles({ executor: { openReadStream: () => source }, container, serverId: "audit", serverIdentity: "audit-ssh" });
  const download = files.openDownloadStream({ canonicalPath: "/audit/file", size: 100, sha256: "0".repeat(64) });
  download.destroy();
  await tick();
  assert.equal(source.destroyed, true);
  let released = false;
  let ended = false;
  const remote = new Readable({ read() {} });
  const bound = new WorkerBoundAgentExecutor({ serverId: "audit", worker: { async withSession(_id, operation) {
    try { return await operation({ async sftp() { return { createReadStream: () => remote, end() { ended = true; } }; } }); }
    finally { released = true; }
  } } });
  const output = bound.openReadStream("/audit/file");
  await tick();
  output.destroy();
  await tick();
  assert.equal(remote.destroyed, true);
  assert.equal(released, true);
  assert.equal(ended, true);
});

test("log range transfers only the requested bytes and one EOF lookahead", async () => {
  const calls = [];
  const scheduler = new SshSchedulerExecutor({ openReadStream(file, options) { calls.push({ file, ...options }); return Readable.from([Buffer.alloc(129, 65)]); } });
  const result = await scheduler.readRange({ path: "/audit/job.out", offset: 16 * 1024 * 1024, maxBytes: 128 });
  assert.deepEqual(calls, [{ file: "/audit/job.out", start: 16 * 1024 * 1024, end: 16 * 1024 * 1024 + 128 }]);
  assert.equal(result.bytes.length, 128);
  assert.equal(result.eof, false);
});

test("closing a preview cancels a stream that opens after close", async () => {
  let resolveStream;
  const raw = new Readable({ read() {} });
  const opening = new Promise((resolve) => { resolveStream = resolve; });
  const service = new PreviewService({ actor, hostSource: { async inspect() { return { authorized: true, size: 100, name: "audit.png", mime: "image/png" }; }, async openReadStream() { return opening; } } });
  const preview = await service.create({ source: { kind: "host", sourceId: "audit" } });
  const pending = service.openContent({ previewId: preview.previewId });
  await tick();
  await service.close({ previewId: preview.previewId });
  resolveStream(raw);
  await assert.rejects(() => pending, { code: "PREVIEW_EXPIRED" });
  assert.equal(raw.destroyed, true);
});

test("a disconnected SSE client cancels the upstream after the request body completed", async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstream = http.createServer((request, response) => {
    response.on("close", upstreamClosed);
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: first\n\n"); });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const relay = await createHostApiRelay({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "test" });
  t.after(() => relay.close());
  await new Promise((resolve, reject) => {
    const request = http.request({ host: relay.host, port: relay.port, path: relay.endpointPath + "/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      response.once("data", () => { response.destroy(); request.destroy(); resolve(); });
    });
    request.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
    request.end('{"stream":true}');
  });
  await closed;
});
