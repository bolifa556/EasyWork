import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { createActorContext } from "../gateway/core/actor.mjs";
import {
  MemoryPreviewSessionStore,
  PreviewService,
} from "../gateway/core/previews/index.mjs";
import { createGatewayServer } from "../gateway/core/server.mjs";

function actor(actorId = "preview_user", actorType = "user") {
  return createActorContext({
    actorType,
    actorId,
    sessionId: `session_${actorId}`,
    deviceId: `device_${actorId}`,
    roles: [],
  });
}

function mutableClock(initial = "2026-08-10T00:00:00.000Z") {
  let value = initial;
  return {
    clock: () => new Date(value),
    set(next) { value = next; },
  };
}

function hostProvider(entries, releases = []) {
  return {
    async inspect({ sourceId }) {
      const entry = entries[sourceId];
      if (!entry) return { authorized: false };
      return {
        authorized: true,
        size: entry.content.length,
        name: entry.name,
        mime: entry.mime,
        supportsRange: entry.supportsRange !== false,
        metadata: entry.metadata || {},
      };
    },
    async openReadStream({ sourceId, range }) {
      const entry = entries[sourceId];
      return Readable.from([entry.content.subarray(range.start, range.endExclusive)]);
    },
    async release(input) {
      releases.push(input);
    },
  };
}

function entry(name, mime, content, metadata) {
  return { name, mime, content: Buffer.isBuffer(content) ? content : Buffer.from(content), metadata };
}

async function streamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function streamText(stream) {
  return (await streamBuffer(stream)).toString("utf8");
}

test("descriptor clean-break 支持七类 viewer，公开值只含 opaque previewId 与有界 metadata", async () => {
  const entries = {
    text_a: entry("notes.txt", "text/plain", "plain"),
    markdown_a: entry("README.md", "text/markdown", "# heading"),
    json_a: entry("data.json", "application/json", '{"ok":true}'),
    image_a: entry("image.png", "image/png", Buffer.from([1, 2, 3])),
    pdf_a: entry("paper.pdf", "application/pdf", Buffer.from("%PDF")),
    csv_a: entry("table.csv", "text/csv", "a,b\n1,2\n"),
    fallback_a: entry("blob.bin", "application/octet-stream", Buffer.from([4, 5]), { source: "generated" }),
  };
  const service = new PreviewService({ actor: actor(), hostSource: hostProvider(entries) });
  const expected = ["text", "markdown", "json", "image", "pdf", "csv", "fallback"];
  for (const [index, sourceId] of Object.keys(entries).entries()) {
    const descriptor = await service.create({ source: { kind: "host", sourceId } });
    assert.equal(descriptor.kind, expected[index]);
    assert.match(descriptor.previewId, /^preview_[A-Za-z0-9_-]{16,}$/);
    assert.equal(descriptor.delivery.endpoint, `/api/previews/${descriptor.previewId}/content`);
    assert.equal(JSON.stringify(descriptor).includes(sourceId), false);
    assert.equal(Object.hasOwn(descriptor, "path"), false);
    assert.deepEqual(service.head({ previewId: descriptor.previewId }).descriptor, descriptor);
  }
});

test("Actor 隔离隐藏 preview 是否存在，浏览器无法通过 descriptor 推断 host source", async () => {
  const store = new MemoryPreviewSessionStore();
  const entries = { private_a: entry("private.txt", "text/plain", "owner only") };
  const owner = new PreviewService({ actor: actor("owner"), store, hostSource: hostProvider(entries) });
  const other = new PreviewService({ actor: actor("other"), store, hostSource: hostProvider(entries) });
  const descriptor = await owner.create({ source: { kind: "host", sourceId: "private_a" } });
  await assert.rejects(async () => other.get({ previewId: descriptor.previewId }), (error) => error?.code === "PREVIEW_NOT_FOUND" && error?.status === 404);
  await assert.rejects(() => other.openContent({ previewId: descriptor.previewId }), (error) => error?.code === "PREVIEW_NOT_FOUND");
  assert.equal((await streamText((await owner.openContent({ previewId: descriptor.previewId })).stream)), "owner only");
});

