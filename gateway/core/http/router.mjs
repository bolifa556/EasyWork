import crypto from "node:crypto";

import { apiFailure, apiSuccess, invariant } from "../errors.mjs";

function compilePattern(pattern) {
  const names = [];
  const source = pattern.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(segment.slice(1));
    return "([^/]+)";
  }).join("/");
  return { regex: new RegExp(`^${source}/?$`), names };
}

function normalizedHeaders(value = {}) {
  if (typeof value.get === "function") {
    const result = {};
    for (const key of ["authorization", "content-type", "if-match", "idempotency-key", "x-request-id", "origin"]) {
      const entry = value.get(key);
      if (entry !== null) result[key] = entry;
    }
    return result;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.toLowerCase(), String(entry)]));
}

function bearerToken(headers) {
  const value = String(headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(value);
  invariant(match, "SESSION_TOKEN_REQUIRED", "缺少登录会话", { status: 401 });
  return match[1];
}

const SAFE_AUDIT_PARAM = /^[A-Za-z0-9._:-]{1,256}$/;
const AUDITED_READ_PREFIXES = Object.freeze([
  "/api/resources",
  "/api/resource-bindings",
  "/api/artifacts",
  "/api/previews",
  "/api/servers/:id/remote-files",
  "/api/servers/:id/version",
]);

function defaultAuditAction(method, pattern) {
  const normalized = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.startsWith(":") ? "item" : segment.replace(/[^A-Za-z0-9_-]/g, "-"))
    .join(".")
    .toLowerCase();
  return `api.${method.toLowerCase()}.${normalized || "root"}`.slice(0, 128);
}

function auditedRoute(route) {
  if (route.audit === false) return false;
  if (route.auditAction || route.audit === true) return true;
  if (!["GET", "HEAD", "OPTIONS"].includes(route.method)) return true;
  return AUDITED_READ_PREFIXES.some((prefix) => route.pattern.startsWith(prefix));
}

function auditTarget(route, params) {
  const safeParams = Object.fromEntries(Object.entries(params || {})
    .filter(([, value]) => SAFE_AUDIT_PARAM.test(String(value)))
    .map(([key, value]) => [key, String(value)]));
  return { route: route.pattern, ...(Object.keys(safeParams).length ? { params: safeParams } : {}) };
}

function validSecretResponse(secret) {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) return false;
  const keys = Object.keys(secret);
  const hasValidExpiry = Number.isFinite(Date.parse(secret.expiresAt));
  if (!hasValidExpiry) return false;
  if (keys.every((key) => ["providerId", "apiKey", "expiresAt"].includes(key))) {
    return typeof secret.providerId === "string" && typeof secret.apiKey === "string" && secret.apiKey.length > 0;
  }
  if (!keys.every((key) => ["serverId", "method", "password", "fileName", "hasPassphrase", "expiresAt", "profileRevision"].includes(key))) return false;
  if (typeof secret.serverId !== "string" || !Number.isSafeInteger(secret.profileRevision) || secret.profileRevision < 0) return false;
  if (secret.method === "password") return typeof secret.password === "string" && secret.password.length > 0;
  return secret.method === "private-key" && typeof secret.fileName === "string" && typeof secret.hasPassphrase === "boolean";
}

export class HttpRouter {
  constructor({ auth, servicesForActor, allowedOrigins = [] }) {
    invariant(auth?.resolveSession && typeof servicesForActor === "function", "HTTP_ROUTER_DEPENDENCY_INVALID", "HTTP Router 缺少依赖", { status: 500, expose: false });
    this.auth = auth;
    this.servicesForActor = servicesForActor;
    this.allowedOrigins = new Set(allowedOrigins);
    this.routes = [];
  }

  route(method, pattern, handler, options = {}) {
    const compiled = compilePattern(pattern);
    const auth = options.auth !== false;
    invariant(!options.secretResponse || auth, "SECRET_RESPONSE_AUTH_REQUIRED", "密钥响应接口必须要求登录", { status: 500, expose: false });
    this.routes.push({
      method: method.toUpperCase(),
      pattern,
      handler,
      auth,
      admin: options.admin === true,
      secretResponse: options.secretResponse === true,
      audit: options.audit,
      auditAction: options.auditAction,
      auditTarget: options.auditTarget,
      ...compiled,
    });
    return this;
  }

