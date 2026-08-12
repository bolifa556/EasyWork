import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";

import { createGatewayServer } from "../gateway/core/server.mjs";
import { SshRemoteFiles } from "../gateway/core/runtime/remote.mjs";

function missing() {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function memoryRemote() {
  const files = new Map();
  const directories = new Set(["/", "/work", "/work/root"]);
  const symlinks = new Map();
  const exists = (candidate) => files.has(candidate) || directories.has(candidate) || symlinks.has(candidate);
  const attributes = (candidate) => ({
    size: files.get(candidate)?.length || 0,
    mtime: 1_780_000_000,
    mode: directories.has(candidate) ? 0o040700 : symlinks.has(candidate) ? 0o120777 : 0o100600,
    isDirectory: () => directories.has(candidate),
    isSymbolicLink: () => symlinks.has(candidate),
  });
  const children = (directory) => {
    const prefix = directory === "/" ? "/" : `${directory}/`;
    const names = new Set();
    for (const candidate of [...directories, ...files.keys(), ...symlinks.keys()]) {
      if (candidate === directory || !candidate.startsWith(prefix)) continue;
      const suffix = candidate.slice(prefix.length);
      if (suffix && !suffix.includes("/")) names.add(suffix);
    }
    return [...names].map((filename) => ({ filename, attrs: attributes(`${prefix}${filename}`) }));
  };
  const move = (from, to) => {
    if (files.has(from)) {
      files.set(to, files.get(from));
      files.delete(from);
      return;
    }
    if (symlinks.has(from)) {
      symlinks.set(to, symlinks.get(from));
      symlinks.delete(from);
      return;
    }
    if (!directories.has(from)) throw missing();
    const directoryEntries = [...directories].filter((entry) => entry === from || entry.startsWith(`${from}/`));
    const fileEntries = [...files.entries()].filter(([entry]) => entry.startsWith(`${from}/`));
    const linkEntries = [...symlinks.entries()].filter(([entry]) => entry.startsWith(`${from}/`));
    for (const entry of directoryEntries) directories.delete(entry);
    for (const [entry] of fileEntries) files.delete(entry);
    for (const [entry] of linkEntries) symlinks.delete(entry);
    for (const entry of directoryEntries) directories.add(`${to}${entry.slice(from.length)}`);
    for (const [entry, bytes] of fileEntries) files.set(`${to}${entry.slice(from.length)}`, bytes);
    for (const [entry, target] of linkEntries) symlinks.set(`${to}${entry.slice(from.length)}`, target);
  };
  const sftp = {
    lstat(candidate, callback) { callback(exists(candidate) ? null : missing(), exists(candidate) ? attributes(candidate) : undefined); },
    readdir(candidate, callback) { callback(directories.has(candidate) ? null : missing(), directories.has(candidate) ? children(candidate) : undefined); },
    mkdir(candidate, _options, callback) {
      if (!directories.has(candidate.substring(0, candidate.lastIndexOf("/")) || "/")) return callback(missing());
      if (exists(candidate)) return callback(Object.assign(new Error("exists"), { code: "EEXIST" }));
      directories.add(candidate);
      callback(null);
    },
    rename(from, to, callback) {
      try {
        if (!exists(from)) throw missing();
        if (exists(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
        move(from, to);
        callback(null);
      } catch (error) { callback(error); }
    },
    unlink(candidate, callback) {
      if (files.delete(candidate) || symlinks.delete(candidate)) callback(null);
      else callback(missing());
    },
    rmdir(candidate, callback) {
      if (!directories.has(candidate)) return callback(missing());
      if (children(candidate).length) return callback(Object.assign(new Error("not empty"), { code: "ENOTEMPTY" }));
      directories.delete(candidate);
      callback(null);
    },
    createWriteStream(candidate) {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        final(callback) { files.set(candidate, Buffer.concat(chunks)); callback(); },
      });
    },
    createReadStream(candidate, options = {}) {
      if (!files.has(candidate)) return Readable.from((async function* fail() { throw missing(); })());
      const bytes = files.get(candidate);
      return Readable.from(bytes.subarray(options.start || 0, options.end == null ? bytes.length : options.end + 1));
    },
    end() {},
  };
  const canonical = (candidate) => {
    let resolved = candidate;
    for (const [link, target] of symlinks) {
      if (resolved === link || resolved.startsWith(`${link}/`)) resolved = `${target}${resolved.slice(link.length)}`;
    }
    return exists(candidate) || exists(resolved) ? resolved : null;
  };
  const executor = {
    async withSftp(operation) { return operation(sftp); },
    openReadStream(candidate, options) { return sftp.createReadStream(candidate, options); },
    async exec(command) {
      if (command.startsWith("readlink -f --")) {
        const candidate = command.slice("readlink -f --".length).trim().replace(/^'|'$/g, "");
        const resolved = canonical(candidate);
        return { code: resolved ? 0 : 1, stdout: resolved ? `${resolved}\n` : "", stderr: "" };
      }
      if (command.startsWith("sha256sum --")) {
        const candidate = command.match(/sha256sum -- '([^']+)'/)?.[1];
        return files.has(candidate)
          ? { code: 0, stdout: `${crypto.createHash("sha256").update(files.get(candidate)).digest("hex")}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { files, directories, symlinks, executor };
}

function remoteFilesFixture(actorId = "alice") {
  const remote = memoryRemote();
  const workspace = {
    id: "workspace_a",
    actorId: "alice",
    serverIdentity: "ssh_identity_a",
    canonicalPath: "/work/root",
  };
  const container = {
    actor: { actorId },
    async workspaceFor() { return { async getWorkspace() { return workspace; } }; },
  };
  const service = new SshRemoteFiles({
    executor: remote.executor,
    container,
    serverId: "server_a",
    serverIdentity: "ssh_identity_a",
    limits: { maxUploadBytes: 8 * 1024 * 1024, maxDownloadBytes: 8 * 1024 * 1024 },
  });
  return { ...remote, workspace, service };
}

test("Remote Files streams files larger than 2 MB and serves exact byte ranges", async () => {
  const fixture = remoteFilesFixture();
  await fixture.service.mkdir({ workspaceId: fixture.workspace.id, path: "datasets" });
  const original = crypto.randomBytes(2 * 1024 * 1024 + 333);
  const sha256 = crypto.createHash("sha256").update(original).digest("hex");
  const uploaded = await fixture.service.uploadStream({
    workspaceId: fixture.workspace.id,
    path: "datasets/sample.bin",
    source: Readable.from(original),
    expectedSize: original.length,
    expectedSha256: sha256,
  });
  assert.deepEqual({ size: uploaded.size, sha256: uploaded.sha256 }, { size: original.length, sha256 });
  assert.deepEqual(fixture.files.get("/work/root/datasets/sample.bin"), original);
  const descriptor = await fixture.service.inspectDownload({ workspaceId: fixture.workspace.id, path: "datasets/sample.bin" });
  const chunks = [];
  for await (const chunk of fixture.service.openDownloadStream(descriptor, { start: 1024, endExclusive: 8193 })) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), original.subarray(1024, 8193));
});

test("Remote Files rejects traversal, symlink targets, hash mismatches, and foreign Actor workspaces", async () => {
  const fixture = remoteFilesFixture();
  fixture.symlinks.set("/work/root/outside", "/etc/passwd");
  await assert.rejects(() => fixture.service.list({ workspaceId: fixture.workspace.id, path: "../outside" }), (error) => error?.code === "REMOTE_PATH_INVALID");
  await assert.rejects(() => fixture.service.inspectDownload({ workspaceId: fixture.workspace.id, path: "outside" }), (error) => error?.code === "REMOTE_FILE_SYMLINK_FORBIDDEN");
  await assert.rejects(() => fixture.service.uploadStream({
    workspaceId: fixture.workspace.id,
    path: "bad.bin",
    source: Readable.from(Buffer.from("payload")),
    expectedSize: 7,
    expectedSha256: "0".repeat(64),
  }), (error) => error?.code === "REMOTE_FILE_HASH_MISMATCH");
  const foreign = remoteFilesFixture("mallory");
  await assert.rejects(() => foreign.service.list({ workspaceId: foreign.workspace.id, path: "" }), (error) => error?.code === "REMOTE_FILE_WORKSPACE_FORBIDDEN");
});

test("Remote Files creates, renames, and explicitly deletes workspace-scoped entries", async () => {
  const fixture = remoteFilesFixture();
  await fixture.service.mkdir({ workspaceId: fixture.workspace.id, path: "results" });
  assert.equal(fixture.directories.has("/work/root/results"), true);
  await fixture.service.uploadStream({
    workspaceId: fixture.workspace.id,
    path: "results/report.txt",
    source: Readable.from(Buffer.from("ready")),
    expectedSize: 5,
  });
  await fixture.service.rename({ workspaceId: fixture.workspace.id, path: "results/report.txt", destination: "results/final.txt" });
  assert.equal(fixture.files.get("/work/root/results/final.txt").toString(), "ready");
  await assert.rejects(() => fixture.service.delete({ workspaceId: fixture.workspace.id, path: "results", recursive: true, confirmation: "wrong" }), (error) => error?.code === "REMOTE_FILE_DELETE_CONFIRMATION_REQUIRED");
  await fixture.service.delete({ workspaceId: fixture.workspace.id, path: "results", recursive: true, confirmation: "results" });
  assert.equal(fixture.directories.has("/work/root/results"), false);
  assert.equal(fixture.files.has("/work/root/results/final.txt"), false);
});

test("Bearer HTTP endpoints keep raw bytes out of JSON and enforce Actor ownership", async (t) => {
  const fixture = remoteFilesFixture();
  const audits = [];
  const actors = {
    owner: { actorType: "user", actorId: "alice" },
    intruder: { actorType: "user", actorId: "mallory" },
  };
  const runtime = {
    allowedOrigins: [],
    auth: { async resolveSession(token) { assert.ok(actors[token]); return { actor: actors[token] }; } },
    async servicesForActor(actor) {
      return {
        audit: { async append(event) { audits.push({ actorId: actor.actorId, ...event }); } },
        async remoteBackend() {
          return actor.actorId === "alice" ? { remoteFiles: fixture.service } : {
            remoteFiles: new SshRemoteFiles({
              executor: fixture.executor,
              container: { actor, async workspaceFor() { return { async getWorkspace() { return fixture.workspace; } }; } },
              serverId: "server_a",
              serverIdentity: "ssh_identity_a",
              limits: { maxUploadBytes: 8 * 1024 * 1024, maxDownloadBytes: 8 * 1024 * 1024 },
            }),
          };
        },
      };
    },
    createApi() { return { async dispatch() { return { status: 404, headers: { "content-type": "application/json" }, body: { error: { code: "ROUTE_NOT_FOUND", message: "not found" } } }; } }; },
    createRealtimeServer() { return { attach() {} }; },
  };
  const gateway = await createGatewayServer({ runtime });
  const address = await gateway.start();
  t.after(() => gateway.close());
  const base = `http://${address.host}:${address.port}/api/servers/server_a/workspaces/workspace_a/files/content`;
  const original = crypto.randomBytes(2 * 1024 * 1024 + 19);
  const sha256 = crypto.createHash("sha256").update(original).digest("hex");
  const upload = await fetch(`${base}?path=${encodeURIComponent("large.bin")}&size=${original.length}`, {
    method: "PUT",
    headers: { authorization: "Bearer owner", "idempotency-key": "upload-a", "x-content-sha256": sha256, "content-type": "application/octet-stream" },
    body: original,
  });
  assert.equal(upload.status, 200);
  const uploadPayload = await upload.json();
  assert.equal(uploadPayload.data.sha256, sha256);
  assert.equal(JSON.stringify(uploadPayload).includes(original.toString("base64").slice(0, 40)), false);
  const range = await fetch(`${base}?path=${encodeURIComponent("large.bin")}`, { headers: { authorization: "Bearer owner", range: "bytes=100-999" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 100-999/${original.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), original.subarray(100, 1000));
  const forbidden = await fetch(`${base}?path=${encodeURIComponent("large.bin")}`, { headers: { authorization: "Bearer intruder" } });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(audits.filter((entry) => entry.actorId === "alice").map((entry) => `${entry.action}:${entry.status}`), [
    "remote-file.upload:attempted",
    "remote-file.upload:success",
    "remote-file.download:attempted",
    "remote-file.download:success",
  ]);
  assert.equal(JSON.stringify(audits).includes("large.bin"), true);
  assert.equal(JSON.stringify(audits).includes("/work/root"), false);
  assert.deepEqual(audits.filter((entry) => entry.actorId === "mallory").map((entry) => `${entry.action}:${entry.status}`), [
    "remote-file.download:attempted",
    "remote-file.download:failure",
  ]);
});
