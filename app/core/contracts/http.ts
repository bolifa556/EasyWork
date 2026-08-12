export type ApiMeta = {
  requestId: string;
  nextCursor?: string | null;
  revision?: number;
};

export type ApiSuccess<T> = {
  data: T;
  meta: ApiMeta;
};

export type ApiFailureBody = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
  meta: Pick<ApiMeta, "requestId">;
};

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(status: number, body: ApiFailureBody) {
    super(body.error.message);
    this.name = "GatewayError";
    this.status = status;
    this.code = body.error.code;
    this.retryable = body.error.retryable;
    this.details = body.error.details;
    this.requestId = body.meta?.requestId;
  }
}