test("remote 只接受无 traversal 的工作区相对路径，并强制 inspector 验证 realpath、symlink 与作用域", async () => {
  const opened = [];
  const remoteSource = {
    async inspect(input) {
      if (input.relativePath === "unsafe.txt") {
        return { authorized: true, resolved: true, withinAllowedRoot: false, symlinkSafe: false };
      }
      return {
        authorized: true,
        resolved: true,
        withinAllowedRoot: true,
        symlinkSafe: true,
        canonicalPath: "/srv/work/docs/report.txt",
        serverIdentity: input.serverIdentity,
        workspaceId: input.workspaceId,
        size: 6,
        name: "report.txt",
        mime: "text/plain",
        metadata: { version: 2 },
      };
    },
    async openReadStream(input) {
      opened.push(input);
      return Readable.from([Buffer.from("remote").subarray(input.range.start, input.range.endExclusive)]);
    },
  };
  const service = new PreviewService({ actor: actor(), remoteSource });
  for (const relativePath of ["/etc/passwd", "../secret", "folder/../../secret", "C:/secret", "folder\\secret"]) {
    await assert.rejects(() => service.create({
      source: { kind: "remote", serverIdentity: "server_a", workspaceId: "workspace_a", relativePath },
    }), (error) => error?.code === "PREVIEW_REMOTE_PATH_FORBIDDEN");
  }
  await assert.rejects(() => service.create({
    source: { kind: "remote", serverIdentity: "server_a", workspaceId: "workspace_a", relativePath: "unsafe.txt" },
  }), (error) => error?.code === "PREVIEW_REMOTE_PATH_FORBIDDEN");
  const descriptor = await service.create({
    source: { kind: "remote", serverIdentity: "server_a", workspaceId: "workspace_a", relativePath: "docs/report.txt" },
  });
  assert.equal(JSON.stringify(descriptor).includes("/srv/work"), false);
  assert.equal(await streamText((await service.openContent({ previewId: descriptor.previewId })).stream), "remote");
  assert.equal(opened[0].canonicalPath, "/srv/work/docs/report.txt");
  assert.equal(Object.hasOwn(opened[0], "relativePath"), false);
  await assert.rejects(() => service.create({ source: { kind: "remote", serverIdentity: "server_a", workspaceId: "workspace_a", relativePath: "ok", canonicalPath: "/etc/passwd" } }), (error) => error?.code === "PREVIEW_INPUT_UNKNOWN_FIELD");
});

test("metadata、来源大小、JSON 与单次 Range 各自有独立上限，大二进制不被 base64 或全量缓冲", async () => {
  const entries = {
    metadata_a: entry("meta.txt", "text/plain", "x", { huge: "x".repeat(128) }),
    private_metadata_a: entry("private.txt", "text/plain", "x", { canonical_path: "/private/source" }),
    huge_a: entry("huge.bin", "application/octet-stream", Buffer.alloc(65_536, 7)),
    json_a: entry("huge.json", "application/json", JSON.stringify({ value: "x".repeat(128) })),
  };
  const provider = hostProvider(entries);
  const metadataService = new PreviewService({ actor: actor(), hostSource: provider, maxMetadataBytes: 32 });
  await assert.rejects(() => metadataService.create({ source: { kind: "host", sourceId: "metadata_a" } }), (error) => error?.code === "PREVIEW_METADATA_TOO_LARGE");
  const privateMetadataService = new PreviewService({ actor: actor(), hostSource: provider });
  await assert.rejects(() => privateMetadataService.create({ source: { kind: "host", sourceId: "private_metadata_a" } }), (error) => error?.code === "PREVIEW_METADATA_PRIVATE_FIELD");
  const sizeService = new PreviewService({ actor: actor(), hostSource: provider, maxSourceBytes: 1024 });
  await assert.rejects(() => sizeService.create({ source: { kind: "host", sourceId: "huge_a" } }), (error) => error?.code === "PREVIEW_SOURCE_SIZE_INVALID");

  const service = new PreviewService({ actor: actor(), hostSource: provider, maxJsonBytes: 32, maxRangeBytes: 16 });
  const json = await service.create({ source: { kind: "host", sourceId: "json_a" } });
  await assert.rejects(() => service.openContent({ previewId: json.previewId }), (error) => error?.code === "PREVIEW_CONTENT_TOO_LARGE");
  const binary = await service.create({ source: { kind: "host", sourceId: "huge_a" } });
  assert.equal(binary.delivery.mode, "stream");
  assert.equal(JSON.stringify(binary).includes(Buffer.alloc(12, 7).toString("base64")), false);
  await assert.rejects(() => service.openContent({ previewId: binary.previewId, range: { start: 0, endExclusive: 17 } }), (error) => error?.code === "PREVIEW_RANGE_TOO_LARGE");
  await assert.rejects(() => service.openContent({ previewId: binary.previewId }), (error) => error?.code === "PREVIEW_RANGE_REQUIRED");
});

