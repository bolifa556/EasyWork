export type RealtimeEventKind =
  | "message"
  | "reasoning"
  | "plan"
  | "tool_call"
  | "tool_result"
  | "approval_request"
  | "approval_response"
  | "input_request"
  | "input_response"
  | "file_change"
  | "job_status"
  | "artifact"
  | "usage"
  | "status"
  | "error"
  | "final"
  | "context_delivery"
  | "ssh_status"
  | "index_status"
  | "terminal_output"
  | "file_transfer";

export type RealtimeProducer =
  | "web-agent"
  | "orchestrator"
  | "remote-agent"
  | "ssh"
  | "scheduler"
  | "resource-indexer";

export type RealtimeEnvelope<T = unknown> = {
  schemaVersion: 1;
  eventId: string;
  topic: string;
  sequence: number;
  occurredAt: string;
  actorType: "user" | "guest";
  actorId: string;
  producer: RealtimeProducer | string;
  kind: RealtimeEventKind | string;
  status: string | null;
  ids: Record<`${string}Id`, string | null>;
  payload: T;
};

export type RealtimeSubscribe = {
  type: "subscribe";
  requestId: string;
  topics: string[];
  resume: Record<string, number>;
  replayView?: "summary";
};

export type RealtimeUnsubscribe = {
  type: "unsubscribe";
  requestId: string;
  topics: string[];
};

export type RealtimeCommand<T = unknown> = {
  type: string;
  requestId: string;
  idempotencyKey: string;
  payload: T;
};