  async dispatch(input) {
    const requestId = String(input.requestId || normalizedHeaders(input.headers)["x-request-id"] || `req_${crypto.randomUUID()}`);
    const headers = normalizedHeaders(input.headers);
    let route = null;
    let services = null;
    let params = {};
    let audit = null;
    try {
      const url = new URL(input.url || input.path, "http://easywork.local");
      const origin = headers.origin;
      if (origin && this.allowedOrigins.size > 0) invariant(this.allowedOrigins.has(origin), "ORIGIN_FORBIDDEN", "请求来源不被允许", { status: 403 });
      const method = String(input.method || "GET").toUpperCase();
      route = this.routes.find((candidate) => candidate.method === method && candidate.regex.test(url.pathname));
      invariant(route, "ROUTE_NOT_FOUND", "接口不存在", { status: 404, details: { method, path: url.pathname } });
      const matched = route.regex.exec(url.pathname);
      params = Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(matched[index + 1])]));
      let session = null;
      let token = null;
      if (route.auth) {
        token = bearerToken(headers);
        session = await this.auth.resolveSession(token);
        if (route.admin) invariant(session.actor.roles.includes("admin"), "ADMIN_REQUIRED", "需要管理员权限", { status: 403 });
        services = await this.servicesForActor(session.actor, session);
      }
      if (route.auth && services?.audit && auditedRoute(route)) {
        audit = {
          action: String(route.auditAction || defaultAuditAction(method, route.pattern)),
          target: typeof route.auditTarget === "function"
            ? route.auditTarget({ params, session, method, pattern: route.pattern })
            : route.auditTarget || auditTarget(route, params),
          requestId,
          metadata: { method },
        };
        await services.audit.append({ ...audit, status: "attempted" });
      }
      const result = await route.handler({
        method,
        url,
        params,
        query: Object.fromEntries(url.searchParams.entries()),
        headers,
        body: input.body ?? null,
        requestId,
        session,
        token,
        services,
      });
      if (audit) await services.audit.append({ ...audit, status: "success" }).catch(() => undefined);
      let response;
      if (route.secretResponse) {
        const secret = result?.data === undefined ? result : result.data;
        invariant(validSecretResponse(secret), "SECRET_RESPONSE_INVALID", "密钥响应结构无效", { status: 500, expose: false });
        response = { status: Number.isInteger(result?.status) ? result.status : 200, body: { data: secret, meta: { requestId } } };
      } else {
        response = apiSuccess(result?.data === undefined ? result : result.data, {
          status: Number.isInteger(result?.status) ? result.status : undefined,
          requestId,
          meta: result?.meta,
        });
      }
      return { ...response, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store, max-age=0", pragma: "no-cache", "x-request-id": requestId } };
    } catch (error) {
      if (!error?.expose || Number(error?.status || 500) >= 500) {
        console.error("[EasyWork] route failed", {
          requestId,
          method: String(input.method || "GET").toUpperCase(),
          path: new URL(input.url || input.path, "http://easywork.local").pathname,
          code: String(error?.code || "INTERNAL_ERROR"),
          message: String(error?.message || "Unknown route error"),
          stack: error?.stack,
        });
      }
      if (audit && services?.audit) {
        await services.audit.append({
          ...audit,
          status: "failure",
          metadata: { ...audit.metadata, code: String(error?.code || "INTERNAL_ERROR").slice(0, 128) },
        }).catch(() => undefined);
      }
      const response = apiFailure(error, { requestId });
      return { ...response, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId } };
    }
  }
}

export function expectedRevision(request) {
  const header = request.headers["if-match"]?.replace(/^W\//, "").replace(/^"|"$/g, "");
  const value = request.body?.expectedRevision ?? header;
  invariant(value !== undefined && value !== null && value !== "", "EXPECTED_REVISION_REQUIRED", "写操作必须提供 expectedRevision", { status: 428 });
  const revision = Number(value);
  invariant(Number.isSafeInteger(revision) && revision >= 0, "REVISION_INVALID", "expectedRevision 无效", { status: 400 });
  return revision;
}

export function commandId(request) {
  const value = request.headers["idempotency-key"] || request.body?.commandId;
  invariant(typeof value === "string" && value.length > 0 && value.length <= 512, "IDEMPOTENCY_KEY_REQUIRED", "写操作必须提供 Idempotency-Key", { status: 428 });
  return value;
}

export async function readNodeJson(request, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    invariant(bytes <= maxBytes, "REQUEST_BODY_TOO_LARGE", "请求体超过允许大小", { status: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  invariant(String(request.headers["content-type"] || "").split(";", 1)[0].trim() === "application/json", "CONTENT_TYPE_UNSUPPORTED", "接口只接受 application/json", { status: 415 });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    invariant(false, "REQUEST_JSON_INVALID", "请求体不是有效 JSON", { status: 400 });
  }
}

export function createNodeHttpHandler(router) {
  return async (request, response) => {
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) ? await readNodeJson(request).catch((error) => ({ __parseError: error })) : null;
    const result = body?.__parseError
      ? apiFailure(body.__parseError, { requestId: request.headers["x-request-id"] })
      : await router.dispatch({ method: request.method, url: request.url, headers: request.headers, body });
    response.writeHead(result.status, result.headers || { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result.body));
  };
}