test("UTF-8 文本按字符安全截断，CSV 只返回有限记录且不拆开引号内换行", async () => {
  const utf8 = Buffer.from("甲乙🙂丙丁", "utf8");
  const csv = Buffer.from('name,value\n"multi\nline",1\nthird,3\nfourth,4\n', "utf8");
  const entries = {
    utf8_a: entry("unicode.txt", "text/plain", utf8),
    csv_a: entry("rows.csv", "text/csv", csv),
  };
  const service = new PreviewService({
    actor: actor(),
    hostSource: hostProvider(entries),
    maxTextBytes: 7,
    maxCsvBytes: 1024,
    maxCsvRows: 2,
  });
  const textDescriptor = await service.create({ source: { kind: "host", sourceId: "utf8_a" } });
  const text = await service.openContent({ previewId: textDescriptor.previewId });
  assert.equal(text.truncated, true);
  assert.equal(await streamText(text.stream), "甲乙");

  const csvDescriptor = await service.create({ source: { kind: "host", sourceId: "csv_a" } });
  const csvResult = await service.openContent({ previewId: csvDescriptor.previewId });
  assert.equal(csvResult.rows, 2);
  assert.equal(csvResult.truncated, true);
  assert.equal(await streamText(csvResult.stream), 'name,value\n"multi\nline",1\n');
});

test("image/pdf/fallback 使用严格 Range 流，非法或不满足长度的 provider 被拒绝", async () => {
  const entries = { image_a: entry("image.png", "image/png", Buffer.from("0123456789")) };
  const service = new PreviewService({ actor: actor(), hostSource: hostProvider(entries), maxRangeBytes: 8 });
  const descriptor = await service.create({ source: { kind: "host", sourceId: "image_a" } });
  const ranged = await service.openContent({ previewId: descriptor.previewId, range: { start: 2, endExclusive: 6 } });
  assert.equal(ranged.contentLength, 4);
  assert.deepEqual(ranged.contentRange, { start: 2, endExclusive: 6, total: 10 });
  assert.equal(await streamText(ranged.stream), "2345");
  await assert.rejects(() => service.openContent({ previewId: descriptor.previewId, range: { start: -1, endExclusive: 3 } }), (error) => error?.code === "PREVIEW_RANGE_INVALID");
  await assert.rejects(() => service.openContent({ previewId: descriptor.previewId, range: { start: 1, endExclusive: 99 } }), (error) => error?.code === "PREVIEW_RANGE_INVALID");

  const bad = new PreviewService({
    actor: actor("bad_stream"),
    hostSource: {
      async inspect() { return { authorized: true, size: 4, name: "bad.png", mime: "image/png" }; },
      async openReadStream() { return Readable.from([Buffer.from("too long")]); },
    },
  });
  const badDescriptor = await bad.create({ source: { kind: "host", sourceId: "bad_a" } });
  await assert.rejects(async () => {
    const opened = await bad.openContent({ previewId: badDescriptor.previewId });
    await streamBuffer(opened.stream);
  }, (error) => error?.code === "PREVIEW_STREAM_LENGTH_MISMATCH");
});

