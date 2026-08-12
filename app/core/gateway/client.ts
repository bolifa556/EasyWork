import { GatewayError, type ApiFailureBody, type ApiSuccess } from "../contracts";
import { prefixedIdentifier } from "../identifiers";

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  expectedRevision?: number;
  idempotencyKey?: string;
  authenticated?: boolean;
};

export class GatewayClient {
  constructor(
    private readonly baseUrl = "",
    private readonly deviceToken: () => string | null = () => null,
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      body,
      credentials: "include",
    });
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      credentials: "include",
    });
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
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      method: options.method || "POST",
      headers,
      body,
      credentials: "include",
    });
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
      request.open(options.method || "PUT", `${this.baseUrl}${path}`, true);
      request.withCredentials = true;
      request.setRequestHeader("accept", "application/json");
      const token = this.deviceToken();
      if (options.authenticated !== false && token) request.setRequestHeader("authorization", `Bearer ${token}`);
      if (options.expectedRevision !== undefined) request.setRequestHeader("if-match", `"${options.expectedRevision}"`);
      if (options.idempotencyKey) request.setRequestHeader("idempotency-key", options.idempotencyKey);
      new Headers(options.headers).forEach((value, key) => request.setRequestHeader(key, value));
      request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : body.size);
      request.onerror = () => reject(new GatewayError(0, {
        error: { code: "NETWORK_ERROR", message: "上传连接中断", retryable: true },
        meta: { requestId: "" },
      }));
      request.onabort = () => reject(new GatewayError(499, {
        error: { code: "UPLOAD_ABORTED", message: "上传已取消", retryable: true },
        meta: { requestId: request.getResponseHeader("x-request-id") ?? "" },
      }));
      request.onload = () => {
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
    return this.request<T>(path, { method: "GET", signal });
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
