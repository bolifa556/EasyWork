import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { WebSocketServer } from "ws";

import { apiFailure, apiSuccess, invariant } from "./errors.mjs";
import { readNodeJson } from "./http/router.mjs";
import { createEasyWorkRuntime } from "./runtime/runtime.mjs";

function requestId(request) {
  return String(request.headers["x-request-id"] || `req_${crypto.randomUUID()}`);
}

function bearer(request) {
  const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || ""));
  invariant(match, "SESSION_TOKEN_REQUIRED", "缺少登录会话", { status: 401 });
  return match[1];
}

function corsHeaders(request, allowedOrigins) {
  const origin = String(request.headers.origin || "");
  if (origin && allowedOrigins.size) invariant(allowedOrigins.has(origin), "ORIGIN_FORBIDDEN", "请求来源不被允许", { status: 403 });
  return {
    ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key, Range, X-Content-Sha256, X-Request-Id",
    "access-control-expose-headers": "Accept-Ranges, Content-Length, Content-Range, ETag, Last-Modified, X-Content-Sha256, X-Preview-Revision, X-Preview-Source-Size, X-Preview-Truncated, X-Request-Id",
  };
}

function writeJson(response, result, cors = {}) {
  response.writeHead(result.status, { ...result.headers, ...cors });
  response.end(result.body === undefined || result.body === null ? "" : JSON.stringify(result.body));
}

async function parseBody(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return null;
  const url = new URL(request.url || "/", "http://easywork.local");
  return readNodeJson(request, { maxBytes: request.method === "PATCH" && url.pathname === "/api/profile" ? 3 * 1024 * 1024 : 2 * 1024 * 1024 });
}

