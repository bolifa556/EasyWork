import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { StartupPrefetch } from "../app/core/gateway/startup-prefetch.ts";
import { startupDestination } from "../app/easywork/runtime/startup-route.ts";
import { builtAssetHandler, precompressClient } from "../scripts/static-assets.mjs";
import { createGatewayServer } from "../gateway/core/server.mjs";

test("home renders without a conversation navigation snapshot; project conversations use the matching summary", async () => {
  const source = await fs.readFile(new URL("../app/easywork/features/conversation/ConversationView.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  const bootstrapSummary =");
  const end = source.indexOf(";", start);
  const code = ts.transpileModule(source.slice(start, end + 1), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const summary = new Function("runtime", "conversationId", `${code}; return bootstrapSummary;`);
  assert.equal(summary({ bootstrap: null }, undefined), undefined);
  assert.equal(summary({ bootstrap: { recentConversations: [] } }, undefined), undefined);
  const active = { id: "conv_old", projectId: "project_old" };
  const runtime = { bootstrap: { recentConversations: [], conversationNavigation: { conversationId: active.id, conversation: active } } };
  assert.equal(summary(runtime, "conv_old"), active);
  assert.equal(summary(runtime, "conv_other"), undefined);
});

test("first devices open help; repeat entry opens home; intentional deep links survive", () => {
  for (const url of ["/", "/help", "/c/conv_first", "/servers"]) assert.equal(startupDestination(url, "", true, false), "/help");
  assert.equal(startupDestination("/", "", false, false), "/");
  assert.equal(startupDestination("/help", "", false, true), "/");
  assert.equal(startupDestination("/help", "", false, false), "/help");
  assert.equal(startupDestination("/c/conv_old", "?message=msg_1", false, false), "/c/conv_old?message=msg_1");
  assert.equal(startupDestination("/c/conv_old", "", false, true), "/c/conv_old");
});

test("startup requests are deduplicated, single use, abortable and isolated across sessions", async () => {
  const cache = new StartupPrefetch();
  let resolve;
  let calls = 0;
  const request = () => { calls++; return new Promise((done) => { resolve = done; }); };
  cache.start("/page", "alice", request);
  cache.start("/page", "alice", request);
  assert.equal(calls, 1);
  const result = cache.take("/page", "alice");
  assert.equal(cache.take("/page", "alice"), undefined);
  resolve({ page: "alice" });
  assert.deepEqual(await result, { page: "alice" });
  cache.start("/page", "alice", () => Promise.resolve("private"));
  assert.equal(cache.take("/page", "bob"), undefined);
  cache.start("/page", "bob", request);
  const controller = new AbortController();
  const aborted = cache.take("/page", "bob", controller.signal);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  resolve("no longer displayed");
  cache.start("/page", "bob", () => Promise.resolve("before mutation"));
  cache.clear();
  assert.equal(cache.take("/page", "bob"), undefined);
  cache.start("/page", "bob", () => Promise.reject(new Error("offline")));
  await new Promise(setImmediate);
  assert.equal(cache.take("/page", "bob"), undefined);
  const realNow = Date.now;
  try {
    cache.start("/page", "bob", () => Promise.resolve("expired"));
    Date.now = () => realNow() + 16_000;
    assert.equal(cache.take("/page", "bob"), undefined);
  } finally { Date.now = realNow; }
});

test("built assets negotiate actual Brotli/gzip bytes with identity, HEAD, q=0 and stale-file fallbacks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "assets"));
  const content = Buffer.from("console.log('你好 EasyWork');\n".repeat(200));
  const file = path.join(root, "assets", "app-hash.js");
  await fs.writeFile(file, content);
  await precompressClient(root);
  const handler = builtAssetHandler(root);
  const server = http.createServer((req, res) => { void handler(req, res).then((served) => { if (!served) { res.writeHead(404); res.end(); } }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const read = (encoding, method = "GET", url = "/assets/app-hash.js") => new Promise((resolve, reject) => {
    http.request({ hostname: "127.0.0.1", port: server.address().port, path: url, method, headers: encoding === undefined ? {} : { "accept-encoding": encoding } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  for (const [accept, expected] of [["br, gzip", "br"], ["gzip", "gzip"], ["br;q=0, gzip;q=0.5", "gzip"], [undefined, undefined], ["identity", undefined], ["gzip;q=0", undefined], ["br;q=0.1,identity;q=1", undefined]]) {
    const result = await read(accept);
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-encoding"], expected);
    assert.equal(result.headers.vary, "Accept-Encoding");
    assert.match(result.headers["cache-control"], /immutable/);
    assert.equal(Number(result.headers["content-length"]), result.bytes.length);
    assert.deepEqual(expected === "br" ? brotliDecompressSync(result.bytes) : expected === "gzip" ? gunzipSync(result.bytes) : result.bytes, content);
  }
  const head = await read("gzip", "HEAD");
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal((await read("*;q=0")).status, 406);
  assert.equal((await read("gzip", "GET", "/%2e%2e%5csecret.js")).status, 404);
  assert.equal((await read("gzip", "GET", "/%ZZ")).status, 404);
  await fs.writeFile(file, "updated");
  const future = new Date(Date.now() + 1000);
  await fs.utimes(file, future, future);
  const stale = await read("br, gzip");
  assert.equal(stale.headers["content-encoding"], undefined);
  assert.equal(stale.bytes.toString(), "updated");
});

test("bootstrap includes the active project's page from one index and preserves pagination and account isolation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-startup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# 入门\n\n新设备帮助。\n");
  const gateway = await createGatewayServer({ runtimeOptions: { dataRoot: path.join(root, "data"), helpFile } });
  await gateway.start({ host: "127.0.0.1", port: 0 });
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const guest = await gateway.runtime.auth.createGuestSession({ deviceId: "startup-first" });
  const session = await gateway.runtime.auth.resolveSession(guest.token);
  const services = await gateway.runtime.servicesForActor(session.actor);
  const project = await services.projects.create({ name: "启动项目", commandId: "startup-project" });
  const ids = [];
  for (let index = 0; index < 7; index++) {
    const created = await services.baseConversations.sendMessage({ mode: "chat", projectId: project.id, role: "user", content: `第 ${index} 个问题`, expectedRevision: 0, commandId: `startup-${index}` });
    ids.push(created.conversation.id);
  }
  const get = async (url, token = guest.token) => {
    const response = await fetch(base + url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { response, body: response.status === 304 ? null : await response.json() };
  };
  const initial = await get(`/api/bootstrap?conversationId=${ids[0]}`);
  assert.equal(initial.response.status, 200);
  const boot = initial.body.data;
  assert.equal(boot.projects[0].conversationCount, 7);
  assert.equal(boot.recentConversations.length, 0);
  const nav = boot.conversationNavigation;
  assert.equal(nav.conversation.id, ids[0]);
  assert.equal(nav.projectConversations.items.length, 4);
  assert.ok(!nav.projectConversations.items.some((item) => item.id === ids[0]));
  assert.ok(!JSON.stringify(nav).includes("lastMessagePreview"));
  const next = await get(`/api/conversations?projectId=${project.id}&limit=4&cursor=${encodeURIComponent(nav.projectConversations.nextCursor)}`);
  assert.deepEqual(new Set([...nav.projectConversations.items, ...next.body.data.items].map((item) => item.id)), new Set(ids));
  assert.equal((await get("/api/bootstrap")).body.data.conversationNavigation, undefined);
  const other = await gateway.runtime.auth.createGuestSession({ deviceId: "startup-other" });
  const foreign = await get(`/api/bootstrap?conversationId=${ids[0]}`, other.token);
  assert.equal(foreign.body.data.conversationNavigation.conversation, null);
  assert.equal(foreign.body.data.conversationNavigation.projectConversations, null);
  await services.baseConversations.delete({ conversationId: ids[0], expectedRevision: 1, commandId: "startup-delete" });
  assert.equal((await get(`/api/bootstrap?conversationId=${ids[0]}`)).body.data.conversationNavigation.conversation, null);
  const help = await get("/api/help", null);
  assert.equal(help.response.status, 200);
  assert.equal(help.body.data.content, "# 入门\n\n新设备帮助。\n");
  assert.ok(help.body.data.etag);
  const cached = await fetch(base + "/api/help", { headers: { "if-none-match": help.body.data.etag } });
  assert.equal(cached.status, 304);
  assert.equal((await get("/api/bootstrap", null)).response.status, 401);
});
