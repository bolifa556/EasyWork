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
const MODEL_EFFORT_ORDER = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MAX_ADAPTIVE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_ADAPTIVE_ERROR_BYTES = 1024 * 1024;

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

function jsonContentType(headers) {
  return /(?:^|\s|;)application\/(?:[A-Za-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(String(headers?.["content-type"] || ""));
}

function collectBody(stream, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" }));
        stream.destroy();
        return;
      }
      chunks.push(bytes);
    });
    stream.once("end", () => resolve(Buffer.concat(chunks)));
    stream.once("error", reject);
    stream.once("aborted", () => reject(Object.assign(new Error("body aborted"), { code: "BODY_ABORTED" })));
  });
}

function effortSlots(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const slots = [];
  const add = (owner, key) => {
    if (owner && typeof owner[key] === "string" && MODEL_EFFORT_ORDER.includes(owner[key].toLowerCase())) slots.push({ owner, key, value: owner[key].toLowerCase() });
  };
  add(body, "reasoning_effort");
  add(body, "effort");
  add(body.reasoning, "effort");
  add(body.output_config, "effort");
  add(body.thinking, "effort");
  return slots;
}

function supportedEffortsFromError(bytes) {
  const text = Buffer.from(bytes || []).toString("utf8");
  const match = text.match(/Supported (?:types|values)(?:\s+are)?\s*:?\s*([^\r\n.]+)/i);
  if (!match) return [];
  return MODEL_EFFORT_ORDER.filter((effort) => new RegExp(`(?:^|[^A-Za-z])${effort}(?:$|[^A-Za-z])`, "i").test(match[1]));
}

function nearestHigherEffort(requested, supported) {
  const requestedIndex = MODEL_EFFORT_ORDER.indexOf(String(requested || "").toLowerCase());
  const candidates = [...new Set((supported || []).map((value) => String(value).toLowerCase()))]
    .map((value) => ({ value, index: MODEL_EFFORT_ORDER.indexOf(value) }))
    .filter((entry) => entry.index >= 0 && entry.index !== requestedIndex);
  if (!candidates.length) return null;
  if (requestedIndex < 0) return candidates.sort((left, right) => right.index - left.index)[0].value;
  const stronger = candidates
    .filter((entry) => entry.index > requestedIndex)
    .sort((left, right) => left.index - right.index);
  if (stronger.length) return stronger[0].value;
  // A provider may expose no level at or above the user's choice. In that
  // case use its strongest supported level instead of failing the whole turn.
  return candidates.sort((left, right) => right.index - left.index)[0].value;
}

function parseAdaptiveRequest(bytes) {
  try {
    const body = JSON.parse(Buffer.from(bytes || []).toString("utf8"));
    const slots = effortSlots(body);
    if (!slots.length) return null;
    return { body, slots, model: String(body.model || "") };
  } catch {
    return null;
  }
}

