import { GatewayError, type ApiFailureBody, type ApiSuccess } from "../contracts";
import { prefixedIdentifier } from "../identifiers";
import { StartupPrefetch } from "./startup-prefetch";

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  expectedRevision?: number;
  idempotencyKey?: string;
  authenticated?: boolean;
};

export class GatewayClient {
  private readonly startupPrefetch = new StartupPrefetch();
  private readonly authenticatedRequests = new Set<AbortController>();
  private readonly authenticatedUploads = new Set<XMLHttpRequest>();

  constructor(
    private readonly baseUrl = "",
    private readonly deviceToken: () => string | null = () => null,
  ) {}

  beginSessionTransition() {
    this.startupPrefetch.clear();
    for (const controller of this.authenticatedRequests) controller.abort("session-transition");
    this.authenticatedRequests.clear();
    for (const request of this.authenticatedUploads) request.abort();
    this.authenticatedUploads.clear();
  }

  private trackedSignal(options: RequestOptions) {
    if (options.authenticated === false) return { signal: options.signal, release: () => undefined };
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    this.authenticatedRequests.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        this.authenticatedRequests.delete(controller);
        options.signal?.removeEventListener("abort", abort);
      },
    };
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
    if (!["GET", "HEAD"].includes(options.method || "GET")) this.startupPrefetch.clear();
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    const token = this.deviceToken();
    if (options.authenticated !== false && token) headers.set("authorization", `Bearer ${token}`);
    if (options.expectedRevision !== undefined) {
      headers.set("if-match", `\"${options.expectedRevision}\"`);
    }
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }
    const tracked = this.trackedSignal(options);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: tracked.signal,
        headers,
        body,
        credentials: "include",
      });
    } finally { tracked.release(); }
    const payload = (await response.json().catch(() => null)) as
      | ApiSuccess<T>
      | ApiFailureBody
      | null;
    if (!response.ok) {
      const fallback: ApiFailureBody = payload && "error" in payload
        ? payload
        : {
            error: {
              code: "HTTP_ERROR",
              message: `请求失败（${response.status}）`,
              retryable: response.status >= 500,
            },
            meta: { requestId: response.headers.get("x-request-id") ?? "" },
          };
      throw new GatewayError(response.status, fallback);
    }
    if (!payload || !("data" in payload)) {
      throw new GatewayError(502, {
        error: { code: "INVALID_RESPONSE", message: "服务返回了无效响应", retryable: true },
        meta: { requestId: response.headers.get("x-request-id") ?? "" },
      });
    }
    return payload;
  }

  async raw(path: string, options: Omit<RequestOptions, "body"> = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    const token = this.deviceToken();
    if (options.authenticated !== false && token) headers.set("authorization", `Bearer ${token}`);
    const tracked = this.trackedSignal(options);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: tracked.signal,
        headers,
        credentials: "include",
      });
    } finally { tracked.release(); }
    if (!response.ok) {
      const payload = await response.clone().json().catch(() => null) as ApiFailureBody | null;
      const fallback: ApiFailureBody = payload && "error" in payload
        ? payload
        : {
            error: {
              code: "HTTP_ERROR",
              message: `请求失败（${response.status}）`,
              retryable: response.status >= 500,
            },
            meta: { requestId: response.headers.get("x-request-id") ?? "" },
          };
      throw new GatewayError(response.status, fallback);
    }
    return response;
  }

  async upload<T>(path: string, body: BodyInit, options: Omit<RequestOptions, "body"> = {}): Promise<ApiSuccess<T>> {
    const headers = new Headers(options.headers);
    headers.set("accept", "application/json");
    const token = this.deviceToken();
    if (options.authenticated !== false && token) headers.set("authorization", `Bearer ${token}`);
    if (options.expectedRevision !== undefined) headers.set("if-match", `\"${options.expectedRevision}\"`);
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    const tracked = this.trackedSignal(options);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: tracked.signal,
        method: options.method || "POST",
        headers,
        body,
        credentials: "include",
      });
    } finally { tracked.release(); }
    const payload = (await response.json().catch(() => null)) as ApiSuccess<T> | ApiFailureBody | null;
    if (!response.ok) {
      const fallback: ApiFailureBody = payload && "error" in payload
        ? payload
        : {
            error: { code: "HTTP_ERROR", message: `上传失败（${response.status}）`, retryable: response.status >= 500 },
            meta: { requestId: response.headers.get("x-request-id") ?? "" },
          };
      throw new GatewayError(response.status, fallback);
    }
    if (!payload || !("data" in payload)) {
      throw new GatewayError(502, {
        error: { code: "INVALID_RESPONSE", message: "服务返回了无效上传响应", retryable: true },
        meta: { requestId: response.headers.get("x-request-id") ?? "" },
      });
    }
    return payload;
  }

  uploadWithProgress<T>(
    path: string,
    body: Blob,
    onProgress: (loaded: number, total: number) => void,
    options: Omit<RequestOptions, "body"> = {},
  ): Promise<ApiSuccess<T>> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      if (options.authenticated !== false) this.authenticatedUploads.add(request);
      request.open(options.method || "PUT", `${this.baseUrl}${path}`, true);
      request.withCredentials = true;
      request.setRequestHeader("accept", "application/json");
      const token = this.deviceToken();
      if (options.authenticated !== false && token) request.setRequestHeader("authorization", `Bearer ${token}`);
      if (options.expectedRevision !== undefined) request.setRequestHeader("if-match", `"${options.expectedRevision}"`);
      if (options.idempotencyKey) request.setRequestHeader("idempotency-key", options.idempotencyKey);
      new Headers(options.headers).forEach((value, key) => request.setRequestHeader(key, value));
      request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : body.size);
      const release = () => this.authenticatedUploads.delete(request);
      request.onerror = () => { release(); reject(new GatewayError(0, {
        error: { code: "NETWORK_ERROR", message: "上传连接中断", retryable: true },
        meta: { requestId: "" },
      })); };
      request.onabort = () => { release(); reject(new GatewayError(499, {
        error: { code: "UPLOAD_ABORTED", message: "上传已取消", retryable: true },
        meta: { requestId: request.getResponseHeader("x-request-id") ?? "" },
      })); };
      request.onload = () => {
        release();
        const payload = (() => {
          try { return JSON.parse(request.responseText) as ApiSuccess<T> | ApiFailureBody; } catch { return null; }
        })();
        if (request.status < 200 || request.status >= 300) {
          reject(new GatewayError(request.status, payload && "error" in payload ? payload : {
            error: { code: "HTTP_ERROR", message: `上传失败（${request.status}）`, retryable: request.status >= 500 },
            meta: { requestId: request.getResponseHeader("x-request-id") ?? "" },
          }));
          return;
        }
        if (!payload || !("data" in payload)) {
          reject(new GatewayError(502, {
            error: { code: "INVALID_RESPONSE", message: "服务返回了无效上传响应", retryable: true },
            meta: { requestId: request.getResponseHeader("x-request-id") ?? "" },
          }));
          return;
        }
        onProgress(body.size, body.size);
        resolve(payload);
      };
      options.signal?.addEventListener("abort", () => request.abort(), { once: true });
      request.send(body);
    });
  }

  get<T>(path: string, signal?: AbortSignal) {
    return this.startupPrefetch.take<ApiSuccess<T>>(path, this.deviceToken(), signal)
      ?? this.request<T>(path, { method: "GET", signal });
  }

  prefetch(path: string) {
    this.startupPrefetch.start(path, this.deviceToken(), () => this.request(path, { method: "GET" }));
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, "body" | "method"> = {}) {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  patch<T>(path: string, body: unknown, options: Omit<RequestOptions, "body" | "method"> = {}) {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, "method"> = {}) {
    return this.request<T>(path, { ...options, method: "DELETE" });
  }
}

export function commandId(prefix = "web") {
  return prefixedIdentifier(prefix);
}
