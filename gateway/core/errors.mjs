const SENSITIVE_KEY_PATTERN = /^(?:api[-_]?key|password|passwd|private[-_]?key|secret|credential|two[-_]?factor[-_]?code|otp)$/i;

function redactString(value) {
  return String(value)
    .replace(/-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED API KEY]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]");
}

function containsSecretString(value) {
  const text = String(value);
  return (
    /-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/i.test(text)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
    || /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(text)
  );
}

function safeClone(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((entry) => safeClone(entry, seen));

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = "[REDACTED]";
      continue;
    }
    if (["stack", "cause"].includes(key)) continue;
    result[key] = safeClone(entry, seen);
  }
  return result;
}

export class ApiError extends Error {
  constructor(code, message, options = {}) {
    super(String(message || "请求失败"), { cause: options.cause });
    this.name = "ApiError";
    this.code = String(code || "INTERNAL_ERROR");
    this.status = Number.isInteger(options.status) ? options.status : 500;
    this.details = options.details === undefined ? undefined : safeClone(options.details);
    this.expose = options.expose ?? this.status < 500;
    this.retryable = options.retryable === true;
  }
}

export function invariant(condition, code, message, options) {
  if (!condition) throw new ApiError(code, message, options);
}

export function asApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && /^[A-Z][A-Z0-9_:-]{1,127}$/.test(String(error.code || "")) && Number.isInteger(error.status)) {
    return new ApiError(error.code, error.message, {
      status: error.status,
      details: error.details,
      retryable: error.retryable,
      expose: error.expose,
      cause: error,
    });
  }
  return new ApiError("INTERNAL_ERROR", "服务器处理请求时发生错误", {
    status: 500,
    cause: error,
    expose: false,
  });
}

export function apiSuccess(data, options = {}) {
  const body = {
    data: safeClone(data),
    meta: {
      ...(options.meta === undefined ? {} : safeClone(options.meta)),
      ...(options.requestId ? { requestId: String(options.requestId) } : {}),
    },
  };
  return { status: options.status ?? 200, body };
}

export function apiFailure(error, options = {}) {
  const apiError = asApiError(error);
  const publicMessage = apiError.expose ? redactString(apiError.message) : "服务器处理请求时发生错误";
  const body = {
    error: {
      code: apiError.code,
      message: publicMessage,
      retryable: apiError.retryable,
    },
    meta: options.requestId ? { requestId: String(options.requestId) } : {},
  };
  if (apiError.expose && apiError.details !== undefined) {
    body.error.details = safeClone(apiError.details);
  }
  return { status: apiError.status, body };
}

export function assertNoSensitiveFields(value, path = "payload", seen = new WeakSet()) {
  if (value === null || value === undefined) return;
  invariant(typeof value !== "string" || !containsSecretString(value), "SENSITIVE_VALUE_FORBIDDEN", `响应或事件不能包含密钥内容：${path}`, {
    status: 500,
    expose: false,
  });
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveFields(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    invariant(!SENSITIVE_KEY_PATTERN.test(key), "SENSITIVE_FIELD_FORBIDDEN", `响应或事件不能包含敏感字段：${path}.${key}`, {
      status: 500,
      expose: false,
    });
    assertNoSensitiveFields(entry, `${path}.${key}`, seen);
  }
}

export { safeClone as redactSensitive };
