import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { ApiError, invariant } from "../errors.mjs";
import { normalizeBaseUrl } from "../platform/contract.mjs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

function outgoingHeaders(headers, upstream, apiKey) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower) || CREDENTIAL_HEADERS.has(lower)) continue;
    if (value !== undefined) output[lower] = value;
  }
  output.host = upstream.host;
  output.authorization = `Bearer ${apiKey}`;
  output["x-api-key"] = apiKey;
  output["api-key"] = apiKey;
  return output;
}

function pathWithinBase(candidate, basePath) {
  if (basePath === "/") return candidate.startsWith("/");
  return candidate === basePath || candidate.startsWith(`${basePath}/`) || candidate.startsWith(`${basePath}?`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function probeUpstream(upstream, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const port = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
    const options = {
      host: upstream.hostname,
      port,
      ...(upstream.protocol === "https:" && !net.isIP(upstream.hostname) ? { servername: upstream.hostname } : {}),
    };
    const socket = upstream.protocol === "https:"
      ? tls.connect({ ...options, rejectUnauthorized: true })
      : net.connect(options);
    const readyEvent = upstream.protocol === "https:" ? "secureConnect" : "connect";
    const finish = (error = null) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" })));
    socket.once(readyEvent, () => finish());
    socket.once("error", (error) => finish(error));
  });
}

/**
 * Host-only HTTP relay. The real credential is closed over by the request
 * handler and deliberately absent from the returned descriptor.
 */
export async function createHostApiRelay({ baseUrl, apiKey, tokenFactory = () => crypto.randomBytes(24).toString("base64url"), connectTimeoutMs = 5_000 } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const credential = String(apiKey || "");
  invariant(credential.length > 0, "AGENT_API_CREDENTIAL_REQUIRED", "Agent API credential 缺失", { status: 409 });
  const upstream = new URL(normalizedBaseUrl);
  await probeUpstream(upstream, connectTimeoutMs).catch((error) => {
    throw new ApiError("AGENT_API_UPSTREAM_UNREACHABLE", "部署 EasyWork 的主机无法连接模型 API", {
      status: 502,
      retryable: true,
      details: { stage: "host_upstream_connect", reason: String(error?.code || "connect_failed") },
      cause: error,
    });
  });
  const basePath = upstream.pathname.replace(/\/+$/, "") || "/";
  const token = String(tokenFactory() || "");
  invariant(/^[A-Za-z0-9_-]{24,128}$/.test(token), "AGENT_API_PROXY_TOKEN_INVALID", "Agent API relay token 无效", { status: 500, expose: false });
  const capabilityPrefix = `/${token}`;
  const endpointPath = `${capabilityPrefix}${basePath === "/" ? "" : basePath}`;
  const sockets = new Set();
  const upstreamRequests = new Set();

  const server = http.createServer((request, response) => {
    const incoming = String(request.url || "/");
    if (!incoming.startsWith(capabilityPrefix)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
      return;
    }
    const targetPath = incoming.slice(capabilityPrefix.length) || "/";
    if (!pathWithinBase(targetPath, basePath)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"path_forbidden"}');
      return;
    }
    const client = upstream.protocol === "https:" ? https : http;
    const forwarded = client.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || undefined,
      method: request.method,
      path: targetPath,
      headers: outgoingHeaders(request.headers, upstream, credential),
    }, (upstreamResponse) => {
      const headers = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers || {})) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode || 502, headers);
      upstreamResponse.pipe(response);
    });
    upstreamRequests.add(forwarded);
    forwarded.once("close", () => upstreamRequests.delete(forwarded));
    forwarded.once("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end('{"error":"upstream_unavailable"}');
    });
    request.once("aborted", () => forwarded.destroy());
    request.pipe(forwarded);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await listen(server).catch((error) => {
    throw new ApiError("AGENT_API_PROXY_LISTEN_FAILED", "主机 Agent API relay 启动失败", {
      status: 502,
      details: { reason: String(error?.code || "listen_failed") },
      cause: error,
    });
  });
  const address = server.address();
  invariant(address && typeof address === "object" && Number.isSafeInteger(address.port), "AGENT_API_PROXY_LISTEN_FAILED", "主机 Agent API relay 未取得监听端口", {
    status: 500,
    expose: false,
  });
  let closed = false;
  return Object.freeze({
    host: "127.0.0.1",
    port: address.port,
    protocol: "http",
    endpointPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}