function safeFilename(value) {
  return String(value || "artifact").replace(/[\r\n"\\]/g, "_").slice(0, 255);
}

function contentDisposition(value, disposition = "attachment") {
  const filename = safeFilename(value).toWellFormed();
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function remoteFileAuditTarget(serverId, workspaceId, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  return {
    serverId,
    workspaceId,
    pathHash: crypto.createHash("sha256").update(normalized).digest("hex"),
    name: path.posix.basename(normalized || "."),
  };
}

function headerRevision(request) {
  const value = String(request.headers["if-match"] || "").trim();
  const match = /^(?:W\/)?"?(\d+)"?$/.exec(value);
  invariant(match, "EXPECTED_REVISION_REQUIRED", "写操作必须提供 If-Match", { status: 428 });
  return Number(match[1]);
}

function idempotencyKey(request) {
  const value = String(request.headers["idempotency-key"] || "").trim();
  invariant(value, "IDEMPOTENCY_KEY_REQUIRED", "写操作必须提供 Idempotency-Key", { status: 428 });
  return value;
}

function remoteFileRange(value, size) {
  if (!value) return { start: 0, endExclusive: size };
  invariant(size > 0, "REMOTE_FILE_RANGE_INVALID", "空文件不接受 Range", { status: 416, details: { size } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  invariant(match && (match[1] || match[2]), "REMOTE_FILE_RANGE_INVALID", "Range 请求无效", { status: 416, details: { size } });
  let start;
  let endExclusive;
  if (!match[1]) {
    const suffix = Number(match[2]);
    invariant(Number.isSafeInteger(suffix) && suffix > 0, "REMOTE_FILE_RANGE_INVALID", "Range 请求无效", { status: 416, details: { size } });
    start = Math.max(0, size - suffix);
    endExclusive = size;
  } else {
    start = Number(match[1]);
    endExclusive = match[2] ? Number(match[2]) + 1 : size;
  }
  invariant(Number.isSafeInteger(start) && Number.isSafeInteger(endExclusive) && start >= 0 && start < size && endExclusive > start && endExclusive <= size, "REMOTE_FILE_RANGE_INVALID", "Range 请求超出远端文件大小", { status: 416, details: { size } });
  return { start, endExclusive };
}

export async function createGatewayServer(options = {}) {
  const runtime = options.runtime || await createEasyWorkRuntime(options.runtimeOptions || options);
  const ownsRuntime = !options.runtime;
  const router = runtime.createApi();
  const realtime = runtime.createRealtimeServer();
  const allowedOrigins = new Set((options.allowedOrigins || runtime.allowedOrigins || []).map(String));
  const webSockets = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (request, response) => {
    const id = requestId(request);
    let cors = {};
    try {
      const url = new URL(request.url || "/", "http://easywork.local");
      const isGatewayRequest = url.pathname === "/health"
        || url.pathname === "/healthz"
        || url.pathname === "/api"
        || url.pathname.startsWith("/api/");
      if (!isGatewayRequest && typeof options.fallbackRequestHandler === "function") {
        await options.fallbackRequestHandler(request, response);
        return;
      }
      cors = corsHeaders(request, allowedOrigins);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { ...cors, "cache-control": "no-store", "x-request-id": id });
        response.end();
        return;
      }
      if (request.method === "GET" && ["/health", "/healthz", "/api/health"].includes(url.pathname)) {
        const result = apiSuccess({ status: "ok", service: "easywork", occurredAt: new Date().toISOString() }, { requestId: id });
        writeJson(response, { ...result, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": id } }, cors);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/help") {
        const document = await runtime.helpDocument();
        if (String(request.headers["if-none-match"] || "") === document.etag) {
          response.writeHead(304, { ...cors, "cache-control": "public, no-cache", etag: document.etag, "last-modified": document.lastModified, "x-request-id": id });
          response.end();
          return;
        }
        const result = apiSuccess(document, { requestId: id });
        writeJson(response, {
          ...result,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, no-cache",
            etag: document.etag,
            "last-modified": document.lastModified,
            "x-request-id": id,
          },
        }, cors);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/profile/avatar") {
        const opened = await runtime.auth.openAvatar(bearer(request));
        const etag = `"${opened.descriptor.sha256}"`;
        if (String(request.headers["if-none-match"] || "") === etag) {
          response.writeHead(304, { ...cors, etag, "cache-control": "private, no-cache", "x-request-id": id });
          response.end();
          return;
        }
        response.writeHead(200, {
          ...cors,
          "content-type": opened.descriptor.mime,
          "content-length": opened.bytes.length,
          "cache-control": "private, no-cache",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          etag,
          "x-request-id": id,
        });
        response.end(opened.bytes);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/resources/upload") {
        const session = await runtime.auth.resolveSession(bearer(request));
        const ownerType = String(url.searchParams.get("ownerType") || "");
        const ownerId = String(url.searchParams.get("ownerId") || "");
        const filename = String(url.searchParams.get("filename") || "");
        const bindingPath = url.searchParams.get("path");
        const expectedSize = Number(url.searchParams.get("size"));
        const expectedSha256 = String(request.headers["x-content-sha256"] || "");
        const createdSequence = Number(url.searchParams.get("createdSequence") || 0);
        const providerId = String(url.searchParams.get("providerId") || "").trim();
        const modelId = String(url.searchParams.get("modelId") || "").trim();
        invariant(providerId && modelId, "RESOURCE_SUMMARY_ROUTE_REQUIRED", "文件上传需要当前网页模型", { status: 400 });
        const services = await runtime.servicesForActor(session.actor);
        const uploaded = await services.resources.ingestStream({
          commandId: idempotencyKey(request),
          expectedRevision: headerRevision(request),
          filename,
          mime: String(request.headers["content-type"] || "application/octet-stream"),
          expectedSize,
          expectedSha256,
          createdSequence,
          binding: { ownerType, ownerId, path: bindingPath || null },
          summary: { required: true, providerId, modelId },
          openSource: async () => request,
        });
        const result = apiSuccess(uploaded, { requestId: id });
        writeJson(response, {
          ...result,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": id },
        }, cors);
        return;
      }
      const remoteFileContentMatch = /^\/api\/servers\/([^/]+)\/workspaces\/([^/]+)\/files\/content\/?$/.exec(url.pathname);
      if (["GET", "PUT"].includes(request.method) && remoteFileContentMatch) {
        const routeServerId = decodeURIComponent(remoteFileContentMatch[1]);
        const routeWorkspaceId = decodeURIComponent(remoteFileContentMatch[2]);
        const downloadToken = request.method === "GET" ? url.searchParams.get("downloadToken") : null;
        const ticket = downloadToken ? runtime.resolveRemoteFileDownloadToken(downloadToken) : null;
        const session = ticket ? { actor: ticket.actor } : await runtime.auth.resolveSession(bearer(request));
        const services = await runtime.servicesForActor(session.actor);
        const serverId = ticket?.serverId || routeServerId;
        const workspaceId = ticket?.workspaceId || routeWorkspaceId;
        invariant(!ticket || ticket.serverId === routeServerId && ticket.workspaceId === routeWorkspaceId, "REMOTE_FILE_DOWNLOAD_SCOPE_INVALID", "下载链接与请求范围不一致", { status: 403 });
        const backend = await services.remoteBackend(serverId);
        const relativePath = ticket?.path || String(url.searchParams.get("path") || "");
        const auditTarget = remoteFileAuditTarget(serverId, workspaceId, relativePath);
        if (request.method === "PUT") {
          await services.audit.append({ action: "remote-file.upload", status: "attempted", target: auditTarget, requestId: id, metadata: { method: "PUT" } });
          try {
            invariant(typeof backend.remoteFiles?.uploadStream === "function", "REMOTE_FILE_UPLOAD_UNAVAILABLE", "远端 backend 未提供流式文件上传", { status: 503 });
            idempotencyKey(request);
            const querySize = Number(url.searchParams.get("size"));
            const contentLength = request.headers["content-length"] == null ? querySize : Number(request.headers["content-length"]);
            invariant(Number.isSafeInteger(querySize) && querySize >= 0 && Number.isSafeInteger(contentLength) && contentLength === querySize, "REMOTE_FILE_SIZE_INVALID", "上传文件大小声明无效", { status: 400 });
            const uploaded = await backend.remoteFiles.uploadStream({
              workspaceId,
              path: relativePath,
              source: request,
              expectedSize: querySize,
              expectedSha256: request.headers["x-content-sha256"] || null,
            });
            await services.audit.append({ action: "remote-file.upload", status: "success", target: auditTarget, requestId: id, metadata: { method: "PUT", size: uploaded.size, sha256: uploaded.sha256 } });
            const result = apiSuccess(uploaded, { requestId: id });
            writeJson(response, {
              ...result,
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                "x-content-sha256": uploaded.sha256,
                "x-request-id": id,
              },
            }, cors);
          } catch (error) {
            await services.audit.append({ action: "remote-file.upload", status: "failure", target: auditTarget, requestId: id, metadata: { method: "PUT", code: String(error?.code || "REMOTE_FILE_UPLOAD_FAILED") } }).catch(() => undefined);
            throw error;
          }
          return;
        }
        await services.audit.append({ action: "remote-file.download", status: "attempted", target: auditTarget, requestId: id, metadata: { method: "GET", range: Boolean(request.headers.range) } });
        let descriptor;
        let range;
        let stream;
        try {
          invariant(typeof backend.remoteFiles?.inspectDownload === "function" && typeof backend.remoteFiles?.openDownloadStream === "function", "REMOTE_FILE_DOWNLOAD_UNAVAILABLE", "远端 backend 未提供流式文件下载", { status: 503 });
          descriptor = await backend.remoteFiles.inspectDownload({ workspaceId, path: relativePath });
          range = remoteFileRange(request.headers.range, descriptor.size);
          stream = backend.remoteFiles.openDownloadStream(descriptor, range);
        } catch (error) {
          await services.audit.append({ action: "remote-file.download", status: "failure", target: auditTarget, requestId: id, metadata: { method: "GET", code: String(error?.code || "REMOTE_FILE_DOWNLOAD_FAILED") } }).catch(() => undefined);
          throw error;
        }
        const partial = Boolean(request.headers.range);
        let auditSettled = false;
        const auditCompletion = (status, error = null) => {
          if (auditSettled) return;
          auditSettled = true;
          void services.audit.append({
            action: "remote-file.download",
            status,
            target: auditTarget,
            requestId: id,
            metadata: {
              method: "GET",
              size: range.endExclusive - range.start,
              sha256: descriptor.sha256,
              ...(error ? { code: String(error?.code || "REMOTE_FILE_DOWNLOAD_FAILED") } : {}),
            },
          }).catch(() => undefined);
        };
        stream.once("end", () => auditCompletion("success"));
        stream.once("error", (error) => auditCompletion("failure", error));
        response.writeHead(partial ? 206 : 200, {
          ...cors,
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream",
          "content-length": range.endExclusive - range.start,
          "content-disposition": contentDisposition(descriptor.name),
          ...(partial ? { "content-range": `bytes ${range.start}-${range.endExclusive - 1}/${descriptor.size}` } : {}),
          "etag": `"sha256:${descriptor.sha256}"`,
          "x-content-sha256": descriptor.sha256,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": id,
        });
        stream.on("error", () => response.destroy());
        response.on("close", () => {
          if (!response.writableEnded) stream.destroy();
        });
        stream.pipe(response);
        return;
      }
      const artifactMatch = /^\/api\/artifacts\/([^/]+)\/download\/?$/.exec(url.pathname);
      if (request.method === "GET" && artifactMatch) {
        const downloadToken = url.searchParams.get("token");
        invariant(downloadToken, "ARTIFACT_DOWNLOAD_TOKEN_REQUIRED", "缺少 Artifact 下载 token", { status: 401 });
        const ticket = runtime.resolveArtifactDownloadTicket(downloadToken);
        const routeArtifactId = decodeURIComponent(artifactMatch[1]);
        invariant(ticket.artifactId === routeArtifactId, "ARTIFACT_DOWNLOAD_SCOPE_INVALID", "结果文件下载链接与请求不一致", { status: 403 });
        const opened = await runtime.openArtifactDownload({
          actor: ticket.actor,
          artifactId: routeArtifactId,
          downloadToken: ticket.artifactToken,
          rangeHeader: request.headers.range,
        });
        const partial = Boolean(request.headers.range);
        response.writeHead(partial ? 206 : 200, {
          ...cors,
          "accept-ranges": "bytes",
          "content-type": opened.mime || "application/octet-stream",
          "content-length": opened.contentLength,
          "content-disposition": contentDisposition(opened.filename),
          ...(partial ? { "content-range": `bytes ${opened.range.start}-${opened.range.endExclusive - 1}/${opened.size}` } : {}),
          "cache-control": "private, no-store",
          "x-request-id": id,
        });
        opened.stream.on("error", () => response.destroy());
        response.on("close", () => {
          if (!response.writableEnded) opened.stream.destroy();
        });
        opened.stream.pipe(response);
        return;
      }
      const previewMatch = /^\/api\/previews\/([^/]+)(\/content)?\/?$/.exec(url.pathname);
      if (["GET", "HEAD"].includes(request.method) && previewMatch && (request.method === "HEAD" || previewMatch[2])) {
        const session = await runtime.auth.resolveSession(bearer(request));
        const previewId = decodeURIComponent(previewMatch[1]);
        const head = await runtime.previewHead({ actor: session.actor, previewId });
        const descriptor = head.descriptor;
        const etag = `"${descriptor.previewId}:${descriptor.revision}"`;
        if (request.method === "HEAD") {
          const isContent = Boolean(previewMatch[2]);
          const exactContentLength = descriptor.delivery.mode === "stream" ? head.contentLength : null;
          response.writeHead(200, {
            ...cors,
            ...(head.acceptsRange ? { "accept-ranges": "bytes" } : {}),
            "content-type": isContent ? head.contentType : "application/json; charset=utf-8",
            ...(isContent && exactContentLength !== null ? { "content-length": exactContentLength } : {}),
            "x-preview-source-size": head.contentLength,
            "x-preview-revision": descriptor.revision,
            etag,
            "cache-control": "private, no-store",
            "x-request-id": id,
          });
          response.end();
          return;
        }
        const opened = await runtime.openPreviewContent({
          actor: session.actor,
          previewId,
          rangeHeader: request.headers.range,
        });
        const partial = Boolean(opened.contentRange);
        response.writeHead(partial ? 206 : 200, {
          ...cors,
          ...(descriptor.delivery.acceptsRange ? { "accept-ranges": "bytes" } : {}),
          "content-type": opened.contentType || "application/octet-stream",
          "content-length": opened.contentLength,
          "content-disposition": contentDisposition(descriptor.name, "inline"),
          ...(partial ? { "content-range": `bytes ${opened.contentRange.start}-${opened.contentRange.endExclusive - 1}/${opened.contentRange.total}` } : {}),
          "x-preview-revision": descriptor.revision,
          "x-preview-source-size": descriptor.size,
          "x-preview-truncated": opened.truncated ? "1" : "0",
          etag,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": id,
        });
        opened.stream.on("error", () => response.destroy());
        response.on("close", () => {
          if (!response.writableEnded) opened.stream.destroy();
        });
        opened.stream.pipe(response);
        return;
      }
      const body = await parseBody(request);
      const result = await router.dispatch({ method: request.method, url: request.url, headers: request.headers, body, requestId: id });
      writeJson(response, result, cors);
    } catch (error) {
      console.error("[EasyWork] request failed", {
        requestId: id,
        method: request.method,
        path: new URL(request.url || "/", "http://easywork.local").pathname,
        code: String(error?.code || "INTERNAL_ERROR"),
        message: String(error?.message || "Unknown gateway error"),
        stack: error?.stack,
      });
      const result = apiFailure(error, { requestId: id });
      writeJson(response, {
        ...result,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": id },
      }, cors);
    }
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", "http://easywork.local");
      invariant(url.pathname === "/easywork-ws", "ROUTE_NOT_FOUND", "WebSocket 接口不存在", { status: 404 });
      corsHeaders(request, allowedOrigins);
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        realtime.attach(webSocket);
        webSockets.emit("connection", webSocket, request);
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  let started = false;
  return Object.freeze({
    runtime,
    server,
    webSockets,
    async start({ host = options.host || "127.0.0.1", port = Number(options.port ?? 0) } = {}) {
      invariant(!started, "GATEWAY_ALREADY_STARTED", "Gateway 已启动", { status: 409 });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); resolve(); });
      });
      started = true;
      const address = server.address();
      return { host: typeof address === "object" ? address.address : host, port: typeof address === "object" ? address.port : port };
    },
    async close() {
      for (const socket of webSockets.clients) socket.close(1001, "server shutdown");
      webSockets.close();
      if (started) await new Promise((resolve) => server.close(resolve));
      started = false;
      if (ownsRuntime || options.closeRuntime === true) await runtime.close();
    },
  });
}

