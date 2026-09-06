import { ApiError, assertNoSensitiveFields, invariant } from "../errors.mjs";

export const AGENT_EVENT_SCHEMA_VERSION = 1;

export const AGENT_EVENT_KINDS = Object.freeze([
  "message",
  "reasoning",
  "plan",
  "tool_call",
  "tool_result",
  "approval_request",
  "approval_response",
  "input_request",
  "input_response",
  "file_change",
  "job_status",
  "artifact",
  "usage",
  "status",
  "error",
  "final",
]);

export const AGENT_EVENT_PHASES = Object.freeze([
  "started",
  "updated",
  "completed",
  "failed",
  "cancelled",
  "waiting",
]);

export const AGENT_OPERATIONS = Object.freeze([
  "start",
  "append",
  "interrupt",
  "resume",
  "respondApproval",
  "respondInput",
  "compact",
  "contextUsage",
  "fork",
  "revert",
]);

const AVAILABILITY = new Set(["available", "unavailable"]);
const KIND_SET = new Set(AGENT_EVENT_KINDS);
const PHASE_SET = new Set(AGENT_EVENT_PHASES);
const OPERATION_SET = new Set(AGENT_OPERATIONS);

function copyJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeCapability(operation, value) {
  const capability = value && typeof value === "object" ? value : {};
  const availability = capability.availability || "unavailable";
  invariant(AVAILABILITY.has(availability), "AGENT_CAPABILITY_INVALID", `Agent capability ${operation} availability 无效`, {
    status: 500,
    expose: false,
  });
  const normalized = {
    availability,
    mode: String(capability.mode || (availability === "available" ? "native" : "unavailable")),
  };
  if (availability === "unavailable") {
    normalized.reason = String(capability.reason || `${operation} is not available for this adapter`);
  }
  return Object.freeze(normalized);
}

export function createCapabilitySchema(declared = {}, overrides = {}) {
  const result = {};
  for (const operation of AGENT_OPERATIONS) {
    result[operation] = normalizeCapability(operation, overrides[operation] ?? declared[operation]);
  }
  return Object.freeze(result);
}

export function createAgentState(adapterId, seed = {}) {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    adapterId: String(adapterId),
    sequence: Number.isSafeInteger(seed.sequence) && seed.sequence >= 0 ? seed.sequence : 0,
    status: String(seed.status || "idle"),
    sessionId: seed.sessionId == null ? null : String(seed.sessionId),
    turnId: seed.turnId == null ? null : String(seed.turnId),
    eventSequence: Number.isSafeInteger(seed.eventSequence) && seed.eventSequence >= 0 ? seed.eventSequence : 0,
    items: copyJson(seed.items || {}),
    messageRoles: copyJson(seed.messageRoles || {}),
    pendingApprovals: copyJson(seed.pendingApprovals || {}),
    pendingInputs: copyJson(seed.pendingInputs || {}),
    plan: copyJson(Array.isArray(seed.plan) ? seed.plan : []),
    contextUsage: seed.contextUsage == null ? null : copyJson(seed.contextUsage),
    finalText: String(seed.finalText || ""),
    finalSeen: Boolean(seed.finalSeen),
    streamMessageId: seed.streamMessageId == null ? null : String(seed.streamMessageId),
  };
}