test("Preview TTL、revision、close 与 expire 都释放 provider 和活动流", async () => {
  const time = mutableClock();
  const releases = [];
  const entries = { session_a: entry("session.bin", "application/octet-stream", "abcd") };
  const store = new MemoryPreviewSessionStore();
  const service = new PreviewService({ actor: actor(), store, clock: time.clock, hostSource: hostProvider(entries, releases), ttlMs: 1000, maxTtlMs: 5000 });
  const descriptor = await service.create({ source: { kind: "host", sourceId: "session_a" } });
  assert.equal(descriptor.revision, 0);
  const renewed = await service.renew({ previewId: descriptor.previewId, expectedRevision: 0, ttlMs: 3000 });
  assert.equal(renewed.revision, 1);
  await assert.rejects(() => service.renew({ previewId: descriptor.previewId, expectedRevision: 0 }), (error) => error?.code === "REVISION_CONFLICT");
  const closed = await service.close({ previewId: descriptor.previewId, expectedRevision: 1 });
  assert.deepEqual(closed, { previewId: descriptor.previewId, revision: 2, closed: true });
  assert.equal(releases.at(-1).reason, "closed");
  assert.equal(store.size, 0);

  const expiring = await service.create({ source: { kind: "host", sourceId: "session_a" }, ttlMs: 1000 });
  time.set("2026-08-10T00:00:02.000Z");
  const expired = await service.expireDue();
  assert.deepEqual(expired.expiredPreviewIds, [expiring.previewId]);
  assert.equal(releases.at(-1).reason, "expired");
  await assert.rejects(async () => service.get({ previewId: expiring.previewId }), (error) => error?.code === "PREVIEW_NOT_FOUND");
});

test("host source 只接受受控 sourceId，不接受路径、内联 Buffer 或任意 callback", async () => {
  const service = new PreviewService({ actor: actor(), hostSource: hostProvider({ safe_a: entry("safe.txt", "text/plain", "safe") }) });
  const forbiddenInputs = [
    { kind: "host", sourceId: "safe_a", path: "C:/Windows/System32/config/SAM" },
    { kind: "host", sourceId: "safe_a", content: "inline" },
    { kind: "host", sourceId: "safe_a", openReadStream() {} },
  ];
  for (const source of forbiddenInputs) {
    await assert.rejects(() => service.create({ source }), (error) => error?.code === "PREVIEW_INPUT_UNKNOWN_FIELD");
  }
});