function rewriteAdaptiveRequest(parsed, requested, fallback) {
  let changed = false;
  for (const slot of parsed.slots) {
    if (slot.value !== requested) continue;
    slot.owner[slot.key] = fallback;
    slot.value = fallback;
    changed = true;
  }
  return changed ? Buffer.from(JSON.stringify(parsed.body)) : null;
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
export async function createHostApiRelay({ baseUrl, apiKey, tokenFactory = () => crypto.randomBytes(24).toString("base64url"), connectTimeoutMs = 5_000, onEffortAdapted = null } = {}) {
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
  const effortAdaptations = new Map();
  let effortAdaptationHandler = typeof onEffortAdapted === "function" ? onEffortAdapted : null;

  const notifyEffortAdaptation = (detail) => {
    const handler = effortAdaptationHandler;
    if (typeof handler !== "function") return;
    try {
      const result = handler(Object.freeze(structuredClone(detail)));
      if (result && typeof result.catch === "function") void result.catch(() => undefined);
    } catch { /* an optional host notification must never fail the model request */ }
  };

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
    let activeForward = null;
    const responseHeaders = (upstreamResponse) => {
      const headers = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers || {})) {
        if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      return headers;
    };
    const failUpstream = () => {
      if (response.writableEnded || response.destroyed) return;
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end('{"error":"upstream_unavailable"}');
    };
    const forward = (bodyBytes = null, parsed = null, attempt = 0) => {
      if (request.aborted || response.destroyed) return;
      const headers = outgoingHeaders(request.headers, upstream, credential);
      if (bodyBytes) {
        delete headers["content-length"];
        headers["content-length"] = String(bodyBytes.length);
      }
      const forwarded = client.request({
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        method: request.method,
        path: targetPath,
        headers,
      }, (upstreamResponse) => {
        if (response.destroyed) { upstreamResponse.destroy(); return; }
        const status = Number(upstreamResponse.statusCode || 502);
        if (bodyBytes && parsed && attempt === 0 && [400, 422].includes(status)) {
          collectBody(upstreamResponse, MAX_ADAPTIVE_ERROR_BYTES).then((errorBytes) => {
            const requested = parsed.slots[0]?.value || "";
            const supported = supportedEffortsFromError(errorBytes);
            const fallback = supported.includes(requested) ? null : nearestHigherEffort(requested, supported);
            const rewritten = fallback ? rewriteAdaptiveRequest(parsed, requested, fallback) : null;
            if (!rewritten) {
              response.writeHead(status, responseHeaders(upstreamResponse));
              response.end(errorBytes);
              return;
            }
            effortAdaptations.set(`${targetPath}\0${parsed.model}\0${requested}`, Object.freeze({ applied: fallback, supported: [...supported] }));
            notifyEffortAdaptation({
              requestedEffort: requested,
              appliedEffort: fallback,
              supportedEfforts: supported,
              model: parsed.model,
              endpoint: targetPath,
              cached: false,
            });
            forward(rewritten, parseAdaptiveRequest(rewritten), attempt + 1);
          }).catch(failUpstream);
          return;
        }
        response.writeHead(status, responseHeaders(upstreamResponse));
        upstreamResponse.pipe(response);
      });
      activeForward = forwarded;
      upstreamRequests.add(forwarded);
      forwarded.once("close", () => upstreamRequests.delete(forwarded));
      forwarded.once("error", failUpstream);
      if (bodyBytes) forwarded.end(bodyBytes);
      else request.pipe(forwarded);
    };
    request.once("aborted", () => activeForward?.destroy());
    response.once("close", () => {
      if (!response.writableEnded) activeForward?.destroy();
    });
    if (!jsonContentType(request.headers)) {
      forward();
      return;
    }
    collectBody(request, MAX_ADAPTIVE_REQUEST_BYTES).then((bodyBytes) => {
      let parsed = parseAdaptiveRequest(bodyBytes);
      if (parsed) {
        const requested = parsed.slots[0]?.value || "";
        const cached = effortAdaptations.get(`${targetPath}\0${parsed.model}\0${requested}`);
        const rewritten = cached ? rewriteAdaptiveRequest(parsed, requested, cached.applied) : null;
        if (rewritten) {
          notifyEffortAdaptation({
            requestedEffort: requested,
            appliedEffort: cached.applied,
            supportedEfforts: cached.supported,
            model: parsed.model,
            endpoint: targetPath,
            cached: true,
          });
          bodyBytes = rewritten;
          parsed = parseAdaptiveRequest(rewritten);
        }
      }
      forward(bodyBytes, parsed, 0);
    }).catch((error) => {
      if (response.writableEnded) return;
      if (error?.code === "BODY_TOO_LARGE") {
        response.writeHead(413, { "content-type": "application/json" });
        response.end('{"error":"request_too_large"}');
        return;
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"request_aborted"}');
    });
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
    setEffortAdaptationHandler(handler) {
      const next = typeof handler === "function" ? handler : null;
      effortAdaptationHandler = next;
      return () => {
        if (effortAdaptationHandler === next) effortAdaptationHandler = null;
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  });
}