export function createReducerContext(previousState, producer) {
  const state = createAgentState(previousState.adapterId, previousState);
  const events = [];

  function emit(kind, phase, payload = {}, source = {}) {
    invariant(KIND_SET.has(kind), "AGENT_EVENT_KIND_INVALID", `未知 Agent event kind: ${kind}`, {
      status: 500,
      expose: false,
    });
    invariant(PHASE_SET.has(phase), "AGENT_EVENT_PHASE_INVALID", `未知 Agent event phase: ${phase}`, {
      status: 500,
      expose: false,
    });
    state.sequence += 1;
    const event = {
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      sequence: state.sequence,
      producer: {
        adapter: String(producer.adapter),
        protocol: String(producer.protocol),
      },
      kind,
      phase,
      source: {
        type: String(source.type || "unknown"),
      },
      payload: copyJson(payload || {}),
    };
    // Keep the original Markdown alongside the readable final text so the UI
    // can replace captured links at their source position, including on replay.
    const linked = state.items["easywork:linked-final"];
    if (kind === "final" && linked?.paths?.length && payload.text === linked.cleaned) {
      event.payload.artifactMarkdown = String(linked.original);
    }
    for (const key of ["id", "sessionId", "turnId", "itemId", "requestId"]) {
      if (source[key] != null && source[key] !== "") event.source[key] = String(source[key]);
    }
    assertNoSensitiveFields(event);
    events.push(event);
    return event;
  }

  return { state, events, emit };
}

export function parseAgentFrame(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return copyJson(raw);
  invariant(typeof raw === "string" && raw.trim(), "AGENT_FRAME_INVALID", "Agent frame 必须是 JSON object 或 JSON line", {
    status: 400,
  });
  try {
    const parsed = JSON.parse(raw);
    invariant(parsed && typeof parsed === "object" && !Array.isArray(parsed), "AGENT_FRAME_INVALID", "Agent frame 必须是 JSON object", {
      status: 400,
    });
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("AGENT_FRAME_INVALID", "Agent frame 不是有效 JSON", { status: 400, cause: error });
  }
}

export function requireString(input, field, operation) {
  const value = input?.[field];
  invariant(typeof value === "string" && value.trim(), "AGENT_OPERATION_INPUT_INVALID", `${operation} 缺少 ${field}`, {
    status: 400,
    details: { operation, field },
  });
  return value.trim();
}

export function defineAgentAdapter(definition, options = {}) {
  invariant(definition && typeof definition === "object", "AGENT_ADAPTER_INVALID", "Agent adapter definition 无效", {
    status: 500,
    expose: false,
  });
  const id = String(definition.id || "");
  const protocol = String(definition.protocol || "");
  invariant(id && protocol && typeof definition.reduce === "function" && typeof definition.buildOperation === "function", "AGENT_ADAPTER_INVALID", "Agent adapter definition 不完整", {
    status: 500,
    expose: false,
  });
  const capabilities = createCapabilitySchema(definition.capabilities, options.capabilityOverrides);
  const producer = Object.freeze({ adapter: id, protocol });

  return Object.freeze({
    id,
    producer,
    capabilities,
    createState(seed = {}) {
      return createAgentState(id, seed);
    },
    reduce(previousState, rawFrame) {
      invariant(previousState?.adapterId === id, "AGENT_STATE_ADAPTER_MISMATCH", `State 不属于 ${id}`, { status: 400 });
      const frame = parseAgentFrame(rawFrame);
      const result = definition.reduce(previousState, frame, producer);
      invariant(result?.state?.adapterId === id && Array.isArray(result.events), "AGENT_REDUCER_INVALID", `${id} reducer 返回值无效`, {
        status: 500,
        expose: false,
      });
      return result;
    },
    operation(operation, input = {}) {
      invariant(OPERATION_SET.has(operation), "AGENT_OPERATION_UNKNOWN", `未知 Agent operation: ${operation}`, { status: 400 });
      const capability = capabilities[operation];
      if (capability.availability !== "available") {
        throw new ApiError("AGENT_CAPABILITY_UNAVAILABLE", `${id} 不支持 ${operation}`, {
          status: 409,
          details: { adapter: id, operation, reason: capability.reason },
        });
      }
      const descriptor = definition.buildOperation(operation, copyJson(input), capability);
      invariant(descriptor && typeof descriptor === "object", "AGENT_OPERATION_DESCRIPTOR_INVALID", `${id} ${operation} descriptor 无效`, {
        status: 500,
        expose: false,
      });
      assertNoSensitiveFields(descriptor);
      return copyJson({ adapter: id, operation, ...descriptor });
    },
  });
}