test("runtime HTTP 接入 create/get/head/content Range/renew/close，并隔离 Actor 与远端规范路径", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "easywork-preview-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, "data");
  const helpFile = path.join(root, "help.md");
  await fs.writeFile(helpFile, "# Help\n", "utf8");
  const hostBytes = Buffer.from("0123456789", "utf8");
  const remoteBytes = Buffer.from("remote small file", "utf8");
  const gateway = await createGatewayServer({
    runtimeOptions: {
      dataRoot,
      helpFile,
      previewLimits: { maxRangeBytes: 8 },
      previewHostSourceFactory: async ({ actor: currentActor }) => ({
        async inspect({ sourceId }) {
          return sourceId === "host_document" ? {
            authorized: true,
            size: hostBytes.length,
            name: "document.bin",
            mime: "application/octet-stream",
            metadata: { owner: currentActor.actorId },
          } : { authorized: false };
        },
        async openReadStream({ range }) {
          return Readable.from([hostBytes.subarray(range.start, range.endExclusive)]);
        },
      }),
      previewRemoteSourceFactory: async () => ({
        async inspect(input) {
          return {
            authorized: true,
            resolved: true,
            withinAllowedRoot: true,
            symlinkSafe: true,
            canonicalPath: `/srv/private/work/${input.relativePath}`,
            serverIdentity: input.serverIdentity,
            workspaceId: input.workspaceId,
            size: remoteBytes.length,
            name: "remote.txt",
            mime: "text/plain",
            metadata: {},
          };
        },
        async openReadStream({ range }) {
          return Readable.from([remoteBytes.subarray(range.start, range.endExclusive)]);
        },
      }),
    },
  });
  t.after(() => gateway.close());
  const address = await gateway.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const json = async (pathname, { token, method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, payload: response.status === 204 ? null : await response.json() };
  };
  const register = async (username) => (await json("/api/auth/register", {
    method: "POST",
    body: { username, password: "preview-password", deviceId: `device-${username}` },
  })).payload.data.token;
  const ownerToken = await register("preview-owner");
  const otherToken = await register("preview-other");

  const created = await json("/api/previews", {
    token: ownerToken,
    method: "POST",
    body: { source: { kind: "host", sourceId: "host_document" }, ttlMs: 30_000 },
  });
  assert.equal(created.response.status, 200);
  const descriptor = created.payload.data;
  assert.equal(descriptor.kind, "fallback");
  assert.equal(JSON.stringify(descriptor).includes("host_document"), false);
  assert.equal(JSON.stringify(descriptor).includes("document.bin"), true);

  const fetched = await json(`/api/previews/${descriptor.previewId}`, { token: ownerToken });
  assert.deepEqual(fetched.payload.data, descriptor);
  const forbidden = await json(`/api/previews/${descriptor.previewId}`, { token: otherToken });
  assert.equal(forbidden.response.status, 404);
  const forbiddenContent = await fetch(`${baseUrl}/api/previews/${descriptor.previewId}/content`, { headers: { authorization: `Bearer ${otherToken}` } });
  assert.equal(forbiddenContent.status, 404);
  const anonymousContent = await fetch(`${baseUrl}/api/previews/${descriptor.previewId}/content`);
  assert.equal(anonymousContent.status, 401);

  const head = await fetch(`${baseUrl}/api/previews/${descriptor.previewId}/content`, {
    method: "HEAD",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(hostBytes.length));
  assert.equal(head.headers.get("x-preview-revision"), "0");
  const range = await fetch(`${baseUrl}/api/previews/${descriptor.previewId}/content`, {
    headers: { authorization: `Bearer ${ownerToken}`, range: "bytes=2-5" },
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await range.text(), "2345");

  const renewed = await json(`/api/previews/${descriptor.previewId}`, {
    token: ownerToken,
    method: "PATCH",
    headers: { "if-match": '"0"' },
    body: { ttlMs: 60_000 },
  });
  assert.equal(renewed.payload.data.revision, 1);

  const ownerSession = await gateway.runtime.auth.resolveSession(ownerToken);
  const ownerServices = await gateway.runtime.servicesForActor(ownerSession.actor);
  await ownerServices.servers.create({
    id: "server_preview",
    name: "Preview server",
    host: "127.0.0.1",
    port: 22,
    username: "preview",
    authMethod: "password",
    credential: { password: "test-only" },
  });
  await ownerServices.servers.setFingerprint("server_preview", "SHA256:preview-test-fingerprint");
  const remote = await json("/api/previews", {
    token: ownerToken,
    method: "POST",
    body: { source: { kind: "remote", serverId: "server_preview", workspaceId: "workspace_preview", relativePath: "folder/remote.txt" } },
  });
  assert.equal(remote.response.status, 200);
  assert.equal(remote.payload.data.kind, "text");
  assert.equal(JSON.stringify(remote.payload).includes("/srv/private"), false);
  assert.equal(JSON.stringify(remote.payload).includes("folder/remote.txt"), false);
  const remoteContent = await fetch(`${baseUrl}/api/previews/${remote.payload.data.previewId}/content`, { headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(remoteContent.status, 200);
  assert.equal(await remoteContent.text(), "remote small file");

  const closed = await json(`/api/previews/${descriptor.previewId}`, {
    token: ownerToken,
    method: "DELETE",
    headers: { "if-match": '"1"' },
  });
  assert.equal(closed.payload.data.closed, true);
  const afterClose = await json(`/api/previews/${descriptor.previewId}`, { token: ownerToken });
  assert.equal(afterClose.response.status, 404);
});