async function runStandalone() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataRoot = path.resolve(process.env.EASYWORK_DATA_ROOT || path.join(repositoryRoot, "data"));
  const allowedOrigins = String(process.env.EASYWORK_ALLOWED_ORIGINS || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const secrets = ["SESSION_SECRET", "MASTER_SECRET", "CURSOR_SECRET", "ARTIFACT_SECRET"].every((name) => process.env[`EASYWORK_${name}`])
    ? {
      sessionSecret: process.env.EASYWORK_SESSION_SECRET,
      masterSecret: process.env.EASYWORK_MASTER_SECRET,
      cursorSecret: process.env.EASYWORK_CURSOR_SECRET,
      artifactSecret: process.env.EASYWORK_ARTIFACT_SECRET,
    }
    : undefined;
  const gateway = await createGatewayServer({
    runtimeOptions: { dataRoot, allowedOrigins, secrets },
    allowedOrigins,
    host: process.env.EASYWORK_HOST || "127.0.0.1",
    port: Number(process.env.EASYWORK_GATEWAY_PORT || 8789),
  });
  const address = await gateway.start();
  process.stdout.write(`EasyWork Gateway listening on http://${address.host}:${address.port}\n`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await gateway.close();
  };
  process.once("SIGINT", () => close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => close().finally(() => process.exit(0)));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runStandalone().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
